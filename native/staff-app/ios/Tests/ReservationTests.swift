import Foundation

@main struct ReservationTests {
  @MainActor static func main() async throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-reservations.json"))) as! [String: Any]
    func data(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ t: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(t, from: data(x))
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let row = try decode(LiveReservation.self, f["row"]!)
    let queue = try decode(LiveReservationIntake.self, f["queue"]!)
    var count = 0
    func check(_ x: Bool, _ label: String) {
      precondition(x, label)
      count += 1
      print("PASS " + label)
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    let command = try ReservationCommands.transition(
      row, action: "confirm", reason: "已核对", override: false, actor: actor)
    let step = command.steps[0]
    check(
      step.path == "/api/staff/native-reservations/reservation-1/confirm"
        && step.key.hasPrefix("native-business-"), "isolated native endpoint with original key")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "complete", reason: "", override: false, actor: actor)
      }, "pending cannot complete")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "cancel", reason: "", override: false, actor: actor)
      }, "cancel reason required")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "confirm", reason: "", override: true, actor: actor)
      }, "override only applies to cancellation")
    var auth = f["auth"] as! [String: Any]
    auth["deniedPermissions"] = ["reservation.cancel.override"]
    let denied = try decode(StaffIdentity.self, auth)
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "cancel", reason: "客户取消", override: true, actor: denied)
      }, "live denial overrides grant")
    var receipt = f["row"] as! [String: Any]
    receipt["status"] = "confirmed"
    try validateReservationReply(data(["data": receipt, "meta": ["replayed": true]]), step: step)
    count += 1
    for (k, v) in [("id", "other"), ("publicId", "other"), ("status", "arrived")] {
      var copy = receipt
      copy[k] = v
      check(
        rejects {
          try validateReservationReply(
            data(["data": copy, "meta": ["replayed": false]]), step: step)
        }, "receipt mismatch retained: " + k)
    }
    let priority = try ReservationCommands.priority(
      queue, mode: "promote", reason: "客户现场说明", actor: actor)
    let proof = priority.steps[0].reservationProof!
    check(
      proof["targetKind"] as? String == "reservation" && proof["mode"] as? String == "promote",
      "queue action binds target kind")
    check(
      rejects {
        _ = try ReservationCommands.priority(queue, mode: "anything", reason: "说明", actor: actor)
      }, "arbitrary queue action blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-02-30", to: "2026-03-01") },
      "invalid calendar date blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-09-30", to: "2026-09-01") },
      "reversed dates blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-09-01", to: "2026-10-02") },
      "query has bounded window")
    let window = try ReservationQuery.window(from: "2026-09-28", to: "2026-09-28")
    check(
      window.0 == "2026-09-27T16:00:00Z" && window.1 == "2026-09-28T16:00:00Z",
      "inclusive Shanghai date becomes half-open UTC interval")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(priority))
    check(restored == priority, "relaunch preserves priority request")
    let choices=[ReservationTable(id:"table-1",code:"A5",areaName:"大厅",capacity:4)]
    var draft=ReservationDraft();draft.name="顾客";draft.contact="测试联系方式";draft.tables=["table-1"]
    let creation=try draft.command(actor:actor,choices:choices)
    check(creation.steps[0].path=="/api/staff/native-reservations" && creation.steps[0].object["publicId"] as? String==creation.steps[0].reservationProof?["publicId"] as? String,"creation keeps stable original public id and request key")
    let restoredCreate=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(creation));check(restoredCreate==creation,"new reservation survives relaunch as original command")
    draft.people=5;check(rejects{_=try draft.command(actor:actor,choices:choices)},"insufficient table capacity blocked")
    draft.people=2;draft.arrival=Date(timeIntervalSince1970:0);check(rejects{_=try draft.command(actor:actor,choices:choices)},"past arrival blocked before creating command")
    var created=creation.steps[0].object;created["id"]="new-reservation";created["status"]="confirmed";created["tableLocks"]=[["tableId":"table-1"]]
    try validateReservationReply(data(["data":created,"meta":["replayed":true]]),step:creation.steps[0]);count+=1
    created["guestCount"]=99;check(rejects{try validateReservationReply(data(["data":created,"meta":["replayed":false]]),step:creation.steps[0])},"wrong creation receipt count remains unknown")
    count += try await waitlistLifecycleChecks(fixture: f)
    print("Reservation tests: \(count) passed")
  }
}

