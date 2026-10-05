import Foundation

@main struct ReservationReceptionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func rejects(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    let employee = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002", customer = "00000000-0000-4000-8000-000000000003", reservation = "00000000-0000-4000-8000-000000000004"
    func auth(_ id: String = employee, denied: [String] = []) throws -> StaffIdentity {
      try JSONDecoder().decode(StaffIdentity.self, from: bytes(["employee": ["id": id, "code": "reception", "displayName": "接待员工", "roleCodes": []], "session": ["id": "session-" + id, "employeeId": id, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "permissions": ["reservation.view", "reservation.manage", "table.open"], "deniedPermissions": denied]))
    }
    let actor = try auth(), now = Date()
    var draft = ReservationAdmissionDraft(); draft.name = "测试顾客"; draft.contact = "13800138000"; draft.note = "私密备注"; draft.guestCount = 7
    let optionsObject: [String: Any] = ["data": ["protocol": 1, "arrivalAt": draft.arrivalAt, "expectedEndAt": draft.expectedEndAt, "policy": ["version": 3, "maxAdvanceDays": 30, "defaultDurationMinutes": 120, "arrivalGraceMinutes": 10], "capacity": ["totalGuests": 12, "committedGuests": 4], "physicalTablesPreassigned": false]]
    func options(_ object: [String: Any] = optionsObject, at: Date = now) throws -> ReservationAdmissionOptions { try .init(data: bytes(object), actor: actor, arrivalAt: draft.arrivalAt, expectedEndAt: draft.expectedEndAt, now: at) }
    let admission = try options(), creation = try draft.command(actor: actor, options: admission, now: now)
    let capability = try JSONDecoder().decode(ReservationCapabilities.self, from: bytes(["durableTransitions": true, "durablePriority": true, "durableCreate": true, "admissionCreateV1": true, "receptionSeatV1": true, "tableBoundCreate": false]))
    check(creation.steps[0].object["tableIds"] == nil && creation.steps[0].path == reservationReceptionRoot, "admission never contains a physical table claim")
    check(validReservationReceptionCommand(command: creation, actor: actor, capabilities: capability), "explicit new backend capability enables admission")
    let legacy = try JSONDecoder().decode(ReservationCapabilities.self, from: bytes(["durableTransitions": true, "durablePriority": true, "durableCreate": true]))
    check(!validReservationReceptionCommand(command: creation, actor: actor, capabilities: legacy), "old durableCreate cannot enable new or legacy table-bound submission")
    check(!validReservationReceptionCommand(command: creation, actor: try auth(other), capabilities: capability), "another employee cannot submit prepared creation")
    check(rejects { _ = try draft.command(actor: actor, options: options(at: now.addingTimeInterval(-31)), now: now) }, "stale options require fresh capacity read")
    draft.guestCount = 9; check(rejects { _ = try draft.command(actor: actor, options: admission, now: now) }, "current admission capacity respected"); draft.guestCount = 7
    for field in ["protocol", "totalGuests", "committedGuests"] {
      var root = optionsObject, data = root["data"] as! [String: Any]
      if field == "protocol" { data[field] = true } else { var capacity = data["capacity"] as! [String: Any]; capacity[field] = -1; data["capacity"] = capacity }; root["data"] = data
      check(rejects { _ = try options(root) }, "invalid options rejected: " + field)
    }
    var wrongWindow = optionsObject, windowData = wrongWindow["data"] as! [String: Any]; windowData["arrivalAt"] = "2099-01-01T00:00:00Z"; wrongWindow["data"] = windowData
    check(rejects { _ = try options(wrongWindow) }, "response must echo exact chosen window")
    let ids = (10...13).map { String(format: "00000000-0000-4000-8000-%012d", $0) }
    let sessionRows: [[String: Any]] = [["tableSessionId": ids[0], "tableId": ids[2], "tableCode": "A01", "locationVersion": 0, "guestCount": 4, "businessDate": "2026-10-05", "openedAt": "2026-10-05 10:00:00.123456+00"], ["tableSessionId": ids[1], "tableId": ids[3], "tableCode": "A02", "locationVersion": 2, "guestCount": 3, "businessDate": "2026-10-05", "openedAt": "2026-10-05T10:00:00Z"]]
    let selectionObject: [String: Any] = ["data": ["protocol": 1, "reservationId": reservation, "reservationVersion": 2, "reservationGuestCount": 6, "reservationStatus": "arrived", "sessions": sessionRows, "partialSeatingSupported": false]]
    let selection = try ReservationReceptionSelection(data: bytes(selectionObject), actor: actor, id: reservation, now: now)
    let seating = try selection.command(selected: Set(ids.prefix(2)), reason: "实际七人分两桌全部安排", actor: actor, now: now)
    check((seating.steps[0].object["sessions"] as? [Any])?.count == 2 && seating.steps[0].path == reservationReceptionRoot + "/" + reservation + "/seat", "two real sessions form one explicit complete reception")
    check(rejects { _ = try selection.command(selected: [UUID().uuidString], reason: "实际全部桌位", actor: actor, now: now) }, "unlisted table sessions cannot be invented")
    check(rejects { _ = try selection.command(selected: Set(ids.prefix(2)), reason: "说明", actor: actor, now: now) }, "actual reception reason has full contract minimum")
    check(rejects { _ = try selection.command(selected: Set(ids.prefix(2)), reason: "实际全部桌位", actor: auth(denied: ["table.open"]), now: now) }, "table capability required independently")
    var duplicate = selectionObject, duplicateData = duplicate["data"] as! [String: Any]; duplicateData["sessions"] = [sessionRows[0], sessionRows[0]]; duplicate["data"] = duplicateData
    check(rejects { _ = try ReservationReceptionSelection(data: bytes(duplicate), actor: actor, id: reservation) }, "duplicate sessions in response are invalid")
    check(rejects { _ = try ReservationReceptionSelection(data: bytes(selectionObject), actor: actor, id: other) }, "response belongs to selected reservation")
    check(receptionDate("2026-10-05 10:00:00.123456+00") != nil, "real PostgreSQL timestamp parses without fixture-only ISO assumption")

    func reply(_ command: LiveCommand, replayed: Bool = false) throws -> Data {
      let step = command.steps[0], body = step.object, p = step.reservationReceptionProof!, operation = p["operation"] as! String
      var row: [String: Any] = ["id": reservation, "customerId": customer, "contactAvailable": true]
      var data: [String: Any] = ["protocol": 1, "operation": operation, "employeeId": employee, "requestKey": step.key]
      if operation == "create" {
        for key in ["publicId", "customerName", "guestCount", "arrivalAt", "expectedEndAt", "source", "seatPreference", "note"] { row[key] = body[key] }
        row["status"] = body["initialStatus"]; row["ownerEmployeeId"] = employee; row["tableLocks"] = []; row["aggregateVersion"] = 1; row["reservationSnapshot"] = ["receptionProtocol": 1, "physicalTablesPreassigned": false]
        data["maskedContact"] = "138****8000"
      } else {
        row["status"] = "seated"; row["aggregateVersion"] = 3; row["publicId"] = "original-reservation"
        let sessions = body["sessions"] as! [[String: Any]]
        data["seating"] = ["batchId": UUID().uuidString.lowercased(), "customerId": customer, "seatedByEmployeeId": employee, "seatedAt": "2026-10-05T10:10:00Z", "seatedGuestCount": 7, "reservationGuestCount": 6, "reason": body["reason"]!, "sessions": sessions.map { ["tableSessionId": $0["tableSessionId"]!, "tableIdAtSeating": $0["expectedTableId"]!, "tableCodeAtSeating": "A", "locationVersionAtSeating": $0["expectedLocationVersion"]!, "guestCountAtSeating": $0["expectedGuestCount"]!] }]
      }
      data["reservation"] = row
      return try bytes(["data": data, "meta": ["replayed": replayed]])
    }
    for original in [creation, seating] {
      let operation = original.steps[0].reservationReceptionProof!["operation"] as! String
      var vault: [String: String] = [:], receipts: [String: String] = [:]
      let secured = try secureReservationReceptionCommand(original) { vault[$0] = $1 }, step = secured.steps[0]
      let ordinary = String(data: try JSONEncoder().encode(secured), encoding: .utf8)!
      for secret in [draft.contact, draft.name, draft.note] { check(!ordinary.contains(secret), "\(operation) ordinary pending excludes private value") }
      check(!ordinary.contains(original.steps[0].body.base64EncodedString()), "\(operation) ordinary pending excludes encoded original payload")
      check(try NSDictionary(dictionary: reservationReceptionRequestBody(secured, step: step, actor: actor, read: { vault[$0]! })).isEqual(to: original.steps[0].object), "\(operation) secure recovery restores exact original body")
      check(rejects { _ = try reservationReceptionRequestBody(secured, step: step, actor: auth(other), read: { _ in preconditionFailure("foreign actor read vault") }) }, "\(operation) foreign employee is rejected before vault read")
      check(rejects { _ = try secureReservationReceptionCommand(secured) { _, _ in preconditionFailure("rewrote secure slot") } }, "\(operation) secured execute cannot bypass fresh validation")
      for mutation in ["path", "key", "employee", "proof", "body", "permission"] {
        var proof = step.reservationReceptionProof!, path = step.path, key = step.key, body = step.body
        if mutation == "path" { path += "/other" }; if mutation == "key" { key += "-other" }; if mutation == "proof" { proof["target"] = other }; if mutation == "body" { body = Data("{\"changed\":true}".utf8) }
        let changed = LiveCommand(id: secured.id, employeeID: mutation == "employee" ? other : secured.employeeID, title: secured.title, permission: mutation == "permission" ? "table.open" : secured.permission, steps: [.init(path: path, body: body, keyHeader: step.keyHeader, key: key, recoveryBody: try bytes(["reservationReception": proof]))])
        check(rejects { _ = try reservationReceptionRequestBody(changed, step: changed.steps[0], actor: actor, read: { vault[$0]! }) }, "\(operation) full command tamper blocked: \(mutation)")
      }
      let response = try reply(original)
      try validateReservationReceptionReply(response, step: step, body: original.steps[0].object); count += 1
      for field in ["protocol", "operation", "employeeId", "requestKey"] {
        var root = try JSONSerialization.jsonObject(with: response) as! [String: Any], d = root["data"] as! [String: Any]; d[field] = "wrong"; root["data"] = d
        check(rejects { try validateReservationReceptionReply(bytes(root), step: step, body: original.steps[0].object) }, "\(operation) mismatched receipt blocked: \(field)")
      }
      var changedReceipt = try JSONSerialization.jsonObject(with: response) as! [String: Any], d = changedReceipt["data"] as! [String: Any], r = d["reservation"] as! [String: Any]; r["status"] = "cancelled"; d["reservation"] = r; changedReceipt["data"] = d
      check(rejects { try validateReservationReceptionReply(bytes(changedReceipt), step: step, body: original.steps[0].object) }, "\(operation) wrong state cannot confirm result")
      let receiptMutations = operation == "create"
        ? ["publicId", "customerName", "guestCount", "arrivalAt", "expectedEndAt", "ownerEmployeeId", "tableLocks", "contactToken", "maskedContact", "receptionProtocol", "meta"]
        : ["reservationId", "aggregateVersion", "customerId", "seatedByEmployeeId", "reason", "reservationGuestCount", "seatedGuestCount", "tableSessionId", "tableIdAtSeating", "locationVersionAtSeating", "guestCountAtSeating", "meta"]
      for field in receiptMutations {
        var object = try JSONSerialization.jsonObject(with: response) as! [String: Any], data = object["data"] as! [String: Any], row = data["reservation"] as! [String: Any]
        if field == "meta" { object["meta"] = ["replayed": 1] }
        else if operation == "create" {
          if field == "maskedContact" { data[field] = draft.contact }
          else if field == "receptionProtocol" { row["reservationSnapshot"] = ["receptionProtocol": 2] }
          else if field == "tableLocks" { row[field] = [["tableCode": "A99", "status": "held"]] }
          else if field == "guestCount" { row[field] = 199 }
          else { row[field] = "other" }
        } else if ["reservationId", "aggregateVersion"].contains(field) { row[field == "reservationId" ? "id" : field] = field == "reservationId" ? other as Any : 99 }
        else {
          var linked = data["seating"] as! [String: Any]
          if ["tableSessionId", "tableIdAtSeating", "locationVersionAtSeating", "guestCountAtSeating"].contains(field) {
            var rows = linked["sessions"] as! [[String: Any]]; rows[0][field] = field.hasSuffix("Id") || field == "tableIdAtSeating" ? other as Any : 99; linked["sessions"] = rows
          } else { linked[field] = ["seatedGuestCount", "reservationGuestCount"].contains(field) ? 99 as Any : "other" }
          data["seating"] = linked
        }
        data["reservation"] = row; object["data"] = data
        check(rejects { try validateReservationReceptionReply(bytes(object), step: step, body: original.steps[0].object) }, "\(operation) bound business receipt rejects \(field) mismatch")
      }
      func ack(_ command: LiveCommand = secured) throws -> Bool { try hasReservationReceptionAcknowledgement(command, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }) }
      check(try !ack(), "\(operation) no secure ACK is not completed")
      var forged = secured; forged.completedSteps = 1
      check(try !ack(forged), "\(operation) ordinary completedSteps cannot authorize deletion")
      check(rejects { try recordReservationReceptionAcknowledgement(response, command: secured, step: step, actor: actor, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: { _, _ in throw URLError(.cannotWriteToFile) }) } && receipts.isEmpty, "\(operation) ACK write failure preserves original unresolved request")
      try recordReservationReceptionAcknowledgement(response, command: secured, step: step, actor: actor, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: { receipts[$0] = $1 })
      check(try ack() && ack(forged), "\(operation) validated independent ACK permits only local completion across checkpoint crash")
      let saved = receipts
      try recordReservationReceptionAcknowledgement(response, command: secured, step: step, actor: actor, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: { _, _ in preconditionFailure("ACK replaced") })
      check(saved == receipts, "\(operation) first validated ACK is immutable")
      let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(secured))
      check(try ack(restored), "\(operation) restart preserves original security binding")
      let second = operation == "create" ? try draft.command(actor: actor, options: admission, now: now) : try selection.command(selected: Set(ids.prefix(2)), reason: "实际七人分两桌全部安排", actor: actor, now: now)
      let otherCommand = try secureReservationReceptionCommand(second) { vault[$0] = $1 }; receipts[otherCommand.id] = receipts[secured.id]
      check(rejects { _ = try ack(otherCommand) }, "\(operation) another original key cannot borrow completion evidence")

      // Real StaffAPI transport + runner: simulate a committed response lost on
      // the wire, then restore disk bytes and send the exact original safe body.
      receipts = [:]; var persisted = try JSONEncoder().encode(secured), calls = 0, commits = 0, serverReceipt: Data?
      let api = StaffAPI(transport: { request in
        guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          let requestBody = request.httpBody, NSDictionary(dictionary: try JSONSerialization.jsonObject(with: requestBody) as! [String: Any]).isEqual(to: original.steps[0].object) else { throw StaffAPIError.invalid }
        calls += 1
        if serverReceipt == nil { commits += 1; serverReceipt = response; throw URLError(.timedOut) }
        return (serverReceipt!, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      func send(_ current: LiveCommand, _ s: LiveCommand.Step) async throws {
        let body = try reservationReceptionRequestBody(current, step: s, actor: actor, read: { vault[$0]! })
        let (reply, _) = try await api.raw(s.path, body: body, headers: [s.keyHeader: s.key])
        try recordReservationReceptionAcknowledgement(reply, command: current, step: s, actor: actor, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: { receipts[$0] = $1 })
      }
      do { _ = try await LiveCommandRunner.advance(secured, send: { try await send(secured, $0) }, checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("lost receipt incorrectly acknowledged") } catch {}
      let pending = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      check(pending.completedSteps == 0 && pending == secured, "\(operation) lost reply retains exact safe original checkpoint")
      let done = try await LiveCommandRunner.advance(pending, send: { try await send(pending, $0) }, checkpoint: { persisted = try JSONEncoder().encode($0) })
      let acknowledgedDone = try ack(done)
      check(done.completedSteps == 1 && commits == 1 && calls == 2 && acknowledgedDone, "\(operation) original-key transport retry produces one committed business request")
      let before = calls; check(try ack(done), "\(operation) secure ACK restores without current session or network")
      check(calls == before, "\(operation) acknowledged cleanup sends no second operation")
    }
    check(receptionDisplayTime("2026-12-31T16:10:00Z") == "2027-01-01 00:10（北京）", "cross-year reception displays full Beijing calendar date")
    check(receptionDisplayTime("2026-10-05 10:00:00.123456+00").hasPrefix("2026-10-05 18:00"), "stored PostgreSQL reception date displays full Beijing time")
    let confirmation = creation.steps[0].reservationReceptionProof?["confirmation"] as? String ?? ""
    check(confirmation.contains("电话代订") && confirmation.contains("无偏好") && confirmation.contains(draft.note), "confirmation includes selected source preference and original note")
    var displayRow: [String: Any] = ["id": reservation, "publicId": "reservation-history", "customerName": "顾客", "arrivalAt": draft.arrivalAt, "expectedEndAt": draft.expectedEndAt, "status": "arrived", "guestCount": 4, "seatPreference": "no_preference", "contactAvailable": false, "tableLocks": []]
    func row() throws -> LiveReservation { try JSONDecoder().decode(LiveReservation.self, from: bytes(displayRow)) }
    check(try row().actions.contains("complete"), "unmarked historical arrived request keeps legacy completion")
    displayRow["reservationSnapshot"] = ["receptionProtocol": 1]
    check(try !row().actions.contains("complete"), "new arrived admission cannot bypass actual table reception")
    displayRow["status"] = "seated"
    check(try row().actions == ["complete"] && row().tables != "待安排桌位", "linked admission enables completion and never displays unarranged table state")
    print("Reservation reception: \(count) checks passed")
  }
}
