import UIKit
import CoreLocation
import UserNotifications
import AVFoundation
import AudioToolbox
import PhotosUI
import FirebaseCore
import FirebaseMessaging
import GoogleSignIn
import AuthenticationServices
import CryptoKit

enum AppEntry: ScraveitApp {
    static func makeBridge() -> NativeBridge { CustomerBridge() }
}

/// The iOS side of window.FeastlyNative for the Customer app - the same
/// methods, arguments and replies as the Android app's MainActivity, so the
/// web screens run unchanged.
final class CustomerBridge: NSObject, NativeBridge, CLLocationManagerDelegate,
                            ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// Page method -> Cloud Function, all called as (requestId, idToken, payloadJson).
    private static let callables: [String: String] = [
        "createCodOrder": "createCodOrder", "createOrder": "createOrder",
        "getCheckoutConfiguration": "getCheckoutConfiguration", "getCustomerWallet": "getCustomerWallet",
        "applyCustomerReferral": "applyCustomerReferral", "createPaymentIntent": "createPaymentIntent",
        "createPhonePeIntent": "createPhonePeIntent",
        // "Confirming your payment" and the COD / cancel choices after a payment that didn't finish.
        "checkOrderPayment": "checkOrderPayment", "cancelUnpaidOrder": "cancelUnpaidOrder",
    ]
    private static let dineInFunctions: Set<String> = [
        "dineInBookTable", "dineInCancelBooking", "dineInOpenTable", "dineInPlaceRound", "dineInTableRequest",
    ]
    /// Friends, chat and calls: the same list as Android's MainActivity.SOCIAL_FUNCTIONS.
    private static let socialFunctions: Set<String> = [
        "callIceServers", "chatSetup", "chatNewCode", "chatSetPrivacy", "chatAddFriend", "chatSetUsername", "chatRespond", "chatMarkRead",
        "chatParentRequest", "chatParentRespond", "chatParentRevoke", "chatReport",
        "accountSetBirthDate", "accountParentRequest", "accountParentRespond", "accountParentRevoke",
        "parentPayRequest", "parentPayCancel", "parentPayRespond", "chatCrave", "chatSetEatingShare", "chatTasteMatch", "chatIou", "chatUnsend",
    ]
    /// Methods this build supports. Table QR scanning is left out until it's
    /// built for iOS, so the page hides that button.
    private static let asyncMethods = Array(callables.keys) + [
        "invokeDineIn", "openExternalPayment", "startCashfreePayment", "getDeliveryOtp", "recoverDeliveryOtp", "deleteDeliveryOtp",
        "clearDeliveryOtps", "setStatusBarStyle", "requestCurrentLocation", "haptic", "shareText", "shareImage",
        "notifyOrder", "registerPushToken", "unregisterPushToken", "clearPushIdentity", "signInWithApple", "signInWithGoogle",
        "invokeSocial", "callPermissions", "callAudio", "pickChatPhoto", "pickProfilePhoto",
    ]

    private let location = CLLocationManager()
    private weak var shell: WebShellViewController?
    private var wantsLocation = false
    private var ringTimer: Timer?
    private var photoRequest: (id: String, chat: Bool)?
    /// Set while the app itself sent the person elsewhere (a UPI app), so that never counts as leaving.
    private var leftForOwnScreen = false
    /// A tapped reminder that arrived before the page had loaded.
    private var waitingNudgeOpen: [String: Any]?

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        NotificationCenter.default.addObserver(self, selector: #selector(appLeft),
                                               name: UIScene.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appCameBack),
                                               name: UIScene.willEnterForegroundNotification, object: nil)
    }

    var shimScript: String {
        let names = Self.asyncMethods.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        (function(){
          if (window.FeastlyNative) return;
          var state = window.__scraveitNative = {locationReady:\(locationAllowed), tableLink:null};
          var post = function(m, a){ try { window.webkit.messageHandlers.native.postMessage({m:m, a:Array.prototype.slice.call(a||[])}); } catch(e) {} };
          var api = {};
          [\(names)].forEach(function(m){ api[m] = function(){ post(m, arguments); }; });
          api.isLocationReady = function(){ return !!state.locationReady; };
          api.takeTableLink = function(){ var link = state.tableLink; state.tableLink = null; return link; };
          window.FeastlyNative = api;
        })();
        """
    }

    /// Whether the person has let the app use location (any "while using" or "always").
    private var locationAllowed: Bool {
        [.authorizedWhenInUse, .authorizedAlways].contains(location.authorizationStatus)
    }

    // At launch iOS reports the location permission before the page exists, so
    // the page used to think location was off ("Location is off" banner and the
    // address sheet every time). Tell it again once it has loaded.
    func pageDidLoad(shell: WebShellViewController) {
        self.shell = shell
        shell.evaluate("window.__scraveitNative && (window.__scraveitNative.locationReady = \(locationAllowed));")
        settleNudge()
        if let event = waitingNudgeOpen {
            waitingNudgeOpen = nil
            sendPushEvent(event)
        }
    }

    // MARK: reminders after leaving the app (Android: CartNudge.java)

    /// Leaving with food in the cart, or right after looking at a store, the page says whether a
    /// reminder is due (window.savrivoCartNudge: hours, switches, under-18s, store open). The phone
    /// shows it about 5 seconds later, unless the person comes back first,
    /// and never more than one in 20 hours.
    private static let nudgeId = "scraveit-nudge"
    private static let nudgeShownKey = "nudge.lastShownAt", nudgePendingKey = "nudge.pendingAt"
    private static let nudgeGap: TimeInterval = 20 * 60 * 60

    @objc private func appLeft() {
        if leftForOwnScreen { return }
        guard let web = shell?.webView, web.url?.scheme == AssetSchemeHandler.scheme else { return }
        var task = UIBackgroundTaskIdentifier.invalid
        let finish = {
            DispatchQueue.main.async {
                if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid }
            }
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "nudge") { finish() }
        web.evaluateJavaScript("window.savrivoCartNudge ? window.savrivoCartNudge() : ''") { value, _ in
            guard let text = value as? String, let data = text.data(using: .utf8),
                  let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let title = p["title"] as? String, let body = p["body"] as? String,
                  !title.isEmpty, !body.isEmpty else { finish(); return }
            // Test accounts ("test": true) skip the one-a-day limit so a reminder can be tried again.
            let lastShown = UserDefaults.standard.double(forKey: Self.nudgeShownKey)
            if (p["test"] as? Bool) != true && Date().timeIntervalSince1970 - lastShown < Self.nudgeGap { finish(); return }
            let delay = min(1800, max(3, ((p["delayMs"] as? NSNumber)?.doubleValue ?? 5000) / 1000))
            let center = UNUserNotificationCenter.current()
            center.getNotificationSettings { settings in
                guard [.authorized, .provisional].contains(settings.authorizationStatus) else { finish(); return }
                Self.nudgeImage(p["image"] as? String) { attachment in
                    let content = UNMutableNotificationContent()
                    content.title = title
                    content.body = body
                    content.sound = .default
                    var info: [String: Any] = ["type": (p["type"] as? String) ?? "CART_REMINDER", "localNudge": true]
                    if let store = p["restaurantId"] as? String, !store.isEmpty { info["restaurantId"] = store }
                    content.userInfo = info
                    if let attachment { content.attachments = [attachment] }
                    let fireAt = Date().addingTimeInterval(delay).timeIntervalSince1970
                    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
                    center.add(UNNotificationRequest(identifier: Self.nudgeId, content: content, trigger: trigger)) { error in
                        if error == nil { UserDefaults.standard.set(fireAt, forKey: Self.nudgePendingKey) }
                        finish()
                    }
                }
            }
        }
    }

    @objc private func appCameBack() {
        leftForOwnScreen = false
        settleNudge()
    }

    /// Back in the app: a reminder not shown yet is cancelled; one already shown starts the 20 hours.
    private func settleNudge() {
        let defaults = UserDefaults.standard
        let pendingAt = defaults.double(forKey: Self.nudgePendingKey)
        guard pendingAt > 0 else { return }
        defaults.removeObject(forKey: Self.nudgePendingKey)
        if Date().timeIntervalSince1970 >= pendingAt {
            defaults.set(pendingAt, forKey: Self.nudgeShownKey)
        } else {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [Self.nudgeId])
        }
    }

    /// The dish or store photo for the reminder, fetched while the app still has a few seconds.
    private static func nudgeImage(_ link: String?, done: @escaping (UNNotificationAttachment?) -> Void) {
        guard let link, link.hasPrefix("https://"), let url = URL(string: link) else { done(nil); return }
        URLSession.shared.downloadTask(with: URLRequest(url: url, timeoutInterval: 6)) { file, response, _ in
            guard let file, (response as? HTTPURLResponse)?.statusCode == 200 else { done(nil); return }
            let ext = (response?.mimeType ?? "").contains("png") ? "png" : "jpg"
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-\(UUID().uuidString).\(ext)")
            do {
                try FileManager.default.moveItem(at: file, to: target)
                done(try UNNotificationAttachment(identifier: "photo", url: target))
            } catch { done(nil) }
        }.resume()
    }

    /// Tapping a reminder opens the store (or the cart), like Android.
    func notificationOpened(_ userInfo: [AnyHashable: Any]) {
        guard userInfo["localNudge"] as? Bool == true else { return }
        var event: [String: Any] = ["type": (userInfo["type"] as? String) ?? "CART_REMINDER", "openedFromNotification": true]
        if let store = userInfo["restaurantId"] as? String { event["restaurantId"] = store }
        if shell == nil { waitingNudgeOpen = event } else { sendPushEvent(event) }
    }

    private func sendPushEvent(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        shell?.evaluate("window.savrivoPushReceived && window.savrivoPushReceived(JSON.parse(atob('\(data.base64EncodedString())')));")
    }

    func handle(_ method: String, _ args: [Any], shell: WebShellViewController) {
        self.shell = shell
        let text = { (i: Int) -> String in i < args.count ? String(describing: args[i]) : "" }
        if let function = Self.callables[method] {
            callFunction(function, operation: method, requestId: text(0), idToken: text(1), payloadJson: text(2))
            return
        }
        switch method {
        case "invokeSocial":
            guard Self.socialFunctions.contains(text(2)) else {
                shell.publish(requestId: text(0), operation: method,
                              result: .failure(.init(code: "INVALID_ARGUMENT", message: "That action isn't available.")))
                return
            }
            callFunction(text(2), operation: method, requestId: text(0), idToken: text(1), payloadJson: text(3))
        case "callPermissions":
            callPermissions(requestId: text(0), video: (jsonObject(text(1))["video"] as? Bool) ?? false)
        case "callAudio":
            callAudio(requestId: text(0), jsonObject(text(1)))
        case "pickChatPhoto", "pickProfilePhoto":
            pickPhoto(requestId: text(0), chat: method == "pickChatPhoto")
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
        case "startCashfreePayment":
            startCashfreePayment(requestId: text(0), payloadJson: text(1))
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
        case "registerPushToken":
            registerPush(requestId: text(0), idToken: text(1))
        case "unregisterPushToken":
            unregisterPush(requestId: text(0), idToken: text(1))
        case "signInWithApple":
            DispatchQueue.main.async { self.signInWithApple() }
        case "signInWithGoogle":
            DispatchQueue.main.async { self.signInWithGoogle() }
        case "clearPushIdentity":
            // Signed out: drop this phone's push token so no account's
            // notifications reach it, as Android does.
            UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
            Messaging.messaging().deleteToken { _ in }
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        default:
            break
        }
    }

    private func jsonObject(_ text: String) -> [String: Any] {
        guard let data = text.data(using: .utf8) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    // MARK: calls

    /// Asks iOS for the microphone (and the camera for video); replies {audio, video} like Android.
    private func callPermissions(requestId: String, video: Bool) {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] audio in
            let finish = { (camera: Bool) in
                self?.shell?.publish(requestId: requestId, operation: "callPermissions", result: .success(["audio": audio, "video": camera]))
            }
            if video { AVCaptureDevice.requestAccess(for: .video) { finish($0) } }
            else { finish(AVCaptureDevice.authorizationStatus(for: .video) == .authorized) }
        }
    }

    /// Phone side of a call, same payload as Android: {ring, active, speaker, video, dismissCallId, background}.
    private func callAudio(requestId: String, _ p: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let dismiss = p["dismissCallId"] as? String, !dismiss.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["call-\(dismiss)"])
            }
            if let ring = p["ring"] as? Bool { self.setRinging(ring) }
            if let active = p["active"] as? Bool {
                self.setCallActive(active, speaker: p["speaker"] as? Bool ?? false, video: p["video"] as? Bool ?? false)
            }
            // "background" (send the app behind the call) has no iOS equivalent; the call screen stays.
            self.shell?.publish(requestId: requestId, operation: "callAudio", result: .success(["ok": true]))
        }
    }

    /// iOS has no public ringtone API: an alert sound and a buzz every two seconds instead.
    private func setRinging(_ on: Bool) {
        ringTimer?.invalidate()
        ringTimer = nil
        guard on else { return }
        let ring = { AudioServicesPlayAlertSound(1005); AudioServicesPlaySystemSound(kSystemSoundID_Vibrate) }
        ring()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in ring() }
    }

    private func setCallActive(_ on: Bool, speaker: Bool, video: Bool) {
        if on { setRinging(false) }
        UIApplication.shared.isIdleTimerDisabled = on
        // Voice call at the ear: the screen turns off when held to the face.
        UIDevice.current.isProximityMonitoringEnabled = on && !video && !speaker
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on && speaker ? .speaker : .none)
    }

    // MARK: photos

    /// Chat photo -> {image, w, h} (longest side 1280, shrunk until it fits a chat message);
    /// profile photo -> {image} (320 px square). Re-encoding drops EXIF, location included.
    private func pickPhoto(requestId: String, chat: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let shell = self.shell else { return }
            if let pending = self.photoRequest {
                shell.publish(requestId: pending.id, operation: pending.chat ? "pickChatPhoto" : "pickProfilePhoto",
                              result: .failure(.init(code: "CANCELLED", message: "No photo chosen.")))
            }
            self.photoRequest = (requestId, chat)
            var config = PHPickerConfiguration()
            config.filter = .images
            config.selectionLimit = 1
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            shell.present(picker, animated: true)
        }
    }

    fileprivate func finishPhoto(_ image: UIImage?) {
        guard let request = photoRequest else { return }
        photoRequest = nil
        let operation = request.chat ? "pickChatPhoto" : "pickProfilePhoto"
        guard let image else {
            shell?.publish(requestId: request.id, operation: operation, result: .failure(.init(code: "CANCELLED", message: "No photo chosen.")))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let out = request.chat ? Self.chatJpeg(image) : Self.squareJpeg(image, side: 320, quality: 0.8).map { ["image": $0] }
            DispatchQueue.main.async {
                self?.shell?.publish(requestId: request.id, operation: operation,
                                     result: out.map { .success($0) } ?? .failure(.init(code: "INVALID", message: "That photo couldn't be used. Try another.")))
            }
        }
    }

    private static func render(_ image: UIImage, width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private static func chatJpeg(_ image: UIImage) -> [String: Any]? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        for (side, quality) in [(1280.0, 0.78), (1280.0, 0.66), (1024.0, 0.66), (880.0, 0.60), (720.0, 0.58)] {
            let scale = min(1.0, side / longest)
            let w = max(1, Int((image.size.width * scale).rounded())), h = max(1, Int((image.size.height * scale).rounded()))
            guard let data = render(image, width: w, height: h).jpegData(compressionQuality: quality) else { continue }
            let url = "data:image/jpeg;base64," + data.base64EncodedString()
            if url.count <= 700_000 { return ["image": url, "w": w, "h": h] }
        }
        return nil
    }

    private static func squareJpeg(_ image: UIImage, side: Int, quality: CGFloat) -> String? {
        let size = min(image.size.width, image.size.height)
        guard size > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let square = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            let scale = CGFloat(side) / size
            let w = image.size.width * scale, h = image.size.height * scale
            image.draw(in: CGRect(x: (CGFloat(side) - w) / 2, y: (CGFloat(side) - h) / 2, width: w, height: h))
        }
        return square.jpegData(compressionQuality: quality).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
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

    // MARK: Sign in with Apple

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
        shell?.evaluate("window.appleSignInReceived && window.appleSignInReceived(\(WebShellViewController.jsString(idToken)), \(WebShellViewController.jsString(nonce)), \(WebShellViewController.jsString(name)))")
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        appleNonce = nil
        // Closing Apple's sheet isn't an error worth a message.
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        appleFailed(cancelled ? "" : "Apple sign-in could not be completed. Try again.")
    }

    private func appleFailed(_ message: String) {
        shell?.evaluate("window.appleSignInFailed && window.appleSignInFailed(\(WebShellViewController.jsString(message)))")
    }

    // MARK: Google sign-in (same page callbacks as Android and the Restaurant iPhone app)

    private func signInWithGoogle() {
        guard let shell, let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty else {
            googleFailed("Google sign-in is not configured for this build."); return
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        GIDSignIn.sharedInstance.signIn(withPresenting: shell) { [weak self] result, error in
            if let token = result?.user.idToken?.tokenString {
                // The page keeps the Firebase session; let the next sign-in pick an account again.
                GIDSignIn.sharedInstance.signOut()
                self?.shell?.evaluate("window.googleIdTokenReceived && window.googleIdTokenReceived(\(WebShellViewController.jsString(token)))")
                return
            }
            let cancelled = (error as NSError?)?.code == GIDSignInError.Code.canceled.rawValue
            self?.googleFailed(cancelled ? "Google sign-in was cancelled." : "Google sign-in could not be completed. Try again.")
        }
    }

    private func googleFailed(_ message: String) {
        shell?.evaluate("window.googleSignInFailed && window.googleSignInFailed(\(WebShellViewController.jsString(message)))")
    }

    func open(url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    // MARK: push notifications

    private static let pushTokenKey = "scraveit.pushToken"

    /// Same payload as Android's registerPushToken, with platform "ios".
    private func registerPush(requestId: String, idToken: String) {
        let fail = { [weak self] in
            self?.shell?.publish(requestId: requestId, operation: "registerPushToken",
                                 result: .failure(.init(code: "PUSH_TOKEN_UNAVAILABLE",
                                                        message: "Notifications could not be enabled on this device.")))
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
                Task { [weak self] in
                    guard let token = await Self.fcmToken(), let self else { fail(); return }
                    UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
                    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
                    self.callFunction("registerPushToken", operation: "registerPushToken", requestId: requestId, idToken: idToken,
                                      payload: ["token": token, "app": "customer", "platform": "ios",
                                                "appVersion": version, "deviceModel": Self.deviceModel()])
                }
            }
        }
    }

    private func unregisterPush(requestId: String, idToken: String) {
        let token = UserDefaults.standard.string(forKey: Self.pushTokenKey) ?? ""
        guard token.count >= 20 else {
            shell?.publish(requestId: requestId, operation: "unregisterPushToken", result: .success(["removed": false]))
            return
        }
        Task { [weak self] in
            let result = await CallableClient.call("unregisterPushToken", idToken: idToken, data: ["token": token])
            if case .success = result { UserDefaults.standard.removeObject(forKey: Self.pushTokenKey) }
            self?.shell?.publish(requestId: requestId, operation: "unregisterPushToken", result: result)
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

    // MARK: payments, sharing, notifications

    private var paymentSheet: PaymentSheetController?

    /// Pays a Cashfree order inside the app (Android: MainActivity.startCashfreePayment).
    /// payload: {paymentUrl, upiAppId?}; iPhone can't list UPI apps, so Cashfree's page offers them.
    /// The reply only says the sheet closed; the page then asks the server whether the money came in.
    private func startCashfreePayment(requestId: String, payloadJson: String) {
        let link = ((jsonObject(payloadJson)["paymentUrl"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        guard link.count <= 2_048, let url = URL(string: link), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == "www.scraveit.in" || host == "scraveit.in",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let order = items.first(where: { $0.name == "order_id" })?.value,
              order.range(of: "^SVPAY_[A-F0-9]{32}$", options: .regularExpression) != nil,
              let session = items.first(where: { $0.name == "session" })?.value,
              session.range(of: "^session_[A-Za-z0-9_-]{10,400}$", options: .regularExpression) != nil else {
            shell?.publish(requestId: requestId, operation: "startCashfreePayment",
                           result: .failure(.init(code: "INVALID_ARGUMENT", message: "The payment link is invalid.")))
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let shell = self.shell else { return }
            if self.paymentSheet != nil {
                shell.publish(requestId: requestId, operation: "startCashfreePayment",
                              result: .failure(.init(code: "PAYMENT_IN_PROGRESS", message: "A payment is already open.")))
                return
            }
            shell.evaluate("window.__scraveitPaySheetOpen=true;")
            self.paymentSheet = PaymentSheetController.present(url: url, over: shell,
                onLeaveApp: { [weak self] in self?.leftForOwnScreen = true },
                onDone: { [weak self] outcome in
                    guard let self else { return }
                    self.paymentSheet = nil
                    self.shell?.evaluate("window.__scraveitPaySheetOpen=false;")
                    if outcome == .failedToLoad {
                        self.shell?.publish(requestId: requestId, operation: "startCashfreePayment",
                                            result: .failure(.init(code: "PAYMENT_NOT_STARTED",
                                                                   message: "The payment page didn't open. Check your internet and try again.")))
                        return
                    }
                    self.shell?.publish(requestId: requestId, operation: "startCashfreePayment",
                                        result: .success(["paymentOrderId": order, "finished": outcome == .finished]))
                })
        }
    }

    private func openPayment(requestId: String, link: String) {
        guard link.count <= 8_192, let url = URL(string: link.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), ["https", "upi", "phonepe", "paytmmp", "tez", "gpay"].contains(scheme) else {
            shell?.publish(requestId: requestId, operation: "openExternalPayment",
                           result: .failure(.init(code: "INVALID_ARGUMENT", message: "This payment link isn't supported on iPhone.")))
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.leftForOwnScreen = true
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

extension CustomerBridge: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
            finishPhoto(nil); return
        }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
            DispatchQueue.main.async { self?.finishPhoto(object as? UIImage) }
        }
    }
}
