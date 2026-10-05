import Foundation
struct MembershipOverviewRecord: Identifiable {
  let object: [String: Any]
  var id: String { text("id").isEmpty ? text("publicId") : text("id") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  func boolean(_ key: String) throws -> Bool { try walletBoolean(object[key]) }
}
struct MembershipOverview {
  let employeeID: String
  let points, tiers, benefits, catalog: [MembershipOverviewRecord]
  let controlState, controlReason: String
  init(points: Data, tiers: Data, benefits: Data, catalog: Data, actor: StaffIdentity) throws {
    guard actor.allows("loyalty.policy.view") else { throw StaffAPIError.invalid }
    func list(_ data: Data) throws -> [[String: Any]] {
      guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let rows = root["data"] as? [[String: Any]] else { throw StaffAPIError.invalid }; return rows
    }
    func published(_ rows: [[String: Any]]) throws -> [MembershipOverviewRecord] {
      let result = rows.filter { $0["status"] as? String == "published" }.map { MembershipOverviewRecord(object: $0) }
      guard Set(result.map(\.id)).count == result.count else { throw StaffAPIError.invalid }
      for r in result { guard UUID(uuidString: r.id) != nil, try r.integer("version") > 0, assignmentDate(r.text("effectiveFrom")) != nil,
        r.object["effectiveUntil"] is NSNull || assignmentDate(r.text("effectiveUntil")) != nil else { throw StaffAPIError.invalid } }
      return try result.sorted { try $0.integer("version") > $1.integer("version") }
    }
    employeeID = actor.employee.id; self.points = try published(list(points)); self.tiers = try published(list(tiers))
    let b = try walletEnvelope(benefits), c = try walletEnvelope(catalog)
    guard let policies = b["policies"] as? [[String: Any]], let items = c["items"] as? [[String: Any]], let control = c["control"] as? [String: Any], let state = control["state"] as? String else { throw StaffAPIError.invalid }
    self.benefits = try published(policies); self.catalog = items.filter { $0["catalogStatus"] as? String == "published" }.map { MembershipOverviewRecord(object: $0) }
    guard Set(self.catalog.map(\.id)).count == self.catalog.count else { throw StaffAPIError.invalid }
    controlState = state; controlReason = control["reason"] as? String ?? ""
    for r in self.points {
      for key in ["pointsNumerator", "growthNumerator"] { _ = try r.integer(key) }
      for key in ["pointsDenominatorMinor", "growthDenominatorMinor", "pointsValidityMonths"] { guard try r.integer(key) > 0 else { throw StaffAPIError.invalid } }
    }
    for r in self.tiers {
      for key in ["evaluationWindowMonths", "tierPeriodMonths", "downgradeGraceDays", "silverUpgradeGrowth", "silverRetainGrowth", "goldUpgradeGrowth", "goldRetainGrowth"] { _ = try r.integer(key) }
      for tier in ["silver", "gold"] { _ = try membershipOverviewRatio(r, tier + "PointsMultiplierNumerator", tier + "PointsMultiplierDenominator") }
    }
    for r in self.benefits {
      _ = try r.integer("tierPolicyVersion")
      guard let rules = r.object["rules"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      for value in rules {
        let item = MembershipOverviewRecord(object: value)
        for key in ["quantity", "validityDays"] { _ = try item.integer(key) }
        for key in ["enabled", "inheritToHigherTiers", "grantOnEntry", "grantOnRetention"] { _ = try item.boolean(key) }
      }
    }
    for r in self.catalog {
      guard !r.id.isEmpty, assignmentDate(r.text("availableFrom")) != nil else { throw StaffAPIError.invalid }
      for key in ["pointsRequired", "catalogVersion", "memberDailyLimit", "memberRolling30DayLimit", "fulfillmentTimeoutMinutes", "restoreExpiredPointsDays"] { _ = try r.integer(key) }
      for key in ["totalInventory", "dailyInventory", "memberLifetimeLimit"] where !(r.object[key] is NSNull) { _ = try r.integer(key) }
      for key in ["requiresTableSession", "requiresEmployeeFulfillment", "cancellationAllowedBeforeFulfillment"] { _ = try r.boolean(key) }
    }
  }
}
func membershipOverviewEffective(_ row: MembershipOverviewRecord, now: Date = Date()) -> String {
  guard row.text("status") == "published" else { return "未发布" }
  guard let start = assignmentDate(row.text("effectiveFrom")) else { return "生效时间待核对" }
  if now < start { return "已发布 · 待生效" }
  if let end = assignmentDate(row.text("effectiveUntil")), now >= end { return "历史已结束" }
  return "生效时段内"
}
func membershipOverviewRatio(_ row: MembershipOverviewRecord, _ numerator: String, _ denominator: String) throws -> String {
  let n = try row.integer(numerator), d = try row.integer(denominator)
  guard d > 0 else { throw StaffAPIError.invalid }; return "\(n) / \(d)"
}
func membershipOverviewSummary(_ row: MembershipOverviewRecord, section: String) throws -> String {
  func count(_ key: String) throws -> String { String(try row.integer(key)) }
  func flag(_ key: String, _ yes: String, _ no: String) throws -> String { try row.boolean(key) ? yes : no }
  var lines: [String] = []
  if section != "catalog" { lines = ["第\(try count("version"))版 · " + membershipOverviewEffective(row), "生效：" + (try membershipLocal(row.text("effectiveFrom"))) + " 至 " + ((try? membershipLocal(row.text("effectiveUntil"))) ?? "未设置结束时间"), "依据：" + row.text("reason")] }
  switch section {
  case "points":
    for (key, name) in [("points", "积分"), ("growth", "成长值")] { lines.append("每" + walletMoneyText(try row.integer(key + "DenominatorMinor")) + "元符合条件消费获得 " + (try count(key + "Numerator")) + " " + name) }
    lines.append("积分有效期：" + (try count("pointsValidityMonths")) + "个月")
    lines.append("取整：" + (["floor": "向下取整", "half_up": "四舍五入", "nearest": "四舍五入"][row.text("roundingMode")] ?? "请核对原取整方式"))
  case "tiers":
    lines.append("评估窗口：" + (try count("evaluationWindowMonths")) + "个月 · 等级周期：" + (try count("tierPeriodMonths")) + "个月 · 降级宽限：" + (try count("downgradeGraceDays")) + "天")
    for (key, name) in [("silver", "银卡"), ("gold", "金卡")] { lines.append(name + "：升级" + (try count(key + "UpgradeGrowth")) + "成长值 · 保级" + (try count(key + "RetainGrowth")) + "成长值\n积分倍率：" + (try membershipOverviewRatio(row, key + "PointsMultiplierNumerator", key + "PointsMultiplierDenominator"))) }
  case "benefits":
    lines.append("关联等级政策第" + (try count("tierPolicyVersion")) + "版")
    for raw in row.object["rules"] as? [[String: Any]] ?? [] {
      let r = MembershipOverviewRecord(object: raw)
      lines.append((r.text("benefitName").isEmpty ? "权益定义待核对" : r.text("benefitName")) + " · " + (try r.boolean("enabled") ? "启用" : "停用"))
      lines.append((membershipFieldChoices["eligibleTier"]?[r.text("eligibleTier")] ?? "等级待核对") + (try r.boolean("inheritToHigherTiers") ? "及更高等级" : "限定等级") + " · \(try r.integer("quantity"))份 · 有效\(try r.integer("validityDays"))天")
      var moments: [String] = []; if try r.boolean("grantOnEntry") { moments.append("进入等级") }; if try r.boolean("grantOnRetention") { moments.append("保级") }
      lines.append("发放时机：" + moments.joined(separator: "、")); lines.append(r.text("revocationPolicy") == "protect_until_expiry" ? "降级后保护到到期" : "降级后撤销未预留权益")
    }
  case "catalog":
    lines += [row.text("name") + " · " + (try count("pointsRequired")) + "积分", "目录第" + (try count("catalogVersion")) + "版 · " + (membershipFieldChoices["minimumTier"]?[row.text("minimumTier")] ?? "等级待核对") + "起", row.text("status") == "active" ? "兑换项启用" : "兑换项停用", "可用：" + (try membershipLocal(row.text("availableFrom"))) + " 至 " + ((try? membershipLocal(row.text("availableUntil"))) ?? "未设置结束")]
    for (key, label) in [("totalInventory", "总库存上限"), ("dailyInventory", "每日库存上限"), ("memberDailyLimit", "每会员每日"), ("memberRolling30DayLimit", "每会员滚动30天"), ("memberLifetimeLimit", "每会员累计")] { lines.append(label + "：" + (row.object[key] is NSNull ? "不限" : try count(key))) }
    lines += [try flag("requiresTableSession", "需要在桌", "无需在桌"), try flag("requiresEmployeeFulfillment", "员工确认交付", "按原系统自动履约"), try flag("cancellationAllowedBeforeFulfillment", "交付前允许取消", "交付前不可自行取消"), "履约时限：" + (try count("fulfillmentTimeoutMinutes")) + "分钟 · 退回过期积分保留：" + (try count("restoreExpiredPointsDays")) + "天"]
  default: throw StaffAPIError.invalid
  }
  return lines.joined(separator: "\n")
}
