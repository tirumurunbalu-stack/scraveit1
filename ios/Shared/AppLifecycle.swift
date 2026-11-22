import UIKit
import UserNotifications
import FirebaseCore
import FirebaseAppCheck
import FirebaseMessaging

/// Each app target provides its bridge through this one function.
protocol ScraveitApp {
    static func makeBridge() -> NativeBridge
}

/// Hands notification events to the app's bridge. A tap that launches the app
/// can arrive before the screen exists, so those wait here until it does.
final class NotificationRouter {
    static let shared = NotificationRouter()
    private weak var bridge: NativeBridge?
    private var waitingReceived: [[AnyHashable: Any]] = []
    private var waitingOpened: [[AnyHashable: Any]] = []

    func attach(_ bridge: NativeBridge) {
        self.bridge = bridge
        let received = waitingReceived, opened = waitingOpened
        waitingReceived = []
        waitingOpened = []
        received.forEach { bridge.notificationReceived($0) }
        opened.forEach { bridge.notificationOpened($0) }
    }

    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        bridge?.presentationOptions(for: notification) ?? [.banner, .sound]
    }

    func received(_ userInfo: [AnyHashable: Any]) {
        if let bridge { bridge.notificationReceived(userInfo) } else { waitingReceived.append(userInfo) }
    }

    func opened(_ userInfo: [AnyHashable: Any]) {
        if let bridge { bridge.notificationOpened(userInfo) } else { waitingOpened.append(userInfo) }
    }

    func open(url: URL) -> Bool { bridge?.open(url: url) ?? false }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // App Check proves calls come from this genuine app. The simulator and
        // debug builds use a registered debug token; real phones use App Attest.
        #if DEBUG || targetEnvironment(simulator)
        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
        #else
        AppCheck.setAppCheckProviderFactory(AttestProviderFactory())
        #endif
        FirebaseApp.configure()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // Firebase swizzling also forwards these, but passing the token directly
    // keeps push working if swizzling is ever turned off.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    // Pushes that reach the app itself (for example "this order was answered",
    // which silences the order alarm), open or in the background.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationRouter.shared.received(userInfo)
        completionHandler(.noData)
    }

    // Order updates still show while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(NotificationRouter.shared.presentationOptions(for: notification))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        NotificationRouter.shared.opened(response.notification.request.content.userInfo)
        completionHandler()
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let bridge = AppEntry.makeBridge()
        window.rootViewController = WebShellViewController(bridge: bridge)
        window.makeKeyAndVisible()
        self.window = window
        // A tap that launched the app reaches the notification delegate (set
        // before launch finished) and waits in the router until now.
        NotificationRouter.shared.attach(bridge)
        connectionOptions.urlContexts.forEach { _ = NotificationRouter.shared.open(url: $0.url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach { _ = NotificationRouter.shared.open(url: $0.url) }
    }
}

/// App Attest on supported phones, DeviceCheck on the rest.
final class AttestProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        if #available(iOS 14.0, *) { return AppAttestProvider(app: app) }
        return DeviceCheckProvider(app: app)
    }
}
