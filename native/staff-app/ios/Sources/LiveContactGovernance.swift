import Foundation
let contactGovernanceRoot = "/api/staff/native-contact-governance"
let contactResourceKinds = [("activity_registration_contact", "活动报名联系方式"), ("verified_membership_phone", "已验证会员手机号")]
let contactAreas = [("policies", "策略版本"), ("holds", "法定保留"), ("dispositions", "清除证据"), ("resources", "选择保留对象")]
let contactActions = ["draft": "建立保留策略草稿", "approve": "独立审批保留策略", "publish": "第三人发布保留策略", "hold": "建立法定保留", "release": "释放法定保留"]
let contactStatuses = ["draft": "待审批", "approved": "待发布", "published": "已发布", "retired": "已退役", "active": "保留中", "released": "已释放"]
func contactPermission(_ action: String) -> String { ["hold", "release"].contains(action) ? "privacy.contact.legal_hold" : "privacy.contact.retention." + action }
func contactPublicID(_ value: String, prefix: String? = nil) -> Bool {
  if let prefix { return value.range(of: "^" + prefix + "[0-9A-F]{32}$", options: .regularExpression) != nil }
  return (3...64).contains(value.utf16.count) && !value.contains("/") && !value.contains("\n")
}
func contactMasked(_ value: Any?) throws -> String {
  guard let text = value as? String, !text.isEmpty, text.contains("*") || text == "已清除" else { throw CatalogError("接口未返回受保护的联系方式，请重新读取") }; return text
}
struct ContactGovernanceRecord: Identifiable, Equatable {
  let data: Data
  init(_ raw: [String: Any]) throws { data = try membershipData(raw) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("publicId").isEmpty ? text("resourcePublicId") : text("publicId") }
  func text(_ key: String) -> String { membershipText(object[key]) }
}
func validateContactRecord(_ row: ContactGovernanceRecord, area: String) throws {
  let r = row.object
  guard contactResourceKinds.contains(where: { $0.0 == row.text("resourceKind") }), contactPublicID(row.id), row.text("nativeVersion").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
  if area == "policies" {
    guard contactPublicID(row.id, prefix: "PCR"), ["draft", "approved", "published", "retired"].contains(row.text("status")), UUID(uuidString: row.text("draftedByEmployeeId")) != nil else { throw StaffAPIError.invalid }
    _ = try couponPolicyInteger(r["version"], 1...2_147_483_647); _ = try couponPolicyInteger(r["retentionDaysAfterPurposeEnd"], 0...36500); _ = try annualText(r["legalBasisReference"], min: 3, max: 500); _ = try annualText(r["draftReason"], max: 500)
    if ["approved", "published", "retired"].contains(row.text("status")) { guard UUID(uuidString: row.text("approvedByEmployeeId")) != nil, row.text("approvedByEmployeeId") != row.text("draftedByEmployeeId") else { throw StaffAPIError.invalid } }
    if ["published", "retired"].contains(row.text("status")) { guard UUID(uuidString: row.text("publishedByEmployeeId")) != nil, ![row.text("draftedByEmployeeId"), row.text("approvedByEmployeeId")].contains(row.text("publishedByEmployeeId")), assignmentDate(row.text("effectiveFrom")) != nil else { throw StaffAPIError.invalid } }
  } else {
    _ = try contactMasked(r["maskedContact"])
    if area == "holds" {
      guard contactPublicID(row.id, prefix: "PCH"), contactPublicID(row.text("resourcePublicId")), ["active", "released"].contains(row.text("status")), UUID(uuidString: row.text("createdByEmployeeId")) != nil, r["holdUntil"] is NSNull || assignmentDate(row.text("holdUntil")) != nil else { throw StaffAPIError.invalid }
      _ = try annualText(r["legalBasisReference"], min: 3, max: 500); _ = try annualText(r["reason"], max: 500)
      if row.text("status") == "released" { guard UUID(uuidString: row.text("releasedByEmployeeId")) != nil, assignmentDate(row.text("releasedAt")) != nil else { throw StaffAPIError.invalid }; _ = try annualText(r["releaseReason"], max: 500) }
    } else if area == "resources" { guard !row.text("businessLabel").isEmpty, !row.text("status").isEmpty, row.text("status") != "disposed" else { throw StaffAPIError.invalid } }
    else if area == "dispositions" { guard contactPublicID(row.text("policyPublicId"), prefix: "PCR"), row.text("maskedContact") == "已清除", !row.text("dispositionMethod").isEmpty, assignmentDate(row.text("purposeEndedAt")) != nil, assignmentDate(row.text("disposedAt")) != nil else { throw StaffAPIError.invalid }; _ = try couponPolicyInteger(r["policyVersion"], 1...2_147_483_647) }
    else { throw StaffAPIError.invalid }
  }
}
struct ContactGovernanceBoard {
  let employeeID: String, enabled: Bool, area: String, search: String, cursor: String
  let rows: [ContactGovernanceRecord], nextCursor: String?
  static func query(area: String = "policies", search: String = "", cursor: String = "") throws -> String {
    guard contactAreas.contains(where: { $0.0 == area }), search.utf16.count <= 80, cursor.isEmpty || contactPublicID(cursor) else { throw StaffAPIError.invalid }
    var parts = URLComponents(); parts.queryItems = [URLQueryItem(name: "area", value: area), URLQueryItem(name: "search", value: search)] + (cursor.isEmpty ? [] : [URLQueryItem(name: "cursor", value: cursor)])
    return contactGovernanceRoot + "?" + (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
  init(data: Data, actor: StaffIdentity, area: String = "policies", search: String = "", cursor: String = "") throws {
    _ = try Self.query(area: area, search: search, cursor: cursor)
    guard actor.allows("privacy.contact.retention.view"), area != "resources" || actor.allows("privacy.contact.legal_hold"), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let d = root["data"] as? [String: Any], d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1, try walletBoolean(d["durableCommands"]), d["area"] as? String == area, let raw = d["rows"] as? [[String: Any]], raw.count <= 50 else { throw CatalogError("请确认当前联系方式治理权限并重新读取") }
    employeeID = actor.employee.id; enabled = true; self.area = area; self.search = search; self.cursor = cursor
    rows = try raw.map(ContactGovernanceRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }; for row in rows { try validateContactRecord(row, area: area) }
    nextCursor = d["next"] as? String; guard d["next"] is NSNull || nextCursor.map({ contactPublicID($0) }) == true else { throw StaffAPIError.invalid }
  }
  func actions(actor: StaffIdentity, row: ContactGovernanceRecord) -> [String] {
    guard enabled, employeeID == actor.employee.id, actor.allows("privacy.contact.retention.view"), rows.contains(row) else { return [] }
    if area == "resources" { return actor.allows(contactPermission("hold")) ? ["hold"] : [] }
    if area == "holds" { return row.text("status") == "active" && actor.allows(contactPermission("release")) ? ["release"] : [] }
    if area != "policies" { return [] }
    if row.text("status") == "draft", row.text("draftedByEmployeeId") != employeeID, actor.allows(contactPermission("approve")) { return ["approve"] }
    if row.text("status") == "approved", ![row.text("draftedByEmployeeId"), row.text("approvedByEmployeeId")].contains(employeeID), actor.allows(contactPermission("publish")) { return ["publish"] }
    return []
  }
  func command(actor: StaffIdentity, action: String, body input: [String: Any], row: ContactGovernanceRecord? = nil, now: Date = Date()) throws -> LiveCommand {
    guard let title = contactActions[action], employeeID == actor.employee.id, enabled, actor.allows("privacy.contact.retention.view"), actor.allows(contactPermission(action)), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("请读取当前权限和原保留记录") }
    var b = input; b["reason"] = try annualText(b["reason"], max: 500)
    if action == "draft" { guard area == "policies", Set(input.keys) == ["reason", "resourceKind", "retentionDaysAfterPurposeEnd", "legalBasisReference"] else { throw StaffAPIError.invalid }; b["retentionDaysAfterPurposeEnd"] = try couponPolicyInteger(b["retentionDaysAfterPurposeEnd"], 0...36500) }
    else { guard let row, actions(actor: actor, row: row).contains(action) else { throw CatalogError("原状态、独立分工或版本不允许此操作，请重新读取") }; b["expectedVersion"] = row.text("nativeVersion"); b[action == "hold" ? "resourcePublicId" : "publicId"] = row.id }
    if ["draft", "hold"].contains(action) { guard contactResourceKinds.contains(where: { $0.0 == b["resourceKind"] as? String }) else { throw StaffAPIError.invalid }; b["legalBasisReference"] = try annualText(b["legalBasisReference"], min: 3, max: 500) }
    if ["approve", "release"].contains(action) { guard Set(input.keys) == ["reason"] else { throw StaffAPIError.invalid } }
    if action == "publish" { guard Set(input.keys) == ["reason", "effectiveFrom"], let date = assignmentDate(membershipText(b["effectiveFrom"])), date >= now.addingTimeInterval(-60) else { throw CatalogError("生效时间不能明显早于现在，请核对北京时间") } }
    if action == "hold" { guard Set(input.keys) == ["reason", "resourceKind", "legalBasisReference", "holdUntil"], row?.text("resourceKind") == b["resourceKind"] as? String, b["holdUntil"] is NSNull || assignmentDate(membershipText(b["holdUntil"])).map({ $0 > now }) == true else { throw CatalogError("请选择原联系方式版本，截止须晚于现在或有明确无预定截止依据") } }
    var summary = title + "\n"
    if action == "draft" { summary += try contactPolicySummary(b) }
    else if ["approve", "publish"].contains(action) { summary += try contactPolicySummary(row!.object) + "\n原政策：" + row!.id + " · 第" + row!.text("version") + "版" }
    else if action == "hold" { summary += contactResourceKinds.first { $0.0 == row!.text("resourceKind") }!.1 + "\n" + row!.text("businessLabel") + " · " + row!.text("maskedContact") + "\n原联系方式版本：" + row!.id + "\n依据：" + membershipText(b["legalBasisReference"]) + "\n保留至：" + (b["holdUntil"] is NSNull ? "无预定截止（须有相应依据）" : try membershipLocal(membershipText(b["holdUntil"]))) + "\n仅阻止此旧版本清除，不影响顾客更正联系方式。" }
    else { summary += "原保留：" + row!.id + "\n" + row!.text("resourcePublicId") + " · " + row!.text("maskedContact") + "\n原依据：" + row!.text("legalBasisReference") + "\n释放后，符合已发布期限的旧版本由清除任务处理；不会立即删除当前联系方式。" }
    if action == "publish" { summary += "\n生效：" + (try membershipLocal(membershipText(b["effectiveFrom"]))) }
    summary += "\n实际操作依据：" + membershipText(b["reason"])
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["employeeId": employeeID, "action": action, "area": area, "search": search, "before": row?.object ?? [:], "confirmation": summary], body = try membershipData(b)
    guard body.count <= 8192 else { throw CatalogError("操作说明超过接口大小限制") }
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: contactPermission(action), steps: [.init(path: contactGovernanceRoot + "/" + action, body: body, keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["contactGovernance": proof]))])
  }
}
func contactPolicySummary(_ raw: [String: Any]) throws -> String {
  guard let name = contactResourceKinds.first(where: { $0.0 == raw["resourceKind"] as? String })?.1 else { throw StaffAPIError.invalid }
  return name + "\n目的结束后保留 \(try couponPolicyInteger(raw["retentionDaysAfterPurposeEnd"], 0...36500)) 天\n依据：" + (try annualText(raw["legalBasisReference"], min: 3, max: 500))
}
extension LiveCommand.Step { var contactGovernanceProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["contactGovernance"] as? [String: Any] } }
func validContactGovernanceSelection(command: LiveCommand, board: ContactGovernanceBoard, actor: StaffIdentity) -> Bool {
  guard command.steps.count == 1, let s = command.steps.first, let p = s.contactGovernanceProof, let action = p["action"] as? String, contactActions[action] != nil, p["area"] as? String == board.area, p["search"] as? String == board.search, command.employeeID == actor.employee.id, p["employeeId"] as? String == actor.employee.id, board.employeeID == actor.employee.id, board.enabled, actor.allows("privacy.contact.retention.view"), actor.allows(contactPermission(action)), command.permission == contactPermission(action), s.path == contactGovernanceRoot + "/" + action, s.keyHeader == "idempotency-key", s.key == "native-business-" + command.id else { return false }
  if action == "draft" { return board.area == "policies" }
  guard let before = p["before"] as? [String: Any] else { return false }
  return board.rows.contains { $0.id == s.object[action == "hold" ? "resourcePublicId" : "publicId"] as? String && membershipEqual($0.object, before) && board.actions(actor: actor, row: $0).contains(action) }
}
func validateContactGovernanceReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let p = step.contactGovernanceProof, let action = p["action"] as? String, contactActions[action] != nil, step.path == contactGovernanceRoot + "/" + action, step.keyHeader == "idempotency-key", step.key.hasPrefix("native-business-"), UUID(uuidString: String(step.key.dropFirst(16))) != nil, d["employeeId"] as? String == p["employeeId"] as? String, d["requestKey"] as? String == step.key, d["action"] as? String == action, let accepted = d["accepted"] as? [String: Any], membershipEqual(accepted, step.object), let raw = d["row"] as? [String: Any], let before = p["before"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); let row = try ContactGovernanceRecord(raw), body = step.object
  try validateContactRecord(row, area: ["hold", "release"].contains(action) ? "holds" : "policies")
  func equal(_ key: String, _ expected: [String: Any]) -> Bool { membershipEqual(["v": raw[key] ?? NSNull()], ["v": expected[key] ?? NSNull()]) }
  if ["draft", "approve", "publish"].contains(action) {
    let expected = action == "draft" ? body : before
    guard ["resourceKind", "retentionDaysAfterPurposeEnd", "legalBasisReference"].allSatisfy({ equal($0, expected) }), row.text("status") == ["draft": "draft", "approve": "approved", "publish": "published"][action] else { throw CatalogError("保留策略回执的期限、依据或状态不匹配") }
    if action == "draft" { guard row.text("draftedByEmployeeId") == p["employeeId"] as? String, row.text("draftReason") == body["reason"] as? String else { throw StaffAPIError.invalid } }
    else { guard row.id == body["publicId"] as? String, equal("version", before), equal("draftedByEmployeeId", before), equal("draftReason", before) else { throw StaffAPIError.invalid } }
    if action == "approve" { guard row.text("approvedByEmployeeId") == p["employeeId"] as? String, row.text("approvalReason") == body["reason"] as? String else { throw StaffAPIError.invalid } }
    if action == "publish" { guard row.text("publishedByEmployeeId") == p["employeeId"] as? String, row.text("publicationReason") == body["reason"] as? String, equal("approvedByEmployeeId", before), assignmentDate(row.text("effectiveFrom")) == assignmentDate(membershipText(body["effectiveFrom"])) else { throw StaffAPIError.invalid } }
  } else if action == "hold" {
    guard ["resourceKind", "resourcePublicId", "legalBasisReference", "reason"].allSatisfy({ equal($0, body) }), row.text("status") == "active", row.text("createdByEmployeeId") == p["employeeId"] as? String, (raw["holdUntil"] is NSNull) == (body["holdUntil"] is NSNull), body["holdUntil"] is NSNull || assignmentDate(row.text("holdUntil")) == assignmentDate(membershipText(body["holdUntil"])) else { throw CatalogError("法定保留回执的原对象、依据或期限不匹配") }
  } else {
    guard row.id == body["publicId"] as? String, row.text("status") == "released", row.text("releasedByEmployeeId") == p["employeeId"] as? String, row.text("releaseReason") == body["reason"] as? String, ["resourceKind", "resourcePublicId", "legalBasisReference", "reason", "createdByEmployeeId"].allSatisfy({ equal($0, before) }), (raw["holdUntil"] is NSNull) == (before["holdUntil"] is NSNull), before["holdUntil"] is NSNull || assignmentDate(row.text("holdUntil")) == assignmentDate(membershipText(before["holdUntil"])) else { throw CatalogError("释放回执不是原保留对象或原依据") }
  }
}
