import Foundation
import Security

/// Immutable, device-only payloads; ordinary business checkpoints contain only
/// random original keys and actor references, never PIN/contact/credential data.
enum NativeManagementSecrets {
  private static let service = "com.mbox.staff.native-management.v1"
  private static func query(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
  }
  static func store(_ key: String, _ value: String) throws {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    let result = SecItemAdd(query(key).merging([
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]) { _, new in new } as CFDictionary, nil)
    if result == errSecDuplicateItem {
      guard try read(key) == value else { throw CatalogError("原管理请求载荷不同，未发送") }
    } else if result != errSecSuccess { throw CatalogError("原管理请求未能安全保存，请解锁设备后重试") }
  }
  static func read(_ key: String) throws -> String {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(key).merging([
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]) { _, new in new } as CFDictionary, &result)
    guard status == errSecSuccess, let bytes = result as? Data,
      let value = String(data: bytes, encoding: .utf8) else { throw CatalogError("原管理安全载荷暂不可读，请解锁后核对原请求") }
    return value
  }
  static func remove(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}
