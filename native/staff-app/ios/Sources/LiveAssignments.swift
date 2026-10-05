import Foundation

let assignmentKinds = ["primary": "主服务员", "backup": "候补服务员", "temporary": "临时支援"]
func assignmentDate(_ value: String) -> Date? {
  var text = value.replacingOccurrences(of: " ", with: "T")
  if text.range(of: "[+-][0-9]{2}$", options: .regularExpression) != nil { text += ":00" }
  return StaffIdentity.date(text)
}
func assignmentTime(_ value: String) -> String {
  guard let date = assignmentDate(value) else { return "时间待核对" }
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
  formatter.dateFormat = "MM-dd HH:mm"
  return formatter.string(from: date)
}
struct LiveAssignments {
  static let permission = "table.assignment.manage"
  struct Options: Decodable {
    struct Employee: Decodable, Identifiable {
      let id: String
      let code: String
      let displayName: String
    }
    struct Role: Decodable, Identifiable {
      let id: String
      let code: String
      let name: String
    }
    let employees: [Employee]
    let roles: [Role]
    var supportsGuardedAssignmentRecovery: Bool? = nil
    var supportsNativeAssignmentSchedule: Bool? = nil
  }
  struct Table: Decodable, Identifiable {
    let id: String
    let code: String
    let areaId: String
    let areaName: String
    let capacity: Int
    let status: String
    let activeSessionId: String?
  }
  struct Assignment: Decodable, Identifiable {
    let id: String
    let tableId: String
    let tableCode: String
    let employeeId: String
    let employeeName: String
    let roleId: String
    let roleCode: String
    let assignmentType: String
    let startsAt: String
    let endsAt: String?
    let reason: String
  }
  let options: Options
  let tables: [Table]
  let assignments: [Assignment]
  var schedule: AssignmentSchedule? = nil
  var commandRoot: String {
    options.supportsGuardedAssignmentRecovery == true
      ? "/api/table-management/guarded-assignments" : "/api/table-management/assignments"
  }
  func validate() throws {
    for ids in [
      tables.map(\.id), assignments.map(\.id), options.employees.map(\.id), options.roles.map(\.id),
    ] {
      guard !ids.contains(""), Set(ids).count == ids.count else { throw StaffAPIError.invalid }
    }
    guard
      assignments.allSatisfy({
        assignmentDate($0.startsAt) != nil
          && ($0.endsAt == nil || assignmentDate($0.endsAt!) != nil)
      })
    else { throw StaffAPIError.invalid }
  }
  func visibleTables(_ query: String) -> [Table] {
    let q = query.folding(
      options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "zh_CN")
    ).filter { !$0.isWhitespace }
    return tables.filter { row in
      row.status == "available"
        && (q.isEmpty
          || (row.code + row.areaName).folding(
            options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "zh_CN")
          ).filter { !$0.isWhitespace }.contains(q))
    }.sorted { a, b in
      if (a.activeSessionId != nil) != (b.activeSessionId != nil) {
        return a.activeSessionId != nil
      }
      return a.code.localizedStandardCompare(b.code) == .orderedAscending
    }
  }
  func assign(
    actor: StaffIdentity, tableIDs: Set<String>, employeeID: String, roleID: String, kind: String,
    start: Date, end: Date?, reason: String
  ) throws -> LiveCommand {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows(Self.permission), (1...80).contains(tableIDs.count),
      assignmentKinds[kind] != nil,
      let employee = options.employees.first(where: { $0.id == employeeID }),
      let role = options.roles.first(where: { $0.id == roleID }),
      tableIDs.allSatisfy({ id in tables.contains { $0.id == id && $0.status == "available" } }),
      start.timeIntervalSince1970.isFinite,
      end == nil || (end!.timeIntervalSince1970.isFinite && end! > start),
      (2...1000).contains(reason.utf16.count)
    else { throw CatalogError("请核对可用桌台、员工、岗位、起止时间和2—1000字原因") }
    let iso = ISO8601DateFormatter()
    let startsAt = iso.string(from: start)
    let endsAt = end.map { iso.string(from: $0) }
    // Precision sent to PostgreSQL must still describe a non-empty interval.
    guard endsAt == nil || assignmentDate(endsAt!)! > assignmentDate(startsAt)! else {
      throw CatalogError("结束时间必须晚于开始时间")
    }
    // Mirror the two database exclusion constraints using only the visible snapshot.
    // Hidden future assignments and races remain the server's authority.
    let conflicts = assignments.filter { item in
      guard tableIDs.contains(item.tableId), let existingStart = assignmentDate(item.startsAt),
        end == nil || existingStart < end!,
        item.endsAt == nil || item.endsAt.flatMap(assignmentDate).map({ $0 > start }) == true
      else { return false }
      return item.employeeId == employeeID
        || (kind == "primary" && item.assignmentType == "primary")
    }
    guard conflicts.isEmpty else {
      throw CatalogError(
        "责任时段冲突：" + conflicts.map { $0.tableCode + " · " + $0.employeeName }.joined(separator: "、")
          + "。请先核对并结束原责任，或调整起止时间。")
    }
    let body: [String: Any] = [
      "tableIds": tableIDs.sorted(), "employeeId": employeeID, "roleId": roleID,
      "assignmentType": kind, "startsAt": startsAt, "endsAt": endsAt as Any? ?? NSNull(),
      "reason": reason,
    ]
    let codes = visibleTables("").filter { tableIDs.contains($0.id) }.map(\.code).joined(
      separator: "、")
    let confirmation =
      "员工：\(employee.displayName) · 岗位：\(role.name)\n责任：\(assignmentKinds[kind]!)\n桌台：\(codes)\n上海时间：\(assignmentTime(startsAt)) 起，\(endsAt.map(assignmentTime) ?? "不设结束时间")\n原因：\(reason)\n所选桌台一次提交；冲突时不会部分生效。岗位仅用于责任记录，不授予账号新权限。"
    return try make(
      actor: actor, path: "\(commandRoot)/batch", body: body,
      proof: ["assignment": "batch", "confirmation": confirmation, "actorId": actor.employee.id],
      title: "\(employee.displayName) · 安排\(tableIDs.count)张责任桌")
  }
  func end(actor: StaffIdentity, id: String, reason: String, now: Date = Date()) throws
    -> LiveCommand
  {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows(Self.permission), let item = assignments.first(where: { $0.id == id }),
      let start = assignmentDate(item.startsAt), start < now,
      item.endsAt == nil || item.endsAt.flatMap(assignmentDate).map({ $0 > now }) == true,
      (2...1000).contains(reason.utf16.count)
    else { throw CatalogError("责任安排已变化或不在生效期内，请刷新并填写结束原因") }
    let time = ISO8601DateFormatter().string(from: now)
    guard assignmentDate(time)! > start else { throw CatalogError("刚生效的安排请稍后再结束") }
    return try make(
      actor: actor, path: "\(commandRoot)/\(LiveCommand.pathPart(id))/end",
      body: ["endsAt": time, "reason": reason],
      proof: [
        "assignment": "end", "id": item.id, "tableId": item.tableId, "employeeId": item.employeeId,
        "roleId": item.roleId, "assignmentType": item.assignmentType, "startsAt": item.startsAt,
        "confirmation":
          "\(item.tableCode) · \(item.employeeName) · \(assignmentKinds[item.assignmentType] ?? item.assignmentType)\n上海时间 \(assignmentTime(time)) 结束责任。\n原因：\(reason)\n仅结束人员责任，不关桌、不清除该桌待办。",
      ], title: "结束 \(item.tableCode) · \(item.employeeName) 的责任")
  }
  private func make(
    actor: StaffIdentity, path: String, body: [String: Any], proof: [String: Any], title: String
  ) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: Self.permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "x-idempotency-key", key: "native-assignment-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var assignmentProof: [String: Any]? {
    guard let recoveryBody,
      let value = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      value["assignment"] is String
    else { return nil }
    return value
  }
}
func validateAssignmentReply(_ bytes: Data, step: LiveCommand.Step) throws {
  if step.assignmentProof?["assignment"] as? String == "schedule" {
    try validateAssignmentScheduleReply(bytes, step: step)
    return
  }
  struct EnvelopeMeta: Decodable {
    struct Meta: Decodable { let replayed: Bool }
    let meta: Meta
  }
  _ = try JSONDecoder().decode(EnvelopeMeta.self, from: bytes)
  guard let proof = step.assignmentProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    let id = data["id"] as? String, !id.isEmpty
  else { throw StaffAPIError.invalid }
  func equalTime(_ lhs: Any?, _ rhs: Any?) -> Bool {
    if lhs is NSNull || lhs == nil { return rhs is NSNull || rhs == nil }
    guard let a = lhs as? String, let b = rhs as? String, let x = assignmentDate(a),
      let y = assignmentDate(b)
    else { return false }
    return abs(x.timeIntervalSince(y)) < 0.001
  }
  if proof["assignment"] as? String == "batch" {
    guard ["/api/table-management/assignments/batch", "/api/table-management/guarded-assignments/batch"].contains(step.path),
      let rows = data["assignments"] as? [[String: Any]],
      let expected = step.object["tableIds"] as? [String], rows.count == expected.count
    else { throw StaffAPIError.invalid }
    var tableIDs = Set<String>()
    var ids = Set<String>()
    for row in rows {
      guard let rowID = row["id"] as? String, !rowID.isEmpty, ids.insert(rowID).inserted,
        let tableID = row["tableId"] as? String, tableIDs.insert(tableID).inserted,
        row["createdByEmployeeId"] as? String == proof["actorId"] as? String
      else { throw StaffAPIError.invalid }
      for key in ["employeeId", "roleId", "assignmentType", "reason"] {
        guard row[key] as? String == step.object[key] as? String else {
          throw StaffAPIError.invalid
        }
      }
      guard equalTime(row["startsAt"], step.object["startsAt"]),
        equalTime(row["endsAt"], step.object["endsAt"])
      else { throw StaffAPIError.invalid }
    }
    guard tableIDs == Set(expected) else { throw StaffAPIError.invalid }
  } else {
    guard proof["assignment"] as? String == "end", data["id"] as? String == proof["id"] as? String,
      ["/api/table-management/assignments/\(LiveCommand.pathPart(id))/end",
        "/api/table-management/guarded-assignments/\(LiveCommand.pathPart(id))/end"].contains(step.path)
    else { throw StaffAPIError.invalid }
    for key in ["tableId", "employeeId", "roleId", "assignmentType"] {
      guard data[key] as? String == proof[key] as? String else { throw StaffAPIError.invalid }
    }
    guard equalTime(data["startsAt"], proof["startsAt"]),
      equalTime(data["endsAt"], step.object["endsAt"])
    else { throw StaffAPIError.invalid }
  }
}

