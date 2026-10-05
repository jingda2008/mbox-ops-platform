import Foundation
@main struct LoyaltyRefundTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ message: String) { precondition(value, message); count += 1; print("PASS " + message) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "refund-review-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "财务复核员", "roleCodes": ["MANAGER"]], "permissions": ["reconciliation.view", "reconciliation.manage", "loyalty.accrual.exception.view", "loyalty.accrual.request", "loyalty.accrual.approve"], "deniedPermissions": []]
    func actor(_ object: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(object ?? auth)) }
    let user = try actor(), version = String(repeating: "a", count: 64), reason = "已逐笔核对已成功退款的原商品归属"
    func group(history: Bool = false) -> [String: Any] {
      ["refundId": id(history ? 11 : 10), "refundPublicId": history ? "REFUND-HISTORY" : "REFUND-CURRENT", "refundAmountMinor": history ? 5000 : 12000, "excessAmountMinor": history ? 1000 : 2000, "salesRefundAmountMinor": history ? 4000 : 10000,
       "items": [["orderItemId": id(31), "productName": "原计分商品", "quantity": 2.5, "refundAllocatedAmountMinor": history ? 4000 : 6000, "maxSalesReturnAmountMinor": history ? 4000 : 6000, "loyaltyEligible": true], ["orderItemId": id(32), "productName": "原不计分商品", "quantity": 1, "refundAllocatedAmountMinor": history ? 1000 : 4000, "maxSalesReturnAmountMinor": history ? 1000 : 4000, "loyaltyEligible": false]]]
    }
    let values = [id(10) + ":" + id(31): "60", id(10) + ":" + id(32): "40", id(11) + ":" + id(31): "30", id(11) + ":" + id(32): "10"]
    func source(history: Bool = true, requestStatus: String = "requested", requester: String? = nil, blocking: Any = NSNull()) -> [String: Any] {
      var row = group(); row["orderPublicId"] = "ORDER-ORIGINAL"; row["currency"] = "CNY"; row["status"] = "pending"; row["basisVersion"] = version; row["blockingRefundPublicId"] = blocking; row["historicalRefunds"] = history ? [group(history: true)] : []
      let request: [String: Any] = ["requestId": id(20), "requestedByEmployeeId": requester ?? id(2), "requestedByName": "申请员工", "reason": "原退款分配依据", "createdAt": "2026-10-05T08:00:00Z", "basisVersion": requestStatus == "stale" ? String(repeating: "b", count: 64) : version, "status": requestStatus, "allocations": [["orderItemId": id(31), "salesRefundAmountMinor": 6000], ["orderItemId": id(32), "salesRefundAmountMinor": 4000]], "historicalAllocations": history ? [["refundId": id(11), "allocations": [["orderItemId": id(31), "salesRefundAmountMinor": 3000], ["orderItemId": id(32), "salesRefundAmountMinor": 1000]]]] : [], "decisionReason": NSNull(), "decidedByName": NSNull()]
      row["requests"] = [request]; return row
    }
    func board(_ row: [String: Any], who: StaffIdentity? = nil, enabled: Any = true) throws -> LoyaltyRefundBoard {
      try LoyaltyRefundBoard(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": enabled, "page": 0, "hasMore": false, "items": [row]]]), actor: who ?? user)
    }
    for path in ["request", "history", "approve", "reject", "reject_stale", "reject_superseded"] {
      let decision = path == "approve" ? "approve" : "reject", action = ["request", "history"].contains(path) ? "request" : "decision"
      let b = try board(source(history: path != "request", requestStatus: path == "reject_stale" ? "stale" : path == "reject_superseded" ? "superseded" : "requested")), row = b.rows[0]
      let request = action == "request" ? nil : row.rows("requests")[0]
      let command = try b.command(actor: user, row: row, request: request, decision: decision, values: values, reason: reason), step = command.steps[0]
      check(validLoyaltyRefundSelection(command: command, board: b, actor: user), path + " current original allocation selected")
      let confirmation = step.loyaltyRefundProof!["confirmation"] as! String
      check(confirmation.contains("不会再次退款") && confirmation.contains("60.00") && confirmation.contains("40.00") && confirmation.contains("原数量 2.5"), path + " confirmation includes all item amounts and quantities")
      if path != "request" { check(confirmation.contains("REFUND-HISTORY") && confirmation.contains("30.00") && confirmation.contains("10.00"), "all historical refund allocations in final confirmation") }
      func response() -> [String: Any] {
        ["meta": ["protocol": 1, "replayed": false], "data": ["employeeId": id(1), "requestKey": step.key, "action": action, "result": ["requestId": id(action == "request" ? 21 : 20), "refundId": id(10), "status": action == "request" ? "requested" : decision == "approve" ? "approved" : "rejected", "pointsDelta": path == "approve" ? -8 : 0, "growthDelta": path == "approve" ? -8 : 0]]]
      }
      try validateLoyaltyRefundReply(bytes(response()), step: step); check(true, "valid original refund receipt accepted")
      for permission in ["reconciliation.manage", action == "request" ? "loyalty.accrual.request" : "loyalty.accrual.approve"] {
        var denied = auth; denied["deniedPermissions"] = [permission]
        check(bad { _ = try b.command(actor: actor(denied), row: row, request: request, decision: decision, values: values, reason: reason) }, "either finance or loyalty write denial blocks command")
      }
      for key in ["employeeId", "requestKey", "action"] { var r = response(); var d = r["data"] as! [String: Any]; d[key] = "wrong"; r["data"] = d; check(bad { try validateLoyaltyRefundReply(bytes(r), step: step) }, "wrong receipt " + key + " rejected") }
      for key in ["requestId", "refundId", "status", "pointsDelta", "growthDelta"] {
        var r = response(); var d = r["data"] as! [String: Any], result = d["result"] as! [String: Any]; result[key] = "wrong"; d["result"] = result; r["data"] = d
        check(bad { try validateLoyaltyRefundReply(bytes(r), step: step) }, "wrong original result " + key + " rejected")
      }
      for delta in [true as Any, 0.5 as Any, 1 as Any] {
        var r = response(); var d = r["data"] as! [String: Any], result = d["result"] as! [String: Any]; result["pointsDelta"] = delta; d["result"] = result; r["data"] = d
        check(bad { try validateLoyaltyRefundReply(bytes(r), step: step) }, "refund outcome cannot be boolean fractional or positive reward")
      }
      var changed = row.object; changed["basisVersion"] = String(repeating: "c", count: 64)
      check(!validLoyaltyRefundSelection(command: command, board: try board(changed), actor: user), "changed basis invalidates prior confirmation")
      var pending = try JSONEncoder().encode(command), sends = 0, commits = 0
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key, request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let data = request.httpBody, membershipEqual(try JSONSerialization.jsonObject(with: data) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
        sends += 1; if commits == 0 { commits += 1; throw URLError(.timedOut) }
        var r = response(); r["meta"] = ["protocol": 1, "replayed": true]; return (try bytes(r), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ step: LiveCommand.Step) async throws { try validateLoyaltyRefundReply(await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key]).0, step: step) }
      do { _ = try await LiveCommandRunner.advance(command, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("unknown dropped") } catch {}
      let restored = try JSONDecoder().decode(LiveCommand.self, from: pending); check(restored == command, "lost success retains original request all allocations and basis")
      let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); check(commits == 1 && sends == 2 && done.completedSteps == 1, "actual API adapter replays one original effect")
      _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "failed refresh cannot repeat completed reward adjustment")
    }
    let b = try board(source()), row = b.rows[0]
    for value in ["", "60.01", "-1", "0.001", "1e2"] { var v = values; v[id(10) + ":" + id(31)] = value; check(bad { _ = try b.command(actor: user, row: row, values: v, reason: reason) }, "blank overallocated or invalid money refused") }
    var mismatch = values; mismatch[id(10) + ":" + id(32)] = "39.99"
    check(bad { _ = try b.command(actor: user, row: row, values: mismatch, reason: reason) }, "current refund exact sum required")
    mismatch = values; mismatch[id(11) + ":" + id(32)] = "9.99"
    check(bad { _ = try b.command(actor: user, row: row, values: mismatch, reason: reason) }, "every historical refund exact sum required")
    let missingHistory = values.filter { !$0.key.hasPrefix(id(11)) }
    check(bad { _ = try b.command(actor: user, row: row, values: missingHistory, reason: reason) }, "historical allocation cannot be omitted")
    let blocked = try board(source(blocking: "REFUND-EARLIER"))
    check(bad { _ = try blocked.command(actor: user, row: blocked.rows[0], values: values, reason: reason) }, "earlier refund must be resolved first")
    let own = try board(source(requester: id(1)))
    for decision in ["approve", "reject"] { check(bad { _ = try own.command(actor: user, row: own.rows[0], request: own.rows[0].rows("requests")[0], decision: decision, reason: reason) }, "requester cannot independently decide own allocation") }
    for status in ["stale", "superseded", "approved", "rejected"] { let sb = try board(source(requestStatus: status)); check(bad { _ = try sb.command(actor: user, row: sb.rows[0], request: sb.rows[0].rows("requests")[0], decision: "approve", reason: reason) }, "non-current requested allocation cannot be approved") }
    for p in ["reconciliation.view", "loyalty.accrual.exception.view"] { var denied = auth; denied["deniedPermissions"] = [p]; check(bad { _ = try board(source(), who: actor(denied)) }, "either read permission denial hides financial loyalty details") }
    var invalid = source(); invalid["excessAmountMinor"] = 13000; check(bad { _ = try board(invalid) }, "excess cannot exceed original refund total")
    invalid = source(); invalid["currency"] = "USD"; check(bad { _ = try board(invalid) }, "different currency cannot use yuan entry")
    check(bad { _ = try board(source(), enabled: 1) }, "strict durable capability boolean")
    print("Loyalty refund tests passed (\(count) assertions; 6 action/status recovery paths)")
  }
}
