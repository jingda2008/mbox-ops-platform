import Foundation

struct LiveOrderAccess: Decodable {
  struct Gift: Decodable {
    let enabled: Bool
    let maximumAmountMinor: Int?
    let currency: String
  }
  let employeeId: String
  let canCreateOrder: Bool
  let gift: Gift?
}
struct LiveOrderContext: Decodable {
  let token: String
  let employeeId: String
  let staffSessionId: String
  let tableSessionId: String
  let expiresAt: String
}
struct LiveReplacement: Codable, Equatable, Identifiable {
  let itemID, caseID, originalOrderID, originalPublicID, productName: String
  let session, tableCode, employeeID: String
  let previousOrderID: String?
  var id: String { caseID + ":" + (previousOrderID ?? "first") }
  var draftSession: String { session + ":replacement:" + id }
  var explanation: String {
    "原单 " + originalPublicID + " · " + productName
      + "。新商品按当前价格另计，原退款不自动抵扣；原申请的审批、退款和实物处理仍需分别完成。"
  }
  static func make(board: LiveAfterSales, caseID: String, actor: StaffIdentity) throws -> Self {
    try board.validate(itemID: board.item.id)
    guard board.supportsNativeReplacementRecovery == true, actor.allows("refund.request"),
      actor.allows("order.create"),
      let session = board.item.tableSessionId, !session.isEmpty,
      let row = board.cases.first(where: { $0.id == caseID }), row.canReplace == true,
      row.revisedByCaseId == nil, ["requested", "approved", "completed"].contains(row.status),
      row.heldQuantity + row.stoppedQuantity > 0,
      row.replacementOrder == nil || row.replacementOrder?.status == "cancelled"
    else { throw CatalogError("原申请、换品权限或已关联新单发生变化，请刷新原商品") }
    return Self(
      itemID: board.item.id, caseID: caseID, originalOrderID: board.item.orderId,
      originalPublicID: board.item.orderPublicId, productName: board.item.name,
      session: session, tableCode: board.item.tableCode, employeeID: actor.employee.id,
      previousOrderID: row.replacementOrder?.orderId)
  }
  func validate(board: LiveAfterSales, actor: StaffIdentity) throws {
    guard try Self.make(board: board, caseID: caseID, actor: actor) == self else {
      throw CatalogError("原商品、桌次或换品关联已变化，请返回原商品重新核对")
    }
  }
  // Recover by authoritative source linkage even after login/day changes. Never infer
  // success from another staff member's replacement for the same case.
  func recoveredReceipt(board: LiveAfterSales, publicID: String, orderID: String? = nil) throws
    -> LiveOrderReceipt?
  {
    try board.validate(itemID: itemID)
    guard board.item.orderId == originalOrderID else { throw StaffAPIError.invalid }
    let matches = (board.replacementOrders ?? []).filter { $0.publicId == publicID }
    guard matches.count <= 1 else { throw StaffAPIError.invalid }
    guard let link = matches.first else { return nil }
    guard link.sourceCaseId == caseID, !link.orderId.isEmpty,
      orderID == nil || orderID == link.orderId
    else { throw StaffAPIError.invalid }
    return LiveOrderReceipt(
      publicId: publicID, id: link.orderId, totalAmountMinor: nil, recovered: true)
  }
}