struct AssignmentSchedule: Decodable, Equatable {
  static let modes = ["future", "history", "cancelled"]
  static let labels = ["future": "未来安排", "history": "已结束", "cancelled": "已取消"]
  struct Row: Codable, Equatable, Identifiable {
    let id, tableId, tableCode, employeeId, employeeName, roleId, roleCode: String
    let assignmentType, startsAt, reason, updatedAt, configurationFingerprint: String
    let endsAt, cancelledAt, cancellationReason: String?
  }
  struct Change: Codable, Equatable {
    let employeeId, roleId, assignmentType, startsAt: String
    let endsAt: String?
    init(employeeID: String, roleID: String, kind: String, start: Date, end: Date?) throws {
      guard UUID(uuidString: employeeID) != nil, UUID(uuidString: roleID) != nil,
        assignmentKinds[kind] != nil, start.timeIntervalSince1970.isFinite,
        end == nil || (end!.timeIntervalSince1970.isFinite && end! > start)
      else { throw CatalogError("请核对原安排的员工、岗位和起止时间") }
      let iso = ISO8601DateFormatter()
      employeeId = employeeID; roleId = roleID; assignmentType = kind
      startsAt = iso.string(from: start); endsAt = end.map(iso.string)
      guard endsAt == nil || assignmentDate(endsAt!)! > assignmentDate(startsAt)! else {
        throw CatalogError("结束时间必须晚于开始时间")
      }
    }
    var object: [String: Any] {
      ["employeeId": employeeId, "roleId": roleId, "assignmentType": assignmentType,
        "startsAt": startsAt, "endsAt": endsAt as Any? ?? NSNull()]
    }
  }
  let employeeId, mode: String
  let page: Int
  let hasMore: Bool
  let rows: [Row]
  static func path(mode: String, page: Int) throws -> String {
    guard modes.contains(mode), (0...10000).contains(page) else { throw StaffAPIError.invalid }
    return "/api/table-management/native-assignment-schedule?mode=\(mode)&page=\(page)"
  }
  func validate(actorID: String, mode: String, page: Int) throws {
    guard employeeId == actorID, self.mode == mode, self.page == page,
      Self.modes.contains(mode), (0...10000).contains(page), rows.count <= 50,
      Set(rows.map(\.id)).count == rows.count
    else { throw StaffAPIError.invalid }
    for row in rows {
      guard [row.id, row.tableId, row.employeeId, row.roleId].allSatisfy({ UUID(uuidString: $0) != nil }),
        !row.tableCode.isEmpty, !row.employeeName.isEmpty, !row.roleCode.isEmpty,
        assignmentKinds[row.assignmentType] != nil,
        let start = assignmentDate(row.startsAt), assignmentDate(row.updatedAt) != nil,
        row.configurationFingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
      else { throw StaffAPIError.invalid }
      if let cancellation = row.cancelledAt {
        guard mode == "cancelled", assignmentDate(cancellation) != nil,
          row.endsAt.flatMap(assignmentDate) == start,
          (2...1000).contains((row.cancellationReason ?? "").utf16.count)
        else { throw StaffAPIError.invalid }
      } else {
        guard mode != "cancelled", row.endsAt == nil || row.endsAt.flatMap(assignmentDate).map({ $0 > start }) == true,
          mode != "history" || row.endsAt != nil
        else { throw StaffAPIError.invalid }
      }
    }
  }
}

