import Foundation

struct LivePaymentOrder: Decodable, Identifiable {
  let id: String
  let publicId: String
  let currency: String
  let paymentStatus: String
  let outstandingAmountMinor: Int
  let hasOnlinePaymentInProgress: Bool
  let unresolvedOnlinePaymentId: String?
  var selectable: Bool {
    currency == "CNY" && outstandingAmountMinor > 0 && !hasOnlinePaymentInProgress
      && unresolvedOnlinePaymentId == nil
  }
  static let permissions = [
    "payment.initiate.staff", "payment.manual.cash.record", "payment.manual.pos.record",
    "payment.manual.external.record",
  ]
}
extension LiveCommand {
  static func manualCollection(
    orders: [LivePaymentOrder], actor: StaffIdentity, amount: Int,
    provider: String, reference: String, terminal: String, method: String, note: String,
    session: String? = nil
  ) throws -> Self {
    let providers = [
      "cash": "payment.manual.cash.record", "physical_pos": "payment.manual.pos.record",
      "external_manual": "payment.manual.external.record",
    ]
    guard let permission = providers[provider], actor.allows(permission), !orders.isEmpty,
      orders.count <= 50, Set(orders.map(\.id)).count == orders.count,
      orders.allSatisfy(\.selectable),
      amount > 0, amount <= orders.reduce(0, { $0 + $1.outstandingAmountMinor })
    else { throw CatalogError("订单、权限或收款金额已变化；原款未确认时不能再次收款") }
    let id = UUID().uuidString.lowercased()
    var body: [String: Any] = [
      "orderId": orders[0].id, "amountMinor": amount, "publicId": "APP-PAY-" + id,
      "provider": provider,
      "method": provider == "cash" ? "cash" : provider == "physical_pos" ? "card" : "manual",
    ]
    if orders.count > 1 { body["orderIds"] = orders.map(\.id) }
    let ref = reference.trimmingCharacters(in: .whitespacesAndNewlines)
    if provider == "cash" {
      body["receiptReference"] = "CASH-APP-" + id
    } else {
      guard (3...256).contains(ref.utf16.count) else { throw CatalogError("请填写原收款凭证号（3—256字）") }
      body["receiptReference"] = ref
    }
    let terminal = terminal.trimmingCharacters(in: .whitespacesAndNewlines)
    if !terminal.isEmpty {
      guard terminal.utf16.count <= 128 else { throw CatalogError("终端编号过长") }
      body["terminalId"] = terminal
    }
    if provider == "external_manual" {
      guard
        ["bank_transfer", "mobile_wallet", "stored_value_voucher", "corporate_account", "other"]
          .contains(method),
        (2...500).contains(note.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw CatalogError("请选择外部收款方式并填写说明") }
      body["externalMethodCode"] = method
      body["collectionNote"] = note.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return Self(
      id: id, employeeID: actor.employee.id,
      title: "登记已收款 " + money(amount) + " · \(orders.count)笔订单", permission: permission,
      steps: [
        Step(
          path: "/api/payments/manual",
          body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-payment-" + id,
          recoveryBody: try session.map {
            try JSONSerialization.data(withJSONObject: ["collectionSession": $0])
          })
      ])
  }
}

extension LiveCommand.Step {
  var collectionSession: String? {
    guard path == "/api/payments/manual", let recoveryBody,
      let proof = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      let session = proof["collectionSession"] as? String, !session.isEmpty
    else { return nil }
    return session
  }
}
