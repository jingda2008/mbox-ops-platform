import Foundation
let marketingRoot = "/api/staff/native-marketing"
let marketingChannels = [("wechat", "微信"), ("sms", "短信"), ("phone", "电话")]
let marketingPurposes = [("own_activities", "本店活动"), ("mbox_joint_activities", "由本店联系的联合活动")]
let marketingAreas = [("notices", "告知版本", "marketing.notice.view"), ("jobs", "联系任务", "marketing.send"), ("refusal", "记录拒绝", "marketing.refusal.record"), ("audit", "本人许可历史", "marketing.consent.audit")]
let marketingStatuses = ["draft": "待审核", "approved": "待发布", "published": "已发布", "stopped": "已停止", "queued": "等待核验", "blocked": "暂不能发送", "dispatching": "正在交给渠道", "submitted": "渠道已受理，尚未确认送达", "sent": "渠道确认送达", "unknown": "结果未知，禁止自动重发", "cancelled": "已取消", "failed": "渠道确认失败"]
let marketingJobStatuses = ["queued", "blocked", "dispatching", "submitted", "sent", "unknown", "cancelled", "failed"]
let marketingReasons = ["channel_not_configured": "渠道尚未配置", "recipient_not_verified": "收件身份尚未核实", "channel_authority_missing": "缺少渠道授权", "outside_contact_window": "不在允许联系时段", "frequency_limit": "已到联系频次上限", "previous_delivery_unknown": "此前任务结果未知", "verification_unavailable": "暂时无法核验", "consent_changed": "本人许可已变化", "notice_stopped": "告知已停用", "task_expired": "任务已过期", "sender_permission_revoked": "发起人权限已撤销", "not_consented": "没有本人许可", "consent_changed_since_queue": "排队后许可已变化", "consent_expired_or_scope_changed": "许可已过期或范围变化", "staff_cancelled": "员工已取消", "notice_unavailable": "告知不可用", "scope_not_covered": "许可不覆盖此次范围"]
let marketingActions = ["save": "保存营销告知草稿", "decision": "审核 / 发布营销告知", "refusal": "记录顾客拒绝全部营销", "queue": "建立联系任务", "cancel": "取消未发送任务"]
func marketingPermission(_ action: String, body: [String: Any]) -> String {
  if action == "save" { return "marketing.notice.edit" }; if action == "decision" { return body["decision"] as? String == "approve" ? "marketing.notice.approve" : "marketing.notice.publish" }; return action == "refusal" ? "marketing.refusal.record" : "marketing.send"
}
func marketingCustomerPermission(_ purpose: String) -> String { ["send": "marketing.send", "refusal": "marketing.refusal.record", "audit": "marketing.consent.audit"][purpose] ?? "invalid" }
func marketingDate(_ value: Any?) throws -> String {
  guard let text = value as? String, text.range(of: "(?:Z|[+-][0-9]{2}:[0-9]{2})$", options: [.regularExpression, .caseInsensitive]) != nil, let date = assignmentDate(text) else { throw CatalogError("请填写有效且包含时区的时间") }; let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter.string(from: date)
}
func marketingRule(_ input: [String: Any]) throws -> [String: Any] {
  var r: [String: Any] = [:]
  for (key, max) in [("operatorName", 200), ("operatorContact", 300), ("summary", 3000), ("withdrawalInstructions", 1000)] { r[key] = try annualText(input[key], max: max) }
  for (key, values) in [("channels", marketingChannels), ("purposes", marketingPurposes)] {
    guard let choices = input[key] as? [String], !choices.isEmpty, Set(choices).count == choices.count, choices.allSatisfy({ value in values.contains { $0.0 == value } }) else { throw CatalogError("请明确且不重复选择允许的渠道及用途") }; r[key] = choices.sorted()
  }
  guard let categories = input["dataCategories"] as? [String], (1...20).contains(categories.count), let weekdays = input["weekdays"] as? [Any], !weekdays.isEmpty, input["sharingMode"] as? String == "no_partner_list" else { throw CatalogError("须明确必要资料与可联系星期，不向合作方提供名单") }
  let names = try categories.map { try annualText($0, max: 80) }, days = try weekdays.map { try couponPolicyInteger($0, 1...7) }.sorted()
  guard Set(names).count == names.count, Set(days).count == days.count else { throw CatalogError("资料类型和可联系星期不得重复") }; r["dataCategories"] = names; r["weekdays"] = days; r["sharingMode"] = "no_partner_list"
  r["validFrom"] = try marketingDate(input["validFrom"]); r["validUntil"] = try marketingDate(input["validUntil"])
  guard assignmentDate(r["validUntil"] as! String)! > assignmentDate(r["validFrom"] as! String)! else { throw CatalogError("告知结束须晚于开始，不能无限期") }
  for (key, range) in [("consentDays", 1...3660), ("contactStartMinute", 0...1439), ("contactEndMinute", 1...1440), ("maximumPerDay", 1...100), ("maximumPerMonth", 1...1000)] { r[key] = try couponPolicyInteger(input[key], range) }
  guard (r["contactStartMinute"] as! Int) < (r["contactEndMinute"] as! Int), (r["maximumPerDay"] as! Int) <= (r["maximumPerMonth"] as! Int) else { throw CatalogError("联系时段须正序、不跨午夜；每日上限不能超过每月") }; return r
}
func marketingRuleSummary(_ raw: [String: Any]) throws -> String {
  let r = try marketingRule(raw), channels = (r["channels"] as! [String]).map { value in marketingChannels.first { $0.0 == value }!.1 }, purposes = (r["purposes"] as! [String]).map { value in marketingPurposes.first { $0.0 == value }!.1 }
  return "实际经营主体：" + membershipText(r["operatorName"]) + "\n主体联系方式：" + membershipText(r["operatorContact"]) + "\n用途与范围：" + membershipText(r["summary"]) + "\n停止方法：" + membershipText(r["withdrawalInstructions"]) + "\n允许渠道：" + channels.joined(separator: "、") + "\n允许用途：" + purposes.joined(separator: "、") + "\n必要资料：" + (r["dataCategories"] as! [String]).joined(separator: "、") + "\n告知期限：" + (try membershipLocal(r["validFrom"] as! String)) + " 至 " + (try membershipLocal(r["validUntil"] as! String)) + "\n本人许可最多 " + membershipText(r["consentDays"]) + " 天\n北京时间 " + couponCalendarClock(r["contactStartMinute"] as! Int) + " 至 " + couponCalendarClock(r["contactEndMinute"] as! Int) + "\n可联系星期：" + (r["weekdays"] as! [Int]).map(String.init).joined(separator: "、") + "\n每日上限 " + membershipText(r["maximumPerDay"]) + " 次，每月上限 " + membershipText(r["maximumPerMonth"]) + " 次\n不向独立合作方提供名单；发布告知不代替本人同意。"
}
struct MarketingRecord: Identifiable, Equatable {
  let data: Data
  init(_ raw: [String: Any]) throws { data = try membershipData(raw) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { membershipText(object[key]) }
}
func marketingEnvelope(_ data: Data, actor: StaffIdentity) throws -> [String: Any] {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let d = root["data"] as? [String: Any], d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1, try walletBoolean(d["durableCommands"]) else { throw StaffAPIError.invalid }; return d
}
func marketingURL(_ path: String, _ q: [(String, String)]) -> String { var c = URLComponents(); c.queryItems = q.filter { !$0.1.isEmpty }.map { URLQueryItem(name: $0.0, value: $0.1) }; let query = (c.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B"); return marketingRoot + "/" + path + (query.isEmpty ? "" : "?" + query) }
func marketingValidateRecord(_ row: MarketingRecord, area: String) throws {
  guard UUID(uuidString: row.id) != nil, row.text("nativeVersion").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
  if area == "notices" {
    _ = try couponPolicyCode(row.text("code")); _ = try couponPolicyInteger(row.object["version"], 1...2_147_483_647)
    guard ["draft", "approved", "published", "stopped"].contains(row.text("status")), UUID(uuidString: row.text("createdByEmployeeId")) != nil, let rule = row.object["rule"] as? [String: Any], let decisions = row.object["decisions"] as? [[String: Any]] else { throw StaffAPIError.invalid }; _ = try marketingRule(rule)
    guard Set(decisions.map { membershipText($0["action"]) }).count == decisions.count else { throw StaffAPIError.invalid }
    for d in decisions { guard ["approve", "publish", "stop"].contains(membershipText(d["action"])), UUID(uuidString: membershipText(d["employee_id"])) != nil else { throw StaffAPIError.invalid } }
    let status = decisions.contains { $0["action"] as? String == "stop" } ? "stopped" : decisions.contains { $0["action"] as? String == "publish" } ? "published" : decisions.contains { $0["action"] as? String == "approve" } ? "approved" : "draft"
    guard status == row.text("status") else { throw StaffAPIError.invalid }
    if status == "stopped" { guard decisions.contains(where: { $0["action"] as? String == "publish" }) else { throw StaffAPIError.invalid } }
    if let approver = decisions.first(where: { $0["action"] as? String == "approve" })?["employee_id"] as? String { guard approver != row.text("createdByEmployeeId") else { throw StaffAPIError.invalid } }
    if let publisher = decisions.first(where: { $0["action"] as? String == "publish" })?["employee_id"] as? String { guard let approver = decisions.first(where: { $0["action"] as? String == "approve" })?["employee_id"] as? String, ![approver, row.text("createdByEmployeeId")].contains(publisher) else { throw StaffAPIError.invalid } }
  } else if area == "jobs" {
    guard marketingJobStatuses.contains(row.text("status")), ["customerId", "noticeId", "createdByEmployeeId"].allSatisfy({ UUID(uuidString: row.text($0)) != nil }), marketingChannels.contains(where: { $0.0 == row.text("channel") }), marketingPurposes.contains(where: { $0.0 == row.text("purpose") }), row.text("campaignKey").range(of: "^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$", options: .regularExpression) != nil, assignmentDate(row.text("expiresAt")) != nil else { throw StaffAPIError.invalid }; _ = try annualText(row.object["content"], max: 2000); _ = try walletInteger(row.object["checks"])
  } else { throw StaffAPIError.invalid }
}
struct MarketingBoard {
  let employeeID: String, enabled: Bool, area: String, code: String, cursor: String
  let rows: [MarketingRecord], nextCursor: String?, latestVersion: Int?
  static func query(area: String = "notices", code: String = "", cursor: String = "") throws -> String {
    guard ["workspace", "notices", "jobs"].contains(area), cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw StaffAPIError.invalid }
    if !code.isEmpty && area == "notices" { _ = try couponPolicyCode(code) }
    return marketingURL(area, area == "workspace" ? [] : [("code", area == "notices" ? code : ""), ("cursor", cursor)])
  }
  init(data: Data, actor: StaffIdentity, area: String = "notices", code: String = "", cursor: String = "") throws {
    _ = try Self.query(area: area, code: code, cursor: cursor)
    guard area == "workspace" ? marketingAreas.contains(where: { actor.allows($0.2) }) : actor.allows(area == "notices" ? "marketing.notice.view" : "marketing.send") else { throw StaffAPIError.invalid }
    let d = try marketingEnvelope(data, actor: actor); guard let raw = d["rows"] as? [[String: Any]], raw.count <= (area == "notices" ? 20 : 50) else { throw StaffAPIError.invalid }
    self.area = area; self.code = area == "notices" ? code : ""; self.cursor = cursor; employeeID = actor.employee.id; enabled = true
    if area == "notices" { guard (code.isEmpty && d["code"] is NSNull) || d["code"] as? String == code else { throw StaffAPIError.invalid }; latestVersion = code.isEmpty ? nil : try couponPolicyInteger(d["latestVersion"], 0...2_147_483_646) } else { latestVersion = nil }
    rows = try raw.map(MarketingRecord.init); guard Set(rows.map(\.id)).count == rows.count, area != "workspace" || rows.isEmpty else { throw StaffAPIError.invalid }
    for row in rows { try marketingValidateRecord(row, area: area); if area == "notices", !code.isEmpty { guard row.text("code") == code, try walletInteger(row.object["version"]) <= latestVersion! else { throw StaffAPIError.invalid } } }
    nextCursor = d["next"] as? String; guard d["next"] is NSNull || nextCursor.map({ UUID(uuidString: $0) != nil }) == true else { throw StaffAPIError.invalid }
  }
  func decisionActions(actor: StaffIdentity, row: MarketingRecord) -> [String] {
    guard area == "notices", rows.contains(row), actor.allows("marketing.notice.view"), let action = ["draft": "approve", "approved": "publish", "published": "stop"][row.text("status")], actor.allows(marketingPermission("decision", body: ["decision": action])) else { return [] }
    if action != "stop", row.text("createdByEmployeeId") == actor.employee.id { return [] }
    if action == "publish", (row.object["decisions"] as? [[String: Any]] ?? []).contains(where: { $0["action"] as? String == "approve" && $0["employee_id"] as? String == actor.employee.id }) { return [] }
    return [action]
  }
  func command(actor: StaffIdentity, action: String, body input: [String: Any], row: MarketingRecord? = nil, customer: MarketingCustomerSelection? = nil, now: Date = Date()) throws -> LiveCommand {
    guard let title = marketingActions[action], employeeID == actor.employee.id, enabled, actor.allows(marketingPermission(action, body: input)), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("请读取当前员工权限与原营销记录") }
    var b = input
    if action != "queue" { b["reason"] = try annualText(b["reason"], max: 500) }
    if ["save", "decision", "queue"].contains(action) { guard area == "notices", actor.allows("marketing.notice.view") else { throw StaffAPIError.invalid } }
    if ["decision", "queue", "cancel"].contains(action) { guard let row, rows.contains(row) else { throw CatalogError("原告知或任务版本已变化，请重新读取") }; b["expectedVersion"] = row.text("nativeVersion"); b[action == "cancel" ? "jobId" : "noticeId"] = row.id }
    if action == "save" { guard Set(input.keys) == ["code", "rule", "reason"], !code.isEmpty, input["code"] as? String == code, let latestVersion, let rule = input["rule"] as? [String: Any] else { throw CatalogError("起草前须先读取同编号最新告知") }; b["expectedVersion"] = latestVersion; b["rule"] = try marketingRule(rule) }
    if action == "decision" { guard Set(input.keys) == ["decision", "reason"], let row, decisionActions(actor: actor, row: row).contains(membershipText(b["decision"])) else { throw CatalogError("原状态或独立审核分工不允许此操作") }; if b["decision"] as? String != "stop" { guard let rule = row.object["rule"] as? [String: Any], assignmentDate(membershipText(rule["validUntil"])).map({ $0 > now }) == true else { throw CatalogError("原告知已经过期，请起草新版本") } } }
    if ["refusal", "queue"].contains(action) { guard let customer, customer.employeeID == employeeID, customer.purpose == (action == "queue" ? "send" : "refusal"), customer.row.id == input["customerId"] as? String else { throw CatalogError("须从本用途的当前授权查询中选择原顾客") } }
    if action == "refusal" { guard area == "workspace", Set(input.keys) == ["customerId", "reason"] else { throw StaffAPIError.invalid } }
    if action == "queue" {
      guard Set(input.keys) == ["customerId", "channel", "purpose", "campaignKey", "content", "expiresAt"], row?.text("status") == "published", let rule = row?.object["rule"] as? [String: Any], (rule["channels"] as? [String] ?? []).contains(membershipText(b["channel"])), (rule["purposes"] as? [String] ?? []).contains(membershipText(b["purpose"])), membershipText(b["campaignKey"]).range(of: "^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$", options: .regularExpression) != nil else { throw CatalogError("任务须绑定已发布原告知、原活动批次及其允许范围") }
      b["content"] = try annualText(b["content"], max: 2000); b["expiresAt"] = try marketingDate(b["expiresAt"])
      guard assignmentDate(b["expiresAt"] as! String)! > now else { throw CatalogError("任务截止必须晚于现在，服务端仍会核验本人许可期限") }
    }
    if action == "cancel" { guard area == "jobs", Set(input.keys) == ["reason"], ["queued", "blocked"].contains(row?.text("status") ?? "") else { throw CatalogError("仅能取消尚未交给渠道的原任务，不能撤回已发送内容") } }
    var confirmation = title + "\n"
    if ["save", "decision"].contains(action) {
      let rule = (action == "save" ? b["rule"] : row?.object["rule"]) as! [String: Any]
      let v = action == "save" ? latestVersion! + 1 : try walletInteger(row!.object["version"])
      confirmation += (action == "save" ? code : row!.text("code")) + " · 第\(v)版\n" + (try marketingRuleSummary(rule))
      if action == "decision" { confirmation += "\n本次：" + (["approve": "独立审核", "publish": "第三人发布", "stop": "停止告知"][membershipText(b["decision"])] ?? "待核对") }
    } else if action == "queue" {
      confirmation += "顾客：" + customer!.row.text("name") + " · " + customer!.row.text("code") + "\n原告知：" + row!.text("code") + " 第" + row!.text("version") + "版\n" + marketingChannels.first { $0.0 == b["channel"] as? String }!.1 + " · " + marketingPurposes.first { $0.0 == b["purpose"] as? String }!.1 + "\n原活动批次：" + membershipText(b["campaignKey"]) + "\n内容：" + membershipText(b["content"]) + "\n截止：" + (try membershipLocal(b["expiresAt"] as! String)) + "\n排队仍须核验本人许可、渠道和频次，不表示已经送达；结果未知保留原任务。"
    } else if action == "refusal" { confirmation += "顾客：" + customer!.row.text("name") + " · " + customer!.row.text("code") + "\n顾客已经明确拒绝全部营销。此操作不能代替顾客授予许可。" }
    else { confirmation += "原活动批次：" + row!.text("campaignKey") + "\n顾客：" + (row!.text("customerRef").isEmpty ? row!.text("customerId") : row!.text("customerRef")) + "\n内容：" + row!.text("content") + "\n只取消未交给渠道的原任务，不表示撤回已送达内容。" }
    if action != "queue" { confirmation += "\n实际依据：" + membershipText(b["reason"]) }
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["employeeId": employeeID, "action": action, "area": area, "code": code, "before": row?.object ?? [:], "customer": customer?.row.object ?? [:], "confirmation": confirmation], body = try membershipData(b)
    guard body.count <= 32768 else { throw CatalogError("告知或任务内容超过接口大小限制") }
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: marketingPermission(action, body: b), steps: [.init(path: marketingRoot + "/" + action, body: body, keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["marketing": proof]))])
  }
}
extension LiveCommand.Step { var marketingProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["marketing"] as? [String: Any] } }
func validMarketingSelection(command: LiveCommand, board: MarketingBoard, actor: StaffIdentity) -> Bool {
  guard command.steps.count == 1, let s = command.steps.first, let p = s.marketingProof, let action = p["action"] as? String, marketingActions[action] != nil, command.employeeID == actor.employee.id, p["employeeId"] as? String == actor.employee.id, board.employeeID == actor.employee.id, board.enabled, p["area"] as? String == board.area, p["code"] as? String == board.code, command.permission == marketingPermission(action, body: s.object), actor.allows(command.permission), s.path == marketingRoot + "/" + action, s.keyHeader == "idempotency-key", s.key == "native-business-" + command.id else { return false }
  if ["save", "decision", "queue"].contains(action), !actor.allows("marketing.notice.view") { return false }
  if action == "save" { return board.area == "notices" && s.object["code"] as? String == board.code && (try? walletInteger(s.object["expectedVersion"])) == board.latestVersion }
  if action == "refusal" { return board.area == "workspace" && (p["customer"] as? [String: Any])?["id"] as? String == s.object["customerId"] as? String }
  guard let before = p["before"] as? [String: Any] else { return false }
  return board.rows.contains { $0.id == s.object[action == "cancel" ? "jobId" : "noticeId"] as? String && membershipEqual($0.object, before) }
}
func validateMarketingReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let p = step.marketingProof, let action = p["action"] as? String, marketingActions[action] != nil, step.path == marketingRoot + "/" + action, step.keyHeader == "idempotency-key", step.key.hasPrefix("native-business-"), UUID(uuidString: String(step.key.dropFirst(16))) != nil, d["employeeId"] as? String == p["employeeId"] as? String, d["requestKey"] as? String == step.key, d["action"] as? String == action, let accepted = d["accepted"] as? [String: Any], membershipEqual(accepted, step.object), let raw = d["row"] as? [String: Any], let before = p["before"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); let body = step.object
  if action == "refusal" { guard try walletBoolean(raw["stopped"]), raw["customerId"] as? String == body["customerId"] as? String else { throw StaffAPIError.invalid }; return }
  let row = try MarketingRecord(raw); try marketingValidateRecord(row, area: ["save", "decision"].contains(action) ? "notices" : "jobs")
  if action == "save" {
    guard row.text("code") == body["code"] as? String, try walletInteger(raw["version"]) == walletInteger(body["expectedVersion"]) + 1, row.text("status") == "draft", row.text("createdByEmployeeId") == p["employeeId"] as? String, row.text("reason") == body["reason"] as? String, let rule = raw["rule"] as? [String: Any], let original = body["rule"] as? [String: Any], try membershipEqual(marketingRule(rule), marketingRule(original)) else { throw CatalogError("告知回执范围、时段、频次或内容不符") }
  } else if action == "decision" {
    guard row.id == body["noticeId"] as? String, let decision = body["decision"] as? String, row.text("status") == ["approve": "approved", "publish": "published", "stop": "stopped"][decision], row.text("code") == before["code"] as? String, try walletInteger(raw["version"]) == walletInteger(before["version"]), row.text("createdByEmployeeId") == before["createdByEmployeeId"] as? String, let rule = raw["rule"] as? [String: Any], let original = before["rule"] as? [String: Any], try membershipEqual(marketingRule(rule), marketingRule(original)), (raw["decisions"] as! [[String: Any]]).contains(where: { $0["action"] as? String == decision && $0["employee_id"] as? String == p["employeeId"] as? String }) else { throw CatalogError("回执不是原告知版本或当前员工的原决定") }
    for old in before["decisions"] as? [[String: Any]] ?? [] { guard (raw["decisions"] as! [[String: Any]]).contains(where: { membershipEqual($0, old) }) else { throw StaffAPIError.invalid } }
  } else {
    let source = action == "queue" ? body : before
    guard ["customerId", "noticeId", "campaignKey", "content", "channel", "purpose"].allSatisfy({ raw[$0] as? String == source[$0] as? String }), assignmentDate(row.text("expiresAt")) == assignmentDate(membershipText(source["expiresAt"])) else { throw CatalogError("回执的原顾客、活动批次、内容、渠道或期限不匹配") }
    if action == "cancel" { guard row.id == body["jobId"] as? String, row.text("status") == "cancelled", row.text("createdByEmployeeId") == before["createdByEmployeeId"] as? String, row.text("blockedReason") == "staff_cancelled" else { throw StaffAPIError.invalid } }
  }
}
struct MarketingCustomerSelection { let employeeID: String, purpose: String; let row: MarketingRecord }
struct MarketingCustomerPage {
  let employeeID: String, purpose: String, rows: [MarketingRecord], nextCursor: String?
  static func query(purpose: String, search: String, cursor: String = "") throws -> String {
    guard ["send", "refusal", "audit"].contains(purpose), (2...80).contains(search.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count), cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw CatalogError("请输入至少2字的会员号或顾客编号") }; return marketingURL("customers", [("purpose", purpose), ("search", search), ("cursor", cursor)])
  }
  init(data: Data, actor: StaffIdentity, purpose: String, search: String) throws {
    _ = try Self.query(purpose: purpose, search: search); guard actor.allows(marketingCustomerPermission(purpose)) else { throw StaffAPIError.invalid }; let d = try marketingEnvelope(data, actor: actor)
    guard let raw = d["rows"] as? [[String: Any]], raw.count <= 50 else { throw StaffAPIError.invalid }; rows = try raw.map(MarketingRecord.init)
    guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }; for row in rows { guard UUID(uuidString: row.id) != nil, !row.text("name").isEmpty, !row.text("code").isEmpty, Set(row.object.keys) == ["id", "name", "code"] else { throw StaffAPIError.invalid } }
    employeeID = actor.employee.id; self.purpose = purpose; nextCursor = d["next"] as? String; guard d["next"] is NSNull || nextCursor.map({ UUID(uuidString: $0) != nil }) == true else { throw StaffAPIError.invalid }
  }
  func selection(row: MarketingRecord) throws -> MarketingCustomerSelection { guard rows.contains(row) else { throw StaffAPIError.invalid }; return MarketingCustomerSelection(employeeID: employeeID, purpose: purpose, row: row) }
}
struct MarketingHistoryPage {
  let rows: [MarketingRecord], nextCursor: String?, customerId: String
  static func body(customerId: String, reason: String, cursor: String = "") throws -> [String: Any] {
    guard UUID(uuidString: customerId) != nil else { throw StaffAPIError.invalid }; if !cursor.isEmpty { guard cursor.range(of: "^[1-9][0-9]{0,18}$", options: .regularExpression) != nil, UInt64(cursor).map({ $0 <= 9_223_372_036_854_775_807 }) == true else { throw StaffAPIError.invalid } }
    return ["customerId": customerId, "reason": try annualText(reason, max: 500), "cursor": cursor.isEmpty ? NSNull() : cursor]
  }
  init(data: Data, actor: StaffIdentity, customerId: String) throws {
    guard actor.allows("marketing.consent.audit"), UUID(uuidString: customerId) != nil else { throw StaffAPIError.invalid }; let d = try marketingEnvelope(data, actor: actor)
    guard d["customerId"] as? String == customerId, let raw = d["rows"] as? [[String: Any]], raw.count <= 50 else { throw CatalogError("原顾客身份或历史已变化，请重新选择") }; self.customerId = customerId; rows = try raw.map(MarketingRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows { guard UUID(uuidString: row.id) != nil, ["granted", "withdrawn", "denied", "stop_all"].contains(row.text("action")), ["customer_self", "staff_recorded_refusal"].contains(row.text("source")), assignmentDate(row.text("createdAt")) != nil else { throw StaffAPIError.invalid }; if row.text("source") == "staff_recorded_refusal", row.text("action") != "stop_all" { throw CatalogError("员工记录不能伪装成本人营销同意") } }
    for row in rows {
      if row.text("action") == "stop_all" { guard row.object["channel"] is NSNull, row.object["purpose"] is NSNull else { throw StaffAPIError.invalid } }
      else { guard marketingChannels.contains(where: { $0.0 == row.text("channel") }), marketingPurposes.contains(where: { $0.0 == row.text("purpose") }) else { throw StaffAPIError.invalid } }
      if row.text("action") == "granted" { guard assignmentDate(row.text("validUntil")) != nil, let notice = row.object["notice"] as? [String: Any], UUID(uuidString: membershipText(notice["id"])) != nil else { throw StaffAPIError.invalid } }
    }
    nextCursor = d["next"] as? String; guard d["next"] is NSNull || nextCursor != nil else { throw StaffAPIError.invalid }; if let nextCursor { _ = try Self.body(customerId: customerId, reason: "继续原历史查询", cursor: nextCursor) }
  }
}