struct LiveOrderReceipt: Codable {
  let publicId: String
  let id: String?
  let totalAmountMinor: Int?
  let recovered: Bool
}
struct LiveOrderSubmission: Codable {
  let key: String
  let publicId: String
  let employeeID: String
  let authSessionID: String
  let tableSessionID: String
  let tableCode: String
  let createdAt: Date
  let draftIDs: [String]
  let body: Data
  let token: String
  var receipt: LiveOrderReceipt?
  var rejectedCode: String?
  var replacement: LiveReplacement?
  var replacementVerified: Bool?
  var draftSession: String { replacement?.draftSession ?? tableSessionID }
  var canFinish: Bool { receipt != nil && (replacement == nil || replacementVerified == true) }
  var object: [String: Any] {
    (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
  }
  static func initialRejection(_ error: Error) -> String? {
    guard let e = error as? StaffAPIError, [400, 409].contains(e.status),
      [
        "ORDER_ITEMS_INVALID", "ORDER_DUPLICATE_PRODUCT", "REQUEST_INVALID",
        "ORDER_PRODUCT_UNAVAILABLE", "TABLE_SESSION_UNAVAILABLE", "INVENTORY_RECIPE_MISSING",
        "INVENTORY_BALANCE_MISSING", "INVENTORY_INSUFFICIENT", "GIFT_REASON_REQUIRED",
        "SETTLEMENT_MODE_INVALID", "BUNDLE_SELECTION_INVALID",
      ].contains(e.code)
    else { return nil }
    return e.code
  }
  func validate() throws {
    guard !key.isEmpty, !publicId.isEmpty, !employeeID.isEmpty, !authSessionID.isEmpty,
      !tableSessionID.isEmpty,
      !draftIDs.isEmpty, object["publicId"] as? String == publicId,
      object["tableSessionId"] as? String == tableSessionID,
      object["assistedOrderContextToken"] as? String == token,
      (object["items"] as? [[String: Any]])?.isEmpty == false
    else { throw StaffAPIError.invalid }
    if let replacement {
      guard replacement.employeeID == employeeID, replacement.session == tableSessionID,
        replacement.tableCode == tableCode, !replacement.caseID.isEmpty,
        !replacement.itemID.isEmpty,
        object["replacementCaseId"] as? String == replacement.caseID,
        object["replacementPreviousOrderId"] as? String == replacement.previousOrderID,
        object["orderMode"] as? String == "paid"
      else { throw StaffAPIError.invalid }
    } else if object["replacementCaseId"] != nil || object["replacementPreviousOrderId"] != nil {
      throw StaffAPIError.invalid
    }
    if replacementVerified == true && (replacement == nil || receipt == nil) {
      throw StaffAPIError.invalid
    }
    if let receipt, receipt.publicId != publicId { throw StaffAPIError.invalid }
  }
  static func make(
    lines: [LiveDraftLine], products: [LiveProduct], identity: StaffIdentity,
    access: LiveOrderAccess, context: LiveOrderContext, session: String, tableCode: String,
    gift: Bool, reason: String, note: String, settlement: String,
    replacement: LiveReplacement? = nil, source: LiveAfterSales? = nil
  ) throws -> Self {
    guard identity.allows("order.create"), access.employeeId == identity.employee.id,
      access.canCreateOrder,
      context.employeeId == identity.employee.id, context.staffSessionId == identity.session.id,
      context.tableSessionId == session, let expiry = StaffIdentity.date(context.expiresAt),
      expiry > Date(),
      note.utf16.count <= 500, ["table_tab", "immediate_payment"].contains(settlement)
    else { throw CatalogError("身份、桌次或点单权限已变化，请刷新重试") }
    if let replacement {
      guard !gift, let source, replacement.session == session, replacement.tableCode == tableCode
      else {
        throw CatalogError("换品须关联原桌次并按新商品独立计价")
      }
      try replacement.validate(board: source, actor: identity)
    }
    for line in lines {
      guard let latest = products.first(where: { $0.id == line.product.id }),
        latest.price == line.product.price
      else { throw CatalogError("商品价格已变化，请移除该商品并重新选择") }
      _ = try LiveDraftLine(product: latest, choices: line.choices, note: line.note)
      guard lines.filter({ $0.product.id == latest.id }).count <= latest.maxOrderQuantity else {
        throw CatalogError("商品限购数量已变化，请减少数量")
      }
    }
    if gift {
      let total = lines.reduce(0) { $0 + ($1.product.price ?? 0) }
      guard identity.allows("order.gift"), let limit = access.gift, limit.enabled,
        limit.currency == "CNY",
        limit.maximumAmountMinor == nil || total <= limit.maximumAmountMinor!,
        (2...200).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw CatalogError("赠送权限、额度或理由不符合要求") }
    }
    let key = "native-order-" + UUID().uuidString.lowercased()
    let publicID = "APP-" + UUID().uuidString.lowercased()
    var object: [String: Any] = [
      "publicId": publicID, "tableSessionId": session,
      "assistedOrderContextToken": context.token, "items": try LiveDraftBook.orderItems(lines),
      "orderMode": gift ? "gift" : "paid", "settlementMode": gift ? "table_tab" : settlement,
    ]
    if let replacement {
      object["replacementCaseId"] = replacement.caseID
      if let previous = replacement.previousOrderID {
        object["replacementPreviousOrderId"] = previous
      }
    }
    if gift { object["giftReason"] = reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      object["fulfillmentNote"] = note.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return Self(
      key: key, publicId: publicID, employeeID: identity.employee.id,
      authSessionID: identity.session.id,
      tableSessionID: session, tableCode: tableCode, createdAt: Date(), draftIDs: lines.map(\.id),
      body: try JSONSerialization.data(withJSONObject: object, options: .sortedKeys),
      token: context.token, replacement: replacement)
  }
  func parseReceipt(_ data: Data) throws -> LiveOrderReceipt {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      value["publicId"] as? String == publicId,
      value["tableSessionId"] as? String == tableSessionID,
      let id = value["id"] as? String, !id.isEmpty, value["currency"] as? String == "CNY",
      let amount = value["totalAmountMinor"] as? Int, amount >= 0,
      let next = value["paymentNextStep"] as? [String: Any], next["orderId"] as? String == id
    else { throw StaffAPIError.invalid }
    return LiveOrderReceipt(publicId: publicId, id: id, totalAmountMinor: amount, recovered: false)
  }
  func canReplay(_ identity: StaffIdentity, now: Date = Date()) -> Bool {
    // Never create a new identity or cross the server's 06:00 business day on a retry.
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    return identity.employee.id == employeeID && identity.session.id == authSessionID
      && identity.allows("order.create")
      && now.timeIntervalSince(createdAt) >= 0 && now.timeIntervalSince(createdAt) < 12 * 3600
      && calendar.isDate(
        createdAt.addingTimeInterval(-6 * 3600), inSameDayAs: now.addingTimeInterval(-6 * 3600))
  }
}
