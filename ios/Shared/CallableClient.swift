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
}
