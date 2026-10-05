import Foundation
import CryptoKit

enum CouponPolicyKind: String, CaseIterable, Identifiable {
  case calendar, stacking
  var id: String { rawValue }
  var root: String { "/api/staff/native-" + (self == .calendar ? "coupon-calendars" : "stacking-policies") }
  var title: String { self == .calendar ? "券使用日历" : "优惠叠加与价格试算" }
  var previewPermission: String { self == .calendar ? "loyalty.configuration.view" : "loyalty.configuration.preview" }
}
let couponPolicyStatuses = ["draft": "草稿", "approved": "已审批待发布", "published": "已发布", "stopped": "已停发"]
let couponPolicyDecisions = ["approve": "独立审批", "publish": "独立发布", "stop_issuing": "停止新发券"]
struct CouponPolicyRecord: Identifiable, Equatable {
  let data: Data
  init(_ value: [String: Any]) throws { data = try membershipData(value) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
}
func couponPolicyInteger(_ value: Any?, _ range: ClosedRange<Int>) throws -> Int {
  let n = try walletInteger(value); guard range.contains(n) else { throw CatalogError("规则中的整数超出允许范围") }; return n
}
func couponPolicyReason(_ text: String) throws -> String {
  let result = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard (2...500).contains(result.utf16.count) else { throw CatalogError("请填写2至500字实际操作原因") }; return result
}
func couponPolicyCode(_ text: String) throws -> String {
  let result = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard result.range(of: "^[A-Z][A-Z0-9_]{1,39}$", options: .regularExpression) != nil else { throw CatalogError("规则编号须为2至40位大写字母、数字或下划线") }; return result
}
func couponPolicyCursor(_ text: String, kind: CouponPolicyKind) throws {
  if text.isEmpty { return }
  if kind == .stacking { guard UUID(uuidString: text) != nil else { throw StaffAPIError.invalid }; return }
  guard text.count <= 300, text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
  let standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  guard let data = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)),
    let cursor = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(cursor.keys) == ["at", "id"],
    let id = cursor["id"] as? String, UUID(uuidString: id) != nil, let at = cursor["at"] as? String, assignmentDate(at) != nil else { throw StaffAPIError.invalid }
}
func couponPolicyContent(_ row: [String: Any], kind: CouponPolicyKind) throws -> [String: Any] {
  if kind == .stacking { guard let p = row["policy"] as? [String: Any] else { throw StaffAPIError.invalid }; return ["policy": try stackingPolicy(p)] }
  guard let rule = row["rule"] as? [String: Any], let limits = row["limits"] as? [String: Any] else { throw StaffAPIError.invalid }
  return ["rule": try couponCalendarRule(rule), "limits": try couponCalendarLimits(limits)]
}
func couponPolicyFingerprint(_ row: [String: Any], kind: CouponPolicyKind) throws -> String {
  SHA256.hash(data: try membershipData(couponPolicyContent(row, kind: kind))).map { String(format: "%02x", $0) }.joined()
}
func couponPolicyValidateRow(_ row: CouponPolicyRecord, kind: CouponPolicyKind) throws {
  guard UUID(uuidString: row.id) != nil, UUID(uuidString: row.text("createdByEmployeeId")) != nil,
    couponPolicyStatuses[row.text("status")] != nil, let decisions = row.object["decisions"] as? [[String: Any]] else { throw StaffAPIError.invalid }
  _ = try couponPolicyCode(row.text("code")); _ = try couponPolicyInteger(row.object["version"], 1...2_147_483_647)
  _ = try couponPolicyContent(row.object, kind: kind)
  for d in decisions { guard couponPolicyDecisions[membershipText(d["action"])] != nil, UUID(uuidString: membershipText(d["employeeId"])) != nil else { throw StaffAPIError.invalid } }
  let actions = decisions.map { membershipText($0["action"]) }
  guard Set(actions).count == actions.count else { throw StaffAPIError.invalid }
  let actual = actions.contains("stop_issuing") ? "stopped" : actions.contains("publish") ? "published" : actions.contains("approve") ? "approved" : "draft"
  guard actual == row.text("status"), !actions.contains("publish") || actions.contains("approve"), !actions.contains("stop_issuing") || actions.contains("publish") else { throw StaffAPIError.invalid }
}
struct CouponPolicyBoard {
  let kind: CouponPolicyKind
  let employeeID: String
  let enabled: Bool
  let search: String
  let rows: [CouponPolicyRecord]
  let nextCursor: String?
  init(kind: CouponPolicyKind, data: Data, actor: StaffIdentity, search: String = "") throws {
    let d = try walletEnvelope(data)
    guard actor.allows("loyalty.configuration.view"), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, let items = d["rows"] as? [[String: Any]], items.count <= 30 else { throw StaffAPIError.invalid }
    self.kind = kind; employeeID = actor.employee.id; enabled = try walletBoolean(d["durableCommands"])
    self.search = search.trimmingCharacters(in: .whitespacesAndNewlines); guard self.search.utf16.count <= 40 else { throw StaffAPIError.invalid }
    rows = try items.map(CouponPolicyRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows { try couponPolicyValidateRow(row, kind: kind) }
    if d["next"] is NSNull { nextCursor = nil } else { guard let cursor = d["next"] as? String, !cursor.isEmpty else { throw StaffAPIError.invalid }; try couponPolicyCursor(cursor, kind: kind); nextCursor = cursor }
  }
  static func query(kind: CouponPolicyKind, search: String = "", cursor: String = "") throws -> String {
    let text = search.trimmingCharacters(in: .whitespacesAndNewlines); guard text.utf16.count <= 40 else { throw CatalogError("规则编号查询不超过40字") }; try couponPolicyCursor(cursor, kind: kind)
    var parts = URLComponents(); var q = [URLQueryItem(name: "search", value: text)]
    if !cursor.isEmpty { q.append(URLQueryItem(name: "cursor", value: cursor)) }; parts.queryItems = q
    return kind.root + "?" + (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
  func command(actor: StaffIdentity, action: String, body input: [String: Any], row: CouponPolicyRecord? = nil, now: Date = Date()) throws -> LiveCommand {
    guard ["save", "decision"].contains(action), enabled, employeeID == actor.employee.id, actor.allows("loyalty.configuration.view"), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("请重新读取规则并确认当前权限") }
    var body = input; body["reason"] = try couponPolicyReason(membershipText(input["reason"]))
    let permission = action == "save" ? "loyalty.configuration.edit" : membershipText(body["action"]) == "approve" ? "loyalty.configuration.approve" : "loyalty.policy.publish"
    guard actor.allows(permission) else { throw CatalogError("当前岗位不能执行此规则操作") }
    if let row { guard rows.contains(row) else { throw CatalogError("原规则版本已变化，请重新读取") } }
    var before: [String: Any] = [:], title: String
    if action == "save" {
      let content = try couponPolicyContent(body, kind: kind)
      guard Set(body.keys) == (kind == .calendar ? ["code", "expectedVersion", "rule", "limits", "reason"] : ["code", "expectedVersion", "policy", "reason"]) else { throw StaffAPIError.invalid }
      body["code"] = try couponPolicyCode(membershipText(body["code"])); let version = try couponPolicyInteger(body["expectedVersion"], 0...2_147_483_646)
      if version > 0 {
        guard let row, row.text("code") == body["code"] as? String, try row.integer("version") == version else { throw CatalogError("修订必须绑定读取的原编号和版本") }
        if kind == .calendar, let old = row.object["rule"] as? [String: Any], let rule = content["rule"] as? [String: Any] {
          for k in ["dateBasis", "businessDayStartMinute", "weekStartsOn"] { guard membershipEqual(["value": old[k] ?? NSNull()], ["value": rule[k] ?? NSNull()]) else { throw CatalogError("同编号的换日口径与周起点不可改写，请使用新编号") } }
        }
      } else { guard !rows.contains(where: { $0.text("code") == body["code"] as? String }) else { throw CatalogError("此编号已有版本，请先读取原规则再修订") } }
      for (k, v) in content { body[k] = v }
      title = "保存 \(membershipText(body["code"])) 的第\(version + 1)版草稿"
    } else {
      guard Set(body.keys) == ["versionId", "expectedStatus", "action", "reason"], let row,
        body["versionId"] as? String == row.id, body["expectedStatus"] as? String == row.text("status"),
        let decision = body["action"] as? String, couponPolicyDecisions[decision] != nil,
        row.text("status") == ["approve": "draft", "publish": "approved", "stop_issuing": "published"][decision] else { throw CatalogError("原规则状态不能进行此操作，请重新读取") }
      if decision != "stop_issuing" { guard row.text("createdByEmployeeId") != employeeID else { throw CatalogError("编辑人不能审批或发布本人规则") } }
      if decision == "publish" { guard !(row.object["decisions"] as! [[String: Any]]).contains(where: { $0["action"] as? String == "approve" && $0["employeeId"] as? String == employeeID }) else { throw CatalogError("发布人与审批人必须不同") } }
      title = couponPolicyDecisions[decision]! + " · " + row.text("code") + " 第" + row.text("version") + "版"
    }
    if let row { before = ["id": row.id, "code": row.text("code"), "version": try row.integer("version"), "status": row.text("status"), "createdByEmployeeId": row.text("createdByEmployeeId"), "contentSHA256": try couponPolicyFingerprint(row.object, kind: kind)] }
    let summarySource = action == "save" ? body : row!.object
    let summary = try couponPolicySummary(summarySource, kind: kind)
    let confirmation = title + "\n" + summary + "\n新草稿须由不同员工审批和发布。停发只停止后续绑定，已发券保留原规则。\n原因：" + membershipText(body["reason"])
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["kind": kind.rawValue, "action": action, "employeeId": employeeID, "search": search, "before": before, "confirmation": confirmation]
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: kind.root + "/" + action, body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["couponPolicy": proof]))])
  }
}
extension LiveCommand.Step { var couponPolicyProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["couponPolicy"] as? [String: Any] } }
func validCouponPolicySelection(command: LiveCommand, board: CouponPolicyBoard, actor: StaffIdentity) -> Bool {
  guard let step = command.steps.first, let p = step.couponPolicyProof, command.steps.count == 1, command.employeeID == actor.employee.id,
    p["employeeId"] as? String == actor.employee.id, actor.allows(command.permission), actor.allows("loyalty.configuration.view"), board.employeeID == actor.employee.id, board.enabled,
    p["kind"] as? String == board.kind.rawValue, let before = p["before"] as? [String: Any] else { return false }
  if before.isEmpty { return p["action"] as? String == "save" && (try? walletInteger(step.object["expectedVersion"])) == 0 && !board.rows.contains(where: { $0.text("code") == step.object["code"] as? String }) }
  return board.rows.contains { $0.id == before["id"] as? String && $0.text("status") == before["status"] as? String && (try? $0.integer("version")) == before["version"] as? Int && (try? couponPolicyFingerprint($0.object, kind: board.kind)) == before["contentSHA256"] as? String }
}
func validateCouponPolicyReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1,
    let d = root["data"] as? [String: Any], let p = step.couponPolicyProof, let kind = CouponPolicyKind(rawValue: membershipText(p["kind"])), let action = p["action"] as? String,
    step.path == kind.root + "/" + action, d["employeeId"] as? String == p["employeeId"] as? String, d["action"] as? String == action, d["requestKey"] as? String == step.key,
    let raw = d["row"] as? [String: Any], let before = p["before"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); let row = try CouponPolicyRecord(raw), body = step.object; try couponPolicyValidateRow(row, kind: kind)
  if action == "save" {
    guard row.text("code") == body["code"] as? String, try row.integer("version") == walletInteger(body["expectedVersion"]) + 1,
      row.text("status") == "draft", row.text("createdByEmployeeId") == p["employeeId"] as? String,
      try couponPolicyFingerprint(raw, kind: kind) == couponPolicyFingerprint(body, kind: kind) else { throw CatalogError("回执的规则、次数或金额与原请求不一致") }
  } else {
    guard action == "decision", let decision = body["action"] as? String, row.id == body["versionId"] as? String,
      row.text("status") == ["approve": "approved", "publish": "published", "stop_issuing": "stopped"][decision],
      row.text("code") == before["code"] as? String, try row.integer("version") == walletInteger(before["version"]), row.text("createdByEmployeeId") == before["createdByEmployeeId"] as? String,
      try couponPolicyFingerprint(raw, kind: kind) == before["contentSHA256"] as? String,
      (raw["decisions"] as! [[String: Any]]).contains(where: { $0["action"] as? String == decision && $0["employeeId"] as? String == p["employeeId"] as? String }) else { throw CatalogError("回执的原规则版本或独立决定不一致") }
  }
}
func couponPolicySummary(_ row: [String: Any], kind: CouponPolicyKind) throws -> String {
  if kind == .calendar { return try couponCalendarSummary(row) }; guard let p = row["policy"] as? [String: Any] else { throw StaffAPIError.invalid }; return try stackingPolicySummary(p)
}
