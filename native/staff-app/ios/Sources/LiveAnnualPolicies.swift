import Foundation
import CryptoKit

let annualPolicyRoot = "/api/staff/native-annual-policies"
let annualKinds = [("birthday", "生日礼遇"), ("festival", "节日礼遇"), ("priority_seating", "优先订座"), ("daily_snack", "每日点心")]
let annualTiers = [("member", "普通会员"), ("silver", "银卡"), ("gold", "金卡")]
let annualAlcohol = [("not_applicable", "不涉及酒水"), ("non_alcoholic_only", "仅无酒精"), ("staff_compliance_required", "员工核验并配替代品")]
let annualInventory = [("not_applicable", "无需库存"), ("strict_recipe", "正式配方严格扣库")]
let annualRevocation = [("cancel_before_redeem", "核销前可取消"), ("expire_only", "仅到期失效"), ("manual_compensation", "人工补偿")]
let annualFeb = [("feb28", "2月28日"), ("mar01", "3月1日"), ("leap_year_only", "仅闰年")]
let annualNumeric = [("quantity", "份数（1至100）"), ("validityDays", "有效天数（1至366）"), ("windowBeforeDays", "提前可用天数（0至90）"), ("windowAfterDays", "延后可用天数（0至90）"), ("memberDailyLimit", "会员每日上限（1至100）"), ("tableDailyLimit", "每桌每日上限（1至100）"), ("priority", "优先级（1至32767，越小越优先）")]
let annualBooleans = [("inheritToHigherTiers", "高等级继承"), ("onSiteOnly", "仅到店使用"), ("requiresTableSession", "必须关联桌次"), ("enabled", "启用此规则")]
let annualActions = ["draft": "保存年度权益草稿", "approve": "独立审批年度权益", "publish": "第三人发布年度权益", "occurrence": "确认节日日期"]
let annualStatuses = ["draft": "待独立审批", "approved": "已审批待发布", "published": "已发布（按生效时间执行）"]
func annualPermission(_ action: String) -> String { "loyalty.annual-benefit." + (["draft": "manage", "approve": "approve", "publish": "publish", "occurrence": "occurrence.confirm"][action] ?? "invalid") }
func annualCode(_ raw: String) throws -> String {
  guard raw.range(of: "^[A-Z][A-Z0-9_]{2,63}$", options: .regularExpression) != nil else { throw CatalogError("编号须为3至64位大写字母、数字或下划线，并以字母开头") }; return raw
}
func annualText(_ value: Any?, min: Int = 2, max: Int) throws -> String {
  guard let raw = value as? String else { throw StaffAPIError.invalid }; let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard (min...max).contains(text.utf16.count) else { throw CatalogError("请核对文本长度（\(min)至\(max)字）") }; return text
}
func annualTimezone(_ value: Any?) throws -> String {
  let zone = try annualText(value, min: 3, max: 64)
  guard zone.range(of: "^[A-Za-z_]+/[A-Za-z_]+(?:/[A-Za-z_]+)?$", options: .regularExpression) != nil, TimeZone(identifier: zone) != nil else { throw CatalogError("请填写有效地区时区，例如 Asia/Shanghai") }; return zone
}
func newAnnualRule() -> [String: Any] {
  ["ruleCode": "", "title": "", "ruleKind": "birthday", "eligibleTier": "member", "benefitDefinitionId": "", "inheritToHigherTiers": true, "onSiteOnly": true, "requiresTableSession": true, "enabled": true, "quantity": 1, "validityDays": 7, "windowBeforeDays": 0, "windowAfterDays": 6, "memberDailyLimit": 1, "tableDailyLimit": 1, "priority": 10, "alcoholHandling": "not_applicable", "stackGroup": "festival_gift", "inventoryRequirement": "not_applicable", "revocationPolicy": "expire_only", "feb29Policy": "feb28", "reservationHoldMinutes": NSNull(), "redemptionHoldMinutes": NSNull(), "substitutes": [[String: Any]]()]
}
func normalizeAnnualRule(_ raw: [String: Any]) throws -> [String: Any] {
  var r: [String: Any] = [:]
  r["ruleCode"] = try annualCode(annualText(raw["ruleCode"], min: 3, max: 64)); r["title"] = try annualText(raw["title"], max: 120)
  let group = try annualText(raw["stackGroup"], max: 64)
  guard group.range(of: "^[a-z][a-z0-9_.-]{1,63}$", options: .regularExpression) != nil, UUID(uuidString: membershipText(raw["benefitDefinitionId"])) != nil else { throw CatalogError("请选择原权益定义并核对叠加组编号") }
  r["stackGroup"] = group; r["benefitDefinitionId"] = raw["benefitDefinitionId"]
  for (key, _) in annualNumeric {
    let range: ClosedRange<Int> = key.hasPrefix("window") ? 0...90 : key == "validityDays" ? 1...366 : key == "priority" ? 1...32767 : 1...100
    r[key] = try couponPolicyInteger(raw[key], range)
  }
  for (key, _) in annualBooleans { r[key] = try walletBoolean(raw[key]) }
  for (key, choices) in [("ruleKind", annualKinds), ("eligibleTier", annualTiers), ("alcoholHandling", annualAlcohol), ("inventoryRequirement", annualInventory), ("revocationPolicy", annualRevocation)] {
    guard let v = raw[key] as? String, choices.contains(where: { $0.0 == v }) else { throw CatalogError("请核对礼遇类型及履约规则") }; r[key] = v
  }
  let kind = r["ruleKind"] as! String
  if kind == "birthday" { guard let feb = raw["feb29Policy"] as? String, annualFeb.contains(where: { $0.0 == feb }) else { throw CatalogError("生日规则必须明确2月29日处理方式") }; r["feb29Policy"] = feb }
  else { guard raw["feb29Policy"] is NSNull else { throw StaffAPIError.invalid }; r["feb29Policy"] = NSNull() }
  if ["birthday", "festival"].contains(kind), group != "festival_gift" { throw CatalogError("生日和节日使用同一 festival_gift 叠加组") }
  for (key, target) in [("reservationHoldMinutes", "priority_seating"), ("redemptionHoldMinutes", "daily_snack")] {
    if kind == target { r[key] = try couponPolicyInteger(raw[key], 5...30) }
    else { guard raw[key] is NSNull else { throw StaffAPIError.invalid }; r[key] = NSNull() }
  }
  guard let subs = raw["substitutes"] as? [[String: Any]], subs.count <= 20, Set(subs.map { membershipText($0["productId"]) }).count == subs.count else { throw CatalogError("替代品最多20种且不得重复") }
  r["substitutes"] = try subs.map { sub -> [String: Any] in
    guard UUID(uuidString: membershipText(sub["productId"])) != nil else { throw StaffAPIError.invalid }
    return ["productId": sub["productId"]!, "priority": try couponPolicyInteger(sub["priority"], 1...32767), "reason": try annualText(sub["reason"], max: 240)]
  }
  if kind == "priority_seating" { guard r["onSiteOnly"] as? Bool == false, r["requiresTableSession"] as? Bool == false, r["inventoryRequirement"] as? String == "not_applicable", subs.isEmpty else { throw CatalogError("优先订座不能要求已经到店、开台或扣商品库存") } }
  if kind == "daily_snack" { guard r["onSiteOnly"] as? Bool == true, r["requiresTableSession"] as? Bool == true, r["alcoholHandling"] as? String == "not_applicable", r["inventoryRequirement"] as? String == "strict_recipe", r["validityDays"] as? Int == 1, r["windowBeforeDays"] as? Int == 0, r["windowAfterDays"] as? Int == 0, (r["quantity"] as! Int) <= min(r["memberDailyLimit"] as! Int, r["tableDailyLimit"] as! Int) else { throw CatalogError("每日点心须当天到店并关联桌次，正式扣库且份数不超过每日上限") } }
  return r
}
func annualRules(_ raw: Any?, requireEnabled: Bool = false) throws -> [[String: Any]] {
  guard let input = raw as? [[String: Any]], (1...100).contains(input.count) else { throw CatalogError("政策必须包含1至100条完整规则") }
  let rules = try input.map(normalizeAnnualRule)
  guard Set(rules.map { $0["ruleCode"] as! String }).count == rules.count, (!requireEnabled || rules.contains(where: { $0["enabled"] as? Bool == true })) else { throw CatalogError("规则编号不得重复，至少启用一条规则") }
  let enabled = rules.filter { $0["enabled"] as? Bool == true }
  guard enabled.filter({ $0["ruleKind"] as? String == "priority_seating" }).count <= 1 else { throw CatalogError("同一政策只能启用一条优先订座规则") }
  if let birthday = enabled.filter({ $0["ruleKind"] as? String == "birthday" }).map({ $0["priority"] as! Int }).max(), let festival = enabled.filter({ $0["ruleKind"] as? String == "festival" }).map({ $0["priority"] as! Int }).min(), birthday >= festival { throw CatalogError("生日规则必须比全部节日规则优先") }
  return rules
}
struct AnnualPolicyRecord: Identifiable, Equatable {
  let data: Data
  init(_ raw: [String: Any]) throws { data = try membershipData(raw) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  var rules: [[String: Any]] { object["rules"] as? [[String: Any]] ?? [] }
}
func annualValidateRow(_ row: AnnualPolicyRecord) throws {
  guard UUID(uuidString: row.id) != nil, row.text("nativeVersion").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, annualStatuses[row.text("status")] != nil, UUID(uuidString: row.text("draftedByEmployeeId")) != nil else { throw StaffAPIError.invalid }
  _ = try annualCode(row.text("policyCode")); _ = try couponPolicyInteger(row.object["version"], 1...2_147_483_647); _ = try annualTimezone(row.object["timezone"]); _ = try annualRules(row.object["rules"])
  guard Set(row.rules.map { membershipText($0["id"]) }).count == row.rules.count else { throw StaffAPIError.invalid }
  for rule in row.rules { guard UUID(uuidString: membershipText(rule["id"])) != nil, rule["policyVersionId"] as? String == row.id else { throw StaffAPIError.invalid } }
  if row.text("status") != "draft" { guard UUID(uuidString: row.text("approvedByEmployeeId")) != nil, row.text("approvedByEmployeeId") != row.text("draftedByEmployeeId") else { throw StaffAPIError.invalid } }
  if row.text("status") == "published" { guard UUID(uuidString: row.text("publishedByEmployeeId")) != nil, ![row.text("draftedByEmployeeId"), row.text("approvedByEmployeeId")].contains(row.text("publishedByEmployeeId")), let from = assignmentDate(row.text("effectiveFrom")), row.object["effectiveUntil"] is NSNull || assignmentDate(row.text("effectiveUntil")).map({ $0 > from }) == true else { throw StaffAPIError.invalid } }
}
func annualEnvelope(_ data: Data, actor: StaffIdentity) throws -> [String: Any] {
  guard actor.allows("loyalty.annual-benefit.view"), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let d = root["data"] as? [String: Any], d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1, try walletBoolean(d["durableCommands"]) else { throw CatalogError("当前员工或年度权益接口不可用，请重新读取") }; return d
}
func annualURL(_ path: String = "", _ values: [(String, String)]) throws -> String {
  var parts = URLComponents(); parts.queryItems = values.filter { !$0.1.isEmpty }.map { URLQueryItem(name: $0.0, value: $0.1) }
  let query = (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  return annualPolicyRoot + path + (query.isEmpty ? "" : "?" + query)
}
struct AnnualPolicyBoard {
  let employeeID: String, enabled: Bool, code: String, cursor: String
  let latest: Int?, rows: [AnnualPolicyRecord], nextCursor: String?
  static func query(code: String = "", cursor: String = "") throws -> String {
    if !code.isEmpty { _ = try annualCode(code) }; if !cursor.isEmpty, UUID(uuidString: cursor) == nil { throw StaffAPIError.invalid }
    return try annualURL("", [("code", code), ("cursor", cursor)])
  }
  init(data: Data, actor: StaffIdentity, code: String = "", cursor: String = "") throws {
    _ = try Self.query(code: code, cursor: cursor); let d = try annualEnvelope(data, actor: actor)
    guard (d["code"] is NSNull && code.isEmpty) || d["code"] as? String == code, let raw = d["rows"] as? [[String: Any]], raw.count <= 20 else { throw StaffAPIError.invalid }
    self.code = code; self.cursor = cursor; employeeID = actor.employee.id; enabled = true
    latest = code.isEmpty ? nil : try couponPolicyInteger(d["latest"], 0...2_147_483_646)
    rows = try raw.map(AnnualPolicyRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows { try annualValidateRow(row); guard code.isEmpty || row.text("policyCode") == code, (try (latest == nil || walletInteger(row.object["version"]) <= latest!)) else { throw StaffAPIError.invalid } }
    nextCursor = d["next"] as? String
    guard d["next"] is NSNull || nextCursor.map({ UUID(uuidString: $0) != nil }) == true else { throw StaffAPIError.invalid }
  }
  func command(actor: StaffIdentity, action: String, body input: [String: Any], row: AnnualPolicyRecord? = nil, now: Date = Date()) throws -> LiveCommand {
    guard let title = annualActions[action], enabled, employeeID == actor.employee.id, actor.allows("loyalty.annual-benefit.view"), actor.allows(annualPermission(action)), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("请刷新原政策并确认当前权限") }
    var body = input; body["reason"] = try annualText(body["reason"], max: 500)
    if action == "draft" {
      guard !code.isEmpty, let latest, input["policyCode"] as? String == code, Set(input.keys) == ["policyCode", "timezone", "rules", "reason"] else { throw CatalogError("起草前须读取同编号最新版本") }
      body["expectedLatest"] = latest; body["timezone"] = try annualTimezone(input["timezone"]); body["rules"] = try annualRules(input["rules"], requireEnabled: true)
    } else {
      guard let row, rows.contains(row) else { throw CatalogError("原政策版本已变化，请重新读取") }
      body["policyId"] = row.id; body["expectedVersion"] = row.text("nativeVersion")
      if action == "approve" { guard Set(input.keys) == ["reason"], row.text("status") == "draft", row.text("draftedByEmployeeId") != employeeID else { throw CatalogError("草稿须由另一位授权员工独立审批") } }
      if action == "publish" {
        guard Set(input.keys) == ["reason", "effectiveFrom", "effectiveUntil"], row.text("status") == "approved", ![row.text("draftedByEmployeeId"), row.text("approvedByEmployeeId")].contains(employeeID), let from = assignmentDate(membershipText(body["effectiveFrom"])), from > now, body["effectiveUntil"] is NSNull || assignmentDate(membershipText(body["effectiveUntil"])).map({ $0 > from }) == true else { throw CatalogError("发布必须由第三位员工安排未来生效，截止须晚于生效") }
      }
      if action == "occurrence" {
        guard Set(input.keys) == ["reason", "ruleId", "cycleYear", "startsOn", "endsOn", "confirmationReference"], row.rules.contains(where: { $0["id"] as? String == body["ruleId"] as? String && $0["ruleKind"] as? String == "festival" && $0["enabled"] as? Bool == true }) else { throw CatalogError("只能确认当前原版本启用的节日规则") }
        let year = try couponPolicyInteger(body["cycleYear"], 2020...2200), start = try couponCalendarDay(membershipText(body["startsOn"])), end = try couponCalendarDay(membershipText(body["endsOn"]))
        guard start <= end, membershipText(body["startsOn"]).hasPrefix(String(year) + "-"), membershipText(body["endsOn"]).hasPrefix(String(year) + "-") else { throw CatalogError("开始与结束必须在所填同一自然年，且结束不早于开始") }
        body["cycleYear"] = year; body["confirmationReference"] = try annualText(body["confirmationReference"], max: 240)
      }
    }
    var summarySource = action == "draft" ? body : row!.object
    if action == "draft" { summarySource["rules"] = input["rules"] }
    let summary = try annualPolicySummary(summarySource)
    var confirmation = title + "\n" + summary
    if action == "publish" { confirmation += "\n计划生效：" + (try membershipLocal(membershipText(body["effectiveFrom"]))) + "\n截止：" + (body["effectiveUntil"] is NSNull ? "长期" : try membershipLocal(membershipText(body["effectiveUntil"]))) }
    if action == "occurrence" { confirmation += "\n节日规则：" + (row!.rules.first { $0["id"] as? String == body["ruleId"] as? String }?["title"] as? String ?? "") + "\n" + membershipText(body["startsOn"]) + " 至 " + membershipText(body["endsOn"]) + "\n依据：" + membershipText(body["confirmationReference"]) }
    confirmation += "\n操作原因：" + membershipText(body["reason"]) + "\n生日本人授权、现场核验及库存条件仍按原规则执行；配置保存不代表已经发放。"
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["employeeId": employeeID, "action": action, "code": code, "before": row?.object ?? [:], "confirmation": confirmation]
    let data = try membershipData(body); guard data.count <= 262144 else { throw CatalogError("规则内容超过接口大小限制") }
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: annualPermission(action), steps: [.init(path: annualPolicyRoot + "/" + action, body: data, keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["annualPolicy": proof]))])
  }
}
extension LiveCommand.Step { var annualPolicyProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["annualPolicy"] as? [String: Any] } }
func validAnnualPolicySelection(command: LiveCommand, board: AnnualPolicyBoard, actor: StaffIdentity) -> Bool {
  guard command.steps.count == 1, let s = command.steps.first, let p = s.annualPolicyProof, let action = p["action"] as? String, annualActions[action] != nil, command.employeeID == actor.employee.id, p["employeeId"] as? String == actor.employee.id, board.employeeID == actor.employee.id, board.enabled, board.code == p["code"] as? String, actor.allows("loyalty.annual-benefit.view"), command.permission == annualPermission(action), actor.allows(command.permission), s.path == annualPolicyRoot + "/" + action, s.key == "native-business-" + command.id, s.keyHeader == "idempotency-key" else { return false }
  if action == "draft" { return s.object["policyCode"] as? String == board.code && (try? walletInteger(s.object["expectedLatest"])) == board.latest }
  guard let before = p["before"] as? [String: Any] else { return false }
  return board.rows.contains { $0.id == s.object["policyId"] as? String && $0.text("nativeVersion") == s.object["expectedVersion"] as? String && membershipEqual($0.object, before) }
}
func annualComparable(_ raw: [String: Any]) throws -> Data {
  var r = try normalizeAnnualRule(raw); r["substitutes"] = (r["substitutes"] as! [[String: Any]]).sorted { membershipText($0["productId"]) < membershipText($1["productId"]) }; return try membershipData(r)
}
func validateAnnualPolicyReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let p = step.annualPolicyProof, let action = p["action"] as? String, annualActions[action] != nil, step.path == annualPolicyRoot + "/" + action, step.keyHeader == "idempotency-key", step.key.hasPrefix("native-business-"), UUID(uuidString: String(step.key.dropFirst(16))) != nil, d["employeeId"] as? String == p["employeeId"] as? String, d["requestKey"] as? String == step.key, d["action"] as? String == action, let accepted = d["accepted"] as? [String: Any], membershipEqual(accepted, step.object), let raw = d["row"] as? [String: Any], UUID(uuidString: membershipText(raw["id"])) != nil else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); let body = step.object
  if action == "occurrence" {
    for (k, v) in body { guard membershipEqual(["v": v], ["v": raw[k] ?? NSNull()]) else { throw CatalogError("节日回执不是原规则、日期或依据") } }
    guard raw["confirmedByEmployeeId"] as? String == p["employeeId"] as? String, assignmentDate(membershipText(raw["confirmedAt"])) != nil else { throw StaffAPIError.invalid }; return
  }
  let row = try AnnualPolicyRecord(raw); try annualValidateRow(row)
  guard let before = (action == "draft" ? body : p["before"]) as? [String: Any], row.text("policyCode") == before["policyCode"] as? String, row.text("timezone") == before["timezone"] as? String, let original = before["rules"] as? [[String: Any]], original.count == row.rules.count, row.text("status") == ["draft": "draft", "approve": "approved", "publish": "published"][action], row.text("reason") == body["reason"] as? String else { throw CatalogError("年度政策回执内容、状态或原因不匹配") }
  for item in row.rules { guard let old = original.first(where: { $0["ruleCode"] as? String == item["ruleCode"] as? String }), try annualComparable(old) == annualComparable(item), action == "draft" || old["id"] as? String == item["id"] as? String else { throw CatalogError("年度规则份数、时限或履约条件与原请求不一致") } }
  if action == "draft" { guard try walletInteger(raw["version"]) == walletInteger(body["expectedLatest"]) + 1, row.text("draftedByEmployeeId") == p["employeeId"] as? String else { throw StaffAPIError.invalid } }
  else { guard row.id == body["policyId"] as? String, try walletInteger(raw["version"]) == walletInteger(before["version"]), row.text("draftedByEmployeeId") == before["draftedByEmployeeId"] as? String, row.text(action == "approve" ? "approvedByEmployeeId" : "publishedByEmployeeId") == p["employeeId"] as? String else { throw StaffAPIError.invalid } }
  if action == "publish" { guard row.text("approvedByEmployeeId") == before["approvedByEmployeeId"] as? String, assignmentDate(row.text("effectiveFrom")) == assignmentDate(membershipText(body["effectiveFrom"])), (raw["effectiveUntil"] is NSNull) == (body["effectiveUntil"] is NSNull), body["effectiveUntil"] is NSNull || assignmentDate(row.text("effectiveUntil")) == assignmentDate(membershipText(body["effectiveUntil"])) else { throw StaffAPIError.invalid } }
}
func annualRuleSummary(_ raw: [String: Any]) throws -> String {
  let r = try normalizeAnnualRule(raw); var lines = [membershipText(r["title"]) + " · " + membershipText(r["ruleCode"])]
  for (key, label, choices) in [("ruleKind", "类型", annualKinds), ("eligibleTier", "适用等级", annualTiers), ("alcoholHandling", "酒水处理", annualAlcohol), ("inventoryRequirement", "库存要求", annualInventory), ("revocationPolicy", "撤销规则", annualRevocation)] { lines.append(label + "：" + (choices.first { $0.0 == r[key] as? String }?.1 ?? "待核对")) }
  lines.append("关联权益：" + (raw["benefitDefinitionName"] as? String ?? "正式权益") + "（" + membershipText(r["benefitDefinitionId"]) + "）")
  for (key, label) in annualNumeric { lines.append(label + "：" + membershipText(r[key])) }
  for (key, label) in annualBooleans { lines.append(label + "：" + (r[key] as? Bool == true ? "是" : "否")) }
  lines.append("叠加组：" + membershipText(r["stackGroup"]))
  if let feb = r["feb29Policy"] as? String { lines.append("2月29日生日：" + (annualFeb.first { $0.0 == feb }?.1 ?? "待核对")) }
  for (key, label) in [("reservationHoldMinutes", "优先订座保留分钟"), ("redemptionHoldMinutes", "点心暂留分钟")] { if !(r[key] is NSNull) { lines.append(label + "：" + membershipText(r[key])) } }
  for sub in r["substitutes"] as! [[String: Any]] { let name = (raw["substitutes"] as? [[String: Any]])?.first { $0["productId"] as? String == sub["productId"] as? String }?["productName"] as? String; lines.append("替代品：" + (name ?? "正式替代品") + "（" + membershipText(sub["productId"]) + "） · 优先级 " + membershipText(sub["priority"]) + " · 依据：" + membershipText(sub["reason"])) }
  return lines.joined(separator: "\n")
}
func annualPolicySummary(_ raw: [String: Any]) throws -> String {
  let rules = try annualRules(raw["rules"]); let version: Any = try raw["version"] ?? (walletInteger(raw["expectedLatest"]) + 1)
  let original = raw["rules"] as! [[String: Any]]
  return membershipText(raw["policyCode"]) + " · 第" + membershipText(version) + "版 · " + membershipText(raw["timezone"]) + "\n共\(rules.count)条完整规则（含停用项）\n" + (try original.enumerated().map { "规则\($0.offset + 1)\n" + (try annualRuleSummary($0.element)) }.joined(separator: "\n\n"))
}
struct AnnualPolicyPage {
  let rows: [AnnualPolicyRecord], nextCursor: String?
  static func optionsQuery(kind: String, search: String = "", cursor: String = "") throws -> String {
    guard ["definitions", "products"].contains(kind), search.count <= 80, cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw StaffAPIError.invalid }
    return try annualURL("/options", [("kind", kind), ("search", search), ("cursor", cursor)])
  }
  static func occurrencesQuery(ruleId: String, cursor: String = "") throws -> String {
    guard UUID(uuidString: ruleId) != nil, cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw StaffAPIError.invalid }; return try annualURL("/occurrences", [("ruleId", ruleId), ("cursor", cursor)])
  }
  init(data: Data, actor: StaffIdentity, kind: String, ruleId: String = "") throws {
    let d = try annualEnvelope(data, actor: actor)
    guard ["definitions", "products", "occurrences"].contains(kind), let raw = d["rows"] as? [[String: Any]], raw.count <= 50 else { throw StaffAPIError.invalid }
    if kind == "occurrences" { guard UUID(uuidString: ruleId) != nil, d["ruleId"] as? String == ruleId else { throw StaffAPIError.invalid } }
    rows = try raw.map(AnnualPolicyRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows {
      guard UUID(uuidString: row.id) != nil else { throw StaffAPIError.invalid }
      if kind == "occurrences" {
        let start = try couponCalendarDay(row.text("startsOn")), end = try couponCalendarDay(row.text("endsOn")), year = try couponPolicyInteger(row.object["cycleYear"], 2020...2200)
        guard row.text("ruleId") == ruleId, start <= end, row.text("startsOn").hasPrefix(String(year) + "-"), row.text("endsOn").hasPrefix(String(year) + "-"), UUID(uuidString: row.text("confirmedByEmployeeId")) != nil, assignmentDate(row.text("confirmedAt")) != nil else { throw StaffAPIError.invalid }; _ = try annualText(row.object["confirmationReference"], max: 240)
      } else { guard !row.text("name").isEmpty, row.text("status") == "active" else { throw StaffAPIError.invalid } }
    }
    nextCursor = d["next"] as? String; guard d["next"] is NSNull || nextCursor.map({ UUID(uuidString: $0) != nil }) == true else { throw StaffAPIError.invalid }
  }
}
