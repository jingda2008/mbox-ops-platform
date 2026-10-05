import Foundation

private final class AppSessionStore: StaffSessionStore {
  var bytes: Data?
  var failRemove = false
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws {
    if failRemove { throw URLError(.cannotRemoveFile) }
    bytes = nil
  }
}

@main struct AppSessionTests {
  @MainActor static func main() async throws {
    let fixture = try JSONSerialization.jsonObject(
      with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]
    // This role needs no operations read after login, so only the actual auth boundary is exercised.
    auth["permissions"] = []
    let identity = try JSONDecoder().decode(
      StaffIdentity.self, from: JSONSerialization.data(withJSONObject: auth))
    let original = try JSONEncoder().encode(SavedStaffSession(
      version: 1, identity: identity, device: nil,
      cookies: [.init(name: "__Host-mbox_staff_session", value: "local-test-cookie",
        expiresAt: Date().addingTimeInterval(3600))]))
    let store = AppSessionStore()
    store.bytes = original
    var offline = true
    var status = 200
    var requests: [URLRequest] = []
    let api = StaffAPI(transport: { request in
      requests.append(request)
      if offline { throw URLError(.timedOut) }
      return (try JSONSerialization.data(withJSONObject: ["data": auth]),
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }, store: store)
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: true)
    var count = 0
    func check(_ condition: Bool, _ label: String) {
      precondition(condition, label)
      count += 1
      print("PASS \(label)")
    }

    await model.restoreRememberedSession()
    check(model.identity == nil && api.identity == nil && !model.live && !model.busy,
      "failed remembered login leaves both API and actual AppModel locked")
    check(model.savedLoginAvailable && store.bytes == original,
      "unknown heartbeat keeps only the encrypted original login for explicit retry")
    offline = false
    await model.restoreRememberedSession(retry: true)
    check(model.identity?.employee.id == identity.employee.id && model.live,
      "explicit retry enters the workspace only after a fresh heartbeat")
    offline = true
    await model.logout()
    check(model.identity == nil && api.identity == nil && !model.savedLoginAvailable && store.bytes == nil,
      "actual AppModel logout locks local login even when the remote result is unknown")
    check(model.world.tables.isEmpty && model.staffName == "未登录"
      && model.message.contains("服务器退出结果未确认"),
      "failed logout clears staff business views and does not claim remote revocation")

    let pending = LiveCommand(id: "original-pending", employeeID: identity.employee.id,
      title: "原员工未决请求", permission: "table.open",
      steps: [.init(path: "/api/table-management/sessions/open", body: Data("{}".utf8),
        keyHeader: "x-idempotency-key", key: "original-key")])
    model.livePending = pending
    store.bytes = original
    offline = false
    await model.restoreRememberedSession(retry: true)
    check(model.identity?.employee.id == pending.employeeID && model.livePending == pending,
      "same employee can reauthenticate without changing the original pending payload or key")
    let requestCount = requests.count
    await model.logout()
    check(requests.count == requestCount && model.identity != nil && model.livePending == pending,
      "unresolved original request still blocks logout before any revocation call")
    status = 403
    await model.heartbeat()
    check(model.identity == nil && api.identity == nil && !model.deviceReady,
      "authentication denial locks the actual workspace and device readiness")
    check(model.livePending == pending, "revocation never deletes the original employee pending request")

    let foreign = LiveCommand(id: pending.id, employeeID: "different-employee",
      title: pending.title, permission: pending.permission, steps: pending.steps)
    model.livePending = foreign
    store.bytes = original
    status = 200
    await model.restoreRememberedSession(retry: true)
    check(model.identity == nil && api.identity == nil && model.livePending == foreign,
      "remembered login cannot take over another employee's unknown request")
    check(model.message.contains("原员工"), "wrong-owner recovery explains that the original employee must return")

    model.livePending = nil
    store.bytes = original
    await model.restoreRememberedSession(retry: true)
    status = 403
    do { _ = try await api.raw("/api/operations"); preconditionFailure() }
    catch { model.handleLiveError(error) }
    check(model.identity != nil && api.identity != nil,
      "a business permission denial preserves an otherwise valid login")
    status = 503
    store.failRemove = true
    await model.logout()
    check(model.identity == nil && api.identity == nil && store.bytes != nil
      && model.savedLoginAvailable && model.message.contains("服务器退出结果未确认"),
      "secure-store removal failure remains visible while the running workspace is locked")
    store.failRemove = false
    api.clearIdentity()
    print("\(count) actual AppModel session checks passed")
  }
}
