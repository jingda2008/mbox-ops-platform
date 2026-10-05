import Foundation

func validateNativeSettingsBody(_ body: [String: Any], proof: [String: Any], module: NativeManagementModule) throws {
  guard let op = proof["operation"] as? String, proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  _ = try nativeSettingsPermission(module, operation: op)
  let versionKey = module == .tableConfiguration ? "expectedUpdatedAt" : "expectedVersion"
  guard managementJSONEqual(body[versionKey] ?? NSNull(), proof["expected"] ?? "missing") else { throw StaffAPIError.invalid }
  if module != .tableConfiguration && module != .commercePolicy {
    guard let version = body["expectedVersion"] as? String, managementHash(version) else { throw StaffAPIError.invalid }
  }
  func target(_ value: Any?) throws {
    guard managementJSONEqual(value ?? NSNull(), proof["targetId"] ?? "missing") else { throw StaffAPIError.invalid }
    if let value { _ = try managementUUID(value) }
  }
  func code(_ value: Any?) throws {
    guard managementJSONEqual(value ?? NSNull(), proof["targetCode"] ?? "missing") else { throw StaffAPIError.invalid }
  }
  switch module {
  case .tableConfiguration:
    _ = try managementText(body, "reason", 2...500)
    let table = op.hasPrefix("table"), update = op.hasSuffix("update")
    var keys = table ? ["areaId", "code", "displayName", "capacity", "minimumSpendMinor", "status", "reason"] : ["name", "areaType", "sortOrder", "status", "reason"]
    if update { keys += [table ? "tableId" : "areaId", "expectedUpdatedAt"]; _ = try managementText(body, "expectedUpdatedAt", 10...64) }
    else if !table { keys += ["code"] }
    try managementExact(body, keys)
    try target(update ? body[table ? "tableId" : "areaId"] : nil)
    try code(body["code"])
    let states = table ? nativeTableStates : nativeAreaStates
    guard states[body["status"] as? String ?? ""] != nil else { throw StaffAPIError.invalid }
    if table || !update { guard managementCode(try managementText(body, "code", 1...32)) else { throw StaffAPIError.invalid } }
    if table {
      _ = try managementUUID(body["areaId"]); _ = try managementText(body, "displayName", 1...120)
      guard (1...200).contains(try managementInt(body["capacity"])) else { throw StaffAPIError.invalid }
      if !(body["minimumSpendMinor"] is NSNull) { guard (0...100_000_000).contains(try managementInt(body["minimumSpendMinor"])) else { throw StaffAPIError.invalid } }
    } else {
      _ = try managementText(body, "name", 1...120)
      guard nativeAreaTypes[body["areaType"] as? String ?? ""] != nil,
        (-100_000...100_000).contains(try managementInt(body["sortOrder"])) else { throw StaffAPIError.invalid }
    }
  case .commercePolicy:
    try managementExact(body, ["expectedVersion", "reason", op == "online-payment" ? "enabled" : "paymentReservationMinutes"])
    _ = try managementText(body, "reason", 3...1000); try target(nil); try code(nil)
    guard try managementInt(body["expectedVersion"]) >= 0, let baseline = proof["baseline"] as? [String: Any] else { throw StaffAPIError.invalid }
    try managementExact(baseline, ["online", "minutes"])
    let online = try managementBool(baseline["online"]), minutes = try managementInt(baseline["minutes"])
    guard (2...30).contains(minutes) else { throw StaffAPIError.invalid }
    if op == "online-payment" { guard try managementBool(body["enabled"]) != online else { throw StaffAPIError.invalid } }
    else { let next = try managementInt(body["paymentReservationMinutes"]); guard (2...30).contains(next), next != minutes else { throw StaffAPIError.invalid } }
  case .staff:
    _ = try managementText(body, "reason", 2...200)
    let common = ["expectedVersion", "reason"]
    switch op {
    case "create":
      try managementExact(body, common + ["employeeCode", "displayName", "pin", "roleId"]); try target(nil); try code(body["employeeCode"])
      guard managementCode(try managementText(body, "employeeCode", 1...64), maximum: 64) else { throw StaffAPIError.invalid }
      _ = try managementText(body, "displayName", 1...64); _ = try managementUUID(body["roleId"])
    case "status":
      try managementExact(body, common + ["employeeId", "status"]); try target(body["employeeId"]); try code(nil)
      guard ["active", "suspended"].contains(body["status"] as? String ?? "") else { throw StaffAPIError.invalid }
    case "pin": try managementExact(body, common + ["employeeId", "pin"]); try target(body["employeeId"]); try code(nil)
    case "credential":
      try managementExact(body, common + ["credentialVersion", "credential", "validFrom", "validUntil"]); try target(nil); try code(nil)
      guard let version = body["credentialVersion"] as? String, managementHash(version), version == proof["credentialVersion"] as? String,
        let secret = body["credential"] as? String, (6...128).contains(secret.utf16.count),
        let from = body["validFrom"] as? String, let until = body["validUntil"] as? String,
        try managementInstant(until) > managementInstant(from) else { throw StaffAPIError.invalid }
      // Original expired requests are still recoverable; only new preparation checks now.
    case "deploy":
      try managementExact(body, common + ["changes"]); try target(nil); try code(nil)
      guard let changes = body["changes"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      try validateNativeStaffChanges(changes)
    default: throw StaffAPIError.invalid
    }
    if ["create", "pin"].contains(op) {
      guard let pin = body["pin"] as? String, pin.range(of: "^[0-9]{4}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
    }
  case .publication:
    _ = try managementText(body, "reason", 2...500)
    let common = ["expectedVersion", "reason"]
    switch op {
    case "profile-draft":
      try managementExact(body, common + ["employeeId", "publicDisplayName"]); try target(body["employeeId"]); try code(nil)
      _ = try managementText(body, "publicDisplayName", 1...80)
    case "profile-publish", "profile-withdraw":
      try managementExact(body, common + ["profileId"] + (op.hasSuffix("publish") ? ["approvalReference", "effectiveAt"] : []))
      try target(body["profileId"]); try code(nil)
    case "privacy-draft":
      try managementExact(body, common + ["policyVersion", "content", "operatorName", "contact", "dataRetentionPolicyVersion", "thirdPartyRegisterVersion"])
      try target(nil); try code(body["policyVersion"])
      for (key, limits) in [("content", 80...50000), ("operatorName", 2...200), ("contact", 2...500), ("dataRetentionPolicyVersion", 2...80), ("thirdPartyRegisterVersion", 2...80)] { _ = try managementText(body, key, limits) }
    case "privacy-publish", "privacy-withdraw":
      try managementExact(body, common + ["policyVersion"] + (op.hasSuffix("publish") ? ["approvedBy", "approvalReference", "effectiveAt"] : []))
      _ = try managementUUID(proof["targetId"]); try code(body["policyVersion"])
      if op == "privacy-publish" { _ = try managementText(body, "approvedBy", 2...200) }
    case "contact":
      try managementExact(body, common + ["rolloutState", "configuration"]); try target(nil); try code(nil)
      guard ["disabled", "pilot", "enabled"].contains(body["rolloutState"] as? String ?? ""), let contact = body["configuration"] as? [String: Any] else { throw StaffAPIError.invalid }
      try managementExact(contact, ["phone", "phoneLabel", "wecomName", "wecomQrImageUrl"])
      let phone = try managementText(contact, "phone", 6...31)
      guard phone.range(of: "^[+0-9][0-9 -]{5,30}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
      _ = try managementText(contact, "phoneLabel", 2...40); _ = try managementText(contact, "wecomName", 2...40)
      if !(contact["wecomQrImageUrl"] is NSNull) {
        guard let qr = contact["wecomQrImageUrl"] as? String, qr.range(of: "^/api/public/media-assets/MA[0-9A-F]{32}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
      }
    default: throw StaffAPIError.invalid
    }
    if op.hasPrefix("privacy") {
      guard let value = body["policyVersion"] as? String, value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
    }
    if op.hasSuffix("publish") {
      _ = try managementText(body, "approvalReference", 8...240)
      guard let value = body["effectiveAt"] as? String else { throw StaffAPIError.invalid }; _ = try managementInstant(value)
    }
  default: throw StaffAPIError.invalid
  }
}
func validateNativeSettingsReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let proof = step.nativeManagementProof, let name = proof["module"] as? String,
    let module = NativeManagementModule(rawValue: name), let op = proof["operation"] as? String,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let meta = root["meta"] as? [String: Any],
    try managementInt(meta["protocol"]) == 1, (try? managementBool(meta["replayed"])) != nil,
    let data = root["data"] as? [String: Any], data["employeeId"] as? String == proof["employeeId"] as? String,
    data["requestKey"] as? String == step.key, data["action"] as? String == op,
    let row = data[module == .commercePolicy ? "row" : "result"] as? [String: Any] else { throw StaffAPIError.invalid }
  try validateNativeSettingsBody(body, proof: proof, module: module)
  func exactFields(_ expected: [String: Any]) throws {
    for (key, value) in expected { guard let actual = row[key], managementJSONEqual(value, actual) else { throw StaffAPIError.invalid } }
  }
  switch module {
  case .tableConfiguration:
    _ = try managementUUID(row["id"])
    var expected = body; expected.removeValue(forKey: "reason"); expected.removeValue(forKey: "expectedUpdatedAt")
    if let target = expected.removeValue(forKey: op.hasPrefix("table") ? "tableId" : "areaId") { expected["id"] = target }
    try exactFields(expected)
  case .commercePolicy:
    guard let baseline = proof["baseline"] as? [String: Any] else { throw StaffAPIError.invalid }
    try exactFields(["policyVersion": try managementInt(body["expectedVersion"]) + 1,
      "updatedByEmployeeId": proof["employeeId"]!, "reason": body["reason"]!,
      "policyOnlinePaymentEnabled": body["enabled"] ?? baseline["online"]!,
      "paymentReservationMinutes": body["paymentReservationMinutes"] ?? baseline["minutes"]!])
    guard try managementBool(row["onlinePaymentEnabled"]) == (managementBool(row["policyOnlinePaymentEnabled"]) && managementBool(row["providerConfigured"])) else { throw StaffAPIError.invalid }
  case .staff:
    switch op {
    case "create":
      _ = try managementUUID(row["employeeId"])
      guard let overview = row["overview"] as? [String: Any], let employees = overview["employees"] as? [[String: Any]],
        let created = employees.first(where: { $0["id"] as? String == row["employeeId"] as? String }),
        created["code"] as? String == body["employeeCode"] as? String, created["displayName"] as? String == body["displayName"] as? String else { throw StaffAPIError.invalid }
    case "status": try exactFields(["employeeId": body["employeeId"]!, "status": body["status"]!])
    case "pin":
      try exactFields(["employeeId": body["employeeId"]!, "pinConfigured": true])
      guard try managementInt(row["revokedSessionCount"]) >= 0 else { throw StaffAPIError.invalid }
    case "credential":
      _ = try managementUUID(row["credentialId"])
      guard let from = row["validFrom"] as? String, let until = row["validUntil"] as? String,
        try managementInstant(from) == managementInstant(body["validFrom"] as! String),
        try managementInstant(until) == managementInstant(body["validUntil"] as! String) else { throw StaffAPIError.invalid }
    case "deploy":
      guard row["status"] as? String == "verified", let results = row["changes"] as? [[String: Any]],
        let changes = body["changes"] as? [[String: Any]], results.count == changes.count else { throw StaffAPIError.invalid }
      for (change, result) in zip(changes, results) {
        let kind = change["kind"] as! String
        var code = (change["permissionCode"] ?? change["scopeKey"] ?? change["approvalCode"] ?? change["navigationCode"]) as? String
        if kind == "role_data_scope" { code = (code ?? "") + ":" + (change["effect"] as? String ?? "") }
        if kind == "role_approval_limit" { code = (code ?? "") + ":" + (change["currency"] as? String ?? "") }
        guard result["kind"] as? String == kind, try managementBool(result["applied"]),
          result["targetId"] as? String == (change["employeeId"] ?? change["roleId"]) as? String,
          result["configurationCode"] as? String == code,
          try managementInt(result["effectiveEmployeeCount"]) >= 0,
          try managementInt(result["affectedEmployeeCount"]) >= 0 else { throw StaffAPIError.invalid }
      }
    default: throw StaffAPIError.invalid
    }
  case .publication:
    if op == "contact" {
      try exactFields(["featureCode": "customer.support.contact", "rolloutState": body["rolloutState"]!, "configuration": body["configuration"]!])
    } else {
      _ = try managementUUID(row["id"])
      try exactFields(["status": op.hasSuffix("draft") ? "draft" : op.hasSuffix("publish") ? "published" : "withdrawn"])
      if let target = body["profileId"] { try exactFields(["id": target]) }
      if let version = body["policyVersion"] { try exactFields(["policyVersion": version]) }
      if op.hasPrefix("privacy") && !op.hasSuffix("draft") { try exactFields(["id": proof["targetId"]!]) }
      if op == "profile-draft" { try exactFields(["employeeId": body["employeeId"]!, "publicDisplayName": body["publicDisplayName"]!]) }
      if op == "privacy-draft" { try exactFields(["contentSha256": managementSHA256(Data((body["content"] as! String).utf8))]) }
    }
  default: throw StaffAPIError.invalid
  }
}

func validNativeSettingsSelection(command: LiveCommand, board: NativeManagementBoard, actor: StaffIdentity) -> Bool {
  guard let step = command.steps.first, let proof = step.nativeManagementProof, let op = proof["operation"] as? String else { return false }
  let body = step.object
  switch board.module {
  case .tableConfiguration:
    if op.hasSuffix("update") {
      let table = op.hasPrefix("table"), collection = table ? "tables" : "areas"
      guard let row = board.rows(collection).first(where: { $0.id == proof["targetId"] as? String }),
        row.text("updatedAt") == proof["expected"] as? String else { return false }
      if table { return row.object["activeSessionId"] is NSNull }
      if body["status"] as? String != "active" {
        return !board.rows("tables").contains { $0.text("areaId") == row.id && !($0.object["activeSessionId"] is NSNull) }
      }
      return true
    }
    return !board.rows(op.hasPrefix("table") ? "tables" : "areas").contains { $0.text("code") == body["code"] as? String }
  case .commercePolicy:
    guard let row = board.data["row"] as? [String: Any], let baseline = proof["baseline"] as? [String: Any] else { return false }
    return managementJSONEqual(row["policyVersion"] ?? NSNull(), proof["expected"] ?? NSNull())
      && managementJSONEqual(row["policyOnlinePaymentEnabled"] ?? NSNull(), baseline["online"] ?? NSNull())
      && managementJSONEqual(row["paymentReservationMinutes"] ?? NSNull(), baseline["minutes"] ?? NSNull())
      && (!(body["enabled"] as? Bool ?? false) || (try? managementBool(row["providerConfigured"])) == true)
  case .staff:
    guard let overview = board.data["overview"] as? [String: Any], overview["configurationVersion"] as? String == proof["expected"] as? String else { return false }
    if op == "deploy" { guard let changes = body["changes"] as? [[String: Any]] else { return false }; return (try? validateNativeStaffChanges(changes, board: board)) != nil }
    if op == "credential" { return board.data["credentialVersion"] as? String == proof["credentialVersion"] as? String }
    if op == "create" { return board.rows("roles").contains { $0.id == body["roleId"] as? String && $0.text("status") == "active" }
      && !board.rows("employees").contains { $0.text("code").lowercased() == (body["employeeCode"] as? String ?? "").lowercased() } }
    return board.rows("employees").contains { $0.id == body["employeeId"] as? String }
  case .publication:
    let section = op.hasPrefix("profile") ? "profile" : op.hasPrefix("privacy") ? "privacy" : "contact"
    guard let versions = board.data["versions"] as? [String: Any], versions[section] as? String == proof["expected"] as? String,
      (board.data["permissions"] as? [String] ?? []).contains(command.permission) else { return false }
    if op.hasSuffix("publish") || op.hasSuffix("withdraw") {
      guard let row = board.rows(section == "profile" ? "profiles" : "policies").first(where: { $0.id == proof["targetId"] as? String }),
        row.text("status") == (op.hasSuffix("publish") ? "draft" : "published") else { return false }
      return !op.hasSuffix("publish") || (!row.text("draftedByEmployeeId").isEmpty && row.text("draftedByEmployeeId") != actor.employee.id && (section != "profile" || row.text("employeeId") != actor.employee.id))
    }
    return op != "profile-draft" || board.rows("employees").contains { $0.id == body["employeeId"] as? String }
  default: return false
  }
}
