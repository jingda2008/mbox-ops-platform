import Foundation

let nativeStaffChangeKinds = ["role_permission": "操作权限", "employee_override": "个人授权", "role_data_scope": "数据范围", "role_approval_limit": "审批额度", "role_navigation": "工作入口"]
func nativeStaffDefinition(_ board: NativeManagementBoard, kind: String, code: String) throws -> NativeManagementRow {
  if kind == "role_permission" || kind == "employee_override" {
    return try board.originalRow("permissions", id: code)
  }
  return try board.originalRow("configurationDefinitions", id: String(kind.dropFirst(5)) + ":" + code)
}
func nativeStaffChange(board: NativeManagementBoard, targetID: String, kind: String,
  code: String, fields: [String: String]) throws -> [String: Any] {
  guard nativeStaffChangeKinds[kind] != nil else { throw StaffAPIError.invalid }
  let employee = kind == "employee_override", row = try board.originalRow(employee ? "employees" : "roles", id: targetID)
  let definition = try nativeStaffDefinition(board, kind: kind, code: code), f = NativeManagementInput(values: fields)
  let config = definition.object["config"] as? [String: Any] ?? [:]
  var change: [String: Any] = ["kind": kind, employee ? "employeeId" : "roleId": row.id]
  let enabled = employee ? false : try f.boolean("enabled")
  switch kind {
  case "role_permission": change["permissionCode"] = code; change["enabled"] = enabled
  case "employee_override":
    guard ["default", "grant", "deny"].contains(f.text("effect")) else { throw StaffAPIError.invalid }
    change["permissionCode"] = code; change["effect"] = f.text("effect") == "default" ? NSNull() : f.text("effect") as Any
  case "role_data_scope":
    let editor = config["editor"] as? String ?? "", effect = config["effect"] as? String ?? "include"
    change["scopeKey"] = code; change["effect"] = effect; change["enabled"] = enabled
    if editor == "boolean" { change["scopeValue"] = config["enabledValue"] ?? true }
    else {
      guard ["area_multi", "employee_multi", "multi_choice"].contains(editor),
        let values = try JSONSerialization.jsonObject(with: Data((fields["values"] ?? "[]").utf8)) as? [String] else { throw CatalogError("此数据范围类型尚未支持编辑") }
      change["scopeValue"] = values
    }
  case "role_approval_limit":
    let currency = config["currency"] as? String ?? "CNY"
    let current = (row.object["approvalLimits"] as? [[String: Any]] ?? []).first { $0["code"] as? String == code && $0["currency"] as? String == currency }
    var rules = current?["rules"] as? [String: Any] ?? config["defaultRules"] as? [String: Any] ?? [:]
    let controls = config["controls"] as? [String] ?? []
    rules["requiresReason"] = true
    if controls.contains("second_actor") { rules["requiresSecondActor"] = true }
    if controls.contains("discount_percent") { rules["discountBasisPoints"] = try f.integer("discountBasisPoints", 0...10000) }
    change["approvalCode"] = code; change["currency"] = currency; change["rules"] = rules; change["enabled"] = enabled
    change["amountMinor"] = f.text("amountMinor").isEmpty ? NSNull() : try ownerMoney(f.text("amountMinor"))
  case "role_navigation":
    let current = (row.object["navigation"] as? [[String: Any]] ?? []).first { $0["code"] as? String == code }
    var display = current?["displayConfig"] as? [String: Any] ?? [:]
    display["highFrequency"] = try f.boolean("highFrequency")
    change["navigationCode"] = code; change["label"] = try f.required("label", 1...30)
    change["route"] = config["route"] ?? NSNull(); change["icon"] = config["icon"] ?? NSNull()
    change["sortOrder"] = try f.integer("sortOrder", 0...999); change["enabled"] = enabled; change["displayConfig"] = display
  default: throw StaffAPIError.invalid
  }
  try validateNativeStaffChanges([change], board: board)
  return change
}
func validateNativeStaffChanges(_ changes: [[String: Any]], board: NativeManagementBoard? = nil) throws {
  guard (1...100).contains(changes.count) else { throw StaffAPIError.invalid }
  var unique: Set<String> = []
  for change in changes {
    guard let kind = change["kind"] as? String, nativeStaffChangeKinds[kind] != nil else { throw StaffAPIError.invalid }
    let employee = kind == "employee_override", target = try managementUUID(change[employee ? "employeeId" : "roleId"])
    let key = kind == "role_navigation" ? "navigationCode" : kind == "role_data_scope" ? "scopeKey" : kind == "role_approval_limit" ? "approvalCode" : "permissionCode"
    let code = try managementText(change, key, 3...128)
    guard code.range(of: "^[a-z][a-z0-9_.-]{2,127}$", options: .regularExpression) != nil,
      unique.insert(kind + ":" + target + ":" + code).inserted else { throw CatalogError("同一配置项只能有一项待发布修改") }
    var definition: NativeManagementRow?
    if let board {
      _ = try board.originalRow(employee ? "employees" : "roles", id: target)
      definition = try nativeStaffDefinition(board, kind: kind, code: code)
    }
    let config = definition?.object["config"] as? [String: Any] ?? [:]
    switch kind {
    case "role_permission":
      try managementExact(change, ["kind", "roleId", "permissionCode", "enabled"]); _ = try managementBool(change["enabled"])
    case "employee_override":
      try managementExact(change, ["kind", "employeeId", "permissionCode", "effect"])
      guard change["effect"] is NSNull || ["grant", "deny"].contains(change["effect"] as? String ?? "") else { throw StaffAPIError.invalid }
    case "role_data_scope":
      try managementExact(change, ["kind", "roleId", "scopeKey", "effect", "scopeValue", "enabled"])
      _ = try managementBool(change["enabled"])
      guard let effect = change["effect"] as? String, ["include", "exclude"].contains(effect), let value = change["scopeValue"], !(value is NSNull) else { throw StaffAPIError.invalid }
      if let board {
        guard effect == (config["effect"] as? String ?? "include"), let editor = config["editor"] as? String else { throw StaffAPIError.invalid }
        if editor == "boolean" { guard managementJSONEqual(value, config["enabledValue"] ?? true) else { throw StaffAPIError.invalid } }
        else {
          let options: Set<String>
          switch editor {
          case "area_multi": options = Set(board.rows("areas").map(\.id))
          case "employee_multi": options = Set(board.rows("employees").filter { $0.text("status") == "active" }.map(\.id))
          case "multi_choice": options = Set(config["options"] as? [String] ?? [])
          default: throw CatalogError("此数据范围类型尚未支持编辑")
          }
          guard let values = value as? [String], Set(values).count == values.count, Set(values).isSubset(of: options) else { throw StaffAPIError.invalid }
        }
      }
    case "role_approval_limit":
      try managementExact(change, ["kind", "roleId", "approvalCode", "amountMinor", "currency", "rules", "enabled"])
      _ = try managementBool(change["enabled"])
      if !(change["amountMinor"] is NSNull) { guard (0...100_000_000_000).contains(try managementInt(change["amountMinor"])) else { throw StaffAPIError.invalid } }
      guard let currency = change["currency"] as? String, currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil,
        let rules = change["rules"] as? [String: Any], try managementBool(rules["requiresReason"]) else { throw StaffAPIError.invalid }
      if definition != nil {
        guard currency == (config["currency"] as? String ?? "CNY") else { throw StaffAPIError.invalid }
        let controls = config["controls"] as? [String] ?? []
        if controls.contains("second_actor") { guard try managementBool(rules["requiresSecondActor"]) else { throw StaffAPIError.invalid } }
        if controls.contains("discount_percent") { guard (0...10000).contains(try managementInt(rules["discountBasisPoints"])) else { throw StaffAPIError.invalid } }
      }
    case "role_navigation":
      try managementExact(change, ["kind", "roleId", "navigationCode", "label", "route", "icon", "sortOrder", "enabled", "displayConfig"])
      _ = try managementBool(change["enabled"]); _ = try managementText(change, "label", 1...30)
      guard let route = change["route"] as? String, StaffNavigation.knownRoutes.contains(route),
        (0...999).contains(try managementInt(change["sortOrder"])), let display = change["displayConfig"] as? [String: Any] else { throw StaffAPIError.invalid }
      _ = try managementBool(display["highFrequency"])
      guard change["icon"] is NSNull || change["icon"] is String else { throw StaffAPIError.invalid }
      if definition != nil {
        guard route == config["route"] as? String, managementJSONEqual(change["icon"]!, config["icon"] ?? NSNull()) else { throw StaffAPIError.invalid }
      }
    default: throw StaffAPIError.invalid
    }
  }
}
