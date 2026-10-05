import Foundation

@main struct NativeDeviceManagementTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ label: String) { precondition(condition, label); count += 1; print("PASS " + label) }
    func bytes(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: .sortedKeys) }
    func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let hash = String(repeating: "a", count: 64)
    let auth: [String: Any] = ["employee": ["id": id(1), "code": "printer", "displayName": "设备管理员", "roleCodes": []],
      "session": ["id": id(2), "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["printer.manage"], "deniedPermissions": []]
    func actor(_ value: [String: Any] = [:]) throws -> StaffIdentity {
      try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth.merging(value) { _, new in new }))
    }
    let employee = try actor()
    let device: [String: Any] = ["id": id(3), "code": "cashier-printer", "name": "收银打印机", "deviceType": "printer",
      "stationCode": "cashier", "status": "active", "printBridgeId": id(4), "windowsQueueName": "POS-80", "printProfile": "escpos_80", "configurationFingerprint": hash]
    let bridge: [String: Any] = ["id": id(4), "name": "门店电脑", "hostname": "store-local", "status": "active", "queues": ["POS-80"]]
    let route: [String: Any] = ["id": id(5), "code": "cashier-route", "name": "收银路由", "stationCode": "cashier", "status": "active", "printerDeviceId": id(3), "copies": 2, "priority": 100, "productCategoryCode": NSNull(), "configurationFingerprint": hash]
    let policy: [String: Any] = ["ticketKind": "cashier_payment", "enabled": true, "copies": NSNull(), "configurationFingerprint": hash]
    func board(devices: [[String: Any]]? = nil, bridges: [[String: Any]]? = nil, enabled: Bool = true,
      revocation: Bool = true, user: StaffIdentity? = nil) throws -> NativeManagementBoard {
      try NativeManagementBoard(module: .devices, data: bytes(["data": ["employeeId": id(1), "nativeCommands": enabled,
        "devices": devices ?? [device], "routes": [route], "policies": [policy], "commands": []]]),
        bridges: bytes(["data": bridges ?? [bridge]]), capabilities: bytes(["data": ["durableRevocation": revocation]]), actor: user ?? employee)
    }
    let current = try board()
    let fields: [String: String] = ["code": "cashier-printer", "name": "收银打印机", "stationCode": "cashier", "status": "active",
      "printBridgeId": id(4), "windowsQueueName": "POS-80", "printProfile": "escpos_80", "printerDeviceId": id(3),
      "productCategoryCode": "", "copies": "", "priority": "100", "enabled": "true", "command": "test_print", "reason": "核对原门店打印配置"]
    func command(_ op: String, changed: [String: String] = [:], row: String? = nil,
      source: NativeManagementBoard? = nil, user: StaffIdentity? = nil) throws -> LiveCommand {
      try (source ?? current).command(actor: user ?? employee, operation: op, fields: fields.merging(changed) { _, new in new }, rowID: row)
    }
    let commands = try [command("device-create", changed: ["code": "new-printer"]), command("device-update", row: id(3)),
      command("route-save", changed: ["code": "cashier-route", "copies": "2"], row: id(5)),
      command("route-save", changed: ["code": "new-route", "copies": "3"]),
      command("policy-save", row: "cashier_payment"), command("bridge-revoke", row: id(4)), command("device-test", row: id(3))]
    func receipt(_ command: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let body = command.steps[0].object, operation = body["kind"] as! String
      var row: [String: Any]
      if let value = body["device"] as? [String: Any] { row = value; row["id"] = body["id"] ?? id(31); row["deviceType"] = "printer" }
      else if let value = body["route"] as? [String: Any] { row = value; row["id"] = id(5) }
      else if let value = body["policy"] as? [String: Any] { row = value }
      else if operation == "bridge-revoke" { row = ["id": id(4), "status": "revoked"] }
      else { row = ["id": id(32), "publicId": command.steps[0].key, "deviceId": id(3), "commandType": "test_print", "status": "requested"] }
      return ["data": ["kind": operation, "employeeId": id(1), "reason": fields["reason"]!, "row": row], "meta": ["replayed": replayed]]
    }
    for original in commands {
      let operation = original.steps[0].object["kind"] as! String
      var vault: [String: String] = [:]
      let secured = try secureNativeManagementCommand(original) { vault[$0] = $1 }
      let step = secured.steps[0]
      check(try step.body == Data("{}".utf8) && !String(data: JSONEncoder().encode(secured), encoding: .utf8)!.contains(fields["reason"]!), "\(operation) ordinary checkpoint has no configuration payload")
      let body = try nativeManagementRequestBody(secured, step: step, actor: employee) { vault[$0]! }
      check(NSDictionary(dictionary: body).isEqual(to: original.steps[0].object), "\(operation) secure reload keeps original complete payload")
      try validateNativeManagementReply(bytes(receipt(original)), step: step, body: body)
      check(true, "\(operation) actual receipt shape validates")
      var saved = try JSONEncoder().encode(secured), requests: [URLRequest] = [], commits = 0
      let api = StaffAPI(transport: { request in
        if request.url!.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        requests.append(request)
        guard request.url!.path == step.path, request.httpMethod == "POST",
          request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1),
          let sent = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: sent) as! [String: Any]).isEqual(to: body) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1; throw URLError(.timedOut) }
        return (try bytes(receipt(original, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "printer", pin: "1234", switching: false)
      func send(_ value: LiveCommand, _ selected: LiveCommand.Step) async throws {
        let payload = try nativeManagementRequestBody(value, step: selected, actor: employee) { vault[$0]! }
        let (data, _) = try await api.raw(selected.path, body: payload, headers: [selected.keyHeader: selected.key])
        try validateNativeManagementReply(data, step: selected, body: payload)
      }
      do { _ = try await LiveCommandRunner.advance(secured, send: { try await send(secured, $0) }, checkpoint: { saved = try JSONEncoder().encode($0) }); preconditionFailure("lost receipt accepted") } catch {}
      let restored = try JSONDecoder().decode(LiveCommand.self, from: saved)
      check(restored == secured, "\(operation) lost reply keeps original secure checkpoint")
      let complete = try await LiveCommandRunner.advance(restored, send: { try await send(restored, $0) }, checkpoint: { saved = try JSONEncoder().encode($0) })
      check(complete.completedSteps == 1 && commits == 1 && requests.count == 2, "\(operation) original key replay confirms one mutation after restart")
      _ = try await LiveCommandRunner.advance(complete, send: { try await send(complete, $0) }, checkpoint: { _ in })
      check(requests.count == 2, "\(operation) receipt checkpoint prevents resend after refresh failure")
      check(rejects { _ = try secureNativeManagementCommand(secured) { _, _ in preconditionFailure("rewrote secured slot") } }, "\(operation) new execution cannot resecure pending checkpoint")
    }
    check(validNativeManagementSelection(command: commands[1], board: current, actor: employee), "current exact device version remains executable")
    var movedVersion = device; movedVersion["configurationFingerprint"] = String(repeating: "b", count: 64)
    check(!validNativeManagementSelection(command: commands[1], board: try board(devices: [movedVersion]), actor: employee), "new configuration fingerprint invalidates open confirmation")
    check(!validNativeManagementSelection(command: commands[0], board: try board(devices: [device.merging(["code": "new-printer"]) { _, new in new }]), actor: employee), "newly claimed device code invalidates create confirmation")
    let policyCommand = commands[4], policyStep = policyCommand.steps[0]
    check((policyStep.object["policy"] as! [String: Any])["copies"] is NSNull, "route inheritance remains explicit JSON null")
    for invalid: Any in ["null", 1, "1", true] {
      var response = receipt(policyCommand), data = response["data"] as! [String: Any], row = data["row"] as! [String: Any]
      row["copies"] = invalid; data["row"] = row; response["data"] = data
      check(rejects { try validateNativeManagementReply(bytes(response), step: policyStep, body: policyStep.object) }, "inherited copies rejects substituted scalar \(invalid)")
    }
    var missing = receipt(policyCommand), data = missing["data"] as! [String: Any], row = data["row"] as! [String: Any]
    row.removeValue(forKey: "copies"); data["row"] = row; missing["data"] = data
    check(rejects { try validateNativeManagementReply(bytes(missing), step: policyStep, body: policyStep.object) }, "inherited copies rejects omitted receipt field")
    for value in ["0", "6", "1.5", "01", "1e0"] {
      check(rejects { _ = try command("policy-save", changed: ["copies": value], row: "cashier_payment") }, "invalid copies \(value) cannot prepare")
    }
    check(rejects { _ = try command("device-create", changed: ["printBridgeId": "", "windowsQueueName": ""]) }, "partial print configuration cannot prepare")
    check(rejects { _ = try command("device-create", changed: ["windowsQueueName": "unreported"]) }, "new active device requires actual bridge queue")
    var paused = device; paused["status"] = "paused"
    check((try command("route-save", changed: ["code": "new-route", "copies": "1"], source: board(devices: [paused]))).steps.count == 1, "paused printer can retain route configuration")
    var revoked = bridge; revoked["status"] = "revoked"
    let offline = try board(bridges: [revoked])
    check((try command("device-update", changed: ["status": "retired"], row: id(3), source: offline)).steps.count == 1, "revoked old bridge cannot block retiring its device")
    check(rejects { _ = try command("device-update", row: id(3), source: board(devices: [paused], bridges: [revoked])) }, "reactivating paused device requires active bridge")
    var retired = device; retired["status"] = "retired"
    check(rejects { _ = try command("device-update", row: id(3), source: board(devices: [retired])) }, "retired printer cannot reactivate")
    check(rejects { _ = try command("bridge-revoke", row: id(4), source: board(revocation: false)) }, "missing durable revocation capability blocks revoke")
    check(rejects { _ = try command("device-test", row: id(3), source: board(enabled: false)) }, "disabled native command capability blocks execution")
    check(rejects { _ = try board(user: actor(["deniedPermissions": ["printer.manage"]])) }, "explicit denied permission blocks board")
    check(rejects { _ = try command("device-test", row: id(3), user: actor(["permissions": []])) }, "permission removal blocks original board command")
    var vault: [String: String] = [:]
    let original = commands[1], secure = try secureNativeManagementCommand(original) { vault[$0] = $1 }
    func altered(proof changes: [String: Any] = [:], path: String? = nil, key: String? = nil, header: String? = nil,
      body: Data? = nil, permission: String? = nil, identifier: String? = nil) throws -> LiveCommand {
      let step = secure.steps[0]; var proof = step.nativeManagementProof!; proof.merge(changes) { _, new in new }
      return LiveCommand(id: identifier ?? secure.id, employeeID: secure.employeeID, title: secure.title, permission: permission ?? secure.permission,
        steps: [.init(path: path ?? step.path, body: body ?? step.body, keyHeader: header ?? step.keyHeader, key: key ?? step.key, recoveryBody: try bytes(["nativeManagement": proof]))])
    }
    check(secure.steps[0].nativeManagementProof?["payloadSHA256"] == nil
      && managementHash(secure.steps[0].nativeManagementProof?["payloadAuthentication"] as? String ?? ""),
      "ordinary pending stores keyed authentication and cannot expose low entropy payload digest")
    let alteredCommands = try [altered(proof: ["payloadKey": id(88)]), altered(proof: ["employeeId": id(88)]),
      altered(proof: ["module": "staff"]), altered(proof: ["operation": "device-create"]), altered(proof: ["targetId": id(99)]),
      altered(proof: ["expected": String(repeating: "b", count: 64)]), altered(proof: ["targetCode": "other"]),
      altered(proof: ["confirmation": "plaintext"]), altered(path: "/api/refunds/unsafe/execute"), altered(key: "new-key"),
      altered(header: "x-idempotency-key"), altered(body: Data("{\"kind\":\"device-update\"}".utf8)), altered(permission: "staff.access.configure"), altered(identifier: "invalid")]
    for (index, changed) in alteredCommands.enumerated() {
      check(rejects { _ = try nativeManagementRequestBody(changed, step: changed.steps[0], actor: employee) { vault[$0] ?? "{}" } }, "checkpoint tamper \(index) rejected before send")
    }
    var changedEnvelope = try JSONSerialization.jsonObject(with: Data(vault[secure.id]!.utf8)) as! [String: Any]
    changedEnvelope["authenticationKey"] = Data(repeating: 0, count: 32).base64EncodedString()
    check(rejects { _ = try nativeManagementRequestBody(secure, step: secure.steps[0], actor: employee) { _ in String(data: try bytes(changedEnvelope), encoding: .utf8)! } }, "Keychain authentication-key substitution rejected")
    var other = auth["employee"] as! [String: Any]; other["id"] = id(80)
    check(rejects { _ = try nativeManagementRequestBody(secure, step: secure.steps[0], actor: actor(["employee": other])) { _ in preconditionFailure("cross employee secret read") } }, "another employee cannot even read original secure slot")
    check(rejects { _ = try nativeManagementRequestBody(secure, step: alteredCommands[0].steps[0], actor: employee) { _ in preconditionFailure("substituted step secret read") } }, "external substituted step must exactly belong to command")
    check(rejects { _ = try nativeManagementRequestBody(secure, step: secure.steps[0], actor: employee) { _ in "{\"changed\":true}" } }, "secure payload replacement rejected by digest")
    check(rejects { _ = try secureNativeManagementCommand(original) { _, _ in throw URLError(.cannotWriteToFile) } }, "secure storage failure prevents pending preparation")
    let now = Date(), validPairing: [String: Any] = ["id": id(66), "pairingCode": "ABCDE-01234-56789-ABCDE", "expiresAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(600))]
    check((try NativeBridgePairing(data: bytes(["data": validPairing]), now: now)).id == id(66), "manual pairing displays validated server code with ten minute expiry")
    for expiry in [now.addingTimeInterval(-1), now.addingTimeInterval(700)] {
      var invalid = validPairing; invalid["expiresAt"] = ISO8601DateFormatter().string(from: expiry)
      check(rejects { _ = try NativeBridgePairing(data: bytes(["data": invalid]), now: now) }, "expired or overlong pairing code rejected")
    }
    print("Native device management: \(count) checks passed")
  }
}
