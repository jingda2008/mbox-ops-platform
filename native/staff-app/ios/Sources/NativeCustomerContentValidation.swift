import Foundation

let nativeHomeDraftKeys = ["type", "title", "summary", "imageUrl", "ctaLabel", "targetPath", "priority", "displayMode", "visibility", "audienceMemberLevels", "audienceLifecycleStages", "validFrom", "validUntil"]
let nativeRecommendationDraftKeys = Array(nativeRecommendationWeights.keys) + Array(nativeRecommendationLimits.keys) + ["explanationTemplate", "displayConfiguration"]
func validateHomeDraft(_ body: [String: Any]) throws {
  guard nativeHomeTypes[body["type"] as? String ?? ""] != nil,
    ["pinned", "rotation"].contains(body["displayMode"] as? String ?? ""),
    ["public", "member", "segment"].contains(body["visibility"] as? String ?? ""),
    let levels = body["audienceMemberLevels"] as? [String], let stages = body["audienceLifecycleStages"] as? [String],
    levels.allSatisfy({ nativeHomeLevels[$0] != nil }), stages.allSatisfy({ nativeHomeStages[$0] != nil }),
    levels == Array(Set(levels)).sorted(), stages == Array(Set(stages)).sorted(),
    body["visibility"] as? String == "segment" ? !levels.isEmpty || !stages.isEmpty : levels.isEmpty && stages.isEmpty,
    (0...10000).contains(try managementInt(body["priority"])),
    nativeContentTarget(try managementText(body, "targetPath", 1...256)) else { throw CatalogError("请核对展示方式、客群与站内目标页面") }
  for (key, limits) in [("title", 2...120), ("summary", 2...400), ("ctaLabel", 1...20)] { _ = try managementText(body, key, limits) }
  if !(body["imageUrl"] is NSNull) {
    guard let image = body["imageUrl"] as? String, image.range(of: "^/api/public/media-assets/MA[0-9A-F]{32}$", options: .regularExpression) != nil else { throw CatalogError("请从站内图片库选择内容图片") }
  }
  guard try nativeContentDate(managementText(body, "validUntil", 10...64)) > nativeContentDate(managementText(body, "validFrom", 10...64)) else { throw CatalogError("结束展示时间须晚于开始时间") }
}
func validatePopupDraft(_ body: [String: Any]) throws {
  _ = try managementBool(body["enabled"]); _ = try managementText(body, "title", 1...80)
  guard let content = body["content"] as? String, content.utf16.count <= 1000,
    ["daily", "session", "always"].contains(body["frequency"] as? String ?? ""),
    let ids = body["productIds"] as? [String], ids.count <= 8, Set(ids).count == ids.count,
    try managementInt(body["version"]) >= 0 else { throw StaffAPIError.invalid }
  for id in ids { _ = try managementUUID(id) }
}
func validateRecommendationDraft(_ body: [String: Any]) throws {
  for key in nativeRecommendationWeights.keys { guard (-1000...1000).contains(try managementInt(body[key])) else { throw StaffAPIError.invalid } }
  for (key, field) in nativeRecommendationLimits { guard field.1.contains(try managementInt(body[key])) else { throw CatalogError(field.0 + "超出范围") } }
  guard try managementInt(body["preferenceMaxAgeDays"]) >= managementInt(body["preferenceHalfLifeDays"]),
    let config = body["displayConfiguration"] as? [String: Any], JSONSerialization.isValidJSONObject(config) else { throw StaffAPIError.invalid }
  _ = try managementText(body, "explanationTemplate", 2...500)
}
func validateNativeContentBody(_ body: [String: Any], proof: [String: Any], module: NativeManagementModule) throws {
  guard module.isCustomerContent, let op = proof["operation"] as? String, proof["ticketKind"] is NSNull else { throw StaffAPIError.invalid }
  _ = try nativeContentPermission(module, op); _ = try managementText(body, "reason", 2...500)
  let before = proof["before"] as? [String: Any]
  if module == .launchPopup {
    try managementExact(body, ["enabled", "title", "content", "frequency", "productIds", "version", "reason"])
    try validatePopupDraft(body)
    guard proof["targetId"] is NSNull, proof["targetCode"] is NSNull, let before,
      managementJSONEqual(body["version"]!, proof["expected"] ?? NSNull()), managementJSONEqual(before["version"] ?? NSNull(), body["version"]!) else { throw StaffAPIError.invalid }
    try validatePopupDraft(before); return
  }
  if module == .homeContent {
    let create = op == "create", edit = create || op == "update"
    try managementExact(body, ["code", "expectedVersion", "reason"] + (edit ? nativeHomeDraftKeys : []))
    guard let code = body["code"] as? String, nativeHomeCode(code), proof["targetCode"] as? String == code,
      managementJSONEqual(body["expectedVersion"]!, proof["expected"] ?? "missing") else { throw StaffAPIError.invalid }
    if create {
      guard body["expectedVersion"] is NSNull, proof["targetId"] is NSNull, proof["before"] is NSNull else { throw StaffAPIError.invalid }
    } else {
      guard let before, let version = body["expectedVersion"] as? String, managementHash(version), proof["targetId"] as? String == code,
        before["code"] as? String == code, before["nativeVersion"] as? String == version else { throw StaffAPIError.invalid }
      try validateHomeDraft(before)
      guard op == "pause" ? before["status"] as? String == "published" : ["draft", "paused"].contains(before["status"] as? String ?? "") else { throw StaffAPIError.invalid }
    }
    if edit { try validateHomeDraft(body) }; return
  }
  if op == "create" {
    try managementExact(body, ["code", "expectedLatest", "reason"] + nativeRecommendationDraftKeys)
    guard let code = body["code"] as? String, nativeRecommendationCode(code), code == proof["targetCode"] as? String,
      try managementInt(body["expectedLatest"]) >= 0, managementJSONEqual(body["expectedLatest"]!, proof["expected"] ?? NSNull()),
      proof["targetId"] is NSNull, proof["before"] is NSNull else { throw StaffAPIError.invalid }
    try validateRecommendationDraft(body)
  } else {
    guard let version = body["expectedVersion"] as? String, managementHash(version), version == proof["expected"] as? String,
      let before, before["nativeVersion"] as? String == version else { throw StaffAPIError.invalid }
    if op == "rollout" {
      try managementExact(body, ["rolloutState", "expectedVersion", "reason"])
      guard nativeRecommendationRollouts[body["rolloutState"] as? String ?? ""] != nil,
        proof["targetId"] is NSNull, proof["targetCode"] is NSNull else { throw StaffAPIError.invalid }
    } else {
      try managementExact(body, ["publicId", "expectedVersion", "reason"] + (op == "publish" ? ["effectiveFrom"] : []))
      let publicId = try managementText(body, "publicId", 8...128)
      guard publicId == proof["targetId"] as? String, before["publicId"] as? String == publicId,
        before["code"] as? String == proof["targetCode"] as? String, try managementInt(before["version"]) > 0 else { throw StaffAPIError.invalid }
      try validateRecommendationDraft(before)
      if op == "approve" || op == "publish" {
        guard before["createdByEmployeeId"] as? String != proof["employeeId"] as? String,
          before["status"] as? String == (op == "approve" ? "draft" : "approved") else { throw StaffAPIError.invalid }
        if op == "publish" {
          guard before["approvedByEmployeeId"] as? String != proof["employeeId"] as? String else { throw StaffAPIError.invalid }
          _ = try managementInstant(managementText(body, "effectiveFrom", 10...64))
        }
      }
    }
  }
}
func validateNativeContentReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let proof = step.nativeManagementProof, let raw = proof["module"] as? String, let module = NativeManagementModule(rawValue: raw),
    let op = proof["operation"] as? String, let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    try managementInt(meta["protocol"]) == 1, (try? managementBool(meta["replayed"])) != nil,
    data["employeeId"] as? String == proof["employeeId"] as? String, data["requestKey"] as? String == step.key,
    let row = data["row"] as? [String: Any] else { throw StaffAPIError.invalid }
  try validateNativeContentBody(body, proof: proof, module: module)
  if module == .launchPopup {
    let version = try managementInt(body["version"])
    guard try managementInt(row["version"]) == (version == 0 ? 2 : version + 1) else { throw StaffAPIError.invalid }
    for key in ["enabled", "title", "content", "frequency", "productIds"] { guard managementJSONEqual(row[key] ?? NSNull(), body[key]!) else { throw StaffAPIError.invalid } }
    return
  }
  guard data["action"] as? String == op, let version = row["nativeVersion"] as? String, managementHash(version) else { throw StaffAPIError.invalid }
  let before = proof["before"] as? [String: Any]
  if module == .homeContent {
    let edit = ["create", "update"].contains(op), expected = edit ? body : before!
    guard row["code"] as? String == body["code"] as? String, row["status"] as? String == (op == "publish" ? "published" : op == "pause" ? "paused" : "draft") else { throw StaffAPIError.invalid }
    for key in nativeHomeDraftKeys where !["validFrom", "validUntil"].contains(key) { guard managementJSONEqual(row[key] ?? "missing", expected[key]!) else { throw StaffAPIError.invalid } }
    for key in ["validFrom", "validUntil"] { guard let actual = row[key] as? String, try nativeContentDate(actual) == nativeContentDate(expected[key] as! String) else { throw StaffAPIError.invalid } }
    let publisher: Any = op == "publish" ? proof["employeeId"]! : op == "pause" ? expected["publishedByEmployeeId"] ?? NSNull() : NSNull()
    guard managementJSONEqual(row["publishedByEmployeeId"] ?? "missing", publisher) else { throw StaffAPIError.invalid }; return
  }
  guard managementJSONEqual(data["accepted"] ?? NSNull(), body) else { throw StaffAPIError.invalid }
  if op == "rollout" {
    guard row["rolloutState"] as? String == body["rolloutState"] as? String, row["reason"] as? String == body["reason"] as? String,
      managementJSONEqual(row["configuration"] ?? NSNull(), before?["configuration"] ?? NSNull()) else { throw StaffAPIError.invalid }; return
  }
  let expected = op == "create" ? body : before!
  for key in nativeRecommendationDraftKeys + ["code"] { guard managementJSONEqual(row[key] ?? "missing", expected[key] ?? NSNull()) else { throw StaffAPIError.invalid } }
  guard row["status"] as? String == (op == "approve" ? "approved" : op == "publish" ? "published" : "draft"),
    let publicId = row["publicId"] as? String, (8...128).contains(publicId.utf16.count) else { throw StaffAPIError.invalid }
  if op == "create" || op == "clone" {
    guard row["createdByEmployeeId"] as? String == proof["employeeId"] as? String, row["draftReason"] as? String == body["reason"] as? String else { throw StaffAPIError.invalid }
    if op == "create" { guard try managementInt(row["version"]) == managementInt(body["expectedLatest"]) + 1 else { throw StaffAPIError.invalid } }
    else { guard publicId != before!["publicId"] as? String, try managementInt(row["version"]) > managementInt(before!["version"]) else { throw StaffAPIError.invalid } }
  } else {
    guard publicId == body["publicId"] as? String, managementJSONEqual(row["version"] ?? NSNull(), before!["version"]!) else { throw StaffAPIError.invalid }
    let actorKey = op == "approve" ? "approvedByEmployeeId" : "publishedByEmployeeId", reasonKey = op == "approve" ? "approvalReason" : "publicationReason"
    guard row[actorKey] as? String == proof["employeeId"] as? String, row[reasonKey] as? String == body["reason"] as? String else { throw StaffAPIError.invalid }
    if op == "publish" { guard let actual = row["effectiveFrom"] as? String, try nativeContentDate(actual) == managementInstant(body["effectiveFrom"] as! String) else { throw StaffAPIError.invalid } }
  }
}
func validNativeContentSelection(command: LiveCommand, board: NativeManagementBoard, actor: StaffIdentity) -> Bool {
  guard let step = command.steps.first, let proof = step.nativeManagementProof, let op = proof["operation"] as? String else { return false }
  let body = step.object
  if board.module == .launchPopup { return managementJSONEqual(board.data["row"] ?? NSNull(), proof["before"] ?? "missing") }
  if board.module == .recommendations {
    if op == "rollout" { return managementJSONEqual(board.data["feature"] ?? NSNull(), proof["before"] ?? "missing") }
    if op == "create" { return managementJSONEqual(board.data["latest"] ?? NSNull(), body["expectedLatest"] ?? "missing") && board.data["code"] as? String == body["code"] as? String }
  }
  if op == "create" { return !board.rows("rows").contains { $0.id == body["code"] as? String } }
  return board.rows("rows").contains { managementJSONEqual($0.object, proof["before"] ?? NSNull()) }
}
