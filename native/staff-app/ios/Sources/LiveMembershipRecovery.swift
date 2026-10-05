import Foundation
import CryptoKit
let membershipRecoveryRoot = "/api/staff/native-membership-recovery"
let membershipRecoveryPermissions = ["customer.membership.recovery.verify", "customer.membership.merge.approve"]
let membershipRecoveryStatuses = ["manual_review": "待核验候选", "pending_review": "待独立复核", "approved": "已批准待核对", "executed": "已合并并保留原历史", "rejected": "已驳回"]
let membershipRecoveryActions = ["contact": "登记人工核验的历史联系方式", "select": "选择已核验的会员候选", "approve": "独立复核并合并会员", "reject": "驳回会员找回申请"]
func recoveryReference(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{3,128}$", options: .regularExpression) != nil }
func recoveryVersion(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
func recoveryPermission(_ action: String) throws -> String { guard membershipRecoveryActions[action] != nil else { throw StaffAPIError.invalid }; return membershipRecoveryPermissions[["contact", "select"].contains(action) ? 0 : 1] }
struct RecoveryRecord: Identifiable, Equatable {
  let data: Data
  init(_ object: [String: Any]) throws { data = try membershipData(object) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("casePublicId").isEmpty ? text("candidatePublicId") : text("casePublicId") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
}
struct MembershipRecoveryBoard {
  let employeeID: String
  let enabled, history: Bool
  let rows: [RecoveryRecord]
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity, history: Bool) throws {
    let d = try walletEnvelope(data)
    guard membershipRecoveryPermissions.contains(where: actor.allows), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, try walletBoolean(d["history"]) == history, let items = d["rows"] as? [[String: Any]], items.count <= 50 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.history = history; enabled = try walletBoolean(d["durableCommands"]); rows = try items.map(RecoveryRecord.init)
    guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows {
      guard recoveryReference(row.id), recoveryVersion(row.text("nativeVersion")), membershipRecoveryStatuses[row.text("status")] != nil,
        history || ["manual_review", "pending_review"].contains(row.text("status")), row.text("maskedPhone").contains("*"),
        row.text("maskedMemberNo").isEmpty || row.text("maskedMemberNo").contains("*"), assignmentDate(row.text("createdAt")) != nil, assignmentDate(row.text("updatedAt")) != nil else { throw StaffAPIError.invalid }
      _ = try row.integer("candidateCount")
      if ["pending_review", "approved", "executed"].contains(row.text("status")) { guard recoveryReference(row.text("selectedCandidatePublicId")), UUID(uuidString: row.text("selectedByEmployeeId")) != nil else { throw StaffAPIError.invalid } }
    }
    nextCursor = try recoveryNext(d["next"])
  }
  static func query(history: Bool = false, cursor: String = "") throws -> String {
    guard cursor.isEmpty || recoveryReference(cursor) else { throw StaffAPIError.invalid }
    var q = [URLQueryItem(name: "history", value: String(history))]; if !cursor.isEmpty { q.append(URLQueryItem(name: "cursor", value: cursor)) }
    var parts = URLComponents(); parts.queryItems = q; return membershipRecoveryRoot + "?" + (parts.percentEncodedQuery ?? "")
  }
  func command(actor: StaffIdentity, action: String, row: RecoveryRecord? = nil, candidate: RecoveryRecord? = nil,
    fields: [String: String], verified: Bool, now: Date = Date()) throws -> LiveCommand {
    let permission = try recoveryPermission(action)
    guard enabled, actor.employee.id == employeeID, actor.allows(permission), verified,
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("请先核验本人及原始凭据，并重新确认当前权限") }
    let reason = (fields["reason"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...500).contains(reason.utf16.count) else { throw CatalogError("请填写2—500字实际核验或复核依据") }
    var body: [String: Any] = ["reason": reason], before: [String: Any] = [:], details: String
    if action == "contact" {
      let member = (fields["memberNo"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines), phone = (fields["phone"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard (1...64).contains(member.utf16.count), phone.range(of: "^\\+[1-9][0-9]{7,14}$", options: .regularExpression) != nil else { throw CatalogError("请填真实会员号和含国家代码的已核验手机号，例如+86") }
      body["memberNo"] = member; body["phone"] = phone
      details = "会员 " + member + " · 手机尾号 " + phone.suffix(4) + "\n必须核对本人、原会员凭据和手机号，不授予营销许可。"
    } else {
      guard let row, rows.contains(row) else { throw CatalogError("原找回申请已变化，请重新读取") }
      let allowed = action == "select" ? ["manual_review"] : action == "approve" ? ["pending_review"] : ["manual_review", "pending_review"]
      guard allowed.contains(row.text("status")) else { throw CatalogError("原申请状态不能进行此操作") }
      if action == "approve" { guard UUID(uuidString: row.text("selectedByEmployeeId")) != nil, row.text("selectedByEmployeeId") != employeeID else { throw CatalogError("核验人与合并复核人必须不同") } }
      body["casePublicId"] = row.id; body["expectedVersion"] = row.text("nativeVersion")
      for key in ["casePublicId", "nativeVersion", "status", "selectedCandidatePublicId", "selectedByEmployeeId"] { before[key] = row.object[key] ?? NSNull() }
      if action == "select" {
        guard let candidate, recoveryReference(candidate.id), candidate.text("casePublicId").isEmpty,
          candidate.text("caseVersion") == row.text("nativeVersion"), candidate.text("sourceCasePublicId") == row.id else { throw CatalogError("请重新查询并选择此申请的原会员候选") }
        body["candidatePublicId"] = candidate.id
      }
      details = "申请 " + row.id + "\n" + (candidate?.text("maskedMemberNo") ?? row.text("maskedMemberNo")) + " · " + (candidate?.text("maskedPhone") ?? row.text("maskedPhone"))
      details += action == "approve" ? "\n合并保留来源账户、积分流水和权益历史，不重复加积分或发券；不授予营销许可。" : "\n原申请和核验记录保留。"
    }
    let title = membershipRecoveryActions[action]!, id = UUID().uuidString.lowercased()
    let proof: [String: Any] = ["action": action, "employeeId": employeeID, "history": history, "before": before, "confirmation": title + "\n" + details + "\n依据：" + reason]
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: membershipRecoveryRoot + "/" + action, body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["membershipRecovery": proof]))])
  }
}
func recoveryNext(_ value: Any?) throws -> String? { if value is NSNull { return nil }; guard let text = value as? String, recoveryReference(text) else { throw StaffAPIError.invalid }; return text }
struct MembershipRecoveryCandidates {
  let employeeID: String
  let rows: [RecoveryRecord]
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity, row: RecoveryRecord) throws {
    let d = try walletEnvelope(data)
    guard actor.allows(membershipRecoveryPermissions[0]), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, try walletBoolean(d["durableCommands"]), d["casePublicId"] as? String == row.id,
      d["caseVersion"] as? String == row.text("nativeVersion"), row.text("status") == "manual_review", let items = d["rows"] as? [[String: Any]], items.count <= 50 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id
    rows = try items.map { input in
      guard let id = input["candidatePublicId"] as? String, recoveryReference(id), (input["maskedPhone"] as? String)?.contains("*") == true,
        (input["maskedMemberNo"] as? String)?.contains("*") == true, let day = input["joinedDate"] as? String,
        day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil, assignmentDate(day + "T00:00:00Z") != nil else { throw StaffAPIError.invalid }
      var item = input; item["caseVersion"] = row.text("nativeVersion"); item["sourceCasePublicId"] = row.id; return try RecoveryRecord(item)
    }
    guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }; nextCursor = try recoveryNext(d["next"])
  }
  static func query(row: RecoveryRecord, cursor: String = "") throws -> String {
    guard recoveryReference(row.id), recoveryVersion(row.text("nativeVersion")), row.text("status") == "manual_review", cursor.isEmpty || recoveryReference(cursor) else { throw StaffAPIError.invalid }
    var parts = URLComponents(); var q = [URLQueryItem(name: "casePublicId", value: row.id), URLQueryItem(name: "expectedVersion", value: row.text("nativeVersion"))]
    if !cursor.isEmpty { q.append(URLQueryItem(name: "cursor", value: cursor)) }; parts.queryItems = q
    return membershipRecoveryRoot + "/candidates?" + (parts.percentEncodedQuery ?? "")
  }
}
extension LiveCommand.Step {
  var membershipRecoveryProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["membershipRecovery"] as? [String: Any] }
}
private func recoveryCommandContract(_ command: LiveCommand, step: LiveCommand.Step) throws -> [String: Any] {
  guard command.steps.count == 1, command.steps.first == step, UUID(uuidString: command.id) != nil, UUID(uuidString: command.employeeID) != nil,
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    let proof = step.membershipRecoveryProof, proof["employeeId"] as? String == command.employeeID, let action = proof["action"] as? String,
    command.permission == (try recoveryPermission(action)), step.path == membershipRecoveryRoot + "/" + action,
    let before = proof["before"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(proof["history"])
  if action == "contact" { guard before.isEmpty else { throw StaffAPIError.invalid } }
  else { guard recoveryReference(membershipText(before["casePublicId"])), recoveryVersion(membershipText(before["nativeVersion"])), Set(before.keys) == ["casePublicId", "nativeVersion", "status", "selectedCandidatePublicId", "selectedByEmployeeId"] else { throw StaffAPIError.invalid } }
  return proof
}
func secureMembershipRecoveryCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, step.membershipRecoveryProof != nil else { return command }
  var proof = try recoveryCommandContract(command, step: step)
  guard proof["payloadKey"] == nil, command.completedSteps == 0, let text = String(data: step.body, encoding: .utf8), !step.object.isEmpty else { throw CatalogError("请从未决记录恢复原会员找回请求") }
  try recoveryPayload(step.object, proof: proof)
  let key = "membership-recovery-" + command.id
  try store(key, text)
  proof.removeValue(forKey: "confirmation"); proof["payloadKey"] = key; proof["payloadSHA256"] = SHA256.hash(data: step.body).map { String(format: "%02x", $0) }.joined()
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对会员找回原请求", permission: command.permission, steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key, recoveryBody: try membershipData(["membershipRecovery": proof]))], completedSteps: command.completedSteps, rejected: command.rejected)
}
func membershipRecoveryRequestBody(_ command: LiveCommand, step: LiveCommand.Step, read: (String) throws -> String) throws -> [String: Any] {
  let proof = try recoveryCommandContract(command, step: step)
  guard let key = proof["payloadKey"] as? String, key == "membership-recovery-" + command.id, let digest = proof["payloadSHA256"] as? String,
    recoveryVersion(digest), proof["confirmation"] == nil, String(data: step.body, encoding: .utf8) == "{}" else { throw StaffAPIError.invalid }
  let data = Data(try read(key).utf8)
  guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest,
    let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CatalogError("原会员找回安全载荷不一致，未发送") }
  try recoveryPayload(body, proof: proof); return body
}
private func recoveryPayload(_ body: [String: Any], proof: [String: Any]) throws {
  guard let action = proof["action"] as? String, let reason = body["reason"] as? String, reason == reason.trimmingCharacters(in: .whitespacesAndNewlines), (2...500).contains(reason.utf16.count) else { throw StaffAPIError.invalid }
  if action == "contact" {
    guard Set(body.keys) == ["memberNo", "phone", "reason"], let member = body["memberNo"] as? String, (1...64).contains(member.utf16.count), member == member.trimmingCharacters(in: .whitespacesAndNewlines),
      let phone = body["phone"] as? String, phone.range(of: "^\\+[1-9][0-9]{7,14}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
  } else {
    guard let before = proof["before"] as? [String: Any], Set(body.keys) == (action == "select" ? ["casePublicId", "expectedVersion", "candidatePublicId", "reason"] : ["casePublicId", "expectedVersion", "reason"]),
      body["casePublicId"] as? String == before["casePublicId"] as? String, body["expectedVersion"] as? String == before["nativeVersion"] as? String,
      action != "select" || recoveryReference(membershipText(body["candidatePublicId"])) else { throw StaffAPIError.invalid }
  }
}
func validateMembershipRecoveryReply(_ data: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1,
    let d = root["data"] as? [String: Any], let proof = step.membershipRecoveryProof, let action = proof["action"] as? String,
    step.path == membershipRecoveryRoot + "/" + action, d["employeeId"] as? String == proof["employeeId"] as? String, d["requestKey"] as? String == step.key, d["action"] as? String == action,
    let accepted = d["accepted"] as? [String: Any], let raw = d["row"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); try recoveryPayload(body, proof: proof)
  var expected = body; expected.removeValue(forKey: "phone")
  guard membershipEqual(accepted, expected) else { throw StaffAPIError.invalid }
  let row = try RecoveryRecord(raw)
  if action == "contact" {
    guard row.text("memberNo") == body["memberNo"] as? String, row.text("maskedPhone").contains("*"),
      row.text("maskedPhone").hasSuffix(String((body["phone"] as! String).suffix(2))), assignmentDate(row.text("verifiedAt")) != nil,
      raw["phone"] == nil else { throw StaffAPIError.invalid }
  } else {
    guard row.id == body["casePublicId"] as? String, recoveryVersion(row.text("nativeVersion")),
      row.text("status") == ["select": "pending_review", "approve": "executed", "reject": "rejected"][action] else { throw StaffAPIError.invalid }
    if action == "select" { guard row.text("selectedCandidatePublicId") == body["candidatePublicId"] as? String, row.text("selectedByEmployeeId") == proof["employeeId"] as? String else { throw StaffAPIError.invalid } }
    if action == "approve" {
      guard row.text("approvedByEmployeeId") == proof["employeeId"] as? String, let before = proof["before"] as? [String: Any] else { throw StaffAPIError.invalid }
      for key in ["selectedCandidatePublicId", "selectedByEmployeeId"] { guard membershipText(raw[key]) == membershipText(before[key]) else { throw StaffAPIError.invalid } }
    }
  }
}
