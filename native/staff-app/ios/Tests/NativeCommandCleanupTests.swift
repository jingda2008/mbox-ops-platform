import Foundation

private final class Vault {
  var tickets: [String: Data] = [:]
  var slots: Set<NativeCommandCleanupSlot> = []
  var events: [String] = []
  var fault = ""
  var savedOnce = false
  var persistence: NativeCommandCleanupPersistence {
    .init(readTicket: { key in
      if self.fault == "read-ticket" { throw NativeCommandCleanupError("injected read") }
      return self.tickets[key]
    }, storeTicket: { key, data in
      self.events.append("store-ticket")
      if self.fault == "store-ticket" { throw NativeCommandCleanupError("injected write") }
      if let old = self.tickets[key], old != data { throw NativeCommandCleanupError("immutable") }
      self.tickets[key] = data
      if self.fault == "stored-then-error" { throw NativeCommandCleanupError("injected lost acknowledgement") }
    }, listTickets: {
      if self.fault == "list" { throw NativeCommandCleanupError("injected list") }
      return self.tickets
    }, removeTicket: { key in
      self.events.append("remove-ticket")
      if self.fault == "remove-ticket" { throw NativeCommandCleanupError("injected removal") }
      if self.fault != "ticket-still-present" { self.tickets.removeValue(forKey: key) }
    }, removeSlot: { slot in
      self.events.append("remove-slot:" + slot.module.rawValue)
      if self.fault == "remove-slot" { throw NativeCommandCleanupError("injected removal") }
      if self.fault != "slot-still-present" { self.slots.remove(slot) }
      if self.fault == "slot-removed-then-error" { throw NativeCommandCleanupError("injected crash after deletion") }
    }, slotExists: { slot in
      if self.fault == "read-slot" { throw NativeCommandCleanupError("injected verification") }
      return self.slots.contains(slot)
    })
  }
}
@main struct NativeCommandCleanupTests {
  static var count = 0
  static func check(_ value: @autoclosure () throws -> Bool, _ message: String) rethrows {
    count += 1; if try !value() { fatalError(message) }
  }
  static func rejects(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
  static func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
  static let actor = "11111111-1111-4111-8111-111111111111"
  static let modules: [(String, NativeCommandCleanupModule)] = [
    ("nativeManagement", .managementPayload), ("ownerFinance", .ownerFinance),
    ("membershipRecovery", .membershipRecovery), ("bottleStorage", .bottleStorage),
    ("show", .show), ("experiencePlan", .experiencePlan), ("remakeHandover", .remakeHandover),
    ("online", .paymentCode), ("voucher", .voucherCode),
  ]
  static func command(_ name: String, _ module: NativeCommandCleanupModule, unsecured: Bool = false) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased()
    var proof: [String: Any] = [:]; var path = "/api/staff/test"
    if name == "online" { proof = ["online": "init", "authCodeKey": id]; path = "/api/payments" }
    else if name == "voucher" { proof = ["voucher": "redeem", "voucherSecretKey": "voucher-" + id]; path = "/api/commercial-ops/vouchers/operations/redeem" }
    else { proof[name] = unsecured ? ["confirmation": "私人电话13800138000", "employeeId": actor] : ["payloadKey": module.key(commandID: id), "employeeId": actor] }
    return LiveCommand(id: id, employeeID: actor, title: "独立原请求", permission: "test",
      steps: [.init(path: path, body: try bytes(unsecured ? ["phone": "13800138000", "pin": "1234"] : [:]), keyHeader: "idempotency-key", key: "original-" + id, recoveryBody: try bytes(proof))])
  }
  static func main() throws {
    for (name, module) in modules {
      let original = try command(name, module), slots = try nativeCommandCleanupSlots(original)
      let other = try command(name, module), otherSlots = try nativeCommandCleanupSlots(other)
      check(slots.contains(.init(module: module, key: module.key(commandID: original.id))), "exact derived module slot")
      check(slots.count == (name == "nativeManagement" ? 2 : 1), "exact family slot count")
      for disposition in [NativeCommandCleanupDisposition.acknowledged, .rejected, .neverSent] {
        let vault = Vault(); vault.slots = Set(disposition == .neverSent ? otherSlots : slots + otherSlots)
        var pending: LiveCommand? = original; var ordinaryRemovals = 0; var validations = 0
        try recordNativeCommandCleanup(original, disposition: disposition, verifyTerminal: { validations += 1 }, persistence: vault.persistence)
        check(validations == 1 && vault.tickets.count == 1, "ticket written only after explicit terminal validation")
        vault.slots.formUnion(slots)
        var checkpoint = original; checkpoint.completedSteps = 1; checkpoint.rejected = true
        try check(nativeCommandCleanupBinding(checkpoint) == nativeCommandCleanupBinding(original), "ordinary status flags do not alter original binding")
        let text = String(decoding: vault.tickets[original.id]!, as: UTF8.self)
        check(!text.contains(actor) && !text.contains("13800138000") && !text.contains("1234") && !text.contains(original.title), "ticket excludes identity contact PIN and title")
        let done = try finishNativeCommandCleanup(checkpoint, persistence: vault.persistence) { ticket in
          check(ticket.commandID == original.id && slots.allSatisfy { !vault.slots.contains($0) }, "ordinary deletion follows confirmed sensitive deletion")
          ordinaryRemovals += 1; pending = nil; vault.events.append("remove-pending")
        }
        check(done && pending == nil && ordinaryRemovals == 1 && vault.tickets.isEmpty, "verified terminal completes local cleanup")
        check(otherSlots.allSatisfy { vault.slots.contains($0) }, "unrelated original slots preserved")
        check(vault.events.first == "store-ticket" && vault.events.last == "remove-ticket", "durable ticket surrounds all deletion")
      }
      do {
        let vault = Vault(); var forged = original; forged.completedSteps = 1; forged.rejected = true
        try check(!finishNativeCommandCleanup(forged, persistence: vault.persistence) { _ in fatalError("forged pending erased") }, "ordinary completed/rejected never grants cleanup")
        check(vault.events.isEmpty, "forged flags have no deletion side effect")
        check(rejects { try recordNativeCommandCleanup(forged, disposition: .acknowledged, verifyTerminal: { throw NativeCommandCleanupError("wrong reply") }, persistence: vault.persistence) }, "wrong receipt cannot authorize ticket")
        check(vault.tickets.isEmpty, "failed validator writes no authorization")
      }
      for fault in ["remove-slot", "slot-still-present", "slot-removed-then-error", "read-slot", "remove-pending", "remove-ticket", "ticket-still-present"] {
        let vault = Vault(); vault.slots = Set(slots + otherSlots); var pending: LiveCommand? = original
        try recordNativeCommandCleanup(original, disposition: .acknowledged, verifyTerminal: {}, persistence: vault.persistence)
        vault.fault = fault
        check(rejects { try finishNativeCommandCleanup(original, persistence: vault.persistence) { _ in
          if fault == "remove-pending" { throw NativeCommandCleanupError("ordinary failed") }; pending = nil
        } }, "\(name): \(fault) is not false success")
        check(vault.tickets[original.id] != nil, "\(name): \(fault) retains independent recovery ticket")
        check(otherSlots.allSatisfy { vault.slots.contains($0) }, "\(name): failed cleanup leaves other command intact")
        vault.fault = ""
        let recovered = try resumeNativeCommandCleanups(pending: pending, persistence: vault.persistence) { _ in pending = nil }
        check(recovered == [original.id] && pending == nil && vault.tickets.isEmpty && slots.allSatisfy { !vault.slots.contains($0) }, "\(name): \(fault) startup recovery finishes without payload or network")
      }
      for fault in ["store-ticket", "stored-then-error", "read-ticket"] {
        let vault = Vault(); vault.slots = Set(slots); vault.fault = fault
        check(rejects { try recordNativeCommandCleanup(original, disposition: .acknowledged, verifyTerminal: {}, persistence: vault.persistence) }, "ticket failure surfaced")
        check(vault.slots == Set(slots) && !vault.events.contains(where: { $0.hasPrefix("remove") }), "ticket failure does not erase original")
        if fault == "stored-then-error" {
          vault.fault = ""; var ordinary = true
          try resumeNativeCommandCleanups(pending: original, persistence: vault.persistence) { _ in ordinary = false }
          check(!ordinary && vault.slots.isEmpty && vault.tickets.isEmpty, "ticket persisted before acknowledgement loss restores locally")
        }
      }
      do {
        let vault = Vault(); vault.slots = Set(slots + otherSlots)
        try recordNativeCommandCleanup(original, disposition: .acknowledged, verifyTerminal: {}, persistence: vault.persistence)
        var changed = original; changed = LiveCommand(id: original.id, employeeID: UUID().uuidString, title: original.title, permission: original.permission, steps: original.steps)
        check(rejects { try finishNativeCommandCleanup(changed, persistence: vault.persistence) { _ in fatalError("different command erased") } }, "same ID different employee rejects before deletion")
        check(vault.slots == Set(slots + otherSlots), "mismatched binding preserves all original slots")
        let finished = try resumeNativeCommandCleanups(pending: other, persistence: vault.persistence) { _ in fatalError("unrelated pending erased") }
        check(finished == [original.id] && Set(otherSlots).isSubset(of: vault.slots), "orphan ticket cleans only own ID and never other pending")
      }
      if !["online", "voucher"].contains(name) {
        let vault = Vault(), initial = try command(name, module, unsecured: true)
        check(rejects { _ = try nativeCommandCleanupSlots(initial) }, "unsecured original cannot masquerade as verified ACK cleanup")
        let ticket = try recordNativeCommandCleanup(initial, disposition: .neverSent, verifyTerminal: {}, persistence: vault.persistence)!
        vault.slots = Set(ticket.slots)
        try resumeNativeCommandCleanups(pending: nil, persistence: vault.persistence) { _ in fatalError("never-sent has no pending file") }
        check(vault.slots.isEmpty && vault.tickets.isEmpty, "never-sent secure-store-before-file failure can clean without HTTP")
      }
    }
    for (name, module) in modules {
      let raw = try command(name, module, unsecured: true)
      let originalStep = raw.steps[0]
      var proof = try JSONSerialization.jsonObject(with: originalStep.recoveryBody!) as! [String: Any]
      if !["online", "voucher"].contains(name) {
        var item = proof[name] as! [String: Any]; item.removeValue(forKey: "confirmation"); item["payloadKey"] = module.key(commandID: raw.id); item["payloadAuthentication"] = "secured"; proof[name] = item
      }
      let secured = LiveCommand(id: raw.id, employeeID: raw.employeeID, title: "待核对安全请求", permission: raw.permission,
        steps: [.init(path: originalStep.path, body: try bytes([:]), keyHeader: originalStep.keyHeader, key: originalStep.key, recoveryBody: try bytes(proof))])
      try check(nativeCommandInitializationBinding(raw) == nativeCommandInitializationBinding(secured), "\(name) initialization binding survives secure payload redaction")
      let fresh = Vault()
      check(rejects { try discardNativeCommandInitialization(secured, persistence: fresh.persistence) }, "no ticket cannot authorize first send")
      let slot = try nativeCommandCleanupSlots(secured).first!; fresh.slots.insert(slot)
      check(rejects { try recordNativeCommandCleanup(raw, disposition: .neverSent, verifyTerminal: {}, persistence: fresh.persistence) }, "new initialization cannot capture existing same-UUID private payload")
      check(fresh.tickets.isEmpty && fresh.slots.contains(slot), "preexisting slot is preserved without cleanup authorization")
      fresh.slots = []
      try recordNativeCommandCleanup(raw, disposition: .neverSent, verifyTerminal: {}, persistence: fresh.persistence)
      fresh.slots.insert(slot)
      try recordNativeCommandCleanup(raw, disposition: .neverSent, verifyTerminal: {}, persistence: fresh.persistence)
      check(fresh.tickets.count == 1, "same original initialization ticket remains immutable after partial secure store")
      for fault in ["remove-ticket", "ticket-still-present", "read-ticket"] {
        fresh.fault = fault
        check(rejects { try discardNativeCommandInitialization(secured, persistence: fresh.persistence) }, "\(name) initialization consume \(fault) blocks first HTTP")
        check(fresh.slots.contains(slot), "failed consume does not prematurely erase original payload")
      }
      fresh.fault = ""
      try check(discardNativeCommandInitialization(secured, persistence: fresh.persistence), "\(name) first-send gate consumes only exact saved initialization")
      check(fresh.tickets.isEmpty && fresh.slots.contains(slot), "successful initialization consume preserves payload for original business request")
      check(rejects { try discardNativeCommandInitialization(secured, persistence: fresh.persistence) }, "initialization permit cannot be reused")
      try recordNativeCommandCleanup(secured, disposition: .acknowledged, verifyTerminal: {}, persistence: fresh.persistence)
      check(rejects { try discardNativeCommandInitialization(secured, persistence: fresh.persistence) }, "ACK cleanup ticket cannot be consumed as first-send authorization")
    }
    let initial = try command("ownerFinance", .ownerFinance), vault = Vault()
    try recordNativeCommandCleanup(initial, disposition: .acknowledged, verifyTerminal: {}, persistence: vault.persistence)
    let originalTicket = vault.tickets[initial.id]!
    for field in ["unknown-field", "slot-extra", "slot-module", "slot-key", "commandID", "hash", "disposition", "protocol", "duplicate", "other-family", "management-alone"] {
      var json = try JSONSerialization.jsonObject(with: originalTicket) as! [String: Any]
      var slots = json["slots"] as! [[String: Any]]
      switch field {
      case "unknown-field": json["phone"] = "13800138000"
      case "slot-extra": slots[0]["service"] = "arbitrary"
      case "slot-module": slots[0]["module"] = "session"
      case "slot-key": slots[0]["key"] = "owner-finance-" + UUID().uuidString
      case "commandID": json["commandID"] = UUID().uuidString
      case "hash": json["bindingSHA256"] = "not-a-hash"
      case "disposition": json["disposition"] = "ordinaryCompleted"
      case "protocol": json["protocolVersion"] = 2
      case "duplicate": slots.append(slots[0])
      case "other-family": slots.append(["module": "membershipRecovery", "key": "membership-recovery-" + initial.id])
      default: slots = [["module": "managementPayload", "key": initial.id]]
      }
      json["slots"] = slots
      check(rejects { _ = try decodeNativeCommandCleanupTicket(bytes(json), key: initial.id) }, "ticket rejects \(field) without deletion")
    }
    vault.fault = "list"
    check(rejects { try resumeNativeCommandCleanups(pending: nil, persistence: vault.persistence) { _ in fatalError() } }, "enumeration failure cannot be assumed empty")
    let expectedServices: [NativeCommandCleanupModule: String] = [.ownerFinance: "com.mbox.staff.owner-finance", .membershipRecovery: "com.mbox.staff.membership-recovery", .bottleStorage: "com.mbox.staff.bottle-storage", .show: "com.mbox.staff.live-show", .experiencePlan: "com.mbox.staff.live-experience-plan", .remakeHandover: "com.mbox.staff.live-remake-handover", .managementPayload: "com.mbox.staff.native-management.v1", .managementReceipt: "com.mbox.staff.native-management.receipts.v1", .paymentCode: "com.mbox.staff.payment-code", .voucherCode: "com.mbox.staff.payment-code"]
    for module in NativeCommandCleanupModule.allCases { check(module.service == expectedServices[module], "adapter service matches actual module") }
    print("Native command cleanup: \(count) checks passed; nine command families; no live Keychain or network operations")
  }
}
