import Foundation

@main struct AssignmentTests {
  @MainActor static func main() async throws {
    let base = URL(fileURLWithPath: CommandLine.arguments[1])
    func read(_ name: String) throws -> [String: Any] {
      try JSONSerialization.jsonObject(with: Data(contentsOf: base.appendingPathComponent(name)))
        as! [String: Any]
    }
    func bytes(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    var auth = try read("live-contract.json")["auth"] as! [String: Any]
    auth["permissions"] = [LiveAssignments.permission]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    let fixture = try read("live-assignments.json")
    let options = try JSONDecoder().decode(
      LiveAssignments.Options.self, from: bytes(fixture["options"]!))
    let tables = try JSONDecoder().decode(
      [LiveAssignments.Table].self, from: bytes(fixture["tables"]!))
    let assignments = try JSONDecoder().decode(
      [LiveAssignments.Assignment].self, from: bytes(fixture["assignments"]!))
    let board = LiveAssignments(options: options, tables: tables, assignments: assignments)
    try board.validate()
    var checks = 0
    func check(_ value: Bool, _ label: String) {
      precondition(value, label)
      checks += 1
      print("PASS \(label)")
    }
    func rejects(_ action: () throws -> Void) -> Bool {
      do {
        try action()
        return false
      } catch { return true }
    }
    let now = assignmentDate("2026-09-27T12:00:00Z")!
    func request(
      ids: Set<String>? = nil, user: StaffIdentity? = nil, employee: String? = nil,
      role: String? = nil, kind: String = "backup", start: Date? = nil, end: Date? = nil,
      reason: String = "晚班调整"
    ) throws -> LiveCommand {
      try board.assign(
        actor: user ?? actor, tableIDs: ids ?? Set(tables.prefix(2).map(\.id)),
        employeeID: employee ?? options.employees[0].id, roleID: role ?? options.roles[0].id,
        kind: kind, start: start ?? now, end: end, reason: reason)
    }
    check(
      board.visibleTables("").map(\.code) == ["A10", "A2"], "occupied first and paused excluded")
    check(
      board.visibleTables("ａ １").map(\.code) == ["A10"],
      "width case whitespace tolerant fuzzy table search")
    check(board.visibleTables("厅").count == 2, "partial area selects scoped tables")
    check(
      assignmentDate("2026-09-27 12:00:00.000000+00") == now, "Postgres fractional timestamps parse"
    )
    check(
      assignmentDate("2026-09-27T20:00:00+08:00") == now
        && assignmentTime(now.ISO8601Format()) == "09-27 20:00",
      "Shanghai time independent of device zone")
    let command = try request()
    let step = command.steps[0]
    check(
      step.path == "/api/table-management/assignments/batch"
        && step.keyHeader == "x-idempotency-key", "batch endpoint and table idempotency header")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(command))
    check(restored == command, "exact request survives durable reload")
    check(rejects { _ = try request(ids: []) }, "empty batch refused")
    check(rejects { _ = try request(ids: [tables[2].id]) }, "paused table refused")
    check(rejects { _ = try request(ids: ["foreign"]) }, "unseen table refused")
    check(
      rejects { _ = try request(ids: Set((1...81).map { "table\($0)" })) }, "batch above 80 refused"
    )
    check(rejects { _ = try request(employee: "foreign") }, "unavailable employee refused")
    check(rejects { _ = try request(role: "foreign") }, "unavailable role refused")
    check(rejects { _ = try request(kind: "owner") }, "unknown assignment kind refused")
    check(rejects { _ = try request(end: now) }, "empty interval refused")
    check(
      rejects { _ = try request(end: now.addingTimeInterval(0.2)) },
      "wire second precision cannot collapse interval")
    check(
      rejects { _ = try request(reason: " ") }
        && rejects { _ = try request(reason: String(repeating: "a", count: 1001)) },
      "reason bounds enforced")
    auth["deniedPermissions"] = [LiveAssignments.permission]
    let denied = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    check(rejects { _ = try request(user: denied) }, "explicit denial overrides assignment grant")
    check(
      rejects { _ = try request(kind: "primary") }, "visible primary overlap blocked before network"
    )
    let occupiedByActor = LiveAssignments(
      options: options, tables: tables,
      assignments: [
        LiveAssignments.Assignment(
          id: "assignment", tableId: tables[0].id, tableCode: tables[0].code,
          employeeId: options.employees[0].id, employeeName: "当前员工", roleId: options.roles[0].id,
          roleCode: "WAITER", assignmentType: "primary",
          startsAt: now.addingTimeInterval(-3600).ISO8601Format(), endsAt: now.ISO8601Format(),
          reason: "原责任")
      ])
    _ = try occupiedByActor.assign(
      actor: actor, tableIDs: [tables[0].id], employeeID: options.employees[0].id,
      roleID: options.roles[0].id, kind: "backup", start: now, end: nil, reason: "相邻时段")
    check(true, "adjacent half open intervals allowed")
    check(
      rejects {
        _ = try occupiedByActor.assign(
          actor: actor, tableIDs: [tables[0].id], employeeID: options.employees[0].id,
          roleID: options.roles[0].id, kind: "backup", start: now.addingTimeInterval(-60), end: nil,
          reason: "重复分工")
      }, "same employee overlap blocked across responsibility types")
    var rows = tables.prefix(2).enumerated().map { index, table -> [String: Any] in
      var row = step.object
      row.removeValue(forKey: "tableIds")
      row["tableId"] = table.id
      row["id"] = "receipt-\(index)"
      row["createdByEmployeeId"] = actor.employee.id
      row["startsAt"] = "2026-09-27 12:00:00+00"
      return row
    }
    func receipt(_ rows: [[String: Any]]) throws -> Data {
      try bytes(["data": ["id": "batch-id", "assignments": rows], "meta": ["replayed": false]])
    }
    try validateAssignmentReply(receipt(rows), step: step)
    check(true, "batch receipt binds every original table employee role reason and dates")
    for key in [
      "tableId", "id", "employeeId", "roleId", "assignmentType", "reason", "createdByEmployeeId",
      "startsAt", "endsAt",
    ] {
      var wrong = rows
      wrong[0][key] = key == "id" ? rows[1]["id"] : "wrong"
      check(
        rejects { try validateAssignmentReply(receipt(wrong), step: step) },
        "wrong \(key) cannot clear pending request")
    }
    check(
      rejects { try validateAssignmentReply(receipt([rows[0]]), step: step) },
      "partial batch never accepted")
    check(
      rejects { try validateAssignmentReply(receipt([rows[0], rows[0]]), step: step) },
      "duplicate table receipt never accepted")
    check(
      rejects {
        try validateAssignmentReply(
          bytes(["data": ["id": "batch", "assignments": rows], "meta": ["replayed": 1]]), step: step
        )
      }, "numeric metadata never treated as a boolean receipt")
    let end = try board.end(actor: actor, id: assignments[0].id, reason: "交班结束", now: now)
    var ended = (fixture["assignments"] as! [[String: Any]])[0]
    ended["endsAt"] = "2026-09-27 12:00:00+00"
    let endReply = try bytes(["data": ended, "meta": ["replayed": true]])
    try validateAssignmentReply(endReply, step: end.steps[0])
    check(
      ended["reason"] as? String != end.steps[0].object["reason"] as? String,
      "end receipt keeps original assignment reason")
    check(
      rejects { _ = try board.end(actor: actor, id: "foreign", reason: "交班结束", now: now) },
      "end cannot target unseen responsibility")
    check(
      rejects { _ = try board.end(actor: denied, id: assignments[0].id, reason: "交班结束", now: now) },
      "end enforces permission")
    check(
      rejects {
        _ = try board.end(
          actor: actor, id: assignments[0].id, reason: "交班结束",
          now: assignmentDate(assignments[0].startsAt)!)
      }, "end cannot precede start")
    let bounded = try request(end: now.addingTimeInterval(3600))
    for i in rows.indices { rows[i]["endsAt"] = "2026-09-27 13:00:00+00" }
    try validateAssignmentReply(receipt(rows), step: bounded.steps[0])
    check(true, "bounded assignment receipt accepted")
    check(
      rejects { try validateAssignmentReply(receipt(rows), step: step) },
      "unexpected end bound rejected")
    let api = StaffAPI(transport: { request in
      check(
        request.value(forHTTPHeaderField: step.keyHeader) == step.key,
        "recovery uses original idempotency key")
      check(
        (try JSONSerialization.jsonObject(with: request.httpBody!)) as? NSDictionary == step.object
          as NSDictionary, "recovery uses original payload values")
      return (
        try receipt(
          rows.map { row in
            var r = row
            r["endsAt"] = NSNull()
            return r
          }),
        HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
      )
    })
    try await api.execute(restored.steps[0])
    var sent = 0
    let complete = try await LiveCommandRunner.advance(
      restored, send: { _ in sent += 1 }, checkpoint: { _ in })
    _ = try await LiveCommandRunner.advance(
      complete, send: { _ in sent += 1 }, checkpoint: { _ in })
    check(sent == 1, "readback retry after checkpoint never resubmits")
    check(
      !StaffAPIError(status: 409, code: "TABLE_OPERATION_CONFLICT", message: "冲突")
        .definitivelyRejected, "ambiguous 409 stays unknown and cannot be cleared")
    var guardedOptions = options
    guardedOptions.supportsGuardedAssignmentRecovery = true
    let guardedBoard = LiveAssignments(options: guardedOptions, tables: tables, assignments: assignments)
    let guarded = try guardedBoard.assign(actor: actor, tableIDs: Set(tables.prefix(2).map(\.id)),
      employeeID: options.employees[0].id, roleID: options.roles[0].id, kind: "backup",
      start: now, end: nil, reason: "晚班调整")
    check(guarded.steps[0].path == "/api/table-management/guarded-assignments/batch", "new server opts into guarded route")
    let originalRows = rows.map { row in var r = row; r["endsAt"] = NSNull(); return r }
    try validateAssignmentReply(receipt(originalRows), step: guarded.steps[0])
    let guardedEnd = try guardedBoard.end(actor: actor, id: assignments[0].id, reason: "交班结束", now: now)
    try validateAssignmentReply(endReply, step: guardedEnd.steps[0])
    check(guardedEnd.steps[0].path.contains("guarded-assignments/"), "guarded end validates original receipt")
    check(try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(guarded)) == guarded,
      "guarded route and original key persist unchanged")
    check(options.supportsGuardedAssignmentRecovery == nil && restored.steps[0].path == step.path,
      "old server and stored old requests keep old route")
    for status in [400, 409, 500] {
      for disposition in [nil, "not_committed", "unknown"] as [String?] {
        check(StaffAPIError(status: status, code: "TABLE_ASSIGNMENT_NOT_COMMITTED", message: "冲突",
          commitDisposition: disposition).definitivelyRejected == (status == 409 && disposition == "not_committed"),
          "guarded rejection requires exact status and proof")
      }
    }
    check(!StaffAPIError(status: 409, code: "TABLE_OPERATION_CONFLICT", message: "原键冲突",
      commitDisposition: "not_committed").definitivelyRejected, "old ambiguous conflict never clears")
    checks += try await assignmentScheduleChecks(actor: actor, fixture: fixture)
    print("\(checks) assignment contract checks passed")
  }
}

