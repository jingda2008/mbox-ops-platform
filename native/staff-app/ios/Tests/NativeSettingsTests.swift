import Foundation

@main struct NativeSettingsTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let hash = String(repeating: "a", count: 64)
    let permissions = ["staff.access.configure", "table.manage", "payment.policy.manage"] + Array(Set(nativePublicationPermissions.values))
    let auth: [String: Any] = ["employee": ["id": id(1), "code": "manager", "displayName": "管理员", "roleCodes": []],
      "session": ["id": id(2), "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": permissions, "deniedPermissions": []]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    let employee: [String: Any] = ["id": id(1), "code": "manager", "displayName": "管理员", "employeeCode": "manager", "status": "active", "roleCodes": ["MANAGER"], "overrides": []]
    var other = employee; other["id"] = id(3); other["displayName"] = "其他员工"; other["code"] = "other"
    let role: [String: Any] = ["id": id(4), "name": "店长", "code": "MANAGER", "status": "active", "permissionCodes": ["staff.access.configure"], "dataScopes": [], "approvalLimits": [], "navigation": [], "memberCount": 2]
    let area: [String: Any] = ["id": id(5), "code": "indoor", "name": "室内", "areaType": "indoor", "sortOrder": 1, "status": "active", "updatedAt": "2026-10-05 09:01:02.123456+00"]
    let table: [String: Any] = ["id": id(6), "areaId": id(5), "code": "A01", "displayName": "一号桌", "capacity": 4, "minimumSpendMinor": NSNull(), "status": "available", "activeSessionId": NSNull(), "updatedAt": "2026-10-05 09:02:03.123456+00"]
    let defs: [[String: Any]] = [["kind": "data_scope", "code": "area.assigned", "label": "负责区域", "sortOrder": 1, "config": ["editor": "area_multi", "effect": "include"]],
      ["kind": "approval_limit", "code": "refund.approve", "label": "退款审批", "sortOrder": 2, "config": ["currency": "CNY", "controls": ["second_actor", "discount_percent"], "defaultRules": [:]]],
      ["kind": "navigation", "code": "settings", "label": "门店设置", "sortOrder": 3, "config": ["route": "/staff/settings", "icon": NSNull()]]]
    let overview: [String: Any] = ["configurationVersion": hash, "employees": [employee, other], "roles": [role], "areas": [area],
      "permissions": [["code": "staff.access.configure", "name": "人员配置"], ["code": "table.manage", "name": "桌台管理"]], "configurationDefinitions": defs]
    let staffData: [String: Any] = ["overview": overview, "credentials": [], "credentialVersion": hash]
    let profile: [String: Any] = ["id": id(7), "employeeId": id(3), "publicDisplayName": "服务小李", "employeeDisplayName": "其他员工", "draftedByEmployeeId": id(8), "status": "draft"]
    var publishedProfile = profile; publishedProfile["id"] = id(9); publishedProfile["status"] = "published"
    let policy: [String: Any] = ["id": id(10), "policyVersion": "privacy-2026-10", "draftedByEmployeeId": id(8), "status": "draft", "content": String(repeating: "真实政策正文。", count: 20)]
    var publishedPolicy = policy; publishedPolicy["id"] = id(11); publishedPolicy["policyVersion"] = "privacy-2026-09"; publishedPolicy["status"] = "published"
    func board(_ module: NativeManagementModule, changed: [String: Any] = [:]) throws -> NativeManagementBoard {
      var data: [String: Any] = ["employeeId": id(1), "protocol": 1, "durableCommands": true]
      switch module {
      case .staff: data.merge(staffData) { _, new in new }
      case .tableConfiguration: data.merge(["areas": [area], "tables": [table]]) { _, new in new }
      case .commercePolicy: data["row"] = ["policyVersion": 7, "providerConfigured": true, "policyOnlinePaymentEnabled": true, "onlinePaymentEnabled": true, "paymentReservationMinutes": 15]
      case .publication:
        data.merge(["profiles": [profile, publishedProfile], "policies": [policy, publishedPolicy], "employees": [other], "permissions": Array(Set(nativePublicationPermissions.values)), "versions": ["profile": hash, "privacy": hash, "contact": hash], "contact": NSNull()]) { _, new in new }
      default: preconditionFailure()
      }
      data.merge(changed) { _, new in new }
      return try NativeManagementBoard(module: module, data: bytes(["data": data]), actor: actor)
    }
    let staff = try board(.staff), tables = try board(.tableConfiguration), commerce = try board(.commercePolicy), publication = try board(.publication)
    let baseFields: [String: String] = ["reason": "核对门店真实配置", "name": "新区域", "displayName": "新桌台", "code": "new-code", "status": "active", "areaType": "indoor", "sortOrder": "-10", "capacity": "6", "areaId": id(5), "minimumSpendMinor": "100.01", "employeeCode": "new_staff", "roleId": id(4), "pin": "1234", "repeatSecret": "1234", "credential": "new-store-secret", "validFrom": "2098-01-01T00:00:00+08:00", "validUntil": "2099-01-01T00:00:00+08:00", "enabled": "false", "paymentReservationMinutes": "10", "employeeId": id(3), "publicDisplayName": "服务小王", "policyVersion": "new-policy-v1", "content": String(repeating: "实际批准的隐私政策内容。", count: 20), "operatorName": "真实运营公司", "contact": "门店客服渠道", "dataRetentionPolicyVersion": "retention-v1", "thirdPartyRegisterVersion": "third-v1", "approvedBy": "真实运营批准人", "approvalReference": "APPROVAL-REAL-20261005", "phone": "+86 13800138000", "phoneLabel": "门店电话", "wecomName": "门店客服", "wecomQrImageUrl": "", "rolloutState": "enabled"]
    func make(_ b: NativeManagementBoard, _ op: String, row: String? = nil, fields: [String: String] = [:]) throws -> LiveCommand {
      try b.command(actor: actor, operation: op, fields: baseFields.merging(fields) { _, new in new }, rowID: row)
    }
    let changeFields: [String: String] = ["enabled": "false", "effect": "deny", "amountMinor": "1000.01", "discountBasisPoints": "1000", "label": "门店配置", "sortOrder": "1", "highFrequency": "false", "values": String(data: try bytes([id(5)]), encoding: .utf8)!]
    let changes = try [nativeStaffChange(board: staff, targetID: id(4), kind: "role_permission", code: "staff.access.configure", fields: changeFields),
      nativeStaffChange(board: staff, targetID: id(3), kind: "employee_override", code: "table.manage", fields: changeFields),
      nativeStaffChange(board: staff, targetID: id(4), kind: "role_data_scope", code: "area.assigned", fields: changeFields),
      nativeStaffChange(board: staff, targetID: id(4), kind: "role_approval_limit", code: "refund.approve", fields: changeFields),
      nativeStaffChange(board: staff, targetID: id(4), kind: "role_navigation", code: "settings", fields: changeFields)]
    let encodedChanges = String(data: try bytes(changes), encoding: .utf8)!
    let commands = try [make(tables, "area-create"), make(tables, "area-update", row: id(5)), make(tables, "table-create", fields: ["status": "available"]), make(tables, "table-update", row: id(6), fields: ["status": "available"]),
      make(staff, "create"), make(staff, "status", row: id(3), fields: ["status": "suspended"]), make(staff, "pin", row: id(1)), make(staff, "credential", fields: ["repeatSecret": "new-store-secret"]), make(staff, "deploy", fields: ["changes": encodedChanges, "changeSummary": "核对五类原配置"]),
      make(commerce, "online-payment"), make(commerce, "payment-reservation"), make(publication, "profile-draft"), make(publication, "profile-publish", row: id(7)), make(publication, "profile-withdraw", row: id(9)), make(publication, "privacy-draft"), make(publication, "privacy-publish", row: id(10)), make(publication, "privacy-withdraw", row: id(11)), make(publication, "contact")]
    func reply(_ c: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let b = c.steps[0].object, p = c.steps[0].nativeManagementProof!, op = p["operation"] as! String, module = p["module"] as! String
      var result: [String: Any] = [:]
      if module == "tableConfiguration" { result = b; result["id"] = b[op.hasPrefix("table") ? "tableId" : "areaId"] ?? id(21); if !op.hasSuffix("update") { result["id"] = id(21) } }
      else if module == "staff" {
        switch op {
        case "create": result = ["employeeId": id(20), "status": "active", "overview": ["employees": [["id": id(20), "code": b["employeeCode"]!, "displayName": b["displayName"]!]]]]
        case "status": result = ["employeeId": b["employeeId"]!, "status": b["status"]!]
        case "pin": result = ["employeeId": b["employeeId"]!, "pinConfigured": true, "revokedSessionCount": 2]
        case "credential": result = ["credentialId": id(25), "validFrom": "2097-12-31T16:00:00Z", "validUntil": "2098-12-31T16:00:00Z"]
        default: result = ["status": "verified", "changes": changes.map { change -> [String: Any] in
          let kind = change["kind"] as! String
          var code = (change["permissionCode"] ?? change["scopeKey"] ?? change["approvalCode"] ?? change["navigationCode"]) as! String
          if kind == "role_data_scope" { code += ":" + (change["effect"] as! String) }
          if kind == "role_approval_limit" { code += ":" + (change["currency"] as! String) }
          return ["kind": kind, "targetId": change["employeeId"] ?? change["roleId"]!, "configurationCode": code, "applied": true, "effectiveEmployeeCount": 0, "affectedEmployeeCount": 2]
        }]
        }
      } else if module == "commercePolicy" {
        result = ["policyVersion": 8, "updatedByEmployeeId": id(1), "reason": b["reason"]!, "policyOnlinePaymentEnabled": b["enabled"] ?? true, "paymentReservationMinutes": b["paymentReservationMinutes"] ?? 15, "providerConfigured": true, "onlinePaymentEnabled": b["enabled"] ?? true]
      } else if op == "contact" { result = ["featureCode": "customer.support.contact", "rolloutState": b["rolloutState"]!, "configuration": b["configuration"]!] }
      else {
        result = ["id": b["profileId"] ?? (op.hasPrefix("privacy") && !op.hasSuffix("draft") ? p["targetId"]! : id(23)), "status": op.hasSuffix("draft") ? "draft" : op.hasSuffix("publish") ? "published" : "withdrawn"]
        if let value = b["policyVersion"] { result["policyVersion"] = value }
        if op == "profile-draft" { result["employeeId"] = b["employeeId"]; result["publicDisplayName"] = b["publicDisplayName"] }
        if op == "privacy-draft" { result["contentSha256"] = managementSHA256(Data((b["content"] as! String).utf8)) }
      }
      return ["data": ["employeeId": id(1), "requestKey": c.steps[0].key, "action": op, module == "commercePolicy" ? "row" : "result": result], "meta": ["protocol": 1, "replayed": replayed]]
    }
    for original in commands {
      let p = original.steps[0].nativeManagementProof!, op = p["operation"] as! String, module = NativeManagementModule(rawValue: p["module"] as! String)!
      let current = [NativeManagementModule.staff: staff, .tableConfiguration: tables, .commercePolicy: commerce, .publication: publication][module]!
      check(validNativeManagementSelection(command: original, board: current, actor: actor), "\(module).\(op) exact current board permits new request")
      var vault: [String: String] = [:], ack: [String: String] = [:]
      let secure = try secureNativeManagementCommand(original) { vault[$0] = $1 }
      let body = try nativeManagementRequestBody(secure, step: secure.steps[0], actor: actor) { vault[$0]! }
      check(managementJSONEqual(body, original.steps[0].object), "\(op) Keychain reload retains full original payload")
      let publicRecord = String(data: try JSONEncoder().encode(secure), encoding: .utf8)!
      check(!publicRecord.contains("new-store-secret") && secure.steps[0].object["pin"] == nil && secure.steps[0].object["credential"] == nil && !publicRecord.contains("真实运营"), "\(op) ordinary pending excludes secrets and privacy payload")
      try recordNativeManagementAcknowledgement(bytes(reply(original)), command: secure, step: secure.steps[0], actor: actor, readPayload: { vault[$0]! }, readReceipt: { ack[$0] }, storeReceipt: { ack[$0] = $1 })
      check(try hasNativeManagementAcknowledgement(secure, readPayload: { vault[$0]! }, readReceipt: { ack[$0] }), "\(op) validated result becomes bound safe local ACK")
      var wrong = reply(original), wrongData = wrong["data"] as! [String: Any]; wrongData["requestKey"] = "new-key"; wrong["data"] = wrongData
      check(rejects { try validateNativeManagementReply(bytes(wrong), step: secure.steps[0], body: body) }, "\(op) receipt from another request rejected")
      var saved = try JSONEncoder().encode(secure), sends = 0
      let api = StaffAPI(transport: { request in
        if request.url!.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.url!.path == secure.steps[0].path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == secure.steps[0].key,
          let input = request.httpBody, managementJSONEqual(try JSONSerialization.jsonObject(with: input), body) else { throw StaffAPIError.invalid }
        if sends == 1 { throw URLError(.timedOut) }
        return (try bytes(reply(original, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "manager", pin: "1234", switching: false)
      func send(_ c: LiveCommand, _ s: LiveCommand.Step) async throws {
        let body = try nativeManagementRequestBody(c, step: s, actor: actor) { vault[$0]! }
        let response = try await api.raw(s.path, body: body, headers: [s.keyHeader: s.key]).0
        try validateNativeManagementReply(response, step: s, body: body)
      }
      do { _ = try await LiveCommandRunner.advance(secure, send: { try await send(secure, $0) }, checkpoint: { saved = try JSONEncoder().encode($0) }); preconditionFailure() } catch {}
      let restored = try JSONDecoder().decode(LiveCommand.self, from: saved)
      let done = try await LiveCommandRunner.advance(restored, send: { try await send(restored, $0) }, checkpoint: { _ in })
      check(done.completedSteps == 1 && sends == 2, "\(op) real API original-key recovery after lost reply")
    }
    check(commands[3].steps[0].object["expectedUpdatedAt"] as? String == table["updatedAt"] as? String, "Postgres microsecond version is preserved byte for byte")
    var busy = table; busy["activeSessionId"] = id(90)
    let occupied = try board(.tableConfiguration, changed: ["tables": [busy]])
    check(rejects { _ = try make(occupied, "table-update", row: id(6), fields: ["status": "available"]) }, "active table configuration remains locked")
    check(rejects { _ = try make(occupied, "area-update", row: id(5), fields: ["status": "paused"]) }, "area with live session cannot pause")
    check(rejects { _ = try make(staff, "pin", row: id(1), fields: ["repeatSecret": "9999"]) }, "PIN confirmation mismatch cannot prepare")
    check(rejects { _ = try make(staff, "credential", fields: ["repeatSecret": "new-store-secret", "validUntil": "2020-01-01T00:00:00Z"]) }, "expired new credential cannot prepare")
    var originalProfile = profile; originalProfile["draftedByEmployeeId"] = id(1)
    check(rejects { _ = try make(board(.publication, changed: ["profiles": [originalProfile]]), "profile-publish", row: id(7)) }, "drafter cannot publish own public profile")
    check(rejects { _ = try make(publication, "privacy-publish", row: id(10), fields: ["approvalReference": "fake"]) }, "short unsupported approval reference rejected")
    check(rejects { _ = try make(publication, "contact", fields: ["wecomQrImageUrl": "https://external.invalid/qr.png"]) }, "public contact requires own media asset instead of arbitrary remote URL")
    var changedDefs = changes; changedDefs[4]["route"] = "/staff/payments"
    check(rejects { try validateNativeStaffChanges(changedDefs, board: staff) }, "role navigation cannot substitute another route for its definition")
    changedDefs = changes; changedDefs[2]["scopeValue"] = [id(99)]
    check(rejects { try validateNativeStaffChanges(changedDefs, board: staff) }, "scope selection cannot introduce another store area")
    changedDefs = changes; var rules = changedDefs[3]["rules"] as! [String: Any]; rules["requiresSecondActor"] = false; changedDefs[3]["rules"] = rules
    check(rejects { try validateNativeStaffChanges(changedDefs, board: staff) }, "required second actor cannot be disabled")
    let publishA = try make(publication, "privacy-draft"), publishB = try make(publication, "privacy-draft", fields: ["content": String(repeating: "修改后的实际政策内容。", count: 20)])
    check(publishA.id != publishB.id && publishA.steps[0].key != publishB.steps[0].key, "privacy content change always gets new payload key and original request")
    print("Native settings: \(count) checks passed")
  }
}
