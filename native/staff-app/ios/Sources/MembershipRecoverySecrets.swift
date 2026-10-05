import Foundation
import Security

/// Historical membership contact and decision payloads stay in device-only Keychain; the durable business
/// checkpoint contains only the original command references and this key.
enum MembershipRecoverySecrets {
  private static let service = "com.mbox.staff.membership-recovery"
  static func store(_ key: String, _ value: String) throws {
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key]
    let result = SecItemAdd(base.merging([
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]) { _, new in new } as CFDictionary, nil)
    if result == errSecDuplicateItem {
      guard try read(key) == value else { throw CatalogError("原会员找回载荷不一致，未发送") }
    } else if result != errSecSuccess {
      throw CatalogError("会员找回请求无法安全保存，未发送")
    }
  }
  static func read(_ key: String) throws -> String {
    var result: CFTypeRef?
    let status = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne] as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
      throw CatalogError("原会员找回安全凭据暂不可读，请解锁后恢复原请求")
    }
    return text
  }
  static func remove(_ key: String) {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: key] as CFDictionary)
  }
}
