import Foundation

private final class CleanupSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ data: Data) throws { bytes = data }
  func remove() throws { bytes = nil }
}
@main struct NativeCommandCleanupSessionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ title: String) { precondition(value, title); count += 1; print("PASS " + title) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    let employee = "00000000-0000-4000-8000-000000000001", role = "00000000-0000-4000-8000-000000000002", hash = String(repeating: "a", count: 64)
    let auth: [String: Any] = ["employee": ["id": employee, "code": "admin", "displayName": "管理员", "roleCodes": ["ADMIN"]],
      "session": ["id": "cleanup-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["staff.access.configure"], "deniedPermissions": [], "navigation": [["route": "/staff/settings"]]]
    let board: [String: Any] = ["employeeId": employee, "protocol": 1, "durableCommands": true, "credentialVersion": hash, "credentials": [],
      "overview": ["configurationVersion": hash,
        "employees": [["id": employee, "code": "admin", "displayName": "管理员", "status": "active", "roleCodes": ["ADMIN"], "overrides": []]],
        "roles": [["id": role, "code": "ADMIN", "name": "管理员", "status": "active", "permissionCodes": ["staff.access.configure"], "dataScopes": [], "approvalLimits": [], "navigation": []]],
        "areas": [], "permissions": [["code": "staff.access.configure", "name": "员工配置"]], "configurationDefinitions": []]]
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: folder) }
    for scenario in ["payload-delete", "receipt-delete", "ordinary-delete", "ticket-delete", "ticket-still-present", "unverified-ordinary", "initial-ticket-store", "initial-payload-after-store", "initial-file-double-failure", "initial-consume", "initial-consume-read-error"] {
      let parent = folder.appendingPathComponent(scenario)
      try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
      let url = parent.appendingPathComponent("pending.json")
      defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path) }
      defer { try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: url.path) }
      var payloads: [String: String] = [:], receipts: [String: String] = [:], tickets: [String: Data] = [:]
      let unrelated = UUID().uuidString.lowercased(); payloads[unrelated] = "unrelated"; receipts[unrelated] = "unrelated"
      var requests: [URLRequest] = [], writes = 0, fault = true, consumeDeleted = false
      var sentKeys: [String] = [], sentBodies: [Data] = []
      let persistence = NativeManagementPersistence(readPayload: { guard let value = payloads[$0] else { throw StaffAPIError.invalid }; return value },
        storePayload: { key, value in
          payloads[key] = value
          if fault && scenario == "initial-payload-after-store" { throw URLError(.cannotWriteToFile) }
          if fault && scenario == "initial-file-double-failure" { try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: parent.path) }
        }, removePayload: { payloads.removeValue(forKey: $0) },
        readReceipt: { receipts[$0] }, storeReceipt: { receipts[$0] = $1 }, removeReceipt: { receipts.removeValue(forKey: $0) })
      let cleanup = NativeCommandCleanupPersistence(readTicket: { key in
        if fault && consumeDeleted { throw URLError(.cannotOpenFile) }; return tickets[key]
      }, storeTicket: { key, value in
        if fault && scenario == "initial-ticket-store" { throw URLError(.cannotWriteToFile) }
        if let old = tickets[key], old != value { throw StaffAPIError.invalid }; tickets[key] = value
      }, listTickets: { tickets }, removeTicket: { key in
        let disposition = try tickets[key].map { try decodeNativeCommandCleanupTicket($0, key: key).disposition }
        if fault && scenario == "initial-consume-read-error" && disposition == .neverSent { tickets.removeValue(forKey: key); consumeDeleted = true; return }
        if fault && ((scenario == "ticket-delete" && disposition == .acknowledged) || (scenario == "initial-consume" && disposition == .neverSent)) { throw URLError(.cannotWriteToFile) }
        if !(fault && scenario == "ticket-still-present" && disposition == .acknowledged) { tickets.removeValue(forKey: key) }
      }, removeSlot: { slot in
        if slot.module == .managementPayload {
          if fault && ["payload-delete", "initial-payload-after-store", "initial-file-double-failure", "initial-consume"].contains(scenario) { throw URLError(.cannotWriteToFile) }; payloads.removeValue(forKey: slot.key)
        } else if slot.module == .managementReceipt {
          if fault && scenario == "receipt-delete" { throw URLError(.cannotWriteToFile) }; receipts.removeValue(forKey: slot.key)
          if fault && scenario == "ordinary-delete" { try FileManager.default.setAttributes([.immutable: true], ofItemAtPath: url.path) }
        } else { throw StaffAPIError.invalid }
      }, slotExists: { slot in
        if slot.module == .managementPayload { return payloads[slot.key] != nil }
        if slot.module == .managementReceipt { return receipts[slot.key] != nil }; throw StaffAPIError.invalid
      })
      let emptyReception = ReservationReceptionPersistence(payloadExists: { _ in false },
        readPayload: { _ in throw StaffAPIError.invalid }, storePayload: { _, _ in throw StaffAPIError.invalid }, removePayload: { _ in throw StaffAPIError.invalid },
        readReceipt: { _ in nil }, storeReceipt: { _, _ in throw StaffAPIError.invalid }, removeReceipt: { _ in throw StaffAPIError.invalid },
        readCleanupTicket: { _ in nil }, storeCleanupTicket: { _, _ in throw StaffAPIError.invalid }, removeCleanupTicket: { _ in throw StaffAPIError.invalid }, listCleanupTicketKeys: { [] })
      let api = StaffAPI(transport: { request in
        requests.append(request); let path = request.url!.path; let reply: [String: Any]
        if ["/api/auth/login", "/api/auth/heartbeat"].contains(path) { reply = ["data": auth] }
        else if path == "/api/staff/native-administration" { reply = ["data": board] }
        else {
          guard path == "/api/staff/native-administration/pin", let bytes = request.httpBody,
            let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], body["expectedVersion"] as? String == hash,
            body["employeeId"] as? String == employee, body["pin"] as? String == "2345",
            let key = request.value(forHTTPHeaderField: "idempotency-key") else { throw StaffAPIError.invalid }
          writes += 1; sentKeys.append(key); sentBodies.append(bytes)
          reply = ["data": ["employeeId": employee, "requestKey": key, "action": "pin", "result": ["employeeId": employee, "pinConfigured": true, "revokedSessionCount": 1]], "meta": ["protocol": 1, "replayed": false]]
        }
        return (try data(reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      }, store: CleanupSessionStore())
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url,
        nativeManagementPersistence: persistence, reservationReceptionPersistence: emptyReception, nativeCleanupPersistence: cleanup)
      model.identity = try await api.login(code: "admin", pin: "1234", switching: false)
      await model.loadNativeManagement(.staff)
      let command = try model.prepareNativeManagement(operation: "pin", fields: ["reason": "实际核对本人PIN", "pin": "2345", "repeatSecret": "2345"], rowID: employee)
      if scenario == "unverified-ordinary" {
        var secured = try secureNativeManagementCommand(command, store: persistence.storePayload); secured.completedSteps = 1; secured.rejected = true
        try JSONEncoder().encode(secured).write(to: url); model.livePending = secured
        let before = requests.count
        model.dismissRejectedLive()
        check(model.livePending == secured && payloads[command.id] != nil && tickets.isEmpty && FileManager.default.fileExists(atPath: url.path), "forged ordinary rejected+completed cannot erase protected original")
        model.identity = nil; await model.recoverLive()
        check(requests.count == before && writes == 0, "unverified signed-out checkpoint cannot mint cleanup permission or send")
        continue
      }
      await model.executeLive(command)
      if scenario == "initial-consume-read-error" {
        check(writes == 0 && tickets[command.id] == nil && payloads[command.id] != nil, "initialization ticket deleted then verification read failed: no first POST and no false payload cleanup")
        guard let pending = model.livePending else { preconditionFailure("secured original missing") }
        check(pending.id == command.id && model.localCleanupBlocked && FileManager.default.fileExists(atPath: url.path), "ambiguous local transition preserves secured original pending")
        let before = requests.count; fault = false; model.identity = nil
        model.retryLocalCommandCleanup()
        check(requests.count == before && writes == 0 && payloads[command.id] != nil && model.livePending == pending, "local-cleanup button with no surviving ticket neither sends nor invents payload deletion permission")
        model.identity = try await api.login(code: "admin", pin: "1234", switching: false)
        await model.recoverLive()
        let restoredBody = try JSONSerialization.jsonObject(with: sentBodies.first ?? Data("{}".utf8)) as! [String: Any]
        check(writes == 1 && sentKeys == [command.steps[0].key] && sentBodies.count == 1 && NSDictionary(dictionary: restoredBody).isEqual(to: command.steps[0].object), "explicit original-request recovery sends original key and full original payload once")
        check(model.livePending == nil && payloads[command.id] == nil && receipts[command.id] == nil && tickets.isEmpty, "verified original recovery finishes exact protected cleanup")
        let after = requests.count; await model.recoverLive()
        check(writes == 1 && requests.count == after, "finished original recovery cannot send a second business request")
        continue
      }
      if scenario.hasPrefix("initial-") {
        check(writes == 0, "\(scenario) prevents entry into business HTTP")
        if scenario == "initial-ticket-store" {
          check(payloads[command.id] == nil && receipts[command.id] == nil && tickets[command.id] == nil && !FileManager.default.fileExists(atPath: url.path), "failed initial ticket write happens before private store or ordinary pending")
        } else {
          check(tickets[command.id] != nil && model.localCleanupBlocked, "\(scenario) trusted initialization survives private or ordinary or consume failure")
          check(!model.canExecuteLive(command), "\(scenario) temporary cleanup block prevents a replacement operation")
          let before = requests.count
          fault = false; try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path)
          model.identity = nil
          model.retryLocalCommandCleanup()
          check(model.livePending == nil && !model.liveStorageDamaged && tickets.isEmpty && payloads[command.id] == nil && receipts[command.id] == nil, "\(scenario) same-process signed-out cleanup resolves partial initialization")
          check(requests.count == before && writes == 0 && model.identity == nil, "\(scenario) recovery remains local and never turns unsent draft into a write")
        }
        continue
      }
      check(writes == 1 && tickets[command.id] != nil && model.livePending?.id == command.id, "\(scenario) validated response leaves ticket and pending while cleanup fails")
      check(payloads[unrelated] == "unrelated" && receipts[unrelated] == "unrelated", "\(scenario) failure never erases unrelated original")
      if scenario == "receipt-delete" { check(payloads[command.id] == nil && receipts[command.id] != nil, "receipt failure reproduces partial cleanup without losing authorization") }
      if ["ticket-delete", "ticket-still-present"].contains(scenario) { check(!FileManager.default.fileExists(atPath: url.path), "\(scenario) crash occurs after ordinary file removed") }
      if scenario == "ordinary-delete" { check(FileManager.default.fileExists(atPath: url.path), "immutable actual pending file reproduces FileManager deletion failure") }
      let before = requests.count; fault = false
      try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: url.path)
      let reopened = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url,
        nativeManagementPersistence: persistence, reservationReceptionPersistence: emptyReception, nativeCleanupPersistence: cleanup)
      reopened.readLivePending()
      check(reopened.livePending == nil && !reopened.liveStorageDamaged && tickets.isEmpty, "\(scenario) actual signed-out startup finishes ticket-only local recovery")
      check(requests.count == before && writes == 1 && reopened.identity == nil, "\(scenario) cleanup restart makes zero heartbeat or business calls")
      check(payloads[command.id] == nil && receipts[command.id] == nil && payloads[unrelated] == "unrelated" && receipts[unrelated] == "unrelated", "\(scenario) exact payload and ACK removed with unrelated values preserved")
    }
    print("Native command cleanup actual AppModel: \(count) checks passed; injected business transport; no real Keychain or network")
  }
}
