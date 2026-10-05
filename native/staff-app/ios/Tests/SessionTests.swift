import Foundation

final class MemorySessionStore: StaffSessionStore {
  var bytes: Data?
  var failWrite = false
  var failRemove = false
  func read() throws -> Data? { bytes }
  func write(_ data: Data) throws {
    if failWrite { throw URLError(.cannotWriteToFile) }
    bytes = data
  }
  func remove() throws {
    if failRemove { throw URLError(.cannotRemoveFile) }
    bytes = nil
  }
}
@main struct SessionTests {
  @MainActor static func main() async throws {
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let auth = fixture["auth"] as! [String: Any]
    var response = auth
    var status = 200
    var offline = false
    var setCookie = true
    var requests: [URLRequest] = []
    let store = MemorySessionStore()
    let transport: StaffAPI.Transport = { request in
      requests.append(request)
      if offline { throw URLError(.timedOut) }
      let headers =
        setCookie
        ? [
          "Set-Cookie":
            "__Host-mbox_staff_session=test-session-token; Path=/; Secure; HttpOnly; Max-Age=3600"
        ] : [:]
      return (
        try JSONSerialization.data(withJSONObject: ["data": response]),
        HTTPURLResponse(
          url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
      )
    }
    var count = 0
    func check(_ b: Bool, _ label: String) {
      precondition(b, label)
      count += 1
      print("PASS \(label)")
    }
    let api = StaffAPI(transport: transport, store: store)
    _ = try await api.login(code: "staff", pin: "1234", switching: false)
    check(store.bytes == nil, "remember is opt-in and defaults to memory only")
    try api.configureRememberSession(true)
    check(
      store.bytes != nil && api.persistenceNotice.isEmpty,
      "opt-in writes session cookie to supplied secure store")
    let original = store.bytes!
    let encoded = String(data: original, encoding: .utf8)!
    check(
      !encoded.contains("1234") && !encoded.contains("fixture-only") && !encoded.contains("pin"),
      "PIN and venue password never persisted")
    var saved = try JSONDecoder().decode(SavedStaffSession.self, from: original)
    check(
      saved.cookies.count == 1 && saved.cookies[0].name == "__Host-mbox_staff_session",
      "only whitelisted session cookie saved")
    let restored = StaffAPI(transport: transport, store: store)
    check(restored.identity == nil, "cached identity not installed before restore")
    response["permissions"] = ["dashboard.view"]
    setCookie = false
    let verified = try await restored.restoreSession()
    check(
      verified?.allows("table.open") == false,
      "restart adopts current server permissions, not cached grants")
    check(
      requests.last!.url!.path == "/api/auth/heartbeat"
        && requests.last!.value(forHTTPHeaderField: "Cookie")?.contains("test-session-token")
          == true,
      "restore validates original cookie at heartbeat")
    check(
      requests.last!.value(forHTTPHeaderField: "x-mbox-staff-session-id") == "session-1"
        && requests.last!.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == "employee-1",
      "restore binds original employee and session")
    store.bytes = original
    offline = true
    let retry = StaffAPI(transport: transport, store: store)
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(store.bytes == original, "network timeout preserves original encrypted record for retry")
    check(retry.identity == nil, "failed restore never retains the unverified runtime actor")
    offline = false
    _ = try await retry.raw("/api/operations")
    check(
      requests.last!.value(forHTTPHeaderField: "Cookie")?.contains("__Host-mbox_staff_session=") != true
        && requests.last!.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == nil,
      "requests after failed restore send neither cached staff cookie nor actor headers")
    status = 503
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(retry.identity == nil && store.bytes == original, "restore server failure locks runtime and preserves retry record")
    status = 200
    _ = try await retry.restoreSession()
    check(retry.identity != nil, "explicit retry requires a fresh successful heartbeat")
    status = 403
    do {
      _ = try await retry.raw("/api/operations")
      preconditionFailure()
    } catch {}
    check(retry.identity != nil && store.bytes != nil, "business permission denial does not revoke the login")
    do {
      _ = try await retry.heartbeat()
      preconditionFailure()
    } catch {}
    check(retry.identity == nil && store.bytes == nil, "authentication 403 revokes stored and live login")
    store.bytes = original
    status = 401
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(
      store.bytes == nil && retry.identity == nil,
      "server revocation clears stored and live session")
    status = 200
    store.bytes = original
    var changed = response["session"] as! [String: Any]
    changed["id"] = "different-session"
    response["session"] = changed
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(
      store.bytes == nil && retry.identity == nil,
      "different server session cannot silently replace saved employee")
    response = auth
    store.bytes = Data("broken".utf8)
    let before = requests.count
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(
      store.bytes == nil && requests.count == before, "corrupt record removed without network use")
    saved = SavedStaffSession(
      version: 1, identity: saved.identity, device: nil,
      cookies: [
        .init(
          name: "__Host-mbox_staff_session", value: "expired",
          expiresAt: Date(timeIntervalSince1970: 0))
      ])
    store.bytes = try JSONEncoder().encode(saved)
    do {
      _ = try await retry.restoreSession()
      preconditionFailure()
    } catch {}
    check(
      store.bytes == nil && requests.count == before, "expired session cookie cannot be restored")
    store.bytes = original
    _ = try await retry.restoreSession()
    try retry.configureRememberSession(false)
    check(
      store.bytes == nil && retry.identity != nil,
      "disabling remember clears vault while keeping current valid login")
    store.failWrite = true
    try retry.configureRememberSession(true)
    check(
      store.bytes == nil && !retry.persistenceNotice.isEmpty,
      "store failure never falls back to plaintext and reports re-login requirement")
    store.failWrite = false
    try retry.configureRememberSession(true)
    status = 204
    try await retry.logout()
    check(store.bytes == nil && retry.identity == nil, "confirmed logout removes saved login")
    for failure in ["timeout", "503", "unexpected-success"] {
      store.bytes = original
      status = 200
      _ = try await retry.restoreSession()
      offline = failure == "timeout"
      status = failure == "503" ? 503 : 200
      do {
        try await retry.logout()
        preconditionFailure()
      } catch {}
      check(retry.identity == nil && store.bytes == nil, "\(failure) logout still removes local and remembered login")
      offline = false
      status = 200
      _ = try await retry.raw("/api/operations")
      check(
        requests.last!.value(forHTTPHeaderField: "Cookie")?.contains("__Host-mbox_staff_session=") != true
          && requests.last!.value(forHTTPHeaderField: "x-mbox-staff-session-id") == nil,
        "\(failure) logout cannot reuse staff authentication")
    }
    store.bytes = original
    _ = try await retry.restoreSession()
    store.failRemove = true
    offline = true
    do { try await retry.logout(); preconditionFailure() } catch {}
    check(retry.identity == nil && !retry.persistenceNotice.isEmpty && store.bytes != nil,
      "vault removal failure still locks runtime and preserves an explicit warning")
    store.failRemove = false
    retry.clearIdentity()
    check(retry.persistenceNotice.isEmpty && store.bytes == nil, "successful cleanup clears prior storage warning")
    print("\(count) session persistence checks passed")
  }
}
