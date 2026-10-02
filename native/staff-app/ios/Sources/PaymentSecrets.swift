import Foundation
import Security

enum PaymentSecrets {
  static let service = "com.mbox.staff.payment-code"
  static func store(_ key: String, _ value: String) throws {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    let data = Data(value.utf8)
    let status = SecItemAdd(
      base.merging([
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      ]) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      // Never silently change the code of a durable request.
      guard try read(key) == value else { throw CatalogError("原付款码与原请求不一致，未发送") }
    } else if status != errSecSuccess {
      throw CatalogError("付款码无法安全保存，未发送扣款请求")
    }
  }
  static func read(_ key: String) throws -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: key, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var value: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
      let data = value as? Data, let result = String(data: data, encoding: .utf8)
    else { throw CatalogError("原付款安全凭据暂不可读，请解锁设备后核对原请求；不要重新收款") }
    return result
  }
  static func remove(_ key: String) {
    SecItemDelete(
      [
        kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
        kSecAttrAccount as String: key,
      ] as CFDictionary)
  }
}
