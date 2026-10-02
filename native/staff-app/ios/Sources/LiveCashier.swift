import Foundation

let refundPurposes = [
  "return_goods": "退货或取消商品", "price_adjustment": "退差价", "service_compensation": "服务补偿，商品继续供应",
  "duplicate_payment": "重复收款退回",
]
struct LiveCashier: Decodable {
  static let permissions = [
    "reconciliation.view", "reconciliation.manage", "payment.settlement.view",
    "payment.manual.cash.record", "payment.manual.pos.record", "payment.manual.external.record",
    "refund.request", "refund.approve", "refund.execute", "community.activity.cashier",
    "business_day.close",
  ]
  static let actionFlags = [
    "payment.recollect.authorize": "canAuthorizeRecollection",
    "refund.request": "canRequestRefund", "refund.approve": "canApproveRefund",
    "refund.execute": "canExecuteRefund", "reconciliation.view": "canQueryOnlinePayment",
  ]
  struct Item: Decodable, Identifiable {
    let id: String
    let productName: String
    let quantity: Int
    let totalAmountMinor: Int
    let status: String
    let remainingRefundableMinor: Int?
    let fundsOnly: Bool?
  }
  struct Refund: Decodable, Identifiable {
    struct Case: Decodable {
      let caseId: String
      let orderItemId: String
      let status: String
    }
    let id: String
    let publicId: String
    let paymentId: String
    let amountMinor: Int
    let currency: String
    let status: String
    let providerSubmissionState: String
    let reason: String
    let requestedByEmployeeId: String
    let requestedByEmployeeName: String
    let decisionReason: String?
    let receiptReference: String?
    let purpose: String?
    let afterSalesCase: Case?
  }
  struct Payment: Decodable, Identifiable {
    let originalAmountMinor: Int?
    let originalOrderPublicIds: [String]?
    let payableKind: String?
    let id: String
    let publicId: String
    let provider: String
    let method: String
    let providerActionState: String?
    let retryReleasedAt: String?
    let retryReleaseReason: String?
    let amountMinor: Int
    let currency: String
    let status: String
    let remainingRefundableMinor: Int
    let reservedRefundAmountMinor: Int
    let refundableItems: [Item]
    let refunds: [Refund]
    var manual: Bool { ["cash", "physical_pos", "external_manual"].contains(provider) }
  }
  struct Recollection: Decodable {
    let id: String
    let amountMinor: Int
    let expiresAt: String
  }
  struct ClosedDebt: Decodable {
    struct Closable: Decodable {
      let paymentId: String
      let payableKind: String
      let totalAmountMinor: Int
      let currency: String
      let orderIds: [String]
      let orderPublicIds: [String]
    }
    let status: String
    let originalBusinessDate: String
    let pendingPaymentIds: [String]
    let closableUnpresentedPaymentIds: [String]?
    let closableUnpresentedPayments: [Closable]?
  }
  struct Order: Decodable, Identifiable {
    struct Settlement: Decodable {
      let reasonCode: String
      let settledAmountMinor: Int
      let occurredAt: String
    }
    let settlementException: Settlement?

    let recollectionAuthorization: Recollection?
    let closedDebtRecovery: ClosedDebt?
    var needsRecollection: Bool {
      guard outstandingAmountMinor > 0, !["draft", "cancelled"].contains(status),
        recollectionAuthorization == nil
      else { return false }
      if tableSessionStatus == "closed" {
        return closedDebtRecovery?.status == "authorization_required"
      }
      return ["open", "closing"].contains(tableSessionStatus ?? "")
        && payments.contains { $0.refunds.contains { $0.status == "succeeded" } }
    }

