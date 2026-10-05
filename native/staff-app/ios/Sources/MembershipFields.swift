import Foundation
import CoreFoundation
import CryptoKit

let membershipFieldLabels: [String: String] = try! JSONSerialization.jsonObject(with: Data("{\"pointsNumerator\":\"获得积分\",\"pointsDenominatorMinor\":\"消费金额（元）\",\"growthNumerator\":\"获得成长值\",\"growthDenominatorMinor\":\"消费金额（元）\",\"roundingMode\":\"取整方式\",\"pointsValidityMonths\":\"积分有效月数\",\"evaluationWindowMonths\":\"评估周期（月）\",\"tierPeriodMonths\":\"等级周期（月）\",\"downgradeGraceDays\":\"降级宽限天数\",\"silverUpgradeGrowth\":\"银卡升级值\",\"silverRetainGrowth\":\"银卡保级值\",\"goldUpgradeGrowth\":\"金卡升级值\",\"goldRetainGrowth\":\"金卡保级值\",\"silverPointsMultiplierNumerator\":\"银卡获得积分\",\"silverPointsMultiplierDenominator\":\"银卡基础积分\",\"goldPointsMultiplierNumerator\":\"金卡获得积分\",\"goldPointsMultiplierDenominator\":\"金卡基础积分\",\"tierPolicyVersionId\":\"适用等级规则\",\"rules\":\"规则\",\"items\":\"兑换项\",\"ruleCode\":\"规则编号\",\"eligibleTier\":\"适用等级\",\"inheritToHigherTiers\":\"向更高等级继承\",\"grantOnEntry\":\"入级发放\",\"grantOnRetention\":\"保级发放\",\"benefitDefinitionId\":\"发放权益\",\"quantity\":\"数量\",\"validityDays\":\"有效天数\",\"revocationPolicy\":\"降级处理\",\"enabled\":\"启用\",\"publicId\":\"公开编号\",\"itemCode\":\"兑换项编号\",\"name\":\"名称\",\"fulfillmentKind\":\"履约类型\",\"productId\":\"兑换商品\",\"activityId\":\"关联活动\",\"pointsRequired\":\"所需积分\",\"costAmountMinor\":\"成本（元）\",\"currency\":\"币种\",\"totalInventory\":\"总库存\",\"dailyInventory\":\"日库存\",\"memberDailyLimit\":\"每人每日上限\",\"memberLifetimeLimit\":\"每人终身上限\",\"minimumTier\":\"最低等级\",\"requiresTableSession\":\"需在已开台的桌位使用\",\"requiresEmployeeFulfillment\":\"需由员工交付\",\"cancellationAllowedBeforeFulfillment\":\"交付前允许取消\",\"restoreExpiredPointsDays\":\"退回过期积分天数\",\"availableFrom\":\"可用开始时间\",\"availableUntil\":\"可用结束时间\",\"fulfillmentTimeoutMinutes\":\"履约时限（分钟）\",\"status\":\"状态\",\"campaignCode\":\"活动积分编号\",\"stackingGroup\":\"叠加组\",\"stackingMode\":\"叠加方式\",\"priority\":\"优先级\",\"storeBudgetPoints\":\"门店总预算积分\",\"perMemberPointsLimit\":\"每会员上限\",\"pointValidityDays\":\"积分有效天数\",\"refundPolicy\":\"退款冲回规则\",\"budgetReuseAfterRefund\":\"退款后释放预算\",\"memberLimitReuseAfterRefund\":\"退款后释放个人限额\",\"eligibleMemberLevels\":\"适用会员等级\",\"triggerKind\":\"触发事实\",\"points\":\"奖励积分\",\"perMemberAwardLimit\":\"每人奖励次数\",\"minimumPaidAmountMinor\":\"最低付款金额（元）\",\"title\":\"标题\",\"summary\":\"摘要\",\"content\":\"正文\",\"notificationType\":\"通知类型\",\"authorizationPurpose\":\"授权用途\",\"authorizationContext\":\"授权场景\",\"templateId\":\"微信模板ID\",\"pagePath\":\"到达页面\",\"pointsDataKey\":\"积分字段\",\"balanceDataKey\":\"余额字段\",\"occurredAtDataKey\":\"发生时间字段\",\"expiresAtDataKey\":\"到期时间字段\",\"expiryLeadDays\":\"提前提醒天数\",\"minimumIntervalMinutes\":\"最短发送间隔\",\"quietHoursStart\":\"静默开始\",\"quietHoursEnd\":\"静默结束\"}".utf8)) as! [String: String]
let membershipExtraLabels = ["memberRolling30DayLimit": "每人30天滚动上限", "maxPerCustomerPer24h": "每会员24小时通知上限"]
let membershipFieldChoices: [String: [String: String]] = try! JSONSerialization.jsonObject(with: Data("{\"notificationType\":{\"loyalty_points_credited\":\"积分到账\",\"loyalty_points_reversed\":\"积分退回或扣回\",\"loyalty_points_expiring\":\"积分即将到期\"},\"authorizationPurpose\":{\"loyalty_balance_change\":\"积分余额变动\",\"loyalty_expiry_reminder\":\"积分到期提醒\"},\"authorizationContext\":{\"loyalty_accrual\":\"消费积分到账\",\"loyalty_refund\":\"退款积分调整\",\"loyalty_expiry\":\"积分到期\"},\"roundingMode\":{\"floor\":\"向下取整\",\"nearest\":\"四舍五入\"},\"eligibleTier\":{\"member\":\"普通会员\",\"silver\":\"银卡\",\"gold\":\"金卡\"},\"minimumTier\":{\"member\":\"普通会员\",\"silver\":\"银卡\",\"gold\":\"金卡\"},\"revocationPolicy\":{\"revoke_unreserved\":\"撤回未使用权益\",\"protect_until_expiry\":\"保留至到期\"},\"fulfillmentKind\":{\"product\":\"商品\",\"benefit\":\"权益\",\"activity\":\"活动\",\"service\":\"服务\"},\"status\":{\"active\":\"启用\",\"paused\":\"暂停\",\"retired\":\"退役\"},\"stackingMode\":{\"stackable\":\"可叠加\",\"exclusive_highest\":\"同组取最高\",\"exclusive_first\":\"同组取最先\"},\"refundPolicy\":{\"reverse_on_any_refund\":\"任一退款冲回\",\"reverse_on_full_refund\":\"全额退款冲回\"},\"triggerKind\":{\"activity_payment\":\"付款成功\",\"activity_check_in\":\"完成签到\",\"activity_completion\":\"活动完成\"}}".utf8)) as! [String: [String: String]]
let membershipDefaultContents: [String: [String: Any]] = try! JSONSerialization.jsonObject(with: Data("{\"base_points\":{\"domain\":\"base_points\",\"pointsNumerator\":1,\"pointsDenominatorMinor\":100,\"growthNumerator\":1,\"growthDenominatorMinor\":100,\"roundingMode\":\"floor\",\"pointsValidityMonths\":12},\"tier_policy\":{\"domain\":\"tier_policy\",\"evaluationWindowMonths\":12,\"tierPeriodMonths\":12,\"downgradeGraceDays\":0,\"silverUpgradeGrowth\":0,\"silverRetainGrowth\":0,\"goldUpgradeGrowth\":0,\"goldRetainGrowth\":0,\"silverPointsMultiplierNumerator\":1,\"silverPointsMultiplierDenominator\":1,\"goldPointsMultiplierNumerator\":1,\"goldPointsMultiplierDenominator\":1},\"tier_benefits\":{\"domain\":\"tier_benefits\",\"tierPolicyVersionId\":\"\",\"rules\":[]},\"redemption_catalog\":{\"domain\":\"redemption_catalog\",\"items\":[]},\"promotion_points\":{\"domain\":\"promotion_points\",\"campaignCode\":\"\",\"name\":\"\",\"activityId\":\"\",\"stackingGroup\":\"\",\"stackingMode\":\"stackable\",\"priority\":0,\"storeBudgetPoints\":0,\"perMemberPointsLimit\":0,\"pointValidityDays\":30,\"refundPolicy\":\"reverse_on_any_refund\",\"budgetReuseAfterRefund\":false,\"memberLimitReuseAfterRefund\":false,\"eligibleMemberLevels\":[\"member\"],\"rules\":[]},\"membership_terms\":{\"domain\":\"membership_terms\",\"title\":\"\",\"summary\":\"\",\"content\":\"\"}}".utf8)) as! [String: [String: Any]]
let membershipDefaultItems: [String: [String: Any]] = try! JSONSerialization.jsonObject(with: Data("{\"tier_benefits\":{\"ruleCode\":\"\",\"eligibleTier\":\"member\",\"inheritToHigherTiers\":false,\"grantOnEntry\":true,\"grantOnRetention\":false,\"benefitDefinitionId\":\"\",\"quantity\":1,\"validityDays\":30,\"revocationPolicy\":\"revoke_unreserved\",\"enabled\":true},\"promotion_points\":{\"ruleCode\":\"\",\"triggerKind\":\"activity_payment\",\"points\":0,\"perMemberAwardLimit\":1,\"minimumPaidAmountMinor\":0,\"enabled\":true},\"redemption_catalog\":{\"publicId\":\"\",\"itemCode\":\"\",\"name\":\"\",\"fulfillmentKind\":\"product\",\"productId\":null,\"benefitDefinitionId\":null,\"activityId\":null,\"pointsRequired\":0,\"costAmountMinor\":0,\"currency\":\"CNY\",\"totalInventory\":null,\"dailyInventory\":null,\"memberDailyLimit\":1,\"memberRolling30DayLimit\":1,\"memberLifetimeLimit\":null,\"minimumTier\":\"member\",\"requiresTableSession\":true,\"requiresEmployeeFulfillment\":true,\"cancellationAllowedBeforeFulfillment\":true,\"restoreExpiredPointsDays\":0,\"availableFrom\":\"\",\"availableUntil\":null,\"fulfillmentTimeoutMinutes\":30,\"status\":\"active\"}}".utf8)) as! [String: [String: Any]]
let membershipNullableNumbers: Set<String> = ["totalInventory", "dailyInventory", "memberLifetimeLimit", "expiryLeadDays"]
let membershipMoneyFields: Set<String> = ["pointsDenominatorMinor", "growthDenominatorMinor", "costAmountMinor", "minimumPaidAmountMinor"]
let membershipNumericFields: Set<String> = membershipMoneyFields.union(membershipNullableNumbers).union(["pointsNumerator", "growthNumerator", "pointsValidityMonths", "evaluationWindowMonths", "tierPeriodMonths", "downgradeGraceDays", "silverUpgradeGrowth", "silverRetainGrowth", "goldUpgradeGrowth", "goldRetainGrowth", "silverPointsMultiplierNumerator", "silverPointsMultiplierDenominator", "goldPointsMultiplierNumerator", "goldPointsMultiplierDenominator", "quantity", "validityDays", "pointsRequired", "memberDailyLimit", "memberRolling30DayLimit", "restoreExpiredPointsDays", "fulfillmentTimeoutMinutes", "priority", "storeBudgetPoints", "perMemberPointsLimit", "pointValidityDays", "points", "perMemberAwardLimit", "maxPerCustomerPer24h", "minimumIntervalMinutes"])
let membershipReferenceFields: Set<String> = ["tierPolicyVersionId", "productId", "benefitDefinitionId", "activityId"]
let membershipNullableText: Set<String> = ["productId", "benefitDefinitionId", "activityId", "balanceDataKey", "expiresAtDataKey", "quietHoursStart", "quietHoursEnd", "availableUntil"]
func membershipData(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
func membershipEqual(_ first: [String: Any], _ second: [String: Any]) -> Bool { (try? membershipData(first)) == (try? membershipData(second)) }
func membershipText(_ value: Any?) -> String {
  if let text = value as? String { return text }
  if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() { return value.stringValue }
  return ""
}
func membershipLocal(_ value: String) throws -> String {
  guard let date = assignmentDate(value) else { throw StaffAPIError.invalid }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
  return f.string(from: date)
}
func membershipDate(_ value: String) throws -> String {
  if value.count == 16 { return try walletDateInput(value) }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; f.isLenient = false
  guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$", options: .regularExpression) != nil,
    let date = f.date(from: value), f.string(from: date) == value else { throw CatalogError("规则时间须为有效北京时间 YYYY-MM-DD HH:mm:ss") }
  return ISO8601DateFormatter().string(from: date)
}
func newMembershipContent(_ domain: String) throws -> [String: Any] {
  guard let content = membershipDefaultContents[domain] else { throw CatalogError("微信通知须选择后台托管的已有草稿") }
  return try membershipEditingContent(content)
}
func newMembershipItem(_ domain: String) throws -> [String: Any] {
  guard var item = membershipDefaultItems[domain] else { throw StaffAPIError.invalid }
  if domain == "redemption_catalog" { item["publicId"] = "RDI-" + UUID().uuidString.lowercased() }
  return try membershipEditingContent(item)
}
func membershipEditingContent(_ value: [String: Any]) throws -> [String: Any] {
  var result = value
  for (key, item) in value {
    if let child = item as? [String: Any] { result[key] = try membershipEditingContent(child) }
    else if let rows = item as? [[String: Any]] { result[key] = try rows.map(membershipEditingContent) }
    else if !(item is NSNull), membershipMoneyFields.contains(key) { result[key] = walletMoneyText(try walletInteger(item)) }
    else if ["availableFrom", "availableUntil"].contains(key), let text = item as? String, !text.isEmpty { result[key] = try membershipLocal(text) }
  }
  return result
}
func membershipNormalizeContent(_ value: [String: Any]) throws -> [String: Any] {
  var result = value
  for (key, item) in value {
    let raw = membershipText(item).trimmingCharacters(in: .whitespacesAndNewlines)
    if let child = item as? [String: Any] { result[key] = try membershipNormalizeContent(child) }
    else if let rows = item as? [[String: Any]] { result[key] = try rows.map(membershipNormalizeContent) }
    else if membershipNumericFields.contains(key) {
      if raw.isEmpty && membershipNullableNumbers.contains(key) { result[key] = NSNull() }
      else {
        let number: Int
        if membershipMoneyFields.contains(key) {
          guard raw.range(of: "^(0|[1-9][0-9]{0,7})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError((membershipFieldLabels[key] ?? "金额") + "格式无效") }
          let parts = raw.split(separator: ".").map(String.init)
          number = Int(parts[0])! * 100 + (parts.count == 2 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
        } else { number = try walletInteger(raw) }
        guard number <= 2_147_483_647 else { throw CatalogError((membershipFieldLabels[key] ?? "数字") + "超出范围") }
        result[key] = number
      }
    } else if ["availableFrom", "availableUntil"].contains(key) {
      result[key] = raw.isEmpty && key == "availableUntil" ? NSNull() : try membershipDate(raw) as Any
    } else if membershipNullableText.contains(key) { result[key] = raw.isEmpty ? NSNull() : raw as Any }
    else if item is String { result[key] = raw }
  }
  return result
}
func membershipContentSummary(_ value: [String: Any], references: [WalletRecord]) throws -> String {
  var lines: [String] = []
  for key in value.keys.sorted() where !["domain", "publicId", "currency"].contains(key) {
    let item = value[key]!, label = membershipFieldLabels[key] ?? membershipExtraLabels[key] ?? "规则内容"
    if let rows = item as? [[String: Any]] {
      lines.append("\(label)：\(rows.count)项")
      for (index, row) in rows.enumerated() { lines.append("第\(index + 1)项\n" + (try membershipContentSummary(row, references: references))) }
    } else if key == "eligibleMemberLevels", let values = item as? [String] {
      lines.append(label + "：" + values.map { membershipFieldChoices["eligibleTier"]?[$0] ?? "待核对" }.joined(separator: "、"))
    } else if item is NSNull { lines.append(label + "：未设置") }
    else if let boolean = item as? NSNumber, CFGetTypeID(boolean) == CFBooleanGetTypeID() { lines.append(label + "：" + (boolean.boolValue ? "是" : "否")) }
    else if membershipMoneyFields.contains(key) { lines.append(label + "：" + walletMoneyText(try walletInteger(item))) }
    else if membershipReferenceFields.contains(key) {
      let reference = references.first { $0.text("kind") == key && $0.id == membershipText(item) }
      lines.append(label + "：" + (reference?.text("name") ?? "原关联待核对"))
    } else { let raw = membershipText(item); lines.append(label + "：" + (membershipFieldChoices[key]?[raw] ?? raw)) }
  }
  return lines.joined(separator: "\n")
}

func validateMembershipContent(_ content: [String: Any]) throws {
  guard let domain = content["domain"] as? String else { throw StaffAPIError.invalid }
  let notificationKeys: Set<String> = ["domain", "notificationType", "authorizationPurpose", "authorizationContext", "templateId", "pagePath", "pointsDataKey", "balanceDataKey", "occurredAtDataKey", "expiresAtDataKey", "expiryLeadDays", "maxPerCustomerPer24h", "minimumIntervalMinutes", "quietHoursStart", "quietHoursEnd"]
  let expected = domain == "wechat_notifications" ? notificationKeys : Set(membershipDefaultContents[domain]?.keys.map { $0 } ?? [])
  guard !expected.isEmpty, Set(content.keys) == expected else { throw CatalogError("规则字段不完整或包含不支持的字段") }
  func number(_ row: [String: Any], _ key: String, positive: Bool = false) throws -> Int {
    let value = try walletInteger(row[key]); guard value <= 2_147_483_647, !positive || value > 0 else { throw CatalogError((membershipFieldLabels[key] ?? "数字") + "超出范围") }; return value
  }
  func text(_ row: [String: Any], _ key: String, min: Int = 1, max: Int = 200) throws -> String {
    guard let raw = row[key] as? String, (min...max).contains(raw.utf16.count), raw == raw.trimmingCharacters(in: .whitespacesAndNewlines) else { throw CatalogError((membershipFieldLabels[key] ?? "文字") + "未填写完整") }; return raw
  }
  func code(_ row: [String: Any], _ key: String) throws {
    guard try text(row, key, max: 128).range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil else { throw CatalogError("规则或兑换项编码格式无效") }
  }
  func choice(_ row: [String: Any], _ key: String) throws {
    guard let value = row[key] as? String, membershipFieldChoices[key]?[value] != nil else { throw CatalogError((membershipFieldLabels[key] ?? "选项") + "无效") }
  }
  func reference(_ row: [String: Any], _ key: String, optional: Bool = false) throws {
    if optional && row[key] is NSNull { return }
    guard let value = row[key] as? String, UUID(uuidString: value) != nil else { throw CatalogError((membershipFieldLabels[key] ?? "关联") + "尚未选择") }
  }
  func rows(_ key: String) throws -> [[String: Any]] {
    guard let rows = content[key] as? [[String: Any]], (1...200).contains(rows.count), let defaults = membershipDefaultItems[domain],
      rows.allSatisfy({ Set($0.keys) == Set(defaults.keys) }) else { throw CatalogError("规则明细须为1—200条完整内容") }
    for unique in domain == "redemption_catalog" ? ["itemCode", "publicId"] : ["ruleCode"] {
      let values = rows.compactMap { $0[unique] as? String }
      guard values.count == rows.count, Set(values).count == rows.count else { throw CatalogError("规则或兑换项编号重复") }
    }
    return rows
  }
  switch domain {
  case "base_points":
    for key in ["pointsNumerator", "growthNumerator"] { _ = try number(content, key) }
    for key in ["pointsDenominatorMinor", "growthDenominatorMinor", "pointsValidityMonths"] { _ = try number(content, key, positive: true) }
    guard try number(content, "pointsValidityMonths") <= 120 else { throw CatalogError("积分有效期须为1—120个月") }; try choice(content, "roundingMode")
  case "tier_policy":
    for key in content.keys where key != "domain" { _ = try number(content, key, positive: !["downgradeGraceDays", "silverRetainGrowth", "goldRetainGrowth"].contains(key)) }
    guard try number(content, "silverRetainGrowth") <= number(content, "silverUpgradeGrowth"),
      try number(content, "goldRetainGrowth") >= number(content, "silverRetainGrowth"),
      try number(content, "goldRetainGrowth") <= number(content, "goldUpgradeGrowth"),
      try number(content, "goldUpgradeGrowth") > number(content, "silverUpgradeGrowth") else { throw CatalogError("会员等级升级与保级门槛顺序无效") }
  case "tier_benefits":
    try reference(content, "tierPolicyVersionId")
    for row in try rows("rules") {
      try code(row, "ruleCode"); try choice(row, "eligibleTier"); try choice(row, "revocationPolicy"); try reference(row, "benefitDefinitionId")
      for key in ["quantity", "validityDays"] { _ = try number(row, key, positive: true) }
      for key in ["inheritToHigherTiers", "grantOnEntry", "grantOnRetention", "enabled"] { _ = try walletBoolean(row[key]) }
      guard try walletBoolean(row["grantOnEntry"]) || walletBoolean(row["grantOnRetention"]) else { throw CatalogError("权益须选择入级或保级发放") }
    }
  case "redemption_catalog":
    for row in try rows("items") {
      try code(row, "itemCode"); try code(row, "publicId"); _ = try text(row, "publicId", min: 8, max: 128); _ = try text(row, "name", min: 2, max: 120)
      for key in ["fulfillmentKind", "minimumTier", "status"] { try choice(row, key) }
      for key in ["pointsRequired", "memberDailyLimit", "memberRolling30DayLimit", "fulfillmentTimeoutMinutes"] { _ = try number(row, key, positive: true) }
      for key in ["costAmountMinor", "restoreExpiredPointsDays"] { _ = try number(row, key) }
      for key in ["totalInventory", "dailyInventory", "memberLifetimeLimit"] where !(row[key] is NSNull) { _ = try number(row, key, positive: key == "memberLifetimeLimit") }
      for key in ["requiresTableSession", "requiresEmployeeFulfillment", "cancellationAllowedBeforeFulfillment"] { _ = try walletBoolean(row[key]) }
      for key in ["productId", "benefitDefinitionId", "activityId"] { try reference(row, key, optional: true) }
      if let needed = ["product": "productId", "benefit": "benefitDefinitionId", "activity": "activityId"][row["fulfillmentKind"] as? String ?? ""] { try reference(row, needed) }
      guard row["currency"] as? String == "CNY", let start = assignmentDate(try text(row, "availableFrom")) else { throw CatalogError("币种或兑换开始时间无效") }
      if !(row["availableUntil"] is NSNull) { guard let end = assignmentDate(try text(row, "availableUntil")), end > start else { throw CatalogError("兑换结束时间须晚于开始") } }
    }
  case "promotion_points":
    for key in ["campaignCode", "stackingGroup"] { try code(content, key) }
    _ = try text(content, "name", min: 2, max: 80); try reference(content, "activityId")
    for key in ["stackingMode", "refundPolicy"] { try choice(content, key) }
    _ = try number(content, "priority")
    for key in ["storeBudgetPoints", "perMemberPointsLimit", "pointValidityDays"] { _ = try number(content, key, positive: true) }
    for key in ["budgetReuseAfterRefund", "memberLimitReuseAfterRefund"] { _ = try walletBoolean(content[key]) }
    guard let levels = content["eligibleMemberLevels"] as? [String], (1...3).contains(levels.count), Set(levels).count == levels.count,
      levels.allSatisfy({ membershipFieldChoices["eligibleTier"]?[$0] != nil }) else { throw CatalogError("请选择不重复的适用会员等级") }
    for row in try rows("rules") {
      try code(row, "ruleCode"); try choice(row, "triggerKind"); _ = try walletBoolean(row["enabled"])
      for key in ["points", "perMemberAwardLimit"] { _ = try number(row, key, positive: true) }
      let minimum = try number(row, "minimumPaidAmountMinor")
      guard row["triggerKind"] as? String == "activity_payment" || minimum == 0 else { throw CatalogError("非付款触发规则不能设置最低付款金额") }
    }
  case "membership_terms":
    _ = try text(content, "title", min: 2); _ = try text(content, "summary", min: 2, max: 2000); _ = try text(content, "content", min: 10, max: 50000)
  case "wechat_notifications":
    for key in ["notificationType", "authorizationPurpose", "authorizationContext"] { try choice(content, key) }
    _ = try text(content, "templateId", min: 8)
    guard try text(content, "pagePath", max: 500).range(of: "^pages/[A-Za-z0-9_./-]{1,180}$", options: .regularExpression) != nil else { throw CatalogError("微信通知页面路径无效") }
    for key in ["pointsDataKey", "balanceDataKey", "occurredAtDataKey", "expiresAtDataKey"] {
      if ["balanceDataKey", "expiresAtDataKey"].contains(key), content[key] is NSNull { continue }
      guard try text(content, key).range(of: "^[a-z][a-z0-9_]{1,31}$", options: .regularExpression) != nil else { throw CatalogError("微信模板数据字段无效") }
    }
    let type = content["notificationType"] as! String, expiring = type == "loyalty_points_expiring"
    let purpose = expiring ? "loyalty_expiry_reminder" : "loyalty_balance_change"
    let context = expiring ? "loyalty_expiry" : type == "loyalty_points_credited" ? "loyalty_accrual" : "loyalty_refund"
    guard content["authorizationPurpose"] as? String == purpose, content["authorizationContext"] as? String == context,
      expiring == !(content["expiryLeadDays"] is NSNull), expiring == !(content["expiresAtDataKey"] is NSNull),
      expiring == (content["balanceDataKey"] is NSNull) else { throw CatalogError("通知类型、授权用途或到期策略不一致") }
    if expiring { _ = try number(content, "expiryLeadDays", positive: true) }
    _ = try number(content, "maxPerCustomerPer24h", positive: true); _ = try number(content, "minimumIntervalMinutes")
    guard (content["quietHoursStart"] is NSNull) == (content["quietHoursEnd"] is NSNull) else { throw CatalogError("静默时间须同时设置开始和结束") }
    if !(content["quietHoursStart"] is NSNull) {
      let first = try text(content, "quietHoursStart"), last = try text(content, "quietHoursEnd")
      guard first != last, [first, last].allSatisfy({ $0.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$", options: .regularExpression) != nil }) else { throw CatalogError("静默时段无效") }
    }
  default: throw StaffAPIError.invalid
  }
}

// PostgreSQL returns timestamps/time fields in text form and orders rule rows by
// their immutable code. Compare business content, not transport formatting.
func membershipContentFingerprint(_ content: [String: Any]) throws -> String {
  func canonical(_ value: [String: Any]) throws -> [String: Any] {
    var result = value
    for (key, raw) in value {
      if let child = raw as? [String: Any] { result[key] = try canonical(child) }
      else if let rows = raw as? [[String: Any]] {
        let values = try rows.map(canonical)
        let sortKey = key == "items" ? "itemCode" : "ruleCode"
        result[key] = values.sorted { membershipText($0[sortKey]) < membershipText($1[sortKey]) }
      } else if key == "eligibleMemberLevels", let levels = raw as? [String] { result[key] = levels.sorted() }
      else if ["availableFrom", "availableUntil"].contains(key), let text = raw as? String {
        guard let date = assignmentDate(text) else { throw StaffAPIError.invalid }
        // Milliseconds preserve every instant accepted by the platform decoder.
        result[key] = Int64((date.timeIntervalSince1970 * 1000).rounded())
      } else if ["quietHoursStart", "quietHoursEnd"].contains(key), let text = raw as? String {
        result[key] = text.count == 5 ? text + ":00" : text
      }
    }
    return result
  }
  return SHA256.hash(data: try membershipData(canonical(content))).map { String(format: "%02x", $0) }.joined()
}
