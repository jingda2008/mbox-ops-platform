import Foundation
import CryptoKit

/// A ticket is trusted only after loading it from the independent device Keychain.
/// Ordinary completedSteps/rejected flags never grant permission to erase secrets.
enum NativeCommandCleanupDisposition: String, Codable { case acknowledged, rejected, neverSent }
enum NativeCommandCleanupModule: String, Codable, CaseIterable {
  case managementPayload, managementReceipt, ownerFinance, membershipRecovery
  case bottleStorage, show, experiencePlan, remakeHandover, paymentCode, voucherCode
  var service: String {
    switch self {
    case .managementPayload: return "com.mbox.staff.native-management.v1"
    case .managementReceipt: return "com.mbox.staff.native-management.receipts.v1"
    case .ownerFinance: return "com.mbox.staff.owner-finance"
    case .membershipRecovery: return "com.mbox.staff.membership-recovery"
    case .bottleStorage: return "com.mbox.staff.bottle-storage"
    case .show: return "com.mbox.staff.live-show"
    case .experiencePlan: return "com.mbox.staff.live-experience-plan"
    case .remakeHandover: return "com.mbox.staff.live-remake-handover"
    case .paymentCode, .voucherCode: return "com.mbox.staff.payment-code"
    }
  }
  func key(commandID: String) -> String {
    switch self {
    case .managementPayload, .managementReceipt, .paymentCode: return commandID
    case .ownerFinance: return "owner-finance-" + commandID
    case .membershipRecovery: return "membership-recovery-" + commandID
    case .bottleStorage: return "bottle-storage-" + commandID
    case .show: return "live-show-" + commandID
    case .experiencePlan: return "live-experience-" + commandID
    case .remakeHandover: return "live-remake-handover-" + commandID
    case .voucherCode: return "voucher-" + commandID
    }
  }
}
struct NativeCommandCleanupSlot: Codable, Equatable, Hashable {
  let module: NativeCommandCleanupModule
  let key: String
}
struct NativeCommandCleanupTicket: Codable, Equatable {
  let protocolVersion: Int
  let commandID: String
  let bindingSHA256: String
  let disposition: NativeCommandCleanupDisposition
  let slots: [NativeCommandCleanupSlot]
}
struct NativeCommandCleanupPersistence {
  var readTicket: (String) throws -> Data?
  var storeTicket: (String, Data) throws -> Void
  var listTickets: () throws -> [String: Data]
  var removeTicket: (String) throws -> Void
  var removeSlot: (NativeCommandCleanupSlot) throws -> Void
  var slotExists: (NativeCommandCleanupSlot) throws -> Bool
}
struct NativeCommandCleanupError: LocalizedError {
  let message: String
  init(_ message: String = "原请求清理记录不完整，请保留记录并核对；不会重新发送业务") { self.message = message }
  var errorDescription: String? { message }
}
private func cleanupJSON(_ data: Data) throws -> [String: Any] {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeCommandCleanupError() }
  return object
}
private func cleanupValidID(_ value: String) -> Bool { UUID(uuidString: value) != nil && value.utf8.count == 36 }
func nativeCommandCleanupBinding(_ command: LiveCommand) throws -> String {
  guard cleanupValidID(command.id), cleanupValidID(command.employeeID), command.steps.count == 1 else { throw NativeCommandCleanupError() }
  var stable = command; stable.completedSteps = 0; stable.rejected = false
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  return SHA256.hash(data: try encoder.encode(stable)).map { String(format: "%02x", $0) }.joined()
}
/// Initialization authorization is recorded before storing any private payload.
/// Securing changes body/title/recovery metadata, but must not change these originals.
func nativeCommandInitializationBinding(_ command: LiveCommand) throws -> String {
  _ = try nativeCommandCleanupBinding(command)
  let slots = try nativeCommandCleanupSlots(command, allowUnsecured: true)
  guard !slots.isEmpty else { throw NativeCommandCleanupError() }
  let object: [String: Any] = ["commandID": command.id, "employeeID": command.employeeID,
    "permission": command.permission, "steps": command.steps.map { ["path": $0.path, "keyHeader": $0.keyHeader, "key": $0.key] },
    "slots": slots.map { ["module": $0.module.rawValue, "key": $0.key] }]
  return SHA256.hash(data: try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)).map { String(format: "%02x", $0) }.joined()
}
private func cleanupBinding(_ command: LiveCommand, _ disposition: NativeCommandCleanupDisposition) throws -> String {
  try disposition == .neverSent ? nativeCommandInitializationBinding(command) : nativeCommandCleanupBinding(command)
}
/// Only references mechanically derived from this command's original UUID are allowed.
/// RES reception has its own independent ticket service and is deliberately excluded.
func nativeCommandCleanupSlots(_ command: LiveCommand, allowUnsecured: Bool = false) throws -> [NativeCommandCleanupSlot] {
  guard let step = command.steps.first, let proofData = step.recoveryBody else { return [] }
  let root = try cleanupJSON(proofData)
  if root["reservationReception"] != nil { return [] }
  let mappings: [(String, NativeCommandCleanupModule)] = [
    ("nativeManagement", .managementPayload), ("ownerFinance", .ownerFinance),
    ("membershipRecovery", .membershipRecovery), ("bottleStorage", .bottleStorage),
    ("show", .show), ("experiencePlan", .experiencePlan), ("remakeHandover", .remakeHandover),
  ]
  var result: [NativeCommandCleanupSlot] = []; var families = 0
  for (name, module) in mappings where root[name] != nil {
    families += 1
    guard let proof = root[name] as? [String: Any] else { throw NativeCommandCleanupError() }
    let expected = module.key(commandID: command.id)
    guard (allowUnsecured && proof["payloadKey"] == nil) || proof["payloadKey"] as? String == expected else { throw NativeCommandCleanupError() }
    result.append(.init(module: module, key: expected))
    if module == .managementPayload { result.append(.init(module: .managementReceipt, key: command.id)) }
  }
  if root["authCodeKey"] != nil {
    families += 1
    guard root["online"] as? String == "init", root["authCodeKey"] as? String == command.id,
      step.path == "/api/payments" else { throw NativeCommandCleanupError() }
    result.append(.init(module: .paymentCode, key: command.id))
  }
  if root["voucherSecretKey"] != nil {
    families += 1
    guard root["voucher"] as? String == "redeem", root["voucherSecretKey"] as? String == "voucher-" + command.id,
      step.path == "/api/commercial-ops/vouchers/operations/redeem" else { throw NativeCommandCleanupError() }
    result.append(.init(module: .voucherCode, key: "voucher-" + command.id))
  }
  guard families <= 1 else { throw NativeCommandCleanupError() }
  if !result.isEmpty { _ = try nativeCommandCleanupBinding(command) }
  return result.sorted { $0.module.rawValue < $1.module.rawValue }
}
private func validateCleanupTicket(_ ticket: NativeCommandCleanupTicket, key: String) throws {
  guard ticket.protocolVersion == 1, cleanupValidID(ticket.commandID), ticket.commandID == key,
    ticket.bindingSHA256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
    !ticket.slots.isEmpty, ticket.slots.count <= 2, Set(ticket.slots).count == ticket.slots.count,
    ticket.slots.allSatisfy({ $0.key == $0.module.key(commandID: ticket.commandID) }) else { throw NativeCommandCleanupError() }
  let modules = Set(ticket.slots.map(\.module))
  guard modules == [.managementPayload, .managementReceipt] || (modules.count == 1 && !modules.contains(.managementPayload) && !modules.contains(.managementReceipt)) else { throw NativeCommandCleanupError() }
}
func decodeNativeCommandCleanupTicket(_ data: Data, key: String) throws -> NativeCommandCleanupTicket {
  let raw = try cleanupJSON(data)
  guard Set(raw.keys) == ["protocolVersion", "commandID", "bindingSHA256", "disposition", "slots"],
    let slots = raw["slots"] as? [[String: Any]], slots.allSatisfy({ Set($0.keys) == ["module", "key"] }) else { throw NativeCommandCleanupError() }
  let ticket = try JSONDecoder().decode(NativeCommandCleanupTicket.self, from: data)
  try validateCleanupTicket(ticket, key: key); return ticket
}
/// Call only at a trusted boundary: immediately after validating the actual response,
/// a definitive server rejection, or before any HTTP was possible during initialization.
/// verifyTerminal must perform that validation; a disk checkpoint is not evidence.
@discardableResult
func recordNativeCommandCleanup(_ command: LiveCommand, disposition: NativeCommandCleanupDisposition,
  verifyTerminal: () throws -> Void, persistence: NativeCommandCleanupPersistence) throws -> NativeCommandCleanupTicket? {
  let slots = try nativeCommandCleanupSlots(command, allowUnsecured: disposition == .neverSent)
  guard !slots.isEmpty else { return nil }
  try verifyTerminal()
  let ticket = NativeCommandCleanupTicket(protocolVersion: 1, commandID: command.id,
    bindingSHA256: try cleanupBinding(command, disposition), disposition: disposition, slots: slots)
  try validateCleanupTicket(ticket, key: command.id)
  if let existing = try persistence.readTicket(command.id) {
    guard try decodeNativeCommandCleanupTicket(existing, key: command.id) == ticket else { throw NativeCommandCleanupError("原请求已有不同清理回执，未覆盖") }
    return ticket
  }
  if disposition == .neverSent {
    for slot in slots where try persistence.slotExists(slot) {
      throw NativeCommandCleanupError("本编号已有安全载荷，不能以新初始化记录授权删除；请保留原请求核对")
    }
  }
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  let data = try encoder.encode(ticket)
  try persistence.storeTicket(command.id, data)
  guard let saved = try persistence.readTicket(command.id), try decodeNativeCommandCleanupTicket(saved, key: command.id) == ticket else { throw NativeCommandCleanupError("清理回执尚未安全保存，保留原请求") }
  return ticket
}
private func cleanNativeCommandTicket(_ ticket: NativeCommandCleanupTicket, pending: LiveCommand?,
  persistence: NativeCommandCleanupPersistence, removePending: (NativeCommandCleanupTicket) throws -> Void) throws {
  try validateCleanupTicket(ticket, key: ticket.commandID)
  let matchesPending = pending?.id == ticket.commandID
  if matchesPending, let pending {
    guard try cleanupBinding(pending, ticket.disposition) == ticket.bindingSHA256,
      try nativeCommandCleanupSlots(pending, allowUnsecured: ticket.disposition == .neverSent) == ticket.slots else { throw NativeCommandCleanupError("当前原请求与安全清理回执不一致，未删除任何记录") }
  }
  for slot in ticket.slots {
    try persistence.removeSlot(slot)
    guard try !persistence.slotExists(slot) else { throw NativeCommandCleanupError("业务结果已确认，但本机私密记录尚未清除；请继续原记录清理") }
  }
  // Retain the independent ticket until both sensitive records and the ordinary
  // checkpoint are gone. Every intermediate crash resumes local cleanup only.
  if matchesPending { try removePending(ticket) }
  try persistence.removeTicket(ticket.commandID)
  guard try persistence.readTicket(ticket.commandID) == nil else { throw NativeCommandCleanupError("私密记录已清除，清理回执仍待本机确认") }
}
/// Returns false when no independent ticket exists, regardless of ordinary flags.
@discardableResult
func finishNativeCommandCleanup(_ command: LiveCommand, persistence: NativeCommandCleanupPersistence,
  removePending: (NativeCommandCleanupTicket) throws -> Void) throws -> Bool {
  guard let data = try persistence.readTicket(command.id) else { return false }
  let ticket = try decodeNativeCommandCleanupTicket(data, key: command.id)
  try cleanNativeCommandTicket(ticket, pending: command, persistence: persistence, removePending: removePending)
  return true
}
/// Startup recovery also handles the crash after the ordinary file was deleted.
/// Tickets for other commands never cause removal of the current pending file.
@discardableResult
func resumeNativeCommandCleanups(pending: LiveCommand?, persistence: NativeCommandCleanupPersistence,
  removePending: (NativeCommandCleanupTicket) throws -> Void) throws -> [String] {
  let records = try persistence.listTickets()
  let tickets = try records.keys.sorted().map { try decodeNativeCommandCleanupTicket(records[$0]!, key: $0) }
  var finished: [String] = []
  for ticket in tickets {
    try cleanNativeCommandTicket(ticket, pending: pending, persistence: persistence, removePending: removePending)
    finished.append(ticket.commandID)
  }
  return finished
}

/// Only after secured ordinary pending is durably saved. Failure blocks entry into
/// the business runner; this function never deletes private slots or sends HTTP.
@discardableResult
func discardNativeCommandInitialization(_ command: LiveCommand, persistence: NativeCommandCleanupPersistence) throws -> Bool {
  let slots = try nativeCommandCleanupSlots(command)
  guard !slots.isEmpty else { return false }
  guard let data = try persistence.readTicket(command.id) else { throw NativeCommandCleanupError("缺少初始化安全记录，原请求尚未允许发送") }
  let ticket = try decodeNativeCommandCleanupTicket(data, key: command.id)
  guard ticket.disposition == .neverSent, ticket.bindingSHA256 == (try nativeCommandInitializationBinding(command)), ticket.slots == slots else {
    throw NativeCommandCleanupError("初始化记录与原请求不一致，尚未发送")
  }
  try persistence.removeTicket(command.id)
  guard try persistence.readTicket(command.id) == nil else { throw NativeCommandCleanupError("初始化记录尚未确认移除，尚未发送") }
  return true
}
