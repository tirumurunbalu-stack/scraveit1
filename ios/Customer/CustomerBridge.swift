import UIKit
import CoreLocation
import UserNotifications

enum AppEntry: ScraveitApp {
    static func makeBridge() -> NativeBridge { CustomerBridge() }
}

/// The iOS side of window.FeastlyNative for the Customer app - the same
/// methods, arguments and replies as the Android app's MainActivity, so the
/// web screens run unchanged.
final class CustomerBridge: NSObject, NativeBridge, CLLocationManagerDelegate {
    /// Page method -> Cloud Function, all called as (requestId, idToken, payloadJson).
    private static let callables: [String: String] = [
        "createCodOrder": "createCodOrder", "createOrder": "createOrder",
        "getCheckoutConfiguration": "getCheckoutConfiguration", "getCustomerWallet": "getCustomerWallet",
        "applyCustomerReferral": "applyCustomerReferral", "createPaymentIntent": "createPaymentIntent",
        "createPhonePeIntent": "createPhonePeIntent",
    ]
    private static let dineInFunctions: Set<String> = [
        "dineInBookTable", "dineInCancelBooking", "dineInOpenTable", "dineInPlaceRound", "dineInTableRequest",
    ]
    /// Methods this build supports. Google sign-in and table QR scanning are
    /// left out until they're built for iOS, so the page hides those buttons.
    private static let asyncMethods = Array(callables.keys) + [
        "invokeDineIn", "openExternalPayment", "getDeliveryOtp", "recoverDeliveryOtp", "deleteDeliveryOtp",
        "clearDeliveryOtps", "setStatusBarStyle", "requestCurrentLocation", "haptic", "shareText", "shareImage",
        "notifyOrder", "registerPushToken", "unregisterPushToken",
    ]

