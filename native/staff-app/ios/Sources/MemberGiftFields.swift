import Foundation

let giftFieldLabels = ["code": "活动编号", "name": "活动名称", "availableFrom": "开始发放（北京时间）", "availableUntil": "结束发放（北京时间）", "quantityPerCustomer": "每人份数", "maximumQuantity": "活动总份数上限", "maximumDailyQuantity": "每日总份数上限", "maximumCostMinor": "活动总成本预算（元）", "maximumDailyCostMinor": "每日成本预算（元）", "maximumUnitCostMinor": "每份最高成本（元）", "fixedPriceMinor": "每份兑换价（元）", "budgetCutoff": "预算换日时刻 HH:mm", "reason": "实际核对原因"]
let giftMoneyFields = ["fixedPriceMinor", "maximumCostMinor", "maximumDailyCostMinor", "maximumUnitCostMinor"]
let giftChoices = ["trigger": ["targeted": "选择会员定向发放", "card_entry": "真实入卡审核后触发"], "pricingKind": ["free": "免费赠品", "fixed_price": "固定兑换价"], "budgetDateBasis": ["natural": "自然日", "business": "营业日"], "minimumTier": ["": "不限制等级", "member": "会员", "silver": "银卡", "gold": "金卡", "black": "黑卡"], "cardMatch": ["any": "任一张", "all": "全部"], "tierAndCards": ["and": "同时满足", "or": "满足任一"]]
let giftMetrics = ["issued": "已发份数", "redeemed": "甜点已核销份数", "remaining": "剩余份数", "cost": "已发承诺成本"]
let giftPickLabels = ["couponCalendarVersionId": "券日历版本", "productIds": "可兑换商品池", "dessertProductId": "组合甜点", "cardCodes": "人群兴趣卡", "cardProjectId": "入卡项目", "stackingVersionId": "叠加价格规则"]
let giftPickKinds = ["couponCalendarVersionId": "calendars", "productIds": "products", "dessertProductId": "products", "cardCodes": "audience-cards", "cardProjectId": "projects", "stackingVersionId": "stacking"]
func giftMoney(_ value: String) throws -> Int {
  let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard raw.range(of: "^(0|[1-9][0-9]{0,13})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError("人民币金额须为非负数，最多两位小数") }
  let parts = raw.split(separator: ".").map(String.init)
  guard let whole = Int(parts[0]) else { throw StaffAPIError.invalid }
  let cents = whole * 100 + (parts.count > 1 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
  guard cents <= 9_007_199_254_740_991 else { throw CatalogError("金额超出精确整数范围") }; return cents
}
func giftMinute(_ text: String) throws -> Int {
  guard text.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil else { throw CatalogError("预算换日须为有效HH:mm") }
  let values = text.split(separator: ":").compactMap { Int($0) }; return values[0] * 60 + values[1]
}
func giftClock(_ value: Int) -> String { String(format: "%02d:%02d", value / 60, value % 60) }
func memberGiftOriginalNames(_ row: GiftRecord) -> [String: String] {
  var result: [String: String] = [:]
  for item in row.object["products"] as? [[String: Any]] ?? [] { if let id = item["product_id"] as? String, let name = item["name"] as? String { result[id] = name } }
  if let calendar = row.rule["couponCalendarVersionId"] as? String { result[calendar] = row.text("calendar_code") + " · 第" + row.text("calendar_version") + "版" }
  if let project = row.rule["cardProjectId"] as? String { result[project] = row.text("card_project_name") }
  return result
}
struct MemberGiftDraft {
  let originalID: String?
  let originalCode: String
  let originalVersion: Int
  var fields: [String: String]
  var selected: [String: [String]]
  var names: [String: String]
  init(row: GiftRecord? = nil) throws {
    originalID = row?.id; originalCode = row?.text("code") ?? ""; originalVersion = try row.map { try $0.integer("version") } ?? 0
    let rule = row?.rule ?? [:], audience = rule["audience"] as? [String: Any] ?? [:]
    fields = ["code": originalCode, "name": row?.text("name") ?? "", "trigger": rule["trigger"] as? String ?? "targeted", "pricingKind": rule["pricingKind"] as? String ?? "free", "budgetDateBasis": rule["budgetDateBasis"] as? String ?? "natural", "budgetCutoff": giftClock((try? walletInteger(rule["budgetDayStartMinute"])) ?? 0), "minimumTier": audience["minimumTier"] as? String ?? "", "cardMatch": audience["cardMatch"] as? String ?? "any", "tierAndCards": audience["tierAndCards"] as? String ?? "and", "reason": ""]
    for key in ["availableFrom", "availableUntil"] { fields[key] = try (rule[key] as? String).map(membershipLocal) ?? "" }
    for key in ["quantityPerCustomer", "maximumQuantity", "maximumDailyQuantity"] { fields[key] = rule[key].map(membershipText) ?? (key == "quantityPerCustomer" ? "1" : "") }
    for key in giftMoneyFields { fields[key] = rule[key] == nil || rule[key] is NSNull ? "" : walletMoneyText(try walletInteger(rule[key])) }
    selected = ["productIds": rule["productIds"] as? [String] ?? [], "cardCodes": audience["cardCodes"] as? [String] ?? [], "highlightMetrics": rule["highlightMetrics"] as? [String] ?? ["issued", "redeemed", "remaining"]]
    for key in ["couponCalendarVersionId", "stackingVersionId", "cardProjectId", "dessertProductId"] { selected[key] = (rule[key] as? String).map { [$0] } ?? [] }
    names = row.map(memberGiftOriginalNames) ?? [:]
  }
  func body() throws -> [String: Any] {
    let f = fields.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    let code = f["code"] ?? "", name = f["name"] ?? ""
    guard code.range(of: "^[A-Z][A-Z0-9_]{1,39}$", options: .regularExpression) != nil, (2...120).contains(name.utf16.count) else { throw CatalogError("活动编号须2—40位大写字母数字下划线，名称须2—120字") }
    let trigger = f["trigger"] ?? "", pricing = f["pricingKind"] ?? "", basis = f["budgetDateBasis"] ?? ""
    var rule: [String: Any] = ["trigger": trigger, "pricingKind": pricing, "cardProjectId": trigger == "card_entry" ? (selected["cardProjectId"]?.first ?? "") as Any : NSNull(), "couponCalendarVersionId": selected["couponCalendarVersionId"]?.first ?? "", "fixedPriceMinor": pricing == "fixed_price" ? try giftMoney(f["fixedPriceMinor"] ?? "") as Any : NSNull(), "stackingVersionId": pricing == "fixed_price" ? (selected["stackingVersionId"]?.first ?? "") as Any : NSNull(), "currency": "CNY", "budgetDateBasis": basis, "budgetDayStartMinute": basis == "natural" ? 0 : try giftMinute(f["budgetCutoff"] ?? ""), "availableFrom": try membershipDate(f["availableFrom"] ?? ""), "availableUntil": try membershipDate(f["availableUntil"] ?? ""), "productIds": selected["productIds"] ?? [], "highlightMetrics": selected["highlightMetrics"] ?? []]
    for key in ["quantityPerCustomer", "maximumQuantity", "maximumDailyQuantity"] { rule[key] = try walletInteger(f[key]) }
    for key in giftMoneyFields where key != "fixedPriceMinor" { rule[key] = try giftMoney(f[key] ?? "") }
    if let dessert = selected["dessertProductId"]?.first { rule["dessertProductId"] = dessert }
    rule["audience"] = ["minimumTier": (f["minimumTier"] ?? "").isEmpty ? NSNull() : f["minimumTier"]! as Any, "cardCodes": selected["cardCodes"] ?? [], "cardMatch": f["cardMatch"] ?? "", "tierAndCards": f["tierAndCards"] ?? ""]
    try validateMemberGiftRule(rule)
    return ["code": code, "name": name, "rule": rule, "expectedVersion": code == originalCode ? originalVersion : 0, "reason": f["reason"] ?? ""]
  }
}
func validateMemberGiftRule(_ rule: [String: Any]) throws {
  let required: Set<String> = ["trigger", "cardProjectId", "pricingKind", "fixedPriceMinor", "stackingVersionId", "audience", "quantityPerCustomer", "maximumQuantity", "maximumDailyQuantity", "maximumCostMinor", "maximumDailyCostMinor", "maximumUnitCostMinor", "currency", "budgetDateBasis", "budgetDayStartMinute", "availableFrom", "availableUntil", "couponCalendarVersionId", "productIds"]
  guard required.isSubset(of: Set(rule.keys)), Set(rule.keys).subtracting(required).isSubset(of: ["dessertProductId", "highlightMetrics"]) else { throw CatalogError("赠礼规则字段不完整或不支持") }
  func id(_ key: String) throws { guard UUID(uuidString: rule[key] as? String ?? "") != nil else { throw CatalogError((giftPickLabels[key] ?? "关联规则") + "尚未选择") } }
  let trigger = rule["trigger"] as? String ?? "", pricing = rule["pricingKind"] as? String ?? "", basis = rule["budgetDateBasis"] as? String ?? ""
  guard giftChoices["trigger"]?[trigger] != nil, giftChoices["pricingKind"]?[pricing] != nil, giftChoices["budgetDateBasis"]?[basis] != nil, rule["currency"] as? String == "CNY" else { throw StaffAPIError.invalid }
  if trigger == "card_entry" { try id("cardProjectId") } else { guard rule["cardProjectId"] is NSNull else { throw CatalogError("定向活动不能冒用入卡触发") } }
  if pricing == "fixed_price" { try id("stackingVersionId"); guard try walletInteger(rule["fixedPriceMinor"]) > 0 else { throw CatalogError("固定兑换价须大于零") } }
  else { guard rule["fixedPriceMinor"] is NSNull, rule["stackingVersionId"] is NSNull else { throw CatalogError("免费赠品不能同时设置兑换价") } }
  try id("couponCalendarVersionId")
  guard let products = rule["productIds"] as? [String], (1...100).contains(products.count), Set(products).count == products.count, products.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw CatalogError("请选择1—100种不重复商品") }
  let per = try walletInteger(rule["quantityPerCustomer"]), daily = try walletInteger(rule["maximumDailyQuantity"]), total = try walletInteger(rule["maximumQuantity"])
  guard (1...100).contains(per), (1...1_000_000).contains(daily), (1...1_000_000).contains(total), per <= daily, daily <= total else { throw CatalogError("每人、每日和活动份数上限矛盾") }
  for key in giftMoneyFields where key != "fixedPriceMinor" { _ = try walletInteger(rule[key]) }
  guard try walletInteger(rule["maximumDailyCostMinor"]) <= walletInteger(rule["maximumCostMinor"]) else { throw CatalogError("每日成本不得超过总预算") }
  let minute = try walletInteger(rule["budgetDayStartMinute"])
  guard minute <= 1439, basis != "natural" || minute == 0 else { throw CatalogError("自然日须零点换日") }
  guard let start = assignmentDate(membershipText(rule["availableFrom"])), let end = assignmentDate(membershipText(rule["availableUntil"])), end > start else { throw CatalogError("结束时间须晚于开始") }
  guard let a = rule["audience"] as? [String: Any], Set(a.keys) == ["minimumTier", "cardCodes", "cardMatch", "tierAndCards"],
    let cards = a["cardCodes"] as? [String], cards.count <= 100, Set(cards).count == cards.count,
    cards.allSatisfy({ $0.range(of: "^[A-Z][A-Z0-9_]{1,39}$", options: .regularExpression) != nil }),
    ["any", "all"].contains(a["cardMatch"] as? String ?? ""), ["and", "or"].contains(a["tierAndCards"] as? String ?? ""),
    a["minimumTier"] is NSNull || ["member", "silver", "gold", "black"].contains(a["minimumTier"] as? String ?? ""),
    !(a["minimumTier"] is NSNull) || !cards.isEmpty else { throw CatalogError("须明确有效会员等级或兴趣卡人群；空条件不能全量发放") }
  if !(rule["dessertProductId"] == nil || rule["dessertProductId"] is NSNull) { try id("dessertProductId"); guard per == 1 else { throw CatalogError("组合赠礼每人限一套") } }
  if let metrics = rule["highlightMetrics"] { guard let list = metrics as? [String], Set(list).count == list.count, list.allSatisfy({ giftMetrics[$0] != nil }) else { throw StaffAPIError.invalid } }
}
func memberGiftCanonical(_ rule: [String: Any]) throws -> Data {
  try validateMemberGiftRule(rule)
  var c = rule
  for key in ["availableFrom", "availableUntil"] { c[key] = Int64((assignmentDate(membershipText(rule[key]))!.timeIntervalSince1970 * 1000).rounded()) }
  if c["dessertProductId"] is NSNull { c.removeValue(forKey: "dessertProductId") }
  c["productIds"] = (rule["productIds"] as! [String]).sorted()
  var audience = rule["audience"] as! [String: Any]; audience["cardCodes"] = (audience["cardCodes"] as! [String]).sorted(); c["audience"] = audience
  c["highlightMetrics"] = (rule["highlightMetrics"] as? [String] ?? ["issued", "redeemed", "remaining"]).sorted()
  return try membershipData(c)
}
func memberGiftRuleSummary(_ rule: [String: Any], names: [String: String]) throws -> String {
  try validateMemberGiftRule(rule)
  func ref(_ key: String) -> String { let value = rule[key] as? String ?? ""; return names[value].flatMap { $0.isEmpty ? nil : $0 } ?? "原绑定版本：" + value }
  let audience = rule["audience"] as! [String: Any], cards = audience["cardCodes"] as! [String], metrics = rule["highlightMetrics"] as? [String] ?? ["issued", "redeemed", "remaining"]
  var lines = [giftChoices["trigger"]![rule["trigger"] as! String]!, giftChoices["pricingKind"]![rule["pricingKind"] as! String]!, "发放：" + (try membershipLocal(rule["availableFrom"] as! String)) + " 至 " + (try membershipLocal(rule["availableUntil"] as! String)), "券日历：" + ref("couponCalendarVersionId"), "商品池：" + (rule["productIds"] as! [String]).map { names[$0] ?? "原选商品编号：" + $0 }.joined(separator: "、")]
  if rule["pricingKind"] as? String == "fixed_price" { lines += ["每份兑换价：" + walletMoneyText(try walletInteger(rule["fixedPriceMinor"])) + "元", "叠加价格规则：" + ref("stackingVersionId")] }
  if rule["trigger"] as? String == "card_entry" { lines.append("入卡项目：" + ref("cardProjectId")) }
  if rule["dessertProductId"] is String { lines.append("组合甜点：" + ref("dessertProductId")) }
  for key in ["quantityPerCustomer", "maximumDailyQuantity", "maximumQuantity"] { lines.append(giftFieldLabels[key]! + "：\(try walletInteger(rule[key]))") }
  for key in ["maximumUnitCostMinor", "maximumDailyCostMinor", "maximumCostMinor"] { lines.append(giftFieldLabels[key]! + "：" + walletMoneyText(try walletInteger(rule[key]))) }
  let basis = giftChoices["budgetDateBasis"]![rule["budgetDateBasis"] as! String]!
  let cutoff = giftClock(try walletInteger(rule["budgetDayStartMinute"]))
  lines.append("预算按" + basis + "，北京时间" + cutoff + "换日")
  lines.append("最低等级：" + giftChoices["minimumTier"]![audience["minimumTier"] as? String ?? ""]!)
  let cardNames = cards.isEmpty ? "不限" : cards.map { names[$0] ?? $0 }.joined(separator: "、")
  lines.append("兴趣卡：" + cardNames + " · " + giftChoices["cardMatch"]![audience["cardMatch"] as! String]!)
  lines.append("等级与兴趣卡：" + giftChoices["tierAndCards"]![audience["tierAndCards"] as! String]!)
  lines.append("展示统计：" + metrics.map { giftMetrics[$0]! }.joined(separator: "、"))
  lines.append("预算为待兑现成本承诺，并非销售额；0元预算不是不限额，成本未知时后台拒绝发券。")
  return lines.joined(separator: "\n")
}
