import Foundation

let nativeDeviceOperations: Set<String> = ["device-create", "device-update", "route-save", "policy-save", "bridge-revoke", "device-test"]
let nativeDeviceStations = ["bar": "吧台", "kitchen": "后厨", "cashier": "收银", "service": "服务"]
let nativeDeviceStatuses = ["active": "启用", "paused": "暂停", "retired": "退役"]
let nativePrintProfiles = ["escpos_58": "58毫米热敏", "escpos_80": "80毫米热敏", "windows_text": "Windows文本"]
let nativeTicketKinds = ["bar_production": "吧台制作单", "kitchen_production": "后厨制作单",
  "order_summary": "整单汇总", "delivery": "配送单", "cashier_settlement": "预结算单",
  "cashier_payment": "支付凭证", "cashier_refund": "退款凭证", "table_settlement": "整桌归档", "daily_settlement": "营业日结单"]
let nativeDeviceActions = ["test_print": "测试打印", "ping": "检测连接", "reconnect": "重新连接"]

extension NativeManagementBoard {
  func deviceCommand(actor: StaffIdentity, operation: String, fields: [String: String], rowID: String?) throws -> LiveCommand {
    guard module == .devices, nativeDeviceOperations.contains(operation) else { throw StaffAPIError.invalid }
    func text(_ key: String) -> String { (fields[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    func required(_ key: String, _ range: ClosedRange<Int>) throws -> String {
      let value = text(key)
      guard range.contains(value.utf16.count) else { throw CatalogError("请完整填写名称、配置和处理说明") }
      return value
    }
    func number(_ key: String, _ bounds: ClosedRange<Int>) throws -> Int {
      let value = text(key)
      guard value.range(of: "^(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
        let result = Int(value), bounds.contains(result) else { throw CatalogError("请填写范围内的整数") }
      return result
    }
    func original(_ collection: String) throws -> NativeManagementRow {
      guard let rowID, let row = rows(collection).first(where: { $0.id == rowID }) else { throw CatalogError("原配置不存在，请刷新") }
      return row
    }
    func fingerprint(_ row: NativeManagementRow) throws -> String {
      let value = row.text("configurationFingerprint")
      guard managementHash(value) else { throw CatalogError("缺少原配置版本，请刷新") }
      return value
    }
    let reason = try required("reason", 3...500)
    var body: [String: Any] = ["kind": operation, "reason": reason]
    var summary = ""
    var targetId: String?
    switch operation {
    case "device-create", "device-update":
      let code = text("code"), name = try required("name", 1...120), station = text("stationCode"), status = text("status")
      guard code.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", options: .regularExpression) != nil,
        nativeDeviceStations[station] != nil, nativeDeviceStatuses[status] != nil else { throw CatalogError("请核对设备编码、岗位和状态") }
      if operation == "device-create" {
        guard status == "active" else { throw CatalogError("新打印机须以启用状态创建") }
      } else {
        let row = try original("devices")
        guard UUID(uuidString: row.id) != nil, row.text("code") == code,
          row.text("status") != "retired" || status == "retired" else { throw CatalogError("原设备编号不能改变；已退役设备不能恢复启用") }
        body["id"] = row.id; body["expected"] = try fingerprint(row); targetId = row.id
      }
      let bridge = text("printBridgeId"), queue = text("windowsQueueName"), profile = text("printProfile")
      guard bridge.isEmpty == queue.isEmpty, bridge.isEmpty == profile.isEmpty,
        bridge.isEmpty || UUID(uuidString: bridge) != nil,
        profile.isEmpty || nativePrintProfiles[profile] != nil,
        queue.utf16.count <= 180 else { throw CatalogError("桥接器、队列和打印格式须完整配置或一起清空") }
      let before = rowID.flatMap { id in rows("devices").first { $0.id == id } }
      let changedBinding = before.map { $0.text("printBridgeId") != bridge || $0.text("windowsQueueName") != queue || $0.text("printProfile") != profile } ?? true
      let needsQueueCheck = operation == "device-create" || (status == "active" && (changedBinding || before?.text("status") != "active"))
      if needsQueueCheck && !bridge.isEmpty {
        guard rows("bridges").contains(where: {
          $0.id == bridge && $0.text("status") == "active" && $0.strings("queues").contains(queue)
        }) else { throw CatalogError("启用或变更打印连接时，请选择有效桥接器及该电脑上报的队列") }
      }
      body["device"] = ["code": code, "name": name, "stationCode": station, "status": status,
        "printBridgeId": bridge.isEmpty ? NSNull() : bridge as Any,
        "windowsQueueName": queue.isEmpty ? NSNull() : queue as Any,
        "printProfile": profile.isEmpty ? NSNull() : profile as Any]
      summary = name + " · " + (nativeDeviceStations[station] ?? station) + " · " + (nativeDeviceStatuses[status] ?? status)
    case "route-save":
      let code = text("code"), name = try required("name", 1...120), station = text("stationCode"), status = text("status")
      let printer = text("printerDeviceId"), category = text("productCategoryCode")
      guard code.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", options: .regularExpression) != nil,
        ["bar", "kitchen", "cashier"].contains(station), nativeDeviceStatuses[status] != nil,
        rows("devices").contains(where: { $0.id == printer && $0.text("status") != "retired" && $0.text("deviceType") == "printer" }),
        category.utf16.count <= 64 else { throw CatalogError("请核对路由编码、岗位、可用打印机和分类") }
      if rowID != nil {
        let row = try original("routes")
        guard row.text("code") == code else { throw CatalogError("原路由编号不能改变") }
        body["expected"] = try fingerprint(row); targetId = row.id
      } else {
        guard !rows("routes").contains(where: { $0.text("code") == code }) else { throw CatalogError("路由编号已存在，请从原路由编辑") }
        body["expected"] = NSNull()
      }
      let copies = try number("copies", 1...5), priority = try number("priority", 0...1000)
      body["route"] = ["code": code, "name": name, "stationCode": station, "status": status,
        "printerDeviceId": printer, "copies": copies, "priority": priority,
        "productCategoryCode": category.isEmpty ? NSNull() : category as Any]
      summary = name + " · \(copies)份 · " + (nativeDeviceStatuses[status] ?? status)
    case "policy-save":
      let row = try original("policies"), ticket = row.text("ticketKind")
      guard nativeTicketKinds[ticket] != nil, ["true", "false"].contains(text("enabled")) else { throw CatalogError("原票据策略不兼容，请刷新") }
      let copies: Any = text("copies").isEmpty ? NSNull() : try number("copies", 1...5)
      body["expected"] = try fingerprint(row)
      body["policy"] = ["ticketKind": ticket, "enabled": text("enabled") == "true", "copies": copies]
      summary = (nativeTicketKinds[ticket] ?? ticket) + " · " + (text("enabled") == "true" ? "自动打印开启" : "自动打印关闭")
        + " · " + (copies is NSNull ? "份数跟随路由" : "固定\(copies)份")
    case "bridge-revoke":
      let row = try original("bridges")
      guard bridgeRevocationEnabled, row.text("status") == "active", UUID(uuidString: row.id) != nil else { throw CatalogError("原桥接器已变化或后台尚未开放安全撤销") }
      body["id"] = row.id; targetId = row.id
      summary = "撤销 " + row.text("name") + " · " + row.text("hostname") + "\n该电脑停止接收新任务；已排队票据不会自动改投。"
    case "device-test":
      let row = try original("devices"), action = text("command")
      guard row.text("status") != "retired", nativeDeviceActions[action] != nil else { throw CatalogError("原设备或操作已变化") }
      body["id"] = row.id; body["expected"] = try fingerprint(row); body["command"] = action; targetId = row.id
      summary = (nativeDeviceActions[action] ?? action) + " · " + row.text("name")
    default: throw StaffAPIError.invalid
    }
    let id = UUID().uuidString.lowercased()
    var proof: [String: Any] = ["module": module.rawValue, "operation": operation, "employeeId": actor.employee.id,
      "targetId": targetId as Any? ?? NSNull(), "confirmation": summary + "\n说明：" + reason + "\n"
        + (operation == "device-test" ? "这里只创建原设备任务；请刷新核对设备回报和现场出纸。" : "影响后续打印；保存配置不等于设备在线或已经出纸。")]
    proof["expected"] = body["expected"] ?? NSNull()
    proof["targetCode"] = (body["device"] as? [String: Any])?["code"] ?? (body["route"] as? [String: Any])?["code"] ?? NSNull()
    proof["ticketKind"] = (body["policy"] as? [String: Any])?["ticketKind"] ?? NSNull()
    return LiveCommand(id: id, employeeID: actor.employee.id,
      title: operation == "device-test" ? "核对原设备操作" : "核对打印配置",
      permission: actor.allows("printer.manage") ? "printer.manage" : "hardware.manage",
      steps: [.init(path: nativeManagementPath(module: module, operation: operation, proof: proof),
        body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-business-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: ["nativeManagement": proof], options: .sortedKeys))])
  }
}
func validateNativeDeviceReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let proof = step.nativeManagementProof,
    let operation = proof["operation"] as? String, nativeDeviceOperations.contains(operation),
    body["kind"] as? String == operation,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], (try? managementBool(meta["replayed"])) != nil,
    let data = root["data"] as? [String: Any],
    data["kind"] as? String == operation, data["employeeId"] as? String == proof["employeeId"] as? String,
    data["reason"] as? String == body["reason"] as? String,
    let row = data["row"] as? [String: Any] else { throw StaffAPIError.invalid }
  var expected: [String: Any]
  switch operation {
  case "device-create", "device-update":
    guard let values = body["device"] as? [String: Any] else { throw StaffAPIError.invalid }
    expected = values; expected["deviceType"] = "printer"
    if operation == "device-update" { expected["id"] = body["id"] }
  case "route-save":
    guard let values = body["route"] as? [String: Any] else { throw StaffAPIError.invalid }
    expected = values
    if let target = proof["targetId"] as? String { expected["id"] = target }
  case "policy-save":
    guard let values = body["policy"] as? [String: Any], values["copies"] != nil else { throw StaffAPIError.invalid }
    expected = values
  case "bridge-revoke":
    guard let id = body["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
    expected = ["id": id, "status": "revoked"]
  case "device-test":
    guard let id = body["id"] as? String, UUID(uuidString: id) != nil,
      let action = body["command"] as? String, nativeDeviceActions[action] != nil else { throw StaffAPIError.invalid }
    expected = ["deviceId": id, "commandType": action, "publicId": step.key, "status": "requested"]
  default: throw StaffAPIError.invalid
  }
  if operation != "policy-save" {
    guard let id = row["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
  }
  for (key, value) in expected {
    guard let actual = row[key], managementSameScalar(value, actual) else { throw StaffAPIError.invalid }
  }
}

// Validate the exact original body again after reading its secure slot. This
// binds the ordinary checkpoint's target/version to the original request.
func validateNativeDeviceBody(_ body: [String: Any], proof: [String: Any]) throws {
  guard let operation = proof["operation"] as? String, nativeDeviceOperations.contains(operation),
    body["kind"] as? String == operation, let reason = body["reason"] as? String,
    (3...500).contains(reason.utf16.count), reason == reason.trimmingCharacters(in: .whitespacesAndNewlines)
  else { throw StaffAPIError.invalid }
  func exact(_ row: [String: Any], _ keys: [String]) throws {
    guard Set(row.keys) == Set(keys) else { throw StaffAPIError.invalid }
  }
  func text(_ row: [String: Any], _ key: String, _ range: ClosedRange<Int>) throws -> String {
    guard let value = row[key] as? String, range.contains(value.utf16.count),
      value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { throw StaffAPIError.invalid }
    return value
  }
  func uuid(_ value: Any?) throws -> String {
    guard let value = value as? String, UUID(uuidString: value) != nil else { throw StaffAPIError.invalid }
    return value
  }
  let nullable: Any = NSNull()
  guard managementSameScalar(body["expected"] ?? nullable, proof["expected"] ?? "missing") else { throw StaffAPIError.invalid }
  let target = proof["targetId"]
  if ["device-update", "device-test", "bridge-revoke"].contains(operation) {
    guard try uuid(body["id"]) == uuid(target) else { throw StaffAPIError.invalid }
  } else if operation == "route-save", body["expected"] is String {
    _ = try uuid(target)
  } else { guard target is NSNull else { throw StaffAPIError.invalid } }
  if let expected = body["expected"] as? String {
    guard managementHash(expected) else { throw StaffAPIError.invalid }
  } else if ["device-update", "device-test", "policy-save"].contains(operation) { throw StaffAPIError.invalid }
  switch operation {
  case "device-create", "device-update":
    try exact(body, operation == "device-create" ? ["kind", "reason", "device"] : ["kind", "reason", "device", "id", "expected"])
    guard let row = body["device"] as? [String: Any] else { throw StaffAPIError.invalid }
    try exact(row, ["code", "name", "stationCode", "status", "printBridgeId", "windowsQueueName", "printProfile"])
    let code = try text(row, "code", 2...64)
    guard code.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", options: .regularExpression) != nil,
      code == proof["targetCode"] as? String,
      nativeDeviceStations[try text(row, "stationCode", 1...20)] != nil,
      nativeDeviceStatuses[try text(row, "status", 1...20)] != nil,
      operation != "device-create" || row["status"] as? String == "active" else { throw StaffAPIError.invalid }
    _ = try text(row, "name", 1...120)
    if row["printBridgeId"] is NSNull {
      guard row["windowsQueueName"] is NSNull, row["printProfile"] is NSNull else { throw StaffAPIError.invalid }
    } else {
      _ = try uuid(row["printBridgeId"]); _ = try text(row, "windowsQueueName", 1...180)
      guard nativePrintProfiles[try text(row, "printProfile", 1...40)] != nil else { throw StaffAPIError.invalid }
    }
    guard proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  case "route-save":
    try exact(body, ["kind", "reason", "expected", "route"])
    guard body["expected"] is NSNull || body["expected"] is String,
      let row = body["route"] as? [String: Any] else { throw StaffAPIError.invalid }
    try exact(row, ["code", "name", "stationCode", "productCategoryCode", "printerDeviceId", "copies", "priority", "status"])
    let code = try text(row, "code", 2...64)
    guard code.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$", options: .regularExpression) != nil,
      code == proof["targetCode"] as? String,
      ["bar", "kitchen", "cashier"].contains(try text(row, "stationCode", 1...20)),
      nativeDeviceStatuses[try text(row, "status", 1...20)] != nil,
      (1...5).contains(try managementInt(row["copies"])), (0...1000).contains(try managementInt(row["priority"])) else { throw StaffAPIError.invalid }
    _ = try text(row, "name", 1...120); _ = try uuid(row["printerDeviceId"])
    if !(row["productCategoryCode"] is NSNull) { _ = try text(row, "productCategoryCode", 1...64) }
    guard proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  case "policy-save":
    try exact(body, ["kind", "reason", "expected", "policy"])
    guard let row = body["policy"] as? [String: Any], let ticket = row["ticketKind"] as? String,
      nativeTicketKinds[ticket] != nil, ticket == proof["ticketKind"] as? String else { throw StaffAPIError.invalid }
    try exact(row, ["ticketKind", "enabled", "copies"])
    _ = try managementBool(row["enabled"])
    if !(row["copies"] is NSNull) { guard (1...5).contains(try managementInt(row["copies"])) else { throw StaffAPIError.invalid } }
    guard proof["targetCode"] is NSNull else { throw StaffAPIError.invalid }
  case "bridge-revoke":
    try exact(body, ["kind", "reason", "id"])
    guard proof["targetCode"] is NSNull, proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  case "device-test":
    try exact(body, ["kind", "reason", "id", "expected", "command"])
    guard let action = body["command"] as? String, nativeDeviceActions[action] != nil,
      proof["targetCode"] is NSNull, proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
}
