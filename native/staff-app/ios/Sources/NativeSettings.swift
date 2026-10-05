import Foundation

let nativeAreaTypes = ["indoor": "室内", "outdoor": "室外", "bar": "吧台", "stage": "舞台", "vip": "包间", "other": "其他"]
let nativeAreaStates = ["active": "使用中", "paused": "暂停", "retired": "停用"]
let nativeTableStates = ["available": "可使用", "paused": "暂停", "retired": "停用"]
let nativeStaffOperations: Set<String> = ["create", "status", "pin", "credential", "deploy"]
let nativeTableOperations: Set<String> = ["area-create", "area-update", "table-create", "table-update"]
let nativeCommerceOperations: Set<String> = ["online-payment", "payment-reservation"]
let nativePublicationPermissions = ["profile-draft": "customer.public-profile.manage", "profile-publish": "customer.public-profile.publish",
  "profile-withdraw": "customer.public-profile.publish", "privacy-draft": "privacy.policy.manage", "privacy-publish": "privacy.policy.publish",
  "privacy-withdraw": "privacy.policy.publish", "contact": "customer.experience.feature.manage"]

struct NativeManagementInput {
  let values: [String: String]
  func text(_ key: String) -> String { (values[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
  func required(_ key: String, _ limits: ClosedRange<Int>) throws -> String {
    let value = text(key)
    guard limits.contains(value.utf16.count) else { throw CatalogError("请完整填写必填项目，并核对字数限制") }
    return value
  }
  func integer(_ key: String, _ limits: ClosedRange<Int>) throws -> Int {
    let value = text(key)
    guard value.range(of: "^-?(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
      let result = Int(value), limits.contains(result) else { throw CatalogError("请填写范围内的整数") }
    return result
  }
  func boolean(_ key: String) throws -> Bool {
    guard ["true", "false"].contains(text(key)) else { throw StaffAPIError.invalid }
    return text(key) == "true"
  }
}
func managementExact(_ body: [String: Any], _ keys: [String]) throws {
  guard Set(body.keys) == Set(keys) else { throw StaffAPIError.invalid }
}
func managementUUID(_ value: Any?) throws -> String {
  guard let value = value as? String, UUID(uuidString: value) != nil else { throw StaffAPIError.invalid }
  return value
}
func managementText(_ body: [String: Any], _ key: String, _ limits: ClosedRange<Int>) throws -> String {
  guard let value = body[key] as? String, limits.contains(value.utf16.count),
    value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { throw StaffAPIError.invalid }
  return value
}
func managementCode(_ value: String, maximum: Int = 32) -> Bool {
  value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,\(maximum - 1)}$", options: .regularExpression) != nil
}
func managementJSONEqual(_ lhs: Any, _ rhs: Any) -> Bool {
  guard let a = try? JSONSerialization.data(withJSONObject: [lhs], options: [.sortedKeys]),
    let b = try? JSONSerialization.data(withJSONObject: [rhs], options: [.sortedKeys]) else { return false }
  return a == b
}
func managementInstant(_ value: String) throws -> Date {
  guard let result = StaffIdentity.date(value) else { throw CatalogError("请填写包含时区的有效时间") }
  return result
}
func nativeSettingsPermission(_ module: NativeManagementModule, operation: String) throws -> String {
  switch module {
  case .homeContent, .launchPopup, .recommendations: return try nativeContentPermission(module, operation)
  case .staff: guard nativeStaffOperations.contains(operation) else { throw StaffAPIError.invalid }; return "staff.access.configure"
  case .tableConfiguration: guard nativeTableOperations.contains(operation) else { throw StaffAPIError.invalid }; return "table.manage"
  case .commercePolicy: guard nativeCommerceOperations.contains(operation) else { throw StaffAPIError.invalid }; return "payment.policy.manage"
  case .publication: guard let permission = nativePublicationPermissions[operation] else { throw StaffAPIError.invalid }; return permission
  default: throw StaffAPIError.invalid
  }
}
extension NativeManagementBoard {
  func originalRow(_ collection: String, id: String?) throws -> NativeManagementRow {
    guard let id, let row = rows(collection).first(where: { $0.id == id }) else { throw CatalogError("原配置不存在，请刷新") }
    return row
  }
  func settingsCommand(actor: StaffIdentity, operation: String, fields: [String: String], rowID: String?) throws -> LiveCommand {
    let permission = try nativeSettingsPermission(module, operation: operation)
    guard actor.allows(permission) else { throw CatalogError("当前员工没有此项修改权限") }
    let f = NativeManagementInput(values: fields)
    var body: [String: Any] = [:], target: Any = NSNull(), targetCode: Any = NSNull(), expected: Any = NSNull()
    var extra: [String: Any] = [:], confirmation = ""
    switch module {
    case .tableConfiguration:
      let table = operation.hasPrefix("table"), update = operation.hasSuffix("update")
      body = ["reason": try f.required("reason", 2...500), "status": f.text("status")]
      let states = table ? nativeTableStates : nativeAreaStates
      guard states[f.text("status")] != nil else { throw CatalogError("请选择有效状态") }
      var row: NativeManagementRow?
      if update {
        row = try originalRow(table ? "tables" : "areas", id: rowID)
        guard let row else { throw StaffAPIError.invalid }
        let stamp = row.text("updatedAt"); guard (10...64).contains(stamp.count) else { throw StaffAPIError.invalid }
        expected = stamp; target = try managementUUID(row.id)
        body[table ? "tableId" : "areaId"] = row.id; body["expectedUpdatedAt"] = stamp
        if table {
          guard row.object["activeSessionId"] is NSNull else { throw CatalogError("此桌正在营业，请完成原桌次后再调整配置") }
        } else if f.text("status") != "active" {
          guard !rows("tables").contains(where: { $0.text("areaId") == row.id && !($0.object["activeSessionId"] is NSNull) }) else { throw CatalogError("区域内仍有营业中桌台，不能停用") }
        }
      }
      if table || !update {
        let code = f.text("code"); guard managementCode(code) else { throw CatalogError("编号使用字母、数字、下划线或短横线，最多32位") }
        body["code"] = code; targetCode = code
      }
      if table {
        let area = try originalRow("areas", id: f.text("areaId"))
        body["areaId"] = area.id; body["displayName"] = try f.required("displayName", 1...120)
        body["capacity"] = try f.integer("capacity", 1...200)
        let minimum: Any = f.text("minimumSpendMinor").isEmpty ? NSNull() : try ownerMoney(f.text("minimumSpendMinor"))
        if !(minimum is NSNull) { guard (try managementInt(minimum)) <= 100_000_000 else { throw CatalogError("最低消费不能超过100万元") } }
        body["minimumSpendMinor"] = minimum
        confirmation = "\(f.text("displayName"))（\(f.text("code"))）\n区域：\(area.text("name")) · 容量：\(f.text("capacity"))人\n最低消费：" + (minimum is NSNull ? "不设置" : f.text("minimumSpendMinor") + "元")
      } else {
        body["name"] = try f.required("name", 1...120); body["areaType"] = f.text("areaType")
        guard nativeAreaTypes[f.text("areaType")] != nil else { throw CatalogError("请选择区域类型") }
        body["sortOrder"] = try f.integer("sortOrder", -100_000...100_000)
        confirmation = f.text("name") + " · " + (nativeAreaTypes[f.text("areaType")] ?? "") + "\n排序：" + f.text("sortOrder")
      }
      confirmation += "\n状态：" + (states[f.text("status")] ?? "") + "\n营业中桌台禁止改变配置；旧账单不随新配置改写。"
    case .commercePolicy:
      guard let row = data["row"] as? [String: Any] else { throw StaffAPIError.invalid }
      let version = try managementInt(row["policyVersion"]), oldOnline = try managementBool(row["policyOnlinePaymentEnabled"]), oldMinutes = try managementInt(row["paymentReservationMinutes"])
      guard version >= 0, (2...30).contains(oldMinutes) else { throw StaffAPIError.invalid }
      expected = version; body = ["expectedVersion": version, "reason": try f.required("reason", 3...1000)]
      extra["baseline"] = ["online": oldOnline, "minutes": oldMinutes]
      if operation == "online-payment" {
        let enabled = try f.boolean("enabled")
        guard enabled != oldOnline else { throw CatalogError("策略未变化") }
        guard try !enabled || managementBool(row["providerConfigured"]) else { throw CatalogError("后台尚未配置支付渠道，不能开放线上支付") }
        body["enabled"] = enabled
        confirmation = enabled ? "开放新线上支付" : "关闭新线上支付\n在途回调、原单查询、退款和对账继续处理。"
      } else {
        let minutes = try f.integer("paymentReservationMinutes", 2...30)
        guard minutes != oldMinutes else { throw CatalogError("保留时长未变化") }
        body["paymentReservationMinutes"] = minutes
        confirmation = "新订单待付款库存保留时间：\(minutes)分钟\n只影响后续新订单。"
      }
      confirmation += "\n基于第\(version)版门店策略"
    case .staff:
      guard let overview = data["overview"] as? [String: Any], let version = overview["configurationVersion"] as? String,
        managementHash(version) else { throw StaffAPIError.invalid }
      expected = version; body = ["expectedVersion": version, "reason": try f.required("reason", 2...200)]
      if ["status", "pin"].contains(operation) {
        let row = try originalRow("employees", id: rowID); target = try managementUUID(row.id); body["employeeId"] = row.id
        confirmation = row.text("displayName") + "（" + row.text("code") + "）"
      }
      switch operation {
      case "create":
        let code = f.text("employeeCode"); guard managementCode(code, maximum: 64) else { throw CatalogError("员工账号格式不正确") }
        let role = try originalRow("roles", id: f.text("roleId")); guard role.text("status") == "active" else { throw CatalogError("请选择启用岗位") }
        body["employeeCode"] = code; targetCode = code; body["displayName"] = try f.required("displayName", 1...64); body["roleId"] = role.id
        confirmation = "建立员工：" + f.text("displayName") + "（" + code + "）\n岗位：" + role.text("name")
      case "status":
        let row = try originalRow("employees", id: rowID)
        guard ["active", "suspended"].contains(f.text("status")), row.text("status") != f.text("status") else { throw CatalogError("请选择与原账号不同的状态") }
        guard row.id != actor.employee.id || f.text("status") != "suspended" else { throw CatalogError("不能暂停当前登录员工，请由另一位管理员处理") }
        body["status"] = f.text("status"); confirmation += f.text("status") == "active" ? " · 启用" : " · 暂停并禁止登录"
      case "pin": confirmation += "\n重置PIN，已有登录全部失效。"
      case "credential":
        let credential = f.values["credential"] ?? ""
        guard (6...128).contains(credential.utf16.count), credential == f.values["repeatSecret"],
          let version = data["credentialVersion"] as? String, managementHash(version) else { throw CatalogError("两次口令须一致，长度为6—128位") }
        let from = try managementInstant(f.text("validFrom")), until = try managementInstant(f.text("validUntil"))
        guard until > from, until > Date() else { throw CatalogError("失效时间须晚于生效时间与当前时间") }
        body["credential"] = credential; body["credentialVersion"] = version
        body["validFrom"] = f.text("validFrom"); body["validUntil"] = f.text("validUntil")
        extra["credentialVersion"] = version
        confirmation = "更换门店口令\n" + f.text("validFrom") + " 至 " + f.text("validUntil") + "\n旧口令验证的设备须重新验证。"
      case "deploy":
        guard let raw = f.values["changes"], let changes = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]],
          (1...100).contains(changes.count) else { throw CatalogError("请加入1—100项明确修改") }
        try validateNativeStaffChanges(changes, board: self)
        body["changes"] = changes
        confirmation = "发布\(changes.count)项权限修改\n" + (f.values["changeSummary"] ?? "") + "\n权限与入口分别控制，隐藏入口不会撤销权限。"
      default: break
      }
      if operation == "create" || operation == "pin" {
        let pin = f.values["pin"] ?? ""
        guard pin.range(of: "^[0-9]{4}$", options: .regularExpression) != nil, pin == f.values["repeatSecret"] else { throw CatalogError("两次PIN须一致，且为4位数字") }
        body["pin"] = pin
      }
    case .publication:
      return try publicationCommand(actor: actor, operation: operation, fields: fields, rowID: rowID)
    default: throw StaffAPIError.invalid
    }
    confirmation += "\n原因：" + (body["reason"] as? String ?? "")
    return try makeSettingsCommand(actor: actor, operation: operation, body: body, target: target,
      targetCode: targetCode, expected: expected, extra: extra, confirmation: confirmation)
  }
  func makeSettingsCommand(actor: StaffIdentity, operation: String, body: [String: Any], target: Any = NSNull(),
    targetCode: Any = NSNull(), expected: Any, extra: [String: Any] = [:], confirmation: String) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased(), permission = try nativeSettingsPermission(module, operation: operation)
    var proof: [String: Any] = ["module": module.rawValue, "operation": operation, "employeeId": actor.employee.id,
      "targetId": target, "targetCode": targetCode, "expected": expected, "ticketKind": NSNull(), "confirmation": confirmation]
    proof.merge(extra) { _, new in new }
    return LiveCommand(id: id, employeeID: actor.employee.id, title: module.title + " · 核对修改", permission: permission,
      steps: [.init(path: nativeManagementPath(module: module, operation: operation, proof: proof), body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-business-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: ["nativeManagement": proof], options: .sortedKeys))])
  }
}
