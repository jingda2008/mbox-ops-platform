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
    print("\(count) payment-completion checks passed")
  }
}
