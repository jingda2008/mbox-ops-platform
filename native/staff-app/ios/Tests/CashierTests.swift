import Foundation

@main struct CashierTests {
  @MainActor static func main() async throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    func bytes(_ v: Any) throws -> Data { try JSONSerialization.data(withJSONObject: v) }
    let authFixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-contract.json"))) as! [String: Any]
    var auth = authFixture["auth"] as! [String: Any]
    auth["permissions"] = [
      "refund.request", "refund.approve", "refund.execute", "reconciliation.view",
    ]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(auth))
    let raw =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-cashier.json"))) as! [String: Any]
    func board(_ source: [String: Any]? = nil) throws -> LiveCashier {
      try JSONDecoder().decode(LiveCashier.self, from: bytes(source ?? raw))
    }
    func changedPayment(_ change: (inout [String: Any]) -> Void) throws -> LiveCashier {
      var copy = raw
      var orders = copy["orders"] as! [[String: Any]]
      var payments = orders[0]["payments"] as! [[String: Any]]
      change(&payments[0])
      orders[0]["payments"] = payments
      copy["orders"] = orders
      return try board(copy)
    }
    func changedRefund(_ change: (inout [String: Any]) -> Void) throws -> LiveCashier {
      try changedPayment { payment in
        var refunds = payment["refunds"] as! [[String: Any]]
        change(&refunds[0])
        payment["refunds"] = refunds
      }
    }
    var count = 0
    func check(_ ok: Bool, _ label: String) {
      precondition(ok, label)
      count += 1
      print("PASS \(label)")
    }
    func rejected(_ run: () throws -> Void) -> Bool {
      do {
        try run()
        return false
      } catch { return true }
    }
    let current = try board()
    let request = try current.command(
      actor: actor, orderID: "order1", paymentID: "pay1", action: "request",
      amounts: ["item1": 2000], reason: "客人确认退差价", purpose: "price_adjustment")
    check(
      request.steps[0].object["purpose"] as? String == "price_adjustment"
        && request.steps[0].cashierProof?["amountMinor"] as? Int == 2000,
      "refund captures explicit purpose and original allocation amount")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(request))
    check(restored == request, "restart preserves refund key body and acknowledgement binding")
    check(
      rejected {
        _ = try current.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "request",
          amounts: ["item1": 5001], reason: "退回差额", purpose: "price_adjustment")
      }, "item or payment cap blocks excess refund")
    check(
      rejected {
        _ = try current.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "request",
          amounts: ["other-item": 100], reason: "退回差额", purpose: "price_adjustment")
      }, "foreign item cannot be allocated to original payment")
    let funds = try changedPayment { payment in
      var items = payment["refundableItems"] as! [[String: Any]]
      items[0]["fundsOnly"] = true
      payment["refundableItems"] = items
    }
    for purpose in ["return_goods", "service_compensation"] {
      check(
        rejected {
          _ = try funds.command(
            actor: actor, orderID: "order1", paymentID: "pay1", action: "request",
            amounts: ["item1": 100], reason: "退回差额", purpose: purpose)
        }, "funds-only allocation rejects \(purpose)")
    }
    var deniedAuth = auth
    deniedAuth["deniedPermissions"] = ["refund.approve"]
    let denied = try JSONDecoder().decode(StaffIdentity.self, from: bytes(deniedAuth))
    check(
      rejected {
        _ = try current.command(
          actor: denied, orderID: "order1", paymentID: "pay1", action: "approve",
          refundID: "refund1", reason: "核对通过")
      }, "explicit deny overrides refund approval grant")
    var disabledRaw = raw
    disabledRaw["actions"] = ["canRequestRefund": false]
    let disabled = try board(disabledRaw)
    check(
      rejected {
        _ = try disabled.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "request",
          amounts: ["item1": 100], reason: "退回差额", purpose: "price_adjustment")
      }, "server workbench flag independently blocks refund")
    let own = try changedRefund { $0["requestedByEmployeeId"] = actor.employee.id }
    for action in ["approve", "reject"] {
      check(
        rejected {
          _ = try own.command(
            actor: actor, orderID: "order1", paymentID: "pay1", action: action, refundID: "refund1",
            reason: "核对通过")
        }, "requester cannot \(action) own refund")
    }
    let decision = try current.command(
      actor: actor, orderID: "order1", paymentID: "pay1", action: "approve", refundID: "refund1",
      reason: "核对原款通过")
    check(
      decision.permission == "refund.approve"
        && decision.steps[0].object["reason"] as? String == "核对原款通过",
      "different employee approval retains reason")
    let associated = try changedRefund {
      $0["afterSalesCase"] = [
        "caseId": "case1", "orderItemId": "item1", "status": "requested",
        "allocations": request.steps[0].object["allocations"]!,
      ]
    }
    check(
      rejected {
        _ = try associated.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "approve",
          refundID: "refund1", reason: "核对通过")
      }, "associated item case cannot bypass original after-sales approval")
    check(
      rejected {
        _ = try current.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "execute", refundID: "refund1"
        )
      }, "requested refund cannot execute before approval")
    let processing = try changedRefund { $0["status"] = "processing" }
    let manual = try processing.command(
      actor: actor, orderID: "order1", paymentID: "pay1", action: "manual-result",
      refundID: "refund1", succeeded: true)
    check(
      manual.steps[0].object["receiptReference"] == nil
        && manual.steps[0].object["succeeded"] as? Bool == true,
      "cash refund receipt is assigned by server after physical confirmation")
    let online = try changedPayment { p in
      p["provider"] = "postar"
      var refs = p["refunds"] as! [[String: Any]]
      refs[0]["status"] = "processing"
      refs[0]["providerSubmissionState"] = "submitted"
      p["refunds"] = refs
    }
    check(
      rejected {
        _ = try online.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "manual-result",
          refundID: "refund1")
      }, "online refund cannot be manually marked paid")
    check(
      rejected {
        _ = try online.command(
          actor: actor, orderID: "order1", paymentID: "pay1", action: "execute", refundID: "refund1"
        )
      }, "submitted online refund cannot be executed again")
    let query = try online.command(
      actor: actor, orderID: "order1", paymentID: "pay1", action: "refund-query",
      refundID: "refund1")
    let pending = try bytes(["data": ["status": "processing"], "meta": ["replayed": false]])
    try validateCashierReply(pending, step: query.steps[0])
    check(true, "channel query processing is a completed query not a successful refund")
    var receipt: [String: Any] = [
      "id": "new-refund", "publicId": request.steps[0].cashierProof!["refundPublicId"]!,
      "paymentId": "pay1", "amountMinor": 2000, "currency": "CNY", "status": "requested",
      "allocations": request.steps[0].object["allocations"]!,
    ]
    var response = try bytes(["data": receipt, "meta": ["replayed": true]])
    var sent: [URLRequest] = []
    var lost = true
    let api = StaffAPI(transport: { req in
      sent.append(req)
      if lost {
        lost = false
        throw URLError(.timedOut)
      }
      return (
        response,
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    })
    do {
      try await api.execute(request.steps[0])
      preconditionFailure()
    } catch {}
    try await api.execute(restored.steps[0])
    check(
      sent.count == 2 && sent[0].httpBody == sent[1].httpBody
        && sent[0].value(forHTTPHeaderField: "idempotency-key")
          == sent[1].value(forHTTPHeaderField: "idempotency-key"),
      "lost refund acknowledgement retries identical original body and key")
    receipt["amountMinor"] = 1999
    response = try bytes(["data": receipt, "meta": ["replayed": true]])
    do {
      try await api.execute(request.steps[0])
      preconditionFailure()
    } catch {}
    check(true, "wrong refund amount never clears original request")
    receipt["amountMinor"] = 2000
    receipt["paymentId"] = "another-payment"
    response = try bytes(["data": receipt, "meta": ["replayed": true]])
    check(
      rejected { try validateCashierReply(response, step: request.steps[0]) },
      "wrong original payment cannot acknowledge refund")
    let passive = try online.command(
      actor: actor, orderID: "order1", paymentID: "pay1", action: "payment-query")
    let passiveReply = try bytes([
      "data": [
        "publicId": "PAY-one", "status": "closed", "queryObservation": ["status": "processing"],
      ], "meta": ["replayed": false, "localStatusRetained": true],
    ])
    try validateCashierReply(passiveReply, step: passive.steps[0])
    check(true, "local closure with pending channel observation remains a query result")

    receipt["paymentId"] = "pay1"
    receipt["allocations"] = [["orderItemId": "foreign", "amountMinor": 2000]]
    check(
      rejected {
        try validateCashierReply(
          try bytes(["data": receipt, "meta": ["replayed": true]]), step: request.steps[0])
      }, "refund receipt must match original item allocations")
    let historyBytes = try Data(contentsOf: dir.appending(path: "live-history.json"))
    let history = try JSONDecoder().decode(LiveHistory.self, from: historyBytes)
    let csvBytes = try history.exportCSV()
    let csv = String(data: csvBytes, encoding: .utf8)!
    check(
      Array(csvBytes.prefix(3)) == [0xEF, 0xBB, 0xBF] && csv.contains("\r\n"),
      "export is UTF8 BOM with spreadsheet compatible row breaks")
    check(
      csv.contains("\"2026-09-26 23:00:00\""),
      "CSV uses explicit Shanghai time rather than device timezone")
    check(
      csv.contains("\"套餐内商品，不另收费\",\"\",\"\""),
      "bundle included lines do not invent a second charge")
    check(
      csv.hasSuffix("\"\",\"\",\"\",\"\""),
      "missing preparation and delivery evidence remains blank")
    check(
      LiveHistory.csvCell("=SUM(1,2)") == "\"'=SUM(1,2)\""
        && LiveHistory.csvCell("酒,\"杯\"\n备注") == "\"酒,\"\"杯\"\"\n备注\"",
      "CSV escapes formulas quotes commas and line breaks")
    check(
      historyExportAmount(1001) == "10.01" && historyExportAmount(-1) == "-0.01",
      "CSV money retains exact cents as numeric text")
    check(
      LiveHistory.csvCell("\r\n=1").hasPrefix("\"'"),
      "CSV protects leading CRLF as well as a single newline")
    let filters = HistoryQuery(table: "A&employee=other+5", employee: "本员工")
    let exportURL = URLComponents(string: try filters.exportPath(page: 3, all: true))!
    check(
      exportURL.queryItems?.first(where: { $0.name == "table" })?.value == filters.table
        && exportURL.queryItems?.first(where: { $0.name == "page" })?.value == "0"
        && exportURL.queryItems?.first(where: { $0.name == "exportAll" })?.value == "true",
      "all export preserves literal filters and resets pagination")
    check(
      try filters.exportPath(page: 3, all: false).contains("page=3")
        && !filters.exportPath(page: 3, all: false).contains("exportAll"),
      "page export keeps selected page")
    var oversized = try JSONSerialization.jsonObject(with: historyBytes) as! [String: Any]
    oversized["orders"] = Array(
      repeating: (oversized["orders"] as! [[String: Any]])[0], count: 5001)
    check(
      rejected {
        _ = try JSONDecoder().decode(LiveHistory.self, from: bytes(oversized)).exportCSV()
      }, "over-limit CSV refuses rather than silently truncates")
    var cashierOnly = auth
    cashierOnly["permissions"] = ["payment.manual.cash.record"]
    let cashierActor = try JSONDecoder().decode(StaffIdentity.self, from: bytes(cashierOnly))
    let due = LivePaymentOrder(
      id: "o1", publicId: "O1", currency: "CNY", paymentStatus: "unpaid",
      outstandingAmountMinor: 500, hasOnlinePaymentInProgress: false, unresolvedOnlinePaymentId: nil
    )
    let collection = try LiveCommand.manualCollection(
      orders: [due], actor: cashierActor, amount: 500, provider: "cash", reference: "",
      terminal: "", method: "", note: "", session: "original-session")
    let oldCollection = try JSONDecoder().decode(
      LiveCommand.self, from: JSONEncoder().encode(collection))
    check(
      oldCollection.steps[0].collectionSession == "original-session"
        && oldCollection.steps[0].object["collectionSession"] == nil,
      "cashier-only role retains original session for readback without changing server payload")
    let recoveryRaw =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-cashier-recovery.json"))) as! [String: Any]
    var recoveryAuth = auth
    recoveryAuth["permissions"] = [
      "payment.recollect.authorize", "payment.initiate.staff", "reconciliation.view",
      "payment.collect.all_tables",
    ]
    let manager = try JSONDecoder().decode(StaffIdentity.self, from: bytes(recoveryAuth))
    func recoveryBoard(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> LiveCashier {
      var source = recoveryRaw
      var rows = source["orders"] as! [[String: Any]]
      change(&rows[0])
      source["orders"] = rows
      return try board(source)
    }
    func close(_ b: LiveCashier, _ who: StaffIdentity? = nil, reason: String = "核对原款未对外展示") throws
      -> LiveCommand
    {
      try b.command(
        actor: who ?? manager, orderID: "order1", paymentID: "pay1", action: "close-history",
        reason: reason)
    }
    let recovery = try recoveryBoard()
    let closure = try close(recovery)
    check(
      closure.steps[0].cashierProof?["amountMinor"] as? Int == 15000
        && closure.title.contains(money(15000)),
      "history closure binds whole batch instead of displayed allocation")
    check(
      (closure.steps[0].cashierProof?["confirmation"] as? String)?.contains("APP-second") == true,
      "history close confirmation includes all original order public ids")
    check(
      try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(closure)) == closure,
      "history close restart retains scope reason key and body")
    for permission in [
      "payment.recollect.authorize", "payment.initiate.staff", "reconciliation.view",
      "payment.collect.all_tables",
    ] {
      var blocked = recoveryAuth
      blocked["deniedPermissions"] = [permission]
      let who = try JSONDecoder().decode(StaffIdentity.self, from: bytes(blocked))
      check(
        rejected { _ = try close(recovery, who) },
        "history closure enforces denied capability \(permission)")
    }
    check(
      rejected { _ = try close(recovery, reason: "核对") },
      "history closure requires meaningful reason")
    for state in ["available", "settled", "permission_required"] {
      let invalid = try recoveryBoard { o in
        var r = o["closedDebtRecovery"] as! [String: Any]
        r["status"] = state
        o["closedDebtRecovery"] = r
      }
      check(rejected { _ = try close(invalid) }, "history closure rejects recovery state \(state)")
    }
    let missingScope = try recoveryBoard { o in
      var r = o["closedDebtRecovery"] as! [String: Any]
      r.removeValue(forKey: "closableUnpresentedPayments")
      o["closedDebtRecovery"] = r
    }
    check(
      rejected { _ = try close(missingScope) },
      "legacy close ids alone cannot invent full batch scope")
    let closeData: [String: Any] = [
      "id": "pay1", "publicId": "PAY-one", "amountMinor": 15000, "currency": "CNY",
      "status": "closed", "payableKind": "order_batch",
      "providerSnapshot": [String: String](),
    ]
    try validateCashierReply(
      try bytes(["data": closeData, "meta": ["replayed": true]]), step: closure.steps[0])
    check(true, "whole original local-close receipt validates")
    for (key, bad): (String, Any) in [
      ("amountMinor", 10000), ("id", "another"), ("status", "pending"), ("payableKind", "order"),
    ] {
      var wrong = closeData
      wrong[key] = bad
      check(
        rejected {
          try validateCashierReply(
            try bytes(["data": wrong, "meta": ["replayed": true]]), step: closure.steps[0])
        }, "history closure rejects wrong \(key)")
    }
    let authorizeBoard = try recoveryBoard { o in
      var r = o["closedDebtRecovery"] as! [String: Any]
      r["status"] = "authorization_required"
      o["closedDebtRecovery"] = r
    }
    let authorization = try authorizeBoard.command(
      actor: manager, orderID: "order1", paymentID: "", action: "recollect", reason: "客人同意再次支付")
    check(
      authorization.steps[0].path == "/api/orders/order1/recollection-authorizations"
        && authorization.steps[0].cashierProof?["amountMinor"] as? Int == 2000,
      "recollection binds original order and confirmed due without requiring payment selection")
    check(
      rejected {
        _ = try recovery.command(
          actor: manager, orderID: "order1", paymentID: "", action: "recollect", reason: "客人同意再次支付")
      }, "pending original payment cannot be bypassed by recollection authorization")
    let authData: [String: Any] = [
      "id": "auth1", "publicId": "recollect-one", "orderId": "order1", "amountMinor": 2000,
      "currency": "CNY", "reason": "客人同意再次支付", "authorizedByEmployeeId": manager.employee.id,
      "expiresAt": "2026-09-27T02:00:00Z", "createdAt": "2026-09-27T01:30:00Z",
    ]
    try validateCashierReply(
      try bytes(["data": authData, "meta": ["replayed": true]]), step: authorization.steps[0])
    check(
      true,
      "authorization receipt has no payment status and replayed expiry is not new collection permission"
    )
    for (key, bad): (String, Any) in [
      ("amountMinor", 2100), ("orderId", "other"), ("authorizedByEmployeeId", "other"),
      ("reason", "changed"),
    ] {
      var wrong = authData
      wrong[key] = bad
      check(
        rejected {
          try validateCashierReply(
            try bytes(["data": wrong, "meta": ["replayed": true]]), step: authorization.steps[0])
        }, "recollection receipt rejects changed \(key)")
    }
    var recoverySent: [URLRequest] = []
    var recoveryLost = true
    let recoveryAPI = StaffAPI(transport: { req in
      recoverySent.append(req)
      if recoveryLost {
        recoveryLost = false
        throw URLError(.timedOut)
      }
      return (
        try bytes(["data": closeData, "meta": ["replayed": true]]),
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    })
    do {
      try await recoveryAPI.execute(closure.steps[0])
      preconditionFailure()
    } catch {}
    let reopened = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(closure))
    try await recoveryAPI.execute(reopened.steps[0])
    check(
      recoverySent.count == 2 && recoverySent[0].httpBody == recoverySent[1].httpBody
        && recoverySent[0].value(forHTTPHeaderField: "idempotency-key")
          == recoverySent[1].value(forHTTPHeaderField: "idempotency-key"),
      "lost history-close reply reuses persisted original idempotency request")
    let historicalRaw =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-historical-collection.json")))
      as! [String: Any]
    var collectorAuth = recoveryAuth
    collectorAuth["permissions"] = [
      "payment.manual.cash.record", "payment.manual.pos.record", "payment.manual.external.record",
      "payment.recollect.authorize", "payment.collect.all_tables",
    ]
    let collector = try JSONDecoder().decode(StaffIdentity.self, from: bytes(collectorAuth))
    func historicalBoard(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> LiveCashier {
      var raw = historicalRaw
      change(&raw)
      return try board(raw)
    }
    let historical = try historicalBoard()
    func collect(
      _ b: LiveCashier, provider: String = "cash", tender: Int? = 3000, ref: String = "POS-001",
      method: String = "bank_transfer", note: String = "核对实际转账到账", who: StaffIdentity? = nil,
      order: LiveCashier.Order? = nil
    ) throws -> LiveCommand {
      try b.historicalCollection(
        actor: who ?? collector, order: order ?? b.orders[0], provider: provider, tender: tender,
        reference: ref, terminal: provider == "cash" ? "" : "POS-01", method: method, note: note)
    }
    let cashHistory = try collect(historical)
    let cashBody = cashHistory.steps[0].object
    check(
      cashHistory.steps[0].path == "/api/payments/manual/closed-debt"
        && cashBody["amountMinor"] == nil && cashBody["orderIds"] == nil
        && cashBody["orderId"] as? String == "order1",
      "historical full collection never selects batch partial payment contract")
    check(
      (cashBody["closedDebtGuard"] as? [String: Any])?["amountMinor"] as? Int == 2000
        && cashHistory.steps[0].collectionSession == nil
        && cashHistory.steps[0].cashierProof != nil,
      "history binds confirmed amount and refreshes cashier rather than closed session payment list"
    )
    check(
      (cashHistory.steps[0].cashierProof?["confirmation"] as? String)?.contains("找零：" + money(1000))
        == true, "historical cash tender and change do not inflate recorded amount")
    for amount: Int? in [nil, 1999] {
      check(
        rejected { _ = try collect(historical, tender: amount) },
        "historical cash requires sufficient actual tender")
    }
    for provider in ["physical_pos", "external_manual"] {
      check(
        rejected { _ = try collect(historical, provider: provider, ref: "") },
        "history \(provider) requires original receipt")
    }
    check(
      rejected { _ = try collect(historical, provider: "external_manual", method: "invalid") },
      "history external method whitelist enforced")
    check(
      rejected { _ = try collect(historical, provider: "external_manual", note: "") },
      "history external actual collection explanation required")
    let oldServer = try historicalBoard {
      var flags = $0["actions"] as! [String: Any]
      flags.removeValue(forKey: "supportsGuardedClosedDebtCollection")
      $0["actions"] = flags
    }
    check(
      rejected { _ = try collect(oldServer) },
      "old server lacking guarded capability never receives history collection")
    for permission in [
      "payment.manual.cash.record", "payment.collect.all_tables", "payment.recollect.authorize",
    ] {
      var denied = collectorAuth
      denied["deniedPermissions"] = [permission]
      let who = try JSONDecoder().decode(StaffIdentity.self, from: bytes(denied))
      check(
        rejected { _ = try collect(historical, who: who) },
        "history collection enforces denied \(permission)")
    }
    for field in ["amount", "session", "authorization", "pending"] {
      let changed = try historicalBoard { raw in
        var rows = raw["orders"] as! [[String: Any]]
        if field == "amount" { rows[0]["outstandingAmountMinor"] = 2500 }
        if field == "session" { rows[0]["tableSessionId"] = "new-session" }
        if field == "authorization" {
          var a = rows[0]["recollectionAuthorization"] as! [String: Any]
          a["id"] = "new-authorization"
          rows[0]["recollectionAuthorization"] = a
        }
        if field == "pending" {
          var r = rows[0]["closedDebtRecovery"] as! [String: Any]
          r["pendingPaymentIds"] = ["pay-unknown"]
          rows[0]["closedDebtRecovery"] = r
        }
        raw["orders"] = rows
      }
      check(
        rejected { _ = try collect(changed, order: historical.orders[0]) },
        "stale form rejects changed \(field) before send")
    }
    let externalHistory = try collect(historical, provider: "external_manual")
    func collectionReceipt(_ command: LiveCommand) -> [String: Any] {
      let body = command.steps[0].object
      var evidence: [String: Any] = [
        "collectedByEmployeeId": collector.employee.id,
        "receiptReference": body["receiptReference"]!,
      ]
      for key in ["terminalId", "externalMethodCode", "collectionNote"] {
        evidence[key] = body[key]
      }
      return [
        "id": "payment-history", "publicId": body["publicId"]!, "orderId": "order1",
        "payableKind": "order", "amountMinor": 2000, "currency": "CNY", "status": "succeeded",
        "provider": body["provider"]!, "method": body["method"]!,
        "providerTransactionId": body["receiptReference"]!, "providerSnapshot": evidence,
      ]
    }
    for command in [
      cashHistory, externalHistory, try collect(historical, provider: "physical_pos"),
    ] {
      try validateCashierReply(
        try bytes(["data": collectionReceipt(command), "meta": ["replayed": true]]),
        step: command.steps[0])
      check(true, "historical \(command.steps[0].object["provider"]!) exact receipt validated")
    }
    for (key, value): (String, Any) in [
      ("amountMinor", 3000), ("orderId", "another"), ("status", "pending"),
      ("payableKind", "order_batch"), ("providerTransactionId", "wrong-receipt"),
      ("currency", "USD"),
    ] {
      var receipt = collectionReceipt(cashHistory)
      receipt[key] = value
      check(
        rejected {
          try validateCashierReply(
            try bytes(["data": receipt, "meta": ["replayed": false]]), step: cashHistory.steps[0])
        }, "historical receipt rejects wrong \(key)")
    }
    var wrongEvidence = collectionReceipt(externalHistory)
    var evidence = wrongEvidence["providerSnapshot"] as! [String: Any]
    evidence["collectedByEmployeeId"] = "other"
    wrongEvidence["providerSnapshot"] = evidence
    check(
      rejected {
        try validateCashierReply(
          try bytes(["data": wrongEvidence, "meta": ["replayed": true]]),
          step: externalHistory.steps[0])
      }, "historical receipt rejects wrong collector")
    var sentHistory: [URLRequest] = []
    var lostHistory = true
    let historicalAPI = StaffAPI(transport: { req in
      sentHistory.append(req)
      if lostHistory {
        lostHistory = false
        throw URLError(.timedOut)
      }
      return (
        try bytes(["data": collectionReceipt(cashHistory), "meta": ["replayed": true]]),
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    })
    do {
      try await historicalAPI.execute(cashHistory.steps[0])
      preconditionFailure()
    } catch {}
    let persisted = try JSONDecoder().decode(
      LiveCommand.self, from: JSONEncoder().encode(cashHistory))
    try await historicalAPI.execute(persisted.steps[0])
    check(
      sentHistory[0].httpBody == sentHistory[1].httpBody
        && sentHistory[0].value(forHTTPHeaderField: "idempotency-key")
          == sentHistory[1].value(forHTTPHeaderField: "idempotency-key"),
      "lost historical receipt resumes exact guarded original request after restart")
    check(
      StaffAPIError(
        status: 409, code: "HISTORICAL_COLLECTION_CHANGED", message: "changed",
        commitDisposition: "not_committed"
      ).definitivelyRejected,
      "explicit rolled-back history guard failure can be acknowledged and refreshed")
    check(
      !StaffAPIError(status: 409, code: "HISTORICAL_COLLECTION_CHANGED", message: "changed")
        .definitivelyRejected, "missing not-committed proof keeps historical request unresolved")
    check(
      !StaffAPIError(
        status: 409, code: "FINANCIAL_REFERENCE_CONFLICT", message: "duplicate",
        commitDisposition: "not_committed"
      ).definitivelyRejected, "duplicate financial receipt still needs original payment lookup")
    print("\(count) cashier checks passed")
  }
}
