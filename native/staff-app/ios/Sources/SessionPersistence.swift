import Foundation
import Security

protocol StaffSessionStore {
  func read() throws -> Data?
  func write(_ data: Data) throws
  func remove() throws
}
struct SavedStaffSession: Codable {
  struct Cookie: Codable {
    let name, value: String
    let expiresAt: Date
  }
  let version: Int
  let identity: StaffIdentity
  let device: DeviceGrant?
  let cookies: [Cookie]
  func validate(now: Date = Date()) throws {
    try identity.validate()
    guard version == 1, let until = StaffIdentity.date(identity.session.expiresAt), until > now,
      cookies.count <= 2, Set(cookies.map(\.name)).count == cookies.count,
      cookies.allSatisfy({
        ["__Host-mbox_staff_session", "__Host-mbox_device_lease"].contains($0.name)
          && !$0.value.isEmpty && $0.value.utf8.count <= 8192 && !$0.value.contains("\n")
          && !$0.value.contains("\r")
      }),
      cookies.contains(where: {
        $0.name == "__Host-mbox_staff_session" && $0.expiresAt > now && $0.expiresAt <= until
      })
    else { throw CatalogError("原登录已过期或安全记录无效，请重新登录") }
  }
}
final class KeychainStaffSessionStore: StaffSessionStore {
  private var installationReady = false
  private let service: String
  private var installationMarker: String {
    service == "com.mbox.staff.saved-login.v1"
      ? "mbox.secure-login-install.v1" : service + ".install.v1"
  }
  private var base: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "current", kSecAttrSynchronizable as String: false,
    ]
  }
  init(service: String = "com.mbox.staff.saved-login.v1") {
    self.service = service
    // Keychain can outlive an app installation. A reinstall must start logged out.
    let marker = installationMarker
    if UserDefaults.standard.bool(forKey: marker) {
      installationReady = true
    } else {
      do {
        try remove()
        UserDefaults.standard.set(true, forKey: marker)
        installationReady = true
      } catch {}
    }
  }
  func read() throws -> Data? {
    if !installationReady {
      try remove()
      UserDefaults.standard.set(true, forKey: installationMarker)
      installationReady = true
      return nil
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(
      base.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) {
        _, new in new
      } as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw keychainError("读取", status: status)
    }
    return data
  }
  func write(_ data: Data) throws {
    if !installationReady {
      try remove()
      UserDefaults.standard.set(true, forKey: installationMarker)
      installationReady = true
    }
    let values: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    var status = SecItemUpdate(base as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(base.merging(values) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw keychainError("保存", status: status) }
  }
  private func keychainError(_ operation: String, status: OSStatus) -> CatalogError {
    if status == errSecMissingEntitlement {
      return CatalogError("当前构建缺少钥匙串签名授权，请安装已签名版本（\(status)）")
    }
    return CatalogError("安全登录记录暂不能\(operation)，请解锁设备后重试（\(status)）")
  }
  func remove() throws {
    let status = SecItemDelete(base as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw keychainError("清除", status: status)
    }
  }
}
