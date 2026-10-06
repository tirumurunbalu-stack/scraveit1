import Foundation
import WebKit
import UniformTypeIdentifiers

/// Serves the app's web screens from the bundle at scraveit://app/..., the iOS
/// counterpart of Android's https://appassets.androidplatform.net. One fixed
/// origin keeps the page's Content-Security-Policy ('self') and storage
/// (IndexedDB for the Firebase session) working, and nothing outside the
/// bundled folder can be read.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "scraveit"
    static let host = "app"
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.host == Self.host else {
            urlSchemeTask.didFailWithError(URLError(.badURL)); return
        }
        let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let file = root.appendingPathComponent(relative.isEmpty ? "premium.html" : relative).standardizedFileURL
        // Never step outside the bundled web folder.
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let headers = [
            "Content-Type": mime + (mime.hasPrefix("text/") || mime.hasSuffix("javascript") ? "; charset=utf-8" : ""),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