    let id: String
    let publicId: String
    let tableCode: String
    let tableSessionId: String?
    let tableSessionStatus: String?
    let businessDate: String?
    let status: String
    let paymentStatus: String
    let totalAmountMinor: Int
    let outstandingAmountMinor: Int
    let overCollectedAmountMinor: Int
    let currency: String
    let payments: [Payment]
    let items: [Item]
  }
  let activityRegistrations: [CashierActivity]
  let businessDate: String
  let query: String
  let actions: [String: Bool]
  let orders: [Order]
  // actions also contains a provider string; decode only the boolean authorization flags.
  enum CodingKeys: String, CodingKey {
    case businessDate, query, actions, orders, activityRegistrations
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    businessDate = try c.decode(String.self, forKey: .businessDate)
    query = try c.decode(String.self, forKey: .query)
    orders = try c.decode([Order].self, forKey: .orders)
    activityRegistrations =
      try c.decodeIfPresent([CashierActivity].self, forKey: .activityRegistrations) ?? []
    let flags = try c.nestedContainer(keyedBy: Flag.self, forKey: .actions)
    var value: [String: Bool] = [:]
    for key in flags.allKeys {
      if let flag = try? flags.decode(Bool.self, forKey: key) { value[key.stringValue] = flag }
    }
    actions = value
  }
  struct Flag: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
  }
  func unpaidCommand(
    actor: StaffIdentity, orderID: String, settle: Bool, reasonCode: String, note: String
  ) throws -> LiveCommand {
    let permission = settle ? "order.settle_exception" : "order.cancel_unpaid"
    let reasons =
      settle
      ? ["manager_comp", "uncollectible", "test_cleanup"]
      : ["guest_left", "duplicate_order", "test_cleanup", "other"]
    let reason = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows(permission), let order = orders.first(where: { $0.id == orderID }),
      order.paymentStatus == "unpaid", order.currency == "CNY", reasons.contains(reasonCode),
      (4...500).contains(reason.utf16.count),
      !order.payments.contains(where: {
        ["created", "pending", "succeeded", "partially_refunded", "refunded"].contains($0.status)
      }),
      settle
        ? (order.status == "cancelled" && order.outstandingAmountMinor > 0
          && order.settlementException == nil
          && order.items.contains(where: { $0.status == "delivered" }))
        : order.status != "cancelled",
      !settle || reasonCode != "test_cleanup" || actor.employee.roleCodes.contains("OWNER")
    else { throw CatalogError("仅处理当前未付款原单；有在途或到账款项应先核对，免单需相应权限") }
    let action = settle ? "settle-exception" : "cancel-unpaid"
    let id = UUID().uuidString.lowercased()
    let title = settle ? "异常结清已送达未付款金额" : "取消未付款原订单"
    let proof: [String: Any] = [
      "cashier": true, "action": action, "orderId": order.id, "orderPublicId": order.publicId,
      "sourceBusinessDate": order.businessDate ?? businessDate,
      "amountMinor": order.outstandingAmountMinor,
      "confirmation":
        "\(order.tableCode) · \(order.publicId)\n当前未收 \(money(order.outstandingAmountMinor))\n\(title)\n原因：\(reason)\n这不是收款，也不会删除已送达商品、已消耗库存和原营业日记录。",
    ]
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: "/api/orders/\(LiveCommand.pathPart(order.id))/\(action)",
          body: try JSONSerialization.data(
            withJSONObject: ["reasonCode": reasonCode, "reasonNote": reason], options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-unpaid-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
  static func path(query: String) -> String {
    var u = URLComponents()
    u.path = "/api/payments/workbench"
    u.queryItems = [.init(name: "limit", value: "100"), .init(name: "query", value: query)]
    return u.string!.replacingOccurrences(of: "+", with: "%2B")
  }
  static let collectionMethods = [
    "cash": ("payment.manual.cash.record", "canRecordManualCash", "cash", "现金"),
    "physical_pos": ("payment.manual.pos.record", "canRecordManualPos", "card", "实体POS"),
    "external_manual": (
      "payment.manual.external.record", "canRecordManualExternal", "manual", "外部收款"
    ),
  ]
  func validateHistoricalSelection(
    actor: StaffIdentity, orderID: String, amount: Int, session: String, authorizationID: String,
    provider: String
  ) throws -> Order {
    guard let mode = Self.collectionMethods[provider],
      actions["supportsGuardedClosedDebtCollection"] == true,
      actions[mode.1] == true, actions["canAuthorizeRecollection"] == true,
      [mode.0, "payment.collect.all_tables", "payment.recollect.authorize"].allSatisfy({
        actor.allows($0)
      }),
      let order = orders.first(where: { $0.id == orderID }),
      !["draft", "cancelled"].contains(order.status), order.currency == "CNY",
      order.tableSessionStatus == "closed", !session.isEmpty, order.tableSessionId == session,
      order.closedDebtRecovery?.status == "available",
      order.closedDebtRecovery?.pendingPaymentIds.isEmpty == true,
      amount > 0, amount == order.outstandingAmountMinor,
      !authorizationID.isEmpty, order.recollectionAuthorization?.id == authorizationID,
      order.recollectionAuthorization?.amountMinor == amount
    else { throw CatalogError("历史欠款、原桌次、授权或权限已变化，或服务器尚未支持安全补收；请刷新原单") }
    return order
  }
  func historicalCollection(
    actor: StaffIdentity, order: Order, provider: String, tender: Int?, reference: String,
    terminal: String, method: String, note: String
  ) throws -> LiveCommand {
    let current = try validateHistoricalSelection(
      actor: actor, orderID: order.id, amount: order.outstandingAmountMinor,
      session: order.tableSessionId ?? "",
      authorizationID: order.recollectionAuthorization?.id ?? "", provider: provider)
    let mode = Self.collectionMethods[provider]!
    let id = UUID().uuidString.lowercased()
    let amount = current.outstandingAmountMinor
    // amountMinor would select the batch/partial endpoint contract. Historical debt must omit it.
    var body: [String: Any] = [
      "orderId": current.id, "publicId": "APP-PAY-" + id, "provider": provider, "method": mode.2,
      "closedDebtGuard": [
        "amountMinor": amount, "authorizationId": current.recollectionAuthorization!.id,
      ],
    ]
    let ref = reference.trimmingCharacters(in: .whitespacesAndNewlines)
    var cashDetail = ""
    if provider == "cash" {
      guard let tender, tender >= amount else { throw CatalogError("实际收到现金不能少于本次补收金额") }
      body["receiptReference"] = "CASH-APP-" + id
      cashDetail = "\n实收现金：\(money(tender)) · 找零：\(money(tender - amount))"
    } else {
      guard (3...256).contains(ref.utf16.count) else { throw CatalogError("请填写原收款凭证号（3—256字）") }
      body["receiptReference"] = ref
    }
    let terminal = terminal.trimmingCharacters(in: .whitespacesAndNewlines)
    guard terminal.utf16.count <= 128 else { throw CatalogError("终端编号过长") }
    if !terminal.isEmpty { body["terminalId"] = terminal }
    let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if provider == "external_manual" {
      guard
        ["bank_transfer", "mobile_wallet", "stored_value_voucher", "corporate_account", "other"]
          .contains(method), (2...500).contains(note.utf16.count)
      else { throw CatalogError("请选择外部收款方式并填写说明") }
      body["externalMethodCode"] = method
      body["collectionNote"] = note
    }
    let confirmation =
      "原订单：\(current.publicId)\n原桌次：\(current.tableSessionId!)\n原营业日：\(current.closedDebtRecovery!.originalBusinessDate)\n本次全额补收：\(money(amount)) · \(mode.3)\(cashDetail)\n凭证：\(body["receiptReference"]!)\n确认款项已实际收到。记入服务器收款时的营业日，保留原订单与已关桌状态，不重新开桌、不新增出品。"
    let proof: [String: Any] = [
      "cashier": true, "action": "historical-collection", "orderId": current.id,
      "tableSessionId": current.tableSessionId!, "amountMinor": amount,
      "actorId": actor.employee.id, "authorizationId": current.recollectionAuthorization!.id,
      "confirmation": confirmation,
    ]
    return LiveCommand(
      id: id, employeeID: actor.employee.id,
      title: "\(current.tableCode) · 登记历史补收 \(money(amount))", permission: mode.0,
      steps: [
        .init(
          path: "/api/payments/manual/closed-debt",
          body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-payment-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
  func recoveryCommand(
    actor: StaffIdentity, orderID: String, paymentID: String, action: String, reason: String
  ) throws -> LiveCommand {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let order = orders.first(where: { $0.id == orderID }), order.currency == "CNY",
      actor.allows("payment.recollect.authorize"), actions["canAuthorizeRecollection"] == true,
      (4...500).contains(reason.utf16.count)
    else { throw CatalogError("请刷新原订单、核对授权权限并填写4—500字原因") }
    var proof: [String: Any] = [
      "cashier": true, "action": action, "orderId": order.id, "actorId": actor.employee.id,
    ]
    let path: String
    let title: String
    let confirmation: String
    if action == "recollect" {
      guard order.needsRecollection else { throw CatalogError("当前订单不需要重新收款授权，请刷新原单") }
      proof["amountMinor"] = order.outstandingAmountMinor
      path = "/api/orders/\(LiveCommand.pathPart(order.id))/recollection-authorizations"
      title = "\(order.tableCode) · 授权再次收款 \(money(order.outstandingAmountMinor))"
      confirmation =
        "原订单：\(order.publicId)\n客人明确同意再次支付当前应收 \(money(order.outstandingAmountMinor))。原补偿仍然有效。仅授权此原单，默认30分钟内一次使用；此操作不扣款。\n原因：\(reason)"
    } else {
      guard action == "close-history", order.tableSessionStatus == "closed",
        order.closedDebtRecovery?.status == "pending_payment", order.outstandingAmountMinor > 0,
        actions["canViewReconciliation"] == true, actions["canInitiateOnlinePayment"] == true,
        ["payment.initiate.staff", "reconciliation.view", "payment.collect.all_tables"].allSatisfy({
          actor.allows($0)
        }),
        let payment = order.payments.first(where: { $0.id == paymentID }),
        payment.currency == "CNY",
        ["created", "pending"].contains(payment.status),
        order.closedDebtRecovery?.closableUnpresentedPaymentIds?.contains(paymentID) == true,
        order.closedDebtRecovery?.pendingPaymentIds.contains(paymentID) == true,
        let scope = order.closedDebtRecovery?.closableUnpresentedPayments?.first(where: {
          $0.paymentId == paymentID
        }),
        ["order", "order_batch"].contains(scope.payableKind), scope.currency == "CNY",
        scope.totalAmountMinor > 0,
        scope.orderIds.count == scope.orderPublicIds.count,
        Set(scope.orderIds).count == scope.orderIds.count,
        Set(scope.orderPublicIds).count == scope.orderPublicIds.count,
        !scope.orderIds.contains(""), !scope.orderPublicIds.contains(""),
        let index = scope.orderIds.firstIndex(of: order.id),
        scope.orderPublicIds[index] == order.publicId,
        scope.payableKind != "order" || scope.orderIds.count == 1
      else { throw CatalogError("只可关闭服务端确认未对外展示的历史付款；请核对完整原付款范围和权限") }
      proof["paymentId"] = payment.id
      proof["paymentPublicId"] = payment.publicId
      proof["amountMinor"] = scope.totalAmountMinor
      proof["payableKind"] = scope.payableKind
      proof["orderIds"] = scope.orderIds
      path = "/api/payments/\(LiveCommand.pathPart(payment.id))/close-unpresented-history"
      title = "关闭历史未外送付款 · 整笔 \(money(scope.totalAmountMinor))"
      confirmation =
        "原付款：\(payment.publicId)\n涉及全部订单：\(scope.orderPublicIds.joined(separator: "、"))\n整笔金额：\(money(scope.totalAmountMinor))，不是本单分摊。仅本地关闭未外送尝试，不联系支付渠道、不退款、不重新开桌。\n原因：\(reason)"
    }
    proof["confirmation"] = confirmation
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title,
      permission: "payment.recollect.authorize",
      steps: [
        .init(
          path: path,
          body: try JSONSerialization.data(
            withJSONObject: ["reason": reason], options: .sortedKeys), keyHeader: "idempotency-key",
          key: "native-cashier-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
  func command(
    actor: StaffIdentity, orderID: String, paymentID: String, action: String, refundID: String = "",
    amounts: [String: Int] = [:], reason: String = "", purpose: String = "", reference: String = "",
    succeeded: Bool = true
  ) throws -> LiveCommand {
    if ["recollect", "close-history"].contains(action) {
      return try recoveryCommand(
        actor: actor, orderID: orderID, paymentID: paymentID, action: action, reason: reason)
    }
    let order = orders.first(where: { $0.id == orderID })
    let activity = activityRegistrations.first { $0.id == orderID }
    guard
      let payment = order?.payments.first(where: { $0.id == paymentID }) ?? activity?.payment
        .flatMap({ $0.id == paymentID ? $0 : nil })
        ?? activity?.late.compactMap(\.payment).first(where: { $0.id == paymentID }),
      (order?.currency ?? activity?.currency) == "CNY", payment.currency == "CNY",
      activity == nil
        || (actor.allows("community.activity.cashier") && actions["canUseActivityCashier"] == true
          && action != "request")
    else { throw CatalogError("原订单或付款已变化，请刷新") }
    let permission =
      action == "request"
      ? "refund.request"
      : ["approve", "reject"].contains(action)
        ? "refund.approve"
        : ["payment-query", "payment-close"].contains(action)
          ? "reconciliation.view" : "refund.execute"
    guard actor.allows(permission), actions[Self.actionFlags[permission] ?? ""] == true else {
      throw CatalogError("当前账号或收银工作台未授权此操作")
    }
    let id = UUID().uuidString.lowercased()
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    var body: [String: Any] = [:]
    var proof: [String: Any] = [
      "cashier": true, "action": action, "paymentId": payment.id,
      "paymentPublicId": payment.publicId,
    ]
    let path: String
    let title: String
    if action == "request" {
      guard ["succeeded", "partially_refunded"].contains(payment.status),
        refundPurposes[purpose] != nil, (2...1000).contains(reason.utf16.count), !amounts.isEmpty,
        amounts.count <= 50
      else { throw CatalogError("请选择退款用途、原商品金额并填写2—1000字原因") }
      let items = payment.refundableItems
      var total = 0
      for (itemID, amount) in amounts {
        guard amount > 0, let item = items.first(where: { $0.id == itemID }),
          let remaining = item.remainingRefundableMinor, amount <= remaining,
          !(item.fundsOnly == true && !["price_adjustment", "duplicate_payment"].contains(purpose))
        else { throw CatalogError("所选商品可退余额或用途已变化；资金调整项只允许退差价或退重复款") }
        let sum = total.addingReportingOverflow(amount)
        guard !sum.overflow else { throw CatalogError("退款金额超限") }
        total = sum.partialValue
      }
      guard total <= payment.remainingRefundableMinor else { throw CatalogError("退款超出原付款剩余可退金额") }
      let publicID = "APP-REF-" + id
      body = [
        "publicId": publicID, "reason": reason, "purpose": purpose,
        "allocations": amounts.keys.sorted().map {
          ["orderItemId": $0, "amountMinor": amounts[$0]!] as [String: Any]
        }, "requestEvidence": ["source": "native_cashier"],
      ]
      proof["refundPublicId"] = publicID
      proof["amountMinor"] = total
      title =
        "\(order?.tableCode ?? activity?.activityTitle ?? "") · 申请退款 \(money(total)) · 等待另一员工复核"
      path = "/api/payments/\(LiveCommand.pathPart(payment.id))/refunds"
    } else if action == "payment-close" {
      guard actions["supportsProviderClose"] == true, actor.allows("payment.initiate.staff"),
        payment.provider == "postar", ["created", "pending"].contains(payment.status),
        let whole = payment.originalAmountMinor, whole > 0, (4...500).contains(reason.utf16.count)
      else { throw CatalogError("请刷新原付款整笔金额、渠道关单能力及权限，并填写4—500字原因") }
      body = ["reason": reason, "expectedAmountMinor": whole]
      proof["amountMinor"] = whole
      proof["confirmation"] =
        "核对并关闭原渠道付款 \(payment.publicId)\n整笔金额 \(money(whole))\n关联订单：\((payment.originalOrderPublicIds ?? []).joined(separator:"、"))\n原因：\(reason)\n先查渠道再关单；已到账则保留到账事实，不能另收。合并付款将处理整笔原款，不只当前订单。未知结果保留原请求。"
      path = "/api/payments/\(LiveCommand.pathPart(payment.id))/provider-close"
      title = "核对渠道并关闭原付款"
    } else if action == "payment-query" {
      guard payment.provider == "postar" else { throw CatalogError("该付款不支持此渠道查询") }
      path = "/api/payments/\(LiveCommand.pathPart(payment.id))/provider-query"
      title = "核对原付款 \(payment.publicId) · 不再次扣款"
    } else {
      guard let refund = payment.refunds.first(where: { $0.id == refundID }),
        refund.paymentId == payment.id, refund.currency == "CNY"
      else { throw CatalogError("原退款记录已变化，请刷新") }
      guard refund.afterSalesCase == nil || action == "refund-query" else {
        throw CatalogError("这是原商品售后退款，必须通过原售后单处理")
      }
      proof["refundId"] = refund.id
      proof["refundPublicId"] = refund.publicId
      proof["amountMinor"] = refund.amountMinor
      var endpoint = action
      switch action {
      case "approve", "reject":
        guard refund.status == "requested", refund.requestedByEmployeeId != actor.employee.id,
          (2...1000).contains(reason.utf16.count)
        else { throw CatalogError("发起人不能复核自己的退款；请填写复核说明并核对待复核状态") }
        body = ["reason": reason]
      case "execute":
        guard
          refund.status == "approved"
            || (!payment.manual && refund.status == "processing"
              && refund.providerSubmissionState == "not_started")
        else { throw CatalogError("此退款不能重复提交执行，请先查询原退款") }
      case "refund-query":
        guard payment.provider == "postar", refund.status == "processing",
          refund.providerSubmissionState != "not_started"
        else { throw CatalogError("退款尚未提交渠道或已返回最终结果，请刷新") }
        endpoint = "provider-query"
      case "manual-result":
        guard payment.manual, refund.status == "processing" else {
          throw CatalogError("仅处理中的线下退款可以登记实际结果")
        }
        let ref = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard payment.provider == "cash" || (1...256).contains(ref.utf16.count) else {
          throw CatalogError("请填写独立退款凭证号")
        }
        body = ["succeeded": succeeded]
        if payment.provider != "cash" { body["receiptReference"] = ref }
        proof["succeeded"] = succeeded
      default: throw CatalogError("不支持此退款操作")
      }
      path = "/api/refunds/\(LiveCommand.pathPart(refund.id))/\(endpoint)"
      let label = [
        "approve": "复核通过（线上可能自动提交原路退款）", "reject": "驳回退款",
        "execute": payment.manual ? "开始人工退款" : "提交原路退款", "refund-query": "查询退款结果",
        "manual-result": succeeded ? "登记款项已实际退给客人" : "登记本次实际退款失败",
      ][action]!
      title =
        "\(order?.tableCode ?? activity?.activityTitle ?? "") · \(label) · \(money(refund.amountMinor))"
    }
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-cashier-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var cashierProof: [String: Any]? {
    guard let recoveryBody,
      let obj = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      obj["cashier"] as? Bool == true
    else { return nil }
    return obj
  }
}
func validateCashierReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.cashierProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    let action = proof["action"] as? String
  else { throw StaffAPIError.invalid }
  if ["cancel-unpaid", "settle-exception"].contains(action) {
    guard let event = data["eventId"] as? String, !event.isEmpty,
      let orderID = proof["orderId"] as? String,
      step.path == "/api/orders/\(LiveCommand.pathPart(orderID))/\(action)",
      data["orderPublicId"] as? String == proof["orderPublicId"] as? String,
      data["sourceBusinessDate"] as? String == proof["sourceBusinessDate"] as? String,
      let date = data["actionBusinessDate"] as? String,
      let at = data["occurredAt"] as? String, assignmentDate(at) != nil,
      data["replayed"] as? Bool == meta["replayed"] as? Bool
    else { throw StaffAPIError.invalid }
    _ = try FinanceQuery(date: date).path()
    if action == "settle-exception" {
      guard let amount = data["settledAmountMinor"] as? Int, amount > 0,
        amount == proof["amountMinor"] as? Int
      else { throw StaffAPIError.invalid }
    } else {
      for key in [
        "deliveredItemCount", "cancelledItemCount", "cancelledKdsTaskCount",
        "releasedInventoryReservationCount",
      ] {
        guard let count = data[key] as? Int, count >= 0 else { throw StaffAPIError.invalid }
      }
    }
    return
  }
  if action == "historical-collection" {
    let body = step.object
    guard step.path == "/api/payments/manual/closed-debt", let id = data["id"] as? String,
      !id.isEmpty,
      data["status"] as? String == "succeeded", data["payableKind"] as? String == "order",
      data["orderId"] as? String == proof["orderId"] as? String,
      data["publicId"] as? String == body["publicId"] as? String,
      data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
      data["currency"] as? String == "CNY",
      data["provider"] as? String == body["provider"] as? String,
      data["method"] as? String == body["method"] as? String,
      data["providerTransactionId"] as? String == body["receiptReference"] as? String,
      let evidence = data["providerSnapshot"] as? [String: Any],
      evidence["collectedByEmployeeId"] as? String == proof["actorId"] as? String,
      evidence["receiptReference"] as? String == body["receiptReference"] as? String
    else { throw StaffAPIError.invalid }
    for key in ["terminalId", "externalMethodCode", "collectionNote"] where body[key] != nil {
      guard evidence[key] as? String == body[key] as? String else { throw StaffAPIError.invalid }
    }
    return
  }
  if action == "recollect" {
    guard let id = data["id"] as? String, !id.isEmpty,
      let publicID = data["publicId"] as? String, !publicID.isEmpty,
      data["orderId"] as? String == proof["orderId"] as? String,
      data["authorizedByEmployeeId"] as? String == proof["actorId"] as? String,
      data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
      data["currency"] as? String == "CNY",
      data["reason"] as? String == step.object["reason"] as? String,
      let expires = data["expiresAt"] as? String, !expires.isEmpty,
      let created = data["createdAt"] as? String, !created.isEmpty
    else { throw StaffAPIError.invalid }
    return
  }
  guard let status = data["status"] as? String else { throw StaffAPIError.invalid }
  // The public payment serializer removes the internal local-close marker.
  // Bind this endpoint response to the original payment, whole amount and kind instead.
  if action == "close-history" {
    guard status == "closed", data["id"] as? String == proof["paymentId"] as? String,
      data["publicId"] as? String == proof["paymentPublicId"] as? String,
      data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
      data["currency"] as? String == "CNY",
      data["payableKind"] as? String == proof["payableKind"] as? String
    else { throw StaffAPIError.invalid }
    return
  }
  if action == "payment-close" {
    guard data["id"] as? String == proof["paymentId"] as? String,
      data["publicId"] as? String == proof["paymentPublicId"] as? String,
      data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
      data["currency"] as? String == "CNY",
      ["closed", "failed", "succeeded", "partially_refunded", "refunded"].contains(status),
      status != "closed" || meta["providerClosed"] as? Bool == true
    else { throw StaffAPIError.invalid }
    return
  }
  if action == "payment-query" {
    guard data["publicId"] as? String == proof["paymentPublicId"] as? String,
      ["created", "pending", "succeeded", "failed", "closed", "partially_refunded", "refunded"]
        .contains(status)
    else { throw StaffAPIError.invalid }
    return
  }
  if action == "refund-query" && status == "processing" && data["id"] == nil { return }
  guard let id = data["id"] as? String, !id.isEmpty,
    proof["refundId"] == nil || id == proof["refundId"] as? String,
    data["publicId"] as? String == proof["refundPublicId"] as? String,
    data["paymentId"] as? String == proof["paymentId"] as? String,
    data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
    data["currency"] as? String == "CNY"
  else { throw StaffAPIError.invalid }
  if action == "request" {
    guard let expected = step.object["allocations"] as? [[String: Any]],
      let actual = data["allocations"] as? [[String: Any]], expected.count == actual.count
    else { throw StaffAPIError.invalid }
    var seen = Set<String>()
    for row in actual {
      guard let item = row["orderItemId"] as? String, seen.insert(item).inserted,
        let amount = row["amountMinor"] as? Int,
        expected.contains(where: {
          $0["orderItemId"] as? String == item && $0["amountMinor"] as? Int == amount
        })
      else { throw StaffAPIError.invalid }
    }
  }
  let allowed: [String]
  switch action {
  case "request": allowed = ["requested"]
  case "approve": allowed = ["approved", "processing", "succeeded"]
  case "reject": allowed = ["rejected"]
  case "execute", "refund-query": allowed = ["processing", "succeeded", "failed"]
  case "manual-result": allowed = [proof["succeeded"] as? Bool == true ? "succeeded" : "failed"]
  default: allowed = []
  }
  guard allowed.contains(status) else { throw StaffAPIError.invalid }
}