@MainActor private func assignmentScheduleChecks(actor: StaffIdentity, fixture: [String: Any]) async throws -> Int {
  var checks = 0
  func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1; print("PASS " + label) }
  func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
  func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
    try JSONDecoder().decode(type, from: bytes(value))
  }
  func rejects(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
  let now = assignmentDate("2026-10-06T10:00:00Z")!
  let original = (fixture["assignments"] as! [[String: Any]])[0]
  var row = original
  row["startsAt"] = "2026-10-06 20:00:00+08"
  row["endsAt"] = "2026-10-06T23:00:00+08:00"
  row["updatedAt"] = "2026-10-06T10:00:00Z"
  row["cancelledAt"] = NSNull(); row["cancellationReason"] = NSNull()
  row["configurationFingerprint"] = String(repeating: "a", count: 64)
  var options = try decode(LiveAssignments.Options.self, fixture["options"]!)
  options.supportsNativeAssignmentSchedule = true
  let tables = try decode([LiveAssignments.Table].self, fixture["tables"]!)
  func schedule(_ rows: [[String: Any]]? = nil, mode: String = "future", page: Int = 0,
    employee: String? = nil) throws -> AssignmentSchedule {
    try decode(AssignmentSchedule.self, ["rows": rows ?? [row], "mode": mode, "page": page,
      "employeeId": employee ?? actor.employee.id, "hasMore": false])
  }
  func board(_ value: AssignmentSchedule? = nil) throws -> LiveAssignments {
    LiveAssignments(options: options, tables: tables, assignments: [], schedule: try value ?? schedule())
  }
  let list = try schedule()
  try list.validate(actorID: actor.employee.id, mode: "future", page: 0)
  try schedule(mode: "history").validate(actorID: actor.employee.id, mode: "history", page: 0)
  check(true, "schedule ended history is readable without granting actions")
  var cancelledRow = row
  cancelledRow["cancelledAt"] = now.ISO8601Format()
  cancelledRow["cancellationReason"] = "员工请假取消"
  cancelledRow["endsAt"] = row["startsAt"]
  try schedule([cancelledRow], mode: "cancelled").validate(actorID: actor.employee.id, mode: "cancelled", page: 0)
  check(true, "schedule cancelled history preserves original zero-length row and reason")
  check(rejects { try schedule([cancelledRow]).validate(actorID: actor.employee.id, mode: "future", page: 0) },
    "schedule cancelled record cannot appear as future work")
  check(try AssignmentSchedule.path(mode: "history", page: 2)
    == "/api/table-management/native-assignment-schedule?mode=history&page=2", "schedule history uses bounded server pagination")
  for (mode, page) in [("wrong", 0), ("future", -1), ("cancelled", 10001)] {
    check(rejects { _ = try AssignmentSchedule.path(mode: mode, page: page) }, "schedule query rejects \(mode)/\(page)")
  }
  check(rejects { try list.validate(actorID: "other", mode: "future", page: 0) }, "schedule response binds current employee")
  check(rejects { try list.validate(actorID: actor.employee.id, mode: "history", page: 0) }
    && rejects { try list.validate(actorID: actor.employee.id, mode: "future", page: 1) }, "schedule response cannot substitute mode or page")
  for key in ["id", "tableId", "employeeId", "roleId", "startsAt", "endsAt", "updatedAt", "configurationFingerprint", "assignmentType"] {
    var invalid = row; invalid[key] = "invalid"
    check(rejects { try schedule([invalid]).validate(actorID: actor.employee.id, mode: "future", page: 0) }, "schedule list rejects invalid \(key)")
  }
  check(rejects { try schedule([row, row]).validate(actorID: actor.employee.id, mode: "future", page: 0) }, "schedule list rejects duplicate originals")
  check(rejects { try schedule(Array(repeating: row, count: 51)).validate(actorID: actor.employee.id, mode: "future", page: 0) }, "schedule list never accepts unbounded page")
  let change = try AssignmentSchedule.Change(employeeID: options.employees[0].id,
    roleID: options.roles[0].id, kind: "backup", start: now.addingTimeInterval(14400), end: nil)
  let current = try board()
  let updated = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: "延后晚班负责人", change: change, now: now)
  let cancelled = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: "员工请假取消", change: nil, now: now)
  check(updated.steps[0].keyHeader == "idempotency-key" && updated.steps[0].key.hasPrefix("native-business-")
    && updated.steps[0].object["expected"] as? String == row["configurationFingerprint"] as? String,
    "schedule update freezes optimistic version with native permanent-receipt key")
  check(cancelled.steps[0].object["schedule"] == nil && cancelled.steps[0].object["kind"] as? String == "cancel",
    "schedule cancellation carries no replacement schedule")
  let confirmation = updated.steps[0].assignmentProof!["confirmation"] as! String
  check(confirmation.contains(options.employees[0].displayName) && confirmation.contains(options.roles[0].name)
    && confirmation.contains("新时段") && confirmation.contains("上海时间"), "schedule confirmation shows original and new responsibility")
  check(rejects { _ = try current.changeSchedule(actor: actor, id: "foreign", reason: "原安排核对", change: nil, now: now) }, "schedule never targets unseen row")
  check(rejects { _ = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: "原安排核对", change: nil, now: now.addingTimeInterval(7200)) }, "activated schedule cannot be cancelled")
  for mode in ["history", "cancelled"] {
    check(rejects { _ = try board(schedule(mode: mode)).changeSchedule(actor: actor, id: list.rows[0].id, reason: "原安排核对", change: nil, now: now) }, "\(mode) schedule cannot be changed")
  }
  var deniedValue = try JSONSerialization.jsonObject(with: JSONEncoder().encode(actor)) as! [String: Any]
  deniedValue["deniedPermissions"] = [LiveAssignments.permission]
  let denied = try decode(StaffIdentity.self, deniedValue)
  check(rejects { _ = try current.changeSchedule(actor: denied, id: list.rows[0].id, reason: "原安排核对", change: nil, now: now) }, "schedule explicit permission denial wins")
  check(rejects { _ = try board(schedule(employee: "other")).changeSchedule(actor: actor, id: list.rows[0].id, reason: "原安排核对", change: nil, now: now) }, "schedule cached under another actor cannot submit")
  check(rejects { _ = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: " ", change: nil, now: now) }, "schedule reason required")
  let unavailable = try AssignmentSchedule.Change(employeeID: UUID().uuidString, roleID: options.roles[0].id,
    kind: "backup", start: now.addingTimeInterval(14400), end: nil)
  check(rejects { _ = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: "人员变化核对", change: unavailable, now: now) }, "schedule inactive or foreign employee rejected")
  check(rejects { _ = try AssignmentSchedule.Change(employeeID: options.employees[0].id,
    roleID: options.roles[0].id, kind: "backup", start: now, end: now.addingTimeInterval(0.1)) }, "schedule seconds precision cannot collapse interval")
  let past = try AssignmentSchedule.Change(employeeID: options.employees[0].id,
    roleID: options.roles[0].id, kind: "backup", start: now, end: nil)
  check(rejects { _ = try current.changeSchedule(actor: actor, id: list.rows[0].id, reason: "时间变化核对", change: past, now: now) }, "schedule update must remain future")
  var oldOptions = options; oldOptions.supportsNativeAssignmentSchedule = nil
  let oldServer = LiveAssignments(options: oldOptions, tables: tables, assignments: [], schedule: list)
  check(rejects { _ = try oldServer.changeSchedule(actor: actor, id: list.rows[0].id, reason: "旧后台核对", change: nil, now: now) }, "schedule capability missing cannot silently use unsafe route")
  func reply(_ command: LiveCommand, replayed: Bool = false) throws -> [String: Any] {
    let body = command.steps[0].object
    var result = row
    result.removeValue(forKey: "configurationFingerprint")
    if let values = body["schedule"] as? [String: Any] {
      for (key, value) in values { result[key] = value }; result["reason"] = body["reason"]
    } else {
      result["cancelledAt"] = now.ISO8601Format(); result["cancellationReason"] = body["reason"]
      result["endsAt"] = result["startsAt"]
    }
    return ["meta": ["replayed": replayed], "data": ["kind": body["kind"]!,
      "employeeId": actor.employee.id, "reason": body["reason"]!, "previousFingerprint": body["expected"]!, "row": result]]
  }
  for command in [updated, cancelled] {
    let step = command.steps[0], operation = step.object["kind"] as! String
    try validateAssignmentReply(bytes(reply(command)), step: step)
    check(true, "schedule \(operation) exact receipt accepted")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(command))
    check(restored == command, "schedule \(operation) persists original key body and version")
    for key in ["kind", "employeeId", "reason", "previousFingerprint"] {
      var response = try reply(command); var data = response["data"] as! [String: Any]
      data[key] = "wrong"; response["data"] = data
      check(rejects { try validateAssignmentReply(bytes(response), step: step) }, "schedule \(operation) rejects wrong receipt \(key)")
    }
    for key in ["id", "tableId", "employeeId", "roleId", "assignmentType", "startsAt", "endsAt", "reason"] {
      var response = try reply(command); var data = response["data"] as! [String: Any]
      var result = data["row"] as! [String: Any]; result[key] = "wrong"; data["row"] = result; response["data"] = data
      check(rejects { try validateAssignmentReply(bytes(response), step: step) }, "schedule \(operation) rejects changed original \(key)")
    }
    var malformed = try reply(command); malformed["meta"] = ["replayed": 1]
    check(rejects { try validateAssignmentReply(bytes(malformed), step: step) }, "schedule \(operation) numeric replay marker rejected")
    for key in operation == "cancel" ? ["cancelledAt", "cancellationReason"] : ["cancelledAt"] {
      var response = try reply(command); var data = response["data"] as! [String: Any]
      var result = data["row"] as! [String: Any]; result[key] = "wrong"; data["row"] = result; response["data"] = data
      check(rejects { try validateAssignmentReply(bytes(response), step: step) }, "schedule \(operation) rejects wrong \(key)")
    }
    var commits = 0, sends = 0
    var persisted = try JSONEncoder().encode(command)
    let api = StaffAPI(transport: { request in
      sends += 1
      guard request.url?.path == step.path, request.httpMethod == "POST",
        request.value(forHTTPHeaderField: step.keyHeader) == step.key,
        let payload = request.httpBody,
        NSDictionary(dictionary: try JSONSerialization.jsonObject(with: payload) as! [String: Any]).isEqual(to: step.object)
      else { throw StaffAPIError.invalid }
      if commits == 0 { commits += 1; throw URLError(.timedOut) }
      return (try bytes(reply(command, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    })
    do { _ = try await LiveCommandRunner.advance(restored, send: { try await api.execute($0) },
      checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("lost schedule response accepted") } catch {}
    let relaunched = try JSONDecoder().decode(LiveCommand.self, from: persisted)
    check(relaunched == command, "schedule \(operation) unknown result keeps original pending intent")
    let complete = try await LiveCommandRunner.advance(relaunched, send: { try await api.execute($0) },
      checkpoint: { persisted = try JSONEncoder().encode($0) })
    check(commits == 1 && sends == 2 && complete.completedSteps == 1,
      "schedule \(operation) lost receipt recovers through real API adapter without second change")
    _ = try await LiveCommandRunner.advance(complete, send: { try await api.execute($0) }, checkpoint: { _ in })
    check(sends == 2, "schedule \(operation) failed readback retry never resends checkpointed write")
  }
  for disposition in [nil, "unknown", "not_committed"] as [String?] {
    check(StaffAPIError(status: 409, code: "NATIVE_BUSINESS_NOT_COMMITTED", message: "时段并发变化",
      commitDisposition: disposition).definitivelyRejected == (disposition == "not_committed"),
      "schedule conflict clears only with explicit noncommit proof")
  }
  check(!StaffAPIError(status: 409, code: "ASSIGNMENT_CONFLICT", message: "原键处理中").definitivelyRejected,
    "schedule original-key conflict remains recoverable")
  return checks
}
