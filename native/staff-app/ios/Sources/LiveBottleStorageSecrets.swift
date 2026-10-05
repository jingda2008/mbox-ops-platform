import Foundation
import Security

/// Bottle custody photos, contact, verification codes and original request payloads stay in device-only Keychain; the durable business
/// checkpoint contains only the original command references and this key.
enum BottleStorageSecrets {
  private static let service = "com.mbox.staff.bottle-storage"
  static func store(_ key: String, _ value: String) throws {
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key]
    let result = SecItemAdd(base.merging([
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]) { _, new in new } as CFDictionary, nil)
    if result == errSecDuplicateItem {
      guard try read(key) == value else { throw CatalogError("原存酒载荷不一致，未发送") }
    } else if result != errSecSuccess {
      throw CatalogError("存酒请求无法安全保存，未发送")
    }
  }
  static func read(_ key: String) throws -> String {
    var result: CFTypeRef?
    let status = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne] as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
      throw CatalogError("原存酒安全凭据暂不可读，请解锁后恢复原请求")
    }
    return text
  }
  static func remove(_ key: String) {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key] as CFDictionary)
  }
}

extension BottleStorageSecrets {
  /// Keep the last exact generated document/result across a crash. It is never
  /// written into the ordinary LiveCommand file or opened/printed automatically.
  static func saveReceipt(_ receipt: BottleStorageReceipt) throws {
    let key = "receipt-" + receipt.employeeID
    let data = try JSONEncoder().encode(receipt)
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key]
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      let added = SecItemAdd(query.merging([kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
      guard added == errSecSuccess else { throw CatalogError("原存酒回执无法安全保存，请解锁设备后恢复原请求") }
    } else if status != errSecSuccess { throw CatalogError("原存酒回执无法安全保存，请解锁设备后恢复原请求") }
  }
  static func receipt(employeeID: String) throws -> BottleStorageReceipt? {
    guard UUID(uuidString: employeeID) != nil else { throw StaffAPIError.invalid }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: "receipt-" + employeeID,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw CatalogError("原存酒回执暂不可读，请解锁后重新进入") }
    let receipt = try JSONDecoder().decode(BottleStorageReceipt.self, from: data)
    guard receipt.employeeID == employeeID else { throw StaffAPIError.invalid }; return receipt
  }
}
