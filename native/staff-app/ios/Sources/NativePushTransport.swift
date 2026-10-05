import Foundation

/// Dedicated credential-free transport. It cannot read the staff cookie jar,
/// follow redirects or change the origin. Only the narrow revocation route exists.
@MainActor final class NativePushAnonymousClient {
  private let session: URLSession
  init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 20
    session = URLSession(configuration: configuration, delegate: NativePushNoRedirect(), delegateQueue: nil)
  }
  func request(_ path: String, _ method: String, _ body: [String: Any]?, _ key: String?) async throws -> Data {
    let parts = path.split(separator: "/")
    guard method == "POST", key == nil, parts.count == 6,
      parts[0] == "api", parts[1] == "native", parts[2] == "push", parts[3] == "installations",
      UUID(uuidString: String(parts[4])) != nil, parts[5] == "revoke-capability",
      let body, Set(body.keys) == ["revision", "revocationSecret"],
      let revision = body["revision"] as? Int, revision > 0,
      let secret = body["revocationSecret"] as? String, NativePushState.validSecret(secret),
      let url = URL(string: "https://mbox.shmbox.com" + path)
    else { throw NativePushError.invalid }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
      throw NativePushError.invalid
    }
    return data
  }
}
private final class NativePushNoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
