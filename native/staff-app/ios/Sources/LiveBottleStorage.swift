import Foundation
import CoreFoundation
import CryptoKit

let bottleStorageRoot = "/api/native/staff/bottle-custody"
let bottleStoragePermissions = ["bottle.manage.all", "member.card.manage", "bottle.custody.export", "order.history.all"]
let bottleStorageStates = ["stored": "在存", "collected": "已取走待处理", "archived": "已归档", "voided": "已作废", "restored": "已再存", "pending": "待发送", "accepted": "平台已接受", "failed": "发送失败"]
let bottleStorageFractions = ["1": "1", "1/2": "0.5", "1/4": "0.25", "3/4": "0.75", "1/5": "0.2", "2/5": "0.4", "3/5": "0.6", "4/5": "0.8", "1/10": "0.1"]
func bottleBytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
func bottleObject(_ bytes: Data) throws -> [String: Any] {
  guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw StaffAPIError.invalid }; return result
}
func bottleData(_ bytes: Data) throws -> [String: Any] {
  guard let result = try bottleObject(bytes)["data"] as? [String: Any] else { throw StaffAPIError.invalid }; return result
}
func bottleBoolean(_ value: Any?) throws -> Bool {
  guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw StaffAPIError.invalid }; return value.boolValue
}
func bottleInteger(_ value: Any?, min: Int = 0, max: Int = 9_007_199_254_740_991) throws -> Int {
  guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), let v = Int(n.stringValue), (min...max).contains(v) else { throw StaffAPIError.invalid }; return v
}
func bottleQuantity(_ value: String, zero: Bool = false) throws -> Int64 {
  guard value.range(of: "^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?$", options: .regularExpression) != nil else { throw CatalogError("数量最多十二位整数、六位小数") }
  let parts = value.split(separator: ".").map(String.init)
  let v = Int64(parts[0])! * 1_000_000 + (parts.count == 2 ? Int64(parts[1].padding(toLength: 6, withPad: "0", startingAt: 0))! : 0)
  guard zero || v > 0 else { throw CatalogError("数量必须大于零") }; return v
}
func bottleText(_ object: [String: Any], _ key: String) -> String {
  if let v = object[key] as? String { return v }
  if let v = object[key] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID() { return v.stringValue }; return ""
}
func bottleString(_ object: [String: Any], _ key: String, min: Int = 0, max: Int = 1000) throws -> String {
  guard let text = object[key] as? String, text == text.trimmingCharacters(in: .whitespacesAndNewlines), (min...max).contains(text.utf16.count) else { throw CatalogError("请核对必填信息及长度") }; return text
}
func bottleUUID(_ value: Any?) throws -> String { guard let s = value as? String, UUID(uuidString: s) != nil else { throw StaffAPIError.invalid }; return s }
func bottleDate(_ text: String) throws -> String {
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
  guard text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil, let d = f.date(from: text), f.string(from: d) == text else { throw CatalogError("日期格式为 YYYY-MM-DD，请核对真实日期") }; return text
}
func bottleInstant(_ text: String) throws -> Date {
  guard text.range(of: "(Z|[+-][0-9]{2}:[0-9]{2})$", options: .regularExpression) != nil,
    let value = StaffIdentity.date(text) else { throw CatalogError("时间缺少有效时区，请重新选择") }; return value
}
func bottleISO(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
/// Custody SQL deliberately returns timestamptz::text, including PostgreSQL's
/// space separator, six fractional digits and +00 offset. Accept that exact
/// representation as well as ISO JSON dates without assuming device timezone.
func bottleStoredDate(_ text: String) -> Date? {
  if let date = StaffIdentity.date(text) { return date }
  guard text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?[+-][0-9]{2}(:?[0-9]{2})?$", options: .regularExpression) != nil else { return nil }
  var normalized = text.replacingOccurrences(of: " ", with: "T")
  if normalized.range(of: "[+-][0-9]{2}$", options: .regularExpression) != nil { normalized += ":00" }
  else if normalized.range(of: "[+-][0-9]{4}$", options: .regularExpression) != nil { normalized.insert(":", at: normalized.index(normalized.endIndex, offsetBy: -2)) }
  return StaffIdentity.date(normalized)
}
func bottleDisplayTime(_ text: String) -> String {
  guard let date = bottleStoredDate(text) else { return "时间待核对" }
  let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd HH:mm"; return formatter.string(from: date)
}
func bottlePhone(_ raw: String) throws -> String {
  var text = raw.filter { !$0.isWhitespace && !"()-".contains($0) }
  if text.range(of: "^1[3-9][0-9]{9}$", options: .regularExpression) != nil { text = "+86" + text }
  guard text.range(of: "^\\+[1-9][0-9]{7,14}$", options: .regularExpression) != nil else { throw CatalogError("请输入有效手机号或含国家区号的号码") }; return text
}
struct BottleStorageRow: Identifiable, Equatable {
  let bytes: Data
  var object: [String: Any] { (try? bottleObject(bytes)) ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { bottleText(object, key) }
  func flag(_ key: String) -> Bool { (try? bottleBoolean(object[key])) == true }
  init(_ object: [String: Any]) throws { _ = try bottleUUID(object["id"]); bytes = try bottleBytes(object) }
}
struct BottleStorageDetail: Equatable {
  let bytes: Data
  let order: BottleStorageRow
  let collections, challenges, deposits: [BottleStorageRow]
  var object: [String: Any] { (try? bottleObject(bytes)) ?? [:] }
  var events: [[String: Any]] { object["events"] as? [[String: Any]] ?? [] }
  var reminders: [[String: Any]] { object["reminders"] as? [[String: Any]] ?? [] }
  init(_ object: [String: Any]) throws {
    guard let raw = object["order"] as? [String: Any], let collections = object["collections"] as? [[String: Any]],
      let challenges = object["challenges"] as? [[String: Any]], let deposits = object["deposits"] as? [[String: Any]],
      object["events"] is [[String: Any]], object["reminders"] is [[String: Any]] else { throw StaffAPIError.invalid }
    order = try BottleStorageRow(raw)
    guard !order.text("public_id").isEmpty, !order.text("member_no").isEmpty, ["stored", "collected", "archived", "voided"].contains(order.text("status")),
      try bottleInteger(raw["version"], min: 1) > 0 else { throw StaffAPIError.invalid }
    _ = try bottleQuantity(order.text("remaining_quantity"), zero: true); _ = try bottleQuantity(order.text("original_quantity"))
    self.collections = try collections.map(BottleStorageRow.init); self.challenges = try challenges.map(BottleStorageRow.init); self.deposits = try deposits.map(BottleStorageRow.init)
    for list in [self.collections, self.challenges, self.deposits] { guard Set(list.map(\.id)).count == list.count else { throw StaffAPIError.invalid } }
    bytes = try bottleBytes(object)
  }
}
struct BottleStoragePolicy: Codable, Equatable {
  struct Extra: Codable, Equatable, Identifiable {
    var key: String, label: String, type: String, required: Bool
    var id: String { key }
  }
  var allowRestorage: Bool, requireOriginalOrder: Bool, archiveMode: String
  var extraFieldDefinitions: [Extra], serviceAccountId: String?, enabled: Bool, defaultDays: Int, remindersEnabled: Bool
  var reminderDays: [Int], sendMinute: Int, codeDigits: Int, codeTtlSeconds: Int, resendSeconds: Int, maximumAttempts: Int, allowPartial: Bool
  var numberPattern: String, printFields: [String], printFooter: String, reportDimensions: [String], printTitle: String, reminderText: String
  var object: [String: Any] { var value = (try? bottleObject(JSONEncoder().encode(self))) ?? [:]; if serviceAccountId == nil { value["serviceAccountId"] = NSNull() }; return value }
  func validate() throws {
    guard ["automatic", "manual"].contains(archiveMode), (1...3660).contains(defaultDays), (960...1020).contains(sendMinute),
      (4...8).contains(codeDigits), (60...600).contains(codeTtlSeconds), (30...600).contains(resendSeconds), (1...10).contains(maximumAttempts),
      (1...12).contains(reminderDays.count), reminderDays.allSatisfy({ (1...3660).contains($0) }), Set(reminderDays).count == reminderDays.count,
      serviceAccountId == nil || UUID(uuidString: serviceAccountId!) != nil, !remindersEnabled || serviceAccountId != nil,
      (10...200).contains(numberPattern.utf16.count), ["{date}", "{time}", "{member}", "{serial}"].allSatisfy(numberPattern.contains),
      numberPattern.rangeOfCharacter(from: CharacterSet(charactersIn: "<>\r\n")) == nil,
      printFields.count <= 8, Set(printFields).count == printFields.count,
      printFields.allSatisfy(["category", "item", "quantity", "remaining", "expiry", "location", "status", "source"].contains),
      reportDimensions.count <= 3, Set(reportDimensions).count == reportDimensions.count, reportDimensions.allSatisfy(["category", "status", "date"].contains),
      printFooter.utf16.count <= 300, (1...100).contains(printTitle.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      (1...500).contains(reminderText.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      extraFieldDefinitions.count <= 20, Set(extraFieldDefinitions.map(\.key)).count == extraFieldDefinitions.count else { throw CatalogError("请核对存酒规则范围、服务号及重复选项") }
    for field in extraFieldDefinitions {
      guard field.key.range(of: "^[a-z][a-z0-9_]{0,29}$", options: .regularExpression) != nil, (1...30).contains(field.label.utf16.count),
        ["text", "number", "date"].contains(field.type) else { throw CatalogError("自定义字段的编码、名称或类型不正确") }
    }
  }
  func validateExtra(_ values: [String: String]) throws {
    guard values.keys.allSatisfy({ key in extraFieldDefinitions.contains { $0.key == key } }), values.values.allSatisfy({ $0.utf16.count <= 500 }) else { throw CatalogError("表单字段已变化，请刷新") }
    for field in extraFieldDefinitions {
      let value = (values[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !field.required || !value.isEmpty else { throw CatalogError("请填写" + field.label) }
      if value.isEmpty { continue }
      if field.type == "date" { _ = try bottleDate(value) }
      if field.type == "number", value.range(of: "^-?(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?$", options: .regularExpression) == nil { throw CatalogError(field.label + "须为有效数字") }
    }
  }
}
struct BottleStorageBoard {
  let employeeID: String, sessionID: String
  let enabled: Bool
  let policy: BottleStoragePolicy
  let version: Int
  let categories, accounts: [BottleStorageRow]
  init(policy bytes: Data, capability: Data, actor: StaffIdentity) throws {
    let raw = try bottleData(bytes), cap = try bottleData(capability)
    guard cap["employeeId"] as? String == actor.employee.id, actor.allows("bottle.manage.all"),
      let policy = raw["policy"] as? [String: Any], let categories = raw["categories"] as? [[String: Any]], let accounts = raw["accounts"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; enabled = try bottleBoolean(cap["durableCommands"])
    self.policy = try JSONDecoder().decode(BottleStoragePolicy.self, from: bottleBytes(policy)); try self.policy.validate()
    version = try bottleInteger(raw["version"]); self.categories = try categories.map(BottleStorageRow.init); self.accounts = try accounts.map(BottleStorageRow.init)
    for list in [self.categories, self.accounts] { guard Set(list.map(\.id)).count == list.count else { throw StaffAPIError.invalid } }
  }
  func command(actor: StaffIdentity, operation: String, body: [String: Any], detail: BottleStorageDetail? = nil,
    category: BottleStorageRow? = nil, confirmation: String) throws -> LiveCommand {
    let permission = try bottleStoragePermission(operation)
    guard enabled, actor.employee.id == employeeID, actor.session.id == sessionID, actor.allows("bottle.manage.all"), actor.allows(permission),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else { throw CatalogError("登录、权限或存酒资料已变化，请重新读取") }
    let target = detail?.order.id
    var proof: [String: Any] = ["operation": operation, "employeeId": employeeID, "confirmation": confirmation]
    if let detail { proof["target"] = detail.order.id; proof["version"] = try bottleInteger(detail.order.object["version"], min: 1) }
    if let category {
      guard operation == "category", categories.contains(category), body["id"] as? String == category.id,
        category.text("configurationFingerprint").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CatalogError("品类版本已变化，请刷新") }
      proof["categoryExpected"] = category.text("configurationFingerprint")
    }
    try validateBottleStorageInput(operation, body: body, policy: policy, categories: categories, detail: detail)
    if ["sales", "all"].contains(body["scope"] as? String ?? ""), !actor.allows("order.history.all") { throw CatalogError("没有全部消费订单查看权限") }
    if operation == "policy" { guard try bottleInteger(body["version"]) == version else { throw StaffAPIError.invalid } }
    if operation == "category", body["id"] != nil, category == nil { throw StaffAPIError.invalid }
    let id = UUID().uuidString.lowercased()
    return LiveCommand(id: id, employeeID: employeeID, title: bottleStorageTitles[operation]!, permission: permission,
      steps: [.init(path: try bottleStoragePath(operation, target: target), body: try bottleBytes(body), keyHeader: "idempotency-key", key: "native-business-" + id,
        recoveryBody: try bottleBytes(["bottleStorage": proof]))])
  }
}
let bottleStorageTitles = ["create": "登记存酒", "request_code": "登记发送取酒验证码", "verify": "校验取酒验证码", "collect": "确认实物已取走", "resolve_collection": "处理本次取酒", "archive": "归档存酒单", "expiry": "调整到期时间", "category": "保存存酒品类", "policy": "保存存酒规则", "print_prepared": "生成存酒凭证", "export": "导出存酒明细", "report_export": "导出可选范围报表"]
func bottleStoragePermission(_ operation: String) throws -> String {
  guard bottleStorageTitles[operation] != nil else { throw StaffAPIError.invalid }
  return ["category", "policy"].contains(operation) ? "member.card.manage" : ["export", "report_export"].contains(operation) ? "bottle.custody.export" : "bottle.manage.all"
}
func bottleStoragePath(_ operation: String, target: String?) throws -> String {
  _ = try bottleStoragePermission(operation)
  if operation == "create" { guard target == nil else { throw StaffAPIError.invalid }; return bottleStorageRoot }
  if let suffix = ["category": "/categories", "policy": "/policy", "export": "/export", "report_export": "/report-export"][operation] {
    guard target == nil else { throw StaffAPIError.invalid }; return bottleStorageRoot + suffix
  }
  let id = try bottleUUID(target)
  return bottleStorageRoot + "/" + id + "/" + (["request_code": "request-code", "resolve_collection": "resolve-collection", "print_prepared": "print"][operation] ?? operation)
}
func validateBottleStorageEvidence(_ value: Any?, unit: String, quantity: String) throws {
  guard let evidence = value as? [String: Any], Set(evidence.keys).isSubset(of: ["photoBase64", "phone", "fraction"]),
    let base64 = evidence["photoBase64"] as? String, (100...1_400_000).contains(base64.utf8.count),
    let bytes = Data(base64Encoded: base64), bytes.count <= 1_048_576, bytes.base64EncodedString() == base64,
    bytes.starts(with: [0xff, 0xd8, 0xff]) || bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { throw CatalogError("请重新拍摄清晰存酒照片，压缩后不超过1 MB") }
  if let phone = evidence["phone"] as? String { _ = try bottlePhone(phone) }
  else if !(evidence["phone"] == nil || evidence["phone"] is NSNull) { throw StaffAPIError.invalid }
  if let fraction = evidence["fraction"] as? String {
    guard unit == "瓶", let amount = bottleStorageFractions[fraction], try bottleQuantity(amount) == bottleQuantity(quantity) else { throw CatalogError("瓶数与所选余量比例不一致") }
  } else if !(evidence["fraction"] == nil || evidence["fraction"] is NSNull) { throw StaffAPIError.invalid }
}
func validateBottleStorageInput(_ op: String, body: [String: Any], policy: BottleStoragePolicy, categories: [BottleStorageRow], detail: BottleStorageDetail?) throws {
  func keys(_ allowed: [String]) throws { guard Set(body.keys).isSubset(of: Set(allowed)) else { throw StaffAPIError.invalid } }
  func quantity(_ key: String = "quantity") throws -> Int64 { try bottleQuantity(bottleString(body, key, min: 1, max: 20)) }
  func reason() throws { _ = try bottleString(body, "reason", min: 2, max: 300) }
  switch op {
  case "create":
    try keys(["evidence", "declaredValueMinor", "extraFields", "memberNo", "categoryId", "itemName", "unit", "quantity", "sourceOrderId", "sourceReference", "location", "note", "expiresAt", "days"])
    guard policy.enabled, categories.contains(where: { $0.id == body["categoryId"] as? String && $0.flag("active") }) else { throw CatalogError("新存酒已关闭或品类已停用") }
    _ = try bottleString(body, "memberNo", min: 1, max: 64); _ = try bottleString(body, "itemName", min: 1, max: 120)
    let unit = try bottleString(body, "unit", min: 1, max: 20); _ = try quantity()
    _ = try bottleString(body, "location", max: 120); _ = try bottleString(body, "note", max: 1000)
    if let value = body["sourceOrderId"], !(value is NSNull) { _ = try bottleUUID(value) }
    if body["sourceReference"] is String { _ = try bottleString(body, "sourceReference", max: 120) }
    if let value = body["declaredValueMinor"], !(value is NSNull) { _ = try bottleInteger(value, max: 100_000_000_000) }
    let days = body["days"], expiry = body["expiresAt"] as? String
    guard days == nil || days is NSNull || expiry == nil else { throw CatalogError("存期与到期时间只能选择一种") }
    if let days, !(days is NSNull) { _ = try bottleInteger(days, min: 1, max: 3660) }
    if let expiry { guard try bottleInstant(expiry) > Date() else { throw CatalogError("请选择未来到期时间") } }
    guard let extras = body["extraFields"] as? [String: String] else { throw StaffAPIError.invalid }; try policy.validateExtra(extras)
    try validateBottleStorageEvidence(body["evidence"], unit: unit, quantity: body["quantity"] as! String)
  case "request_code":
    try keys(["quantity"]); guard let detail, detail.order.text("status") == "stored" else { throw CatalogError("当前状态不可取酒") }
    let amount = try quantity(), remaining = try bottleQuantity(detail.order.text("remaining_quantity"))
    guard amount <= remaining, policy.allowPartial || amount == remaining else { throw CatalogError("数量超过剩余，或当前规则仅支持整单取酒") }
  case "verify", "collect":
    try keys(op == "verify" ? ["challengeId", "code"] : ["challengeId"])
    guard let detail, detail.order.text("status") == "stored", let challenge = detail.challenges.first(where: { $0.id == body["challengeId"] as? String }),
      challenge.text("delivery_status") == "accepted", challenge.text("consumed_at").isEmpty, challenge.text("invalidated_at").isEmpty,
      bottleStoredDate(challenge.text("expires_at")).map({ $0 > Date() }) == true,
      (try op == "collect" || (bottleInteger(challenge.object["attempts"]) < bottleInteger(challenge.object["maximum_attempts"], min: 1))) else { throw CatalogError("验证码尚未发送成功或已失效，请刷新") }
    if op == "verify" { guard try bottleString(body, "code").range(of: "^[0-9]{4,8}$", options: .regularExpression) != nil else { throw CatalogError("请填写4至8位数字验证码") } }
    else { guard !challenge.text("verified_at").isEmpty else { throw CatalogError("请先通过验证码校验，再确认实物已取走") } }
  case "resolve_collection":
    try keys(["evidence", "collectionId", "quantity", "restorageMode", "reason"]); try reason()
    guard let detail, let collection = detail.collections.first(where: { $0.id == body["collectionId"] as? String }), collection.text("status") == "collected",
      let mode = body["restorageMode"] as? String, ["original", "new"].contains(mode) else { throw CatalogError("请重新读取未处理取酒记录") }
    if body["quantity"] is NSNull { guard body["evidence"] == nil else { throw StaffAPIError.invalid } }
    else {
      let amount = try quantity(), maximum = try bottleQuantity(collection.text("quantity"))
      guard policy.allowRestorage, amount <= maximum, policy.allowPartial || amount == maximum, !policy.requireOriginalOrder || mode == "original" else { throw CatalogError("再存数量或方式不符合当前规则") }
      if mode == "original" { guard bottleStoredDate(detail.order.text("expires_at")).map({ $0 > Date() }) == true else { throw CatalogError("原单已到期，请先调整到期时间") } }
      try validateBottleStorageEvidence(body["evidence"], unit: detail.order.text("unit"), quantity: body["quantity"] as! String)
    }
  case "archive":
    try keys(["reason"]); try reason()
    guard let detail, detail.order.text("status") == "collected", try bottleQuantity(detail.order.text("remaining_quantity"), zero: true) == 0,
      !detail.collections.contains(where: { $0.text("status") == "collected" }) else { throw CatalogError("仍有存酒或待处理取酒，不能归档") }
  case "expiry":
    try keys(["expiresAt", "reason"]); try reason(); guard detail != nil, try bottleInstant(bottleString(body, "expiresAt")) > Date() else { throw CatalogError("请选择未来到期时间") }
  case "print_prepared": try keys([]); guard detail != nil else { throw StaffAPIError.invalid }
  case "category":
    try keys(["id", "code", "name", "defaultDays", "active", "sortOrder"])
    if let id = body["id"] { _ = try bottleUUID(id) }
    _ = try bottleString(body, "code", min: 1, max: 40); _ = try bottleString(body, "name", min: 1, max: 60)
    _ = try bottleInteger(body["defaultDays"], min: 1, max: 3660); _ = try bottleInteger(body["sortOrder"], max: 10000); _ = try bottleBoolean(body["active"])
  case "policy":
    try keys(["policy", "version", "reason"]); try reason(); _ = try bottleInteger(body["version"])
    guard let object = body["policy"] as? [String: Any] else { throw StaffAPIError.invalid }
    let policy = try JSONDecoder().decode(BottleStoragePolicy.self, from: bottleBytes(object)); try policy.validate()
  case "export", "report_export": _ = try bottleStorageQuery(body, report: op == "report_export", page: false)
  default: throw StaffAPIError.invalid
  }
}
func bottleStorageQuery(_ values: [String: Any], report: Bool = false, page: Bool = true) throws -> String {
  let allowed = report ? ["scope", "memberNo", "category", "from", "to"] + (page ? ["offset"] : []) : ["memberNo", "categoryId", "status", "from", "to", "query"] + (page ? ["cursor"] : [])
  guard Set(values.keys).isSubset(of: Set(allowed)) else { throw StaffAPIError.invalid }
  if let scope = values["scope"] as? String, !["custody", "sales", "all"].contains(scope) { throw StaffAPIError.invalid }
  if let status = values["status"] as? String, !["stored", "collected", "archived", "voided"].contains(status) { throw StaffAPIError.invalid }
  for key in ["categoryId", "cursor"] where values[key] != nil { _ = try bottleUUID(values[key]) }
  for key in ["memberNo", "category", "query"] where values[key] != nil { _ = try bottleString(values, key, min: key == "memberNo" ? 1 : 0, max: key == "query" ? 100 : 64) }
  for key in ["from", "to"] { if let v = values[key] as? String { _ = try bottleInstant(v) } }
  if let from = values["from"] as? String, let to = values["to"] as? String { guard try bottleInstant(from) < bottleInstant(to) else { throw CatalogError("结束时间须晚于开始时间") } }
  if values["offset"] != nil { _ = try bottleInteger(values["offset"], max: 1_000_000) }
  var parts = URLComponents(); parts.queryItems = values.keys.sorted().map { URLQueryItem(name: $0, value: bottleText(values, $0)) }
  return values.isEmpty ? "" : "?" + (parts.percentEncodedQuery ?? "")
}
extension LiveCommand.Step {
  var bottleStorageProof: [String: Any]? { guard let recoveryBody else { return nil }; return (try? bottleObject(recoveryBody))?["bottleStorage"] as? [String: Any] }
}
func secureBottleStorageCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, var proof = step.bottleStorageProof else { return command }
  guard command.steps.count == 1, proof["payloadKey"] == nil else { throw CatalogError("请恢复原存酒请求，不要重新保存") }
  let data = try bottleBytes(["body": step.object, "proof": proof]), key = "bottle-storage-" + command.id
  let authenticationKey = SymmetricKey(size: .bits256)
  let envelope = try bottleBytes(["payload": data.base64EncodedString(), "authenticationKey": authenticationKey.withUnsafeBytes { Data($0).base64EncodedString() }])
  try store(key, String(decoding: envelope, as: UTF8.self))
  proof.removeValue(forKey: "confirmation"); proof["payloadKey"] = key; proof["payloadAuthentication"] = HMAC<SHA256>.authenticationCode(for: data, using: authenticationKey).map { String(format: "%02x", $0) }.joined()
  guard Set(proof.keys).isSubset(of: ["operation", "employeeId", "target", "version", "categoryExpected", "payloadKey", "payloadAuthentication"]) else { throw StaffAPIError.invalid }
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对存酒原请求", permission: command.permission,
    steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key,
      recoveryBody: try bottleBytes(["bottleStorage": proof]))], completedSteps: command.completedSteps, rejected: command.rejected)
}
func bottleStorageRequestBody(_ command: LiveCommand, step: LiveCommand.Step, read: (String) throws -> String) throws -> [String: Any] {
  guard command.steps.count == 1, command.steps.first == step, UUID(uuidString: command.id) != nil, command.id == command.id.lowercased(),
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    let proof = step.bottleStorageProof, proof["employeeId"] as? String == command.employeeID,
    let op = proof["operation"] as? String, command.permission == (try bottleStoragePermission(op)),
    step.path == (try bottleStoragePath(op, target: proof["target"] as? String)),
    let key = proof["payloadKey"] as? String, key == "bottle-storage-" + command.id,
    let digest = proof["payloadAuthentication"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
    proof["confirmation"] == nil, step.body == Data("{}".utf8) else { throw StaffAPIError.invalid }
  let envelope = try bottleObject(Data(try read(key).utf8))
  guard let encoded = envelope["payload"] as? String, let data = Data(base64Encoded: encoded),
    let authentication = envelope["authenticationKey"] as? String, let keyBytes = Data(base64Encoded: authentication), keyBytes.count == 32,
    HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: keyBytes)).map({ String(format: "%02x", $0) }).joined() == digest,
    let body = try bottleObject(data)["body"] as? [String: Any], var original = try bottleObject(data)["proof"] as? [String: Any] else { throw CatalogError("原存酒安全载荷不一致，未发送") }
  original.removeValue(forKey: "confirmation"); var saved = proof; saved.removeValue(forKey: "payloadKey"); saved.removeValue(forKey: "payloadAuthentication")
  guard NSDictionary(dictionary: original).isEqual(to: saved) else { throw StaffAPIError.invalid }
  _ = try bottleStorageHeaders(step)
  return body
}
func bottleStorageHeaders(_ step: LiveCommand.Step) throws -> [String: String] {
  guard let proof = step.bottleStorageProof, let op = proof["operation"] as? String else { throw StaffAPIError.invalid }
  var headers = [step.keyHeader: step.key]
  if !["create", "category", "policy", "export", "report_export"].contains(op) { headers["x-custody-version"] = String(try bottleInteger(proof["version"], min: 1)) }
  if let expected = proof["categoryExpected"] as? String {
    guard op == "category", expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }; headers["x-custody-category"] = expected
  }
  return headers
}
struct BottleStorageReceipt: Codable, Equatable {
  let employeeID: String, requestKey: String, operation: String, result: Data
  var object: [String: Any] { (try? bottleObject(result)) ?? [:] }
  var message: String {
    switch operation {
    case "verify": return bottleText(object, "message")
    case "request_code": return "发送任务已登记，尚不代表验证码送达。请刷新查看发送结果。"
    case "print_prepared": return "存酒凭证已生成；请使用系统打印，并在现场核对出纸。"
    case "export", "report_export": return "报表已生成，可保存到你选择的位置；登记价值和订单应付金额均不等于实收。"
    case "collect": return "本次取酒已登记，请继续处理本次饮用完毕或再次寄存。"
    default: return "存酒操作已登记，请重新读取当前资料。"
    }
  }
}
func validateBottleStorageReceipt(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws -> BottleStorageReceipt {
  let root = try bottleObject(bytes)
  guard let meta = root["meta"] as? [String: Any], try bottleInteger(meta["protocol"]) == 1,
    let proof = step.bottleStorageProof, let op = proof["operation"] as? String,
    let data = root["data"] as? [String: Any], data["operation"] as? String == op,
    let employee = proof["employeeId"] as? String, data["employeeId"] as? String == employee,
    data["requestKey"] as? String == step.key, let result = data["result"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try bottleBoolean(meta["replayed"]); _ = try bottleStoragePermission(op)
  switch op {
  case "create", "collect", "resolve_collection", "archive", "expiry":
    let detail = try BottleStorageDetail(result)
    if op == "create" {
      for key in ["member_no": "memberNo", "category_id": "categoryId", "item_name": "itemName", "unit": "unit"] { guard detail.order.text(key.key) == body[key.value] as? String else { throw StaffAPIError.invalid } }
      guard try bottleQuantity(detail.order.text("original_quantity")) == bottleQuantity(body["quantity"] as? String ?? "") else { throw StaffAPIError.invalid }
    } else { guard detail.order.id == proof["target"] as? String, try bottleInteger(detail.order.object["version"], min: 1) >= bottleInteger(proof["version"], min: 1) else { throw StaffAPIError.invalid } }
    if op == "archive", detail.order.text("status") != "archived" { throw StaffAPIError.invalid }
    if op == "collect", !detail.collections.contains(where: { $0.text("status") == "collected" }) { throw StaffAPIError.invalid }
    if op == "resolve_collection" { guard let row = detail.collections.first(where: { $0.id == body["collectionId"] as? String }), row.text("status") == (body["quantity"] is NSNull ? "archived" : "restored") else { throw StaffAPIError.invalid } }
    if op == "expiry" { guard bottleStoredDate(detail.order.text("expires_at")) == (try bottleInstant(body["expiresAt"] as? String ?? "")) else { throw StaffAPIError.invalid } }
  case "request_code": _ = try bottleUUID(result["challengeId"]); guard result["deliveryStatus"] as? String == "pending" else { throw StaffAPIError.invalid }
  case "verify": _ = try bottleBoolean(result["verified"]); _ = try bottleString(result, "message", min: 1)
  case "category": _ = try bottleUUID(result["id"]); if let id = body["id"] as? String, result["id"] as? String != id { throw StaffAPIError.invalid }
  case "policy":
    guard try bottleInteger(result["version"], min: 1) > bottleInteger(body["version"]), let raw = result["policy"] as? [String: Any],
      NSDictionary(dictionary: raw).isEqual(to: body["policy"] as? [String: Any] ?? [:]) else { throw StaffAPIError.invalid }
  case "print_prepared":
    guard let document = result["document"] as? [String: Any], let order = document["order"] as? [String: Any],
      order["id"] as? String == proof["target"] as? String, order["public_id"] as? String == result["publicId"] as? String,
      let policy = document["policy"] as? [String: Any] else { throw StaffAPIError.invalid }
    try JSONDecoder().decode(BottleStoragePolicy.self, from: bottleBytes(policy)).validate()
  case "export", "report_export":
    guard let encoded = result["base64"] as? String, let data = Data(base64Encoded: encoded), data.starts(with: [0x50, 0x4b]), data.count <= 25_000_000,
      result["filename"] as? String == (op == "export" ? "MBOX-存酒明细.xlsx" : "MBOX-可选范围报表.xlsx") else { throw StaffAPIError.invalid }
    _ = try bottleInteger(result["count"], max: 10000)
    if op == "export", result["amountStatus"] as? String != "declared_value_not_revenue" { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
  return BottleStorageReceipt(employeeID: employee, requestKey: step.key, operation: op, result: try bottleBytes(result))
}
