import UIKit
import WebKit
import CoreLocation
import UserNotifications
import AVFoundation
import AudioToolbox
import FirebaseCore
import FirebaseMessaging
import GoogleSignIn

enum AppEntry: ScraveitApp {
    static func makeBridge() -> NativeBridge { AdminBridge() }
}

/// The iOS side of the Admin app's two page objects, with the same methods,
/// arguments and replies as Android:
/// - window.SavrivoCloudNative (SavrivoOperationsBridge): push and the admin server calls.
/// - window.FeastlyAdminNative (admin MainActivity.AdminBridge): Google sign-in, location,
///   maps, request alarms (rider/store applications, support tickets) and the vibrate-only switch.
/// Left out on iPhone: the native photo upload (the page uploads photos itself).
/// The app is for the owner only: it goes to TestFlight internal testing, never the App Store,
/// and the server still checks the owner/ops_admin role on every call.
final class AdminBridge: NSObject, NativeBridge, CLLocationManagerDelegate, MessagingDelegate, UIGestureRecognizerDelegate {
    /// Same list as Android's SavrivoCallableClient.ADMIN_ECONOMICS.
    private static let economics: Set<String> = [
        "getEconomicsControl", "updateEconomicsControl", "simulateEconomicsOffer",
        "simulateEconomicsGuarantee", "upsertPromotionPolicy", "upsertGrowthBudget",
        "reviewRestaurantOffer", "getCityEconomics", "upsertCashbackCampaign",
        "listCashbackCampaigns", "listCustomerReferrals", "reviewCustomerReferral",
        "upsertCityOperatingCost", "listCityOperatingCosts", "getCityBreakEven",
        "getRiderReferralOverview", "reviewRiderReferral", "simulateRiderReferral",
        "listTdsCommissionClaimsForReview", "reviewTdsCommissionClaim",
        "setRestaurantAgreementTerms", "getRestaurantApplicationReview",
        "requestRestaurantApplicationChanges", "approveRestaurantApplication", "getAdminToday",
        "getStorePayoutsDue", "getPayoutAutomationStatus", "previewWeeklyPayouts",
        "getAdminAnalytics", "resolveChatReport", "recordRiderPanCheck", "reviewReel",
        "getAdsReport", "runLearningNow", "serverWarmth", "adminCommissionNotice",
    ]
    /// Page method -> server function, for the plain (requestId, idToken, payloadJson) calls.
    private static let plainCalls: [String: String] = [
        "updateOrderStatus": "updateOrderStatus",
        "getAdminDashboard": "getAdminDashboard",
        "recordCodRemittance": "recordCodRemittance",
        "recordRiderPayout": "recordRiderPayout",
        "recordRestaurantSettlement": "recordRestaurantSettlement",
        "getRiderFinancialSummary": "getRiderFinancialSummary",
        "getAdminRiderRewardsDashboard": "getAdminRiderRewardsDashboard",
        "upsertRiderRewardCampaignPolicy": "upsertRiderRewardCampaignPolicy",
        "updateRiderRewardSettingsPolicy": "updateRiderRewardSettingsPolicy",
        "getPlatformConfiguration": "getPlatformConfiguration",
        "exportPlatformDataWorkbook": "exportPlatformDataWorkbook",
        "updatePlatformConfigurationPolicy": "updatePlatformConfigurationPolicy",
        "getRestaurantSettlementSummary": "getRestaurantSettlementSummary",
        "getRiderIdentityReview": "getRiderIdentityReviewCall",
        "resolveRiderFaceReview": "resolveRiderFaceReviewCall",
    ]
    private static let cloudMethods = ["registerPushToken", "unregisterPushToken", "clearPushIdentity", "invokeEconomics"]
        + plainCalls.keys.sorted()
    private static let adminMethods = [
        "signInWithGoogle", "vibrateSuccess", "requestRestaurantLocation", "openNavigation",
        "notifyOrder", "startSupportAlarm", "stopSupportAlarm", "stopRequestAlarm",
        "setAlarmVibrateOnly", "testRequestAlarm",
    ]
    private static let pushTokenKey = "scraveit.admin.pushToken"

