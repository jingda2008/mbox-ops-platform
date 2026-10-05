import Foundation

@main struct MemberCardTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ name: String) { precondition(value, name); count += 1; print("PASS " + name) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func bad(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "card-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "staff", "displayName": "审核员工", "roleCodes": ["MANAGER"]], "permissions": memberCardPermissions, "deniedPermissions": []]
    func actor(_ input: [String: Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(input)) }
    let user = try actor()
    let project: [String: Any] = ["id": id(10), "name": "爵士兴趣卡", "code": "JAZZ", "terms": "顾客自愿申请，本卡与等级和营销许可独立。", "kind": "interest", "status": "draft", "version": 1,
      "available_from": "2026-01-01 00:00:00+00", "available_until": "2099-01-01 00:00:00+00", "updated_at": "2026-10-05 00:00:00.123456+00", "created_by_employee_id": id(2),
      "require_social_conditions": true, "social_configuration_required": true, "cooperation_confirmed": false, "cooperation_valid_until": NSNull()]
    var openProject = project; openProject["id"] = id(11); openProject["status"] = "open"
    let application: [String: Any] = ["id": id(20), "project_id": id(10), "project_name": "爵士兴趣卡", "status": "pending", "customer_reference": "CUSTOMER_001", "member_no": "MEMBER001", "requested_at": "2026-10-05 00:00:00+00"]
    let holding: [String: Any] = ["id": id(30), "project_id": id(10), "project_name": "爵士兴趣卡", "status": "active", "customer_reference": "CUSTOMER_001", "updated_at": "2026-10-05 00:00:00.123456+00", "valid_until": "2099-01-01T00:00:00Z", "expired": false]
    var suspended = holding; suspended["id"] = id(31); suspended["status"] = "suspended"
    let source: [String: Any] = ["protocol": 1, "durableCommands": true, "employeeId": id(1), "section": "projects", "items": [project, openProject], "nextCursor": id(11)]
    func board(_ section: String = "projects", values: [[String: Any]]? = nil, as user: StaffIdentity? = nil, source override: [String: Any]? = nil) throws -> MemberCardsBoard {
      var value = override ?? source; value["section"] = section
      value["items"] = values ?? (section == "projects" ? [project, openProject] : section == "applications" ? [application] : [holding, suspended])
      return try MemberCardsBoard(data: bytes(["data": value]), actor: user ?? actor(), section: section)
    }
    let projects = try board(), applications = try board("applications"), holdings = try board("holdings")
    let draft = projects.rows[0], open = projects.rows[1], request = applications.rows[0], card = holdings.rows[0], paused = holdings.rows[1]
    let product: [String: Any] = ["id": id(50), "name": "卡内限定饮品", "guest_visible": false]
    let item: [String: Any] = ["product_id": id(50), "name": "卡内限定饮品", "exclusive": false, "active": true, "sort_order": 1, "exclusive_price_minor": "1500", "updated_at": "2026-10-05T00:00:00Z"]
    let configSource: [String: Any] = ["employeeId": id(1), "project": ["id": id(10), "status": "draft", "updated_at": project["updated_at"]!], "expectedMenu": String(repeating: "a", count: 64), "menu": [item],
      "accounts": [["id": id(60), "name": "本店服务号", "kind": "service_account", "enabled": true], ["id": id(61), "name": "本店企业微信", "kind": "wecom", "enabled": true]]]
    func config(_ data: [String: Any] = configSource) throws -> MemberCardConfig { try MemberCardConfig(data: bytes(["data": data]), actor: user, projectID: id(10)) }
    let configuration = try config(), chosen = try WalletRecord(product)
    let fields = ["code": "NEW_JAZZ", "name": "新爵士兴趣卡", "terms": "真实顾客须自愿申请，会员卡不会变更会员等级或营销许可。", "kind": "interest",
      "from": "2026-10-05 20:00", "until": "2098-10-05 20:00", "cooperationConfirmed": "false", "cooperationReference": "已核对合作合同", "cooperationUntil": "2098-10-05 20:00",
      "reason": "已核对原申请及当面事实", "serviceAccountId": id(60), "wecomAccountId": id(61), "artistName": "爵士驻演", "iconUrl": "/assets/card/jazz.svg", "autoRestore": "false",
      "exclusive": "true", "active": "true", "sortOrder": "2", "price": "15.01"]
    typealias Case = (String, String, MemberCardsBoard, WalletRecord?, String, WalletRecord?)
    let cases: [Case] = [("create", "create", projects, nil, "", nil), ("open", "state", projects, draft, "open", nil),
      ("pause", "state", projects, open, "paused", nil), ("close", "state", projects, draft, "closed", nil),
      ("approve", "review", applications, request, "approve", nil), ("reject", "review", applications, request, "reject", nil),
      ("suspend", "holding", holdings, card, "suspend", nil), ("resume", "holding", holdings, paused, "resume", nil),
      ("revoke", "holding", holdings, card, "revoke", nil), ("social", "social", projects, draft, "", nil),
      ("menu", "menu", projects, draft, "", chosen), ("menu-remove", "menu-remove", projects, draft, "", configuration.menu[0])]
    func command(_ c: Case, fields input: [String: String]? = nil, as identity: StaffIdentity? = nil) throws -> LiveCommand {
      try c.2.command(actor: identity ?? user, action: c.1, fields: input ?? fields, row: c.3, target: c.4, config: configuration, product: c.5)
    }
    check(memberCardSections(user) == ["projects", "applications", "holdings"], "card workspaces follow separate effective permissions")
    var reviewOnly = auth; reviewOnly["permissions"] = ["member.card.review"]
    check(try memberCardSections(actor(reviewOnly)) == ["applications"], "review-only actor cannot open projects or holdings")
    check(bad { _ = try board(as: actor(reviewOnly)) }, "project payload cannot leak behind review-only role")
    var wrong = source; wrong["employeeId"] = id(9)
    check(bad { _ = try board(source: wrong) }, "board rejects another actor")
    wrong = source; wrong["durableCommands"] = 1
    check(bad { _ = try board(source: wrong) }, "board requires boolean durable capability")
    check(bad { _ = try board(values: [project, project]) }, "duplicate original card projects rejected")
    check(try MemberCardsBoard.query(section: "projects", cursor: id(10)) == "?section=projects&cursor=" + id(10), "card pagination retains original opaque UUID")
    for pair in [("other", ""), ("projects", "x&section=holdings")] { check(bad { _ = try MemberCardsBoard.query(section: pair.0, cursor: pair.1) }, "card page query rejects untrusted scope") }
    func receipt(_ c: Case, _ work: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let b = work.steps[0].object
      var result: [String: Any] = [:]
      switch c.1 {
      case "create": result = ["projectId": id(90), "status": "draft"]
      case "state": result = ["projectId": b["projectId"]!, "status": b["state"]!]
      case "review": result = ["applicationId": b["applicationId"]!, "status": c.4 == "approve" ? "approved" : "rejected", "cardId": c.4 == "approve" ? id(90) as Any : NSNull()]
      case "holding": result = ["cardId": b["cardId"]!, "status": ["suspend": "suspended", "resume": "active", "revoke": "revoked"][c.4]!]
      case "social": result = ["projectId": b["projectId"]!, "configured": true]
      default: result = ["projectId": b["projectId"]!, "productId": b["productId"]!, c.1 == "menu" ? "saved" : "removed": true]
      }
      return ["meta": ["protocol": 1, "replayed": replayed], "data": ["employeeId": id(1), "action": c.1, "requestKey": work.steps[0].key, "result": result]]
    }
    for c in cases {
      let work = try command(c), step = work.steps[0]
      check(step.path == memberCardsRoot + "/commands/" + c.1 && step.key == "native-business-" + work.id, "\(c.0) original path and durable key frozen")
      let saved = try JSONEncoder().encode(work), restored = try JSONDecoder().decode(LiveCommand.self, from: saved)
      check(restored == work, "\(c.0) original command persists unchanged")
      var denied = auth; denied["deniedPermissions"] = [work.permission]
      check(bad { _ = try command(c, as: actor(denied)) }, "\(c.0) explicit current denial wins")
      try validateMemberCardReply(bytes(receipt(c, work)), step: step)
      check(true, "\(c.0) exact server receipt accepted")
      for key in ["employeeId", "action", "requestKey"] {
        var reply = receipt(c, work); var d = reply["data"] as! [String: Any]; d[key] = "wrong"; reply["data"] = d
        check(bad { try validateMemberCardReply(bytes(reply), step: step) }, "\(c.0) rejects wrong \(key)")
      }
      var fake = receipt(c, work); fake["meta"] = ["protocol": 1, "replayed": 1]
      check(bad { try validateMemberCardReply(bytes(fake), step: step) }, "\(c.0) integer replay flag rejected")
      let resultKeys = c.1 == "create" ? ["projectId", "status"] : c.1 == "state" ? ["projectId", "status"] : c.1 == "review" ? ["applicationId", "status"] : c.1 == "holding" ? ["cardId", "status"] : c.1 == "social" ? ["projectId", "configured"] : ["projectId", "productId", c.1 == "menu" ? "saved" : "removed"]
      for key in resultKeys {
        var reply = receipt(c, work); var d = reply["data"] as! [String: Any]; var r = d["result"] as! [String: Any]
        r[key] = ["configured", "saved", "removed"].contains(key) ? 1 : "wrong"
        d["result"] = r; reply["data"] = d
        check(bad { try validateMemberCardReply(bytes(reply), step: step) }, "\(c.0) refuses mismatched original result \(key)")
      }
      var persisted = saved, committed = 0, sends = 0
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.httpMethod == "POST", request.url?.path == step.path, request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let body = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: body) as! [String: Any]).isEqual(to: step.object) else { throw StaffAPIError.invalid }
        if committed == 0 { committed += 1; throw URLError(.timedOut) }
        return (try bytes(receipt(c, work, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ s: LiveCommand.Step) async throws { try validateMemberCardReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
      do { _ = try await LiveCommandRunner.advance(work, send: send, checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("unknown discarded") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self, from: persisted) == work, "\(c.0) response loss leaves original payload and key")
      let pending = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      let complete = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(complete.completedSteps == 1 && committed == 1 && sends == 2, "\(c.0) real StaffAPI adapter recovers original receipt without duplicate effect")
      _ = try await LiveCommandRunner.advance(complete, send: send, checkpoint: { _ in })
      check(sends == 2, "\(c.0) readback failure cannot repeat checkpointed operation")
    }
    let openCommand = try command(cases[1])
    check(openCommand.steps[0].object["expectedUpdatedAt"] as? String == project["updated_at"] as? String, "project command retains exact PostgreSQL microsecond version string")
    var owned = project; owned["created_by_employee_id"] = id(1); let ownBoard = try board(values: [owned])
    check(bad { _ = try ownBoard.command(actor: user, action: "state", fields: fields, row: ownBoard.rows[0], target: "open") }, "creator cannot self-publish card project")
    var closed = project; closed["status"] = "closed"; let closedBoard = try board(values: [closed])
    check(bad { _ = try closedBoard.command(actor: user, action: "state", fields: fields, row: closedBoard.rows[0], target: "open") }, "closed project cannot reopen")
    var notConfigured = project; notConfigured["require_social_conditions"] = false; let unconfigured = try board(values: [notConfigured])
    check(bad { _ = try unconfigured.command(actor: user, action: "state", fields: fields, row: unconfigured.rows[0], target: "open") }, "social configuration required before opening")
    var ended = suspended; ended["expired"] = true; let endedBoard = try board("holdings", values: [ended])
    check(bad { _ = try endedBoard.command(actor: user, action: "holding", fields: fields, row: endedBoard.rows[0], target: "resume") }, "expired card cannot resume")
    check(bad { _ = try projects.command(actor: user, action: "state", fields: fields, row: card, target: "open") }, "cannot use holding row as project authority")
    var malformed = fields; malformed["price"] = "1.001"
    check(bad { _ = try command(cases[10], fields: malformed) }, "exclusive price rejects fractional cents")
    malformed = fields; malformed["sortOrder"] = "1e2"
    check(bad { _ = try command(cases[10], fields: malformed) }, "menu ordering requires canonical integer")
    var publicProduct = product; publicProduct["guest_visible"] = true
    check(bad { _ = try projects.command(actor: user, action: "menu", fields: fields, row: draft, config: configuration, product: WalletRecord(publicProduct)) }, "public menu cannot be hidden as exclusive increment")
    check(bad { _ = try projects.command(actor: user, action: "menu", fields: fields, row: draft, config: configuration, product: configuration.menu[0]) }, "old menu with unknown public visibility cannot assume private")
    var associated = fields; associated["exclusive"] = "false"
    check(try projects.command(actor: user, action: "menu", fields: associated, row: draft, config: configuration, product: configuration.menu[0]).steps.count == 1, "existing associated menu remains editable without fabricated public flag")
    var changedConfig = configSource; changedConfig["project"] = ["id": id(10), "status": "draft", "updated_at": "2026-10-05T00:01:00Z"]
    check(bad { _ = try projects.command(actor: user, action: "social", fields: fields, row: draft, config: config(changedConfig)) }, "social edit refuses stale original project timestamp")
    malformed = fields; malformed["serviceAccountId"] = id(61)
    check(bad { _ = try command(cases[9], fields: malformed) }, "wecom account cannot substitute for service account")
    for icon in ["https://example.com/a.svg", "/assets/../private/secret", "/other/icon.svg"] { malformed = fields; malformed["iconUrl"] = icon; check(bad { _ = try command(cases[9], fields: malformed) }, "card icon must remain supported site asset") }
    let menuConfirmation = try command(cases[10]).steps[0].memberCardProof!["confirmation"] as! String
    for text in ["爵士兴趣卡", "卡内限定饮品", "专属增量", "15.01", "排序：2"] { check(menuConfirmation.contains(text), "menu confirmation shows \(text)") }
    let createConfirmation = try command(cases[0]).steps[0].memberCardProof!["confirmation"] as! String
    check(createConfirmation.contains(fields["terms"]!) && createConfirmation.contains("2098-10-05 20:00"), "creation confirmation preserves full terms and end date")
    let socialConfirmation = try command(cases[9]).steps[0].memberCardProof!["confirmation"] as! String
    for text in ["本店服务号", "本店企业微信", "爵士驻演", "自动恢复：关闭"] { check(socialConfirmation.contains(text), "social confirmation identifies \(text)") }
    let products = try MemberCardProducts(data: bytes(["data": ["employeeId": id(1), "items": [product], "nextOffset": 100]]), actor: user)
    check(products.rows.count == 1 && products.nextOffset == 100, "member card product page respects server page size")
    let query = try MemberCardProducts.query(search: "爵士+限定&offset=99", offset: 0)
    let decoded = query.dropFirst().split(separator: "&")[0].dropFirst("search=".count).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    check(decoded == "爵士+限定&offset=99", "card product query encodes literal plus and delimiters")
    print("Member card tests: \(count) passed")
  }
}
