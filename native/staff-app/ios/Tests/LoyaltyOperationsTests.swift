import Foundation
@main struct LoyaltyOperationsTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ message: String) { precondition(value, message); count += 1; print("PASS " + message) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "loyalty-ops-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "复核员", "roleCodes": ["MANAGER"]], "permissions": ["loyalty.redemption.exception", "loyalty.accrual.exception.view", "loyalty.accrual.request", "loyalty.accrual.approve"], "deniedPermissions": []]
    func actor(_ object: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(object ?? auth)) }
    let user = try actor(), reason = "已核对原账与现场实际事实", reference = "OFFSITE-20261005-01"
    func row(_ kind: LoyaltyOperationKind, status: String, section: String) -> [String: Any] {
      if kind == .benefit { return ["id": id(10), "orderId": id(11), "benefitId": id(12), "tableSessionId": id(13), "tableCode": "A1", "orderPublicId": "ORDER-01", "status": status, "attemptCount": 3, "updatedAt": "2026-10-05 08:00:00.123456+00", "lastErrorAt": "2026-10-05T08:00:00Z", "lastErrorCode": "NO_CAPACITY", "memberNo": "MB01", "title": "会员礼遇"] }
      if section == "reconciliation" { return ["orderPublicId": "ORDER-01", "memberNo": "MB01", "status": status, "eligibleAmountMinor": 12050, "expectedPoints": 12, "existingPoints": 1, "expectedGrowth": 12, "existingGrowth": 1, "reviewRefundPublicIds": status == "refund_review_required" ? ["REFUND-01"] : []] }
      return ["publicId": "LSP-" + id(20), "orderPublicId": "ORDER-01", "memberNo": "MB01", "status": status, "requestedPoints": 11, "requestedGrowth": 11, "requestedByEmployeeId": id(2), "requestedByName": "申请员工", "createdAt": "2026-10-05T08:00:00Z", "reason": "核对原账", "decisionReason": NSNull(), "approvedByName": NSNull()]
    }
    func board(_ kind: LoyaltyOperationKind, section: String, rows: [[String: Any]], enabled: Any = true, who: StaffIdentity? = nil) throws -> LoyaltyOperationsBoard {
      try LoyaltyOperationsBoard(kind: kind, data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": enabled, "section": section, "page": 0, "hasMore": false, "items": rows]]), actor: who ?? user, section: section, page: 0)
    }
    typealias Case = (LoyaltyOperationKind, String, String, String, String)
    let cases: [Case] = [(.benefit, "reconciliation", "failed", "retry", "pending"), (.benefit, "reconciliation", "retry", "retry", "pending"), (.benefit, "reconciliation", "failed", "cancel_release", "cancelled"), (.benefit, "reconciliation", "failed", "external_compensation", "compensated"), (.supplement, "reconciliation", "missing", "request", "requested"), (.supplement, "reconciliation", "mismatch", "request", "requested"), (.supplement, "requests", "requested", "approve", "executed"), (.supplement, "requests", "requested", "approve", "not_required"), (.supplement, "requests", "requested", "reject", "rejected"), (.supplement, "requests", "requested", "approve", "executed"), (.supplement, "requests", "requested", "approve", "not_required")]
    for (caseIndex, c) in cases.enumerated() {
      let raw = row(c.0, status: c.2, section: c.1), b = try board(c.0, section: c.1, rows: [raw]), selected = b.rows[0]
      let command = try b.command(actor: user, action: c.3, row: selected, reason: reason, reference: reference, externallyCompleted: true), step = command.steps[0]
      check(validLoyaltyOperationSelection(command: command, board: b, actor: user), c.0.rawValue + " " + c.3 + " original selection allowed")
      let text = step.loyaltyOperationProof!["confirmation"] as! String
      check(text.contains(reason) && text.contains("ORDER-01"), "confirmation includes original record and reason")
      if c.0 == .benefit { check(text.contains(c.3 == "retry" ? "不新发一份礼遇" : c.3 == "cancel_release" ? "不自动恢复已使用权益" : "不自动付款、发券或加积分"), "distinct physical fulfillment and compensation boundaries") }
      else { check(text.contains("最终积分及成长以执行回读为准") && text.contains(c.3 == "request" ? "¥120.50" : "申请积分 11"), "original amounts shown without promising stale rewards") }
      func response() -> [String: Any] {
        var result: [String: Any]
        if c.0 == .benefit {
          result = ["intentId": id(10), "orderId": id(11), "benefitId": id(12), "status": c.4]
          if c.3 != "retry" { result["action"] = c.3; result["resolvedByEmployeeId"] = id(1); result["reason"] = reason; result["compensationReference"] = c.3 == "external_compensation" ? reference : NSNull() as Any; for k in ["releasedInventoryReservationCount", "releasedCapacityReservationCount", "cancelledKdsTaskCount", "cancelledOrderItemCount"] { result[k] = 1 } }
        } else {
          result = ["publicId": "LSP-" + id(20), "status": c.4]
          if c.3 == "request" { result["requestedPoints"] = 11; result["requestedGrowth"] = 11 } else { result["pointsDelta"] = caseIndex >= 9 ? -7 : c.4 == "executed" ? 11 : 0; result["growthDelta"] = caseIndex >= 9 ? -3 : c.4 == "executed" ? 11 : 0 }
        }
        var data: [String: Any] = ["employeeId": id(1), "action": c.3, "requestKey": step.key, "result": result]
        if c.0 == .supplement { data["sourcePublicId"] = step.object["publicId"] }
        return ["meta": ["protocol": 1, "replayed": false], "data": data]
      }
      try validateLoyaltyOperationReply(bytes(response()), step: step); check(true, "correct original outcome accepted")
      for key in ["employeeId", "action", "requestKey"] {
        var r = response(); var d = r["data"] as! [String: Any]; d[key] = "wrong"; r["data"] = d
        check(bad { try validateLoyaltyOperationReply(bytes(r), step: step) }, "wrong receipt " + key + " rejected")
      }
      let outcomeKeys = c.0 == .benefit ? ["intentId", "orderId", "benefitId", "status"] + (c.3 == "retry" ? [] : ["action", "resolvedByEmployeeId", "reason", "compensationReference", "releasedInventoryReservationCount"]) : ["publicId", "status"] + (c.3 == "request" ? ["requestedPoints", "requestedGrowth"] : ["pointsDelta", "growthDelta"])
      for key in outcomeKeys {
        var r = response(); var d = r["data"] as! [String: Any], result = d["result"] as! [String: Any]; result[key] = "wrong"; d["result"] = result; r["data"] = d
        check(bad { try validateLoyaltyOperationReply(bytes(r), step: step) }, "wrong original result " + key + " rejected")
      }
      var denied = auth; denied["deniedPermissions"] = [command.permission]
      check(bad { _ = try b.command(actor: actor(denied), action: c.3, row: selected, reason: reason, reference: reference, externallyCompleted: true) }, "current denied permission blocks mutation")
      var changed = raw; changed[c.0 == .benefit ? "attemptCount" : c.1 == "requests" ? "requestedPoints" : "expectedPoints"] = 99
      let different = try board(c.0, section: c.1, rows: [changed]); check(!validLoyaltyOperationSelection(command: command, board: different, actor: user), "refreshed source change invalidates old confirmation")
      var sends = 0, effects = 0, pending = try JSONEncoder().encode(command)
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key, request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let data = request.httpBody, membershipEqual(try JSONSerialization.jsonObject(with: data) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
        sends += 1; if effects == 0 { effects += 1; throw URLError(.timedOut) }
        var r = response(); r["meta"] = ["protocol": 1, "replayed": true]
        return (try bytes(r), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ s: LiveCommand.Step) async throws { try validateLoyaltyOperationReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
      do { _ = try await LiveCommandRunner.advance(command, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("unknown dropped") } catch {}
      let restored = try JSONDecoder().decode(LiveCommand.self, from: pending); check(restored == command, "unknown result preserves original mutation identity and payload")
      let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); check(effects == 1 && sends == 2 && done.completedSteps == 1, "actual adapter durable replay has one original effect")
      _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "refresh failure never resends completed operation")
    }
    let benefit = try board(.benefit, section: "reconciliation", rows: [row(.benefit, status: "failed", section: "reconciliation")])
    check(bad { _ = try benefit.command(actor: user, action: "external_compensation", row: benefit.rows[0], reason: reason, reference: reference, externallyCompleted: false) }, "cannot register uncompleted external compensation")
    check(bad { _ = try benefit.command(actor: user, action: "external_compensation", row: benefit.rows[0], reason: reason, reference: "", externallyCompleted: true) }, "external compensation requires original receipt")
    let waiting = try board(.benefit, section: "reconciliation", rows: [row(.benefit, status: "retry", section: "reconciliation")])
    for a in ["cancel_release", "external_compensation"] { check(bad { _ = try waiting.command(actor: user, action: a, row: waiting.rows[0], reason: reason, reference: reference, externallyCompleted: true) }, "active automatic retry cannot be closed locally") }
    for status in ["matched", "refund_review_required"] { let b = try board(.supplement, section: "reconciliation", rows: [row(.supplement, status: status, section: "reconciliation")]); check(bad { _ = try b.command(actor: user, action: "request", row: b.rows[0], reason: reason) }, "matched or unresolved refund cannot generate new points request") }
    var own = row(.supplement, status: "requested", section: "requests"); own["requestedByEmployeeId"] = id(1)
    let selfBoard = try board(.supplement, section: "requests", rows: [own])
    for action in ["approve", "reject"] { check(bad { _ = try selfBoard.command(actor: user, action: action, row: selfBoard.rows[0], reason: reason) }, "requester cannot decide own supplement") }
    check(bad { _ = try LoyaltyOperationsBoard.query(kind: .supplement, section: "other") }, "unknown list section refused")
    for page in [-1, 10001] { check(bad { _ = try LoyaltyOperationsBoard.query(kind: .benefit, page: page) }, "unsafe page refused") }
    var denied = auth; denied["deniedPermissions"] = ["loyalty.accrual.exception.view"]
    check(bad { _ = try board(.supplement, section: "requests", rows: [], who: actor(denied)) }, "list read permission required")
    check(bad { _ = try board(.benefit, section: "reconciliation", rows: [], enabled: 1) }, "durable capability boolean strict")
    print("Loyalty operations tests passed (\(count) assertions; \(cases.count) status/action recovery paths)")
  }
}
