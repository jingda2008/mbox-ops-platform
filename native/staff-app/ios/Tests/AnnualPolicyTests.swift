import Foundation
@main struct AnnualPolicyTests {
  @MainActor static func main() async throws {
    var count = 0, paths = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let perms = ["loyalty.annual-benefit.view"] + ["draft", "approve", "publish", "occurrence"].map(annualPermission)
    let auth: [String: Any] = ["session": ["id": "annual-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "独立配置员工", "roleCodes": ["MANAGER"]], "permissions": perms, "deniedPermissions": []]
    func actor(_ value: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value ?? auth)) }
    let user = try actor(), version = String(repeating: "a", count: 64), code = "ANNUAL_TEST", reason = "已核对原规则及现场履约条件"
    func rule(_ kind: String, enabled: Bool = true) -> [String: Any] {
      var r = newAnnualRule(); r["ruleCode"] = "RULE_" + kind.uppercased(); r["title"] = "原" + (annualKinds.first { $0.0 == kind }!.1); r["ruleKind"] = kind; r["benefitDefinitionId"] = id(80); r["benefitDefinitionName"] = "已启用原权益"; r["id"] = id(90); r["enabled"] = enabled; r["policyVersionId"] = id(20)
      r["feb29Policy"] = kind == "birthday" ? "feb28" : NSNull()
      if kind == "priority_seating" { r["reservationHoldMinutes"] = 15; r["onSiteOnly"] = false; r["requiresTableSession"] = false; r["stackGroup"] = "priority_seating" }
      if kind == "daily_snack" { r["redemptionHoldMinutes"] = 15; r["stackGroup"] = "daily_snack"; r["validityDays"] = 1; r["windowAfterDays"] = 0; r["inventoryRequirement"] = "strict_recipe" }
      if kind == "birthday" { r["substitutes"] = [["productId": id(81), "productName": "无酒精原替代品", "priority": 1, "reason": "现场可履约替代"]] }
      return r
    }
    func policy(_ kind: String, status: String = "draft", drafted: String? = nil, approved: String? = nil) -> [String: Any] {
      ["id": id(20), "policyCode": code, "version": 2, "nativeVersion": version, "timezone": "Asia/Shanghai", "status": status, "draftedByEmployeeId": drafted ?? id(2), "approvedByEmployeeId": approved ?? id(3), "publishedByEmployeeId": id(4), "effectiveFrom": "2098-01-01T00:00:00Z", "effectiveUntil": NSNull(), "reason": reason, "rules": [rule(kind)]]
    }
    func board(_ row: [String: Any], latest: Int = 2, who: StaffIdentity? = nil, enabled: Any = true) throws -> AnnualPolicyBoard {
      try AnnualPolicyBoard(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": enabled, "code": code, "latest": latest, "rows": [row], "next": NSNull()]]), actor: who ?? user, code: code)
    }
    for (kind, _) in annualKinds {
      for action in ["draft", "approve", "publish"] + (kind == "festival" ? ["occurrence"] : []) {
        paths += 1
        let b = try board(policy(kind, status: action == "publish" ? "approved" : "draft")), row = b.rows[0]
        var input: [String: Any] = ["reason": reason]
        if action == "draft" { input["policyCode"] = code; input["timezone"] = "Asia/Shanghai"; input["rules"] = [rule(kind)] }
        if action == "publish" { input["effectiveFrom"] = "2098-01-01T08:00:00+08:00"; input["effectiveUntil"] = "2099-01-01T08:00:00+08:00" }
        if action == "occurrence" { input["ruleId"] = id(90); input["cycleYear"] = 2028; input["startsOn"] = "2028-02-29"; input["endsOn"] = "2028-03-01"; input["confirmationReference"] = "已核对本年度日期依据" }
        let c = try b.command(actor: user, action: action, body: input, row: action == "draft" ? nil : row), step = c.steps[0]
        check(validAnnualPolicySelection(command: c, board: b, actor: user), kind + " " + action + " original version selection")
        let confirmation = step.annualPolicyProof!["confirmation"] as! String
        check(confirmation.contains("份数") && confirmation.contains("有效天数") && confirmation.contains("已启用原权益") && confirmation.contains("规则1") && confirmation.contains("库存要求") && confirmation.contains("不代表已经发放"), "full business confirmation includes amounts limits names and conditions")
        if kind == "birthday" { check(confirmation.contains("无酒精原替代品") && confirmation.contains("2月28日") && confirmation.contains("现场可履约替代"), "substitute and leap-birthday policy visible") }
        func response() -> [String: Any] {
          var result = row.object
          result["nativeVersion"] = String(repeating: "b", count: 64); result["reason"] = reason
          if action == "draft" {
            result["id"] = id(21); result["version"] = 3; result["draftedByEmployeeId"] = id(1)
            var newRule = rule(kind); newRule["id"] = id(91); newRule["policyVersionId"] = id(21); result["rules"] = [newRule]
          }
          if action == "approve" { result["status"] = "approved"; result["approvedByEmployeeId"] = id(1) }
          if action == "publish" { result["status"] = "published"; result["publishedByEmployeeId"] = id(1); result["effectiveFrom"] = "2098-01-01 00:00:00+00"; result["effectiveUntil"] = "2099-01-01 00:00:00+00" }
          if action == "occurrence" { result = step.object; result["id"] = id(95); result["confirmedByEmployeeId"] = id(1); result["confirmedAt"] = "2026-10-05 08:00:00+00" }
          return ["data": ["employeeId": id(1), "requestKey": step.key, "action": action, "accepted": step.object, "row": result], "meta": ["protocol": 1, "replayed": false]]
        }
        try validateAnnualPolicyReply(bytes(response()), step: step); check(true, "original receipt validated")
        for k in ["employeeId", "requestKey", "action"] { var reply = response(); var d = reply["data"] as! [String: Any]; d[k] = "wrong"; reply["data"] = d; check(bad { try validateAnnualPolicyReply(bytes(reply), step: step) }, "wrong reply " + k + " blocked") }
        var wrong = response(), d = wrong["data"] as! [String: Any], accepted = step.object; accepted["reason"] = "不同操作依据"; d["accepted"] = accepted; wrong["data"] = d
        check(bad { try validateAnnualPolicyReply(bytes(wrong), step: step) }, "changed accepted payload rejected")
        let changedFields = action == "occurrence" ? ["ruleId", "policyId", "startsOn", "endsOn", "cycleYear", "confirmationReference", "confirmedByEmployeeId"] : ["policyCode", "timezone", "version", "status", "draftedByEmployeeId", "reason", action == "approve" ? "approvedByEmployeeId" : action == "publish" ? "publishedByEmployeeId" : "nativeVersion"]
        for field in changedFields { var r = response(), data = r["data"] as! [String: Any], record = data["row"] as! [String: Any]; record[field] = "wrong"; data["row"] = record; r["data"] = data; check(bad { try validateAnnualPolicyReply(bytes(r), step: step) }, "wrong original field " + field + " rejected") }
        if action != "occurrence" {
          for field in ["quantity", "validityDays", "memberDailyLimit", "priority", "benefitDefinitionId", "enabled"] {
            var r = response(), data = r["data"] as! [String: Any], record = data["row"] as! [String: Any], rules = record["rules"] as! [[String: Any]]
            rules[0][field] = field == "benefitDefinitionId" ? id(82) : field == "enabled" ? false : 2; record["rules"] = rules; data["row"] = record; r["data"] = data
            check(bad { try validateAnnualPolicyReply(bytes(r), step: step) }, "changed content field " + field + " rejected")
          }
        }
        for p in ["loyalty.annual-benefit.view", annualPermission(action)] { var denied = auth; denied["deniedPermissions"] = [p]; check(bad { _ = try b.command(actor: actor(denied), action: action, body: input, row: action == "draft" ? nil : row) }, "current permission denial refuses intent") }
        var changed = row.object; changed["nativeVersion"] = String(repeating: "c", count: 64)
        check(!validAnnualPolicySelection(command: c, board: try board(changed, latest: action == "draft" ? 3 : 2), actor: user), "concurrent latest or original version invalidates confirmation")
        var pending = try JSONEncoder().encode(c), sends = 0, commits = 0
        let api = StaffAPI(transport: { request in
          if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
          guard request.httpMethod == "POST", request.url?.path == step.path, request.value(forHTTPHeaderField: "idempotency-key") == step.key, request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let body = request.httpBody, membershipEqual(try JSONSerialization.jsonObject(with: body) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
          sends += 1; if commits == 0 { commits += 1; throw URLError(.timedOut) }
          var r = response(); r["meta"] = ["protocol": 1, "replayed": true]; return (try bytes(r), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        _ = try await api.login(code: "staff", pin: "1234", switching: false)
        func send(_ s: LiveCommand.Step) async throws { try validateAnnualPolicyReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
        do { _ = try await LiveCommandRunner.advance(c, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("unknown discarded") } catch {}
        let restored = try JSONDecoder().decode(LiveCommand.self, from: pending); check(restored == c, "lost success original key payload and policy persist")
        let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); check(commits == 1 && sends == 2 && done.completedSteps == 1, "real API adapter recovers exactly one effect")
        _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "completed checkpoint prevents repeat on refresh failure")
      }
    }
    for (field, invalids) in [("quantity", [0, 101, true, 0.5] as [Any]), ("validityDays", [0, 367] as [Any]), ("priority", [0, 32768] as [Any]), ("windowBeforeDays", [-1, 91] as [Any])] {
      for value in invalids { var r = rule("birthday"); r[field] = value; check(bad { _ = try normalizeAnnualRule(r) }, "out of range or noninteger " + field + " blocked") }
    }
    for kind in ["priority_seating", "daily_snack"] { var r = rule(kind); r[kind == "priority_seating" ? "onSiteOnly" : "inventoryRequirement"] = kind == "priority_seating" ? true : "not_applicable"; check(bad { _ = try normalizeAnnualRule(r) }, "kind-specific field compatibility enforced") }
    var r = rule("birthday"); r["feb29Policy"] = NSNull(); check(bad { _ = try normalizeAnnualRule(r) }, "birthday leap-day policy required")
    r = rule("festival"); r["feb29Policy"] = "feb28"; check(bad { _ = try normalizeAnnualRule(r) }, "non-birthday cannot inherit leap-day field")
    var birthday = rule("birthday"), festival = rule("festival"); festival["priority"] = 10; check(bad { _ = try annualRules([birthday, festival]) }, "birthday must outrank all festivals")
    festival["priority"] = 11; check(try annualRules([birthday, festival]).count == 2, "correct birthday/festival ordering allowed")
    birthday["substitutes"] = [["productId": id(81), "priority": 1, "reason": "理由"], ["productId": id(81), "priority": 2, "reason": "理由"]]; check(bad { _ = try normalizeAnnualRule(birthday) }, "duplicate substitute refused")
    var crossed = policy("birthday"), crossedRule = rule("birthday"); crossedRule["policyVersionId"] = id(21); crossed["rules"] = [crossedRule]
    check(bad { _ = try board(crossed) }, "rule must belong to original policy ID")
    let own = try board(policy("birthday", drafted: id(1))); check(bad { _ = try own.command(actor: user, action: "approve", body: ["reason": reason], row: own.rows[0]) }, "cannot approve own draft")
    let approved = try board(policy("birthday", status: "approved", approved: id(1))); check(bad { _ = try approved.command(actor: user, action: "publish", body: ["reason": reason, "effectiveFrom": "2098-01-01T00:00:00Z", "effectiveUntil": NSNull()], row: approved.rows[0]) }, "publisher must differ from approver")
    let future = try board(policy("birthday", status: "approved")); check(bad { _ = try future.command(actor: user, action: "publish", body: ["reason": reason, "effectiveFrom": "2020-01-01T00:00:00Z", "effectiveUntil": NSNull()], row: future.rows[0]) }, "cannot publish retroactively")
    let fest = try board(policy("festival"))
    for date in ["2027-02-29", "2028-02-30", "2029-01-01"] { check(bad { _ = try fest.command(actor: user, action: "occurrence", body: ["reason": reason, "ruleId": id(90), "cycleYear": 2028, "startsOn": date, "endsOn": "2028-12-31", "confirmationReference": "正式日期"], row: fest.rows[0]) }, "invalid or different year dates rejected") }
    var disabled = policy("birthday"); disabled["rules"] = [rule("birthday", enabled: false)]
    check(try board(disabled).rows.count == 1, "historical draft with all rules disabled remains readable")
    let b = try board(policy("birthday")); check(bad { _ = try b.command(actor: user, action: "draft", body: ["policyCode": code, "timezone": "Asia/Shanghai", "reason": reason, "rules": [rule("birthday", enabled: false)]]) }, "new draft requires enabled rule before review")
    check(bad { _ = try board(policy("birthday"), enabled: 1) }, "durable marker strict bool")
    var denied = auth; denied["deniedPermissions"] = ["loyalty.annual-benefit.view"]; check(bad { _ = try board(policy("birthday"), who: actor(denied)) }, "denied read hides policy board")
    let path = try AnnualPolicyPage.optionsQuery(kind: "products", search: "A+B & 中文", cursor: id(9))
    check(path.contains("A%2BB") && !path.contains("A+B"), "literal plus protected from form query decoding")
    let decoded = URLComponents(string: "https://example.test" + path.replacingOccurrences(of: "+", with: " "))!.queryItems!.first { $0.name == "search" }!.value
    check(decoded == "A+B & 中文", "server form decoder preserves actual option query")
    let options: [String: Any] = ["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "rows": [["id": id(80), "name": "原权益", "status": "active"]], "next": NSNull()]]
    check(try AnnualPolicyPage(data: bytes(options), actor: user, kind: "definitions").rows.count == 1, "option page valid original IDs")
    var occ = options, data = occ["data"] as! [String: Any]; data["ruleId"] = id(90); data["rows"] = [["id": id(95), "ruleId": id(90), "cycleYear": 2028, "startsOn": "2028-02-29", "endsOn": "2028-03-01", "confirmedByEmployeeId": id(2), "confirmationReference": "原日期依据", "confirmedAt": "2026-10-05T08:00:00Z"]]; occ["data"] = data
    check(try AnnualPolicyPage(data: bytes(occ), actor: user, kind: "occurrences", ruleId: id(90)).rows.count == 1, "occurrence page exact original rule")
    check(bad { _ = try AnnualPolicyPage(data: bytes(occ), actor: user, kind: "occurrences", ruleId: id(91)) }, "other rule occurrence response refused")
    print("Annual policy tests passed (\(count) assertions; \(paths) action-kind recovery paths)")
  }
}
