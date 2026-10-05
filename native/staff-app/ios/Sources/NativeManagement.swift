import Foundation
import CoreFoundation
import CryptoKit

// Canonical modules mirror the existing Android/server contracts. Presentation
// is never authorization; every new command rechecks its original board/actor.
enum NativeManagementModule: String, CaseIterable, Identifiable {
  case devices, staff, tableConfiguration, commercePolicy, publication, homeContent, launchPopup, recommendations
  var id: String { rawValue }
  var path: String {
    switch self {
    case .devices: return "/api/hardware/native-management"
    case .staff: return "/api/staff/native-administration"
    case .tableConfiguration: return "/api/table-management/native-configuration"
    case .commercePolicy: return "/api/staff/native-commerce-policy"
    case .publication: return "/api/staff/native-publication"
    case .homeContent: return "/api/staff/native-home-content"
    case .launchPopup: return "/api/staff/native-launch-popup"
    case .recommendations: return "/api/staff/native-recommendation-policies"
    }
  }
  var title: String {
    switch self {
    case .devices: return "打印设备与路由"
    case .staff: return "员工与岗位权限"
    case .tableConfiguration: return "区域与桌台配置"
    case .commercePolicy: return "门店支付策略"
    case .publication: return "顾客公开内容"
    case .homeContent: return "首页内容与排期"
    case .launchPopup: return "小程序打开弹窗"
    case .recommendations: return "推荐规则与顾客开放"
    }
  }
  func available(to actor: StaffIdentity) -> Bool {
    switch self {
    case .devices: return actor.canOpen(.deviceManagement)
    case .staff: return actor.canOpen(.staffSettings)
    case .tableConfiguration: return actor.canOpen(.tableSettings)
    case .commercePolicy: return actor.canOpen(.commerceSettings)
    case .publication: return actor.canOpen(.publicationSettings)
    case .homeContent, .launchPopup, .recommendations:
      return actor.hasStaffRoute("/staff/customer-experience") && readPermissions.contains(where: actor.allows)
    }
  }
  var readPermissions: [String] {
    if self == .recommendations { return ["recommendation.rule.view"] }
    return permissions
  }
  var permissions: [String] {
    switch self {
    case .devices: return ["hardware.manage", "printer.manage"]
    case .homeContent: return ["community.activity.view", "community.activity.manage", "community.activity.publish"]
    case .launchPopup: return ["community.activity.manage"]
    case .recommendations: return ["recommendation.rule.view", "recommendation.rule.draft", "recommendation.rule.approve", "recommendation.rule.publish"]
    case .staff: return ["staff.access.configure"]
    case .tableConfiguration: return ["table.manage"]
    case .commercePolicy: return ["payment.policy.manage"]
    case .publication: return ["customer.public-profile.manage", "customer.public-profile.publish",
      "privacy.policy.view", "privacy.policy.manage", "privacy.policy.publish", "customer.experience.feature.manage"]
    }
  }
}
struct NativeManagementRow: Identifiable, Equatable {
  let id: String
  let bytes: Data
  init(_ value: [String: Any], idKey: String = "id") throws {
    guard let id = value[idKey] as? String, !id.isEmpty else { throw StaffAPIError.invalid }
    self.id = id
    bytes = try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
  }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] ?? [:] }
  func text(_ key: String) -> String {
    if let value = object[key] as? String { return value }
    if let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() { return value.stringValue }
    return ""
  }
  func bool(_ key: String) -> Bool { (try? managementBool(object[key])) ?? false }
  func integer(_ key: String) -> Int? { try? managementInt(object[key]) }
  func strings(_ key: String) -> [String] { object[key] as? [String] ?? [] }
}
func managementBool(_ value: Any?) throws -> Bool {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw StaffAPIError.invalid }
  return number.boolValue
}
func managementInt(_ value: Any?) throws -> Int {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite, abs(number.doubleValue) <= 9_007_199_254_740_991,
    number.doubleValue == Double(number.int64Value) else { throw StaffAPIError.invalid }
  return number.intValue
}
func managementData(_ bytes: Data) throws -> [String: Any] {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any] else { throw StaffAPIError.invalid }
  return data
}
func managementSameScalar(_ lhs: Any, _ rhs: Any) -> Bool {
  if lhs is NSNull { return rhs is NSNull }
  if let lhs = lhs as? String { return (rhs as? String) == lhs }
  if let lhs = lhs as? NSNumber, let rhs = rhs as? NSNumber {
    let leftBool = CFGetTypeID(lhs) == CFBooleanGetTypeID()
    let rightBool = CFGetTypeID(rhs) == CFBooleanGetTypeID()
    return leftBool == rightBool && lhs.compare(rhs) == .orderedSame
  }
  return false
}
func managementHash(_ value: String) -> Bool {
  value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
}
struct NativeManagementBoard {
  let module: NativeManagementModule
  let employeeID: String
  let enabled: Bool
  let bridgeRevocationEnabled: Bool
  let data: [String: Any]
  private let collections: [String: [NativeManagementRow]]
  func rows(_ key: String) -> [NativeManagementRow] { collections[key] ?? [] }
  init(module: NativeManagementModule, data bytes: Data, bridges: Data? = nil,
    capabilities: Data? = nil, actor: StaffIdentity) throws {
    let data = try managementData(bytes)
    guard data["employeeId"] as? String == actor.employee.id,
      module.permissions.contains(where: actor.allows) else { throw StaffAPIError.invalid }
    self.module = module; self.data = data; employeeID = actor.employee.id
    var collections: [String: [NativeManagementRow]] = [:]
    func load(_ key: String, _ values: Any?, idKey: String = "id") throws {
      guard let values = values as? [[String: Any]] else { throw StaffAPIError.invalid }
      let rows = try values.map { try NativeManagementRow($0, idKey: idKey) }
      guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
      collections[key] = rows
    }
    if module == .devices {
      enabled = try managementBool(data["nativeCommands"])
      for key in ["devices", "routes", "commands"] { try load(key, data[key]) }
      try load("policies", data["policies"], idKey: "ticketKind")
      guard let bridges, let root = try JSONSerialization.jsonObject(with: bridges) as? [String: Any] else { throw StaffAPIError.invalid }
      try load("bridges", root["data"])
      bridgeRevocationEnabled = capabilities.flatMap { try? managementData($0) }
        .flatMap { try? managementBool($0["durableRevocation"]) } ?? false
    } else {
      guard try managementInt(data["protocol"]) == 1 else { throw StaffAPIError.invalid }
      enabled = try managementBool(data["durableCommands"])
      bridgeRevocationEnabled = false
      switch module {
      case .staff:
        guard let overview = data["overview"] as? [String: Any], let version = overview["configurationVersion"] as? String, managementHash(version) else { throw StaffAPIError.invalid }
        for key in ["employees", "roles", "areas"] { try load(key, overview[key]) }
        try load("permissions", overview["permissions"], idKey: "code")
        guard let definitions = overview["configurationDefinitions"] as? [[String: Any]] else { throw StaffAPIError.invalid }
        try load("configurationDefinitions", definitions.map { value in
          var row = value
          row["id"] = (value["kind"] as? String ?? "") + ":" + (value["code"] as? String ?? "")
          return row
        })
        try load("credentials", data["credentials"])
      case .homeContent, .recommendations:
        try load("rows", data["rows"], idKey: module == .homeContent ? "code" : "publicId")
        if !(data["next"] is NSNull) {
          guard let cursor = data["next"] as? String else { throw StaffAPIError.invalid }
          _ = try nativeManagementReadPath(module: module, cursor: cursor, code: data["code"] as? String ?? "DEFAULT")
        }
        for row in collections["rows"] ?? [] {
          guard managementHash(row.text("nativeVersion")) else { throw StaffAPIError.invalid }
          if module == .homeContent { try validateHomeDraft(row.object) } else { try validateRecommendationDraft(row.object) }
        }
        if module == .recommendations {
          guard let code = data["code"] as? String, nativeRecommendationCode(code), try managementInt(data["latest"]) >= 0,
            let feature = data["feature"] as? [String: Any], let version = feature["nativeVersion"] as? String, managementHash(version),
            nativeRecommendationRollouts[feature["rolloutState"] as? String ?? ""] != nil, data["defaultDisplayConfiguration"] is [String: Any] else { throw StaffAPIError.invalid }
        }
      case .launchPopup:
        guard let row = data["row"] as? [String: Any] else { throw StaffAPIError.invalid }; try validatePopupDraft(row)
      case .tableConfiguration:
        try load("areas", data["areas"]); try load("tables", data["tables"])
      case .commercePolicy:
        guard let row = data["row"] as? [String: Any], try managementInt(row["policyVersion"]) >= 0 else { throw StaffAPIError.invalid }
      case .publication:
        for key in ["profiles", "policies", "employees"] { try load(key, data[key]) }
        guard data["permissions"] is [String], data["versions"] is [String: Any] else { throw StaffAPIError.invalid }
      default: break
      }
    }
    self.collections = collections
  }
  func command(actor: StaffIdentity, operation: String, fields: [String: String], rowID: String? = nil) throws -> LiveCommand {
    guard enabled, employeeID == actor.employee.id, module.permissions.contains(where: actor.allows),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else {
      throw CatalogError("原配置、登录或权限已变化，请刷新后核对")
    }
    switch module {
    case .homeContent, .launchPopup, .recommendations: return try customerContentCommand(actor: actor, operation: operation, fields: fields, rowID: rowID)
    case .devices: return try deviceCommand(actor: actor, operation: operation, fields: fields, rowID: rowID)
    default: return try settingsCommand(actor: actor, operation: operation, fields: fields, rowID: rowID)
    }
  }
}
struct NativeBridgePairing: Identifiable, Equatable {
  let id, pairingCode: String
  let expiresAt: Date
  init(data: Data, now: Date = Date()) throws {
    let row = try managementData(data)
    guard let id = row["id"] as? String, UUID(uuidString: id) != nil,
      let code = row["pairingCode"] as? String,
      code.range(of: "^[A-F0-9]{5}(-[A-F0-9]{5}){3}$", options: .regularExpression) != nil,
      let raw = row["expiresAt"] as? String, let expires = assignmentDate(raw),
      expires > now, expires.timeIntervalSince(now) <= 601 else { throw StaffAPIError.invalid }
    self.id = id; pairingCode = code; expiresAt = expires
  }
}
extension LiveCommand.Step {
  var nativeManagementProof: [String: Any]? {
    guard let recoveryBody, let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any] else { return nil }
    return root["nativeManagement"] as? [String: Any]
  }
}
func managementSHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func validateManagementCommand(_ command: LiveCommand, step: LiveCommand.Step,
  body: [String: Any]) throws {
  guard command.steps.count == 1, command.steps.first == step,
    UUID(uuidString: command.id) != nil, command.id == command.id.lowercased(),
    UUID(uuidString: command.employeeID) != nil,
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    let proof = step.nativeManagementProof, proof["employeeId"] as? String == command.employeeID,
    let name = proof["module"] as? String, let module = NativeManagementModule(rawValue: name),
    let operation = proof["operation"] as? String,
    step.path == nativeManagementPath(module: module, operation: operation, proof: proof),
    module.permissions.contains(command.permission) else { throw StaffAPIError.invalid }
  var common = Set(["module", "operation", "employeeId", "targetId", "expected", "targetCode", "ticketKind"])
  if module == .commercePolicy { common.insert("baseline") }
  if module.isCustomerContent { common.insert("before") }
  if module == .staff && operation == "credential" { common.insert("credentialVersion") }
  let secured = proof["payloadKey"] != nil
  guard Set(proof.keys) == common.union(secured ? ["payloadKey", "payloadAuthentication"] : ["confirmation"]) else { throw StaffAPIError.invalid }
  switch module {
  case .homeContent, .launchPopup, .recommendations:
    guard command.permission == (try nativeContentPermission(module, operation)) else { throw StaffAPIError.invalid }
    try validateNativeContentBody(body, proof: proof, module: module)
  case .devices: try validateNativeDeviceBody(body, proof: proof)
  default:
    guard command.permission == (try nativeSettingsPermission(module, operation: operation)) else { throw StaffAPIError.invalid }
    try validateNativeSettingsBody(body, proof: proof, module: module)
  }
}
func secureNativeManagementCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, var proof = step.nativeManagementProof else { return command }
  guard proof["payloadKey"] == nil, proof["payloadAuthentication"] == nil,
    command.completedSteps == 0, !command.rejected,
    let confirmation = proof["confirmation"] as? String, !confirmation.isEmpty,
    let text = String(data: step.body, encoding: .utf8),
    let body = try JSONSerialization.jsonObject(with: step.body) as? [String: Any] else {
    throw CatalogError("请从未决记录恢复原管理请求")
  }
  try validateManagementCommand(command, step: step, body: body)
  // The authentication key lives only in Keychain. A plain body digest in the
  // ordinary checkpoint would allow guessing a short employee PIN or OTP.
  let authenticationKey = SymmetricKey(size: .bits256)
  let keyData = authenticationKey.withUnsafeBytes { Data($0) }
  let envelope: [String: Any] = ["payload": Data(text.utf8).base64EncodedString(),
    "authenticationKey": keyData.base64EncodedString(), "payloadSHA256": managementSHA256(step.body)]
  let envelopeBytes = try JSONSerialization.data(withJSONObject: envelope, options: .sortedKeys)
  guard let envelopeText = String(data: envelopeBytes, encoding: .utf8) else { throw StaffAPIError.invalid }
  // Immutable, independent Keychain slot is written before ordinary pending state.
  try store(command.id, envelopeText)
  proof.removeValue(forKey: "confirmation")
  proof.removeValue(forKey: "row")
  proof["payloadKey"] = command.id
  proof["payloadAuthentication"] = HMAC<SHA256>.authenticationCode(for: step.body, using: authenticationKey).map { String(format: "%02x", $0) }.joined()
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对原管理请求",
    permission: command.permission, steps: [.init(path: step.path, body: Data("{}".utf8),
      keyHeader: step.keyHeader, key: step.key,
      recoveryBody: try JSONSerialization.data(withJSONObject: ["nativeManagement": proof], options: .sortedKeys))],
    completedSteps: command.completedSteps, rejected: command.rejected)
}
func nativeManagementRequestBody(_ command: LiveCommand, step: LiveCommand.Step,
  actor: StaffIdentity, read: (String) throws -> String) throws -> [String: Any] {
  guard command.employeeID == actor.employee.id,
    (actor.allows(command.permission) || isNativeStaffPermissionReceiptRecovery(command)),
    command.steps.count == 1, command.steps.first == step,
    let proof = step.nativeManagementProof, proof["employeeId"] as? String == actor.employee.id,
    proof["payloadKey"] as? String == command.id else { throw CatalogError("原管理请求的员工、权限或安全载荷不匹配，未发送") }
  return try readNativeManagementPayload(command, step: step, read: read)
}
func readNativeManagementPayload(_ command: LiveCommand, step: LiveCommand.Step,
  read: (String) throws -> String) throws -> [String: Any] {
  guard command.steps.count == 1, command.steps.first == step,
    let proof = step.nativeManagementProof, let key = proof["payloadKey"] as? String, key == command.id,
    let authentication = proof["payloadAuthentication"] as? String, managementHash(authentication),
    proof["confirmation"] == nil, proof["row"] == nil, step.body == Data("{}".utf8) else { throw StaffAPIError.invalid }
  let envelopeBytes = Data(try read(key).utf8)
  guard let envelope = try JSONSerialization.jsonObject(with: envelopeBytes) as? [String: Any],
    Set(envelope.keys) == Set(["payload", "authenticationKey", "payloadSHA256"]),
    let payload = envelope["payload"] as? String, let bytes = Data(base64Encoded: payload),
    let encodedKey = envelope["authenticationKey"] as? String, let keyBytes = Data(base64Encoded: encodedKey), keyBytes.count == 32,
    let digest = envelope["payloadSHA256"] as? String, managementSHA256(bytes) == digest,
    HMAC<SHA256>.authenticationCode(for: bytes, using: SymmetricKey(data: keyBytes)).map({ String(format: "%02x", $0) }).joined() == authentication,
    let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
    throw CatalogError("原管理请求安全载荷已变化，未发送")
  }
  try validateManagementCommand(command, step: step, body: body)
  return body
}
func nativeManagementPath(module: NativeManagementModule, operation: String, proof: [String: Any]) -> String {
  if module == .devices {
    if operation == "bridge-revoke", let id = proof["targetId"] as? String, UUID(uuidString: id) != nil {
      return "/api/hardware/native-print-bridges/\(id)/revoke"
    }
    return module.path + "/commands"
  }
  return module == .launchPopup ? module.path : module.path + "/" + operation
}
func isNativeStaffPermissionReceiptRecovery(_ command: LiveCommand) -> Bool {
  guard command.steps.count == 1, let proof = command.steps.first?.nativeManagementProof else { return false }
  return proof["module"] as? String == "staff" && proof["operation"] as? String == "deploy"
}
func validateNativeManagementReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let proof = step.nativeManagementProof, let name = proof["module"] as? String,
    let module = NativeManagementModule(rawValue: name) else { throw StaffAPIError.invalid }
  switch module {
  case .homeContent, .launchPopup, .recommendations: try validateNativeContentReply(bytes, step: step, body: body)
  case .devices: try validateNativeDeviceReply(bytes, step: step, body: body)
  default: try validateNativeSettingsReply(bytes, step: step, body: body)
  }
}

