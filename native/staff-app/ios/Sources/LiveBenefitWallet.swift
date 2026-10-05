import Foundation
import CoreFoundation

let benefitWalletRoot = "/api/staff/native-benefit-wallet"
let walletTypeNames = ["gift_product": "赠品券", "discount": "折扣权益", "credit": "金额权益", "access": "入场或服务资格", "other": "其他权益"]
let walletStateNames = ["available": "可使用", "upcoming": "未生效", "reserved": "已暂留", "redeemed": "已用完", "expired": "已到期", "revoked": "已撤销", "unavailable": "不可使用", "outside_window": "不在可用时段"]
let walletPermissions = ["loyalty.account.view", "benefit.issue", "benefit.cancel", "loyalty.redemption.fulfill"]
struct WalletRecord: Identifiable, Equatable {
  let data: Data
  init(_ value: [String: Any]) throws {
    guard let id = value["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
    data = try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
  }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { object[key] as? String ?? "" }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  func boolean(_ key: String) throws -> Bool { try walletBoolean(object[key]) }
  func rows(_ key: String) throws -> [WalletRecord] {
    guard let list = object[key] as? [[String: Any]] else { throw StaffAPIError.invalid }
    return try walletRecords(list)
  }
  var lowPrice: Bool { object["pricePromise"] is [String: Any] }
  var snack: Bool { (try? boolean("snackClaim")) == true }
}
func walletInteger(_ value: Any?) throws -> Int {
  let string: String
  if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() { string = value.stringValue }
  else if let value = value as? String { string = value }
  else { throw StaffAPIError.invalid }
  guard string.range(of: "^(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
    let number = Int(string), number <= 9_007_199_254_740_991 else { throw StaffAPIError.invalid }
  return number
}
func walletBoolean(_ value: Any?) throws -> Bool {
  guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw StaffAPIError.invalid }
  return value.boolValue
}
func walletRecords(_ values: [[String: Any]]) throws -> [WalletRecord] {
  let rows = try values.map(WalletRecord.init)
  guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
  return rows
}
func walletEnvelope(_ data: Data) throws -> [String: Any] {
  guard let value = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["data"] as? [String: Any] else { throw StaffAPIError.invalid }
  return value
}
func walletMoney(_ input: String) throws -> Int {
  guard input.range(of: "^(0|[1-9][0-9]{0,6})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError("请填写非负授权金额，最多两位小数") }
  let parts = input.split(separator: ".").map(String.init)
  let amount = Int(parts[0])! * 100 + (parts.count == 2 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
  guard amount <= 100_000_000 else { throw CatalogError("每份授权金额不得超过100万元") }
  return amount
}
func walletMoneyText(_ amount: Int) -> String { "\(amount / 100)." + String(format: "%02d", amount % 100) }
func walletDateInput(_ input: String) throws -> String {
  let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX")
  parser.timeZone = TimeZone(identifier: "Asia/Shanghai"); parser.dateFormat = "yyyy-MM-dd HH:mm"; parser.isLenient = false
  guard input.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$", options: .regularExpression) != nil,
    let date = parser.date(from: input), parser.string(from: date) == input else { throw CatalogError("请填写有效北京时间 YYYY-MM-DD HH:mm") }
  return ISO8601DateFormatter().string(from: date)
}
func walletPermission(_ action: String) throws -> String {
  guard ["issue", "reserve", "redeem", "cancel"].contains(action) else { throw StaffAPIError.invalid }
  return action == "issue" ? "benefit.issue" : action == "cancel" ? "benefit.cancel" : "loyalty.redemption.fulfill"
}
struct BenefitWalletBoard {
  let employeeID, customerID, memberNo, displayName: String
  let enabled: Bool
  let rows, tables, limits: [WalletRecord]
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity) throws {
    let d = try walletEnvelope(data)
    guard d["employeeId"] as? String == actor.employee.id, actor.allows("loyalty.account.view"),
      try walletInteger(d["protocol"]) == 1, let customer = d["customerId"] as? String, UUID(uuidString: customer) != nil,
      let member = d["memberNo"] as? String, try MemberCommands.code(member) == member,
      let items = d["items"] as? [[String: Any]], items.count <= 25,
      let tables = d["tables"] as? [[String: Any]], let limits = d["limits"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; customerID = customer; memberNo = member; displayName = d["displayName"] as? String ?? "会员"
    enabled = try walletBoolean(d["durableCommands"]); self.rows = try walletRecords(items)
    self.tables = try walletRecords(tables); self.limits = try walletRecords(limits)
    nextCursor = d["nextCursor"] as? String
    guard nextCursor == nil || (1...120).contains(nextCursor!.utf16.count) else { throw StaffAPIError.invalid }
    for row in rows {
      guard walletTypeNames[row.text("type")] != nil, walletStateNames[row.text("state")] != nil,
        !row.text("title").isEmpty, assignmentDate(row.text("validFrom")) != nil,
        row.text("validUntil").isEmpty || assignmentDate(row.text("validUntil")) != nil,
        try row.integer("version") > 0 else { throw StaffAPIError.invalid }
      _ = try row.boolean("snackClaim")
      let total = try row.integer("quantityTotal"), available = try row.integer("quantityAvailable")
      let held = try row.integer("quantityReserved"), used = try row.integer("quantityRedeemed")
      guard available + held + used <= total else { throw StaffAPIError.invalid }
      if !(row.object["valueAmountMinor"] is NSNull) { _ = try row.integer("valueAmountMinor") }
      for product in try row.rows("products") { guard !product.text("name").isEmpty else { throw StaffAPIError.invalid } }
      for hold in try row.rows("reservations") {
        guard hold.text("benefitId") == row.id, UUID(uuidString: hold.text("tableSessionId")) != nil,
          hold.text("status") == "reserved", (1...100).contains(try hold.integer("quantity")),
          assignmentDate(hold.text("expiresAt")) != nil else { throw StaffAPIError.invalid }
        _ = try hold.boolean("canRedeem")
      }
    }
  }
  func command(actor: StaffIdentity, action: String, body: [String: Any], selectedProducts: [WalletRecord] = [], now: Date = Date()) throws -> LiveCommand {
    let permission = try walletPermission(action)
    guard enabled, employeeID == actor.employee.id, actor.allows("loyalty.account.view"), actor.allows(permission),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true,
      body["customerId"] as? String == customerID else { throw CatalogError("会员、登录或权益权限已变化，请重新读取") }
    func string(_ key: String) throws -> String {
      guard let value = body[key] as? String, !value.isEmpty else { throw CatalogError("请填写完整权益信息") }; return value
    }
    let quantity = try walletInteger(body["quantity"])
    guard (1...(action == "issue" ? 10000 : 100)).contains(quantity) else { throw CatalogError("请核对办理份数") }
    var confirmation = [memberNo + " · " + displayName]
    let title: String
    if action == "issue" {
      let expected: Set<String> = ["customerId", "title", "benefitCode", "benefitType", "valueAmountMinor", "quantity", "authorizationLimitId", "allowedProductIds", "validFrom", "validUntil", "reason"]
      guard Set(body.keys) == expected else { throw StaffAPIError.invalid }
      let code = try string("benefitCode"), name = try string("title"), type = try string("benefitType"), reason = try string("reason")
      guard code.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", options: .regularExpression) != nil,
        (2...100).contains(name.utf16.count), walletTypeNames[type] != nil, (2...256).contains(reason.utf16.count),
        let limit = limits.first(where: { $0.id == body["authorizationLimitId"] as? String }), limit.text("currency") == "CNY",
        let products = body["allowedProductIds"] as? [String], products.count <= 100,
        Set(products).count == products.count, products.allSatisfy({ UUID(uuidString: $0) != nil }),
        type != "gift_product" || !products.isEmpty, type == "gift_product" || products.isEmpty,
        let start = assignmentDate(try string("validFrom")) else { throw CatalogError("请核对名称、编码、岗位额度、商品及有效期") }
      let value = try walletInteger(body["valueAmountMinor"])
      guard value <= 100_000_000 else { throw CatalogError("每份授权金额超出范围") }
      if limit.object["amountMinor"] is String || limit.object["amountMinor"] is NSNumber {
        guard value * quantity <= (try limit.integer("amountMinor")) else { throw CatalogError("本次总价值超过岗位额度") }
      }
      if let end = body["validUntil"] as? String {
        guard let date = assignmentDate(end), date > start else { throw CatalogError("结束时间须晚于生效时间") }
      } else if !(body["validUntil"] is NSNull) { throw StaffAPIError.invalid }
      guard Set(selectedProducts.map(\.id)) == Set(products), selectedProducts.count == products.count,
        selectedProducts.allSatisfy({ !$0.text("name").isEmpty }) else { throw CatalogError("请重新查询并核对所选商品名称") }
      title = "发放会员权益"
      confirmation += [name + " · " + (walletTypeNames[type] ?? "") + " · \(quantity)份", "每份授权价值：\(walletMoneyText(value))元 · 合计：\(walletMoneyText(value * quantity))元", "岗位额度：" + limit.text("name"), "允许商品：" + (selectedProducts.isEmpty ? "按原权益规则使用" : selectedProducts.map { $0.text("name") }.joined(separator: "、")), "生效：" + (body["validFrom"] as! String), "到期：" + (body["validUntil"] as? String ?? "未设置"), "原因：" + reason, "确认后发放权益，不代表已核销或实际交付。"]
    } else {
      guard let row = rows.first(where: { $0.id == body["benefitId"] as? String }),
        let table = body["tableSessionId"] as? String, UUID(uuidString: table) != nil else { throw CatalogError("请重新读取原权益和桌次") }
      confirmation += [row.text("title") + " · \(quantity)份"]
      if action == "reserve" {
        guard Set(body.keys) == ["customerId", "benefitId", "tableSessionId", "quantity", "expectedVersion"],
          !row.lowPrice, !row.snack, row.text("state") == "available",
          quantity <= (try row.integer("quantityAvailable")), try walletInteger(body["expectedVersion"]) == row.integer("version"),
          let currentTable = tables.first(where: { $0.id == table }) else { throw CatalogError("请核对当前可用权益、份数、版本及会员实际所在桌") }
        title = "暂留会员权益"; confirmation += ["桌号：" + currentTable.text("code"), "暂留10分钟，之后仍须核销；暂留不代表已交付。"]
      } else {
        guard let hold = try row.rows("reservations").first(where: { $0.id == body["reservationId"] as? String }),
          hold.text("tableSessionId") == table, try hold.integer("quantity") == quantity else { throw CatalogError("原暂留、桌次或份数已变化") }
        confirmation.append("原暂留桌号：" + hold.text("tableCode"))
        if action == "cancel" {
          guard Set(body.keys) == ["customerId", "benefitId", "reservationId", "tableSessionId", "quantity", "reason"],
            (2...256).contains(try string("reason").utf16.count) else { throw CatalogError("取消暂留须填写2—256字实际原因") }
          title = "取消原权益暂留"; confirmation += ["原因：" + (body["reason"] as! String), "只释放未核销暂留，不撤回已送达商品，不退款。"]
        } else {
          let required: Set<String> = ["customerId", "benefitId", "reservationId", "tableSessionId", "quantity"]
          guard required.isSubset(of: Set(body.keys)), Set(body.keys).isSubset(of: required.union(["selectedProductId", "substitutionReason"])),
            !row.lowPrice, !row.snack, try hold.boolean("canRedeem"), assignmentDate(hold.text("expiresAt")).map({ $0 > now }) == true else { throw CatalogError("原暂留已过期，或此券须按原低价券/点心流程办理") }
          if row.text("type") == "gift_product" {
            guard let product = try row.rows("products").first(where: { $0.id == body["selectedProductId"] as? String && $0.text("status") == "active" }) else { throw CatalogError("请选择允许兑付的实际商品") }
            confirmation.append("实际商品：" + product.text("name"))
          } else if body["selectedProductId"] != nil { throw CatalogError("此权益不是赠品券，不能生成赠品") }
          if let reason = body["substitutionReason"] as? String {
            guard (2...256).contains(reason.utf16.count) else { throw CatalogError("核销说明须为2—256字") }; confirmation.append("说明：" + reason)
          }
          title = "核销原权益暂留"; confirmation.append("赠品仍须出品与送达；本次不退款，也不会自动减免订单金额。")
        }
      }
    }
    let id = UUID().uuidString.lowercased()
    let proof: [String: Any] = ["action": action, "employeeId": actor.employee.id, "confirmation": ([title] + confirmation).joined(separator: "\n")]
    return LiveCommand(id: id, employeeID: actor.employee.id, title: title, permission: permission, steps: [.init(path: benefitWalletRoot + "/commands/" + action,
      body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys), keyHeader: "idempotency-key", key: "native-business-" + id,
      recoveryBody: try JSONSerialization.data(withJSONObject: ["benefitWallet": proof], options: .sortedKeys))])
  }
}
struct BenefitWalletProducts {
  let employeeID: String
  let rows: [WalletRecord]
  let nextOffset: Int?
  init(data: Data, actor: StaffIdentity) throws {
    let d = try walletEnvelope(data)
    guard d["employeeId"] as? String == actor.employee.id, actor.allows("benefit.issue"),
      let rows = d["items"] as? [[String: Any]], rows.count <= 50 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.rows = try walletRecords(rows)
    nextOffset = d["nextOffset"] is NSNull ? nil : try walletInteger(d["nextOffset"])
    guard nextOffset == nil || (1...100000).contains(nextOffset!) else { throw StaffAPIError.invalid }
  }
  static func query(search: String, offset: Int) throws -> String {
    let value = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.utf16.count <= 100, (0...100000).contains(offset) else { throw CatalogError("商品查询条件超出范围") }
    var query = URLComponents(); query.queryItems = [URLQueryItem(name: "search", value: value), URLQueryItem(name: "offset", value: String(offset))]
    return "?" + (query.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
}
extension LiveCommand.Step {
  var benefitWalletProof: [String: Any]? {
    guard let recoveryBody else { return nil }
    return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["benefitWallet"] as? [String: Any]
  }
}
func validateBenefitWalletReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let meta = root["meta"] as? [String: Any],
    try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let p = step.benefitWalletProof,
    let action = p["action"] as? String, step.path == benefitWalletRoot + "/commands/" + action,
    d["employeeId"] as? String == p["employeeId"] as? String, d["requestKey"] as? String == step.key,
    d["action"] as? String == action, d["customerId"] as? String == step.object["customerId"] as? String,
    let result = d["result"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); _ = try walletPermission(action)
  let row = try WalletRecord(result), body = step.object
  // A concurrent membership merge may canonicalize the result customer while the
  // durable envelope continues to bind the exact original request customer.
  guard UUID(uuidString: row.text("customerId")) != nil else { throw StaffAPIError.invalid }
  if action == "issue" {
    guard row.text("benefitCode") == body["benefitCode"] as? String,
      try row.integer("quantityTotal") == walletInteger(body["quantity"]),
      row.text("benefitType") == body["benefitType"] as? String, row.text("currency") == "CNY",
      try row.integer("valueAmountMinor") == walletInteger(body["valueAmountMinor"]),
      row.text("issuedByEmployeeId") == p["employeeId"] as? String,
      row.text("authorizationLimitId") == body["authorizationLimitId"] as? String,
      assignmentDate(row.text("validFrom")) == assignmentDate(body["validFrom"] as? String ?? ""),
      assignmentDate(row.text("validUntil")) == assignmentDate(body["validUntil"] as? String ?? "") else { throw StaffAPIError.invalid }
  } else {
    guard row.text("benefitId") == body["benefitId"] as? String, row.text("tableSessionId") == body["tableSessionId"] as? String,
      try row.integer("quantity") == walletInteger(body["quantity"]) else { throw StaffAPIError.invalid }
    if action == "redeem" {
      guard row.text("benefitReservationId") == body["reservationId"] as? String,
        (row.object["authorizationSource"] as? [String: Any])?["employeeId"] as? String == p["employeeId"] as? String,
        assignmentDate(row.text("redeemedAt")) != nil else { throw StaffAPIError.invalid }
    } else {
      guard row.text("status") == (action == "cancel" ? "cancelled" : "reserved"), action != "cancel" || row.id == body["reservationId"] as? String else { throw StaffAPIError.invalid }
      if action == "cancel", row.text("cancelReason") != body["reason"] as? String { throw StaffAPIError.invalid }
    }
  }
}
