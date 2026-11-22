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
    static func makeBridge() -> NativeBridge { DeliveryBridge() }
}

/// The iOS side of the delivery partner app's two page objects, with the same
/// methods, arguments and replies as the Android Rider app:
/// - window.SavrivoCloudNative (SavrivoOperationsBridge): push, server calls, offer alarms.
/// - window.FeastlyRiderNative (MainActivity.RiderBridge): sign-in, location, live
///   tracking (RiderTracker), face check photo, Aadhaar QR, navigation, sharing.
/// iPhone differences: no "Allow all the time" / battery screen (iPhones keep
/// location running in the background while Online with the normal permission),
/// no Play install referrer, and Sign in with Apple next to Google.
final class DeliveryBridge: NSObject, NativeBridge, CLLocationManagerDelegate, MessagingDelegate,
                            ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private static let cloudMethods = [
        "registerPushToken", "unregisterPushToken", "clearPushIdentity", "updateOrderStatus",
        "getRiderFinancialSummary", "getRiderRewardsDashboard", "submitRiderFaceCheck", "verifyRiderLoginFace",
        "verifyRiderAadhaarQr", "claimRiderOrder", "declineRiderOrder", "markRiderArrivedRestaurant",
        "dismissRiderOffer", "pauseRiderOffer", "startRiderOffer",
    ]
    private static let riderMethods = [
        "setAppearance", "signInWithGoogle", "signInWithApple", "requestLocationAccess", "scanAadhaarQr",
        "readAadhaarQrFromImage", "capturePartnerFace", "requestBackgroundLocation", "requestBatteryExemption",
        "openLocationSettings", "startAvailabilityTracking", "startAdvancedTracking", "startResilientTracking",
        "refreshDeliveryTrackingCredentials", "openNavigation", "stopDeliveryTracking",
        "stopDeliveryTrackingWithReason", "vibrateSuccess",
    ]
    /// Same calls the Android SavrivoCallableClient allows for the rider app.
    private static let jsonCalls: [String: String] = [
        "updateOrderStatus": "updateOrderStatus",
        "getRiderFinancialSummary": "getRiderFinancialSummary",
        "getRiderRewardsDashboard": "getRiderRewardsDashboard",
        "submitRiderFaceCheck": "submitRiderFaceCheckCall",
        "verifyRiderLoginFace": "verifyRiderLoginFaceCall",
        "verifyRiderAadhaarQr": "verifyRiderAadhaarQrCall",
    ]
    private static let faceCalls: Set<String> = ["submitRiderFaceCheck", "verifyRiderLoginFace"]
    private static let pushTokenKey = "scraveit.delivery.pushToken"

    private weak var shell: WebShellViewController?
    private let location = CLLocationManager()
    private let tracker = RiderTracker()
    private let alarm = OfferAlarm()
    private var answeringLocation = false
    private var latestFix: CLLocation?
    private var waitingPushEvents: [[String: Any]] = []
    private var pushFlushScheduled = false
    private var pageLoaded = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        Messaging.messaging().delegate = self
        tracker.onState = { [weak self] state, message in
            self?.script("window.riderTrackingNativeState&&window.riderTrackingNativeState(\(WebShellViewController.jsString(state)),\(WebShellViewController.jsString(message)))")
        }
        tracker.onFix = { [weak self] fix in self?.latestFix = fix }
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    var shimScript: String {
        let cloud = Self.cloudMethods.map { "\"\($0)\"" }.joined(separator: ",")
        let rider = Self.riderMethods.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        (function(){
          if (window.SavrivoCloudNative) return;
          var post = function(m, a){ try { window.webkit.messageHandlers.native.postMessage({m:m, a:Array.prototype.slice.call(a||[])}); } catch(e) {} };
          var make = function(prefix, names){ var api = {}; names.forEach(function(n){ api[n] = function(){ post(prefix + n, arguments); }; }); return api; };
          window.SavrivoCloudNative = make("cloud.", [\(cloud)]);
          var rider = make("rider.", [\(rider)]);
          rider.platform = "ios";
          // Android answers these at once; here they read state native code keeps current.
          var access = {location: \(WebShellViewController.jsString(Self.locationAccess(location.authorizationStatus))), battery: true, declared: false};
          window.__scraveitLocationAccess = function(value){ access.location = String(value || "none"); };
          rider.backgroundAccessState = function(){ return JSON.stringify(access); };
          rider.getInstallReferralCode = function(){ return ""; };
          rider.shareText = function(title, text){ post("rider.shareText", [title, text]); return true; };
          window.FeastlyRiderNative = rider;
        })();
        """
    }

    func pageDidLoad(shell: WebShellViewController) {
        self.shell = shell
        pageLoaded = true
        flushPushEvents()
        #if DEBUG
        runTrackingSelfTest()
        #endif
    }

    #if DEBUG
    /// Debug builds only: drives RiderTracker against a local fake server
    /// (SCRAVEIT_SELFTEST_SERVER) with made-up ids, then goes offline.
    private var selfTestStarted = false
    private func runTrackingSelfTest() {
        let env = ProcessInfo.processInfo.environment
        guard !selfTestStarted, env["SCRAVEIT_SELFTEST_SERVER"] != nil, let mode = env["SCRAVEIT_SELFTEST_MODE"] else { return }
        selfTestStarted = true
        let token = String(repeating: "a", count: 40) + ".test.token"
        let refresh = String(repeating: "r", count: 40)
        let key = "AIzaTestKeyForSelfTest_0123"
        let lat = Double(env["SCRAVEIT_SELFTEST_DOOR_LAT"] ?? "") ?? 14.4426
        let lng = Double(env["SCRAVEIT_SELFTEST_DOOR_LNG"] ?? "") ?? 79.9865
        let seconds = Double(env["SCRAVEIT_SELFTEST_SECONDS"] ?? "") ?? 60
        NSLog("[selftest] start %@", mode)
        if mode == "delivery" {
            tracker.startDelivery(customerId: "selftestCustomer", orderId: "selftestOrder1", restaurantId: "selftestStore",
                                  riderId: "selftestRider", riderName: "Self Test", token: token, refreshToken: refresh,
                                  apiKey: key, customerLat: lat, customerLng: lng, phase: "delivery", city: "Nellore",
                                  orderStatus: "Out for delivery")
        } else {
            tracker.startAvailability(riderId: "selftestRider", riderName: "Self Test", token: token, refreshToken: refresh,
                                      apiKey: key, city: "Nellore")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            NSLog("[selftest] going offline")
            self.tracker.stop(reason: "offline")
        }
    }
    #endif

    func handle(_ method: String, _ args: [Any], shell: WebShellViewController) {
        self.shell = shell
        let text = { (i: Int) -> String in
            guard i < args.count, !(args[i] is NSNull) else { return "" }
            return String(describing: args[i])
        }
        let number = { (i: Int) -> Double in i < args.count ? ((args[i] as? NSNumber)?.doubleValue ?? Double(text(i)) ?? .nan) : .nan }
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
            alarm.stopAll()
        case "cloud.claimRiderOrder", "cloud.declineRiderOrder", "cloud.markRiderArrivedRestaurant":
            let function = String(method.dropFirst("cloud.".count))
            guard OfferAlarm.validOrderId(text(2)) else { return reject(text(0), "INVALID_ORDER_ID") }
            call(function, requestId: text(0), idToken: text(1), payload: ["orderId": text(2)])
        case "cloud.dismissRiderOffer":
            alarm.dismiss(orderId: text(0))
        case "cloud.pauseRiderOffer":
            alarm.pause(orderId: text(0))
        case "cloud.startRiderOffer":
            alarm.start(orderId: text(0), expiresAt: number(3))
        case let name where name.hasPrefix("cloud."):
            let key = String(name.dropFirst("cloud.".count))
            guard let function = Self.jsonCalls[key] else { return }
            call(function, requestId: text(0), idToken: text(1), payloadJson: text(2),
                 limit: Self.faceCalls.contains(key) ? 2_200_000 : 64_000)
        case "rider.setAppearance":
            let dark = (args.first as? Bool) ?? (text(0) == "true" || text(0) == "1")
            DispatchQueue.main.async {
                shell.statusBarStyle = dark ? .lightContent : .darkContent
                shell.webView.backgroundColor = dark ? UIColor(red: 7 / 255, green: 20 / 255, blue: 38 / 255, alpha: 1) : .white
            }
        case "rider.signInWithGoogle":
            DispatchQueue.main.async { self.signInWithGoogle() }
        case "rider.signInWithApple":
            DispatchQueue.main.async { self.signInWithApple() }
        case "rider.requestLocationAccess":
            DispatchQueue.main.async { self.requestLocationAccess(prompt: true) }
        case "rider.openLocationSettings":
            DispatchQueue.main.async { Self.openSettings() }
        case "rider.requestBackgroundLocation", "rider.requestBatteryExemption":
            // Not used on iPhone (declared:false hides that screen); answer so nothing waits.
            script("window.riderBackgroundAccessChanged&&window.riderBackgroundAccessChanged()")
        case "rider.startAvailabilityTracking":
            DispatchQueue.main.async {
                self.tracker.startAvailability(riderId: text(0), riderName: text(1), token: text(2), refreshToken: text(3),
                                               apiKey: text(4), city: text(5))
            }
        case "rider.startResilientTracking":
            DispatchQueue.main.async {
                self.tracker.startDelivery(customerId: text(0), orderId: text(1), restaurantId: text(2), riderId: text(3),
                                           riderName: text(4), token: text(5), refreshToken: text(6), apiKey: text(7),
                                           customerLat: number(8), customerLng: number(9), phase: text(10),
                                           city: text(11), orderStatus: text(12))
            }
        case "rider.startAdvancedTracking":
            DispatchQueue.main.async {
                self.tracker.startDelivery(customerId: text(0), orderId: text(1), restaurantId: text(2), riderId: text(3),
                                           riderName: text(4), token: text(5), refreshToken: text(6), apiKey: text(7),
                                           customerLat: number(8), customerLng: number(9), phase: text(10),
                                           city: "", orderStatus: "")
            }
        case "rider.refreshDeliveryTrackingCredentials":
            DispatchQueue.main.async { self.tracker.updateCredentials(token: text(0), refreshToken: text(1), apiKey: text(2)) }
        case "rider.stopDeliveryTracking":
            DispatchQueue.main.async { self.tracker.stop(reason: "stopped") }
        case "rider.stopDeliveryTrackingWithReason":
            let reason = ["offline", "location_off", "delivered", "cancelled", "no_active_order", "stopped"].contains(text(0)) ? text(0) : "stopped"
            DispatchQueue.main.async { self.tracker.stop(reason: reason) }
        case "rider.openNavigation":
            openNavigation(text(0))
        case "rider.vibrateSuccess":
            DispatchQueue.main.async { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        case "rider.shareText":
            DispatchQueue.main.async { self.share(text(1)) }
        case "rider.capturePartnerFace":
            DispatchQueue.main.async { self.captureFace() }
        case "rider.scanAadhaarQr":
            DispatchQueue.main.async { self.scanAadhaar() }
        case "rider.readAadhaarQrFromImage":
            readAadhaarImage(text(0))
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

    private func call(_ function: String, requestId: String, idToken: String, payloadJson: String, limit: Int) {
        guard valid(requestId: requestId, idToken: idToken) else { return reject(requestId, "INVALID_REQUEST") }
        guard payloadJson.utf8.count <= limit,
              let data = (payloadJson.isEmpty ? "{}" : payloadJson).data(using: .utf8),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return reject(requestId, "INVALID_REQUEST")
        }
        call(function, requestId: requestId, idToken: idToken, payload: payload)
    }

    private func call(_ function: String, requestId: String, idToken: String, payload: [String: Any],
                      after: ((Bool) -> Void)? = nil) {
        guard valid(requestId: requestId, idToken: idToken) else { return reject(requestId, "INVALID_REQUEST") }
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

    /// Same payload as Android's registerPushToken: app "rider", platform "ios".
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
                                  payload: ["token": token, "app": "rider", "platform": "ios",
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

    /// A delivery offer while the app is open: ring here until it is answered,
    /// opened or expires; the banner shows without its own sound.
    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        let event = Self.event(from: notification.request.content.userInfo)
        if (event["type"] as? String) == "RIDER_ORDER_OFFER" {
            let orderId = event["orderId"] as? String ?? ""
            alarm.start(orderId: orderId, expiresAt: Double(event["expiresAt"] as? String ?? "") ?? .nan)
            queuePushEvent(event)
            return [.banner, .list]
        }
        return [.banner, .list, .sound]
    }

    func notificationReceived(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        let orderId = event["orderId"] as? String ?? ""
        switch type {
        case "REMOVE_RIDER_OFFER":
            // Taken by someone else or withdrawn: stop ringing and clear its banner.
            alarm.dismiss(orderId: orderId)
            queuePushEvent(event)
        case "RIDER_ORDER_OFFER":
            guard UIApplication.shared.applicationState == .active else { return }
            alarm.start(orderId: orderId, expiresAt: Double(event["expiresAt"] as? String ?? "") ?? .nan)
            queuePushEvent(event)
        case "ORDER_STATUS", "PUSH_RESYNC_REQUIRED":
            queuePushEvent(event)
        default:
            break
        }
    }

    /// Tapping an offer notification opens that offer's accept/decline sheet.
    func notificationOpened(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        let orderId = event["orderId"] as? String ?? ""
        if type == "RIDER_ORDER_OFFER", !orderId.isEmpty {
            queuePushEvent(["type": "RIDER_OFFER_OPEN", "orderId": orderId])
        } else if !type.isEmpty {
            queuePushEvent(event)
        }
    }

    /// Events go to window.SavrivoNativePushBatch once the page has defined it.
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

    // MARK: Sign in with Apple (same page callbacks as the Customer and Restaurant apps)

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

    // MARK: location permission and position (Android's requestLocationAccess)

    private static func locationAccess(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways: return "all"
        case .authorizedWhenInUse: return "foreground"
        default: return "none"
        }
    }

    /// Answers window.riderLocationPermissionResult(granted, enabled, lat, lng, accuracy).
    private func requestLocationAccess(prompt: Bool) {
        let status = location.authorizationStatus
        switch status {
        case .notDetermined:
            guard prompt else { return }
            answeringLocation = true
            location.requestWhenInUseAuthorization()
        case .denied, .restricted:
            DispatchQueue.global().async {
                let enabled = CLLocationManager.locationServicesEnabled()
                DispatchQueue.main.async { self.publishLocation(granted: false, enabled: enabled, fix: nil) }
            }
        default:
            // Customers follow the partner to the door, so a rough position isn't enough.
            if location.accuracyAuthorization == .reducedAccuracy && prompt {
                location.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "DeliveryTracking") { _ in
                    self.answerWithFix()
                }
                return
            }
            answerWithFix()
        }
    }

    private func answerWithFix() {
        if let fix = latestFix, -fix.timestamp.timeIntervalSinceNow < 20, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 100 {
            publishLocation(granted: true, enabled: true, fix: fix)
            return
        }
        answeringLocation = true
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.requestLocation()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let access = Self.locationAccess(manager.authorizationStatus)
        script("window.__scraveitLocationAccess&&window.__scraveitLocationAccess(\(WebShellViewController.jsString(access)));window.riderBackgroundAccessChanged&&window.riderBackgroundAccessChanged()")
        guard answeringLocation, manager.authorizationStatus != .notDetermined else { return }
        answeringLocation = false
        requestLocationAccess(prompt: true)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        latestFix = fix
        guard answeringLocation else { return }
        answeringLocation = false
        locationRetries = 0
        publishLocation(granted: true, enabled: true, fix: fix)
    }

    private var locationRetries = 0

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard answeringLocation else { return }
        // requestLocation() gives up after one try; indoors the first fix can take longer.
        if (error as? CLError)?.code == .locationUnknown, locationRetries < 2 {
            locationRetries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { manager.requestLocation() }
            return
        }
        answeringLocation = false
        locationRetries = 0
        let denied = (error as? CLError)?.code == .denied
        publishLocation(granted: !denied, enabled: true, fix: nil)
    }

    private func publishLocation(granted: Bool, enabled: Bool, fix: CLLocation?) {
        let lat = fix.map { String($0.coordinate.latitude) } ?? "null"
        let lng = fix.map { String($0.coordinate.longitude) } ?? "null"
        let accuracy = fix.flatMap { $0.horizontalAccuracy >= 0 ? String($0.horizontalAccuracy) : nil } ?? "null"
        script("window.riderLocationPermissionResult&&window.riderLocationPermissionResult(\(granted),\(enabled),\(lat),\(lng),\(accuracy))")
    }

    /// Back from Settings (or another app): tell the page whether Location is on now.
    @objc private func appBecameActive() {
        guard pageLoaded, !answeringLocation, location.authorizationStatus != .notDetermined else { return }
        requestLocationAccess(prompt: false)
    }

    private static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    // MARK: maps and sharing

    private func openNavigation(_ destination: String) {
        let target = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, target.count <= 500,
              let encoded = target.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))),
              let url = URL(string: "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=\(encoded)") else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
    }

    private func share(_ text: String) {
        guard let shell, !text.isEmpty, text.count <= 4_000 else { return }
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = shell.view
        shell.present(sheet, animated: true)
    }

    // MARK: camera: face check photo and Aadhaar QR

    private func captureFace() {
        guard let shell else { return }
        CameraAccess.request { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.faceFailed("Allow camera access in Settings to take your photo.")
                return
            }
            #if targetEnvironment(simulator)
            self.faceFailed("The camera isn't available on this phone.")
            #else
            let screen = FaceCaptureViewController { [weak self] result in
                switch result {
                case .success(let jpeg):
                    let base64 = jpeg.base64EncodedString()
                    self?.script("window.riderFaceCaptured&&window.riderFaceCaptured(\(WebShellViewController.jsString(base64)))")
                case .failure(let error):
                    self?.faceFailed(error == .cancelled ? "cancelled" : "Camera could not be started.")
                }
            }
            shell.present(screen, animated: true)
            #endif
        }
    }

    private func faceFailed(_ reason: String) {
        script("window.riderFaceCaptureFailed&&window.riderFaceCaptureFailed(\(WebShellViewController.jsString(reason)))")
    }

    private func scanAadhaar() {
        guard let shell else { return }
        CameraAccess.request { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.publishAadhaar(raw: "", error: "Allow camera access in Settings to scan your Aadhaar, or upload your e-Aadhaar instead.")
                return
            }
            let screen = QRScanViewController { [weak self] value in
                self?.publishAadhaar(raw: value ?? "", error: value == nil ? "cancelled" : "")
            }
            shell.present(screen, animated: true)
        }
    }

    private func readAadhaarImage(_ base64: String) {
        guard base64.count <= 14_000_000, let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            return publishAadhaar(raw: "", error: "That image is too large.")
        }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let image = UIImage(data: data)?.cgImage else {
                DispatchQueue.main.async { self.publishAadhaar(raw: "", error: "That file isn’t a picture we can read.") }
                return
            }
            let found = QRImageReader.read(image)
            DispatchQueue.main.async {
                self.publishAadhaar(raw: found, error: found.isEmpty
                    ? "We couldn’t read the QR in that picture. Zoom in until the QR fills your screen, take a new screenshot, and upload that." : "")
            }
        }
    }

    private func publishAadhaar(raw: String, error: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let result: [String: String] = ["raw": value.count > 12_000 ? "" : value, "error": error]
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        script("window.aadhaarQrRead&&window.aadhaarQrRead(\(json))")
    }
}

/// Rings for a delivery offer while the app is open, like Android's offer alarm:
/// the alert sound on repeat plus a buzz, even with the silent switch on, until
/// the partner opens or answers the offer, someone else takes it, or it expires.
/// With the app closed the offer notification plays its own 25-second sound.
final class OfferAlarm {
    private var active: [String: Double] = [:]  // orderId -> expiresAt (ms)
    private var player: AVAudioPlayer?
    private var buzz: Timer?
    private var expiry: Timer?

    init() {
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appResigned),
                                               name: UIApplication.willResignActiveNotification, object: nil)
    }

    static func validOrderId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_.:-]{1,120}$", options: .regularExpression) != nil
    }

    func start(orderId: String, expiresAt: Double) {
        DispatchQueue.main.async {
            let now = Double(RiderTracker.nowMs())
            guard Self.validOrderId(orderId), expiresAt.isFinite, expiresAt > now else { return }
            self.active[orderId] = min(expiresAt, now + 120_000)
            self.ring()
        }
    }

    /// The partner opened the offer: stop ringing for it.
    func pause(orderId: String) {
        DispatchQueue.main.async { self.remove(orderId) }
    }

    /// Answered, taken by someone else or withdrawn: stop ringing and clear its notification.
    func dismiss(orderId: String) {
        DispatchQueue.main.async {
            self.remove(orderId)
            Self.removeDelivered(orderId: orderId)
        }
    }

    func stopAll() {
        DispatchQueue.main.async {
            self.active.removeAll()
            self.silence()
        }
    }

    private func remove(_ orderId: String) {
        guard active.removeValue(forKey: orderId) != nil else { return }
        if active.isEmpty { silence() }
    }

    static func removeDelivered(orderId: String) {
        guard !orderId.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { ($0.request.content.userInfo["orderId"] as? String) == orderId }.map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    private func ring() {
        guard !active.isEmpty, UIApplication.shared.applicationState == .active else { return }
        if player?.isPlaying != true {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                if player == nil, let url = Bundle.main.url(forResource: "rider_offer_loop", withExtension: "wav") {
                    player = try AVAudioPlayer(contentsOf: url)
                    player?.numberOfLoops = -1
                }
                player?.currentTime = 0
                player?.play()
            } catch {
                NSLog("[offer] sound could not start: %@", error.localizedDescription)
            }
        }
        if buzz == nil {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            buzz = Timer.scheduledTimer(withTimeInterval: 2.2, repeats: true) { _ in
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            }
        }
        if expiry == nil {
            expiry = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.dropExpired() }
        }
    }

    private func dropExpired() {
        let now = Double(RiderTracker.nowMs())
        active = active.filter { $0.value > now }
        if active.isEmpty { silence() }
    }

    private func silence() {
        buzz?.invalidate()
        buzz = nil
        expiry?.invalidate()
        expiry = nil
        player?.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    @objc private func appBecameActive() {
        dropExpired()
        if !active.isEmpty { ring() }
    }

    /// iOS pauses sound for apps in the background; the notification sound takes over.
    @objc private func appResigned() {
        buzz?.invalidate()
        buzz = nil
        player?.stop()
    }
}
