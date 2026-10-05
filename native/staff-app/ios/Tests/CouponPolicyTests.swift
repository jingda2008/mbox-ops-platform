import Foundation
@main struct CouponPolicyTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ name: String) { precondition(condition, name); count += 1; print("PASS " + name) }
    func bad(_ fn: () throws -> Void) -> Bool { do { try fn(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let permissions = ["loyalty.configuration.view", "loyalty.configuration.edit", "loyalty.configuration.approve", "loyalty.configuration.preview", "loyalty.policy.publish"]
    let auth: [String: Any] = ["session": ["id": "policy-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "规则管理员", "roleCodes": ["MANAGER"]], "permissions": permissions, "deniedPermissions": []]
    func actor(_ value: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value ?? auth)) }
    let user = try actor(), fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let calendarFixture = (fixtures["calendars"] as! [[String: Any]])[0], stackingFixture = (fixtures["stacking"] as! [[String: Any]])[0]
    let rule = (calendarFixture["body"] as! [String: Any])["rule"] as! [String: Any], policy = (stackingFixture["body"] as! [String: Any])["policy"] as! [String: Any]
    let limits: [String: Any] = ["perCustomerDay": NSNull(), "perCustomerWeek": 2, "perCustomerCampaign": 10]
    func row(_ kind: CouponPolicyKind, status: String = "draft", creator: String? = nil, approver: String? = nil) -> [String: Any] {
      var d: [String: Any] = ["id": id(10), "code": "OCT_POLICY", "version": 3, "status": status, "createdByEmployeeId": creator ?? id(2), "decisions": []]
      var decisions: [[String: Any]] = []
      if status != "draft" { decisions.append(["action": "approve", "employeeId": approver ?? id(3)]) }
      if ["published", "stopped"].contains(status) { decisions.append(["action": "publish", "employeeId": id(4)]) }
      if status == "stopped" { decisions.append(["action": "stop_issuing", "employeeId": id(4)]) }; d["decisions"] = decisions
      if kind == .calendar { d["rule"] = rule; d["limits"] = limits } else { d["policy"] = policy }; return d
    }
    func board(_ kind: CouponPolicyKind, rows: [[String: Any]], enabled: Any = true, who: StaffIdentity? = nil) throws -> CouponPolicyBoard {
      try CouponPolicyBoard(kind: kind, data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": enabled, "rows": rows, "next": NSNull()]]), actor: who ?? user, search: "OCT+")
    }
    for kind in CouponPolicyKind.allCases {
      for path in ["new", "revise", "approve", "publish", "stop_issuing"] {
        let status = path == "publish" ? "approved" : path == "stop_issuing" ? "published" : "draft", original = row(kind, status: status)
        let b = try board(kind, rows: [original]), prior = b.rows[0], action = ["new", "revise"].contains(path) ? "save" : "decision"
        var body: [String: Any]
        if action == "save" { body = ["code": path == "new" ? "NEW_POLICY" : "OCT_POLICY", "expectedVersion": path == "new" ? 0 : 3, "reason": "核对完整规则后提交"]; if kind == .calendar { body["rule"] = rule; body["limits"] = limits } else { body["policy"] = policy } }
        else { body = ["versionId": prior.id, "expectedStatus": status, "action": path, "reason": "独立核对完整规则后决定"] }
        let command = try b.command(actor: user, action: action, body: body, row: path == "new" ? nil : prior), step = command.steps[0]
        check(validCouponPolicySelection(command: command, board: b, actor: user), kind.rawValue + " " + path + " original selection allowed")
        let proof = step.couponPolicyProof!, confirmation = proof["confirmation"] as! String
        check(confirmation.contains("已发券保留原规则") && confirmation.contains("原因"), "full impact confirmation")
        if kind == .calendar { check(confirmation.contains("每人每周次数：2") && confirmation.contains("跨午夜") && confirmation.contains("换日 06:00"), "calendar confirmation includes counts and date basis") }
        else { check(confirmation.contains("最低实付：¥0.00") && confirmation.contains("会员价 → 优惠券 → 积分"), "stacking confirmation includes amounts and exact order") }
        func response(replayed: Bool = false) -> [String: Any] {
          var updated = original
          if action == "save" { updated["id"] = id(11); updated["code"] = body["code"]; updated["version"] = (body["expectedVersion"] as! Int) + 1; updated["createdByEmployeeId"] = id(1); if kind == .calendar { updated["rule"] = step.object["rule"]; updated["limits"] = step.object["limits"] } else { updated["policy"] = step.object["policy"] } }
          else { updated["status"] = ["approve": "approved", "publish": "published", "stop_issuing": "stopped"][path]; var d = original["decisions"] as! [[String: Any]]; d.append(["action": path, "employeeId": id(1)]); updated["decisions"] = d }
          return ["meta": ["protocol": 1, "replayed": replayed], "data": ["employeeId": id(1), "action": action, "requestKey": step.key, "row": updated]]
        }
        try validateCouponPolicyReply(bytes(response()), step: step); check(true, "correct original rule receipt")
        var denied = auth; denied["deniedPermissions"] = [command.permission]
        check(bad { _ = try b.command(actor: actor(denied), action: action, body: body, row: path == "new" ? nil : prior) }, "effective deny overrides role")
        for key in ["employeeId", "action", "requestKey"] { var response = response(); var d = response["data"] as! [String: Any]; d[key] = "wrong"; response["data"] = d; check(bad { try validateCouponPolicyReply(bytes(response), step: step) }, "wrong " + key + " cannot close original operation") }
        for key in ["code", "version", "status", "createdByEmployeeId"] { var response = response(); var d = response["data"] as! [String: Any], r = d["row"] as! [String: Any]; r[key] = key == "version" ? 99 : "wrong" as Any; d["row"] = r; response["data"] = d; check(bad { try validateCouponPolicyReply(bytes(response), step: step) }, "wrong original row " + key + " refused") }
        var changed = response(); var d = changed["data"] as! [String: Any], r = d["row"] as! [String: Any]
        if kind == .calendar { var l = r["limits"] as! [String: Any]; l["perCustomerWeek"] = 3; r["limits"] = l } else { var p = r["policy"] as! [String: Any]; p["minimumPayableMinor"] = 1; r["policy"] = p }
        d["row"] = r; changed["data"] = d; check(bad { try validateCouponPolicyReply(bytes(changed), step: step) }, "changed rule or money cannot close original request")
        var sends = 0, commits = 0, persisted = try JSONEncoder().encode(command)
        let api = StaffAPI(transport: { request in
          if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
          guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key,
            request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let data = request.httpBody,
            membershipEqual(try JSONSerialization.jsonObject(with: data) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
          sends += 1; if commits == 0 { commits += 1; throw URLError(.timedOut) }
          return (try bytes(response(replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        _ = try await api.login(code: "staff", pin: "1234", switching: false)
        func send(_ s: LiveCommand.Step) async throws { try validateCouponPolicyReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
        do { _ = try await LiveCommandRunner.advance(command, send: send, checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("unknown lost") } catch {}
        let restored = try JSONDecoder().decode(LiveCommand.self, from: persisted)
        check(restored == command, "lost success preserves full original key payload and target")
        let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { persisted = try JSONEncoder().encode($0) })
        check(commits == 1 && sends == 2 && done.completedSteps == 1, "actual adapter durable replay has one original effect")
        _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "refresh failure cannot resubmit completed rule mutation")
      }
      let own = try board(kind, rows: [row(kind, creator: id(1))])
      check(bad { _ = try own.command(actor: user, action: "decision", body: ["versionId": id(10), "expectedStatus": "draft", "action": "approve", "reason": "自己审批"], row: own.rows[0]) }, "editor cannot approve own rule")
      let selfPublish = try board(kind, rows: [row(kind, status: "approved", approver: id(1))])
      check(bad { _ = try selfPublish.command(actor: user, action: "decision", body: ["versionId": id(10), "expectedStatus": "approved", "action": "publish", "reason": "自己发布"], row: selfPublish.rows[0]) }, "approver cannot publish own decision")
      check(bad { _ = try board(kind, rows: [row(kind), row(kind)]) }, "duplicate list versions refused")
      check(bad { _ = try board(kind, rows: [], enabled: 1) }, "strict boolean durable capability")
      let path = try CouponPolicyBoard.query(kind: kind, search: " A+B ")
      check(path.contains("A%2BB") && !path.contains("A+B"), "literal plus preserves server form decoding")
      for cursor in ["../other", "id?search=bad", "raw"] { check(bad { _ = try CouponPolicyBoard.query(kind: kind, cursor: cursor) }, "unsafe cursor refused") }
    }
    var calendar = CouponCalendarDraft(row: try CouponPolicyRecord(row(.calendar))); calendar.fields["reason"] = "核对日历原规则"
    check(try couponPolicyFingerprint(calendar.save(row: CouponPolicyRecord(row(.calendar))).merging(["reason": "ok"], uniquingKeysWith: { _, new in new }), kind: .calendar) == couponPolicyFingerprint(row(.calendar), kind: .calendar), "editor roundtrip preserves calendar")
    for (key, value) in [("dateFrom", "2026-02-30"), ("validUntil", "2020-01-01 00:00"), ("relativeDays", "0"), ("weekStartsOn", "0"), ("excludedDates", "2020-01-01")] { var changed = calendar; changed.fields[key] = value; check(bad { _ = try changed.rule() }, "invalid calendar " + key + " refused") }
    calendar.fields["reason"] = "实际修订"; calendar.fields["cutoff"] = "07:00"
    let cb = try board(.calendar, rows: [row(.calendar)])
    check(bad { _ = try cb.command(actor: user, action: "save", body: calendar.save(row: cb.rows[0]), row: cb.rows[0]) }, "same-code cutoff cannot reset usage counters")
    calendar.fields["code"] = "NEW_DATE_BASIS"
    _ = try cb.command(actor: user, action: "save", body: calendar.save(row: cb.rows[0]), row: cb.rows[0]); check(true, "new code can use new date basis")
    check(try couponCalendarMinute("24:00", end: true) == 1440 && bad { _ = try couponCalendarMinute("24:00") }, "24:00 only permitted as end")
    for value in ["90071992547409.92", "1e2", "0.001", "-1", "NaN"] { check(bad { _ = try couponPolicyMoney(value) }, "imprecise money refused") }
    check(try couponPolicyMoney("90071992547409.91") == 9_007_199_254_740_991, "maximum JS safe cents preserved exactly")
    var sd = StackingPolicyDraft(); sd.fields["maxCoupons"] = "2"
    check(bad { _ = try sd.policy() }, "no multi-coupon switch means maximum one")
    sd.fields["maxCoupons"] = "1"; sd.fields["order"] = "member,member,coupon"
    check(bad { _ = try sd.policy() }, "calculation stages must occur exactly once")
    var u = StackingUnitDraft(); u.amount = "10"; var e = StackingEffectDraft(); e.unitIDs = [u.id]; e.value = "2"
    _ = try stackingScenario(units: [u], effects: [e]); check(true, "typed scenario preserves unknown cost")
    e.unitIDs = [id(90)]; check(bad { _ = try stackingScenario(units: [u], effects: [e]) }, "deleted unit cannot keep orphan discount")
    e.unitIDs = [u.id]; e.stage = "points"; e.kind = "free"; check(bad { _ = try stackingScenario(units: [u], effects: [e]) }, "points cannot become free coupon")
    for fixture in fixtures["calendars"] as! [[String: Any]] {
      let body = fixture["body"] as! [String: Any], response = fixture["response"] as! [String: Any]
      _ = try CouponCalendarPreview(data: bytes(response), actor: user, body: body); check(true, "actual server calendar response accepted including relative validity")
      for key in ["employeeId", "previewOnly", "boundary"] { var changed = response; var d = response["data"] as! [String: Any]; d[key] = "wrong"; changed["data"] = d; check(bad { _ = try CouponCalendarPreview(data: bytes(changed), actor: user, body: body) }, "calendar preview wrong " + key + " rejected") }
    }
    for fixture in fixtures["stacking"] as! [[String: Any]] {
      let body = fixture["body"] as! [String: Any], response = fixture["response"] as! [String: Any]
      _ = try StackingPolicyPreview(data: bytes(response), actor: user, body: body); check(true, "actual server pricing with rounding unknown cost negative margin or max cents")
      for key in ["employeeId", "previewOnly", "orderAuthorization", "currency", "payableMinor", "costMinor"] {
        var changed = response; var d = response["data"] as! [String: Any]; d[key] = "wrong"; changed["data"] = d
        check(bad { _ = try StackingPolicyPreview(data: bytes(changed), actor: user, body: body) }, "pricing wrong " + key + " rejected")
      }
    }
    print("Coupon policy tests passed (\(count) assertions; 10 action recovery paths; 5 actual server preview fixtures)")
  }
}