extension LiveAssignments {
  func changeSchedule(
    actor: StaffIdentity, id: String, reason: String, change: AssignmentSchedule.Change?,
    now: Date = Date()
  ) throws -> LiveCommand {
    guard options.supportsNativeAssignmentSchedule == true, let schedule else {
      throw CatalogError("配套后台尚未提供未来安排管理，请在原管理端核对")
    }
    try schedule.validate(actorID: actor.employee.id, mode: schedule.mode, page: schedule.page)
    guard actor.allows(Self.permission), schedule.mode == "future",
      let row = schedule.rows.first(where: { $0.id == id }), row.cancelledAt == nil,
      let originalStart = assignmentDate(row.startsAt), originalStart > now
    else { throw CatalogError("仅能修改或取消尚未生效的原安排，请刷新核对") }
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...1000).contains(note.utf16.count) else { throw CatalogError("请填写2—1000字实际原因") }
    var body: [String: Any] = ["kind": change == nil ? "cancel" : "update", "id": id,
      "expected": row.configurationFingerprint, "reason": note]
    var confirmation = "\(row.tableCode) · \(row.employeeName) · \(assignmentKinds[row.assignmentType]!)\n原岗位：\(row.roleCode)\n原时段：\(assignmentTime(row.startsAt)) → \(row.endsAt.map(assignmentTime) ?? "不设结束") · 上海时间"
    if let change {
      guard let employee = options.employees.first(where: { $0.id == change.employeeId }),
        let role = options.roles.first(where: { $0.id == change.roleId }),
        tables.contains(where: { $0.id == row.tableId && $0.status == "available" }),
        assignmentKinds[change.assignmentType] != nil,
        let start = assignmentDate(change.startsAt), start > now,
        change.endsAt == nil || change.endsAt.flatMap(assignmentDate).map({ $0 > start }) == true
      else { throw CatalogError("请刷新并选择可用桌台、在职员工、岗位及未来开始时间") }
      body["schedule"] = change.object
      confirmation += "\n新员工：\(employee.displayName) · \(assignmentKinds[change.assignmentType]!)\n新岗位：\(role.name)\n新时段：\(assignmentTime(change.startsAt)) → \(change.endsAt.map(assignmentTime) ?? "不设结束") · 上海时间\n修改后按新安排生效；岗位仅记录分工，不授予账号权限。"
    } else {
      confirmation += "\n取消后不再生效，原记录和取消原因保留。已生效责任应使用结束责任；此操作不关桌、不清除该桌待办。"
    }
    confirmation += "\n原因：\(note)\n若其他人已修改或时段冲突，服务器会拒绝本次变更，请刷新核对。"
    let before = try JSONSerialization.jsonObject(with: JSONEncoder().encode(row))
    let proof: [String: Any] = ["assignment": "schedule", "actorId": actor.employee.id,
      "before": before, "confirmation": confirmation]
    let key = UUID().uuidString.lowercased()
    return LiveCommand(id: key, employeeID: actor.employee.id,
      title: (change == nil ? "取消未来安排" : "修改未来安排") + " · " + row.tableCode,
      permission: Self.permission, steps: [.init(
        path: "/api/table-management/native-assignment-schedule/commands",
        body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-business-" + key,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))])
  }
}

func validateAssignmentScheduleReply(_ bytes: Data, step: LiveCommand.Step) throws {
  struct Envelope: Decodable {
    struct Meta: Decodable { let replayed: Bool }
    let meta: Meta
  }
  _ = try JSONDecoder().decode(Envelope.self, from: bytes)
  let body = step.object
  guard step.path == "/api/table-management/native-assignment-schedule/commands",
    let proof = step.assignmentProof, proof["assignment"] as? String == "schedule",
    let before = proof["before"] as? [String: Any],
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let row = data["row"] as? [String: Any],
    let kind = body["kind"] as? String, ["update", "cancel"].contains(kind),
    data["kind"] as? String == kind, data["reason"] as? String == body["reason"] as? String,
    let actorID = proof["actorId"] as? String, !actorID.isEmpty,
    data["employeeId"] as? String == actorID,
    let expected = body["expected"] as? String,
    expected == before["configurationFingerprint"] as? String,
    data["previousFingerprint"] as? String == expected,
    let id = body["id"] as? String, row["id"] as? String == id, before["id"] as? String == id,
    let tableID = before["tableId"] as? String, row["tableId"] as? String == tableID
  else { throw StaffAPIError.invalid }
  func equalTime(_ a: Any?, _ b: Any?) -> Bool {
    if a == nil || a is NSNull { return b == nil || b is NSNull }
    guard let a = a as? String, let b = b as? String,
      let first = assignmentDate(a), let second = assignmentDate(b) else { return false }
    return abs(first.timeIntervalSince(second)) < 0.001
  }
  if kind == "cancel" {
    guard let cancelledAt = row["cancelledAt"] as? String, assignmentDate(cancelledAt) != nil,
      row["cancellationReason"] as? String == body["reason"] as? String,
      equalTime(row["startsAt"], before["startsAt"]), equalTime(row["endsAt"], row["startsAt"])
    else { throw StaffAPIError.invalid }
    for key in ["employeeId", "roleId", "assignmentType", "reason"] {
      guard row[key] as? String == before[key] as? String else { throw StaffAPIError.invalid }
    }
  } else {
    guard let change = body["schedule"] as? [String: Any],
      row["cancelledAt"] == nil || row["cancelledAt"] is NSNull,
      row["reason"] as? String == body["reason"] as? String,
      equalTime(row["startsAt"], change["startsAt"]), equalTime(row["endsAt"], change["endsAt"])
    else { throw StaffAPIError.invalid }
    for key in ["employeeId", "roleId", "assignmentType"] {
      guard row[key] as? String == change[key] as? String else { throw StaffAPIError.invalid }
    }
  }
}
