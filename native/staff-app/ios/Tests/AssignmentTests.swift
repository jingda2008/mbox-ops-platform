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
    print("\(checks) assignment contract checks passed")
  }
}