func validNativeManagementSelection(command: LiveCommand, board: NativeManagementBoard, actor: StaffIdentity) -> Bool {
  guard command.completedSteps == 0, !command.rejected, board.enabled,
    command.employeeID == actor.employee.id, board.employeeID == actor.employee.id,
    actor.allows(command.permission), let step = command.steps.first, let proof = step.nativeManagementProof,
    proof["payloadKey"] == nil, proof["module"] as? String == board.module.rawValue,
    let operation = proof["operation"] as? String,
    (try? validateManagementCommand(command, step: step, body: step.object)) != nil else { return false }
  switch board.module {
  case .homeContent, .launchPopup, .recommendations: return validNativeContentSelection(command: command, board: board, actor: actor)
  case .devices:
    switch operation {
    case "device-create": return !board.rows("devices").contains { $0.text("code") == proof["targetCode"] as? String }
    case "device-update", "device-test":
      return board.rows("devices").contains { $0.id == proof["targetId"] as? String && $0.text("configurationFingerprint") == proof["expected"] as? String }
    case "route-save":
      let row = board.rows("routes").first { $0.text("code") == proof["targetCode"] as? String }
      if proof["expected"] is NSNull { return row == nil }
      return row?.id == proof["targetId"] as? String && row?.text("configurationFingerprint") == proof["expected"] as? String
    case "policy-save": return board.rows("policies").contains { $0.id == proof["ticketKind"] as? String && $0.text("configurationFingerprint") == proof["expected"] as? String }
    case "bridge-revoke": return board.bridgeRevocationEnabled && board.rows("bridges").contains { $0.id == proof["targetId"] as? String && $0.text("status") == "active" }
    default: return false
    }
  default: return validNativeSettingsSelection(command: command, board: board, actor: actor)
  }
}