    private let location = CLLocationManager()
    private weak var shell: WebShellViewController?
    private var wantsLocation = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    var shimScript: String {
        let names = Self.asyncMethods.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        (function(){
          if (window.FeastlyNative) return;
          var state = window.__scraveitNative = {locationReady:false, tableLink:null};
          var post = function(m, a){ try { window.webkit.messageHandlers.native.postMessage({m:m, a:Array.prototype.slice.call(a||[])}); } catch(e) {} };
          var api = {};
          [\(names)].forEach(function(m){ api[m] = function(){ post(m, arguments); }; });
          api.isLocationReady = function(){ return !!state.locationReady; };
          api.takeTableLink = function(){ var link = state.tableLink; state.tableLink = null; return link; };
          window.FeastlyNative = api;
        })();
        """
    }

    func handle(_ method: String, _ args: [Any], shell: WebShellViewController) {
        self.shell = shell
        let text = { (i: Int) -> String in i < args.count ? String(describing: args[i]) : "" }
        if let function = Self.callables[method] {
            callFunction(function, operation: method, requestId: text(0), idToken: text(1), payloadJson: text(2))
            return
        }
        switch method {
        case "invokeDineIn":
            guard Self.dineInFunctions.contains(text(2)) else {
                shell.publish(requestId: text(0), operation: method,
                              result: .failure(.init(code: "FUNCTION_NOT_ALLOWED", message: "This request isn't available.")))
                return
            }
            callFunction(text(2), operation: method, requestId: text(0), idToken: text(1), payloadJson: text(3))
        case "recoverDeliveryOtp":
            callFunction("recoverDeliveryOtp", operation: method, requestId: text(0), idToken: text(1),
                         payload: ["orderId": text(2)])
        case "getDeliveryOtp":
            let otp = SecureStore.get("otp." + text(1)) ?? ""
            shell.publish(requestId: text(0), operation: method, result: .success(["orderId": text(1), "deliveryOtp": otp]))
        case "deleteDeliveryOtp":
            SecureStore.remove("otp." + text(0))
        case "clearDeliveryOtps":
            SecureStore.removeAll(prefix: "otp.")
        case "openExternalPayment":
            openPayment(requestId: text(0), link: text(1))
        case "setStatusBarStyle":
            let dark = (args.count > 1 ? args[1] as? Bool : nil) ?? true
            DispatchQueue.main.async { shell.statusBarStyle = dark ? .darkContent : .lightContent }
        case "requestCurrentLocation":
            requestLocation()
        case "haptic":
            let ms = (args.first as? NSNumber)?.intValue ?? 12
            DispatchQueue.main.async {
                UIImpactFeedbackGenerator(style: ms >= 30 ? .medium : .light).impactOccurred()
            }
        case "shareText":
            share([text(0)])
        case "shareImage":
            var items: [Any] = []
            if let data = Data(base64Encoded: text(0).replacingOccurrences(of: "data:image/png;base64,", with: "")),
               let image = UIImage(data: data) { items.append(image) }
            if !text(1).isEmpty { items.append(text(1)) }
            share(items)
        case "notifyOrder":
            notify(title: text(0), body: text(1), id: text(2))
        case "registerPushToken", "unregisterPushToken":
            // Push needs the Apple push service, which comes with the Apple
            // Developer account; until then the app keeps working without it.
            shell.publish(requestId: text(0), operation: method,
                          result: .failure(.init(code: "PUSH_UNAVAILABLE", message: "Notifications aren't set up on iPhone yet.")))
        default:
            break
        }
    }

    // MARK: Cloud Functions

    private func callFunction(_ function: String, operation: String, requestId: String, idToken: String, payloadJson: String) {
        guard payloadJson.count <= 64_000,
              let data = payloadJson.isEmpty ? Data("{}".utf8) : payloadJson.data(using: .utf8),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            shell?.publish(requestId: requestId, operation: operation,
                           result: .failure(.init(code: "INVALID_ARGUMENT", message: "The request is invalid. Refresh and try again.")))
            return
        }
        callFunction(function, operation: operation, requestId: requestId, idToken: idToken, payload: payload)
    }

    private func callFunction(_ function: String, operation: String, requestId: String, idToken: String, payload: [String: Any]) {
        Task { [weak self] in
            var result = await CallableClient.call(function, idToken: idToken, data: payload)
            // Keep each order's delivery code safe on the phone, as Android does.
            if case .success(let data) = result, ["createCodOrder", "createOrder", "recoverDeliveryOtp"].contains(function),
               let orderId = data["orderId"] as? String, let otp = data["deliveryOtp"] as? String, !orderId.isEmpty {
                if !SecureStore.set(otp, for: "otp." + orderId) {
                    result = .failure(.init(code: "SECURE_STORAGE_UNAVAILABLE",
                                            message: "The order was reserved, but its delivery code couldn't be protected. Retry safely to recover it."))
                }
            }
            self?.shell?.publish(requestId: requestId, operation: operation, result: result)
        }
    }

    // MARK: payments, sharing, notifications

    private func openPayment(requestId: String, link: String) {
        guard link.count <= 8_192, let url = URL(string: link.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), ["https", "upi", "phonepe", "paytmmp", "tez", "gpay"].contains(scheme) else {
            shell?.publish(requestId: requestId, operation: "openExternalPayment",
                           result: .failure(.init(code: "INVALID_ARGUMENT", message: "This payment link isn't supported on iPhone.")))
            return
        }
        DispatchQueue.main.async { [weak self] in
            UIApplication.shared.open(url) { opened in
                self?.shell?.publish(requestId: requestId, operation: "openExternalPayment",
                                     result: opened ? .success(["launched": true])
                                        : .failure(.init(code: "APP_UNAVAILABLE", message: "No app on this phone can open this payment.")))
            }
        }
    }

    private func share(_ items: [Any]) {
        guard !items.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shell else { return }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = shell.view
            shell.present(sheet, animated: true)
        }
    }

    private func notify(title: String, body: String, id: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: "order-\(id)", content: content, trigger: nil))
        }
    }

    // MARK: location

    private func requestLocation() {
        wantsLocation = true
        guard CLLocationManager.locationServicesEnabled() else {
            shell?.evaluate("window.locationServicesDisabled && window.locationServicesDisabled()"); return
        }
        switch location.authorizationStatus {
        case .notDetermined: location.requestWhenInUseAuthorization()
        case .denied, .restricted: shell?.evaluate("window.locationUnavailable && window.locationUnavailable()")
        default: location.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let ready = [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus)
        shell?.evaluate("window.__scraveitNative && (window.__scraveitNative.locationReady = \(ready));")
        if ready && wantsLocation { manager.requestLocation() }
        else if wantsLocation && [.denied, .restricted].contains(manager.authorizationStatus) {
            wantsLocation = false
            shell?.evaluate("window.locationUnavailable && window.locationUnavailable()")
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard wantsLocation, let here = locations.last else { return }
        wantsLocation = false
        CLGeocoder().reverseGeocodeLocation(here) { [weak self] places, _ in
            let place = places?.first
            let area = place?.subLocality ?? place?.locality ?? ""
            let city = place?.locality ?? place?.subAdministrativeArea ?? ""
            let details = [place?.name, place?.thoroughfare, place?.subLocality, place?.locality, place?.postalCode]
                .compactMap { $0 }.filter { !$0.isEmpty }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
                .joined(separator: ", ")
            let j = WebShellViewController.jsString
            self?.shell?.evaluate("window.setDetectedLocation && window.setDetectedLocation(\(j("Current location")),\(j(area)),\(j(city)),\(j(details)),\(here.coordinate.latitude),\(here.coordinate.longitude));")
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard wantsLocation else { return }
        wantsLocation = false
        shell?.evaluate("window.locationUnavailable && window.locationUnavailable()")
    }
}
