import Foundation

private final class PushStore: StaffSessionStore {
  var bytes: Data?
  var failWrite = false
  func read() throws -> Data? { bytes }
  func write(_ data: Data) throws {
    if failWrite { throw URLError(.cannotWriteToFile) }
    bytes = data
  }
  func remove() throws { bytes = nil }
}
@MainActor private final class PushSystem: NativePushSystem {
  var authorization: NativePushPermission = .authorized
  var registrations = 0
  var clears = 0
  var prompts = 0
  func permission() async -> NativePushPermission { authorization }
  func requestPermission() async throws -> NativePushPermission { prompts += 1; return authorization }
  func register() { registrations += 1 }
  func stopAndClear() { clears += 1 }
}
@MainActor private final class PushHarness {
  struct Call { let path, method: String; let body: [String: Any]?; let key: String?; let owner: NativePushOwner }
  let store = PushStore()
  let system = PushSystem()
  var actor: StaffIdentity?
  let original: StaffIdentity
  var core: NativePushCoordinator!
  var calls: [Call] = []
  var anonymousCalls: [[String: Any]] = []
  var capabilitiesEnabled = true
  var revision = 0
  var registrationWrites = 0
  var registeredOwner: NativePushOwner?
  var registrationKey: String?
  var registrationSecret: String?
  var status = "active"
  var losePut = false
  var loseObservation = false
  var failRevoke = false
  var failHeartbeat = false
  var heartbeatCount = 0
  var holdPut = false
  var heldPut: CheckedContinuation<Data, Error>?
  var tombstones: Set<String> = []
  let deliveryId = UUID().uuidString.lowercased()
  let taskId = UUID().uuidString.lowercased()
  let tableSessionId = UUID().uuidString.lowercased()
  var deliveryOwner: NativePushOwner?
  var expiredTarget = false
  var wrongReply = false
  var targetRevision: Int?
  var until: String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)) }
  init(_ identity: StaffIdentity) { original = identity; actor = identity; makeCore() }
  func makeCore() {
    core = NativePushCoordinator(store: store, system: system, anonymous: { [unowned self] path, method, body, key in
      guard path.hasSuffix("/revoke-capability"), method == "POST", key == nil,
        let body, Set(body.keys) == ["revision", "revocationSecret"] else { throw NativePushError.invalid }
      anonymousCalls.append(body)
      if failRevoke { throw URLError(.notConnectedToInternet) }
      let rev = body["revision"] as! Int
      let secret = body["revocationSecret"] as! String
      tombstones.insert("\(rev):\(secret)")
      if rev == revision && secret == registrationSecret { status = "revoked" }
      return try data(["protocol": 1, "accepted": true])
    }, appVersion: "0.2.0")
    core.connect(identity: { [unowned self] in actor }, revalidate: { [unowned self] in
      heartbeatCount += 1
      if failHeartbeat { throw URLError(.timedOut) }
      guard let actor else { throw NativePushError.changed }; return actor
    }, request: { [unowned self] path, method, body, key in
      try await request(path, method, body, key)
    })
  }
  func data(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: ["data": value]) }
  func envelope(_ actor: NativePushOwner) -> [String: Any] {
    ["protocol": 1, "employeeId": actor.employeeId, "staffSessionId": actor.staffSessionId]
  }
  func reply(_ actor: NativePushOwner, key: String? = nil) throws -> Data {
    var result = envelope(actor)
    result["installation"] = ["installationId": core.state.installationId,
      "revision": revision, "status": status,
      "boundToCurrentSession": actor == registeredOwner, "expiresAt": until,
      "lastRequestKey": actor == registeredOwner ? (registrationKey as Any? ?? NSNull()) : NSNull()]
    if let key { result["requestKey"] = wrongReply ? NativePushState.key() : key }
    return try data(result)
  }
  func request(_ path: String, _ method: String, _ body: [String: Any]?, _ key: String?) async throws -> Data {
    guard let actor else { throw NativePushError.changed }
    let owner = NativePushOwner(actor)
    calls.append(.init(path: path, method: method, body: body, key: key, owner: owner))
    if path.hasSuffix("/capabilities") {
      var result = envelope(owner)
      result["enabled"] = capabilitiesEnabled
      result["platforms"] = ["ios": ["provider": "apns", "configured": capabilitiesEnabled,
        "environment": capabilitiesEnabled ? "sandbox" as Any : NSNull()]]
      return try data(result)
    }
    if path.hasSuffix("/revoke") {
      if registeredOwner == owner && body?["expectedRevision"] as? Int == revision { status = "revoked" }
      return try reply(owner, key: key)
    }
    if path.hasSuffix("/target") {
      if expiredTarget { throw StaffAPIError(status: 410, code: "PUSH_TARGET_EXPIRED", message: "expired") }
      guard deliveryOwner == owner, registeredOwner == owner, status == "active" else {
        throw StaffAPIError(status: 404, code: "PUSH_NOT_FOUND", message: "not found")
      }
      var result = envelope(owner)
      result.merge(["deliveryId": deliveryId, "installationId": core.state.installationId,
        "revision": targetRevision ?? revision, "kind": "service_task", "taskId": taskId, "tableSessionId": tableSessionId]) { _, new in new }
      return try data(result)
    }
    if path.hasSuffix("/observations") {
      if loseObservation { loseObservation = false; throw URLError(.timedOut) }
      guard deliveryOwner == owner else { throw StaffAPIError(status: 404, code: "PUSH_NOT_FOUND", message: "not found") }
      var result = envelope(owner)
      let kind = body!["kind"] as! String
      result.merge(["requestKey": key!, "deliveryId": deliveryId, "kind": kind,
        "clientReportedReceivedAt": kind == "received" ? until : NSNull(),
        "clientReportedOpenedAt": kind == "opened" ? until : NSNull()]) { _, new in new }
      return try data(result)
    }
    if method == "GET" {
      guard revision > 0 else { throw StaffAPIError(status: 404, code: "PUSH_NOT_FOUND", message: "not found") }
      return try reply(owner)
    }
    guard method == "PUT", let body, let key else { throw NativePushError.invalid }
    let expected = body["expectedRevision"] as! Int
    let secret = body["revocationSecret"] as! String
    if tombstones.contains("\(expected + 1):\(secret)") {
      throw StaffAPIError(status: 409, code: "PUSH_REGISTRATION_REVOKED", message: "revoked")
    }
    if key != registrationKey {
      guard expected == revision else {
        throw StaffAPIError(status: 409, code: "PUSH_REVISION_CONFLICT", message: "changed", commitDisposition: "not_committed")
      }
      registrationWrites += 1; revision += 1; registeredOwner = owner; registrationKey = key
      registrationSecret = secret; status = "active"
    }
    let bytes = try reply(owner, key: key)
    if holdPut { return try await withCheckedThrowingContinuation { heldPut = $0 } }
    if losePut { losePut = false; throw URLError(.timedOut) }
    return bytes
  }
  func start() async {
    await core.sessionChanged(actor); await core.enable()
  }
  func token(_ value: UInt8 = 17) async { await core.registered(token: Data(repeating: value, count: 32)) }
  func activate() async { await start(); await token() }
  func drain() async { for _ in 0..<30 { await Task.yield() } }
}

