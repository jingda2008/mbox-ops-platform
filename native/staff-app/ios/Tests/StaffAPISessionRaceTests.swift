import Foundation

@MainActor private final class RaceTransport {
  var original: [String: Any]
  var next: [String: Any]
  var heldPath = ""
  var held: CheckedContinuation<(Data, HTTPURLResponse), Error>?
  var heldURL: URL?
  var requests: [URLRequest] = []
  init(_ auth: [String: Any]) {
    original = auth; next = auth
    var employee = auth["employee"] as! [String: Any]
    employee["id"] = UUID().uuidString.lowercased()
    next["employee"] = employee
    var session = auth["session"] as! [String: Any]
    session["id"] = UUID().uuidString.lowercased(); session["employeeId"] = employee["id"]
    next["session"] = session
  }
  func response(_ url: URL, status: Int, value: [String: Any], cookie: String) throws -> (Data, HTTPURLResponse) {
    (try JSONSerialization.data(withJSONObject: ["data": value]),
      HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
        headerFields: ["Set-Cookie": "__Host-mbox_staff_session=\(cookie); Path=/; Secure; HttpOnly"])!)
  }
  func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    let isNext = body?["employeeCode"] as? String == "NEXT"
    if request.url!.path == heldPath && !isNext {
      heldURL = request.url!
      return try await withCheckedThrowingContinuation { held = $0 }
    }
    return try response(request.url!, status: 200, value: isNext ? next : original,
      cookie: isNext ? "next-cookie" : "original-cookie")
  }
}

@main struct StaffAPISessionRaceTests {
  @MainActor static func main() async throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf:
      URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let auth = fixture["auth"] as! [String: Any]
    var count = 0
    func check(_ condition: Bool, _ label: String) {
      precondition(condition, label); count += 1; print("PASS \(label)")
    }
    for path in ["/api/operations", "/api/auth/heartbeat", "/api/auth/logout", "/api/auth/switch", "/api/auth/login"] {
      for status in [200, 401] {
        let harness = RaceTransport(auth)
        let api = StaffAPI(transport: harness.perform)
        _ = try await api.login(code: "FIRST", pin: "1234", switching: false)
        harness.heldPath = path
        let pending = Task { @MainActor () -> StaffAPIError? in
          do {
            switch path {
            case "/api/auth/heartbeat": _ = try await api.heartbeat()
            case "/api/auth/logout": try await api.logout()
            case "/api/auth/switch": _ = try await api.login(code: "FIRST", pin: "1234", switching: true)
            case "/api/auth/login": _ = try await api.login(code: "FIRST", pin: "1234", switching: false)
            default: _ = try await api.raw(path)
            }
            return nil
          } catch { return error as? StaffAPIError }
        }
        for _ in 0..<100 where harness.held == nil { await Task.yield() }
        guard let held = harness.held, let url = harness.heldURL else { preconditionFailure("original request did not suspend") }
        let next = try await api.login(code: "NEXT", pin: "1234", switching: false)
        held.resume(returning: try harness.response(url, status: status, value: auth, cookie: "stale-cookie"))
        let error = await pending.value
        check(error?.code == "CLIENT_SESSION_CHANGED" && error?.status == 409,
          "late \(path) \(status) reports a local generation change")
        check(api.identity == next, "late \(path) \(status) cannot clear or replace the newer login")
        harness.heldPath = ""
        _ = try await api.raw("/api/audit-cookie-probe")
        let cookie = harness.requests.last?.value(forHTTPHeaderField: "Cookie") ?? ""
        check(cookie.contains("next-cookie") && !cookie.contains("stale-cookie"),
          "late \(path) \(status) cannot install an old Set-Cookie")
      }
    }
    var encoded: [Data] = []
    let stable = StaffAPI(transport: { request in
      encoded.append(request.httpBody!)
      return (Data("{\"data\":{}}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    })
    let names = (0..<20).map { "field-\($0)" }
    for n in 0..<20 {
      var body: [String: Any] = [:]
      for name in names.dropFirst(n) + names.prefix(n) { body[name] = ["z": 2, "a": 1] }
      _ = try await stable.raw("/api/audit-body-probe", body: body, headers: ["idempotency-key": "same-original-key"])
    }
    check(Set(encoded).count == 1, "restored equal payloads have stable nested JSON bytes across insertion orders")
    print("\(count) actual StaffAPI session race and payload checks passed")
  }
}