    private weak var shell: WebShellViewController?
    private let location = CLLocationManager()
    private var wantsLocation = false
    private let alarm = AdminAlarm()
    private var waitingPushEvents: [[String: Any]] = []
    private var pushFlushScheduled = false
    private var pageLoaded = false
    private var backGestureAdded = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        Messaging.messaging().delegate = self
    }

    var shimScript: String {
        let cloud = Self.cloudMethods.map { "\"\($0)\"" }.joined(separator: ",")
        let admin = Self.adminMethods.map { "\"\($0)\"" }.joined(separator: ",")
        // isAlarmVibrateOnly must answer at once (Android returns it directly),
        // so the page keeps a copy that setAlarmVibrateOnly updates.
        return """
        (function(){
          if (window.SavrivoCloudNative) return;
          var post = function(m, a){ try { window.webkit.messageHandlers.native.postMessage({m:m, a:Array.prototype.slice.call(a||[])}); } catch(e) {} };
          var make = function(prefix, names){ var api = {}; names.forEach(function(n){ api[n] = function(){ post(prefix + n, arguments); }; }); return api; };
          window.SavrivoCloudNative = make("cloud.", [\(cloud)]);
          var admin = make("admin.", [\(admin)]);
          var vibrateOnly = \(AdminAlarm.vibrateOnly ? "true" : "false");
          admin.isAlarmVibrateOnly = function(){ return vibrateOnly; };
          admin.setAlarmVibrateOnly = function(on){ vibrateOnly = !!on; post("admin.setAlarmVibrateOnly", [!!on]); };
          admin.platform = "ios";
          window.FeastlyAdminNative = admin;
        })();
        """
    }

    func pageDidLoad(shell: WebShellViewController) {
        self.shell = shell
        pageLoaded = true
        // The admin screens are dark: white clock and battery.
        shell.statusBarStyle = .lightContent
        addBackGesture(to: shell)
        flushPushEvents()
    }

    func handle(_ method: String, _ args: [Any], shell: WebShellViewController) {
        self.shell = shell
        let text = { (i: Int) -> String in i < args.count ? String(describing: args[i]) : "" }
        if method.hasPrefix("cloud."), let function = Self.plainCalls[String(method.dropFirst("cloud.".count))] {
            return call(function, requestId: text(0), idToken: text(1), payloadJson: text(2))
        }
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
        case "cloud.invokeEconomics":
            guard Self.economics.contains(text(1)) else { return reject(text(0), "FUNCTION_NOT_ALLOWED") }
            call(text(1), requestId: text(0), idToken: text(2), payloadJson: text(3))
        case "admin.signInWithGoogle":
            DispatchQueue.main.async { self.signInWithGoogle() }
        case "admin.vibrateSuccess":
            DispatchQueue.main.async { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        case "admin.requestRestaurantLocation":
            DispatchQueue.main.async { self.requestLocation() }
        case "admin.openNavigation":
            openNavigation(text(0))
        case "admin.notifyOrder":
            postLocal(id: "order-\(text(2))", title: text(0), body: text(1), info: ["type": "ADMIN_ORDER"])
        case "admin.startSupportAlarm":
            let id = "support:\(text(2))"
            alarm.start(id)
            postLocal(id: id, title: text(0), body: text(1), info: ["type": "ADMIN_SUPPORT", "alarmId": id, "route": "support:"])
        case "admin.stopSupportAlarm":
            let id = "support:\(text(0))"
            alarm.stop(id)
            AdminAlarm.removeDelivered(alarmId: id)
        case "admin.stopRequestAlarm":
            let id = text(0).trimmingCharacters(in: .whitespaces)
            guard id.hasPrefix("req:") else { return }
            alarm.stop(id)
            AdminAlarm.removeDelivered(alarmId: id)
        case "admin.setAlarmVibrateOnly":
            AdminAlarm.vibrateOnly = (args.first as? Bool) ?? ((args.first as? NSNumber)?.boolValue ?? false)
        case "admin.testRequestAlarm":
            testAlarm()
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
           data.count <= 2_000_000, let text = String(data: data, encoding: .utf8) {
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

    /// Same payload as Android's registerPushToken: app "admin", platform "ios".
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
                                  payload: ["token": token, "app": "admin", "platform": "ios",
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

    /// A request alarm while the app is open rings here until the request is opened
    /// (the banner stays quiet so the two sounds don't overlap).
    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        let event = Self.event(from: notification.request.content.userInfo)
        let type = event["type"] as? String ?? ""
        if type == "ADMIN_ALARM" || type == "ADMIN_SUPPORT" {
            if let id = event["alarmId"] as? String, !id.isEmpty { alarm.start(id) }
            if type == "ADMIN_ALARM" { queuePushEvent(event) }
            return [.banner, .list]
        }
        if type == "ADMIN_TODO" { queuePushEvent(["type": "PUSH_RESYNC_REQUIRED"]) }
        return [.banner, .list, .sound]
    }

    func notificationReceived(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        switch type {
        case "ADMIN_ALARM":
            guard UIApplication.shared.applicationState == .active else { return }
            if let id = event["alarmId"] as? String, !id.isEmpty { alarm.start(id) }
            queuePushEvent(event)
        case "ORDER_STATUS", "PUSH_RESYNC_REQUIRED", "ADMIN_TODO":
            queuePushEvent(["type": "PUSH_RESYNC_REQUIRED"])
        default:
            break
        }
    }

    /// Tapping a request alarm opens that request, which is what stops it (as on Android).
    func notificationOpened(_ userInfo: [AnyHashable: Any]) {
        let event = Self.event(from: userInfo)
        let type = event["type"] as? String ?? ""
        let alarmId = event["alarmId"] as? String ?? ""
        let route = event["route"] as? String ?? ""
        switch type {
        case "ADMIN_ALARM", "ADMIN_SUPPORT":
            if !alarmId.isEmpty { alarm.stop(alarmId) }
            queuePushEvent(["type": "ADMIN_ALARM_OPEN", "route": route, "alarmId": alarmId])
        case "":
            break
        default:
            queuePushEvent(["type": "PUSH_RESYNC_REQUIRED"])
        }
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

    // MARK: local alerts

    private func postLocal(id: String, title: String, body: String, info: [String: String], after seconds: TimeInterval = 0) {
        guard id.range(of: "^[A-Za-z0-9_.:-]{1,160}$", options: .regularExpression) != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(120))
            content.body = String(body.prefix(400))
            // Request alarms use the app's own 29 s alarm sound and are time-sensitive so they show
            // during Focus (founder, 21 Nov 2026); vibrate-only keeps the short default sound.
            let ringing = info["type"] == "ADMIN_ALARM" || info["type"] == "ADMIN_SUPPORT"
            content.sound = ringing && !AdminAlarm.vibrateOnly ? UNNotificationSound(named: UNNotificationSoundName("admin_alert.caf")) : .default
            if ringing { content.interruptionLevel = .timeSensitive }
            content.userInfo = info
            let trigger = seconds > 0 ? UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false) : nil
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
    }

    /// A sample request so the owner can hear (or feel) the current setting.
    private func testAlarm() {
        let id = "req:test:alert"
        alarm.start(id)
        postLocal(id: id, title: "Test request alert",
                  body: "Tap to open it. The alert stops when the request is on screen.",
                  info: ["type": "ADMIN_ALARM", "alarmId": id, "route": "test"], after: 1)
    }

    // MARK: back swipe (Android's back button)

    private func addBackGesture(to shell: WebShellViewController) {
        guard !backGestureAdded, let web = shell.webView else { return }
        backGestureAdded = true
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(backSwiped(_:)))
        edge.edges = .left
        edge.delegate = self
        web.addGestureRecognizer(edge)
    }

    @objc private func backSwiped(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended else { return }
        script("window.handleAdminBack&&window.handleAdminBack()")
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

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

    func open(url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
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
            script("window.adminLocationReceived&&window.adminLocationReceived(\(here.coordinate.latitude),\(here.coordinate.longitude))")
        } else {
            script("window.adminLocationUnavailable&&window.adminLocationUnavailable()")
        }
    }

    private func openNavigation(_ destination: String) {
        let target = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, target.count <= 500,
              let encoded = target.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))),
              let url = URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(encoded)") else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
}

