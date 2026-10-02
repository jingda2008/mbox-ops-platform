import Foundation

struct OnlineAccess: Decodable {
  let employeeId: String
  let canInitiatePayment: Bool
  let onlinePaymentProvider: String?
}
struct OnlineReceipt: Codable {
  let commandID: String
  let employeeID: String
  let tableSessionID: String
  let kind: String
  let response: Data
  var object: [String: Any] {
    ((try? JSONSerialization.jsonObject(with: response)) as? [String: Any])?["data"]
      as? [String: Any] ?? [:]
  }
  var paymentID: String { object["id"] as? String ?? "" }
  var publicID: String { object["publicId"] as? String ?? "" }
  var amount: Int? { object["amountMinor"] as? Int }
  var action: [String: Any]? { object["providerAction"] as? [String: Any] }
  func qr(now: Date = Date(), status: String) -> String? {
    guard kind == "init", status == "pending", let action, action["status"] as? String == "pending",
      action["presentation"] as? String == "qr", let expires = action["expiresAt"] as? String,
      let date = StaffIdentity.date(expires), date > now,
      let payload = action["payload"] as? [String: Any], let text = payload["qrCodeUrl"] as? String,
      !text.isEmpty, text.utf8.count <= 4096
    else { return nil }
    return text
  }
}
extension LiveCommand.Step {
  var onlineProof: [String: Any]? {
    guard let recoveryBody,
      let value = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      value["online"] is String
    else { return nil }
    return value
  }
}
func onlinePayment(
  actor: StaffIdentity, access: OnlineAccess, orders: [LivePaymentOrder], session: String,
  amount: Int, method: String, code: String = ""
) throws -> LiveCommand {
  let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
  guard actor.allows("payment.initiate.staff"), access.employeeId == actor.employee.id,
    access.canInitiatePayment,
    access.onlinePaymentProvider == "postar", !session.isEmpty, !orders.isEmpty, orders.count <= 50,
    Set(orders.map(\.id)).count == orders.count, orders.allSatisfy(\.selectable), amount > 0,
    amount <= orders.reduce(0, { $0 + $1.outstandingAmountMinor }),
    ["native_qr", "auth_code"].contains(method),
    method != "auth_code" || code.range(of: "^[0-9]{16,32}$", options: .regularExpression) != nil
  else { throw CatalogError("请核对线上支付开关、岗位、原单应收和付款码；原款未知不能重复收款") }
  let id = UUID().uuidString.lowercased()
  var body: [String: Any] = [
    "orderId": orders[0].id, "orderIds": orders.map(\.id), "amountMinor": amount,
    "publicId": "APP-ONLINE-" + id, "provider": "postar", "method": method,
  ]
  var proof: [String: Any] = [
    "online": "init", "tableSessionId": session, "employeeId": actor.employee.id,
    "confirmation":
      "本次收款 \(money(amount))\n原订单：\(orders.map(\.publicId).joined(separator: "、"))\n\(method == "auth_code" ? "扫描付款码将请求扣款，请确认顾客同意。" : "展示本单付款二维码，由顾客付款。")\n只有服务器确认到账才算收款，超时不能换号重收。",
  ]
  if method == "auth_code" {
    body["customerAuthCode"] = code
    proof["authCodeKey"] = id
  }
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: "线上收款 " + money(amount),
    permission: "payment.initiate.staff",
    steps: [
      .init(
        path: "/api/payments",
        body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-online-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
func onlineRelease(
  actor: StaffIdentity, orders: [LivePaymentOrder], paymentID: String, session: String,
  reason: String
) throws -> LiveCommand {
  let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  guard actor.allows("payment.initiate.staff"),
    orders.contains(where: { $0.unresolvedOnlinePaymentId == paymentID }),
    (4...500).contains(note.utf16.count)
  else { throw CatalogError("请刷新原付款并填写4—500字重收原因") }
  let id = UUID().uuidString.lowercased()
  let proof = [
    "online": "release", "tableSessionId": session, "paymentId": paymentID,
    "confirmation": "原付款仍可能后到。本操作只允许另行收款，不代表旧款失败或通道已关闭。请确认顾客知晓可能重复付款；后到款需要财务核对退款。\n原因：\(note)",
  ]
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: "保留旧款待核对，允许重收",
    permission: "payment.initiate.staff",
    steps: [
      .init(
        path: "/api/payments/\(LiveCommand.pathPart(paymentID))/retry-release",
        body: try JSONSerialization.data(withJSONObject: ["reason": note], options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-release-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
func secureOnlineCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws
  -> LiveCommand
{
  let steps = try command.steps.map { step in
    guard let proof = step.onlineProof, let key = proof["authCodeKey"] as? String,
      let code = step.object["customerAuthCode"] as? String
    else { return step }
    try store(key, code)
    var body = step.object
    body.removeValue(forKey: "customerAuthCode")
    return LiveCommand.Step(
      path: step.path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
      keyHeader: step.keyHeader, key: step.key, recoveryBody: step.recoveryBody)
  }
  return LiveCommand(
    id: command.id, employeeID: command.employeeID, title: command.title,
    permission: command.permission, steps: steps, completedSteps: command.completedSteps,
    rejected: command.rejected)
}
func onlineRequestBody(_ step: LiveCommand.Step, secret: (String) throws -> String) throws
  -> [String: Any]
{
  var body = step.object
  if let key = step.onlineProof?["authCodeKey"] as? String {
    body["customerAuthCode"] = try secret(key)
  }
  return body
}
func validateOnlineReply(_ bytes: Data, step: LiveCommand.Step) throws {
  struct Meta: Decodable {
    struct Value: Decodable { let replayed: Bool }
    let meta: Value
  }
  _ = try JSONDecoder().decode(Meta.self, from: bytes)
  guard let proof = step.onlineProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any],
    let id = data["id"] as? String, !id.isEmpty, let publicID = data["publicId"] as? String,
    !publicID.isEmpty,
    let status = data["status"] as? String,
    ["created", "pending", "succeeded", "failed", "closed", "partially_refunded", "refunded"]
      .contains(status)
  else { throw StaffAPIError.invalid }
  if proof["online"] as? String == "release" {
    guard id == proof["paymentId"] as? String,
      step.path == "/api/payments/\(LiveCommand.pathPart(id))/retry-release",
      data["retryReleaseReason"] as? String == step.object["reason"] as? String,
      let at = data["retryReleasedAt"] as? String, assignmentDate(at) != nil
    else { throw StaffAPIError.invalid }
    return
  }
  guard proof["online"] as? String == "init", step.path == "/api/payments",
    publicID == step.object["publicId"] as? String
      || validOnlineBinding(root, step: step, id: id, publicID: publicID),
    data["currency"] as? String == "CNY", data["provider"] as? String == "postar",
    data["method"] as? String == step.object["method"] as? String,
    data["amountMinor"] as? Int == step.object["amountMinor"] as? Int,
    let action = data["providerAction"] as? [String: Any], action["paymentId"] as? String == id,
    action["paymentPublicId"] as? String == publicID,
    let state = action["status"] as? String,
    ["pending", "unknown", "failed", "resolved"].contains(state),
    action["presentation"] as? String
      == (step.object["method"] as? String == "native_qr" ? "qr" : "barcode"),
    let expiry = action["expiresAt"] as? String, StaffIdentity.date(expiry) != nil
  else { throw StaffAPIError.invalid }
}

private func validOnlineBinding(
  _ root: [String: Any], step: LiveCommand.Step, id: String, publicID: String
) -> Bool {
  guard let meta = root["meta"] as? [String: Any], let b = meta["requestBinding"] as? [String: Any],
    b["protocol"] as? Int == 1, b["idempotencyKey"] as? String == step.key,
    b["requestedPublicId"] as? String == step.object["publicId"] as? String,
    b["paymentId"] as? String == id, b["paymentPublicId"] as? String == publicID,
    b["amountMinor"] as? Int == step.object["amountMinor"] as? Int,
    b["provider"] as? String == step.object["provider"] as? String,
    b["method"] as? String == step.object["method"] as? String,
    let actor = step.onlineProof?["employeeId"] as? String, b["employeeId"] as? String == actor,
    let orders = b["orderIds"] as? [String], let expected = step.object["orderIds"] as? [String],
    orders.count == expected.count, Set(orders) == Set(expected)
  else { return false }
  return true
}
