import Foundation

private final class ReceptionSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws { bytes = nil }
}
@MainActor private final class ReceptionHarness {
  let employee = "00000000-0000-4000-8000-000000000001", customer = "00000000-0000-4000-8000-000000000002", reservation = "00000000-0000-4000-8000-000000000003"
  let sessionID = "00000000-0000-4000-8000-000000000010", tableID = "00000000-0000-4000-8000-000000000011"
  var payloads: [String: String] = [:], receipts: [String: String] = [:], tickets: [String: String] = [:], requests: [URLRequest] = []
  var failDeletion: String?, failTicketStore = false
  var rejectWrite = false
  var failReadAfterInitializationDeletion = false, pendingTicketReadFailure = false
  var committed: [String: Data] = [:], originalBodies: [String: Data] = [:]
  var loseReply = false, crashAfterACK = false, invalidReply = false
  var capabilityEnabled = true, failRead = false, malformedRead = false
  var payloadWrites = 0, posts = 0
  var legacyBodies: [Data] = [], legacyKeys: [String] = []
  var draft = ReservationAdmissionDraft()
  init() { draft.name = "待核对顾客"; draft.contact = "13800138000"; draft.note = "接待私密备注"; draft.guestCount = 4 }
  func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
  var auth: [String: Any] { ["employee": ["id": employee, "code": "reception", "displayName": "接待员工", "roleCodes": []], "session": ["id": "reception-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "permissions": ["reservation.view", "reservation.manage", "table.open"], "deniedPermissions": [], "navigation": [["route": "/staff/reservations"]]] }
  var capabilities: [String: Any] { ["durableTransitions": true, "durablePriority": true, "durableCreate": true, "admissionCreateV1": capabilityEnabled, "receptionSeatV1": capabilityEnabled, "tableBoundCreate": false] }
  var persistence: ReservationReceptionPersistence {
    .init(payloadExists: { self.payloads[$0] != nil }, readPayload: { guard let value = self.payloads[$0] else { throw StaffAPIError.invalid }; return value },
      storePayload: { self.payloadWrites += 1; self.payloads[$0] = $1 }, removePayload: { if self.failDeletion == "payload" { throw URLError(.cannotRemoveFile) }; self.payloads.removeValue(forKey: $0) },
      readReceipt: { self.receipts[$0] }, storeReceipt: { self.receipts[$0] = $1; if self.crashAfterACK { throw URLError(.cannotWriteToFile) } },
      removeReceipt: { if self.failDeletion == "receipt" { throw URLError(.cannotRemoveFile) }; self.receipts.removeValue(forKey: $0) },
      readCleanupTicket: { if self.pendingTicketReadFailure { self.pendingTicketReadFailure = false; throw URLError(.cannotOpenFile) }; return self.tickets[$0] }, storeCleanupTicket: { if self.failTicketStore { throw URLError(.cannotWriteToFile) }; if let old = self.tickets[$0], old != $1 { throw StaffAPIError.invalid }; self.tickets[$0] = $1 },
      removeCleanupTicket: { if self.failDeletion == "ticket" { throw URLError(.cannotRemoveFile) }; let initialization = self.tickets[$0]?.contains("never-sent") == true
        self.tickets.removeValue(forKey: $0)
        if self.failReadAfterInitializationDeletion && initialization { self.pendingTicketReadFailure = true }
      }, listCleanupTicketKeys: { self.tickets.keys.sorted() })
  }
  var unrelatedCleanup: NativeCommandCleanupPersistence {
    .init(readTicket: { _ in nil }, storeTicket: { _, _ in preconditionFailure("RES wrote generic ticket") }, listTickets: { [:] },
      removeTicket: { _ in preconditionFailure("RES removed generic ticket") }, removeSlot: { _ in preconditionFailure("RES removed foreign slot") }, slotExists: { _ in false })
  }
  func makeAPI() -> StaffAPI {
    StaffAPI(transport: { request in
      self.requests.append(request)
      let path = request.url!.path
      let result: Data
      if request.httpMethod == "GET", path.hasPrefix(reservationReceptionRoot) {
        if self.failRead { throw URLError(.networkConnectionLost) }
        if self.malformedRead { return (try self.bytes(["data": ["protocol": 1]]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
      }
      if path == "/api/auth/login" || path == "/api/auth/heartbeat" { result = try self.bytes(["data": self.auth]) }
      else if path == "/api/staff/native-reservation-capabilities" { result = try self.bytes(["data": self.capabilities]) }
      else if path == "/api/staff/native-waitlist-capabilities" { result = try self.bytes(["data": ["durableTransitions": true]]) }
      else if path == "/api/staff/reservations" || path == "/api/staff/reservation-intake" { result = try self.bytes(["data": []]) }
      else if path == reservationReceptionRoot + "/options" {
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        result = try self.bytes(["data": ["protocol": 1, "arrivalAt": query.first { $0.name == "arrivalAt" }!.value!, "expectedEndAt": query.first { $0.name == "expectedEndAt" }!.value!, "policy": ["version": 1, "maxAdvanceDays": 30, "defaultDurationMinutes": 120, "arrivalGraceMinutes": 10], "capacity": ["totalGuests": 30, "committedGuests": 5], "physicalTablesPreassigned": false]])
      } else if path == reservationReceptionRoot + "/" + self.reservation + "/table-sessions" {
        result = try self.bytes(["data": ["protocol": 1, "reservationId": self.reservation, "reservationVersion": 2, "reservationGuestCount": 4, "reservationStatus": "arrived", "partialSeatingSupported": false, "sessions": [["tableSessionId": self.sessionID, "tableId": self.tableID, "tableCode": "A01", "locationVersion": 0, "guestCount": 4, "businessDate": "2026-10-05", "openedAt": "2026-10-05 10:00:00+00"]]]])
      } else if path == "/api/staff/native-reservations", request.httpMethod == "POST" {
        guard let bytes = request.httpBody, let key = request.value(forHTTPHeaderField: "idempotency-key") else { throw StaffAPIError.invalid }
        self.legacyBodies.append(bytes); self.legacyKeys.append(key)
        let body = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        var row = body; row["id"] = self.reservation; row["status"] = body["initialStatus"]; row["contactAvailable"] = true
        row["tableLocks"] = (body["tableIds"] as! [String]).map { ["tableId": $0, "tableCode": "A01", "status": "confirmed"] }
        result = try self.bytes(["data": row, "meta": ["replayed": true]])
      } else if path == reservationReceptionRoot + "/" + self.reservation {
        result = try self.bytes(["data": ["protocol": 1, "reservation": ["id": self.reservation, "publicId": "original-reception", "customerName": "顾客", "arrivalAt": self.draft.arrivalAt, "expectedEndAt": self.draft.expectedEndAt, "status": "arrived", "guestCount": 4, "seatPreference": "no_preference", "contactAvailable": false, "tableLocks": [], "reservationSnapshot": ["receptionProtocol": 1]], "seating": NSNull()]])
      } else {
        guard request.httpMethod == "POST", [reservationReceptionRoot, reservationReceptionRoot + "/" + self.reservation + "/seat"].contains(path),
          let body = request.httpBody, let key = request.value(forHTTPHeaderField: "idempotency-key") else { throw StaffAPIError.invalid }
        self.posts += 1
        if self.rejectWrite { return (try self.bytes(["error": ["code": "RESERVATION_RECEPTION_CHANGED", "message": "原桌次已变化", "commitDisposition": "not_committed"]]), HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!) }
        if let original = self.originalBodies[key] { precondition(original == body, "same original key must use byte-identical body") }
        else { self.originalBodies[key] = body }
        if let saved = self.committed[key] { result = saved }
        else {
          result = try self.reply(path: path, key: key, body: body)
          self.committed[key] = result
          if self.loseReply { throw URLError(.timedOut) }
        }
      }
      return (result, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }, store: ReceptionSessionStore())
  }
  func reply(path: String, key: String, body: Data) throws -> Data {
    let b = try JSONSerialization.jsonObject(with: body) as! [String: Any], create = path == reservationReceptionRoot
    var row: [String: Any] = ["id": reservation, "customerId": customer]
    var data: [String: Any] = ["protocol": 1, "operation": create ? "create" : "seat", "employeeId": invalidReply ? customer : employee, "requestKey": key]
    if create {
      for field in ["publicId", "customerName", "guestCount", "arrivalAt", "expectedEndAt", "source", "seatPreference", "note"] { row[field] = b[field] }
      row["status"] = b["initialStatus"]; row["ownerEmployeeId"] = employee; row["tableLocks"] = []; row["reservationSnapshot"] = ["receptionProtocol": 1]
      data["maskedContact"] = "138****8000"
    } else {
      row["status"] = "seated"; row["aggregateVersion"] = 3
      data["seating"] = ["batchId": "00000000-0000-4000-8000-000000000099", "customerId": customer, "seatedByEmployeeId": employee, "seatedAt": "2026-10-05T10:10:00Z", "seatedGuestCount": 4, "reservationGuestCount": 4, "reason": b["reason"]!, "sessions": [["tableSessionId": sessionID, "tableIdAtSeating": tableID, "tableCodeAtSeating": "A01", "locationVersionAtSeating": 0, "guestCountAtSeating": 4]]]
    }
    data["reservation"] = row
    return try bytes(["data": data, "meta": ["replayed": false]])
  }
  func setup(_ model: AppModel, api: StaffAPI, operation: String) async throws -> LiveCommand {
    model.identity = try await api.login(code: "reception", pin: "1234", switching: false)
    await model.loadReservations(model.reservationQuery)
    guard model.canUseReservations else { throw CatalogError("Fixture failed to read actual reservation board: " + model.message) }
    if operation == "create" {
      let options = try await model.readReservationAdmission(arrivalAt: draft.arrivalAt, expectedEndAt: draft.expectedEndAt)
      return try draft.command(actor: model.identity!, options: options)
    }
    let selection = try await model.readReservationReceptionSessions(id: reservation)
    return try selection.command(selected: [sessionID], reason: "已核对本组四人实际桌次", actor: model.identity!)
  }
}
@main struct ReservationReceptionSessionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: folder) }
    for operation in ["create", "seat"] {
      for scenario in ["lost", "checkpoint", "remove-failed", "invalid-receipt"] {
        let h = ReceptionHarness(), url = folder.appendingPathComponent(operation + "-" + scenario + ".json"), api = h.makeAPI()
        let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        let command = try await h.setup(model, api: api, operation: operation)
        check(model.canExecuteLive(command), "\(operation)/\(scenario) actual AppModel enables exact newly prepared request")
        h.loseReply = scenario == "lost"; h.crashAfterACK = ["checkpoint", "remove-failed"].contains(scenario); h.invalidReply = scenario == "invalid-receipt"
        let unrelated = UUID().uuidString; h.payloads[unrelated] = "unrelated-payload"; h.receipts[unrelated] = "unrelated-ack"
        await model.executeLive(command)
        check(h.committed.count == 1 && h.posts == 1 && h.payloadWrites == 1, "\(operation)/\(scenario) initial real API request commits once after one secure save")
        let savedBytes = try Data(contentsOf: url), saved = try JSONDecoder().decode(LiveCommand.self, from: savedBytes)
        check(model.livePending?.id == command.id && saved.completedSteps == 0, "\(operation)/\(scenario) unresolved original checkpoint remains")
        let ordinary = String(data: savedBytes, encoding: .utf8)!
        check(!ordinary.contains(h.draft.contact) && !ordinary.contains(h.draft.name) && !ordinary.contains(h.draft.note), "\(operation)/\(scenario) real AppModel ordinary file has no contact or original private form")
        if scenario == "invalid-receipt" {
          check(h.receipts[command.id] == nil && h.payloads[command.id] != nil, "\(operation) receipt for different employee cannot authorize ACK or deletion")
          continue
        }
        let restartedAPI = h.makeAPI()
        let reopened = AppModel(api: restartedAPI, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        let before = h.requests.count
        if scenario == "lost" {
          reopened.readLivePending()
          check(reopened.livePending == saved, "\(operation) actual restart retains exact unresolved original request")
          await reopened.recoverLive()
          check(h.requests.count == before && reopened.livePending == saved, "\(operation) unacknowledged request requires original employee login")
          reopened.identity = try await restartedAPI.login(code: "reception", pin: "1234", switching: false)
          await reopened.recoverLive()
          check(h.committed.count == 1 && h.posts == 2 && h.originalBodies.count == 1, "\(operation) restart retries original key with exact original bytes and no second commit")
          check(h.payloadWrites == 1, "\(operation) restore does not regenerate secure payload or key")
        } else {
          check(h.receipts[command.id] != nil && h.payloads[command.id] != nil, "\(operation)/\(scenario) ACK persists before failing ordinary checkpoint")
          if scenario == "remove-failed" {
            try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
            reopened.readLivePending()
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
            check(reopened.livePending == saved && h.payloads[command.id] == nil && h.receipts[command.id] == nil && h.tickets[command.id] != nil && h.requests.count == before && reopened.localCleanupBlocked,
              "\(operation) failed original-file removal retains secure cleanup ticket and blocks new writes")
            reopened.retryLocalCommandCleanup()
            check(!reopened.localCleanupBlocked, "\(operation) local cleanup retry clears transient block without clearing genuine damaged-file state")
          } else { reopened.readLivePending() }
          await reopened.recoverLive()
          check(h.requests.count == before && reopened.identity == nil, "\(operation)/\(scenario) signed-out ACK completion sends no heartbeat or business request")
        }
        check(reopened.livePending == nil && !FileManager.default.fileExists(atPath: url.path), "\(operation)/\(scenario) acknowledged original request finishes locally")
        check(h.payloads[command.id] == nil && h.receipts[command.id] == nil && h.payloads[unrelated] == "unrelated-payload" && h.receipts[unrelated] == "unrelated-ack",
          "\(operation)/\(scenario) cleanup removes only original UUID payload and receipt")
      }
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-forged.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      let command = try await h.setup(model, api: api, operation: operation)
      var secured = try secureReservationReceptionCommand(command, store: h.persistence.storePayload); secured.completedSteps = 1
      try JSONEncoder().encode(secured).write(to: url, options: .atomic); model.readLivePending()
      let before = h.requests.count
      await model.recoverLive()
      check(model.livePending == secured && FileManager.default.fileExists(atPath: url.path) && h.payloads[command.id] != nil && h.receipts[command.id] == nil,
        "\(operation) forged ordinary completedSteps without validated secure ACK cannot delete original")
      check(h.requests.count == before && h.posts == 0, "\(operation) forged completion cannot resend or bypass receipt verification")
    }
    for operation in ["create", "seat"] {
      for stage in ["ticket-store", "payload", "receipt", "ticket"] {
        let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-cleanup-" + stage + ".json")
        let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        let command = try await h.setup(model, api: api, operation: operation)
        h.crashAfterACK = true
        await model.executeLive(command)
        let original = model.livePending!, before = h.requests.count
        h.failTicketStore = stage == "ticket-store"; h.failDeletion = stage == "ticket-store" ? nil : stage
        await model.recoverLive()
        check(model.livePending == original && h.requests.count == before, "\(operation) \(stage) failure keeps local-only cleanup recoverable")
        if stage == "ticket-store" { check(h.tickets[command.id] == nil && h.payloads[command.id] != nil && h.receipts[command.id] != nil, "\(operation) ticket must be secured before any private deletion") }
        if stage == "payload" { check(h.payloads[command.id] != nil && h.receipts[command.id] != nil && h.tickets[command.id] != nil, "\(operation) payload-delete failure retains original ACK and trusted cleanup authority") }
        if stage == "receipt" { check(h.payloads[command.id] == nil && h.receipts[command.id] != nil && h.tickets[command.id] != nil, "\(operation) partial Keychain deletion retains cleanup authority after original payload is gone") }
        if stage == "ticket" { check(!FileManager.default.fileExists(atPath: url.path) && h.payloads[command.id] == nil && h.receipts[command.id] == nil && h.tickets[command.id] != nil, "\(operation) last cleanup-ticket failure leaves no private original or ordinary business reference") }
        if let ticket = h.tickets[command.id] { check(!ticket.contains(h.draft.contact) && !ticket.contains(h.draft.name) && !ticket.contains("native-business-") && !ticket.contains("originalBody"), "\(operation) cleanup ticket contains no form data or request key") }
        if stage == "payload" {
          let step = original.steps[0]
          let changed = LiveCommand(id: original.id, employeeID: original.employeeID, title: original.title, permission: original.permission,
            steps: [.init(path: step.path, body: step.body, keyHeader: step.keyHeader, key: step.key + "-changed", recoveryBody: step.recoveryBody)])
          try JSONEncoder().encode(changed).write(to: url, options: .atomic); model.readLivePending()
          await model.recoverLive()
          check(model.livePending == changed && h.payloads[command.id] != nil && h.receipts[command.id] != nil && h.requests.count == before,
            "\(operation) trusted cleanup ticket cannot be borrowed by changed ordinary key")
          try JSONEncoder().encode(original).write(to: url, options: .atomic)
        }
        h.failDeletion = nil; h.failTicketStore = false
        let restarted = AppModel(api: h.makeAPI(), loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        restarted.readLivePending()
        await restarted.recoverLive()
        check(restarted.livePending == nil && !FileManager.default.fileExists(atPath: url.path) && h.tickets.isEmpty && h.receipts.isEmpty && h.payloads.isEmpty,
          "\(operation) restart safely finishes \(stage) partial cleanup including orphaned tickets")
        check(h.requests.count == before, "\(operation) restart after \(stage) failure performs zero heartbeat or POST")
      }
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-rejection.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      let command = try await h.setup(model, api: api, operation: operation)
      h.rejectWrite = true; await model.executeLive(command)
      check(model.livePending?.rejected == true && h.tickets[command.id] != nil && h.committed.isEmpty, "\(operation) actual verified rollback stores cleanup authority before rejected checkpoint")
      h.failDeletion = "payload"; let before = h.requests.count
      model.dismissRejectedLive()
      check(model.livePending != nil && h.payloads[command.id] != nil && h.tickets[command.id] != nil, "\(operation) rejected cleanup failure keeps original reference and private slot recoverable")
      h.failDeletion = nil; model.dismissRejectedLive()
      check(model.livePending == nil && h.payloads.isEmpty && h.tickets.isEmpty && h.requests.count == before, "\(operation) explicitly rejected cleanup retries only local deletion")
      let secure = try secureReservationReceptionCommand(command, store: h.persistence.storePayload)
      var forged = secure; forged.rejected = true
      try JSONEncoder().encode(forged).write(to: url, options: .atomic); model.readLivePending()
      model.dismissRejectedLive()
      check(model.livePending == forged && h.payloads[command.id] != nil && h.tickets.isEmpty, "\(operation) forged ordinary rejected flag cannot authorize private cleanup")
    }
    for operation in ["create", "seat"] {
      for interrupted in [false, true] {
        let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-never-sent-" + String(interrupted) + ".json")
        let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        let command = try await h.setup(model, api: api, operation: operation)
        h.failDeletion = interrupted ? "payload" : nil; let before = h.requests.count
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        await model.executeLive(command)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        check(h.requests.count == before && h.posts == 0 && h.committed.isEmpty, "\(operation) failed first ordinary save never reaches network")
        if interrupted { check(h.tickets[command.id] != nil && h.payloads[command.id] != nil && model.livePending?.id == command.id, "\(operation) unsent cleanup failure retains dedicated trusted ticket") }
        else { check(model.livePending == nil && h.payloads.isEmpty && h.tickets.isEmpty && model.message.contains("未发送"), "\(operation) securely stored but unsent payload is cleaned with accurate outcome") }
        h.failDeletion = nil
        let restarted = AppModel(api: h.makeAPI(), loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
        restarted.readLivePending()
        check(h.requests.count == before && restarted.livePending == nil && h.payloads.isEmpty && h.tickets.isEmpty, "\(operation) unsent orphan ticket completes after restart with zero POST")
      }
    }
    do {
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent("initial-ticket-failed.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      let command = try await h.setup(model, api: api, operation: "create")
      h.failTicketStore = true; let before = h.requests.count
      await model.executeLive(command)
      check(h.payloadWrites == 0 && h.payloads.isEmpty && h.tickets.isEmpty && !FileManager.default.fileExists(atPath: url.path), "initial cleanup-ticket failure prevents creating any private payload or ordinary original")
      check(h.requests.count == before && h.posts == 0, "initialization must finish before any request can leave device")
    }
    for operation in ["create", "seat"] {
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-initial-ticket-deleted-read-failed.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      let command = try await h.setup(model, api: api, operation: operation)
      h.failReadAfterInitializationDeletion = true; let before = h.requests.count
      await model.executeLive(command)
      check(h.requests.count == before && h.posts == 0 && h.tickets.isEmpty && h.payloads[command.id] != nil && model.livePending?.id == command.id && FileManager.default.fileExists(atPath: url.path),
        "\(operation) initialization ticket deleted but readback failed sends no HTTP and retains secured original")
      model.retryLocalCommandCleanup()
      check(h.requests.count == before && model.livePending?.id == command.id && h.payloads[command.id] != nil && h.tickets.isEmpty,
        "\(operation) local retry without trusted ticket cannot authorize payload deletion or network")
      let restartedAPI = h.makeAPI()
      let restarted = AppModel(api: restartedAPI, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      restarted.readLivePending()
      check(restarted.livePending?.id == command.id && h.requests.count == before && !restarted.localCleanupBlocked,
        "\(operation) restart retains unresolved original when no cleanup authority remains")
      restarted.identity = try await restartedAPI.login(code: "reception", pin: "1234", switching: false)
      await restarted.recoverLive()
      check(h.posts == 1 && h.committed.count == 1 && h.originalBodies[command.steps[0].key] == command.steps[0].body && restarted.livePending == nil,
        "\(operation) explicit original recovery after uncertain local readback uses original key and bytes once")
    }
    var expiring: [(AppModel, LiveCommand)] = []
    for operation in ["create", "seat"] {
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent(operation + "-readiness.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      _ = try await h.setup(model, api: api, operation: operation)
      let stale = Date().addingTimeInterval(-90); model.reservationUpdated = stale
      func fresh() async throws -> LiveCommand {
        if operation == "create" { return try h.draft.command(actor: model.identity!, options: await model.readReservationAdmission(arrivalAt: h.draft.arrivalAt, expectedEndAt: h.draft.expectedEndAt)) }
        return try await model.readReservationReceptionSessions(id: h.reservation).command(selected: [h.sessionID], reason: "已核对本组四人全部桌次", actor: model.identity!)
      }
      let command = try await fresh()
      check(model.canExecuteLive(command) && !model.canUseReservations && model.reservationUpdated == stale, "\(operation) fresh parsed reception read enables write without refreshing expired legacy list")
      func changed(_ field: String) throws -> LiveCommand {
        let step = command.steps[0]; var body = step.object, proof = step.reservationReceptionProof!, path = step.path
        switch field {
        case "window": body["arrivalAt"] = ISO8601DateFormatter().string(from: h.draft.arrival.addingTimeInterval(60))
        case "policy": body["reservationPolicyVersion"] = 2
        case "capacity": body["guestCount"] = 26
        case "target": proof["target"] = h.customer; path = reservationReceptionRoot + "/" + h.customer + "/seat"
        case "version": body["reservationVersion"] = 3
        case "reservationGuests": proof["reservationGuestCount"] = 5
        default:
          var sessions = body["sessions"] as! [[String: Any]]
          if field == "tableSessionId" || field == "expectedTableId" { sessions[0][field] = h.customer }
          else { sessions[0][field] = 9 }
          body["sessions"] = sessions
        }
        return LiveCommand(id: command.id, employeeID: command.employeeID, title: command.title, permission: command.permission,
          steps: [.init(path: path, body: try h.bytes(body), keyHeader: step.keyHeader, key: step.key, recoveryBody: try h.bytes(["reservationReception": proof]))])
      }
      for field in operation == "create" ? ["window", "policy", "capacity"] : ["target", "version", "reservationGuests", "tableSessionId", "expectedTableId", "expectedLocationVersion", "expectedGuestCount"] {
        check(try !model.canExecuteLive(changed(field)), "\(operation) real selection readiness rejects changed \(field)")
      }
      for failure in ["capability", "malformed", "offline", "detail"] {
        _ = try await fresh()
        h.capabilityEnabled = failure != "capability"; h.malformedRead = failure == "malformed"; h.failRead = failure == "offline"
        if failure == "detail" { _ = try await model.readReservationReceptionDetail(id: h.reservation) }
        else { do { _ = try await fresh(); preconditionFailure("bad read unexpectedly succeeded") } catch {} }
        check(!model.canExecuteLive(command) && model.reservationUpdated == stale, "\(operation) \(failure) read clears previous write readiness without reviving legacy list")
        h.capabilityEnabled = true; h.malformedRead = false; h.failRead = false
      }
      for change in ["employee", "permission", "navigation"] {
        _ = try await fresh()
        var auth = h.auth
        if change == "employee" { var e = auth["employee"] as! [String: Any], session = auth["session"] as! [String: Any]; e["id"] = h.customer; session["employeeId"] = h.customer; session["id"] = "another-session"; auth["employee"] = e; auth["session"] = session }
        else if change == "permission" { auth["deniedPermissions"] = [operation == "create" ? "reservation.manage" : "table.open"] }
        else { auth["navigation"] = [] as [[String: Any]] }
        model.identity = try JSONDecoder().decode(StaffIdentity.self, from: h.bytes(auth))
        check(!model.canExecuteLive(command), "\(operation) current \(change) change invalidates previously read readiness")
        model.identity = try JSONDecoder().decode(StaffIdentity.self, from: h.bytes(h.auth))
      }
      // Start both independent windows, then let real wall time cross the
      // production 30-second boundary; no private clock or readiness injection.
      expiring.append((model, try await fresh()))
    }
    try await Task.sleep(nanoseconds: 31_000_000_000)
    for (model, command) in expiring { check(!model.canExecuteLive(command), "production 30-second parsed reception readiness expires before submit") }
    do {
      let h = ReceptionHarness(), api = h.makeAPI(), url = folder.appendingPathComponent("legacy-pending.json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false, livePendingURL: url, reservationReceptionPersistence: h.persistence, nativeCleanupPersistence: h.unrelatedCleanup)
      _ = try await h.setup(model, api: api, operation: "create")
      var draft = ReservationDraft(); draft.name = "历史原预约"; draft.contact = "原联系方式"; draft.tables = [h.tableID]
      let old = try draft.command(actor: model.identity!, choices: [ReservationTable(id: h.tableID, code: "A01", areaName: "大厅", capacity: 4)])
      check(!model.canExecuteLive(old), "tableBoundCreate false blocks starting new legacy table-bound request")
      try JSONEncoder().encode(old).write(to: url, options: .atomic); model.readLivePending()
      await model.recoverLive()
      let sent = try JSONSerialization.jsonObject(with: h.legacyBodies.first ?? Data("{}".utf8)) as! [String: Any]
      check(h.legacyKeys == [old.steps[0].key] && NSDictionary(dictionary: sent).isEqual(to: old.steps[0].object), "previously pending legacy create recovers original endpoint key and full table claim unchanged")
      check(model.livePending == nil && !FileManager.default.fileExists(atPath: url.path) && h.posts == 0, "validated legacy replay closes without replacing it with a new admission")
    }
    for code in ["RESERVATION_RECEPTION_REQUIRED", "RESERVATION_RECEPTION_CHANGED", "RESERVATION_POLICY_CHANGED", "RESERVATION_CAPACITY_UNAVAILABLE"] {
      check(StaffAPIError(status: 409, code: code, message: "changed", commitDisposition: "not_committed").definitivelyRejected, "\(code) explicit rolled-back conflict permits rejection handling")
      check(!StaffAPIError(status: 409, code: code, message: "unknown").definitivelyRejected && !StaffAPIError(status: 503, code: code, message: "unknown", commitDisposition: "not_committed").definitivelyRejected, "\(code) unknown outcome cannot discard original")
    }
    print("Reservation reception actual AppModel: \(count) checks passed")
  }
}
