import Foundation
import CryptoKit

let membershipConfigRoot = "/api/staff/native-membership-config"
let membershipDomainNames = ["base_points": "基础积分", "tier_policy": "会员等级", "tier_benefits": "等级权益", "redemption_catalog": "积分兑换", "promotion_points": "促销积分", "membership_terms": "入会条款", "wechat_notifications": "微信服务通知"]
let membershipConfigStatuses = ["draft": "待编辑与审批", "approved": "已审批待发布", "published": "已发布，按生效时间执行", "paused": "暂停", "retired": "退役"]
let membershipControls = ["points_accrual": "积分累积", "points_redemption": "积分兑换", "wechat_notification": "微信通知"]
let membershipConfigPermissions = ["loyalty.configuration.view", "loyalty.operations.view", "loyalty.operations.control", "loyalty.configuration.edit", "loyalty.configuration.preview", "loyalty.configuration.approve", "loyalty.policy.manage", "loyalty.policy.publish", "loyalty.redemption.catalog.manage", "loyalty.redemption.catalog.publish", "loyalty.promotion.manage", "loyalty.promotion.publish", "membership.terms.manage", "membership.terms.publish"]
func membershipPermission(_ action: String, domain: String) throws -> String {
  guard ["create", "edit", "preview", "approve", "publish", "control"].contains(action), action == "control" || membershipDomainNames[domain] != nil else { throw StaffAPIError.invalid }
  if action == "control" { return "loyalty.operations.control" }
  if action == "create" || action == "publish" {
    let root = ["redemption_catalog": "loyalty.redemption.catalog", "promotion_points": "loyalty.promotion", "membership_terms": "membership.terms"][domain] ?? "loyalty.policy"
    return root + (action == "create" ? ".manage" : ".publish")
  }
  return "loyalty.configuration." + action
}
struct MembershipRecord: Identifiable, Equatable {
  let data: Data
  init(_ object: [String: Any]) throws { data = try membershipData(object) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("configurationId").isEmpty ? text("publicId").isEmpty ? text("capability") : text("publicId") : text("configurationId") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  func objects(_ key: String) -> [[String: Any]] { object[key] as? [[String: Any]] ?? [] }
}
struct MembershipConfigBoard {
  let employeeID, section: String
  let enabled: Bool
  let rows: [MembershipRecord]
  let references: [WalletRecord]
  init(data: Data, actor: StaffIdentity, section: String) throws {
    let d = try walletEnvelope(data)
    guard ["rules", "controls"].contains(section), d["section"] as? String == section,
      actor.allows(section == "rules" ? "loyalty.configuration.view" : "loyalty.operations.view"),
      d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1,
      let rows = d["items"] as? [[String: Any]], let refs = d["references"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.section = section; enabled = try walletBoolean(d["durableCommands"])
    self.rows = try rows.map(MembershipRecord.init); references = try refs.map(WalletRecord.init)
    guard Set(self.rows.map(\.id)).count == self.rows.count else { throw StaffAPIError.invalid }
    for row in self.rows {
      if section == "rules" {
        guard UUID(uuidString: row.id) != nil, membershipDomainNames[row.text("domain")] != nil,
          membershipConfigStatuses[row.text("status")] != nil, try row.integer("revision") > 0,
          try row.integer("version") > 0 else { throw StaffAPIError.invalid }
      } else {
        guard membershipControls[row.text("capability")] != nil, ["active", "paused"].contains(row.text("state")) else { throw StaffAPIError.invalid }
        _ = try row.integer("version"); _ = try row.integer("pendingAccrualCount")
      }
    }
  }
  func command(actor: StaffIdentity, action: String, domain: String = "", content: [String: Any]? = nil,
    detail: MembershipConfigDetail? = nil, control: MembershipRecord? = nil,
    reason: String = "", from: String = "", until: String = "", reviewAt: String = "", now: Date = Date()) throws -> LiveCommand {
    let permission = try membershipPermission(action, domain: domain)
    guard enabled, actor.employee.id == employeeID, actor.allows(permission),
      actor.allows(section == "rules" ? "loyalty.configuration.view" : "loyalty.operations.view"),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("原规则、登录或权限已变化，请重新读取") }
    let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard action == "preview" || (2...500).contains(explanation.utf16.count) else { throw CatalogError("请填写2—500字实际依据") }
    var body: [String: Any] = ["action": action], confirmation: [String] = []
    let title: String
    if action == "control" {
      guard section == "controls", let control, rows.contains(control), let name = membershipControls[control.text("capability")] else { throw CatalogError("原运行状态已变化，请刷新") }
      let resume = control.text("state") == "paused"
      let review: Any = resume || reviewAt.isEmpty ? NSNull() : try membershipDate(reviewAt) as Any
      if let text = review as? String { guard assignmentDate(text).map({ $0 > now }) == true else { throw CatalogError("计划复核时间须在未来") } }
      body.merge(["capability": control.text("capability"), "operation": resume ? "resume" : "pause", "expectedVersion": try control.integer("version"), "reviewAt": review, "reason": explanation]) { _, v in v }
      title = (resume ? "恢复" : "暂停") + name
      confirmation = ["原版本：\(try control.integer("version"))", "待核原积分订单：\(try control.integer("pendingAccrualCount"))", "说明：" + explanation,
        "计划复核：" + (review as? String ?? "未设置"), "只改变此能力。不会撤回已发积分、权益或支付；复核时间仅为提醒，不自动恢复。"]
    } else {
      guard section == "rules" else { throw CatalogError("请先读取会员规则") }
      if action == "create" {
        guard domain != "wechat_notifications", let content, content["domain"] as? String == domain else { throw CatalogError("微信通知须选择已有后台托管草稿") }
        try validateMembershipContent(content)
        if domain == "redemption_catalog", (content["items"] as? [[String: Any]] ?? []).contains(where: { $0["status"] as? String != "active" }) { throw CatalogError("新目录兑换项先保存为启用草稿，停用或退役在后续草稿编辑中处理") }
        body["content"] = content; body["reason"] = explanation; title = "保存会员规则新草稿"
        confirmation = [membershipDomainNames[domain]!, try membershipContentSummary(content, references: references), "依据：" + explanation, "保存草稿不会立即生效，仍须影响预览、独立审批和第三人发布。"]
      } else {
        guard let detail, detail.employeeID == employeeID, detail.enabled, detail.domain == domain,
          let summary = rows.first(where: { $0.id == detail.configurationID && $0.text("domain") == domain }),
          try summary.integer("revision") == detail.draft.integer("revision"), summary.text("status") == detail.draft.text("status"),
          detail.draft.text("status") == (action == "publish" ? "approved" : "draft") else { throw CatalogError("原规则版本或状态已变化，请重新读取详情") }
        let revision = try detail.draft.integer("revision")
        body.merge(["domain": domain, "configurationId": detail.configurationID, "expectedRevision": revision]) { _, v in v }
        let original = detail.content
        confirmation = [membershipDomainNames[domain]! + " · 第\(try summary.integer("version"))版 / 修订\(revision)"]
        if action != "preview" { body["reason"] = explanation }
        switch action {
        case "edit":
          guard let content, content["domain"] as? String == domain else { throw StaffAPIError.invalid }
          try validateMembershipContent(content); body["content"] = content; title = "保存会员规则草稿修改"
          confirmation.append(try membershipContentSummary(content, references: references))
        case "preview", "approve":
          if let content, !membershipEqual(content, original) { throw CatalogError("请先保存未提交修改，再生成预览或审批") }
          if action == "approve" {
            guard !detail.makers.contains(actor.employee.id), let preview = detail.preview,
              preview.text("draftPublicId") == detail.configurationID, try preview.integer("draftRevision") == revision,
              preview.text("domain") == domain, assignmentDate(preview.text("expiresAt")).map({ $0 > now }) == true else { throw CatalogError("须由其他员工审批，并使用当前版本未过期的影响预览") }
            body["impactPreviewPublicId"] = preview.text("publicId")
            confirmation.append(try membershipImpactSummary(preview))
          }
          title = action == "preview" ? "生成服务器影响预览" : "独立审批会员规则"
          confirmation.append(try membershipContentSummary(original, references: references))
        case "publish":
          guard !detail.makers.contains(actor.employee.id), let approver = summary.object["approvedByEmployeeId"] as? String,
            UUID(uuidString: approver) != nil, approver != actor.employee.id else { throw CatalogError("须由不同于所有编辑者及审批人的第三位授权员工发布") }
          let start = try membershipDate(from)
          guard assignmentDate(start).map({ $0 > now }) == true else { throw CatalogError("生效时间须在未来") }
          let end: Any = until.isEmpty ? NSNull() : try membershipDate(until) as Any
          if let text = end as? String { guard domain != "membership_terms", assignmentDate(text)! > assignmentDate(start)! else { throw CatalogError("结束须晚于生效；入会条款由后续版本替代，不能设置结束") } }
          body["effectiveFrom"] = start; body["effectiveUntil"] = end; title = "正式发布会员规则"
          confirmation += ["北京时间 " + from + " 生效；" + (until.isEmpty ? "由后续版本替代" : until + " 结束"), try membershipContentSummary(original, references: references), "会影响之后适用的会员业务；不会替顾客接受条款或营销授权。"]
        default: throw StaffAPIError.invalid
        }
        if !explanation.isEmpty { confirmation.append("依据：" + explanation) }
      }
    }
    let id = UUID().uuidString.lowercased()
    var proof: [String: Any] = ["action": action, "domain": action == "control" ? "" : domain, "employeeId": employeeID, "confirmation": ([title] + confirmation).joined(separator: "\n")]
    if let acceptedContent = action == "edit" ? content : action == "approve" ? detail?.content : nil {
      proof["contentSHA256"] = try membershipContentFingerprint(acceptedContent)
    }
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: membershipConfigRoot + "/commands", body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["membershipConfig": proof]))])
  }
}
struct MembershipConfigDetail {
  let employeeID, domain, configurationID: String
  let enabled: Bool
  let draft: MembershipRecord
  let preview: MembershipRecord?
  var content: [String: Any] { draft.object["content"] as? [String: Any] ?? [:] }
  var makers: [String] { draft.object["makerEmployeeIds"] as? [String] ?? [] }
  init(data: Data, actor: StaffIdentity, domain: String, configurationID: String) throws {
    let d = try walletEnvelope(data)
    guard actor.allows("loyalty.configuration.view"), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, membershipDomainNames[domain] != nil, UUID(uuidString: configurationID) != nil,
      let raw = d["draft"] as? [String: Any], raw["publicId"] as? String == configurationID, raw["domain"] as? String == domain,
      let content = raw["content"] as? [String: Any], content["domain"] as? String == domain,
      let makers = raw["makerEmployeeIds"] as? [String], !makers.isEmpty, Set(makers).count == makers.count, makers.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.domain = domain; self.configurationID = configurationID; enabled = try walletBoolean(d["durableCommands"])
    draft = try MembershipRecord(raw)
    guard try draft.integer("revision") > 0, membershipConfigStatuses[draft.text("status")] != nil else { throw StaffAPIError.invalid }
    if let raw = d["preview"] as? [String: Any] {
      let value = try MembershipRecord(raw)
      guard value.text("domain") == domain, value.text("draftPublicId") == configurationID,
        try value.integer("draftRevision") == draft.integer("revision"), value.text("publicId").hasPrefix("MCIP"),
        assignmentDate(value.text("expiresAt")) != nil, !value.text("fingerprint").isEmpty else { throw StaffAPIError.invalid }
      preview = value
    } else { guard d["preview"] is NSNull else { throw StaffAPIError.invalid }; preview = nil }
  }
  static func target(_ value: String) throws -> (domain: String, id: String) {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 2, membershipDomainNames[parts[0]] != nil, UUID(uuidString: parts[1]) != nil else { throw StaffAPIError.invalid }
    return (parts[0], parts[1])
  }
  static func path(target: String) throws -> String { let value = try self.target(target); return membershipConfigRoot + "/" + value.domain + "/" + value.id }
}
func membershipImpactSummary(_ preview: MembershipRecord) throws -> String {
  guard let history = preview.object["historicalMembership"] as? [String: Any], assignmentDate(preview.text("generatedAt")) != nil else { throw StaffAPIError.invalid }
  var lines = ["服务器影响预览（估算，并非已发生费用）", "现有会员：\(try walletInteger(history["activeMembers"])) · 受影响：\(try preview.integer("affectedExistingMembers"))", "预计积分：\(try preview.integer("estimatedPointsIssued"))"]
  for (key, name) in [("estimatedPointsCostAmountMinor", "积分成本"), ("estimatedBenefitCostAmountMinor", "权益成本"), ("estimatedRedemptionCostAmountMinor", "兑换成本")] { lines.append("预计" + name + "：" + walletMoneyText(try preview.integer(key)) + "元") }
  lines += ["数据时点：" + preview.text("generatedAt"), "预览有效至：" + preview.text("expiresAt")]
  for item in preview.objects("fulfillment") {
    lines.append("\(membershipText(item["referenceCode"]))：预计需求 \(try walletInteger(item["expectedDemand"])) · 暂留后可用 \((try? walletInteger(item["availableAfterReservations"])).map(String.init) ?? "未知") · 缺口 \(try walletInteger(item["shortage"])) · 未完任务 \(try walletInteger(item["openFulfillmentTasks"]))")
  }
  let names = ["inventory_shortage": "库存可能不足", "fulfillment_capacity_review": "须复核现场履约人力", "points_cost_review": "须复核积分成本", "benefit_cost_review": "须复核权益成本", "redemption_cost_review": "须复核兑换成本", "terms_reacceptance_not_forced": "不强迫既有会员重新同意条款"]
  for warning in preview.object["warnings"] as? [String] ?? [] { lines.append(names[warning] ?? "有一项影响待核对") }
  return lines.joined(separator: "\n")
}
extension LiveCommand.Step {
  var membershipConfigProof: [String: Any]? {
    guard let recoveryBody else { return nil }
    return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["membershipConfig"] as? [String: Any]
  }
}
func validateMembershipConfigReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard step.path == membershipConfigRoot + "/commands", let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any],
    let p = step.membershipConfigProof, let action = p["action"] as? String, d["action"] as? String == action, step.object["action"] as? String == action,
    d["domain"] as? String == p["domain"] as? String, d["employeeId"] as? String == p["employeeId"] as? String,
    d["requestKey"] as? String == step.key, let raw = d["result"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"])
  let result = try MembershipRecord(raw), body = step.object
  if action == "control" {
    guard d["configurationId"] is NSNull, result.text("capability") == body["capability"] as? String,
      try result.integer("version") == walletInteger(body["expectedVersion"]) + 1,
      result.text("state") == (body["operation"] as? String == "pause" ? "paused" : "active") else { throw StaffAPIError.invalid }; return
  }
  guard let configID = d["configurationId"] as? String, UUID(uuidString: configID) != nil,
    action == "create" || configID == body["configurationId"] as? String else { throw StaffAPIError.invalid }
  switch action {
  case "create": guard result.text("id") == configID, result.text("status") == "draft" else { throw StaffAPIError.invalid }
  case "edit", "approve":
    guard result.text("publicId") == configID, result.text("domain") == p["domain"] as? String,
      result.text("status") == (action == "edit" ? "draft" : "approved"),
      try result.integer("revision") == walletInteger(body["expectedRevision"]) + (action == "edit" ? 1 : 0),
      let content = result.object["content"] as? [String: Any],
      try membershipContentFingerprint(content) == p["contentSHA256"] as? String else { throw StaffAPIError.invalid }
  case "preview":
    guard result.text("draftPublicId") == configID, result.text("domain") == p["domain"] as? String,
      try result.integer("draftRevision") == walletInteger(body["expectedRevision"]), result.text("publicId").hasPrefix("MCIP"),
      assignmentDate(result.text("expiresAt")) != nil, !result.text("fingerprint").isEmpty else { throw StaffAPIError.invalid }
  case "publish": guard result.text("id") == configID, result.text("status") == "published" else { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
}
