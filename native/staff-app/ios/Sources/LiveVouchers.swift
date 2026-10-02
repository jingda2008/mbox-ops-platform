import Foundation

struct VoucherPlatform: Decodable, Identifiable {
  let code, label, mode: String
  let enabled: Bool
  var id: String { code }
  var usable: Bool { enabled && mode == "production" }
}
struct VoucherPreview: Decodable {
  let platform, platformLabel, campaignName, voucherCodeMasked, currency, statusLabel, expiresAt,
    prepareHandle: String
  let faceValueMinor, settlementAmountMinor, quantity: Int
}
struct VoucherOperation: Decodable, Identifiable {
  struct Review: Decodable {
    let id, outcome, certificateId, verifyId, evidenceReference, reason, employeeId: String
    let approvedBy: String?
  }
  let id, platform, voucherCodeMasked, campaignName, currency, status, businessDate, publicId,
    actorEmployeeId, createdAt: String
  let faceValueMinor, settlementAmountMinor: Int
  let orderId, tableSessionId: String?
  let review: Review?
  var terminal: Bool { ["recorded", "not_consumed"].contains(status) }
}
struct VoucherOperationsPage: Decodable {
  struct Meta: Decodable {
    let protocolVersion: Int
    enum CodingKeys: String, CodingKey { case protocolVersion = "protocol" }
  }
  let data: [VoucherOperation]
  let meta: Meta
}
func voucherRedeem(
  actor: StaffIdentity, preview: VoucherPreview, platform: VoucherPlatform, code: String,
  orderID: String? = nil, sessionID: String? = nil, confirmed: Bool
) throws -> LiveCommand {
  guard actor.allows("commercial.voucher.redeem"), platform.usable,
    platform.code == preview.platform, confirmed, (4...256).contains(code.utf16.count),
    preview.currency == "CNY", preview.faceValueMinor >= 0, preview.settlementAmountMinor >= 0,
    preview.quantity > 0, (orderID == nil) == (sessionID == nil)
  else { throw CatalogError("请核对正式平台、原券、原订单桌次及实际核销确认") }
  let id = UUID().uuidString.lowercased()
  var body: [String: Any] = [
    "publicId": "APP-VOUCHER-" + id, "platform": preview.platform, "voucherCode": code,
    "prepareHandle": preview.prepareHandle,
  ]
  if let orderID, let sessionID {
    body["orderId"] = orderID
    body["tableSessionId"] = sessionID
  }
  let p: [String: Any] = [
    "voucher": "redeem", "voucherSecretKey": "voucher-" + id, "platform": preview.platform,
    "publicId": "APP-VOUCHER-" + id, "actorId": actor.employee.id,
    "confirmation":
      "\(preview.platformLabel) · \(preview.campaignName)\n券码 \(preview.voucherCodeMasked) · \(preview.quantity)份\n面额 \(money(preview.faceValueMinor)) · 平台结算额 \(money(preview.settlementAmountMinor))\n\(orderID == nil ? "不关联桌单" : "关联原订单 " + orderID!)\n确认平台消费券；登记核销不等于收到平台结算款，也不自动抵减桌单应收。未知结果不再次核销。",
  ]
  return try voucherCommand(
    actor: actor, id: id, permission: "commercial.voucher.redeem", title: "确认原券核销",
    path: "/api/commercial-ops/vouchers/operations/redeem", body: body, proof: p)
}
func voucherFollowup(
  actor: StaffIdentity, row: VoucherOperation, action: String, outcome: String = "consumed",
  certificate: String = "", verify: String = "", evidence: String = "", reason: String = "",
  confirmed: Bool = false
) throws -> LiveCommand {
  guard actor.allows("commercial.voucher.redeem") else { throw CatalogError("当前岗位无核销恢复权限") }
  let permission =
    ["approve", "reject"].contains(action) ? "reconciliation.manage" : "commercial.voucher.redeem"
  var body: [String: Any] = [:]
  switch action {
  case "recover": guard !row.terminal else { throw CatalogError("该事项已有终态，请刷新核对") }
  case "review":
    guard ["dispatching", "unknown"].contains(row.status), row.review == nil,
      ["consumed", "not_consumed"].contains(outcome), confirmed,
      (4...500).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      (4...500).contains(evidence.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      certificate.utf16.count <= 256, verify.utf16.count <= 256,
      outcome != "consumed"
        || (!certificate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && !verify.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    else { throw CatalogError("请按平台原凭证提供核销结果、查询依据及实际原因，不能猜测结果") }
    body = [
      "outcome": outcome, "certificateId": certificate, "verifyId": verify,
      "evidenceReference": evidence, "reason": reason,
    ]
  case "approve", "reject":
    guard let review = row.review, review.employeeId != actor.employee.id, review.approvedBy == nil,
      confirmed, actor.allows(permission), ["dispatching", "unknown"].contains(row.status)
    else { throw CatalogError("必须由另一名财务复核人员独立核对平台凭证") }
    body["reviewId"] = review.id
    if action == "reject" {
      guard (4...500).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw CatalogError("请填写实际驳回原因") }
      body["reason"] = reason
    }
  default: throw CatalogError("不支持的核销操作")
  }
  let id = UUID().uuidString.lowercased()
  let title = [
    "recover": "恢复原核销记录", "review": "提交平台凭证待另一人复核", "approve": "确认已独立核对平台结果",
    "reject": "驳回原证据并重新核对",
  ][action]!
  let detail =
    row.review.map {
      "\($0.outcome == "consumed" ? "平台已核销" : "已证实未核销")\n证书 \($0.certificateId)\n核销号 \($0.verifyId)\n依据 \($0.evidenceReference)\n\($0.reason)"
    }
    ?? "\(outcome == "consumed" ? "平台已核销" : "已证实未核销")\n证书 \(certificate)\n核销号 \(verify)\n依据 \(evidence)\n\(reason)"
  return try voucherCommand(
    actor: actor, id: id, permission: permission, title: title,
    path: "/api/commercial-ops/vouchers/operations/\(LiveCommand.pathPart(row.id))/\(action)",
    body: body,
    proof: [
      "voucher": action, "operationId": row.id, "platform": row.platform, "publicId": row.publicId,
      "confirmation":
        "\(row.campaignName) · \(row.voucherCodeMasked)\n\(title)\n\(action == "recover" ? "只恢复持久化原记录，不再次消耗券。" : detail + (action=="reject" ? "\n驳回原因："+reason:""))\n人工双人复核会单独留痕，不作为支付平台自动回执或平台结算到账。",
    ])
}
private func voucherCommand(
  actor: StaffIdentity, id: String, permission: String, title: String, path: String,
  body: [String: Any], proof: [String: Any]
) throws -> LiveCommand {
  LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: permission,
    steps: [
      .init(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-voucher-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var voucherProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["voucher"] is String
    else { return nil }
    return p
  }
}
func secureVoucherCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws
  -> LiveCommand
{
  guard let step = command.steps.first, let p = step.voucherProof,
    p["voucher"] as? String == "redeem", let key = p["voucherSecretKey"] as? String
  else { return command }
  var body = step.object
  guard let code = body.removeValue(forKey: "voucherCode") as? String,
    let handle = body.removeValue(forKey: "prepareHandle") as? String
  else { throw CatalogError("原核销凭据缺失，不能发送") }
  try store(
    key,
    String(
      data: JSONSerialization.data(
        withJSONObject: ["voucherCode": code, "prepareHandle": handle], options: .sortedKeys),
      encoding: .utf8)!)
  return LiveCommand(
    id: command.id, employeeID: command.employeeID, title: command.title,
    permission: command.permission,
    steps: [
      .init(
        path: step.path,
        body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: step.keyHeader, key: step.key, recoveryBody: step.recoveryBody)
    ])
}
func voucherRequestBody(_ step: LiveCommand.Step, secret: (String) throws -> String) throws
  -> [String: Any]
{
  var body = step.object
  if let key = step.voucherProof?["voucherSecretKey"] as? String {
    let text = try secret(key)
    guard let d = text.data(using: .utf8),
      let secrets = try JSONSerialization.jsonObject(with: d) as? [String: String],
      let code = secrets["voucherCode"], let handle = secrets["prepareHandle"]
    else { throw CatalogError("原核销凭据不可读，请核对原事项，不能重新核销") }
    body["voucherCode"] = code
    body["prepareHandle"] = handle
  }
  return body
}
func validateVoucherReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.voucherProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], meta["protocol"] as? Int == 1,
    let d = root["data"] as? [String: Any], let id = d["id"] as? String, !id.isEmpty,
    d["platform"] as? String == p["platform"] as? String,
    d["publicId"] as? String == p["publicId"] as? String, d["currency"] as? String == "CNY",
    let status = d["status"] as? String,
    ["dispatching", "unknown", "provider_succeeded", "recorded", "not_consumed"].contains(status)
  else { throw StaffAPIError.invalid }
  if p["voucher"] as? String == "redeem" {
    guard d["actorEmployeeId"] as? String == p["actorId"] as? String else {
      throw StaffAPIError.invalid
    }
  } else {
    guard id == p["operationId"] as? String else { throw StaffAPIError.invalid }
  }
  if status == "recorded" {
    guard let r = d["result"] as? [String: Any],
      r["publicId"] as? String == p["publicId"] as? String, r["currency"] as? String == "CNY",
      r["isSettled"] as? Bool == false
    else { throw StaffAPIError.invalid }
  }
}

struct VoucherHistoryRow: Decodable, Identifiable {
  let id, publicId, platform, campaignName, voucherCodeMasked, currency, redeemedBusinessDate,
    redeemedAt: String
  let faceValueMinor, settlementAmountMinor: Int
  let isSettled: Bool
}

@MainActor func performVoucherStep(
  _ step: LiveCommand.Step, read: (String) async throws -> Data,
  send: ([String: Any]) async throws -> Data, secret: (String) throws -> String
) async throws {
  if let p = step.voucherProof, p["voucher"] as? String == "redeem",
    let original = p["publicId"] as? String
  {
    let bytes = try await read(
      "/api/commercial-ops/vouchers/operations/by-public-id/" + LiveCommand.pathPart(original))
    guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let meta = root["meta"] as? [String: Any], meta["protocol"] as? Int == 1,
      root.keys.contains("data")
    else { throw StaffAPIError.invalid }
    if !(root["data"] is NSNull) {
      try validateVoucherReply(bytes, step: step)
      return
    }
  }
  let bytes = try await send(voucherRequestBody(step, secret: secret))
  try validateVoucherReply(bytes, step: step)
}
