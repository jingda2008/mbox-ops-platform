import Foundation

@main struct NativeManagementAcknowledgementTests {
  static func main() throws {
    var count = 0
    func check(_ value: Bool, _ name: String) { precondition(value, name); count += 1; print("PASS " + name) }
    func bytes(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: .sortedKeys) }
    func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    let employee = "00000000-0000-4000-8000-000000000001"
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(["employee": ["id": employee, "code": "printer", "displayName": "设备管理员", "roleCodes": []],
      "session": ["id": "session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["printer.manage"], "deniedPermissions": []]))
    let board = try NativeManagementBoard(module: .devices, data: bytes(["data": ["employeeId": employee, "nativeCommands": true,
      "devices": [], "routes": [], "commands": [], "policies": [["ticketKind": "cashier_payment", "enabled": true, "copies": NSNull(), "configurationFingerprint": String(repeating: "a", count: 64)]]]]), bridges: bytes(["data": []]), actor: actor)
    let original = try board.command(actor: actor, operation: "policy-save", fields: ["enabled": "false", "copies": "", "reason": "核对门店票据策略"], rowID: "cashier_payment")
    var vault: [String: String] = [:], receipts: [String: String] = [:]
    let secured = try secureNativeManagementCommand(original) { vault[$0] = $1 }
    let reply: [String: Any] = ["data": ["kind": "policy-save", "employeeId": employee, "reason": "核对门店票据策略",
      "row": ["ticketKind": "cashier_payment", "enabled": false, "copies": NSNull()]], "meta": ["replayed": false]]
    func acknowledged(_ command: LiveCommand = secured) throws -> Bool {
      try hasNativeManagementAcknowledgement(command, readPayload: { vault[$0]! }, readReceipt: { receipts[$0] })
    }
    func record(_ data: Data, store: ((String, String) throws -> Void)? = nil) throws {
      try recordNativeManagementAcknowledgement(data, command: secured, step: secured.steps[0], actor: actor,
        readPayload: { vault[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: store ?? { receipts[$0] = $1 })
    }
    check(try !acknowledged(), "pending request without secure ACK is never locally completed")
    var edited = secured; edited.completedSteps = 1
    check(try !acknowledged(edited), "ordinary completed-step tamper cannot authorize cleanup")
    check(rejects { try record(bytes(reply), store: { _, _ in throw URLError(.cannotWriteToFile) }) } && receipts.isEmpty,
      "ACK storage failure leaves original request unresolved")
    var invalid = reply, data = invalid["data"] as! [String: Any]
    data["employeeId"] = "other"; invalid["data"] = data
    check(rejects { try record(bytes(invalid)) } && receipts.isEmpty, "wrong employee server reply cannot become completion proof")
    invalid = reply; data = invalid["data"] as! [String: Any]
    data["row"] = ["ticketKind": "cashier_payment", "enabled": false, "copies": 1]; invalid["data"] = data
    check(rejects { try record(bytes(invalid)) } && receipts.isEmpty, "wrong policy null inheritance cannot become completion proof")
    try record(bytes(reply))
    check(try acknowledged() && acknowledged(edited), "real secure ACK authorizes original local cleanup across checkpoint crash")
    let stored = receipts
    var replay = reply; replay["meta"] = ["replayed": true]
    try record(bytes(replay), store: { _, _ in preconditionFailure("replaced first receipt") })
    check(receipts == stored, "server replay after local checkpoint failure preserves first secure ACK")
    let copy = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(secured))
    check(try acknowledged(copy), "app restart preserves exact ACK binding")
    let newOriginal = try board.command(actor: actor, operation: "policy-save", fields: ["enabled": "false", "copies": "", "reason": "核对门店票据策略"], rowID: "cashier_payment")
    let second = try secureNativeManagementCommand(newOriginal) { vault[$0] = $1 }
    receipts[second.id] = receipts[secured.id]
    check(rejects { _ = try acknowledged(second) }, "same business payload under a new key cannot borrow original ACK")
    let changed = LiveCommand(id: secured.id, employeeID: secured.employeeID, title: secured.title,
      permission: "hardware.manage", steps: secured.steps)
    check(rejects { _ = try acknowledged(changed) }, "changed command permission cannot borrow original ACK")
    var broken = try JSONSerialization.jsonObject(with: Data(receipts[secured.id]!.utf8)) as! [String: Any]
    broken["reply"] = try bytes(invalid).base64EncodedString(); receipts[secured.id] = String(data: try bytes(broken), encoding: .utf8)!
    check(rejects { _ = try acknowledged() }, "corrupted secure receipt is revalidated rather than trusting stored success flag")
    receipts = stored
    vault[secured.id] = "{}"
    check(rejects { _ = try acknowledged() }, "ACK cannot authorize cleanup when original secure payload is damaged")
    print("Native management acknowledgement: \(count) checks passed")
  }
}
