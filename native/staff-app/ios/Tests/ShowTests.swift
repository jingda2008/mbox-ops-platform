import Foundation

@main struct ShowTests {
  @MainActor static func main() async throws {
    var checks = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1; print("PASS " + label) }
    func rejects(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try JSONDecoder().decode(type, from: showBytes(value)) }
    let hash = String(repeating: "a", count: 64)
    let auth: [String: Any] = ["session": ["id": "show-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "stage", "displayName": "演出管理", "roleCodes": ["OWNER"]], "permissions": showPermissions, "deniedPermissions": []]
    let actor = try decode(StaffIdentity.self, auth)
    let performer: [String: Any] = ["id": id(2), "code": "PERFORMER_A", "stageName": "歌手甲", "status": "active", "profileSnapshot": ["genres": ["民谣"], "imageUrl": "/public/media-assets/kept"], "configurationFingerprint": hash]
    let schedule: [String: Any] = ["id": id(3), "performerId": id(2), "performerStageName": "歌手甲", "status": "scheduled", "startsAt": "2099-10-01 12:00:00+00", "endsAt": "2099-10-01 14:00:00+00", "sortOrder": 0, "configurationFingerprint": hash]
    var next = schedule; next["id"] = id(4); next["startsAt"] = "2099-10-02 12:00:00+00"; next["endsAt"] = "2099-10-02 14:00:00+00"
    let phase: [String: Any] = ["publicId": "PHASE-ORIGINAL-1", "scheduleId": id(3), "performerStageName": "歌手甲", "phaseCode": "band_live", "status": "active", "startedAt": "2099-10-01 12:10:00+00"]
    func board(performing: Bool = false, withPhase: Bool = false, user: StaffIdentity? = nil, durable: Any = true, month: String = "2099-10") throws -> ShowBoard {
      var current = schedule; if performing { current["status"] = "performing" }
      return try ShowBoard(showBytes(["data": ["month": month, "employeeId": (user ?? actor).employee.id, "durableCommands": durable, "protocol": 1, "schedules": [current, next], "performers": [performer], "phases": withPhase ? [phase] : [], "revisions": []]]), actor: user ?? actor, month: month)
    }
    let base = try board(), performing = try board(performing: true), active = try board(performing: true, withPhase: true)
    let song: [String: Any] = ["id": id(7), "performerId": id(2), "code": "S1", "title": "原曲目", "aliases": ["别名"], "status": "active", "requestCount": 2, "performedCount": 1, "configurationFingerprint": hash]
    let catalog = try ShowCatalog(showBytes(["data": ["songs": [song], "total": 1, "totalSongs": 8, "nextOffset": NSNull(), "catalogFingerprint": hash]]), actor: actor, performerID: id(2))
    let slot: [String: Any] = ["performerId": id(2), "startsAt": "2099-10-03T12:00:00Z", "endsAt": "2099-10-03T14:00:00Z"]
    let publish: [String: Any] = ["month": "2099-10", "slots": [slot]]
    var slotReply = slot; slotReply["reasons"] = []; slotReply["existingId"] = NSNull(); slotReply["performerName"] = "歌手甲"
    let preview = try ShowPublishPreview(body: publish, response: showBytes(["data": ["slots": [slotReply]]]), board: base)
    let changes: [String: Any] = ["code": "S1", "title": "更新曲目", "aliases": ["另一别名"], "status": "inactive"]
    let revisions: [[String: Any]] = [
      ["scheduleId": id(3), "expected": hash, "kind": "rescheduled", "startsAt": "2099-10-03T12:00:00Z", "endsAt": "2099-10-03T14:00:00Z", "replacementScheduleId": NSNull(), "replacementExpected": NSNull(), "reason": "现场协调改期"],
      ["scheduleId": id(3), "expected": hash, "kind": "cancelled", "startsAt": NSNull(), "endsAt": NSNull(), "replacementScheduleId": NSNull(), "replacementExpected": NSNull(), "reason": "现场协调取消"],
      ["scheduleId": id(3), "expected": hash, "kind": "replaced", "startsAt": NSNull(), "endsAt": NSNull(), "replacementScheduleId": id(4), "replacementExpected": hash, "reason": "现场协调换场"]]
    let cases: [(String, [String: Any], ShowBoard)] = [
      ("publish", publish, base), ("schedule-status", ["scheduleId": id(3), "expected": hash, "targetStatus": "performing"], base),
      ("schedule-status", ["scheduleId": id(3), "expected": hash, "targetStatus": "completed"], performing),
      ("schedule-sort", ["scheduleId": id(3), "expected": hash, "sortOrder": 3], base),
      ("revision", revisions[0], base), ("revision", revisions[1], base), ("revision", revisions[2], base),
      ("phase-start", ["scheduleId": id(3), "expected": hash, "phaseCode": "band_live", "reason": "现场乐队开始"], performing),
      ("phase-end", ["publicId": "PHASE-ORIGINAL-1", "reason": "现场阶段结束"], active),
      ("phase-cancel", ["publicId": "PHASE-ORIGINAL-1", "reason": "核对误启动阶段"], active),
      ("performer-create", ["code": "PERFORMER_B", "stageName": "歌手乙", "profileSnapshot": ["genres": ["摇滚"]], "status": "active"], base),
      ("performer-update", ["performerId": id(2), "expected": hash, "stageName": "歌手甲更新", "profileSnapshot": ["genres": ["民谣"], "imageUrl": "/public/media-assets/kept"], "status": "inactive"], base),
      ("songs-import", ["performerId": id(2), "expected": hash, "sourceName": "iOS曲库", "mode": "upsert", "songs": [changes]], base),
      ("songs-import", ["performerId": id(2), "expected": hash, "sourceName": "iOS曲库", "mode": "replace", "songs": []], base),
      ("song-update", ["songId": id(7), "expected": hash, "changes": changes], base)]
    var commands: [LiveCommand] = []
    for (action, body, board) in cases {
      commands.append(try board.command(actor: actor, action: action, body: body, confirmation: "原场次与私密说明已核对", preview: preview, catalog: catalog))
    }
    let rawRequest: [String: Any] = ["id": id(10), "tableSessionId": id(11), "performerId": id(2), "scheduleId": id(3), "songTitle": "顾客点歌", "status": "requested", "quotedAmountMinor": NSNull(), "currency": NSNull(), "createdAt": "2026-10-05 12:00:00+00", "note": "会员私密说明"]
    func songBoard(_ status: String, amount: Any = NSNull(), user: StaffIdentity? = nil, enabled: Bool = true) throws -> ShowSongBoard {
      var value = rawRequest; value["status"] = status; value["quotedAmountMinor"] = amount; value["currency"] = amount is NSNull ? NSNull() : "CNY"
      return try ShowSongBoard(data: showBytes(["data": [value]]), capability: showBytes(["data": ["durableTransitions": enabled]]), actor: user ?? actor, status: status)
    }
    let requested = try songBoard("requested"), accepted = try songBoard("accepted", amount: 1001), paid = try songBoard("paid", amount: 1001), free = try songBoard("accepted", amount: 0)
    let payment = try ShowPaymentEvidence(["paymentId": id(12), "reconciliationEntryId": id(13), "publicId": "PAY-ORIGINAL", "amountMinor": "1001", "currency": "CNY", "createdAt": "2026-10-05 12:00:00+00", "provider": "cash"], request: accepted.rows[0], actor: actor)
    for (action, board) in [("confirm", requested), ("reject", requested), ("cancel", requested), ("paid", accepted), ("performed", paid), ("performed", free)] {
      commands.append(try board.command(actor: actor, row: board.rows[0], action: action, reason: "现场核对私密办理说明", amountText: "10.01", evidence: action == "paid" ? payment : nil))
    }
    func receipt(_ command: LiveCommand, replayed: Bool = false) throws -> [String: Any] {
      let step = command.steps[0], proof = step.showProof!, kind = proof["kind"] as! String, action = proof["action"] as! String, body = step.object
      if kind == "song" {
        var row = rawRequest; row.merge(proof["expectation"] as! [String: Any]) { _, next in next }
        return ["meta": ["replayed": replayed], "data": ["request": row, "action": action, "previousStatus": body["expectedStatus"]!, "reason": body["reason"]!, "paymentId": body["paymentId"] ?? NSNull(), "reconciliationEntryId": body["reconciliationEntryId"] ?? NSNull()]]
      }
      var result: [String: Any] = [:]
      switch action {
      case "publish": result = ["month": body["month"]!, "scheduleIds": [id(9)], "createdCount": 1, "existingCount": 0]
      case "schedule-status": result = ["id": body["scheduleId"]!, "status": body["targetStatus"]!]
      case "schedule-sort": result = ["id": body["scheduleId"]!, "sortOrder": body["sortOrder"]!]
      case "revision": result = ["scheduleId": body["scheduleId"]!, "kind": body["kind"]!, "createdByEmployeeId": actor.employee.id, "revisionNumber": 1, "affectedReservations": 7]
      case "phase-start": result = ["scheduleId": body["scheduleId"]!, "phaseCode": body["phaseCode"]!, "status": "active"]
      case "phase-end", "phase-cancel": result = ["publicId": body["publicId"]!, "status": action == "phase-end" ? "ended" : "cancelled"]
      case "performer-create", "performer-update": result = ["id": body["performerId"] ?? id(9), "stageName": body["stageName"]!, "status": body["status"]!]
      case "songs-import": result = ["performerId": body["performerId"]!, "mode": body["mode"]!, "importedCount": (body["songs"] as! [[String: Any]]).count, "rejectedCount": 0]
      case "song-update": let changes = body["changes"] as! [String: Any]; result = ["id": body["songId"]!, "title": changes["title"]!, "status": changes["status"]!]
      default: throw StaffAPIError.invalid
      }
      return ["meta": ["protocol": 1, "replayed": replayed], "data": ["action": action, "employeeId": actor.employee.id, "requestKey": step.key, "result": result]]
    }
    for (index, plain) in commands.enumerated() {
      let label = "\(index + 1) " + plain.title
      var vault: [String: String] = [:]
      let secure = try secureShowCommand(plain) { vault[$0] = $1 }, step = secure.steps[0]
      let disk = try JSONEncoder().encode(secure), text = String(decoding: disk, as: UTF8.self)
      check(!text.contains("私密") && !text.contains("歌手") && !text.contains("quotedAmountMinor") && !text.contains("reason") && step.object.isEmpty,
        label + " keeps customer/performer details, amount and reason out of ordinary pending")
      let restored = try JSONDecoder().decode(LiveCommand.self, from: disk)
      let payload = try showRequestPayload(restored, step: restored.steps[0], read: { vault[$0]! })
      check(NSDictionary(dictionary: payload.body).isEqual(to: plain.steps[0].object), label + " exact secure original request restored")
      _ = try validateShowReceipt(showBytes(receipt(plain)), step: step, body: payload.body, expectation: payload.expectation)
      check(true, label + " correct original receipt validated")
      var wrong = try receipt(plain); var bad = wrong["data"] as! [String: Any]; bad["action"] = "wrong"; wrong["data"] = bad
      check(rejects { _ = try validateShowReceipt(showBytes(wrong), step: step, body: payload.body, expectation: payload.expectation) }, label + " rejects another operation receipt")
      var sends = 0, commits = 0, persisted = disk
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try showBytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.httpMethod == "POST", request.url?.path == step.path, request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == actor.employee.id, let body = request.httpBody,
          NSDictionary(dictionary: try showObject(body)).isEqual(to: plain.steps[0].object) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1; throw URLError(.timedOut) }
        return (try showBytes(receipt(plain, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "stage", pin: "1234", switching: false)
      func send(_ original: LiveCommand, _ step: LiveCommand.Step) async throws {
        let payload = try showRequestPayload(original, step: step, read: { vault[$0]! })
        let bytes = try await api.raw(step.path, body: payload.body, headers: [step.keyHeader: step.key]).0
        _ = try validateShowReceipt(bytes, step: step, body: payload.body, expectation: payload.expectation)
      }
      do { _ = try await LiveCommandRunner.advance(secure, send: { try await send(secure, $0) }, checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("lost receipt must remain unknown") } catch {}
      check(persisted == disk, label + " timeout preserves original key/payload")
      let resumed = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      let done = try await LiveCommandRunner.advance(resumed, send: { try await send(resumed, $0) }, checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(done.completedSteps == 1 && sends == 2 && commits == 1, label + " actual API adapter replay has one simulated effect")
      _ = try await LiveCommandRunner.advance(done, send: { try await send(done, $0) }, checkpoint: { _ in })
      check(sends == 2, label + " refresh failure never resends checkpointed operation")
    }
    check(try showInputTime("2099-10-01 20:00") == "2099-10-01T12:00:00Z", "show entry time uses Shanghai timezone")
    check(showTime("2099-10-01 12:00:00.123456+00") == "2099-10-01 20:00", "actual PostgreSQL text time displays correctly")
    for time in ["2026-02-30 20:00", "2026-10-05 24:00", "2026-10-05T20:00", "2026-1-1 20:00"] { check(rejects { _ = try showInputTime(time) }, "invalid local date rejected \(time)") }
    for month in ["2026-13", "1999-10", "2026-1", "2026-10\n"] { check(rejects { _ = try showMonth(month) }, "invalid month rejected") }
    check(rejects { _ = try base.command(actor: actor, action: "publish", body: publish, confirmation: "发布") }, "publication cannot skip server conflict preview")
    var conflict = slotReply; conflict["reasons"] = ["与原场重叠"]
    let blockedPreview = try ShowPublishPreview(body: publish, response: showBytes(["data": ["slots": [conflict]]]), board: base)
    check(!blockedPreview.valid && rejects { _ = try base.command(actor: actor, action: "publish", body: publish, confirmation: "发布", preview: blockedPreview) }, "conflicting preview cannot publish")
    var anotherSlot = slotReply; anotherSlot["performerId"] = id(90)
    check(rejects { _ = try ShowPublishPreview(body: publish, response: showBytes(["data": ["slots": [anotherSlot]]]), board: base) }, "preview must match every original performer/time")
    var wrongMonth = publish; wrongMonth["month"] = "2099-11"
    check(rejects { try validateShowSlots(wrongMonth, board: base) }, "publication stays bound to loaded month")
    var long = slot; long["endsAt"] = "2099-10-04T12:01:00Z"
    check(rejects { try validateShowSlots(["month": "2099-10", "slots": [long]], board: base) }, "single slot over 24 hours refused")
    check(rejects { _ = try active.command(actor: actor, action: "schedule-status", body: cases[2].1, confirmation: "结束") }, "must close live phase before ending show")
    check(rejects { _ = try active.command(actor: actor, action: "phase-start", body: cases[7].1, confirmation: "开始") }, "cannot start another phase while one is active")
    check(rejects { _ = try base.command(actor: actor, action: "phase-start", body: cases[7].1, confirmation: "开始") }, "phase requires currently performing schedule")
    var stale = cases[1].1; stale["expected"] = String(repeating: "b", count: 64)
    check(rejects { _ = try base.command(actor: actor, action: "schedule-status", body: stale, confirmation: "开始") }, "stale original schedule fingerprint rejected")
    var replacement = revisions[2]; replacement["replacementExpected"] = String(repeating: "b", count: 64)
    check(rejects { _ = try base.command(actor: actor, action: "revision", body: replacement, confirmation: "换场") }, "replacement schedule fingerprint independently bound")
    var old = auth; old["deniedPermissions"] = ["song.manage"]
    check(rejects { _ = try base.command(actor: decode(StaffIdentity.self, old), action: "performer-create", body: cases[10].1, confirmation: "演员") }, "explicit permission denial wins")
    let disabled = try board(durable: false)
    check(rejects { _ = try disabled.command(actor: actor, action: "schedule-status", body: cases[1].1, confirmation: "开始") }, "disabled capability stays readonly")
    for text in ["A|歌1\na|歌2", "无编号\n无编号", "A|歌|别名|多余", "A|"] { check(rejects { _ = try parseShowSongs(text) }, "song import rejects duplicate or invalid row") }
    check(try parseShowSongs("A|歌1|别名甲,别名乙\n只有歌名").count == 2, "song import supports coded/uncoded rows and aliases")
    var emptyUpsert = cases[13].1; emptyUpsert["mode"] = "upsert"
    check(rejects { _ = try base.command(actor: actor, action: "songs-import", body: emptyUpsert, confirmation: "追加", catalog: catalog) }, "empty upsert refused, explicit empty replace supported")
    check(try showMoneyInput("10.01") == 1001 && showMoneyInput("90071992547409.91") == 9_007_199_254_740_991, "song quote exact integer cents and maximum safe amount")
    for amount in ["-1", "01", "1.001", "NaN", "1e2", "90071992547409.92"] { check(rejects { _ = try showMoneyInput(amount) }, "invalid/lossy quote rejected") }
    check(!accepted.rows[0].actions(actor).contains("performed") && paid.rows[0].actions(actor).contains("performed") && free.rows[0].actions(actor).contains("performed"), "paid and free songs can complete, unpaid positive quote cannot")
    check(!paid.rows[0].actions(actor).contains("cancel"), "paid song cannot masquerade cancellation as refund")
    check(rejects { _ = try accepted.command(actor: actor, row: accepted.rows[0], action: "paid", reason: "当面核对") }, "payment record requires retrieved original evidence")
    var wrongPayment: [String: Any] = ["paymentId": id(12), "reconciliationEntryId": id(13), "publicId": "PAY-ORIGINAL", "amountMinor": "1002", "currency": "CNY"]
    check(rejects { _ = try ShowPaymentEvidence(wrongPayment, request: accepted.rows[0], actor: actor) }, "payment evidence must exactly equal original quote")
    wrongPayment["amountMinor"] = "1001"; wrongPayment["currency"] = "USD"
    check(rejects { _ = try ShowPaymentEvidence(wrongPayment, request: accepted.rows[0], actor: actor) }, "payment evidence currency cannot drift")
    let paidCommand = commands.first { $0.steps[0].showProof?["kind"] as? String == "song" && $0.steps[0].showProof?["action"] as? String == "paid" }!
    var vault: [String: String] = [:]; let secured = try secureShowCommand(paidCommand) { vault[$0] = $1 }; let step = secured.steps[0]
    let payload = try showRequestPayload(secured, step: step, read: { vault[$0]! })
    for (key, value): (String, Any) in [("tableSessionId", id(90)), ("quotedAmountMinor", 999), ("currency", "USD"), ("status", "accepted")] {
      var wrong = try receipt(paidCommand); var data = wrong["data"] as! [String: Any]; var row = data["request"] as! [String: Any]; row[key] = value; data["request"] = row; wrong["data"] = data
      check(rejects { _ = try validateShowReceipt(showBytes(wrong), step: step, body: payload.body, expectation: payload.expectation) }, "payment receipt binds exact original \(key)")
    }
    for key in ["paymentId", "reconciliationEntryId", "reason", "previousStatus"] {
      var wrong = try receipt(paidCommand); var data = wrong["data"] as! [String: Any]; data[key] = "wrong"; wrong["data"] = data
      check(rejects { _ = try validateShowReceipt(showBytes(wrong), step: step, body: payload.body, expectation: payload.expectation) }, "payment receipt binds original \(key)")
    }
    check(rejects { _ = try secureShowCommand(paidCommand) { _, _ in throw URLError(.cannotWriteToFile) } }, "Keychain failure prevents sending without ordinary-file fallback")
    check(rejects { _ = try showRequestPayload(secured, step: step, read: { _ in "{}" }) }, "missing original secure payload cannot generate a fresh request")
    var alteredProof = step.showProof!; alteredProof["employeeId"] = id(90)
    let wrongActor = LiveCommand(id: secured.id, employeeID: secured.employeeID, title: secured.title, permission: secured.permission,
      steps: [.init(path: step.path, body: step.body, keyHeader: step.keyHeader, key: step.key, recoveryBody: try showBytes(["show": alteredProof]))])
    var privateReads = 0
    check(rejects { _ = try showRequestPayload(wrongActor, step: wrongActor.steps[0], read: { _ in privateReads += 1; return "{}" }) } && privateReads == 0, "actor mismatch rejected before private secure slot read")
    check(!StaffAPIError(status: 409, code: "NATIVE_REQUEST_CONFLICT", message: "未知").definitivelyRejected, "unknown command conflict keeps original intent")
    print("Show tests: \(checks) passed")
  }
}
