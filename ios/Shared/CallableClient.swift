import Foundation
import FirebaseAppCheck

/// Calls a Scraveit Cloud Function the same way the Android apps do: an HTTPS
/// POST to the callable endpoint with the signed-in user's ID token and an
/// App Check token, so the server treats both platforms identically.
enum CallableClient {
    static let region = "asia-south1"
    static let project = "savrivo-app"

    struct Failure: Error {
        let code: String
        let message: String
    }

    static func call(_ function: String, idToken: String, data: [String: Any]) async -> Result<[String: Any], Failure> {
        guard function.range(of: "^[A-Za-z][A-Za-z0-9]{1,80}$", options: .regularExpression) != nil else {
            return .failure(Failure(code: "FUNCTION_NOT_ALLOWED", message: "This request isn't available."))
        }
        guard idToken.count >= 32, idToken.count <= 16_384 else {
            return .failure(Failure(code: "AUTH_REQUIRED", message: "Sign in again to continue."))
        }
        guard let url = URL(string: "https://\(region)-\(project).cloudfunctions.net/\(function)") else {
            return .failure(Failure(code: "INVALID_ARGUMENT", message: "The request is invalid."))
        }
        var appCheckToken = ""
        do {
            appCheckToken = try await AppCheck.appCheck().token(forcingRefresh: false).token
        } catch {
            return .failure(Failure(code: "APP_CHECK_TOKEN_UNAVAILABLE",
                                    message: "Secure sync is starting up. Try again in a moment."))
        }
        var request = URLRequest(url: url, timeoutInterval: 45)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        request.setValue("scraveit-ios/\(version)", forHTTPHeaderField: "X-Client-Version")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: ["data": data])
        } catch {
            return .failure(Failure(code: "INVALID_ARGUMENT", message: "The request is invalid."))
        }
        do {
            let (body, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            if (200..<300).contains(status), let result = json["result"] {
                return .success(result as? [String: Any] ?? ["value": result])
            }
            let error = json["error"] as? [String: Any] ?? [:]
            let code = (error["status"] as? String) ?? (status == 0 ? "UNAVAILABLE" : "HTTP_\(status)")
            let message = (error["message"] as? String) ?? "The request could not be completed."
            return .failure(Failure(code: code, message: String(message.prefix(300))))
        } catch {
            return .failure(Failure(code: "UNAVAILABLE", message: "Check your connection and try again."))
        }
    }

    /// Like call(), but answers with the function's own result value (any JSON
    /// type, as the Android store apps pass it to the page) and retries the way
    /// Android does: once with a fresh App Check token after a 401/403, and once
    /// after 2 s when Google's gateway answered 502/503/504 before the function ran.
    static func callValue(_ function: String, idToken: String, data: [String: Any]) async -> Result<Any, Failure> {
        guard function.range(of: "^[A-Za-z][A-Za-z0-9]{1,80}$", options: .regularExpression) != nil else {
            return .failure(Failure(code: "FUNCTION_NOT_ALLOWED", message: "FUNCTION_NOT_ALLOWED"))
        }
        guard idToken.count >= 32, idToken.count <= 16_384 else {
            return .failure(Failure(code: "AUTH_REQUIRED", message: "AUTH_REQUIRED"))
        }
        guard let url = URL(string: "https://\(region)-\(project).cloudfunctions.net/\(function)"),
              let body = try? JSONSerialization.data(withJSONObject: ["data": data]) else {
            return .failure(Failure(code: "INVALID_PAYLOAD", message: "INVALID_PAYLOAD"))
        }
        var freshAppCheck = false, gatewayRetried = false
        while true {
            let appCheckToken: String
            do {
                appCheckToken = try await AppCheck.appCheck().token(forcingRefresh: freshAppCheck).token
            } catch {
                if !freshAppCheck { freshAppCheck = true; continue }
                return .failure(Failure(code: "APP_CHECK_TOKEN_UNAVAILABLE", message: "APP_CHECK_TOKEN_UNAVAILABLE"))
            }
            var request = URLRequest(url: url, timeoutInterval: 45)
            request.httpMethod = "POST"
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
            request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
            request.setValue("scraveit-ios/\(version)", forHTTPHeaderField: "X-Client-Version")
            request.httpBody = body
            let reply: Data, status: Int
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                reply = data
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
            } catch {
                return .failure(Failure(code: "FUNCTION_NETWORK_ERROR", message: "Check your connection and try again."))
            }
            if (status == 401 || status == 403) && !freshAppCheck {
                freshAppCheck = true
                continue
            }
            guard let json = (try? JSONSerialization.jsonObject(with: reply, options: [.fragmentsAllowed])) as? [String: Any] else {
                if [502, 503, 504].contains(status) && !gatewayRetried {
                    gatewayRetried = true
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                return .failure(Failure(code: "FUNCTION_HTTP_\(status)", message: "FUNCTION_HTTP_\(status)"))
            }
            if (200..<300).contains(status), let result = json["result"] ?? json["data"] {
                return .success(result)
            }
            let error = json["error"] as? [String: Any] ?? [:]
            let message = (error["message"] as? String) ?? (error["status"] as? String) ?? "FUNCTION_HTTP_\(status)"
            return .failure(Failure(code: (error["status"] as? String) ?? "FUNCTION_HTTP_\(status)", message: String(message.prefix(500))))
        }
    }
}
