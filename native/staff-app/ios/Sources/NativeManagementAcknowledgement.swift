import Foundation
import Security

// A receipt is stored independently before the ordinary completed-step checkpoint.
// It authorizes only local cleanup of this exact original request, never sending.
enum NativeManagementReceipts {
  private static let service = "com.mbox.staff.native-management.receipts.v1"
  private static func query(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
  }
  static func read(_ key: String) throws -> String? {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(key).merging([
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
      throw CatalogError("原管理回执暂不可读，请解锁设备后核对")
    }
    return text
  }
  static func store(_ key: String, _ value: String) throws {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    let status = SecItemAdd(query(key).merging([kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard try read(key) == value else { throw CatalogError("原管理回执已存在但内容不同，请核对") }
    } else if status != errSecSuccess { throw CatalogError("服务器回执未能安全保存，请保留原请求恢复") }
  }
  static func remove(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}
private func nativeManagementAcknowledgementBinding(_ command: LiveCommand) throws -> String {
  guard command.steps.count == 1 else { throw StaffAPIError.invalid }
  // completedSteps/rejected/title are ordinary UI state, never completion proof.
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  let stable = LiveCommand(id: command.id, employeeID: command.employeeID, title: "",
    permission: command.permission, steps: command.steps)
  return managementSHA256(try encoder.encode(stable))
}
func hasNativeManagementAcknowledgement(_ command: LiveCommand,
  readPayload: (String) throws -> String, readReceipt: (String) throws -> String?) throws -> Bool {
  guard let step = command.steps.first, step.nativeManagementProof != nil else { return false }
  // Validate structure/HMAC even when an ordinary completedSteps flag was edited.
  let body = try readNativeManagementPayload(command, step: step, read: readPayload)
  guard let receipt = try readReceipt(command.id) else { return false }
  guard let object = try JSONSerialization.jsonObject(with: Data(receipt.utf8)) as? [String: Any],
    Set(object.keys) == Set(["protocol", "commandBinding", "reply"]),
    try managementInt(object["protocol"]) == 1,
    object["commandBinding"] as? String == (try nativeManagementAcknowledgementBinding(command)),
    let encoded = object["reply"] as? String, let reply = Data(base64Encoded: encoded) else { throw StaffAPIError.invalid }
  try validateNativeManagementReply(reply, step: step, body: body)
  return true
}
func recordNativeManagementAcknowledgement(_ reply: Data, command: LiveCommand, step: LiveCommand.Step,
  actor: StaffIdentity, readPayload: (String) throws -> String,
  readReceipt: (String) throws -> String?, storeReceipt: (String, String) throws -> Void) throws {
  let body = try nativeManagementRequestBody(command, step: step, actor: actor, read: readPayload)
  try validateNativeManagementReply(reply, step: step, body: body)
  // Keep the first validated receipt if a local checkpoint failed after it. A
  // later server replay may have different replay metadata but the same result.
  if try hasNativeManagementAcknowledgement(command, readPayload: readPayload, readReceipt: readReceipt) { return }
  let object: [String: Any] = ["protocol": 1, "commandBinding": try nativeManagementAcknowledgementBinding(command), "reply": reply.base64EncodedString()]
  let bytes = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
  guard let value = String(data: bytes, encoding: .utf8) else { throw StaffAPIError.invalid }
  try storeReceipt(command.id, value)
}

struct NativeManagementPersistence {
  var readPayload: (String) throws -> String
  var storePayload: (String, String) throws -> Void
  var removePayload: (String) -> Void
  var readReceipt: (String) throws -> String?
  var storeReceipt: (String, String) throws -> Void
  var removeReceipt: (String) -> Void
  static var device: NativeManagementPersistence {
    .init(readPayload: NativeManagementSecrets.read, storePayload: NativeManagementSecrets.store,
      removePayload: NativeManagementSecrets.remove, readReceipt: NativeManagementReceipts.read,
      storeReceipt: NativeManagementReceipts.store, removeReceipt: NativeManagementReceipts.remove)
  }
}
