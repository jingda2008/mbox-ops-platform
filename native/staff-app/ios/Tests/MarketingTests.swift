import Foundation
@main struct MarketingTests {
  @MainActor static func main() async throws {
    var count = 0, paths = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let f = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any], rule = f["expected"] as! [String: Any]
    check(try membershipEqual(marketingRule(f["input"] as! [String: Any]), rule), "actual backend parser fixture exact normalization including milliseconds")
    let perms = marketingAreas.map(\.2) + ["marketing.notice.edit", "marketing.notice.approve", "marketing.notice.publish"]
    let auth: [String: Any] = ["session": ["id": "marketing-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "独立营销管理员工", "roleCodes": ["MANAGER"]], "permissions": perms, "deniedPermissions": []]
    func actor(_ value: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value ?? auth)) }
    let user = try actor(), version = String(repeating: "a", count: 64), code = "MARKETING_TEST", reason = "已核对原顾客表达或原告知与任务"
    func notice(status: String = "draft", creator: String? = nil, approver: String? = nil) -> [String: Any] {
      var decisions: [[String: Any]] = []
      if ["approved", "published", "stopped"].contains(status) { decisions.append(["action": "approve", "employee_id": approver ?? id(3)]) }
      if ["published", "stopped"].contains(status) { decisions.append(["action": "publish", "employee_id": id(4)]) }
      if status == "stopped" { decisions.append(["action": "stop", "employee_id": id(5)]) }
      return ["id": id(20), "code": code, "version": 2, "nativeVersion": version, "status": status, "createdByEmployeeId": creator ?? id(2), "rule": rule, "decisions": decisions, "reason": reason, "createdAt": "2026-01-01T00:00:00Z"]
    }
    func job(status: String = "queued", channel: String = "wechat", purpose: String = "own_activities") -> [String: Any] {
      ["id": id(30), "customerId": id(10), "customerRef": "CUSTOMER-ORIGINAL", "noticeId": id(20), "channel": channel, "purpose": purpose, "campaignKey": "ORIGINAL_CAMPAIGN_01", "content": "原活动邀请内容，停止方法见原告知", "expiresAt": "2098-01-01T00:00:00Z", "status": status, "createdByEmployeeId": id(2), "checks": 0, "blockedReason": status == "blocked" ? "channel_not_configured" : NSNull(), "nativeVersion": version]
    }
    func board(_ rows: [[String: Any]] = [], area: String = "notices", latest: Int = 2, who: StaffIdentity? = nil) throws -> MarketingBoard {
      try MarketingBoard(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "rows": rows, "next": NSNull(), "code": code, "latestVersion": latest]]), actor: who ?? user, area: area, code: area == "notices" ? code : "")
    }
    func customers(_ purpose: String, who: StaffIdentity? = nil) throws -> MarketingCustomerPage {
      try MarketingCustomerPage(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "rows": [["id": id(10), "name": "MEMBER-ORIGINAL", "code": "CUSTOMER-ORIGINAL"]], "next": NSNull()]]), actor: who ?? user, purpose: purpose, search: "ORIGINAL")
    }
    let pathsToTest = ["save", "approve", "publish", "stop", "refusal"] + marketingJobStatuses.map { "queue_" + $0 } + ["cancel_queued", "cancel_blocked"]
    for (index, path) in pathsToTest.enumerated() {
      paths += 1
      let action = ["approve", "publish", "stop"].contains(path) ? "decision" : path.hasPrefix("queue_") ? "queue" : path.hasPrefix("cancel_") ? "cancel" : path
      let area = action == "refusal" ? "workspace" : action == "cancel" ? "jobs" : "notices", channel = marketingChannels[index % 3].0, purpose = marketingPurposes[(index / 3) % 2].0
      let state = path == "approve" ? "draft" : path == "publish" ? "approved" : "published"
      let raw = action == "cancel" ? job(status: path == "cancel_queued" ? "queued" : "blocked") : notice(status: state), b = try board(action == "refusal" ? [] : [raw], area: area), row = b.rows.first
      let cp = try customers(action == "queue" ? "send" : "refusal"), customer = try cp.selection(row: cp.rows[0])
      var input: [String: Any] = ["reason": reason]
      if action == "save" { input["code"] = code; input["rule"] = rule }
      if action == "decision" { input["decision"] = path }
      if action == "refusal" { input["customerId"] = id(10) }
      if action == "queue" { input = ["customerId": id(10), "channel": channel, "purpose": purpose, "campaignKey": "ORIGINAL_CAMPAIGN_01", "content": "原活动邀请内容，停止方法见原告知", "expiresAt": "2098-01-01T08:00:00+08:00"] }
      let c = try b.command(actor: user, action: action, body: input, row: row, customer: customer), step = c.steps[0]
      check(validMarketingSelection(command: c, board: b, actor: user), path + " bound to original object")
      let confirmation = step.marketingProof!["confirmation"] as! String
      if ["save", "decision"].contains(action) { check(confirmation.contains("实际经营主体") && confirmation.contains("必要资料") && confirmation.contains("可联系星期") && confirmation.contains("每日上限 2") && confirmation.contains("每月上限 10") && confirmation.contains("停止方法") && confirmation.contains("不代替本人同意"), "full notice confirmation contains actual scope windows limits and withdrawal") }
      if action == "queue" { check(confirmation.contains("MEMBER-ORIGINAL") && confirmation.contains("ORIGINAL_CAMPAIGN_01") && confirmation.contains("原活动邀请内容") && confirmation.contains("不表示已经送达"), "queue confirmation original customer campaign content and delivery boundary") }
      if action == "refusal" { check(confirmation.contains("明确拒绝全部营销") && confirmation.contains("不能代替顾客授予许可"), "refusal cannot masquerade as customer consent") }
      func response() -> [String: Any] {
        var record = raw
        if action == "save" { record = notice(); record["id"] = id(21); record["version"] = 3; record["createdByEmployeeId"] = id(1) }
        if action == "decision" {
          record["status"] = ["approve": "approved", "publish": "published", "stop": "stopped"][path]
          var decisions = raw["decisions"] as! [[String: Any]]; decisions.append(["action": path, "employee_id": id(1)]); record["decisions"] = decisions
        }
        if action == "refusal" { record = ["stopped": true, "customerId": id(10)] }
        if action == "queue" { record = job(status: String(path.dropFirst(6)), channel: channel, purpose: purpose) }
        if action == "cancel" { record["status"] = "cancelled"; record["blockedReason"] = "staff_cancelled" }
        return ["data": ["employeeId": id(1), "requestKey": step.key, "action": action, "accepted": step.object, "row": record], "meta": ["protocol": 1, "replayed": false]]
      }
      try validateMarketingReply(bytes(response()), step: step); check(true, path + " exact receipt accepted")
      for k in ["employeeId", "requestKey", "action"] { var r = response(), d = r["data"] as! [String: Any]; d[k] = "wrong"; r["data"] = d; check(bad { try validateMarketingReply(bytes(r), step: step) }, "wrong outer receipt " + k + " refused") }
      var wrong = response(), data = wrong["data"] as! [String: Any], accepted = step.object; accepted[action == "queue" ? "content" : "reason"] = "不同原请求内容"; data["accepted"] = accepted; wrong["data"] = data
      check(bad { try validateMarketingReply(bytes(wrong), step: step) }, "modified accepted body rejected")
      let fields = ["save", "decision"].contains(action) ? ["code", "version", "status", "createdByEmployeeId", "nativeVersion"] : action == "refusal" ? ["customerId", "stopped"] : ["customerId", "noticeId", "channel", "purpose", "campaignKey", "content", "expiresAt", "status", "nativeVersion"]
      for k in fields { var r = response(), d = r["data"] as! [String: Any], record = d["row"] as! [String: Any]; record[k] = "wrong"; d["row"] = record; r["data"] = d; check(bad { try validateMarketingReply(bytes(r), step: step) }, "wrong original field " + k + " rejected") }
      if ["save", "decision"].contains(action) {
        for k in ["maximumPerDay", "consentDays", "operatorName", "validFrom", "sharingMode"] {
          var r = response(), d = r["data"] as! [String: Any], record = d["row"] as! [String: Any], changedRule = rule
          changedRule[k] = k == "maximumPerDay" || k == "consentDays" ? 1 : k == "validFrom" ? "2026-01-01T00:00:00.124Z" : "变更内容"; record["rule"] = changedRule; d["row"] = record; r["data"] = d
          check(bad { try validateMarketingReply(bytes(r), step: step) }, "notice scope/content/millisecond mismatch rejected")
        }
      }
      var denied = auth; denied["deniedPermissions"] = [marketingPermission(action, body: input)]
      check(bad { _ = try b.command(actor: actor(denied), action: action, body: input, row: row, customer: customer) }, "write permission revoked")
      if action != "refusal" { var changed = raw; changed["nativeVersion"] = String(repeating: "c", count: 64); check(!validMarketingSelection(command: c, board: try board([changed], area: area, latest: action == "save" ? 3 : 2), actor: user), "stale original or latest version blocks new intent") }
      var pending = try JSONEncoder().encode(c), sends = 0, commits = 0
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key, request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let body = request.httpBody, membershipEqual(try JSONSerialization.jsonObject(with: body) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
        sends += 1; if commits == 0 { commits += 1; throw URLError(.timedOut) }; var r = response(); r["meta"] = ["protocol": 1, "replayed": true]; return (try bytes(r), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ s: LiveCommand.Step) async throws { try validateMarketingReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
      do { _ = try await LiveCommandRunner.advance(c, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("unknown discarded") } catch {}
      let restored = try JSONDecoder().decode(LiveCommand.self, from: pending); check(restored == c, "lost receipt preserves original campaign payload identity and key")
      let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); check(commits == 1 && sends == 2 && done.completedSteps == 1, "real adapter replays one original effect")
      _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "failed refresh cannot duplicate completed marketing action")
    }
    for k in ["channels", "purposes", "weekdays", "dataCategories"] { var r = rule; r[k] = []; check(bad { _ = try marketingRule(r) }, "empty notice choice " + k + " refused") }
    for (k, value) in [("maximumPerDay", true as Any), ("contactEndMinute", 0 as Any), ("maximumPerMonth", 1 as Any), ("sharingMode", "share_partner_list" as Any), ("consentDays", 3661 as Any)] { var r = rule; r[k] = value; check(bad { _ = try marketingRule(r) }, "invalid/conflicting notice input rejected") }
    var cross = rule; cross["contactStartMinute"] = 1380; cross["contactEndMinute"] = 60; check(bad { _ = try marketingRule(cross) }, "contact window cannot cross midnight")
    let own = try board([notice(creator: id(1))]); check(own.decisionActions(actor: user, row: own.rows[0]).isEmpty, "maker cannot approve own notice")
    let approved = try board([notice(status: "approved", approver: id(1))]); check(approved.decisionActions(actor: user, row: approved.rows[0]).isEmpty, "approver cannot publish own approval")
    let workspace = try board(area: "workspace"), page = try customers("refusal"), selected = try page.selection(row: page.rows[0])
    let other = MarketingCustomerSelection(employeeID: id(9), purpose: "refusal", row: selected.row)
    check(bad { _ = try workspace.command(actor: user, action: "refusal", body: ["customerId": id(10), "reason": reason], customer: other) }, "customer lookup bound to original employee")
    let audit = try customers("audit"), auditSelection = try audit.selection(row: audit.rows[0])
    check(bad { _ = try workspace.command(actor: user, action: "refusal", body: ["customerId": id(10), "reason": reason], customer: auditSelection) }, "audit-only selection cannot become refusal intent")
    for status in ["dispatching", "submitted", "sent", "unknown", "failed", "cancelled"] { let b = try board([job(status: status)], area: "jobs"); check(bad { _ = try b.command(actor: user, action: "cancel", body: ["reason": reason], row: b.rows[0]) }, "channel/terminal/unknown task cannot be cancelled as unsent") }
    let path = try MarketingCustomerPage.query(purpose: "audit", search: "A+B & 测试")
    let formDecoded = URLComponents(string: "https://example.test" + path.replacingOccurrences(of: "+", with: " "))!.queryItems!.first { $0.name == "search" }!.value
    check(formDecoded == "A+B & 测试" && path.contains("A%2BB"), "customer query literal plus and form decoding safe")
    check(bad { _ = try MarketingHistoryPage.body(customerId: id(10), reason: reason, cursor: "9223372036854775808") }, "history bigint cursor overflow rejected without precision loss")
    check(try MarketingHistoryPage.body(customerId: id(10), reason: reason, cursor: "9223372036854775807")["cursor"] as? String == "9223372036854775807", "history maximum bigint remains exact string")
    func history(_ who: String? = nil, source: String = "customer_self", action: String = "granted") throws -> Data { try bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "customerId": who ?? id(10), "rows": [["id": id(70), "sequence": "9007199254740993", "action": action, "source": source, "channel": action == "stop_all" ? NSNull() : "wechat", "purpose": action == "stop_all" ? NSNull() : "own_activities", "createdAt": "2026-10-05T08:00:00Z", "validUntil": "2098-01-01T00:00:00Z", "notice": ["id": id(20), "code": code, "version": 2, "summary": "原告知内容"]]], "next": "9007199254740993"]]) }
    check(try MarketingHistoryPage(data: history(), actor: user, customerId: id(10)).rows.count == 1, "original self consent history accepted")
    check(bad { _ = try MarketingHistoryPage(data: history(id(11)), actor: user, customerId: id(10)) }, "merged or wrong customer history cannot silently replace chosen identity")
    check(bad { _ = try MarketingHistoryPage(data: history(source: "staff_recorded_refusal"), actor: user, customerId: id(10)) }, "staff history cannot claim self granted consent")
    check(try MarketingHistoryPage(data: history(source: "staff_recorded_refusal", action: "stop_all"), actor: user, customerId: id(10)).rows.count == 1, "staff explicit all-refusal history accepted")
    print("Marketing tests passed (\(count) assertions; \(paths) action/status recovery paths; 1 actual server parser fixture)")
  }
}
