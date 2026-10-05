import Foundation
import CoreFoundation
let stackingSwitches = [("allowMemberPrice", "允许与会员价叠加"), ("allowBundlePrice", "允许用于套餐价商品"), ("allowCheckoutUpgrade", "允许用于升级套餐"), ("allowOtherCoupons", "允许多张优惠券叠加"), ("allowPoints", "允许与积分抵扣叠加")]
let stackingStages = ["member": "会员价", "coupon": "优惠券", "points": "积分"]
let stackingOrders = [["member", "coupon", "points"], ["member", "points", "coupon"], ["coupon", "member", "points"], ["coupon", "points", "member"], ["points", "member", "coupon"], ["points", "coupon", "member"]]
let stackingKinds = [("fixed_price", "固定兑换价"), ("amount_off", "减免金额"), ("rate", "实付比例"), ("free", "免费")]
func couponPolicyMoney(_ input: String) throws -> Int {
  let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
  guard text.range(of: "^(0|[1-9][0-9]{0,13})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError("人民币金额须为非负数且最多两位小数") }
  let p = text.split(separator: ".").map(String.init), cents = Int(p[0])! * 100 + (p.count > 1 ? Int(p[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
  guard cents <= 9_007_199_254_740_991 else { throw CatalogError("金额超出精确整数范围") }; return cents
}
func stackingPolicy(_ input: [String: Any]) throws -> [String: Any] {
  var result: [String: Any] = [:]
  for (key, _) in stackingSwitches { result[key] = key == "allowCheckoutUpgrade" && input[key] == nil ? false : try walletBoolean(input[key]) }
  let count = try couponPolicyInteger(input["maxCoupons"], 1...10)
  guard (result["allowOtherCoupons"] as! Bool) || count == 1, let order = input["calculationOrder"] as? [String], stackingOrders.contains(order) else { throw CatalogError("禁止叠券时最多一张；顺序须包含会员价、优惠券和积分各一次") }
  result["maxCoupons"] = count; result["calculationOrder"] = order
  result["maximumDiscountMinor"] = input["maximumDiscountMinor"] is NSNull ? NSNull() : try walletInteger(input["maximumDiscountMinor"]) as Any
  result["minimumPayableMinor"] = try walletInteger(input["minimumPayableMinor"]); return result
}
func stackingPolicySummary(_ input: [String: Any]) throws -> String {
  let p = try stackingPolicy(input)
  var lines = stackingSwitches.map { key, label in label + "：" + ((p[key] as! Bool) ? "是" : "否") }
  lines += ["最多使用 " + membershipText(p["maxCoupons"]) + " 张券", "计算顺序：" + (p["calculationOrder"] as! [String]).map { stackingStages[$0]! }.joined(separator: " → "), "总优惠上限：" + (p["maximumDiscountMinor"] is NSNull ? "不额外限制" : "¥" + walletMoneyText(try walletInteger(p["maximumDiscountMinor"]))), "最低实付：¥" + walletMoneyText(try walletInteger(p["minimumPayableMinor"]))]
  return lines.joined(separator: "\n")
}
struct StackingPolicyDraft: Equatable {
  var fields: [String: String]
  var switches: [String: Bool]
  init(row: CouponPolicyRecord? = nil) {
    let p = row?.object["policy"] as? [String: Any] ?? [:]
    fields = ["code": row?.text("code") ?? "", "maxCoupons": membershipText(p["maxCoupons"]).isEmpty ? "1" : membershipText(p["maxCoupons"]), "order": (p["calculationOrder"] as? [String] ?? stackingOrders[0]).joined(separator: ","), "maximumDiscountMinor": (try? walletInteger(p["maximumDiscountMinor"])).map(walletMoneyText) ?? "", "minimumPayableMinor": walletMoneyText((try? walletInteger(p["minimumPayableMinor"])) ?? 0), "reason": ""]
    switches = Dictionary(uniqueKeysWithValues: stackingSwitches.map { ($0.0, (try? walletBoolean(p[$0.0])) ?? false) })
  }
  func policy() throws -> [String: Any] {
    var p = switches.mapValues { $0 as Any }
    p["maxCoupons"] = try walletInteger(fields["maxCoupons"]); p["calculationOrder"] = (fields["order"] ?? "").split(separator: ",").map(String.init)
    p["maximumDiscountMinor"] = (fields["maximumDiscountMinor"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : try couponPolicyMoney(fields["maximumDiscountMinor"]!) as Any
    p["minimumPayableMinor"] = try couponPolicyMoney(fields["minimumPayableMinor"] ?? ""); return try stackingPolicy(p)
  }
  func save(row: CouponPolicyRecord?) throws -> [String: Any] {
    let code = try couponPolicyCode(fields["code"] ?? "")
    return ["code": code, "expectedVersion": row?.text("code") == code ? try row!.integer("version") : 0, "policy": try policy(), "reason": try couponPolicyReason(fields["reason"] ?? "")]
  }
}
struct StackingUnitDraft: Identifiable, Equatable { let id = UUID().uuidString.lowercased(); var amount = ""; var cost = ""; var bundle = false; var upgraded = false }
struct StackingEffectDraft: Identifiable, Equatable { let id = UUID().uuidString.lowercased(); var stage = "coupon"; var kind = "amount_off"; var value = ""; var minimumSpend = "0"; var unitIDs: Set<String> = [] }
func stackingScenario(units: [StackingUnitDraft], effects: [StackingEffectDraft]) throws -> [String: Any] {
  guard (1...100).contains(units.count), effects.count <= 20, Set(units.map(\.id)).count == units.count, Set(effects.map(\.id)).count == effects.count,
    effects.filter({ $0.stage == "member" }).count <= 1, effects.filter({ $0.stage == "points" }).count <= 1 else { throw CatalogError("模拟须为1至100份商品、最多20项优惠；会员价和积分各一项") }
  let parsed = try units.map { u -> [String: Any] in ["id": u.id, "amountMinor": try couponPolicyMoney(u.amount), "costMinor": u.cost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : try couponPolicyMoney(u.cost) as Any, "bundle": u.bundle, "upgraded": u.upgraded] }
  let ids = Set(units.map(\.id))
  let discounts = try effects.map { e -> [String: Any] in
    guard stackingStages[e.stage] != nil, stackingKinds.contains(where: { $0.0 == e.kind }), e.stage != "points" || e.kind == "amount_off", e.stage != "member" || ["rate", "fixed_price"].contains(e.kind),
      !e.unitIDs.isEmpty, e.unitIDs.isSubset(of: ids), !["fixed_price", "free"].contains(e.kind) || e.unitIDs.count == 1 else { throw CatalogError("请核对优惠方式及仍存在的适用商品；固定价或免费只能一份") }
    let value = e.kind == "free" ? 0 : try couponPolicyMoney(e.value)
    guard e.kind != "rate" || value <= 10_000 else { throw CatalogError("实付比例须0至100%，80表示八折") }
    return ["id": e.id, "stage": e.stage, "kind": e.kind, "value": value, "minimumSpendMinor": try couponPolicyMoney(e.minimumSpend), "unitIds": e.unitIDs.sorted()]
  }
  return ["units": parsed, "effects": discounts]
}
private func stackingSignedInteger(_ value: Any?) throws -> Int {
  guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.stringValue.range(of: "^-?(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
    let result = Int(n.stringValue), (-9_007_199_254_740_991...9_007_199_254_740_991).contains(result) else { throw StaffAPIError.invalid }; return result
}
func stackingMoneyText(_ amount: Int) -> String { amount < 0 ? "-" + walletMoneyText(-amount) : walletMoneyText(amount) }
struct StackingPolicyPreview {
  let data: Data
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  init(data: Data, actor: StaffIdentity, body: [String: Any]) throws {
    let d = try walletEnvelope(data)
    guard actor.allows(CouponPolicyKind.stacking.previewPermission), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, try walletBoolean(d["previewOnly"]), try !walletBoolean(d["orderAuthorization"]), d["currency"] as? String == "CNY",
      let scenario = body["scenario"] as? [String: Any], let units = scenario["units"] as? [[String: Any]], let effects = scenario["effects"] as? [[String: Any]],
      let result = d["units"] as? [[String: Any]], let steps = d["steps"] as? [[String: Any]], result.count == units.count, steps.count == effects.count,
      let rawPolicy = body["policy"] as? [String: Any] else { throw StaffAPIError.invalid }
    let policy = try stackingPolicy(rawPolicy), subtotal = try walletInteger(d["subtotalMinor"]), discount = try walletInteger(d["discountMinor"]), payable = try walletInteger(d["payableMinor"])
    guard subtotal == (try units.reduce(0) { $0 + (try walletInteger($1["amountMinor"])) }), discount <= subtotal, payable == subtotal - discount,
      payable >= (try walletInteger(policy["minimumPayableMinor"])), try (policy["maximumDiscountMinor"] is NSNull || discount <= walletInteger(policy["maximumDiscountMinor"])) else { throw CatalogError("模拟金额与原份次或规则限制不一致") }
    var seen = Set<String>(), perUnit = 0
    for row in result {
      guard let id = row["id"] as? String, seen.insert(id).inserted, let source = units.first(where: { $0["id"] as? String == id }) else { throw StaffAPIError.invalid }
      let original = try walletInteger(row["originalMinor"]), off = try walletInteger(row["discountMinor"]), due = try walletInteger(row["payableMinor"])
      guard original == (try walletInteger(source["amountMinor"])), off <= original, due == original - off else { throw StaffAPIError.invalid }; perUnit += due
    }
    guard perUnit == payable else { throw StaffAPIError.invalid }
    if units.contains(where: { $0["costMinor"] is NSNull }) { guard d["costMinor"] is NSNull, d["grossProfitMinor"] is NSNull else { throw CatalogError("未知成本不能被当作零") } }
    else { let cost = try units.reduce(0) { $0 + (try walletInteger($1["costMinor"])) }; guard try walletInteger(d["costMinor"]) == cost, try stackingSignedInteger(d["grossProfitMinor"]) == payable - cost else { throw StaffAPIError.invalid } }
    let order = policy["calculationOrder"] as! [String], expected = order.flatMap { stage in effects.filter { $0["stage"] as? String == stage } }
    var remaining = subtotal
    for (index, step) in steps.enumerated() {
      let original = expected[index]
      guard step["effectId"] as? String == original["id"] as? String, step["stage"] as? String == original["stage"] as? String,
        step["kind"] as? String == original["kind"] as? String, let allocations = step["allocations"] as? [[String: Any]], let targets = original["unitIds"] as? [String],
        Set(allocations.map { membershipText($0["unitId"]) }) == Set(targets), allocations.count == targets.count else { throw StaffAPIError.invalid }
      let off = try walletInteger(step["discountMinor"]); guard off <= remaining, off == (try allocations.reduce(0) { $0 + (try walletInteger($1["discountMinor"])) }) else { throw StaffAPIError.invalid }
      remaining -= off; guard try walletInteger(step["payableMinor"]) == remaining else { throw StaffAPIError.invalid }
    }
    guard remaining == payable else { throw StaffAPIError.invalid }; self.data = try membershipData(d)
  }
  func money(_ key: String) -> String { if object[key] is NSNull { return "未知" }; return (try? stackingSignedInteger(object[key])).map { "¥" + stackingMoneyText($0) } ?? "待核对" }
}
