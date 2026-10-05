import Foundation
import Security

private enum NativeCommandCleanupKeychain {
  static let service = "com.mbox.staff.command-cleanup.v1"
  static func query(service: String, key: String? = nil) -> [String: Any] {
    var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrSynchronizable as String: false]
    if let key { value[kSecAttrAccount as String] = key }
    return value
  }
  static func validate(_ slot: NativeCommandCleanupSlot) throws {
    let prefixes: [NativeCommandCleanupModule: String] = [.managementPayload: "", .managementReceipt: "", .ownerFinance: "owner-finance-", .membershipRecovery: "membership-recovery-", .bottleStorage: "bottle-storage-", .show: "live-show-", .experiencePlan: "live-experience-", .remakeHandover: "live-remake-handover-", .paymentCode: "", .voucherCode: "voucher-"]
    let prefix = prefixes[slot.module]!
    guard slot.key.hasPrefix(prefix), UUID(uuidString: String(slot.key.dropFirst(prefix.count))) != nil,
      slot.key.utf8.count == prefix.utf8.count + 36 else { throw NativeCommandCleanupError() }
  }
  static func read(service: String, key: String) throws -> Data? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(service: service, key: key).merging([
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data else { throw failure(status) }
    return bytes
  }
  static func failure(_ status: OSStatus) -> NativeCommandCleanupError {
    NativeCommandCleanupError("本机安全记录暂不能清理，请解锁后继续原记录清理（\(status)）；不会重新发送业务")
  }
  static func remove(service: String, key: String) throws {
    let status = SecItemDelete(query(service: service, key: key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    guard try read(service: service, key: key) == nil else { throw NativeCommandCleanupError("安全记录删除尚未确认，请保留清理回执") }
  }
  static func store(_ key: String, _ data: Data) throws {
    _ = try decodeNativeCommandCleanupTicket(data, key: key)
    let status = SecItemAdd(query(service: service, key: key).merging([
      kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard try read(service: service, key: key) == data else { throw NativeCommandCleanupError("原清理回执已存在且不同，未覆盖") }
    } else if status != errSecSuccess { throw failure(status) }
    guard try read(service: service, key: key) == data else { throw NativeCommandCleanupError("清理回执尚未安全保存") }
  }
  static func list() throws -> [String: Data] {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(service: service).merging([
      kSecReturnAttributes as String: true, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return [:] }
    guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw failure(status) }
    var values: [String: Data] = [:]
    for row in rows {
      guard let key = row[kSecAttrAccount as String] as? String, let data = row[kSecValueData as String] as? Data,
        values[key] == nil, row[kSecAttrService as String] as? String == service else { throw NativeCommandCleanupError() }
      _ = try decodeNativeCommandCleanupTicket(data, key: key); values[key] = data
    }
    return values
  }
}
extension NativeCommandCleanupPersistence {
  static var device: NativeCommandCleanupPersistence {
    .init(readTicket: { try NativeCommandCleanupKeychain.read(service: NativeCommandCleanupKeychain.service, key: $0) },
      storeTicket: NativeCommandCleanupKeychain.store, listTickets: NativeCommandCleanupKeychain.list,
      removeTicket: { try NativeCommandCleanupKeychain.remove(service: NativeCommandCleanupKeychain.service, key: $0) },
      removeSlot: { try NativeCommandCleanupKeychain.validate($0); try NativeCommandCleanupKeychain.remove(service: $0.module.service, key: $0.key) },
      slotExists: { try NativeCommandCleanupKeychain.validate($0); return try NativeCommandCleanupKeychain.read(service: $0.module.service, key: $0.key) != nil })
  }
}
