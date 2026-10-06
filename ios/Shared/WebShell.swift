import UIKit
import WebKit

/// What each app adds on top of the shared shell: the JavaScript object the
/// web screens talk to (window.FeastlyNative on Android) and the native work
/// behind each of its methods.
protocol NativeBridge: AnyObject {
    /// Runs before the page's own scripts, defining the native object.
    var shimScript: String { get }
    func handle(_ method: String, _ args: [Any], shell: WebShellViewController)
}

/// The app's single screen: a WKWebView showing the same web screens the
/// Android app ships, served from the bundle, with a message channel back to
/// native code. Results go back through window.savrivoNativeResult, exactly
/// as on Android, so the web screens need no iOS-specific code.
final class WebShellViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let bridge: NativeBridge
    private(set) var webView: WKWebView!
    var statusBarStyle: UIStatusBarStyle = .darkContent {
        didSet { setNeedsStatusBarAppearanceUpdate() }
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }

    init(bridge: NativeBridge) {
        self.bridge = bridge
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        if let root = Bundle.main.url(forResource: "www", withExtension: nil) {
            config.setURLSchemeHandler(AssetSchemeHandler(root: root), forURLScheme: AssetSchemeHandler.scheme)
        }
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: bridge.shimScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakScriptHandler(self), name: "native")
        #if DEBUG
        // Debug builds echo the page's errors to the Xcode/simulator console.
        controller.addUserScript(WKUserScript(source: """
        (function(){
          var send = function(kind, text){ try { window.webkit.messageHandlers.log.postMessage(kind + ": " + String(text).slice(0, 800)); } catch(e) {} };
          window.addEventListener("error", function(e){ send("error", (e.message || e) + " @" + (e.filename || "") + ":" + (e.lineno || "")); });
          window.addEventListener("unhandledrejection", function(e){ send("rejection", e.reason && (e.reason.stack || e.reason.message) || e.reason); });
          var original = console.error; console.error = function(){ send("console.error", Array.prototype.join.call(arguments, " ")); original.apply(console, arguments); };
          var warn = console.warn; console.warn = function(){ send("console.warn", Array.prototype.join.call(arguments, " ")); warn.apply(console, arguments); };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakScriptHandler(self), name: "log")
        #endif
        config.userContentController = controller
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let web = WKWebView(frame: .zero, configuration: config)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        // No rubber-band bounce: the screens scroll inside the page, and a
        // bounce of the whole view looked like the page dragging by itself.
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.navigationDelegate = self
        web.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        view = web
        webView = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "\(AssetSchemeHandler.scheme)://\(AssetSchemeHandler.host)/premium.html")!))
    }

    // MARK: messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "log" { NSLog("[web] %@", String(describing: message.body)); return }
        // Only the app's own page may talk to native code.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == AssetSchemeHandler.scheme,
              let body = message.body as? [String: Any],
              let method = body["m"] as? String else { return }
        bridge.handle(method, body["a"] as? [Any] ?? [], shell: self)
    }

    func evaluate(_ script: String) {
        DispatchQueue.main.async { [weak self] in
            guard let web = self?.webView, web.url?.scheme == AssetSchemeHandler.scheme else { return }
            web.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    /// Answers a request the page made, in the shape Android uses.
    func publish(requestId: String, operation: String, result: Result<[String: Any], CallableClient.Failure>) {
        var response: [String: Any] = ["requestId": requestId, "operation": operation]
        switch result {
        case .success(let data):
            response["ok"] = true
            response["data"] = data
        case .failure(let failure):
            response["ok"] = false
            response["code"] = failure.code
            response["message"] = failure.message
        }
        guard let json = try? JSONSerialization.data(withJSONObject: response),
              let text = String(data: json, encoding: .utf8) else { return }
        evaluate("window.savrivoNativeResult && window.savrivoNativeResult(\(text));")
    }

    /// A JavaScript string literal for `value`, safe to splice into a script.
    static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel); return
        }
        if [AssetSchemeHandler.scheme, "about", "data", "blob"].contains(scheme) {
            decisionHandler(.allow); return
        }
        // Links out of the app (terms, maps, phone numbers, UPI) open where they belong.
        if navigationAction.targetFrame?.isMainFrame ?? true {
            if ["https", "http", "tel", "mailto", "upi", "whatsapp"].contains(scheme) { UIApplication.shared.open(url) }
            decisionHandler(.cancel); return
        }
        decisionHandler(scheme == "https" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[web] page failed to load: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        NSLog("[web] loaded %@", webView.url?.absoluteString ?? "")
        #endif
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // Page dialogs, so a confirm() can never leave the page waiting.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}

/// Keeps the script message channel from holding the screen alive.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
