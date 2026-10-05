import Foundation

@main struct PaymentCompletionTests {
  @MainActor static func main() async throws {
    let base = URL(fileURLWithPath: CommandLine.arguments[1])
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: base.appendingPathComponent("live-payment-completion.json")))
      as! [String: Any]
    func bytes(_ x: Any) throws -> Data {
      try JSONSerialization.data(withJSONObject: x, options: .sortedKeys)
    }
    func decode<T: Decodable>(_ type: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(type, from: bytes(x))
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let af = try decode(LiveAfterSales.self, f["afterSales"]!)
    var count = 0
    func check(_ yes: Bool, _ name: String) {
      precondition(yes, name)
      count += 1
      print("PASS \(name)")
    }
    func rejects(_ block: () throws -> Void) -> Bool {
      do {
        try block()
        return false
      } catch { return true }
    }
    try af.validate(itemID: "item-original")
    check(rejects { try af.validate(itemID: "different") }, "cross-item response rejected")
    let request = try af.command(actor: actor, action: "request", quantity: 1, reason: "客人取消")
    check(
      request.steps[0].object["orderItemId"] as? String == af.item.id,
      "bundle component can request original item after-sales")
    check(
      rejects { _ = try af.command(actor: actor, action: "request", quantity: 2, reason: "客人取消") },
      "held quantity cannot be requested twice")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "approved", caseID: "case-original", reason: "核对原款",
          funding: ["payment-cash": 8000])
      }, "funding cannot exceed original payment cap")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "approved", caseID: "case-original", reason: "核对原款",
          funding: ["payment-cash": 3000, "payment-pos": 3000])
      }, "funding must equal server-calculated original amount")
    let approval = try af.command(
      actor: actor, action: "approved", caseID: "case-original", reason: "核对原款",
      funding: ["payment-cash": 4000, "payment-pos": 4000])
    check(
      (approval.steps[0].afterSalesProof?["confirmation"] as? String)?.contains("payment-cash")
        == true, "review freezes each original funding source")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "returned_unopened", caseID: "case-original", reason: "实物核对",
          unitIDs: ["unit-free"], confirmed: true)
      }, "cannot return a different unit")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "returned_unopened", caseID: "case-original", reason: "实物核对",
          unitIDs: ["unit-unmade"], confirmed: true)
      }, "unmade reservations cannot be misrecorded as received goods")
    let physical = try af.command(
      actor: actor, action: "returned_unopened", caseID: "case-original", reason: "实物核对",
      unitIDs: ["unit-held"], confirmed: true)
    check(
      physical.steps[0].object["unopenedReceived"] as? Bool == true,
      "confirmed original unopened return is explicit")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "notice-ack", caseID: "case-original", reason: "岗位确认")
      }, "notice needs explicit real acknowledgement")
    let notice = try af.command(
      actor: actor, action: "notice-ack", caseID: "case-original", reason: "岗位确认", confirmed: true)
    check(
      (notice.steps[0].afterSalesProof?["confirmation"] as? String)?.contains("暂停两瓶") == true,
      "notice confirmation includes original instruction")
    check(
      rejects {
        _ = try af.command(
          actor: actor, action: "cash-paid", caseID: "case-original", reason: "实退确认",
          refundID: "refund-original", confirmed: true)
      }, "online refund can never be manually marked cash paid")
    _ = try af.command(
      actor: actor, action: "refund-retry", caseID: "case-original", reason: "原失败重试",
      refundID: "refund-original")
    var reply: [String: Any] = [
      "replayed": false,
      "data": [
        "caseId": "new-case", "orderId": "order-original", "selectedQuantity": 1,
        "physicalComplete": false, "moneyComplete": false, "succeededMinor": 0,
      ],
    ]
    try validateAfterSalesReply(bytes(reply), step: request.steps[0])
    count += 1
    var d = reply["data"] as! [String: Any]
    d["orderId"] = "other-order"
    reply["data"] = d
    check(
      rejects { try validateAfterSalesReply(bytes(reply), step: request.steps[0]) },
      "after-sales ack bound to original order")
    var auth = f["auth"] as! [String: Any]
    auth["deniedPermissions"] = ["inventory.receive", "refund.approve"]
    let denied = try decode(StaffIdentity.self, auth)
    check(
      rejects {
        _ = try af.command(
          actor: denied, action: "approved", caseID: "case-original", reason: "核对原款",
          funding: ["payment-cash": 4000, "payment-pos": 4000])
      }, "explicit denial wins over refund capability")
    let board = try decode(LiveCashier.self, f["cashier"]!)
    func activity(
      _ b: LiveCashier? = nil, _ action: String = "collect", provider: String = "cash",
      ref: String = "", terminal: String = "", reason: String = "现场收款", confirmed: Bool = true
    ) throws -> LiveCommand {
      try (b ?? board).activityCommand(
        actor: actor, registrationID: "activity-reg", action: action, provider: provider,
        reference: ref, terminal: terminal, reason: reason, confirmed: confirmed)
    }
    let cash = try activity()
    check(
      cash.steps[0].object["expectedAmountMinor"] as? Int == 8800,
      "activity freezes original due in request")
    check(
      rejects { _ = try activity(confirmed: false) },
      "cash cannot be recorded without actual receipt confirmation")
    check(
      rejects { _ = try activity(provider: "physical_pos", ref: "POS-123") },
      "activity POS requires terminal evidence")
    check(
      rejects { _ = try activity(provider: "external_manual", ref: "TX-123", reason: " ") },
      "other tender requires substantive receipt note")
    var src = f["cashier"] as! [String: Any]
    var flags = src["actions"] as! [String: Any]
    flags["supportsGuardedActivityCashier"] = false
    src["actions"] = flags
    check(
      rejects { _ = try activity(decode(LiveCashier.self, src)) },
      "old server cannot accept unguarded activity operations")
    src = f["cashier"] as! [String: Any]
    var rows = src["activityRegistrations"] as! [[String: Any]]
    rows[0]["lateSuccessPayments"] = [
      [
        "publicId": "LATE-ORIGINAL", "amountMinor": 8800, "remainingRefundableMinor": 8800,
        "currency": "CNY",
      ]
    ]
    src["activityRegistrations"] = rows
    let late = try decode(LiveCashier.self, src)
    check(
      rejects { _ = try activity(late) }, "late success old money blocks replacement collection")
    let lateRequest = try late.activityCommand(
      actor: actor, registrationID: "activity-reg", action: "refund", reason: "迟到旧款退回",
      paymentPublicID: "LATE-ORIGINAL")
    check(
      lateRequest.steps[0].object["expectedPaymentPublicId"] as? String == "LATE-ORIGINAL",
      "late refund freezes original payment across subsequent cycles")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(cash))
    check(restored == cash, "activity persisted command preserves original payload and key")
    let cashData: [String: Any] = [
      "id": "payment-original", "publicId": cash.steps[0].object["publicId"]!,
      "payableKind": "activity_registration", "activityRegistrationId": "activity-reg",
      "amountMinor": 8800, "currency": "CNY", "status": "succeeded", "provider": "cash",
      "method": "cash", "providerSnapshot": ["collectedByEmployeeId": actor.employee.id],
    ]
    try validateActivityReply(
      bytes(["meta": ["replayed": true], "data": cashData]), step: cash.steps[0])
    count += 1
    var wrong = cashData
    wrong["amountMinor"] = 8801
    check(
      rejects {
        try validateActivityReply(
          bytes(["meta": ["replayed": false], "data": wrong]), step: cash.steps[0])
      }, "changed activity money never acknowledged as intended receipt")
    var jobData = f["printJob"] as! [String: Any]
    let job = try decode(LivePrintJob.self, jobData)
    _ = try printingCommand(
      actor: actor, kind: "retry", target: job.id, reason: "缺纸已补充", job: job, confirmed: true)
    jobData["failureCode"] = "print_result_unknown"
    let unknown = try decode(LivePrintJob.self, jobData)
    check(
      rejects {
        _ = try printingCommand(
          actor: actor, kind: "retry", target: job.id, reason: "结果不明", job: unknown, confirmed: true
        )
      }, "unknown paper result cannot retry old job")
    check(
      rejects {
        _ = try printingCommand(
          actor: actor, kind: "reprint", target: job.id, reason: "已核对小票", job: job)
      }, "reprint requires actual verification")
    jobData["status"] = "printing"
    let inFlight = try decode(LivePrintJob.self, jobData)
    check(
      rejects {
        _ = try printingCommand(
          actor: actor, kind: "reprint", target: job.id, reason: "已核对小票", job: inFlight,
          confirmed: true)
      }, "inflight original job cannot produce a second copy")
    let reprint = try printingCommand(
      actor: actor, kind: "reprint", target: job.id, reason: "原单出纸模糊", job: job, confirmed: true)
    var printData: [String: Any] = [
      "id": "22222222-2222-4222-8222-222222222222", "status": "pending", "reprintOfJobId": job.id,
      "reprintReason": "原单出纸模糊",
    ]
    try validatePrintReply(bytes(["replayed": false, "data": printData]), step: reprint.steps[0])
    count += 1
    printData["reprintOfJobId"] = "wrong-job"
    check(
      rejects {
        try validatePrintReply(
          bytes(["replayed": false, "data": printData]), step: reprint.steps[0])
      }, "reprint ack must identify exact original immutable snapshot")
    check(
      rejects { _ = try printingCommand(actor: actor, kind: "report", target: "2026-02-30") },
      "invalid business date cannot print unrelated report")
    let handover = try decode(CashHandoverBoard.self, f["cashHandover"]!)
    check(
      rejects {
        _ = try cashHandoverCommand(
          actor: actor, board: handover, action: "approve", amount: 8100, reason: "独立核对原现金")
      }, "cash counter cannot approve own actual count")
    var reviewerAuth = f["auth"] as! [String: Any]
    var employee = reviewerAuth["employee"] as! [String: Any]
    employee["id"] = "another-reviewer"
    reviewerAuth["employee"] = employee
    var rs = reviewerAuth["session"] as! [String: Any]
    rs["employeeId"] = "another-reviewer"
    reviewerAuth["session"] = rs
    let reviewer = try decode(StaffIdentity.self, reviewerAuth)
    let handoverApproval = try cashHandoverCommand(
      actor: reviewer, board: handover, action: "approve", amount: 8100, reason: "独立核对原现金")
    check(
      handoverApproval.steps[0].object["expectedRevision"] as? Int == 3,
      "cash approval freezes exact revision and difference")
    check(
      rejects {
        _ = try cashHandoverCommand(
          actor: reviewer, board: handover, action: "approve", amount: 8200, reason: "金额不符禁止交接")
      }, "independent count mismatch is blocked")
    var changed = f["cashHandover"] as! [String: Any]
    changed["ledger"] = ["net": 200, "count": 3]
    check(
      rejects {
        _ = try cashHandoverCommand(
          actor: reviewer, board: decode(CashHandoverBoard.self, changed), action: "approve",
          amount: 8100, reason: "新增现金流水检查")
      }, "cash movement count catches offsetting payment and refund")
    check(rejects { _ = try cashCount(["3": 1]) }, "unknown cash denomination rejected")
    let counted = try cashCount(["10000": 1, "50": 2])
    check(counted == 10100, "cash denominations use integer minor units")
    let voucher = try voucherRedeem(
      actor: actor, preview: decode(VoucherPreview.self, f["voucherPreview"]!),
      platform: decode(VoucherPlatform.self, f["voucherPlatform"]!), code: "ORIGINAL-VOUCHER-CODE",
      confirmed: true)
    var secret = ""
    let safe = try secureVoucherCommand(voucher) { _, value in secret = value }
    check(
      safe.steps[0].object["voucherCode"] == nil && safe.steps[0].object["prepareHandle"] == nil,
      "voucher secrets removed from ordinary journal")
    let restoredVoucher = try voucherRequestBody(safe.steps[0]) { _ in secret }
    check(
      restoredVoucher["voucherCode"] as? String == "ORIGINAL-VOUCHER-CODE",
      "voucher retry reconstructs exact secret from secure storage")
    check(
      rejects {
        _ = try secureVoucherCommand(voucher) { _, _ in throw CatalogError("storage failed") }
      }, "failed secure storage blocks voucher dispatch")
    let operation = try decode(VoucherOperation.self, f["voucherOperation"]!)
    check(
      rejects {
        _ = try voucherFollowup(actor: actor, row: operation, action: "approve", confirmed: true)
      }, "voucher evidence maker cannot approve self")
    let rejection = try voucherFollowup(
      actor: reviewer, row: operation, action: "reject", reason: "原证据需要补充", confirmed: true)
    check(
      rejection.steps[0].object["reviewId"] as? String == operation.review?.id,
      "voucher rejection freezes original evidence revision")
    check(
      !StaffAPIError(status: 409, code: "VOUCHER_OPERATION_REVIEW", message: "unknown")
        .definitivelyRejected, "ambiguous voucher response preserves original intent")
    check(
      StaffAPIError(
        status: 409, code: "CASH_HANDOVER_CHANGED", message: "stale",
        commitDisposition: "not_committed"
      ).definitivelyRejected, "proven rolled back cash count can be corrected")
    check(
      !StaffAPIError(status: 400, code: "FINANCE_REVIEW_FAILED", message: "unknown")
        .definitivelyRejected, "legacy finance failure is not assumed rolled back")
    let reuse = f["onlineReuse"] as! [String: Any]
    let originalStep = LiveCommand.Step(
      path: "/api/payments", body: try bytes(reuse["body"]!), keyHeader: "idempotency-key",
      key: reuse["key"] as! String, recoveryBody: try bytes(reuse["proof"]!))
    let validReply = reuse["reply"] as! [String: Any]
    try validateOnlineReply(bytes(validReply), step: originalStep)
    check(true, "server-bound same allocation may reuse original public id")
    for field in ["orderIds", "employeeId", "idempotencyKey", "amountMinor", "paymentId"] {
      var invalid = validReply
      var m = invalid["meta"] as! [String: Any]
      var binding = m["requestBinding"] as! [String: Any]
      binding[field] =
        field == "orderIds" ? ["another-order"] : field == "amountMinor" ? 9999 : "wrong"
      m["requestBinding"] = binding
      invalid["meta"] = m
      check(
        rejects { try validateOnlineReply(bytes(invalid), step: originalStep) },
        "reuse rejects changed \(field)")
    }
    var originalVoucher = f["voucherOperation"] as! [String: Any]
    originalVoucher["publicId"] = voucher.steps[0].object["publicId"]!
    var voucherSends = 0
    var secretReads = 0
    try await performVoucherStep(
      safe.steps[0], read: { _ in try bytes(["meta": ["protocol": 1], "data": originalVoucher]) },
      send: { _ in
        voucherSends += 1
        throw StaffAPIError.invalid
      },
      secret: { _ in
        secretReads += 1
        throw CatalogError("secure storage lost")
      })
    check(
      voucherSends == 0 && secretReads == 0,
      "durable original voucher recovers even after device secret is unreadable")
    count += try await afterSalesManualRecovery(f)
    print("\(count) payment-completion checks passed")
  }
}


