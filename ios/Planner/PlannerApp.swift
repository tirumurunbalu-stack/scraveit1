import UIKit
import WebKit

/// Scraveit Price Planner for iPhone: the same offline page as the Android app
/// (native_android/planner/src/main/assets), served from the bundle. No sign-in,
/// no network, no Firebase; numbers stay on the phone (the page's localStorage).
@main
final class PlannerAppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        config.delegateClass = PlannerSceneDelegate.self
        return config
    }
}

final class PlannerSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = PlannerViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class PlannerViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    override func loadView() {
        let config = WKWebViewConfiguration()
        if let root = Bundle.main.url(forResource: "www", withExtension: nil) {
            config.setURLSchemeHandler(AssetSchemeHandler(root: root), forURLScheme: AssetSchemeHandler.scheme)
        }
        let controller = WKUserContentController()
        // Android's PlannerNative.shareText(text): share the price list (WhatsApp, Notes, ...).
        controller.addUserScript(WKUserScript(source: """
        window.PlannerNative = { platform: "ios", shareText: function(text){ try { window.webkit.messageHandlers.planner.postMessage(String(text || "")); } catch(e) {} } };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakHandler(self), name: "planner")
        config.userContentController = controller
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.965, green: 0.969, blue: 0.984, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        view = web
        webView = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "\(AssetSchemeHandler.scheme)://\(AssetSchemeHandler.host)/index.html")!))
        // Put the page back at full width if iOS zoomed into a text box.
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidHide),
                                               name: UIResponder.keyboardDidHideNotification, object: nil)
    }

    @objc private func keyboardDidHide() {
        guard let scroll = webView?.scrollView else { return }
        if scroll.zoomScale != scroll.minimumZoomScale { scroll.setZoomScale(scroll.minimumZoomScale, animated: true) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == AssetSchemeHandler.scheme,
              let text = message.body as? String, !text.isEmpty, text.count <= 20_000 else { return }
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    /// Only the planner's own page; nothing else loads (the page has no links out).
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == AssetSchemeHandler.scheme ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
