import Foundation

let memberGiftRoot = "/api/staff/native-member-gifts"
let memberGiftPermissions = ["loyalty.configuration.view", "loyalty.configuration.edit", "loyalty.configuration.approve", "loyalty.policy.publish"]
let memberGiftSections = ["campaigns": "赠礼活动", "jobs": "发放任务", "refund-pending": "退款券待复核", "refund-resolved": "退款券已处理"]
let memberGiftStatuses = ["draft": "草稿", "approved": "待发布", "published": "已发布", "stopped": "已停发", "pending": "等待发放", "blocked": "暂时受阻", "issued": "已发券", "duplicate": "已处理过", "cancelled": "已取消"]
let memberGiftActions = ["approve": "独立审批活动", "publish": "正式发布活动", "stop": "停止新发券", "target": "安排指定会员发券", "retry": "重试原任务", "cancel": "取消待发任务", "no_return": "按原规则不返券", "external_compensation": "已完成线下补偿", "replacement_coupon": "关联已发出的补偿券"]
let memberGiftBlockedReasons = ["campaign_closed": "活动已结束或停止", "coupon_calendar_closed": "券日历已停止发放", "campaign_quantity_exceeded": "活动总份数不足", "daily_quantity_exceeded": "每日份数不足", "campaign_cost_exceeded": "活动成本预算不足", "daily_cost_exceeded": "每日成本预算不足", "unit_cost_exceeded": "单份成本超过上限", "cost_unknown": "商品成本未知", "audience_changed": "当前会员资格不符", "product_unavailable_or_cost_unknown": "商品停用、缺少售价或成本未知", "stacking_policy_closed": "叠加价格规则已停止发放", "same_family_already_issued": "同一会员家庭已经发过"]
struct GiftRecord: Identifiable, Equatable {
  let data: Data
  init(_ object: [String: Any]) throws { data = try membershipData(object) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  var rule: [String: Any] { object["rule"] as? [String: Any] ?? [:] }
}
func memberGiftCursor(_ cursor: String, section: String) throws {
  guard memberGiftSections[section] != nil else { throw StaffAPIError.invalid }
  if cursor.isEmpty { return }
  let ids = section.hasPrefix("refund-") ? cursor.split(separator: ":").map(String.init) : [cursor]
  guard ids.count == (section.hasPrefix("refund-") ? 2 : 1), ids.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw StaffAPIError.invalid }
}
func memberGiftQuery(_ path: String, _ values: [URLQueryItem]) -> String {
  var parts = URLComponents(); parts.queryItems = values
  return path + (values.isEmpty ? "" : "?" + (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B"))
}
struct MemberGiftsBoard {
  let employeeID, section: String
  let rows: [GiftRecord]
  let enabled: Bool
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity, section: String) throws {
    let d = try walletEnvelope(data)
    guard actor.allows("loyalty.configuration.view"), memberGiftSections[section] != nil,
      d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1,
      let items = d["rows"] as? [[String: Any]], items.count <= (section == "campaigns" ? 20 : 50) else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.section = section; enabled = try walletBoolean(d["durableCommands"])
    rows = try items.map(GiftRecord.init)
    guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows {
      try memberGiftCursor(row.id, section: section)
      guard !row.id.isEmpty, row.text("nativeVersion").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
      if section == "campaigns" {
        guard ["draft", "approved", "published", "stopped"].contains(row.text("status")), try row.integer("version") > 0,
          UUID(uuidString: row.text("created_by_employee_id")) != nil else { throw StaffAPIError.invalid }
        try validateMemberGiftRule(row.rule)
      } else if section == "jobs" {
        guard ["pending", "blocked", "issued", "duplicate", "cancelled"].contains(row.text("status")) else { throw StaffAPIError.invalid }
        _ = try row.integer("attempts"); _ = try row.integer("quantity")
      } else {
        guard row.id == row.text("refund_id") + ":" + row.text("reservation_id"), row.text("currency") == "CNY",
          section == "refund-pending" ? row.object["action"] is NSNull : ["no_return", "external_compensation", "replacement_coupon"].contains(row.text("action")) else { throw StaffAPIError.invalid }
        _ = try row.integer("refund_amount_minor"); _ = try row.integer("quantity")
      }
    }
    if d["next"] is NSNull { nextCursor = nil }
    else { guard let next = d["next"] as? String, !next.isEmpty else { throw StaffAPIError.invalid }; try memberGiftCursor(next, section: section); nextCursor = next }
  }
  static func query(section: String, cursor: String = "") throws -> String {
    try memberGiftCursor(cursor, section: section)
    return memberGiftQuery(memberGiftRoot + "/" + section, cursor.isEmpty ? [] : [URLQueryItem(name: "cursor", value: cursor)])
  }
  func command(actor: StaffIdentity, action: String, fields: [String: String] = [:], row: GiftRecord? = nil,
    draft: MemberGiftDraft? = nil, customers: [WalletRecord] = [], replacement: WalletRecord? = nil, now: Date = Date()) throws -> LiveCommand {
    let operation = fields["operation"] ?? ""
    let permission = action == "save" ? "loyalty.configuration.edit" : action == "decision" && operation == "approve" ? "loyalty.configuration.approve" : "loyalty.policy.publish"
    guard ["save", "decision", "target", "control", "refund"].contains(action), enabled,
      actor.employee.id == employeeID, actor.allows("loyalty.configuration.view"), actor.allows(permission),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("登录、岗位权限或原记录已变化，请重新读取") }
    let reason = (action == "save" ? draft?.fields["reason"] ?? "" : fields["reason"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...500).contains(reason.utf16.count) else { throw CatalogError("请填写2—500字实际依据") }
    var body: [String: Any], lines: [String], before: [String: Any] = [:]
    let title: String
    if action == "save" {
      guard section == "campaigns", let draft else { throw StaffAPIError.invalid }
      if let row { guard rows.contains(row), draft.originalID == row.id else { throw CatalogError("原活动版本已变化，请重新读取") } }
      else { guard draft.originalID == nil else { throw StaffAPIError.invalid } }
      body = try draft.body()
      if let row, body["code"] as? String == row.text("code") {
        guard try walletInteger(body["expectedVersion"]) == row.integer("version"), let rule = body["rule"] as? [String: Any] else { throw StaffAPIError.invalid }
        for key in ["trigger", "cardProjectId", "budgetDateBasis", "budgetDayStartMinute"] {
          guard NSDictionary(dictionary: [key: rule[key]!]).isEqual(to: [key: row.rule[key]!]) else { throw CatalogError("同一活动的触发身份、入卡项目和预算换日不能改写；请使用新活动编号") }
        }
      }
      title = "保存赠礼活动新版本草稿"
      lines = [body["name"] as! String, "第\(try walletInteger(body["expectedVersion"]) + 1)版", try memberGiftRuleSummary(body["rule"] as! [String: Any], names: draft.names), "保存草稿不发券，仍须不同员工审批、发布。"]
    } else {
      guard let row, rows.contains(row) else { throw CatalogError("原活动、任务或退款权益已不可见，请刷新") }
      body = ["expectedVersion": row.text("nativeVersion"), "reason": reason]
      if action == "decision" || action == "target" {
        guard section == "campaigns" else { throw StaffAPIError.invalid }
        body["versionId"] = row.id
        lines = [row.text("name") + " · 第\(try row.integer("version"))版", try memberGiftRuleSummary(row.rule, names: memberGiftOriginalNames(row))]
        if action == "decision" {
          guard let state = ["approve": "draft", "publish": "approved", "stop": "published"][operation], row.text("status") == state else { throw CatalogError("原活动状态已变化") }
          if operation != "stop" { guard row.text("created_by_employee_id") != employeeID else { throw CatalogError("创建人不能审批或发布本人活动") } }
          if operation == "publish" { guard UUID(uuidString: row.text("approved_by_employee_id")) != nil, row.text("approved_by_employee_id") != employeeID else { throw CatalogError("须由不同于审批人的员工发布") } }
          body["action"] = operation; title = memberGiftActions[operation]!
          lines.append(operation == "stop" ? "停止后不再新发券，已发券仍按原规则使用；不撤销历史发放。" : "发放时后台仍会重新校验顾客资格、成本、预算及券日历。")
        } else {
          guard row.text("status") == "published", row.rule["trigger"] as? String == "targeted", (1...50).contains(customers.count),
            Set(customers.map(\.id)).count == customers.count else { throw CatalogError("请为已发布定向活动选择1—50位不重复会员；入卡礼只能由真实入卡审核触发") }
          let cycle = (fields["cycle"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
          guard cycle.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$", options: .regularExpression) != nil else { throw CatalogError("批次编号须为1—100位字母数字或 . _ : -") }
          body["cycleKey"] = cycle; body["customerIds"] = customers.map(\.id); title = memberGiftActions["target"]!
          lines += ["批次：" + cycle + " · \(customers.count)位", customers.map { $0.text("name") + " · " + $0.text("code") }.joined(separator: "\n"), "本次只安排任务，不表示已发券。相同活动、批次和会员不会重复发放；组合甜点每位会员只赠一次，更换批次不产生新资格。"]
        }
      } else if action == "control" {
        guard section == "jobs", ["pending", "blocked"].contains(row.text("status")), ["retry", "cancel"].contains(operation) else { throw CatalogError("已结束任务不能重发或取消") }
        body["jobId"] = row.id; body["action"] = operation; title = memberGiftActions[operation]!
        lines = [row.text("name"), "顾客：" + row.text("customer_reference"), "原份数：\(try row.integer("quantity"))", "原状态：" + (memberGiftStatuses[row.text("status")] ?? "待核对"), operation == "retry" ? "只安排原任务再次检查，不直接发券、不绕过当前资格或预算。" : "取消未发券任务，不撤回已发券、不退款，也不另建同批次资格。"]
      } else {
        guard section == "refund-pending", row.object["action"] is NSNull, ["reserved", "redeemed"].contains(row.text("status")),
          ["no_return", "external_compensation", "replacement_coupon"].contains(operation) else { throw CatalogError("原退款券权益已处理或不可复核") }
        let evidence = (fields["evidence"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...200).contains(evidence.utf16.count) else { throw CatalogError("请填写原规则或实际补偿凭证（2—200字）") }
        if operation == "external_compensation" { guard fields["compensated"] == "true" else { throw CatalogError("须先确认实际线下补偿已经完成") } }
        body["refundId"] = row.text("refund_id"); body["reservationId"] = row.text("reservation_id"); body["action"] = operation; body["evidenceReference"] = evidence
        title = memberGiftActions[operation]!; lines = [memberGiftRefundSummary(row), "凭证：" + evidence]
        if operation == "replacement_coupon" {
          guard let replacement, try replacement.integer("quantity_total") > 0 else { throw CatalogError("请选择查询返回的同会员已发补偿券") }
          body["replacementBenefitId"] = replacement.id; lines.append("关联原新券：" + replacement.text("benefit_code") + " · \(try replacement.integer("quantity_total"))份")
          before["replacementQuantity"] = try replacement.integer("quantity_total")
        } else { guard replacement == nil else { throw CatalogError("此处理方式不能绑定补偿券") } }
        for key in ["refund_amount_minor", "currency", "benefit_code", "quantity", "order_reference", "refund_reference"] { before[key] = row.object[key] }
        lines.append("只记录已确认的权益处理结论，不退款、不发券、不改库存；本笔订单退款金额并非每张券补偿金额。")
      }
    }
    lines.append("依据：" + reason)
    let id = UUID().uuidString.lowercased()
    let proof: [String: Any] = ["action": action, "employeeId": employeeID, "section": section, "before": before, "confirmation": ([title] + lines).joined(separator: "\n")]
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: memberGiftRoot + "/" + action, body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["memberGift": proof]))])
  }
}
struct MemberGiftOptions {
  let employeeID: String
  let rows: [WalletRecord]
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity, refund: Bool = false) throws {
    let d = try walletEnvelope(data)
    guard actor.allows(refund ? "loyalty.policy.publish" : "loyalty.configuration.view"), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, try walletBoolean(d["durableCommands"]), let items = d["rows"] as? [[String: Any]], items.count <= 50 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; rows = try walletRecords(items)
    nextCursor = d["next"] is NSNull ? nil : d["next"] as? String
    guard d["next"] is NSNull || (nextCursor != nil && UUID(uuidString: nextCursor!) != nil) else { throw StaffAPIError.invalid }
    for row in rows { if refund { _ = try row.integer("quantity_total") } else { guard !row.text("name").isEmpty, !row.text("code").isEmpty else { throw StaffAPIError.invalid } } }
  }
  static func query(kind: String, search: String, cursor: String = "") throws -> String {
    let search = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard ["products", "projects", "audience-cards", "calendars", "stacking", "customers"].contains(kind), search.utf16.count <= 80,
      kind != "customers" || search.utf16.count >= 2, cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw CatalogError("查询条件无效；会员须输入至少2字的会员号或客户编号") }
    var query = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "search", value: search)]
    if !cursor.isEmpty { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    return memberGiftQuery(memberGiftRoot + "/options", query)
  }
  static func refundQuery(refundID: String, reservationID: String, cursor: String = "") throws -> String {
    guard [refundID, reservationID].allSatisfy({ UUID(uuidString: $0) != nil }), cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw StaffAPIError.invalid }
    var q = [URLQueryItem(name: "refundId", value: refundID), URLQueryItem(name: "reservationId", value: reservationID)]
    if !cursor.isEmpty { q.append(URLQueryItem(name: "cursor", value: cursor)) }
    return memberGiftQuery(memberGiftRoot + "/refund-options", q)
  }
}
func memberGiftRefundSummary(_ row: GiftRecord) -> String {
  "订单 " + row.text("order_reference") + " · 退款单 " + row.text("refund_reference") + "\n原券 " + row.text("benefit_code") + " · " + row.text("quantity") + "份\n本笔订单已退款 " + ((try? row.integer("refund_amount_minor")).map(walletMoneyText) ?? "待核对") + "元 · " + row.text("currency")
}
extension LiveCommand.Step {
  var memberGiftProof: [String: Any]? {
    guard let recoveryBody else { return nil }
    return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["memberGift"] as? [String: Any]
  }
}
func validateMemberGiftReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any],
    try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let p = step.memberGiftProof,
    let action = p["action"] as? String, step.path == memberGiftRoot + "/" + action,
    d["action"] as? String == action, d["employeeId"] as? String == p["employeeId"] as? String, d["requestKey"] as? String == step.key,
    let accepted = d["accepted"] as? [String: Any], membershipEqual(accepted, step.object), let r = d["row"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"])
  let b = step.object, result = try GiftRecord(r), operation = b["action"] as? String ?? ""
  switch action {
  case "save":
    guard UUID(uuidString: result.id) != nil, result.text("code") == b["code"] as? String, result.text("name") == b["name"] as? String,
      try result.integer("version") == walletInteger(b["expectedVersion"]) + 1, result.text("status") == "draft", result.text("created_by_employee_id") == p["employeeId"] as? String,
      let rule = b["rule"] as? [String: Any], try memberGiftCanonical(result.rule) == memberGiftCanonical(rule) else { throw StaffAPIError.invalid }
  case "decision":
    guard let state = ["approve": "approved", "publish": "published", "stop": "stopped"][operation], result.id == b["versionId"] as? String,
      result.text("status") == state, result.text(state + "_by_employee_id") == p["employeeId"] as? String else { throw StaffAPIError.invalid }
  case "target":
    guard let items = r["items"] as? [[String: Any]], let customers = b["customerIds"] as? [String], items.count == customers.count else { throw StaffAPIError.invalid }
    for item in items { guard UUID(uuidString: item["jobId"] as? String ?? "") != nil, ["pending", "blocked", "issued", "duplicate", "cancelled"].contains(item["status"] as? String ?? "") else { throw StaffAPIError.invalid }; _ = try walletBoolean(item["replayed"]) }
  case "control":
    let scheduled = try walletBoolean(r["scheduled"])
    guard result.text("jobId") == b["jobId"] as? String, operation == "cancel" ? (!scheduled && result.text("status") == "cancelled") : (operation == "retry" && scheduled && ["pending", "blocked"].contains(result.text("status"))) else { throw StaffAPIError.invalid }
  case "refund":
    guard let before = p["before"] as? [String: Any], result.text("refund_id") == b["refundId"] as? String, result.text("reservation_id") == b["reservationId"] as? String,
      result.text("action") == operation, result.text("reason") == b["reason"] as? String, result.text("evidence_reference") == b["evidenceReference"] as? String else { throw StaffAPIError.invalid }
    for key in ["refund_amount_minor", "currency", "benefit_code", "quantity", "order_reference", "refund_reference"] { guard membershipText(r[key]) == membershipText(before[key]) else { throw StaffAPIError.invalid } }
    if operation == "replacement_coupon" { guard result.text("replacement_benefit_id") == b["replacementBenefitId"] as? String, try result.integer("replacement_quantity") == walletInteger(before["replacementQuantity"]) else { throw StaffAPIError.invalid } }
    else { guard ["no_return", "external_compensation"].contains(operation), r["replacement_benefit_id"] is NSNull else { throw StaffAPIError.invalid } }
  default: throw StaffAPIError.invalid
  }
}
