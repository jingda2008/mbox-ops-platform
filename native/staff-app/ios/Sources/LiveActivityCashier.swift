import Foundation

struct CashierActivity: Decodable, Identifiable {
  struct Late: Decodable, Identifiable {
    let publicId, currency: String
    let amountMinor, remainingRefundableMinor: Int
    let refundStatus: String?
    let payment: LiveCashier.Payment?
    var id: String { publicId }
  }
  let id, publicId, activityPublicId, activityTitle, startsAt, status, paymentStatus,
    currency: String
  let partySize, amountDueMinor, paidAmountMinor: Int
  let payment: LiveCashier.Payment?
  let lateSuccessPayments: [Late]?
  let recollectionAuthorization: LiveCashier.Recollection?
  var refunded: Bool { status == "refunded" || paymentStatus == "refunded" }
  var due: Int { refunded ? paidAmountMinor : amountDueMinor }
  var late: [Late] { lateSuccessPayments ?? [] }
  var onlinePending: Bool {
    payment.map {
      ["postar", "wechat"].contains($0.provider) && ["created", "pending"].contains($0.status)
    } ?? false
  }
  var canCollect: Bool {
    due > 0 && !onlinePending && late.isEmpty
      && (payment?.refunds.allSatisfy {
        ["failed", "rejected", "cancelled"].contains($0.status)
          || (refunded && $0.status == "succeeded")
      } ?? true)
      && (refunded
        ? recollectionAuthorization.flatMap { StaffIdentity.date($0.expiresAt) }.map { $0 > Date() }
          == true : status == "payment_pending" && paymentStatus == "pending")
  }
}
extension LiveCashier {
  func activityCommand(
    actor: StaffIdentity, registrationID: String, action: String, provider: String = "cash",
    reference: String = "", terminal: String = "", externalMethod: String = "bank_transfer",
    reason: String = "", paymentPublicID: String = "", confirmed: Bool = false
  ) throws -> LiveCommand {
    guard actor.allows("community.activity.cashier"), actions["canUseActivityCashier"] == true,
      actions["supportsGuardedActivityCashier"] == true,
      let r = activityRegistrations.first(where: { $0.id == registrationID }), r.currency == "CNY"
    else { throw CatalogError("活动收银权限或原报名已变化，请刷新") }
    let id = UUID().uuidString.lowercased()
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    let ref = reference.trimmingCharacters(in: .whitespacesAndNewlines)
    let term = terminal.trimmingCharacters(in: .whitespacesAndNewlines)
    var body: [String: Any] = [:]
    var amount = r.due
    let permission: String
    let title: String
    let path: String
    var proof: [String: Any] = [
      "activity": action, "registrationId": r.id, "registrationPublicId": r.publicId,
      "actorId": actor.employee.id,
    ]
    switch action {
    case "collect":
      let methods = [
        "cash": ("cash", "payment.manual.cash.record", "canRecordManualCash"),
        "physical_pos": ("card", "payment.manual.pos.record", "canRecordManualPos"),
        "external_manual": ("manual", "payment.manual.external.record", "canRecordManualExternal"),
      ]
      guard let method = methods[provider], actions[method.2] == true, r.canCollect, confirmed
      else { throw CatalogError("须核对已实际收款；旧款未退、渠道未知或授权过期不能另收") }
      permission = method.1
      guard provider == "cash" || (3...256).contains(ref.utf16.count),
        provider != "physical_pos" || (2...128).contains(term.utf16.count)
      else { throw CatalogError("请填写可核对的原收款凭证和POS终端") }
      guard
        provider != "external_manual"
          || ([
            "bank_transfer", "mobile_wallet", "stored_value_voucher", "corporate_account", "other",
          ].contains(externalMethod) && (2...500).contains(note.utf16.count))
      else { throw CatalogError("请填写实际收款方式及2—500字说明") }
      body = [
        "publicId": "APP-ACT-" + id, "provider": provider, "method": method.0,
        "expectedAmountMinor": amount,
      ]
      if provider != "cash" { body["receiptReference"] = ref }
      if provider == "physical_pos" { body["terminalId"] = term }
      if provider == "external_manual" {
        body["externalMethodCode"] = externalMethod
        body["collectionNote"] = note
      }
      path = "/api/activity-registrations/\(LiveCommand.pathPart(r.publicId))/manual-collections"
      title = "登记活动款已实际收到"
    case "recollect":
      permission = "payment.recollect.authorize"
      guard actions["canAuthorizeRecollection"] == true, r.refunded, r.due > 0, r.late.isEmpty,
        r.recollectionAuthorization == nil, (4...500).contains(note.utf16.count)
      else { throw CatalogError("请核对已退款报名、迟到旧款及4—500字重新收款原因") }
      body = ["reason": note]
      path =
        "/api/activity-registrations/\(LiveCommand.pathPart(r.publicId))/recollection-authorizations"
      title = "授权活动再次收款"
    case "refund":
      permission = "refund.request"
      guard actions["canRequestRefund"] == true, (2...1000).contains(note.utf16.count) else {
        throw CatalogError("请核对退款权限并填写2—1000字原因")
      }
      let publicID: String
      if paymentPublicID.isEmpty {
        guard let payment = r.payment,
          ["succeeded", "partially_refunded"].contains(payment.status),
          payment.remainingRefundableMinor > 0,
          payment.refunds.allSatisfy({ ["failed", "rejected", "cancelled"].contains($0.status) })
        else { throw CatalogError("原款不可重复申请退款，请先处理在途退款") }
        publicID = payment.publicId
        amount = payment.remainingRefundableMinor
        proof["paymentId"] = payment.id
      } else {
        guard let late = r.late.first(where: { $0.publicId == paymentPublicID }),
          late.currency == "CNY", late.remainingRefundableMinor > 0,
          late.refundStatus == nil
            || ["failed", "rejected", "cancelled"].contains(late.refundStatus!)
        else { throw CatalogError("仅对已确认迟到到账且无在途退款的旧款申请") }
        publicID = late.publicId
        amount = late.remainingRefundableMinor
      }
      // Freeze original payment even for the current cycle, so recovery never targets a replacement.
      body = ["expectedPaymentPublicId": publicID, "reason": note]
      proof["paymentPublicId"] = publicID
      path =
        "/api/staff/community-activity-registrations/\(LiveCommand.pathPart(r.publicId))/refunds"
      title = "申请活动原款全额退回"
    default: throw CatalogError("不支持的活动操作")
    }
    guard actor.allows(permission), amount > 0 else { throw CatalogError("当前权限或金额已变化") }
    proof["amountMinor"] = amount
    proof["confirmation"] =
      "\(r.activityTitle) · \(r.partySize)人\n报名 \(r.publicId)\n\(title)：\(money(amount))\n凭证：\(ref)\n说明：\(note)\n活动与桌台订单分别记账；退款需另一员工复核。重新收款仍须通过名额及库存校验。"
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-activity-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var activityProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["activity"] is String
    else { return nil }
    return p
  }
}
func validateActivityReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.activityProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let d = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    let id = d["id"] as? String, !id.isEmpty, d["amountMinor"] as? Int == p["amountMinor"] as? Int,
    d["currency"] as? String == "CNY"
  else { throw StaffAPIError.invalid }
  switch p["activity"] as? String {
  case "collect":
    guard d["publicId"] as? String == step.object["publicId"] as? String,
      d["activityRegistrationId"] as? String == p["registrationId"] as? String,
      d["payableKind"] as? String == "activity_registration", d["status"] as? String == "succeeded",
      d["provider"] as? String == step.object["provider"] as? String,
      d["method"] as? String == step.object["method"] as? String,
      let snapshot = d["providerSnapshot"] as? [String: Any],
      snapshot["collectedByEmployeeId"] as? String == p["actorId"] as? String
    else { throw StaffAPIError.invalid }
    for key in ["receiptReference", "terminalId", "externalMethodCode", "collectionNote"]
    where step.object[key] != nil {
      guard snapshot[key] as? String == step.object[key] as? String else {
        throw StaffAPIError.invalid
      }
    }
  case "recollect":
    guard d["activityRegistrationId"] as? String == p["registrationId"] as? String,
      d["authorizedByEmployeeId"] as? String == p["actorId"] as? String,
      d["reason"] as? String == step.object["reason"] as? String,
      let expiry = d["expiresAt"] as? String, StaffIdentity.date(expiry) != nil
    else { throw StaffAPIError.invalid }
  case "refund":
    guard d["status"] as? String == "requested", let payment = d["paymentId"] as? String,
      !payment.isEmpty, p["paymentId"] == nil || payment == p["paymentId"] as? String,
      d["reason"] as? String == step.object["reason"] as? String,
      d["activityRegistrationId"] as? String == p["registrationId"] as? String
    else { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
}