@MainActor private func waitlistLifecycleChecks(fixture: [String: Any]) async throws -> Int {
  var count = 0
  func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
  func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
  func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try JSONDecoder().decode(type, from: bytes(value)) }
  func rejects(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
  let actor = try decode(StaffIdentity.self, fixture["auth"]!)
  func row(_ status: String, kind: String = "waitlist", publicID: String = "WAIT-ORIGINAL-001") throws -> LiveReservationIntake {
    var value = fixture["queue"] as! [String: Any]
    value["kind"] = kind; value["status"] = status; value["publicId"] = publicID
    return try decode(LiveReservationIntake.self, value)
  }
  let expected = ["waiting": ["notified", "arrived", "cancelled", "expired"],
    "notified": ["arrived", "cancelled", "expired"], "arrived": ["seated", "cancelled"],
    "seated": [], "cancelled": [], "expired": []]
  for status in ["waiting", "notified", "arrived", "seated", "cancelled", "expired", "unknown"] {
    let record = try row(status)
    check(ReservationCommands.waitlistActions(status) == (expected[status] ?? []), "waitlist \(status) follows server transition map")
    check(record.active == ["waiting", "notified", "arrived"].contains(status), "waitlist \(status) correctly controls active queue")
    for target in ["notified", "arrived", "seated", "cancelled", "expired"] {
      let allowed = (expected[status] ?? []).contains(target)
      check(rejects { _ = try ReservationCommands.waitlist(record, to: target, reason: "现场已核对", actor: actor) } == !allowed,
        "waitlist \(status) to \(target) allowed exactly by server contract")
    }
    if !record.active {
      check(rejects { _ = try ReservationCommands.priority(record, mode: "promote", reason: "不应插队", actor: actor) },
        "terminal waitlist \(status) cannot regain queue priority")
    }
  }
  let waiting = try row("waiting")
  check(rejects { _ = try ReservationCommands.waitlist(row("waiting", kind: "reservation"), to: "arrived", reason: "现场核对", actor: actor) },
    "reservation cannot use waitlist transition route")
  for note in ["", "一", String(repeating: "字", count: 501)] {
    check(rejects { _ = try ReservationCommands.waitlist(waiting, to: "notified", reason: note, actor: actor) }, "waitlist actual note has strict length")
  }
  for invalid in ["short", " WAIT-ORIGINAL-001", String(repeating: "x", count: 129)] {
    check(rejects { _ = try ReservationCommands.waitlist(row("waiting", publicID: invalid), to: "notified", reason: "现场核对", actor: actor) },
      "waitlist rejects malformed original public ID")
  }
  var denied = fixture["auth"] as! [String: Any]; denied["deniedPermissions"] = ["reservation.manage"]
  check(rejects { _ = try ReservationCommands.waitlist(waiting, to: "arrived", reason: "现场核对", actor: decode(StaffIdentity.self, denied)) },
    "waitlist explicit current permission denial overrides grant")
  let capability = try decode(ReservationCapabilities.self, ["durableTransitions": true, "durablePriority": true])
  check(capability.durableWaitlist == nil, "old capability does not enable unsupported waitlist writes")
  check(rejects { _ = try decode(WaitlistCapabilities.self, ["durableTransitions": 1]) }, "waitlist capability requires real boolean")
  let escaped = try ReservationCommands.waitlist(row("waiting", publicID: "WAIT/ORIGINAL?001"), to: "notified", reason: "联系已完成", actor: actor)
  check(escaped.steps[0].path.contains("WAIT%2FORIGINAL%3F001"), "waitlist original public ID remains one safe URL segment")
  func response(_ command: LiveCommand, replayed: Bool = false) -> [String: Any] {
    let proof = command.steps[0].reservationProof!
    return ["meta": ["replayed": replayed], "data": ["id": "original-internal-waitlist",
      "publicId": proof["publicId"]!, "status": proof["status"]!,
      "previousStatus": proof["previousStatus"]!, "reason": proof["reason"]!]]
  }
  for (status, target) in [("waiting", "notified"), ("notified", "arrived"), ("arrived", "seated"),
    ("waiting", "cancelled"), ("notified", "expired")] {
    let command = try ReservationCommands.waitlist(row(status), to: target, reason: " 现场已核对实际结果 ", actor: actor)
    let step = command.steps[0]
    check(step.keyHeader == "idempotency-key" && step.key.hasPrefix("native-business-")
      && step.object["expectedStatus"] as? String == status && step.object["to"] as? String == target,
      "waitlist \(target) freezes original state and permanent key")
    check((step.reservationProof?["confirmation"] as? String)?.contains("不会自动联系客人、开台或退款") == true,
      "waitlist \(target) explains actual handling and separate financial flow")
    try validateReservationReply(bytes(response(command)), step: step)
    check(true, "waitlist \(target) original receipt accepted")
    for field in ["publicId", "status", "previousStatus", "reason"] {
      var receipt = response(command); var value = receipt["data"] as! [String: Any]
      value[field] = "wrong"; receipt["data"] = value
      check(rejects { try validateReservationReply(bytes(receipt), step: step) }, "waitlist \(target) rejects wrong receipt \(field)")
    }
    var receipt = response(command); receipt["meta"] = ["replayed": 1]
    check(rejects { try validateReservationReply(bytes(receipt), step: step) }, "waitlist \(target) rejects numeric replay marker")
    let wrongPath = LiveCommand.Step(path: "/api/staff/native-waitlist/OTHER-ID/transition", body: step.body,
      keyHeader: step.keyHeader, key: step.key, recoveryBody: step.recoveryBody)
    check(rejects { try validateReservationReply(bytes(response(command)), step: wrongPath) }, "waitlist \(target) receipt cannot clear another public ID path")
    var body = step.object; body["expectedStatus"] = "wrong"
    let wrongBody = LiveCommand.Step(path: step.path, body: try bytes(body), keyHeader: step.keyHeader,
      key: step.key, recoveryBody: step.recoveryBody)
    check(rejects { try validateReservationReply(bytes(response(command)), step: wrongBody) }, "waitlist \(target) payload must match persisted state proof")
    var persisted = try JSONEncoder().encode(command), commits = 0, sends = 0
    let api = StaffAPI(transport: { request in
      sends += 1
      guard request.url?.path == step.path, request.httpMethod == "POST",
        request.value(forHTTPHeaderField: step.keyHeader) == step.key, let payload = request.httpBody,
        NSDictionary(dictionary: try JSONSerialization.jsonObject(with: payload) as! [String: Any]).isEqual(to: step.object)
      else { throw StaffAPIError.invalid }
      if commits == 0 { commits += 1; throw URLError(.networkConnectionLost) }
      // Return the retained original result even if the live row has progressed to a terminal state.
      return (try bytes(response(command, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    })
    do { _ = try await LiveCommandRunner.advance(command, send: { try await api.execute($0) },
      checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("lost waitlist response accepted") } catch {}
    let relaunched = try JSONDecoder().decode(LiveCommand.self, from: persisted)
    check(relaunched == command, "waitlist \(target) unknown result retains original key state note and actor")
    let complete = try await LiveCommandRunner.advance(relaunched, send: { try await api.execute($0) },
      checkpoint: { persisted = try JSONEncoder().encode($0) })
    check(complete.completedSteps == 1 && commits == 1 && sends == 2,
      "waitlist \(target) actual API adapter restores retained receipt without duplicate transition")
    _ = try await LiveCommandRunner.advance(complete, send: { try await api.execute($0) }, checkpoint: { _ in })
    check(sends == 2, "waitlist \(target) failed refresh recovery never repeats completed request")
  }
  for code in ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS", "PUBLIC_RESERVATION_UNAVAILABLE"] {
    check(!StaffAPIError(status: 409, code: code, message: "保留原请求").definitivelyRejected,
      "waitlist \(code) keeps original request recoverable")
  }
  check(StaffAPIError(status: 409, code: "NATIVE_BUSINESS_NOT_COMMITTED", message: "候位已变化", commitDisposition: "not_committed").definitivelyRejected,
    "waitlist proven stale-state noncommit can be safely reviewed then refreshed")
  return count
}