/// Rings for each open request (rider/store application, support ticket) until the
/// page opens it: the admin alert sound on repeat plus a buzz, or only the buzz when
/// "Vibrate only" is on. iPhone apps can't keep ringing once closed; then the
/// notification's own sound plays instead.
final class AdminAlarm {
    private static let vibrateKey = "scraveit.admin.alarmVibrateOnly"
    static var vibrateOnly: Bool {
        get { UserDefaults.standard.bool(forKey: vibrateKey) }
        set { UserDefaults.standard.set(newValue, forKey: vibrateKey) }
    }

    private var active = Set<String>()
    private var player: AVAudioPlayer?
    private var buzz: Timer?

    init() {
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func start(_ alarmId: String) {
        DispatchQueue.main.async {
            guard alarmId.range(of: "^[A-Za-z0-9_.:-]{1,170}$", options: .regularExpression) != nil else { return }
            self.active.insert(alarmId)
            self.ring()
        }
    }

    func stop(_ alarmId: String) {
        DispatchQueue.main.async {
            guard self.active.remove(alarmId) != nil else { return }
            if self.active.isEmpty { self.silence() }
        }
    }

    func stopAll() {
        DispatchQueue.main.async {
            self.active.removeAll()
            self.silence()
        }
    }

    /// Clears the request's banner once it has been opened.
    static func removeDelivered(alarmId: String) {
        guard !alarmId.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [alarmId])
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter {
                ($0.request.content.userInfo["alarmId"] as? String) == alarmId || $0.request.identifier == alarmId
            }.map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    private func ring() {
        guard !active.isEmpty, UIApplication.shared.applicationState != .background else { return }
        if !Self.vibrateOnly, player?.isPlaying != true {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                if player == nil, let url = Bundle.main.url(forResource: "admin_alert", withExtension: "mp3") {
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

    /// Back on screen with a request still open: ring again (iOS paused it in the background).
    @objc private func appBecameActive() {
        if !active.isEmpty { player?.stop(); ring() }
    }
}
