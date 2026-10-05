import Foundation

@main struct MembershipConfigTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ name: String) { precondition(value, name); count += 1; print("PASS " + name) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func bad(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let now = ISO8601DateFormatter().date(from: "2026-10-05T00:00:00Z")!
    let auth: [String: Any] = ["session": ["id": "rules-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "staff", "displayName": "授权规则管理员", "roleCodes": ["MANAGER"]], "permissions": membershipConfigPermissions, "deniedPermissions": []]
    func actor(_ input: [String: Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(input)) }
    let user = try actor()
    func content(_ domain: String) -> [String: Any] {
      if domain == "wechat_notifications" { return ["domain": domain, "notificationType": "loyalty_points_credited", "authorizationPurpose": "loyalty_balance_change", "authorizationContext": "loyalty_accrual", "templateId": "actual_template_id", "pagePath": "pages/account/index", "pointsDataKey": "number1", "balanceDataKey": "number2", "occurredAtDataKey": "date3", "expiresAtDataKey": NSNull(), "expiryLeadDays": NSNull(), "maxPerCustomerPer24h": 2, "minimumIntervalMinutes": 60, "quietHoursStart": "22:00", "quietHoursEnd": "08:00"] }
      var c = membershipDefaultContents[domain]!
      switch domain {
      case "tier_policy": c["silverUpgradeGrowth"] = 100; c["goldUpgradeGrowth"] = 200
      case "tier_benefits":
        var rule = membershipDefaultItems[domain]!; rule["ruleCode"] = "ENTRY"; rule["benefitDefinitionId"] = id(52)
        c["tierPolicyVersionId"] = id(51); c["rules"] = [rule]
      case "redemption_catalog":
        var item = membershipDefaultItems[domain]!; item["publicId"] = "RDI-" + id(54); item["itemCode"] = "SNACK"; item["name"] = "招牌小食"; item["productId"] = id(53); item["pointsRequired"] = 100; item["costAmountMinor"] = 1501; item["availableFrom"] = "2026-10-05T00:00:00Z"; c["items"] = [item]
      case "promotion_points":
        c["campaignCode"] = "MUSIC"; c["name"] = "演出奖励"; c["activityId"] = id(55); c["stackingGroup"] = "NIGHT"; c["storeBudgetPoints"] = 1000; c["perMemberPointsLimit"] = 100
        var rule = membershipDefaultItems[domain]!; rule["ruleCode"] = "PAID"; rule["points"] = 10; rule["minimumPaidAmountMinor"] = 10001; c["rules"] = [rule]
      case "membership_terms": c["title"] = "本店入会条款"; c["summary"] = "请自愿审阅后加入会员"; c["content"] = "会员须本人审阅完整条款并自愿同意；员工不能代替会员同意。"
      default: break
      }
      return c
    }
    let refs: [[String: Any]] = [(51,"tierPolicyVersionId","当前等级规则"),(52,"benefitDefinitionId","欢迎小食"),(53,"productId","招牌小食"),(55,"activityId","爵士演出")].map { ["id": id($0.0), "kind": $0.1, "name": $0.2, "status": "published"] }
    func preview(_ domain: String, expires: String = "2099-01-01T00:00:00Z") -> [String: Any] {
      ["publicId": "MCIP-" + id(70), "draftPublicId": id(10), "draftRevision": 3, "domain": domain, "expiresAt": expires, "generatedAt": "2026-10-05T00:00:00Z", "fingerprint": "server_fingerprint", "historicalMembership": ["activeMembers": 20], "affectedExistingMembers": 10, "estimatedPointsIssued": 25, "estimatedPointsCostAmountMinor": 123, "estimatedBenefitCostAmountMinor": 456, "estimatedRedemptionCostAmountMinor": 789, "fulfillment": [["referenceCode": "SNACK", "expectedDemand": 2, "availableAfterReservations": NSNull(), "shortage": 0, "openFulfillmentTasks": 1]], "warnings": ["terms_reacceptance_not_forced", "inventory_shortage"]]
    }
    func summary(_ domain: String, status: String = "draft", revision: Int = 3, approver: String? = nil) -> [String: Any] {
      ["domain": domain, "configurationId": id(10), "status": status, "revision": revision, "version": 2, "title": "真实门店规则", "updatedAt": "2026-10-05T00:00:00Z", "approvedByEmployeeId": approver ?? id(3)]
    }
    func board(_ domain: String = "base_points", status: String = "draft", revision: Int = 3, source: [[String: Any]]? = nil, as who: StaffIdentity? = nil, section: String = "rules", enabled: Any = true) throws -> MembershipConfigBoard {
      try MembershipConfigBoard(data: bytes(["data": ["section": section, "employeeId": id(1), "durableCommands": enabled, "protocol": 1, "items": source ?? [summary(domain, status: status, revision: revision)], "references": refs]]), actor: who ?? user, section: section)
    }
    func detail(_ domain: String, status: String = "draft", revision: Int = 3, makers: [String]? = nil, impact: [String: Any]? = nil, fields: [String: Any]? = nil) throws -> MembershipConfigDetail {
      try MembershipConfigDetail(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "draft": ["publicId": id(10), "domain": domain, "status": status, "revision": revision, "makerEmployeeIds": makers ?? [id(2)], "content": fields ?? content(domain)], "preview": impact ?? preview(domain)]]), actor: user, domain: domain, configurationID: id(10))
    }
    typealias Case = (String, String, MembershipConfigBoard, MembershipConfigDetail?, MembershipRecord?)
    var cases: [Case] = []
    for domain in membershipDomainNames.keys.sorted() {
      try validateMembershipContent(content(domain))
      check(true, domain + " complete server schema and business constraints")
      let b = try board(domain), d = try detail(domain)
      if domain != "wechat_notifications" { cases.append((domain, "create", b, nil, nil)) }
      for action in ["edit", "preview", "approve"] { cases.append((domain, action, b, d, nil)) }
      cases.append((domain, "publish", try board(domain, status: "approved"), try detail(domain, status: "approved"), nil))
    }
    for capability in membershipControls.keys.sorted() { for state in ["active", "paused"] {
      let b = try board(source: [["capability": capability, "state": state, "version": 0, "pendingAccrualCount": 2]], section: "controls")
      cases.append(("", "control", b, nil, b.rows[0]))
    } }
    func command(_ c: Case, as who: StaffIdentity? = nil) throws -> LiveCommand {
      try c.2.command(actor: who ?? user, action: c.1, domain: c.0, content: ["edit", "create"].contains(c.1) ? content(c.0) : nil, detail: c.3, control: c.4, reason: "已核对门店规则与业务影响", from: "2098-10-05 20:00", now: now)
    }
    func receipt(_ c: Case, _ work: LiveCommand, replayed: Bool = false) -> [String: Any] {
      var result: [String: Any]
      switch c.1 {
      case "control": result = ["capability": c.4!.text("capability"), "version": 1, "state": c.4!.text("state") == "active" ? "paused" : "active"]
      case "create", "publish": result = ["id": id(10), "status": c.1 == "create" ? "draft" : "published"]
      case "preview": result = preview(c.0, expires: "2026-10-05T01:00:00Z")
      default: result = ["publicId": id(10), "domain": c.0, "status": c.1 == "edit" ? "draft" : "approved", "revision": c.1 == "edit" ? 4 : 3, "content": content(c.0)]
      }
      return ["meta": ["protocol": 1, "replayed": replayed], "data": ["employeeId": id(1), "action": c.1, "domain": c.0, "requestKey": work.steps[0].key, "configurationId": c.1 == "control" ? NSNull() : id(10) as Any, "result": result]]
    }
    for c in cases {
      let label = c.0 + " " + c.1 + (c.4.map { " " + $0.text("capability") + " " + $0.text("state") } ?? "")
      let work = try command(c), step = work.steps[0], saved = try JSONEncoder().encode(work)
      check(step.path == membershipConfigRoot + "/commands" && step.key == "native-business-" + work.id, label + " preserves original durable request")
      check(try JSONDecoder().decode(LiveCommand.self, from: saved) == work, label + " complete command survives process death")
      var denied = auth; denied["deniedPermissions"] = [work.permission]
      check(bad { _ = try command(c, as: actor(denied)) }, label + " current explicit permission denial wins")
      try validateMembershipConfigReply(bytes(receipt(c, work)), step: step)
      check(true, label + " accepts original result even if preview is now expired")
      for key in ["employeeId", "action", "domain", "requestKey", "configurationId"] {
        var reply = receipt(c, work); var d = reply["data"] as! [String: Any]; d[key] = "wrong"; reply["data"] = d
        check(bad { try validateMembershipConfigReply(bytes(reply), step: step) }, label + " rejects different " + key)
      }
      var invalidMeta = receipt(c, work); invalidMeta["meta"] = ["protocol": 1, "replayed": 1]
      check(bad { try validateMembershipConfigReply(bytes(invalidMeta), step: step) }, label + " requires real boolean replay flag")
      var wrongResult = receipt(c, work); var envelope = wrongResult["data"] as! [String: Any]; var result = envelope["result"] as! [String: Any]
      let originalKey = c.1 == "control" ? "capability" : c.1 == "preview" ? "draftPublicId" : ["edit", "approve"].contains(c.1) ? "publicId" : "id"
      result[originalKey] = id(99); envelope["result"] = result; wrongResult["data"] = envelope
      check(bad { try validateMembershipConfigReply(bytes(wrongResult), step: step) }, label + " rejects wrong original result")
      if ["edit", "approve"].contains(c.1) {
        var wrong = receipt(c, work); var d = wrong["data"] as! [String: Any]; var r = d["result"] as! [String: Any]; r["content"] = ["domain": c.0]; d["result"] = r; wrong["data"] = d
        check(bad { try validateMembershipConfigReply(bytes(wrong), step: step) }, label + " rejects altered amounts or rule content")
      }
      var persisted = saved, commits = 0, sends = 0
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.httpMethod == "POST", request.url?.path == step.path, request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let body = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: body) as! [String: Any]).isEqual(to: step.object) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1; throw URLError(.timedOut) }
        return (try bytes(receipt(c, work, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ s: LiveCommand.Step) async throws { try validateMembershipConfigReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
      do { _ = try await LiveCommandRunner.advance(work, send: send, checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("unknown result discarded") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self, from: persisted) == work, label + " lost success preserves original payload/key")
      let complete = try await LiveCommandRunner.advance(JSONDecoder().decode(LiveCommand.self, from: persisted), send: send, checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(complete.completedSteps == 1 && commits == 1 && sends == 2, label + " StaffAPI adapter recovers one committed operation")
      _ = try await LiveCommandRunner.advance(complete, send: send, checkpoint: { _ in })
      check(sends == 2, label + " stale readback cannot resend completed operation")
    }
    check(cases.count == 40, "six create domains seven edit preview approve publish and six control transitions")
    let b = try board(), d = try detail("base_points")
    check(bad { _ = try b.command(actor: user, action: "create", domain: "wechat_notifications", content: content("wechat_notifications"), reason: "真实依据") }, "managed notification draft cannot be created by unsupported endpoint")
    check(bad { _ = try b.command(actor: user, action: "approve", domain: "base_points", detail: detail("base_points", makers: [id(1)]), reason: "真实依据", now: now) }, "all draft makers cannot self approve")
    check(bad { _ = try b.command(actor: user, action: "approve", domain: "base_points", detail: detail("base_points", impact: preview("base_points", expires: "2020-01-01T00:00:00Z")), reason: "真实依据", now: now) }, "new approval requires unexpired original preview")
    check(bad { _ = try b.command(actor: user, action: "preview", domain: "base_points", detail: detail("base_points", revision: 4), now: now) }, "stale summary and draft cannot form command")
    var changed = content("base_points"); changed["pointsNumerator"] = 2
    check(bad { _ = try b.command(actor: user, action: "preview", domain: "base_points", content: changed, detail: d, now: now) }, "unsaved change cannot preview original content as current")
    let approved = try detail("base_points", status: "approved")
    check(bad { _ = try board(status: "approved", source: [summary("base_points", status: "approved", approver: id(1))]).command(actor: user, action: "publish", domain: "base_points", detail: approved, reason: "真实依据", from: "2098-01-01 00:00", now: now) }, "approver cannot publish own approval")
    check(bad { _ = try board(status: "approved").command(actor: user, action: "publish", domain: "base_points", detail: detail("base_points", status: "approved", makers: [id(1)]), reason: "真实依据", from: "2098-01-01 00:00", now: now) }, "publisher differs from every maker")
    check(bad { _ = try board(status: "approved").command(actor: user, action: "publish", domain: "base_points", detail: approved, reason: "真实依据", from: "2020-01-01 00:00", now: now) }, "publication rejects backdated effect")
    check(bad { _ = try board("membership_terms", status: "approved").command(actor: user, action: "publish", domain: "membership_terms", detail: detail("membership_terms", status: "approved"), reason: "真实依据", from: "2098-01-01 00:00", until: "2098-02-01 00:00", now: now) }, "membership terms cannot schedule expiry")
    for target in ["base_points/../../staff", "base_points/" + id(10) + "/edit", "unknown/" + id(10)] { check(bad { _ = try MembershipConfigDetail.path(target: target) }, "detail route rejects non-original domain or ID") }
    check(try MembershipConfigDetail.path(target: "base_points/" + id(10)) == membershipConfigRoot + "/base_points/" + id(10), "detail path is full API path")
    check(bad { _ = try board(enabled: 1) }, "integer durable capability is invalid")
    check(bad { _ = try board(source: [summary("base_points"),summary("base_points")]) }, "duplicate original versions rejected")
    var denied = auth; denied["deniedPermissions"] = ["loyalty.configuration.view"]
    check(bad { _ = try board(as: actor(denied)) }, "read denied prevents private rule board")
    let disabled = try board(enabled: false)
    check(bad { _ = try disabled.command(actor: user, action: "preview", domain: "base_points", detail: d, now: now) }, "old server without permanent receipt stays read only")
    for invalid in ["1.001", "1e2", "-1", "21474836.48", "01.00"] {
      var form = try newMembershipContent("base_points"); form["pointsDenominatorMinor"] = invalid
      check(bad { _ = try membershipNormalizeContent(form) }, "invalid or overflowing cents rejected: " + invalid)
    }
    var precision = try newMembershipContent("base_points"); precision["pointsDenominatorMinor"] = "21474836.47"
    check(try walletInteger(membershipNormalizeContent(precision)["pointsDenominatorMinor"]) == 2147483647, "max signed integer cents survives exact decimal conversion")
    var zero = try newMembershipItem("redemption_catalog"); zero["totalInventory"] = "0"; zero["dailyInventory"] = ""
    let normalizedZero = try membershipNormalizeContent(zero.merging(["availableFrom":"2098-01-01 00:00"]) { _,v in v })
    check(try walletInteger(normalizedZero["totalInventory"]) == 0 && normalizedZero["dailyInventory"] is NSNull, "no stock and unlimited stock remain distinct")
    for domain in membershipDomainNames.keys.sorted() {
      let original = content(domain), restored = try membershipNormalizeContent(membershipEditingContent(original))
      check(membershipEqual(original, restored), domain + " edit normalization retains exact original content")
      var unknown = original; unknown["unsupported"] = 1
      check(bad { try validateMembershipContent(unknown) }, domain + " strict field schema blocks unknown settings")
    }
    for invalid in ["2026-02-30 12:00", "2026-13-01 12:00:00", "2026-10-05 24:01", "2026-10-05T12:00"] { check(bad { _ = try membershipDate(invalid) }, "strict Beijing date rejects impossible input") }
    var badBase = content("base_points"); badBase["pointsNumerator"] = true
    check(bad { try validateMembershipContent(badBase) }, "boolean cannot substitute for points")
    var badTier = content("tier_policy"); badTier["goldUpgradeGrowth"] = 50
    check(bad { try validateMembershipContent(badTier) }, "gold threshold must exceed silver")
    var badBenefits = content("tier_benefits"); var benefit = (badBenefits["rules"] as! [[String: Any]])[0]; benefit["grantOnEntry"] = false; badBenefits["rules"] = [benefit]
    check(bad { try validateMembershipContent(badBenefits) }, "benefit must have entry or retention trigger")
    var duplicate = content("tier_benefits"); let row = (duplicate["rules"] as! [[String: Any]])[0]; duplicate["rules"] = [row,row]
    check(bad { try validateMembershipContent(duplicate) }, "duplicate rule code rejected")
    var promo = content("promotion_points"); promo["eligibleMemberLevels"] = ["member","member"]
    check(bad { try validateMembershipContent(promo) }, "duplicate member tiers rejected")
    promo = content("promotion_points"); var rule = (promo["rules"] as! [[String: Any]])[0]; rule["triggerKind"] = "activity_completion"; promo["rules"] = [rule]
    check(bad { try validateMembershipContent(promo) }, "nonpayment trigger cannot invent minimum payment")
    var wx = content("wechat_notifications"); wx["authorizationContext"] = "loyalty_expiry"
    check(bad { try validateMembershipContent(wx) }, "notification authorization must match type")
    wx = content("wechat_notifications"); wx["quietHoursEnd"] = NSNull()
    check(bad { try validateMembershipContent(wx) }, "quiet hours cannot omit one endpoint")
    wx = content("wechat_notifications"); wx["quietHoursStart"] = "25:00"
    check(bad { try validateMembershipContent(wx) }, "quiet hours reject impossible time")
    let summaryText = try membershipContentSummary(content("redemption_catalog"), references: b.references)
    for visible in ["招牌小食","15.01","每人30天滚动上限","库存","100"] { check(summaryText.contains(visible), "confirmation shows " + visible) }
    let impact = try membershipImpactSummary(MembershipRecord(preview("base_points")))
    for visible in ["估算","1.23","4.56","7.89","20","10","未知","不强迫"] { check(impact.contains(visible), "impact summary shows " + visible) }
    for domain in ["redemption_catalog", "wechat_notifications", "promotion_points", "tier_benefits"] {
      let original = content(domain)
      var returned = original
      if domain == "redemption_catalog" {
        var items = returned["items"] as! [[String: Any]]; items[0]["availableFrom"] = "2026-10-05 00:00:00+00"; returned["items"] = items
      } else if domain == "wechat_notifications" { returned["quietHoursStart"] = "22:00:00"; returned["quietHoursEnd"] = "08:00:00" }
      else {
        var row = (original["rules"] as! [[String: Any]])[0]; row["ruleCode"] = "ZZZ"
        var input = original; input["rules"] = [row] + (original["rules"] as! [[String: Any]])
        returned["rules"] = (original["rules"] as! [[String: Any]]) + [row]
        check(try membershipContentFingerprint(input) == membershipContentFingerprint(returned), domain + " PostgreSQL row ordering preserves original meaning")
      }
      if ["redemption_catalog", "wechat_notifications"].contains(domain) {
        check(try membershipContentFingerprint(original) == membershipContentFingerprint(returned), domain + " PostgreSQL timestamp/time normalization accepted")
        let c = cases.first { $0.0 == domain && $0.1 == "edit" }!, work = try command(c)
        var reply = receipt(c, work); var envelope = reply["data"] as! [String: Any]; var result = envelope["result"] as! [String: Any]
        result["content"] = returned; envelope["result"] = result; reply["data"] = envelope
        try validateMembershipConfigReply(bytes(reply), step: work.steps[0])
        check(true, domain + " real repository-format edit receipt accepted")
      }
    }
    print("Membership configuration tests passed (\(count) assertions; \(cases.count) action branches)")
  }
}
