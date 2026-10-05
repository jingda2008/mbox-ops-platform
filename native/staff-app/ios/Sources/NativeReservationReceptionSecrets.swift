import Foundation
import Security

private enum ReceptionKeychain {
  enum Slot: String { case payloads, receipts, cleanup }
  static func query(_ key: String?, slot: Slot) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.mbox.staff.reservation-reception.\(slot.rawValue).v1",
      kSecAttrSynchronizable as String: false]
    if let key { query[kSecAttrAccount as String] = key }
    return query
  }
  static func read(_ key: String, slot: Slot) throws -> String? {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(key, slot: slot).merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data, let text = String(data: bytes, encoding: .utf8) else { throw CatalogError("原预约安全记录暂不可读，请解锁设备后恢复") }
    return text
  }
  static func store(_ key: String, value: String, slot: Slot) throws {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    let status = SecItemAdd(query(key, slot: slot).merging([kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard try read(key, slot: slot) == value else { throw CatalogError("原预约安全记录已存在且内容不同，未覆盖或发送") }
    } else if status != errSecSuccess { throw CatalogError(slot == .payloads ? "原预约载荷未能安全保存，尚未发送" : "服务器结果尚未完成安全保存，请保留原请求恢复") }
  }
  static func remove(_ key: String, slot: Slot) throws {
    guard UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }
    let status = SecItemDelete(query(key, slot: slot) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw CatalogError("已确认原预约结果，但本机安全记录尚未清理完毕，请解锁设备后继续核对；不会另建请求") }
  }
  static func cleanupKeys() throws -> [String] {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query(nil, slot: .cleanup).merging([kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw CatalogError("预约安全清理记录暂不可读，请解锁设备后重试") }
    let keys = try rows.map { row -> String in
      guard let key = row[kSecAttrAccount as String] as? String, UUID(uuidString: key) != nil else { throw StaffAPIError.invalid }; return key
    }
    guard Set(keys).count == keys.count else { throw StaffAPIError.invalid }; return keys.sorted()
  }
}
struct ReservationReceptionPersistence {
  var payloadExists: (String) throws -> Bool
  var readPayload: (String) throws -> String
  var storePayload: (String, String) throws -> Void
  var removePayload: (String) throws -> Void
  var readReceipt: (String) throws -> String?
  var storeReceipt: (String, String) throws -> Void
  var removeReceipt: (String) throws -> Void
  var readCleanupTicket: (String) throws -> String?
  var storeCleanupTicket: (String, String) throws -> Void
  var removeCleanupTicket: (String) throws -> Void
  var listCleanupTicketKeys: () throws -> [String]
  static var device: ReservationReceptionPersistence {
    .init(payloadExists: { try ReceptionKeychain.read($0, slot: .payloads) != nil }, readPayload: { key in guard let value = try ReceptionKeychain.read(key, slot: .payloads) else { throw CatalogError("原预约安全载荷缺失，不能重新生成请求；请核对原编号") }; return value },
      storePayload: { try ReceptionKeychain.store($0, value: $1, slot: .payloads) }, removePayload: { try ReceptionKeychain.remove($0, slot: .payloads) },
      readReceipt: { try ReceptionKeychain.read($0, slot: .receipts) }, storeReceipt: { try ReceptionKeychain.store($0, value: $1, slot: .receipts) }, removeReceipt: { try ReceptionKeychain.remove($0, slot: .receipts) },
      readCleanupTicket: { try ReceptionKeychain.read($0, slot: .cleanup) }, storeCleanupTicket: { try ReceptionKeychain.store($0, value: $1, slot: .cleanup) }, removeCleanupTicket: { try ReceptionKeychain.remove($0, slot: .cleanup) }, listCleanupTicketKeys: { try ReceptionKeychain.cleanupKeys() })
  }
}
