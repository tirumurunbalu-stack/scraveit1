import UIKit
import WebKit

/// Cashfree's checkout inside the app (founder 21 Nov 2026: on iPhone, UPI and card payments
/// opened Safari and left the app). It does the job of Android's Cashfree SDK screen:
/// the page shows Cashfree's checkout, a UPI app button opens that UPI app, and the sheet closes
/// when Cashfree finishes, when the person comes back from the UPI app, or when they close it.
/// Whether the money came in is never read from this page: the app then shows
/// "Confirming your payment" and asks the server (checkOrderPayment), exactly as on Android.
final class PaymentSheetController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    enum Outcome { case finished, closed, returnedFromApp, failedToLoad }

    private let startURL: URL
    private let onLeaveApp: () -> Void
    private var onDone: ((Outcome) -> Void)?
    private var web: WKWebView!
    private var popup: WKWebView?
    /// A UPI app was opened from here and the phone actually switched to it.
    private var openedPaymentApp = false
    private var wentToBackground = false

    init(url: URL, onLeaveApp: @escaping () -> Void, onDone: @escaping (Outcome) -> Void) {
        self.startURL = url
        self.onLeaveApp = onLeaveApp
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
        title = "Pay securely"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Shown full screen inside a blue bar with a close button, like Android's Cashfree screen.
    static func present(url: URL, over host: UIViewController, onLeaveApp: @escaping () -> Void,
                        onDone: @escaping (Outcome) -> Void) -> PaymentSheetController {
        let sheet = PaymentSheetController(url: url, onLeaveApp: onLeaveApp, onDone: onDone)
        let nav = LightBarNavigationController(rootViewController: sheet)
        nav.modalPresentationStyle = .fullScreen
        let bar = UINavigationBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = UIColor(red: 0x14 / 255, green: 0x60 / 255, blue: 0xF0 / 255, alpha: 1)
        bar.titleTextAttributes = [.foregroundColor: UIColor.white]
        nav.navigationBar.standardAppearance = bar
        nav.navigationBar.scrollEdgeAppearance = bar
        nav.navigationBar.compactAppearance = bar
        nav.navigationBar.tintColor = .white
        var top = host
        while let next = top.presentedViewController { top = next }
        top.present(nav, animated: true)
        return sheet
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Payment pages expect a normal Safari; without the Safari token some bank pages refuse to load.
        config.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "xmark"), style: .plain,
                                                           target: self, action: #selector(closeTapped))
        navigationItem.leftBarButtonItem?.accessibilityLabel = "Close payment"
        NotificationCenter.default.addObserver(self, selector: #selector(leftApp),
                                               name: UIScene.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack),
                                               name: UIScene.didActivateNotification, object: nil)
        web.load(URLRequest(url: startURL))
    }

    @objc private func closeTapped() { finish(.closed) }

    /// Closes the sheet and reports once. Safe to call more than once.
    func finish(_ outcome: Outcome) {
        guard let done = onDone else { return }
        onDone = nil
        NotificationCenter.default.removeObserver(self)
        web?.stopLoading()
        let close = { [weak self] in
            guard let presenter = self?.navigationController?.presentingViewController else { done(outcome); return }
            presenter.dismiss(animated: true) { done(outcome) }
        }
        // Still sliding in (an answer that came back at once): close once it has arrived.
        if let coordinator = navigationController?.transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { _ in close() }
        } else {
            close()
        }
    }

    // MARK: coming back from the UPI app

    @objc private func leftApp() {
        if openedPaymentApp { wentToBackground = true }
    }

    /// Back from the UPI app: close at once so "Confirming your payment" shows, as Zomato and
    /// Android do. Switching away for anything else (copying a bank OTP) keeps the page open.
    @objc private func cameBack() {
        guard openedPaymentApp, wentToBackground else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.finish(.returnedFromApp) }
    }

    // MARK: navigation

    private static func isReturnPage(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == "www.scraveit.in" || host == "scraveit.in",
              url.path == "/pay" || url.path == "/pay/",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        return items.contains { $0.name == "op" && $0.value == "return" }
    }

    /// upi://, phonepe://, tez://, paytmmp://, bhim:// and the like belong to the payment apps.
    private func openPaymentApp(_ url: URL) {
        onLeaveApp()
        UIApplication.shared.open(url) { [weak self] opened in
            guard let self else { return }
            if opened {
                self.openedPaymentApp = true
            } else {
                // Also the answer when the person taps Cancel on iPhone's "Open PhonePe?" question.
                let alert = UIAlertController(title: "Payment app didn't open",
                                              message: "If it isn't on this iPhone, choose another way to pay.",
                                              preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(alert, animated: true)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel); return
        }
        if scheme == "http" || scheme == "https" {
            if Self.isReturnPage(url) {
                decisionHandler(.cancel)
                finish(.finished)
                return
            }
            decisionHandler(.allow)
            return
        }
        if ["about", "data", "blob", "javascript"].contains(scheme) {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
        openPaymentApp(url)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        let failure = error as NSError
        // Cancelled loads (a UPI link handed to its app, or the return page) are not failures.
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        guard webView.url == nil || webView.url == startURL else { return }
        let alert = UIAlertController(title: "Payment page didn't open",
                                      message: "Check your internet connection and try again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.finish(.failedToLoad) })
        present(alert, animated: true)
    }

    // Bank pages that open a new window: show it on top, and close it when the page closes it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
           scheme != "http", scheme != "https", scheme != "about" {
            openPaymentApp(url)
            return nil
        }
        popup?.removeFromSuperview()
        let child = WKWebView(frame: web.bounds, configuration: configuration)
        child.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        child.navigationDelegate = self
        child.uiDelegate = self
        web.addSubview(child)
        popup = child
        return child
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === popup {
            popup?.removeFromSuperview()
            popup = nil
        }
    }

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

/// White status-bar text over the blue bar.
private final class LightBarNavigationController: UINavigationController {
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}