// Exercise the persisted command through StaffAPI's real request and response adapter.
@MainActor private func afterSalesManualRecovery(_ fixture: [String: Any]) async throws -> Int {
  var count = 0
  func check(_ value: Bool, _ name: String) {
    precondition(value, name)
    count += 1
    print("PASS " + name)
  }
  func bytes(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
  }
  func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
    try JSONDecoder().decode(type, from: bytes(value))
  }
  func rejects(_ action: () throws -> Void) -> Bool {
    do { try action(); return false } catch { return true }
  }
  let actor = try decode(StaffIdentity.self, fixture["auth"]!)
  func board(_ provider: String, _ status: String = "approved", amount: Int = 8000) throws -> LiveAfterSales {
    var value = fixture["afterSales"] as! [String: Any]
    var cases = value["cases"] as! [[String: Any]]
    cases[0]["refunds"] = [["id": "refund-original", "provider": provider,
      "status": status, "amountMinor": amount, "canRetry": false]]
    value["cases"] = cases
    return try decode(LiveAfterSales.self, value)
  }
  func command(_ board: LiveAfterSales, action: String? = nil, confirmed: Bool = true,
    receipt: String = "POS-ORIGINAL-REFUND") throws -> LiveCommand {
    try board.command(actor: actor,
      action: action ?? (board.cases[0].refunds[0].provider == "cash" ? "cash-paid" : "manual-paid"),
      caseID: "case-original", reason: "原款实退核对", refundID: "refund-original",
      confirmed: confirmed, receiptReference: receipt)
  }
  func response(_ step: LiveCommand.Step, replayed: Bool = false) throws -> Data {
    let proof = step.afterSalesProof!
    return try bytes(["meta": ["replayed": replayed], "data": [
      "id": "refund-original", "paymentId": "original-payment", "orderId": "order-original",
      "amountMinor": 8000, "currency": "CNY",
      "paymentProvider": proof["paymentProvider"] as? String ?? "cash",
      "status": proof["afterSales"] as? String == "manual-begin" ? "processing" : "succeeded",
      "providerRefundId": step.object["receiptReference"] ?? NSNull(),
    ]])
  }
  for provider in ["cash", "physical_pos", "external_manual"] {
    let approved = try board(provider)
    let prepared = try command(approved)
    check(prepared.steps.count == 2 && prepared.steps[0].path.hasSuffix("/execute")
      && prepared.steps[1].path.hasSuffix("/manual-result"), "\(provider) approved executes before final result")
    check(prepared.steps[0].key == prepared.steps[1].key + "-begin"
      && prepared.steps[0].object.isEmpty, "\(provider) both stage keys saved in original intent")
    check(validAfterSalesCommandSelection(command: prepared, board: approved), "\(provider) accepts exact approved selection")
    let processing = try board(provider, "processing")
    let finishing = try command(processing)
    check(finishing.steps.count == 1 && finishing.steps[0].path.hasSuffix("/manual-result"),
      "\(provider) processing never executes again")
    check(validAfterSalesCommandSelection(command: finishing, board: processing)
      && !validAfterSalesCommandSelection(command: finishing, board: approved),
      "\(provider) rejects missing approved begin phase")
    check(rejects { _ = try command(approved, confirmed: false) }, "\(provider) requires actual payout confirmation")
    for status in ["requested", "succeeded", "failed", "cancelled"] {
      check(rejects { _ = try command(board(provider, status)) }, "\(provider) rejects new intent in \(status)")
    }
    if provider != "cash" {
      check(rejects { _ = try command(approved, receipt: " ") }
        && rejects { _ = try command(approved, receipt: String(repeating: "x", count: 257)) },
        "\(provider) rejects missing or oversized original refund receipt")
      check(rejects { _ = try command(approved, action: "cash-paid") }, "\(provider) cannot be declared cash")
      check(finishing.steps[0].object["receiptReference"] as? String == "POS-ORIGINAL-REFUND"
        && (finishing.steps[0].afterSalesProof?["confirmation"] as? String)?.contains("POS-ORIGINAL-REFUND") == true,
        "\(provider) freezes original receipt in payload and confirmation")
    }
    // Simulate server commit followed by a lost reply at each phase. Relaunch from
    // durable bytes then replay exactly the same key; no replacement refund is made.
    for lostPhase in [0, 1] {
      var persisted = try JSONEncoder().encode(prepared)
      var receipts: [String: Data] = [:]
      var committed: [String] = []
      var requests: [URLRequest] = []
      var dropped = false
      let api = StaffAPI(transport: { request in
        requests.append(request)
        guard let key = request.value(forHTTPHeaderField: "idempotency-key"),
          let index = prepared.steps.firstIndex(where: { $0.key == key }),
          request.url?.path == prepared.steps[index].path, request.httpMethod == "POST",
          let body = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: body) as! [String: Any])
            .isEqual(to: prepared.steps[index].object)
        else { throw StaffAPIError.invalid }
        if receipts[key] == nil {
          guard index == committed.count else { throw StaffAPIError.invalid }
          receipts[key] = try response(prepared.steps[index], replayed: true)
          committed.append(key)
        }
        if index == lostPhase && !dropped { dropped = true; throw URLError(.timedOut) }
        return (receipts[key]!, HTTPURLResponse(url: request.url!, statusCode: 200,
          httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
      })
      do {
        _ = try await LiveCommandRunner.advance(prepared, send: { try await api.execute($0) },
          checkpoint: { persisted = try JSONEncoder().encode($0) })
        preconditionFailure("lost response was incorrectly accepted")
      } catch {}
      let restarted = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      check(restarted.completedSteps == lostPhase && restarted.steps == prepared.steps,
        "\(provider) lost phase \(lostPhase) retains both original keys and payloads")
      let recovered = try await LiveCommandRunner.advance(restarted, send: { try await api.execute($0) },
        checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(recovered.completedSteps == 2 && committed == prepared.steps.map(\.key)
        && requests.count == 3, "\(provider) phase \(lostPhase) replays receipt without duplicate commit")
      let sent = requests.count
      _ = try await LiveCommandRunner.advance(recovered, send: { try await api.execute($0) },
        checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(requests.count == sent, "\(provider) completed refresh recovery sends no refund")
    }
    for step in prepared.steps {
      try validateAfterSalesReply(response(step), step: step)
      check(true, "\(provider) accepts exact \(step.afterSalesProof!["afterSales"]!) receipt")
      for (field, wrong): (String, Any) in [("id", "other-refund"), ("orderId", "other-order"),
        ("amountMinor", 8001), ("currency", "USD"), ("paymentProvider", "postar"), ("status", "approved")] {
        var root = try JSONSerialization.jsonObject(with: response(step)) as! [String: Any]
        var data = root["data"] as! [String: Any]
        data[field] = wrong; root["data"] = data
        check(rejects { try validateAfterSalesReply(bytes(root), step: step) },
          "\(provider) \(step.afterSalesProof!["afterSales"]!) rejects wrong \(field)")
      }
    }
    if provider != "cash" {
      let result = prepared.steps[1]
      var root = try JSONSerialization.jsonObject(with: response(result)) as! [String: Any]
      var data = root["data"] as! [String: Any]
      data["providerRefundId"] = "other-receipt"; root["data"] = data
      check(rejects { try validateAfterSalesReply(bytes(root), step: result) },
        "\(provider) rejects a different original-tool receipt")
    }
  }
  let cash = try board("cash")
  let prepared = try command(cash)
  let final = prepared.steps[1]
  var oldProof = final.afterSalesProof!
  oldProof.removeValue(forKey: "paymentProvider")
  let legacyResult = LiveCommand.Step(path: final.path, body: final.body,
    keyHeader: final.keyHeader, key: "legacy-original-cash-key", recoveryBody: try bytes(oldProof))
  let legacy = LiveCommand(id: "legacy-command", employeeID: actor.employee.id, title: "原现金退款",
    permission: "refund.execute", steps: [legacyResult])
  let upgraded = try recoverLegacyAfterSalesCashCommand(command: legacy, board: cash, actor: actor)
  check(upgraded.steps.count == 2 && upgraded.steps[1] == legacyResult && upgraded.id == legacy.id
    && upgraded.steps[0].key == "legacy-original-cash-key-begin", "legacy approved retains original final key and body")
  for status in ["processing", "succeeded", "failed", "cancelled"] {
    let unchanged = try recoverLegacyAfterSalesCashCommand(command: legacy,
      board: board("cash", status), actor: actor)
    check(unchanged == legacy, "legacy \(status) replays original result without new execute")
  }
  var sentPaths: [String] = []
  let oldAPI = StaffAPI(transport: { request in
    sentPaths.append(request.url!.path)
    guard request.value(forHTTPHeaderField: "idempotency-key") == legacyResult.key else { throw StaffAPIError.invalid }
    return (try response(legacyResult, replayed: true), HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: nil)!)
  })
  let terminalLegacy = try recoverLegacyAfterSalesCashCommand(command: legacy,
    board: board("cash", "succeeded"), actor: actor)
  let oldRecovered = try await LiveCommandRunner.advance(terminalLegacy,
    send: { try await oldAPI.execute($0) }, checkpoint: { _ in })
  check(oldRecovered.completedSteps == 1 && sentPaths == [legacyResult.path],
    "already successful legacy cash recovers original manual-result receipt")
  check(rejects { _ = try recoverLegacyAfterSalesCashCommand(command: legacy,
    board: board("cash", amount: 8001), actor: actor) }, "legacy changed amount keeps old request unresolved")
  check(rejects { _ = try recoverLegacyAfterSalesCashCommand(command: legacy,
    board: board("physical_pos"), actor: actor) }, "legacy changed channel keeps old request unresolved")
  var auth = fixture["auth"] as! [String: Any]
  auth["deniedPermissions"] = ["refund.execute"]
  let denied = try decode(StaffIdentity.self, auth)
  check(rejects { _ = try recoverLegacyAfterSalesCashCommand(command: legacy, board: cash, actor: denied) },
    "legacy recovery requires current execute permission")
  var employee = auth["employee"] as! [String: Any]
  employee["id"] = "different-employee"; auth["employee"] = employee; auth["deniedPermissions"] = []
  let other = try decode(StaffIdentity.self, auth)
  check(rejects { _ = try recoverLegacyAfterSalesCashCommand(command: legacy, board: cash, actor: other) },
    "legacy recovery rejects another employee")
  check(!validAfterSalesCommandSelection(command: prepared, board: try board("cash", amount: 8001)),
    "new selection rejects stale original amount")
  return count
}
