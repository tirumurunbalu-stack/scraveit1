import UIKit
import WebKit
import CoreLocation
import UserNotifications
import AVFoundation
import AudioToolbox
import FirebaseCore
import FirebaseMessaging
import GoogleSignIn
import AuthenticationServices
import CryptoKit

enum AppEntry: ScraveitApp {
    static func makeBridge() -> NativeBridge { RestaurantBridge() }
}

/// The iOS side of the Restaurant app's two page objects, with the same
/// methods, arguments and replies as Android:
/// - window.SavrivoCloudNative (SavrivoOperationsBridge): push, server calls, the order alarm.
/// - window.FeastlyRestaurantNative (MainActivity.RestaurantBridge): Google sign-in,
///   Sign in with Apple (iPhone only; Apple requires it next to Google),
///   printing a bill, location, address lookup.
/// Left out on iPhone, so the page uses its own fallbacks or hides them: Bluetooth
/// receipt printers (iPhones can't talk to them), voice typing, on-phone text
/// reading of documents and the native photo upload (the page uploads photos itself).
final class RestaurantBridge: NSObject, NativeBridge, CLLocationManagerDelegate, MessagingDelegate,
                              ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// Same list as Android's SavrivoCallableClient.RESTAURANT_ECONOMICS.
    private static let economics: Set<String> = [
        "saveRestaurantOffer", "getRestaurantOffers", "getRestaurantOfferPerformance",
        "dineInRespondBooking", "dineInStaff", "getRestaurantAgreement", "signRestaurantAgreement",
        "getLiveRestaurantAgreement", "signLiveRestaurantAgreement", "restaurantCommissionNotice", "restaurantOrderWebhook",
        "attachPackedPhoto", "saveMealPlan", "getRestaurantMealPlans",
        "getSponsoredListings", "bookSponsoredListing", "cancelSponsoredListing",
        "listRestaurantStaff", "createRestaurantStaff", "updateRestaurantStaff", "removeRestaurantStaff",
    ]
    private static let cloudMethods = [
        "registerPushToken", "unregisterPushToken", "clearPushIdentity", "updateOrderStatus",
        "getRestaurantSettlementSummary", "invokeEconomics", "startOrderAlarm", "stopOrderAlarm",
        "reconcileRestaurantOrderAlarms",
    ]
    private static let restaurantMethods = [
        "signInWithGoogle", "signInWithApple", "printBill", "vibrateSuccess", "requestRestaurantLocation", "openNavigation", "lookUpAddress",
    ]
    private static let pushTokenKey = "scraveit.restaurant.pushToken"

    private weak var shell: WebShellViewController?
    private let location = CLLocationManager()
    private var wantsLocation = false
    private let alarm = OrderAlarm()
    private var billPrinter: BillPrinter?
    private var waitingPushEvents: [[String: Any]] = []
    private var pushFlushScheduled = false
    private var pageLoaded = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        Messaging.messaging().delegate = self
    }

    var shimScript: String {
        let cloud = Self.cloudMethods.map { "\"\($0)\"" }.joined(separator: ",")
        let restaurant = Self.restaurantMethods.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        (function(){
          if (window.SavrivoCloudNative) return;
          var post = function(m, a){ try { window.webkit.messageHandlers.native.postMessage({m:m, a:Array.prototype.slice.call(a||[])}); } catch(e) {} };
          var make = function(prefix, names){ var api = {}; names.forEach(function(n){ api[n] = function(){ post(prefix + n, arguments); }; }); return api; };
          window.SavrivoCloudNative = make("cloud.", [\(cloud)]);
          var restaurant = make("restaurant.", [\(restaurant)]);
          restaurant.platform = "ios";
          window.FeastlyRestaurantNative = restaurant;
        })();
        """
    }

    func pageDidLoad(shell: WebShellViewController) {
        self.shell = shell
        pageLoaded = true
        flushPushEvents()
    }

    func handle(_ method: String, _ args: [Any], shell: WebShellViewController) {
        self.shell = shell
        let text = { (i: Int) -> String in i < args.count ? String(describing: args[i]) : "" }
        let number = { (i: Int) -> Double in i < args.count ? ((args[i] as? NSNumber)?.doubleValue ?? .nan) : .nan }
        switch method {
        case "cloud.registerPushToken":
            guard valid(requestId: text(0), idToken: text(1)) else { return reject(text(0), "INVALID_REQUEST") }
            registerPush(requestId: text(0), idToken: text(1))
        case "cloud.unregisterPushToken":
            guard valid(requestId: text(0), idToken: text(1)) else { return reject(text(0), "INVALID_REQUEST") }
            unregisterPush(requestId: text(0), idToken: text(1))
        case "cloud.clearPushIdentity":
            UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
            Messaging.messaging().deleteToken { _ in }
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        case "cloud.updateOrderStatus":
            call("updateOrderStatus", requestId: text(0), idToken: text(1), payloadJson: text(2))
        case "cloud.getRestaurantSettlementSummary":
            call("getRestaurantSettlementSummary", requestId: text(0), idToken: text(1), payloadJson: text(2))
        case "cloud.invokeEconomics":
            guard Self.economics.contains(text(1)) else { return reject(text(0), "FUNCTION_NOT_ALLOWED") }
            call(text(1), requestId: text(0), idToken: text(2), payloadJson: text(3))
        case "cloud.startOrderAlarm":
            alarm.start(alarmId: text(0), orderId: text(3))
        case "cloud.stopOrderAlarm":
            alarm.stop(alarmId: text(0))
        case "cloud.reconcileRestaurantOrderAlarms":
            reconcileAlarms(text(0))
        case "restaurant.signInWithGoogle":
            DispatchQueue.main.async { self.signInWithGoogle() }
        case "restaurant.signInWithApple":
            DispatchQueue.main.async { self.signInWithApple() }
        case "restaurant.printBill":
            DispatchQueue.main.async { self.printBill(jobName: text(0), html: text(1)) }
        case "restaurant.vibrateSuccess":
            DispatchQueue.main.async { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        case "restaurant.requestRestaurantLocation":
            DispatchQueue.main.async { self.requestLocation() }
        case "restaurant.openNavigation":
            openNavigation(text(0))
        case "restaurant.lookUpAddress":
            lookUpAddress(requestId: text(0), lat: number(1), lng: number(2))
        default:
            break
        }
    }

    // MARK: replies to the page

    private func script(_ js: String) {
        shell?.evaluate(js)
    }

    /// window.SavrivoNativeCallbacks.resolve(id, ok, value): the reply shape Android's bridge uses.
    private func resolve(_ requestId: String, ok: Bool, value: Any) {
        let json: String
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           data.count <= 300_000, let text = String(data: data, encoding: .utf8) {
            json = text
        } else {
            json = "null"
        }
        script("window.SavrivoNativeCallbacks&&window.SavrivoNativeCallbacks.resolve(\(WebShellViewController.jsString(requestId)),\(ok),\(json))")
    }

    private func reject(_ requestId: String, _ message: String) {
        resolve(requestId, ok: false, value: ["error": ["message": message]])
    }

    private func valid(requestId: String, idToken: String) -> Bool {
        requestId.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil
            && idToken.count >= 32 && idToken.count <= 16_384
            && idToken.range(of: "^[A-Za-z0-9._~-]+$", options: .regularExpression) != nil
    }

    // MARK: server calls

    private func call(_ function: String, requestId: String, idToken: String, payloadJson: String) {
        guard valid(requestId: requestId, idToken: idToken) else { return reject(requestId, "INVALID_REQUEST") }
        guard payloadJson.utf8.count <= 64_000,
              let data = (payloadJson.isEmpty ? "{}" : payloadJson).data(using: .utf8),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return reject(requestId, "INVALID_PAYLOAD")
        }
        call(function, requestId: requestId, idToken: idToken, payload: payload)
    }

    private func call(_ function: String, requestId: String, idToken: String, payload: [String: Any],
                      after: ((Bool) -> Void)? = nil) {
        Task { [weak self] in
            let result = await CallableClient.callValue(function, idToken: idToken, data: payload)
            await MainActor.run {
                switch result {
                case .success(let value):
                    after?(true)
                    self?.resolve(requestId, ok: true, value: value)
                case .failure(let failure):
                    after?(false)
                    self?.reject(requestId, failure.message)
                }
            }
        }
    }

    // MARK: push notifications

    /// Same payload as Android's registerPushToken: app "restaurant", platform "ios".
    private func registerPush(requestId: String, idToken: String) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
                Task { [weak self] in
                    guard let token = await Self.fcmToken() else {
                        await MainActor.run { self?.reject(requestId, "FCM_TOKEN_UNAVAILABLE") }
                        return
                    }
                    await MainActor.run {
                        guard let self else { return }
                        UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
                        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
                        self.call("registerPushToken", requestId: requestId, idToken: idToken,
                                  payload: ["token": token, "app": "restaurant", "platform": "ios",
                                            "appVersion": String(version.prefix(40)), "deviceModel": Self.deviceModel()])
                    }
                }
            }
        }
    }

    private func unregisterPush(requestId: String, idToken: String) {
        Task { [weak self] in
            let token = (try? await Messaging.messaging().token()) ?? UserDefaults.standard.string(forKey: Self.pushTokenKey) ?? ""
            await MainActor.run {
                guard let self else { return }
                guard token.count >= 20 else {
                    self.resolve(requestId, ok: true, value: ["removed": false]); return
                }
                self.call("unregisterPushToken", requestId: requestId, idToken: idToken, payload: ["token": token]) { ok in
                    if ok {
                        UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
                        Messaging.messaging().deleteToken { _ in }
                    }
                }
            }
        }
    }

    /// The FCM token needs Apple's device token first, which arrives a moment
    /// after registerForRemoteNotifications; retry briefly while it does.
    private static func fcmToken() async -> String? {
        for attempt in 0..<8 {
            if let token = try? await Messaging.messaging().token(), token.count >= 20 { return token }
            try? await Task.sleep(nanoseconds: UInt64(500_000_000 * (attempt + 1)))
        }
        return nil
    }

    private static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return "Apple " + machine
    }

    /// A new FCM token: the page registers it again, as on Android (PUSH_TOKEN_REFRESH).
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken, fcmToken.count >= 20,
              let saved = UserDefaults.standard.string(forKey: Self.pushTokenKey), saved != fcmToken else { return }
        DispatchQueue.main.async { self.queuePushEvent(["type": "PUSH_TOKEN_REFRESH"]) }
    }

    private static func event(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        var event: [String: Any] = [:]
        for (key, value) in userInfo {
            guard let key = key as? String, key != "aps", !key.hasPrefix("gcm."), !key.hasPrefix("google.") else { continue }
            event[String(key.prefix(100))] = String(String(describing: value).prefix(2_000))
        }
        return event
    }

    private static func isOtherStore(_ event: [String: Any]) -> Bool {
        let storeType = event["storeType"] as? String ?? ""
        return !storeType.isEmpty && storeType != "restaurant"
    }

    /// A new order while the app is open: ring here (the page's own listener
    /// rings too; one alarm per order). No system sound on top of the alarm.
    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        let event = Self.event(from: notification.request.content.userInfo)
        let type = event["type"] as? String ?? ""
        if type == "RESTAURANT_NEW_ORDER" || type == "RESTAURANT_ORDER_LATE" {
            // Shared sign-in with the Grocery, Dairy and Health care apps: only this store type rings.
            if Self.isOtherStore(event) { return [] }
            if type == "RESTAURANT_NEW_ORDER" {
                startAlarm(for: event)
                queuePushEvent(event)
                return [.banner, .list]
            }
        }
        return [.banner, .list, .sound]
    }

    func notificationReceived(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        let orderId = event["orderId"] as? String ?? ""
        switch type {
        case "STOP_ORDER_ALARM":
            // Answered (here or on another phone): stop ringing and clear its banner.
            alarm.stop(alarmId: (event["alarmId"] as? String) ?? "order:\(orderId)")
            OrderAlarm.removeDelivered(orderId: orderId)
            queuePushEvent(event)
        case "RESTAURANT_NEW_ORDER":
            guard !Self.isOtherStore(event), UIApplication.shared.applicationState == .active else { return }
            startAlarm(for: event)
            queuePushEvent(event)
        case "ORDER_STATUS", "STORE_APPLICATION":
            queuePushEvent(event)
        default:
            break
        }
    }

    /// Tapping a new-order banner opens that order, as tapping the Android alarm does,
    /// in its own outlet when the account has several (the page switches to it).
    func notificationOpened(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        let orderId = event["orderId"] as? String ?? ""
        if type == "RESTAURANT_NEW_ORDER", !orderId.isEmpty {
            queuePushEvent(["type": "RESTAURANT_NEW_ORDER", "orderId": orderId])
            queuePushEvent(["type": "RESTAURANT_ORDER_OPEN", "orderId": orderId,
                            "restaurantId": event["restaurantId"] as? String ?? ""])
        } else if !type.isEmpty {
            queuePushEvent(event)
        }
    }

    private func startAlarm(for event: [String: Any]) {
        guard (event["status"] as? String ?? "Order placed") == "Order placed",
              let orderId = event["orderId"] as? String, !orderId.isEmpty else { return }
        alarm.start(alarmId: (event["alarmId"] as? String) ?? "order:\(orderId)", orderId: orderId)
    }

    /// Events go to window.SavrivoNativePushBatch once the page has defined it,
    /// the same way Android's SavrivoWebPushBinder waits for it.
    private func queuePushEvent(_ event: [String: Any]) {
        var stamped = event
        stamped["receivedAt"] = Int(Date().timeIntervalSince1970 * 1000)
        waitingPushEvents.append(stamped)
        if waitingPushEvents.count > 50 { waitingPushEvents.removeFirst(waitingPushEvents.count - 50) }
        flushPushEvents()
    }

    private func flushPushEvents(attempt: Int = 0) {
        guard pageLoaded, !waitingPushEvents.isEmpty, let web = shell?.webView, !pushFlushScheduled else { return }
        pushFlushScheduled = true
        web.evaluateJavaScript("typeof window.SavrivoNativePushBatch==='function'") { [weak self] ready, _ in
            guard let self else { return }
            self.pushFlushScheduled = false
            guard (ready as? Bool) == true else {
                if attempt < 30 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.flushPushEvents(attempt: attempt + 1) }
                }
                return
            }
            let events = self.waitingPushEvents
            self.waitingPushEvents = []
            guard let data = try? JSONSerialization.data(withJSONObject: events),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.script("window.SavrivoNativePushBatch(\(json))")
        }
    }

    // MARK: order alarm

    /// Stop alarms for orders the page knows are no longer waiting (Android's reconcileRestaurantOrders).
    private func reconcileAlarms(_ json: String) {
        guard json.count <= 128_000, let data = json.data(using: .utf8),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let ids = { (key: String) -> Set<String> in
            Set(((state[key] as? [Any]) ?? []).prefix(1_000).compactMap { $0 as? String }.filter(OrderAlarm.validOrderId))
        }
        let known = ids("known"), pending = ids("pending")
        // Never let an incomplete pending list silence a known waiting order.
        guard pending.isSubset(of: known) else { return }
        alarm.reconcile(known: known, pending: pending)
    }

    // MARK: Google sign-in

    private func signInWithGoogle() {
        guard let shell, let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty else {
            googleFailed("Google sign-in is not configured for this build."); return
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        GIDSignIn.sharedInstance.signIn(withPresenting: shell) { [weak self] result, error in
            if let token = result?.user.idToken?.tokenString {
                // The page keeps the Firebase session; let the next sign-in pick an account again.
                GIDSignIn.sharedInstance.signOut()
                self?.script("window.googleIdTokenReceived&&window.googleIdTokenReceived(\(WebShellViewController.jsString(token)))")
                return
            }
            let cancelled = (error as NSError?)?.code == GIDSignInError.Code.canceled.rawValue
            self?.googleFailed(cancelled ? "Google sign-in was cancelled." : "Google sign-in could not be completed. Try again.")
        }
    }

    private func googleFailed(_ message: String) {
        script("window.googleSignInFailed&&window.googleSignInFailed(\(WebShellViewController.jsString(message)))")
    }

    // MARK: Sign in with Apple (same page callbacks as the Customer app)

    private var appleNonce: String?

    private func signInWithApple() {
        let nonce = Self.randomNonce()
        appleNonce = nonce
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        shell?.view.window ?? UIWindow()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken, let idToken = String(data: tokenData, encoding: .utf8),
              let nonce = appleNonce else {
            appleFailed("Apple sign-in could not be completed. Try again."); return
        }
        appleNonce = nil
        let name = [credential.fullName?.givenName, credential.fullName?.familyName]
            .compactMap { $0 }.joined(separator: " ")
        script("window.appleSignInReceived&&window.appleSignInReceived(\(WebShellViewController.jsString(idToken)), \(WebShellViewController.jsString(nonce)), \(WebShellViewController.jsString(name)))")
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        appleNonce = nil
        // Closing Apple's sheet isn't an error worth a message.
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        appleFailed(cancelled ? "" : "Apple sign-in could not be completed. Try again.")
    }

    private func appleFailed(_ message: String) {
        script("window.appleSignInFailed&&window.appleSignInFailed(\(WebShellViewController.jsString(message)))")
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    func open(url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    // MARK: bill printing (AirPrint, or Save to Files / share from the print screen)

    private func printBill(jobName: String, html: String) {
        guard shell != nil, !html.isEmpty, html.count <= 200_000 else { return }
        let printer = BillPrinter(jobName: jobName.isEmpty ? "Scraveit bill" : String(jobName.prefix(80)), html: html) { [weak self] in
            self?.billPrinter = nil
        }
        billPrinter = printer
        printer.start()
    }

    // MARK: location and maps

    private func requestLocation() {
        wantsLocation = true
        guard CLLocationManager.locationServicesEnabled() else { return locationResult(nil) }
        switch location.authorizationStatus {
        case .notDetermined: location.requestWhenInUseAuthorization()
        case .denied, .restricted: locationResult(nil)
        default: location.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard wantsLocation else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: locationResult(nil)
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard wantsLocation, let here = locations.last else { return }
        locationResult(here)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard wantsLocation else { return }
        locationResult(nil)
    }

    private func locationResult(_ here: CLLocation?) {
        wantsLocation = false
        if let here {
            script("window.restaurantLocationReceived&&window.restaurantLocationReceived(\(here.coordinate.latitude),\(here.coordinate.longitude))")
        } else {
            script("window.restaurantLocationUnavailable&&window.restaurantLocationUnavailable()")
        }
    }

    private func openNavigation(_ destination: String) {
        let target = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, target.count <= 500,
              let encoded = target.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))),
              let url = URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(encoded)") else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
    }

    /// The street, area, town and PIN code at a map pin (Android's lookUpAddress).
    private func lookUpAddress(requestId: String, lat: Double, lng: Double) {
        guard requestId.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
              lat.isFinite, lng.isFinite, abs(lat) <= 90, abs(lng) <= 180 else { return }
        let reply = { [weak self] (found: [String: String]) in
            guard let data = try? JSONSerialization.data(withJSONObject: found),
                  let json = String(data: data, encoding: .utf8) else { return }
            self?.script("window.restaurantAddressFound&&window.restaurantAddressFound(\(WebShellViewController.jsString(requestId)),\(json))")
        }
        CLGeocoder().reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lng),
                                            preferredLocale: Locale(identifier: "en_IN")) { places, _ in
            guard let p = places?.first else { DispatchQueue.main.async { reply([:]) }; return }
            let clean = { (s: String?) in (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
            let street = [clean(p.subThoroughfare), clean(p.thoroughfare)].filter { !$0.isEmpty }.joined(separator: " ")
            let city = clean(p.locality).isEmpty ? clean(p.subAdministrativeArea) : clean(p.locality)
            var seen = Set<String>()
            let line = [clean(p.name), street, clean(p.subLocality), city, clean(p.administrativeArea), clean(p.postalCode)]
                .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
                .joined(separator: ", ")
            let found = ["line": line, "street": street, "area": clean(p.subLocality), "city": city,
                         "pincode": clean(p.postalCode), "state": clean(p.administrativeArea)]
            DispatchQueue.main.async { reply(found) }
        }
    }
}

/// Rings for each waiting order until the page (or a "handled" push) stops it:
/// the app's loud alarm sound on repeat plus a buzz, even with the silent switch on.
/// iPhone apps can't keep ringing once closed; then the new-order notification
/// plays the 26-second alarm sound instead.
final class OrderAlarm {
    private var active: [String: String] = [:]  // alarmId -> orderId
    private var player: AVAudioPlayer?
    private var buzz: Timer?

    init() {
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    static func validOrderId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_.:-]{1,120}$", options: .regularExpression) != nil
    }

    func start(alarmId: String, orderId: String) {
        DispatchQueue.main.async {
            guard alarmId.range(of: "^[A-Za-z0-9_.:-]{1,140}$", options: .regularExpression) != nil else { return }
            let fromAlarmId = alarmId.hasPrefix("order:") ? String(alarmId.dropFirst("order:".count)) : ""
            self.active[alarmId] = Self.validOrderId(orderId) ? orderId : fromAlarmId
            self.ring()
        }
    }

    func stop(alarmId: String) {
        DispatchQueue.main.async {
            guard let orderId = self.active.removeValue(forKey: alarmId) else { return }
            Self.removeDelivered(orderId: orderId)
            if self.active.isEmpty { self.silence() }
        }
    }

    func reconcile(known: Set<String>, pending: Set<String>) {
        DispatchQueue.main.async {
            let stale = self.active.filter { $0.key.hasPrefix("order:") && known.contains($0.value) && !pending.contains($0.value) }
            stale.keys.forEach { self.stop(alarmId: $0) }
        }
    }

    /// Clears the order's new-order banner once it has been answered.
    static func removeDelivered(orderId: String) {
        guard !orderId.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { ($0.request.content.userInfo["orderId"] as? String) == orderId }.map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    private func ring() {
        guard !active.isEmpty, UIApplication.shared.applicationState != .background else { return }
        if player?.isPlaying != true {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                if player == nil, let url = Bundle.main.url(forResource: "order_alarm_loop", withExtension: "wav") {
                    player = try AVAudioPlayer(contentsOf: url)
                    player?.numberOfLoops = -1
                }
                player?.currentTime = 0
                player?.play()
            } catch {
                NSLog("[alarm] sound could not start: %@", error.localizedDescription)
            }
        }
        if buzz == nil {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            buzz = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { _ in
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            }
        }
    }

    private func silence() {
        buzz?.invalidate()
        buzz = nil
        player?.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Back on screen with an order still waiting: ring again (iOS paused it in the background).
    @objc private func appBecameActive() {
        if !active.isEmpty { player?.stop(); ring() }
    }
}

/// Prints a bill through iOS's print screen (AirPrint printers, or Save to
/// Files / share as PDF). The bill renders in its own web view with JavaScript off.
final class BillPrinter: NSObject, WKNavigationDelegate {
    private let jobName: String
    private let html: String
    private let done: () -> Void
    private var web: WKWebView?

    init(jobName: String, html: String, done: @escaping () -> Void) {
        self.jobName = jobName
        self.html = html
        self.done = done
    }

    func start() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: config)
        web.navigationDelegate = self
        self.web = web
        web.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only the bill itself; no links out of it.
        decisionHandler(navigationAction.navigationType == .other ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let info = UIPrintInfo.printInfo()
        info.jobName = jobName
        info.outputType = .general
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        controller.present(animated: true) { [weak self] _, _, _ in
            self?.web = nil
            self?.done()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        web = nil
        done()
    }
}