@main struct NativePushTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: @autoclosure () -> Bool, _ label: String) {
      precondition(condition(), label); count += 1; print("PASS \(label)")
    }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf:
      URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]
    var session = auth["session"] as! [String: Any]
    session["expiresAt"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
    session["onlineLeaseUntil"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-60))
    auth["session"] = session
    let identity = try JSONDecoder().decode(StaffIdentity.self, from: JSONSerialization.data(withJSONObject: auth))
    var otherAuth = auth
    var otherEmployee = auth["employee"] as! [String: Any]
    otherEmployee["id"] = UUID().uuidString.lowercased()
    otherAuth["employee"] = otherEmployee
    var otherSession = session
    otherSession["id"] = UUID().uuidString.lowercased(); otherSession["employeeId"] = otherEmployee["id"]
    otherAuth["session"] = otherSession
    let otherIdentity = try JSONDecoder().decode(StaffIdentity.self, from: JSONSerialization.data(withJSONObject: otherAuth))

    let disabled = PushHarness(identity)
    disabled.capabilitiesEnabled = false
    await disabled.start(); await disabled.token()
    check(disabled.system.registrations == 0 && disabled.system.prompts == 0,
      "disabled server neither prompts nor pretends APNs registration")
    check(!disabled.core.active && disabled.registrationWrites == 0, "disabled config never creates binding")
    let denied = PushHarness(identity); denied.system.authorization = .denied
    await denied.start(); await denied.token()
    check(denied.system.registrations == 0 && !denied.core.enabled, "denied permission remains locally disabled")
    let locked = PushHarness(identity); locked.store.failWrite = true
    await locked.start(); await locked.token()
    check(locked.registrationWrites == 0 && locked.system.registrations == 0,
      "Keychain write failure prevents registration before request")

    let h = PushHarness(identity)
    await h.activate()
    check(h.core.active && h.core.canPresent && h.revision == 1, "real state machine binds current session without foreground online lease")
    check(h.core.state.pending == nil && h.core.state.binding?.owner == NativePushOwner(identity),
      "verified registration clears only original pending and keeps owner proof")
    check(!String(data: h.store.bytes!, encoding: .utf8)!.contains(String(repeating: "11", count: 32)),
      "completed binding does not retain raw token as cached authority")
    check(NativePushState.validSecret(h.registrationSecret!) && h.registrationSecret!.count == 43,
      "registration uses cryptographic 32-byte canonical revocation secret")
    check(Set(h.calls.first(where: { $0.method == "PUT" })!.body!.keys)
      == ["expectedRevision", "platform", "provider", "token", "permission", "appVersion", "revocationSecret"],
      "PUT payload carries no self-reported employee, device, topic or environment")
    let firstSecret = h.registrationSecret
    await h.core.refresh(); await h.token(34)
    check(h.revision == 2 && h.registrationSecret != firstSecret, "token rotation uses current revision and a fresh secret")
    check(h.anonymousCalls.contains(where: { $0["revocationSecret"] as? String == firstSecret }) && h.status == "active",
      "old binding capability cannot revoke the newly rotated binding")
    h.makeCore(); h.actor = nil
    await h.core.sessionChanged(nil)
    check(h.core.state.binding != nil && h.core.state.revocations.isEmpty,
      "initial signed-out UI callback cannot revoke persisted binding before login restore")
    h.actor = identity; await h.core.sessionChanged(identity)
    check(!h.core.active && h.system.registrations >= 3, "cold restore requires fresh system token and fresh installation read")
    await h.token(34)
    check(h.core.active && h.registrationWrites == 2, "same fresh token restores binding without a duplicate write")

    let lost = PushHarness(identity); lost.losePut = true
    await lost.activate()
    let pending = lost.core.state.pending!
    check(!lost.core.active && lost.registrationWrites == 1, "lost PUT success remains unknown instead of falsely active")
    check(pending.owner == NativePushOwner(identity) && pending.token == String(repeating: "11", count: 32),
      "unknown registration retains exact payload and original owner in secure slot")
    lost.makeCore(); lost.actor = nil; await lost.core.sessionChanged(nil)
    check(lost.core.state.pending == pending && lost.core.state.revocations.isEmpty,
      "cold-start nil identity preserves unresolved original registration until restore")
    lost.actor = identity; await lost.core.sessionChanged(identity); await lost.token()
    let attempts = lost.calls.filter { $0.method == "PUT" }
    check(attempts.count == 2 && attempts[0].key == attempts[1].key
      && NSDictionary(dictionary: attempts[0].body!).isEqual(to: attempts[1].body!),
      "process restart retries original key and every original body field")
    check(lost.registrationWrites == 1 && lost.core.active, "lost response recovery does not create a second registration")

    let previouslyRevoked = PushHarness(identity); previouslyRevoked.losePut = true
    await previouslyRevoked.activate()
    let revokedPending = previouslyRevoked.core.state.pending!
    previouslyRevoked.tombstones.insert("1:\(revokedPending.revocationSecret)")
    await previouslyRevoked.core.refresh(); await previouslyRevoked.token(); await previouslyRevoked.drain()
    check(!previouslyRevoked.core.enabled && !previouslyRevoked.core.active
      && previouslyRevoked.core.state.pending == nil && previouslyRevoked.registrationWrites == 1,
      "revoked receipt retires binding without claiming the original PUT never committed")
    let malformed = PushHarness(identity); malformed.wrongReply = true
    await malformed.activate()
    check(!malformed.core.active && malformed.core.state.pending != nil,
      "mismatched receipt key is not accepted or discarded")
    let revoke = PushHarness(identity); revoke.losePut = true; revoke.failRevoke = true
    await revoke.activate()
    let unknownSecret = revoke.core.state.pending!.revocationSecret
    revoke.core.endSession(); revoke.actor = nil; await revoke.drain()
    check(!revoke.core.canPresent && revoke.system.clears > 0 && revoke.core.state.pending == nil,
      "offline logout synchronously locks and clears system notifications")
    check(revoke.core.state.revocations.first?.revision == 1
      && revoke.core.state.revocations.first?.revocationSecret == unknownSecret,
      "lost registration can be revoked with persisted expected revision plus one")
    revoke.makeCore(); revoke.failRevoke = false; await revoke.core.flushRevocations()
    check(revoke.core.state.revocations.isEmpty && revoke.status == "revoked",
      "credential-free revocation survives process death and clears only after accepted receipt")
    check(Set(revoke.anonymousCalls.last!.keys) == ["revision", "revocationSecret"],
      "anonymous revoke does not retain or send old employee cookie or PIN")

    let race = PushHarness(identity); race.holdPut = true
    await race.start()
    let task = Task { await race.token() }
    while race.heldPut == nil { await Task.yield() }
    race.core.endSession(); race.actor = otherIdentity
    await race.core.sessionChanged(otherIdentity)
    let late = try race.reply(NativePushOwner(identity), key: race.registrationKey)
    race.heldPut!.resume(returning: late); race.heldPut = nil
    await task.value; await race.drain()
    check(!race.core.active && !race.core.enabled && race.core.state.binding == nil,
      "late old-session successful PUT cannot revive notifications after employee switch")
    check(race.tombstones.count == 1 && race.status == "revoked", "logout persists capability revocation for in-flight registration")

    let storageFailure = PushHarness(identity); await storageFailure.activate()
    let savedBeforeStop = storageFailure.store.bytes
    storageFailure.store.failWrite = true
    storageFailure.core.endSession(); await storageFailure.drain()
    await storageFailure.core.sessionChanged(identity); await storageFailure.core.enable()
    await storageFailure.token(); await storageFailure.core.refresh()
    check(!storageFailure.core.canPresent && !storageFailure.core.enabled
      && storageFailure.registrationWrites == 1,
      "failed stop persistence latches off across same-session callbacks and explicit enable")
    check(storageFailure.store.bytes == savedBeforeStop,
      "failed stop retains original secure capability instead of losing revocation authority")
    storageFailure.store.failWrite = false; await storageFailure.core.flushRevocations()
    check(storageFailure.core.state.binding == nil && !storageFailure.core.state.enabled
      && storageFailure.status == "revoked",
      "storage recovery stages original capability and revokes without automatic re-enable")
    let withdrawn = PushHarness(identity); await withdrawn.activate()
    withdrawn.system.authorization = .denied; await withdrawn.core.refresh(); await withdrawn.drain()
    check(!withdrawn.core.enabled && !withdrawn.core.canPresent && withdrawn.system.clears > 0,
      "permission withdrawal checked on foreground disables and clears before recovery")
    check(withdrawn.status == "revoked", "permission withdrawal uses original capability to revoke remotely")
    let revokedRole = PushHarness(identity); await revokedRole.activate()
    var noPermissionAuth = auth
    noPermissionAuth["permissions"] = []
    let noPermission = try JSONDecoder().decode(StaffIdentity.self, from: JSONSerialization.data(withJSONObject: noPermissionAuth))
    revokedRole.actor = noPermission
    check(!revokedRole.core.canPresent, "current role revocation immediately suppresses presentation before async refresh")
    await revokedRole.core.sessionChanged(noPermission); await revokedRole.drain()
    check(!revokedRole.core.enabled && revokedRole.status == "revoked", "same-session role revocation durably deactivates original binding")
    let failure = PushHarness(identity); await failure.start(); failure.core.registrationFailed()
    check(failure.registrationWrites == 0 && !failure.core.active,
      "system registration failure never invents token or active binding")

    let opened = PushHarness(identity); await opened.activate()
    opened.deliveryOwner = NativePushOwner(identity)
    let initialHeartbeat = opened.heartbeatCount
    opened.failHeartbeat = true; await opened.core.clicked(opened.deliveryId)
    check(opened.core.target == nil && opened.core.hasOpenIntent,
      "notification click waits for successful fresh heartbeat")
    check(!opened.calls.contains(where: { $0.path.hasSuffix("/target") }), "failed heartbeat cannot use payload as target authorization")
    opened.failHeartbeat = false; opened.loseObservation = true; await opened.core.openPending()
    check(opened.heartbeatCount == initialHeartbeat + 2 && opened.core.target?.taskId == opened.taskId
      && opened.core.target?.tableSessionId == opened.tableSessionId,
      "fresh heartbeat and target GET locate exactly the original task and table session")
    check(opened.core.state.observations.count == 1 && opened.core.state.observations[0].kind == "opened",
      "opened report is persisted separately and does not fabricate received callback")
    let originalObservation = opened.core.state.observations[0]
    await opened.core.refresh(); await opened.token()
    check(opened.core.state.observations.isEmpty
      && opened.calls.filter({ $0.path.hasSuffix("/observations") }).allSatisfy({ $0.key == originalObservation.requestKey }),
      "unknown observation retries original key and preserves first report semantics")
    check(!opened.calls.contains(where: { $0.method != "GET" && !$0.path.hasPrefix("/api/native/push/") }),
      "opening notification never automatically acknowledges or completes a service task")
    opened.targetRevision = opened.revision + 1; opened.core.target = nil
    await opened.core.clicked(opened.deliveryId)
    check(opened.core.target == nil && opened.core.hasOpenIntent,
      "target proof cannot override an existing local binding with a different revision")
    opened.targetRevision = nil
    opened.expiredTarget = true; opened.core.target = nil; await opened.core.clicked(opened.deliveryId)
    check(opened.core.target == nil && !opened.core.hasOpenIntent, "expired original task is not mapped to a new table task")
    opened.expiredTarget = false; opened.actor = otherIdentity; await opened.core.sessionChanged(otherIdentity)
    await opened.core.clicked(opened.deliveryId)
    check(opened.core.target == nil && !opened.core.hasOpenIntent, "other employee cannot open original employee notification")

    let routeDenied = PushHarness(identity); await routeDenied.activate()
    routeDenied.deliveryOwner = NativePushOwner(identity)
    var routeDeniedAuth = auth; routeDeniedAuth["navigation"] = []
    routeDenied.actor = try JSONDecoder().decode(StaffIdentity.self, from: JSONSerialization.data(withJSONObject: routeDeniedAuth))
    await routeDenied.core.clicked(routeDenied.deliveryId)
    check(routeDenied.core.target == nil && !routeDenied.core.hasOpenIntent
      && routeDenied.core.navigationNotice.contains("未开放服务任务入口")
      && !routeDenied.calls.contains(where: { $0.path.hasSuffix("/target") }),
      "explicit empty navigation blocks notification business entry after fresh login proof")
    let cold = PushHarness(identity); cold.actor = nil
    await cold.core.clicked(cold.deliveryId)
    check(cold.core.hasOpenIntent && cold.calls.isEmpty && cold.core.target == nil,
      "signed-out cold click stores only opaque delivery ID and requests login")
    check(NativePushCoordinator.deliveryId(["mbox": ["protocol": 1, "kind": "service_task", "deliveryId": cold.deliveryId]]) == cold.deliveryId,
      "only versioned opaque service-task payload is accepted")
    check(NativePushCoordinator.deliveryId(["mbox": ["protocol": 2, "kind": "service_task", "deliveryId": cold.deliveryId]]) == nil
      && NativePushCoordinator.deliveryId(["mbox": ["protocol": 1, "kind": "payment", "deliveryId": cold.deliveryId]]) == nil,
      "foreign protocol and business action payloads are ignored")

    // Actual StaffAPI cookie/actor handling, not a coordinator-only stand-in.
    for responseStatus in [200, 401] {
      var suspended: CheckedContinuation<(Data, HTTPURLResponse), Error>?
      var captured: URLRequest?
      var loginNumber = 0
      var requests: [URLRequest] = []
      let api = StaffAPI(transport: { request in
        requests.append(request)
        if request.url!.path.hasPrefix("/api/native/push/") {
          captured = request
          return try await withCheckedThrowingContinuation { suspended = $0 }
        }
        loginNumber += 1
        let body = loginNumber == 1 ? auth : otherAuth
        return (try JSONSerialization.data(withJSONObject: ["data": body]),
          HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Set-Cookie": "__Host-mbox_staff_session=\(loginNumber == 1 ? "old" : "new"); Path=/; Secure; HttpOnly"])!)
      })
      _ = try await api.login(code: "test", pin: "1234", switching: false)
      let delayed = Task { try await api.raw("/api/native/push/capabilities", method: "GET") }
      while suspended == nil { await Task.yield() }
      _ = try await api.login(code: "test", pin: "1234", switching: true)
      suspended!.resume(returning: (Data("{}".utf8), HTTPURLResponse(url: captured!.url!, statusCode: responseStatus,
        httpVersion: nil, headerFields: ["Set-Cookie": "__Host-mbox_staff_session=stale; Path=/; Secure; HttpOnly"])!))
      var changed = false
      do { _ = try await delayed.value } catch let error as StaffAPIError { changed = error.code == "CLIENT_SESSION_CHANGED" }
      check(changed && api.identity?.session.id == otherIdentity.session.id,
        "actual StaffAPI rejects old \(responseStatus) without clearing newer identity")
      check(captured?.httpShouldHandleCookies == false
        && captured?.value(forHTTPHeaderField: "x-mbox-staff-session-id") == identity.session.id,
        "push request freezes actor and disables response cookie handling (\(responseStatus))")
      _ = try await api.heartbeat()
      check(requests.last?.value(forHTTPHeaderField: "Cookie")?.contains("=new") == true
        && requests.last?.value(forHTTPHeaderField: "Cookie")?.contains("stale") == false,
        "late push Set-Cookie cannot overwrite new login (\(responseStatus))")
    }
    print("\(count) native push checks passed")
  }
}
