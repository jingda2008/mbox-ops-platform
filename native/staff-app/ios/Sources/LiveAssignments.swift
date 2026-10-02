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
