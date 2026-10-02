import Foundation

@main struct DailyPaymentTests {
  @MainActor static func main() async throws {
    let base = URL(fileURLWithPath: CommandLine.arguments[1])
    func bytes(_ value: Any) throws -> Data {
      try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
    }
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: base.appendingPathComponent("live-contract.json"))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]
    auth["permissions"] = [
      "payment.initiate.staff", "reconciliation.view", "reconciliation.manage",
      "business_day.close",
    ]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    var count = 0
    func check(_ value: Bool, _ label: String) {
      precondition(value, label)
      count += 1
      print("PASS \(label)")
    }
    func rejects(_ block: () throws -> Void) -> Bool {
      do {
        try block()
        return false
      } catch { return true }
    }
    let access = OnlineAccess(
      employeeId: actor.employee.id, canInitiatePayment: true, onlinePaymentProvider: "postar")
    let order = LivePaymentOrder(
      id: "11111111-1111-4111-8111-111111111111", publicId: "ORDER-ORIGINAL", currency: "CNY",
      paymentStatus: "unpaid", outstandingAmountMinor: 8800, hasOnlinePaymentInProgress: false,
      unresolvedOnlinePaymentId: nil)
    func online(
      method: String = "native_qr", amount: Int = 8800, code: String = "",
      who: StaffIdentity? = nil, access nextAccess: OnlineAccess? = nil,
      orders: [LivePaymentOrder]? = nil
    ) throws -> LiveCommand {
      try onlinePayment(
        actor: who ?? actor, access: nextAccess ?? access, orders: orders ?? [order],
        session: "session-original", amount: amount, method: method, code: code)
    }
    check(
      rejects { _ = try online(amount: 0) } && rejects { _ = try online(amount: 8801) },
      "online collection cannot exceed current original due")
    check(
      rejects { _ = try online(orders: [order, order]) } && rejects { _ = try online(orders: []) },
      "empty or duplicate order selection refused")
    check(
      rejects {
        _ = try online(
          access: .init(
            employeeId: "other", canInitiatePayment: true, onlinePaymentProvider: "postar"))
      }, "access scope bound to original employee")
    check(
      rejects {
        _ = try online(
          access: .init(
            employeeId: actor.employee.id, canInitiatePayment: true,
            onlinePaymentProvider: "simulation"))
      }, "simulation never presented as operational payment")
    check(
      rejects {
        _ = try online(
          access: .init(
            employeeId: actor.employee.id, canInitiatePayment: false,
            onlinePaymentProvider: "postar"))
      }, "store payment pause respected")
    auth["deniedPermissions"] = [
      "payment.initiate.staff", "reconciliation.manage", "business_day.close",
    ]
    let denied = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    check(rejects { _ = try online(who: denied) }, "denial overrides online permission")
    check(
      rejects { _ = try online(method: "auth_code", code: "https://wrong-code") },
      "table links never treated as payment codes")
    let authCommand = try online(method: "auth_code", code: "0000000000000000")
    var secrets: [String: String] = [:]
    let secured = try secureOnlineCommand(authCommand) { secrets[$0] = $1 }
    let saved = try JSONEncoder().encode(secured)
    check(
      !String(data: saved, encoding: .utf8)!.contains("0000000000000000"),
      "no customer payment code in durable request JSON")
    let loaded = try JSONDecoder().decode(LiveCommand.self, from: saved)
    check(
      loaded.steps[0].key == authCommand.steps[0].key && loaded.id == authCommand.id,
      "secure restore preserves original request id and key")
    check(
      try onlineRequestBody(loaded.steps[0]) { secrets[$0]! }["customerAuthCode"] as? String
        == "0000000000000000", "secret resolved only for original wire request")
    check(
      rejects {
        _ = try onlineRequestBody(loaded.steps[0]) { _ in throw CatalogError("unavailable") }
      }, "unreadable secret fails closed without fresh request")
    check(
      rejects { _ = try secureOnlineCommand(authCommand) { _, _ in throw CatalogError("disk") } },
      "secret storage failure prevents durable submission")
    let qr = try online(amount: 4000)
    let step = qr.steps[0]
    func receipt(_ command: LiveCommand) -> [String: Any] {
      let body = command.steps[0].object
      return [
        "data": [
          "id": "payment-original", "publicId": body["publicId"]!, "provider": "postar",
          "method": body["method"]!, "currency": "CNY", "status": "pending",
          "amountMinor": body["amountMinor"]!,
          "providerAction": [
            "paymentId": "payment-original", "paymentPublicId": body["publicId"]!,
            "status": "pending",
            "presentation": body["method"] as? String == "native_qr" ? "qr" : "barcode",
            "expiresAt": "2099-01-01T00:00:00Z",
            "payload": ["qrCodeUrl": "https://example.invalid/mock-payment-only"],
          ],
        ], "meta": ["replayed": false],
      ]
    }
    try validateOnlineReply(bytes(receipt(qr)), step: step)
    check(true, "partial QR collection accepted only with matching payment and action")
    for key in ["id", "publicId", "provider", "method", "currency", "amountMinor"] {
      var root = receipt(qr)
      var data = root["data"] as! [String: Any]
      data[key] = key == "amountMinor" ? 999 : "wrong"
      root["data"] = data
      check(
        rejects { try validateOnlineReply(bytes(root), step: step) },
        "wrong \(key) receipt retains unknown request")
    }
    let stored = OnlineReceipt(
      commandID: qr.id, employeeID: qr.employeeID, tableSessionID: "session-original", kind: "init",
      response: try bytes(receipt(qr)))
    check(
      stored.qr(status: "pending") != nil && stored.qr(status: "succeeded") == nil
        && stored.qr(status: "unknown") == nil, "QR visible only while original payment is pending")
    check(
      stored.qr(now: StaffIdentity.date("2100-01-01T00:00:00Z")!, status: "pending") == nil,
      "expired QR hidden without claiming failure")
    let pending = LivePaymentOrder(
      id: order.id, publicId: order.publicId, currency: "CNY", paymentStatus: "pending",
      outstandingAmountMinor: 8800, hasOnlinePaymentInProgress: true,
      unresolvedOnlinePaymentId: "payment-original")
    check(
      rejects { _ = try online(orders: [pending]) }, "unknown payment prevents duplicate collection"
    )
    let release = try onlineRelease(
      actor: actor, orders: [pending], paymentID: "payment-original", session: "session-original",
      reason: "顾客确认改用现金")
    let releaseBody: [String: Any] = [
      "data": [
        "id": "payment-original", "publicId": "PAY-ORIGINAL", "status": "pending",
        "retryReleasedAt": "2026-09-27 12:00:00+00", "retryReleaseReason": "顾客确认改用现金",
      ], "meta": ["replayed": true],
    ]
    try validateOnlineReply(bytes(releaseBody), step: release.steps[0])
    check(true, "retry release does not require or invent failed old payment")
    check(
      rejects {
        _ = try onlineRelease(
          actor: actor, orders: [pending], paymentID: "other", session: "session-original",
          reason: "顾客确认改用现金")
      }, "retry release bound to original table unresolved payment")
    let query = try FinanceQuery(date: "2026-09-27", type: "refund").path(
      cursor: "original+cursor/next")
    check(
      query.contains("entryType=refund") && query.contains("%2B"),
      "ledger date type and cursor encoded")
    check(
      rejects { _ = try FinanceQuery(date: "2026-02-30").path() }, "invalid business date refused")
    let row = FinanceReview(
      id: "payment-original", publicId: "PAY-ORIGINAL", amountMinor: "8800", status: "pending",
      tableCode: "A1", orderPublicId: "ORDER-ORIGINAL", ownerName: nil, note: nil,
      financialSignals: nil, stopReason: nil)
    let review = try financeCommand(actor: actor, row: row, note: "正在核对原渠道")
    check(
      rejects { _ = try financeCommand(actor: actor, row: row, note: "正在核对原渠道", resolve: true) },
      "unknown payment cannot be financially resolved")
    check(
      rejects { _ = try financeCommand(actor: denied, row: row, note: "正在核对原渠道") },
      "finance write requires explicit management permission")
    let reviewReply: [String: Any] = [
      "data": [
        "paymentId": row.id, "ownerEmployeeId": actor.employee.id, "note": "正在核对原渠道",
        "status": "reviewing",
      ], "replayed": false,
    ]
    try validateFinanceReply(bytes(reviewReply), step: review.steps[0])
    check(true, "review receipt validates original payment employee note and state")
    for key in ["paymentId", "ownerEmployeeId", "note", "status"] {
      var root = reviewReply
      var data = root["data"] as! [String: Any]
      data[key] = "wrong"
      root["data"] = data
      check(
        rejects { try validateFinanceReply(bytes(root), step: review.steps[0]) },
        "wrong finance \(key) cannot clear pending")
    }
    let close = try financeCommand(actor: actor, closeDay: true)
    let closure: [String: Any] = [
      "data": [
        "businessDays": [], "closedBusinessDayCount": 0, "closedTableSessionCount": 0,
        "blockedTableSessionCount": 0,
      ], "meta": ["replayed": false],
    ]
    try validateFinanceReply(bytes(closure), step: close.steps[0])
    check(true, "no pending business day is valid readback not invented closure")
    var wrong = closure
    var data = wrong["data"] as! [String: Any]
    data["closedTableSessionCount"] = 1
    wrong["data"] = data
    check(
      rejects { try validateFinanceReply(bytes(wrong), step: close.steps[0]) },
      "closure counters must match detailed results")
    check(
      rejects { _ = try financeCommand(actor: denied, closeDay: true) },
      "day closing requires permission")
    let entry: [String: Any] = [
      "id": "ledger-original", "paymentId": "payment-original", "refundId": "refund-original",
      "entryType": "refund", "provider": "postar", "providerReference": "REF-ORIGINAL",
      "amountMinor": -4000, "currency": "CNY", "businessDate": "2026-09-27",
      "occurredAt": "2026-09-27 12:00:00+00",
    ]
    func ledger(_ row: [String: Any], cursor: String? = nil) throws -> FinancePage {
      try JSONDecoder().decode(
        FinancePage.self,
        from: bytes(["data": [row], "meta": ["nextCursor": cursor as Any? ?? NSNull()]]))
    }
    try validateFinancePage(
      ledger(entry), query: .init(date: "2026-09-27", type: "refund"), cursor: nil)
    check(true, "refund ledger uses signed negative amount")
    for (key, value) in [
      ("amountMinor", 4000 as Any), ("businessDate", "2026-09-26" as Any),
      ("entryType", "payment" as Any),
    ] {
      var wrong = entry
      wrong[key] = value
      check(
        rejects {
          try validateFinancePage(
            ledger(wrong), query: .init(date: "2026-09-27", type: "refund"), cursor: nil)
        }, "ledger rejects wrong \(key)")
    }
    check(
      rejects {
        try validateFinancePage(
          ledger(entry, cursor: "same"), query: .init(date: "2026-09-27"), cursor: "same")
      }, "ledger never loops repeating cursor")
    var baseBoard =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: base.appendingPathComponent("live-cashier.json"))) as! [String: Any]
    var rawOrder = (baseBoard["orders"] as! [[String: Any]])[0]
    rawOrder["payments"] = [] as [Any]
    rawOrder["paymentStatus"] = "unpaid"
    rawOrder["status"] = "submitted"
    rawOrder["outstandingAmountMinor"] = 10000
    func board(_ order: [String: Any]) throws -> LiveCashier {
      baseBoard["orders"] = [order]
      return try JSONDecoder().decode(LiveCashier.self, from: bytes(baseBoard))
    }
    auth["deniedPermissions"] = []
    auth["permissions"] = ["order.cancel_unpaid", "order.settle_exception"]
    let manager = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    let cancel = try board(rawOrder).unpaidCommand(
      actor: manager, orderID: rawOrder["id"] as! String, settle: false, reasonCode: "guest_left",
      note: "现场确认未付款离店")
    let reply: [String: Any] = [
      "data": [
        "eventId": "event-original", "orderPublicId": rawOrder["publicId"]!,
        "sourceBusinessDate": "2026-09-26", "actionBusinessDate": "2026-09-27",
        "deliveredItemCount": 1, "cancelledItemCount": 0, "cancelledKdsTaskCount": 0,
        "releasedInventoryReservationCount": 0, "occurredAt": "2026-09-27 12:00:00+00",
        "replayed": false,
      ], "meta": ["replayed": false],
    ]
    try validateCashierReply(bytes(reply), step: cancel.steps[0])
    check(true, "unpaid cancellation verifies original order and preserves delivered count")
    var wrongReply = reply
    var replyData = reply["data"] as! [String: Any]
    replyData["orderPublicId"] = "another-order"
    wrongReply["data"] = replyData
    check(
      rejects { try validateCashierReply(bytes(wrongReply), step: cancel.steps[0]) },
      "foreign cancellation receipt keeps original request")
    for state in ["pending", "succeeded", "partially_refunded", "refunded"] {
      var wrongOrder = rawOrder
      let originalBoard =
        try JSONSerialization.jsonObject(
          with: Data(contentsOf: base.appendingPathComponent("live-cashier.json")))
        as! [String: Any]
      var payment =
        ((originalBoard["orders"] as! [[String: Any]])[0]["payments"] as! [[String: Any]])[0]
      payment["status"] = state
      wrongOrder["payments"] = [payment]
      check(
        rejects {
          _ = try board(wrongOrder).unpaidCommand(
            actor: manager, orderID: rawOrder["id"] as! String, settle: false,
            reasonCode: "guest_left", note: "现场确认未付款离店")
        }, "\(state) payment blocks unpaid cancellation")
    }
    check(
      rejects {
        _ = try board(rawOrder).unpaidCommand(
          actor: actor, orderID: rawOrder["id"] as! String, settle: false, reasonCode: "guest_left",
          note: "现场确认未付款离店")
      }, "cancellation requires dedicated permission")
    rawOrder["status"] = "cancelled"
    let exception = try board(rawOrder).unpaidCommand(
      actor: manager, orderID: rawOrder["id"] as! String, settle: true, reasonCode: "uncollectible",
      note: "现场确认无法收回原款")
    var exceptionData = reply["data"] as! [String: Any]
    exceptionData["settledAmountMinor"] = 10000
    try validateCashierReply(
      bytes(["data": exceptionData, "meta": ["replayed": false]]), step: exception.steps[0])
    check(true, "exception settlement is separately validated without payment success")
    exceptionData["settledAmountMinor"] = 9999
    check(
      rejects {
        try validateCashierReply(
          bytes(["data": exceptionData, "meta": ["replayed": false]]), step: exception.steps[0])
      }, "changed writeoff amount cannot be silently acknowledged")
    print("\(count) daily payment checks passed")
  }
}
