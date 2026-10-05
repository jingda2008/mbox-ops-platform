import Foundation
@main struct ContactGovernanceTests {
  @MainActor static func main() async throws {
    var count = 0, paths = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    func pub(_ prefix: String, _ n: Int = 1) -> String { prefix + String(format: "%032X", n) }
    let perms = ["privacy.contact.retention.view", "privacy.contact.retention.draft", "privacy.contact.retention.approve", "privacy.contact.retention.publish", "privacy.contact.legal_hold"]
    let auth: [String: Any] = ["session": ["id": "contact-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "独立保留管理员工", "roleCodes": ["MANAGER"]], "permissions": perms, "deniedPermissions": []]
    func actor(_ value: [String: Any]? = nil) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value ?? auth)) }
    let user = try actor(), version = String(repeating: "a", count: 64), reason = "原保留对象与处理依据已核实", basis = "原正式政策或争议依据编号"
    func policy(_ kind: String, status: String = "draft", drafter: String? = nil, approver: String? = nil) -> [String: Any] {
      ["publicId": pub("PCR"), "resourceKind": kind, "version": 2, "status": status, "retentionDaysAfterPurposeEnd": 30, "legalBasisReference": basis, "draftedByEmployeeId": drafter ?? id(2), "approvedByEmployeeId": approver ?? id(3), "publishedByEmployeeId": id(4), "draftReason": "原起草原因", "approvalReason": "原审批原因", "publicationReason": "原发布原因", "effectiveFrom": "2098-01-01T00:00:00Z", "effectiveUntil": NSNull(), "nativeVersion": version]
    }
    func resource(_ kind: String) -> [String: Any] { ["publicId": pub("ACV"), "resourceKind": kind, "maskedContact": "138****0000", "businessLabel": "原报名或联系方式版本", "status": "active", "nativeVersion": version] }
    func hold(_ kind: String) -> [String: Any] { ["publicId": pub("PCH"), "resourceKind": kind, "resourcePublicId": pub("ACV"), "maskedContact": "138****0000", "legalBasisReference": basis, "reason": "原保留原因", "status": "active", "createdByEmployeeId": id(2), "createdAt": "2026-10-05T00:00:00Z", "holdUntil": NSNull(), "nativeVersion": version] }
    func board(_ row: [String: Any], area: String = "policies", who: StaffIdentity? = nil, enabled: Any = true) throws -> ContactGovernanceBoard {
      try ContactGovernanceBoard(data: bytes(["data": ["employeeId": id(1), "protocol": 1, "durableCommands": enabled, "area": area, "rows": [row], "next": NSNull()]]), actor: who ?? user, area: area)
    }
    for (kind, _) in contactResourceKinds {
      for path in ["draft", "approve", "publish", "hold", "hold_until", "release"] {
        paths += 1
        let action = path == "hold_until" ? "hold" : path, area = action == "hold" ? "resources" : action == "release" ? "holds" : "policies"
        let raw = action == "hold" ? resource(kind) : action == "release" ? hold(kind) : policy(kind, status: action == "publish" ? "approved" : "draft")
        let b = try board(raw, area: area), row = b.rows[0]
        var input: [String: Any] = ["reason": reason]
        if ["draft", "hold"].contains(action) { input["resourceKind"] = kind; input["legalBasisReference"] = basis }
        if action == "draft" { input["retentionDaysAfterPurposeEnd"] = 30 }
        if action == "publish" { input["effectiveFrom"] = "2098-01-01T08:00:00+08:00" }
        if action == "hold" { input["holdUntil"] = path == "hold_until" ? "2098-01-01T08:00:00+08:00" : NSNull() }
        let c = try b.command(actor: user, action: action, body: input, row: action == "draft" ? nil : row), step = c.steps[0]
        check(validContactGovernanceSelection(command: c, board: b, actor: user), kind + " " + path + " original selection")
        let confirmation = step.contactGovernanceProof!["confirmation"] as! String
        check(confirmation.contains(basis) && confirmation.contains(reason), "full confirmed basis and reason")
        if ["draft", "approve", "publish"].contains(action) { check(confirmation.contains("30 天"), "retention duration in final confirmation") }
        else { check(confirmation.contains("138****0000") && !confirmation.contains("13812340000"), "masked contact only in final confirmation") }
        func response() -> [String: Any] {
          var record = raw; record["nativeVersion"] = String(repeating: "b", count: 64)
          if action == "draft" { record["publicId"] = pub("PCR", 2); record["version"] = 3; record["draftedByEmployeeId"] = id(1); record["draftReason"] = reason }
          if action == "approve" { record["status"] = "approved"; record["approvedByEmployeeId"] = id(1); record["approvalReason"] = reason }
          if action == "publish" { record["status"] = "published"; record["publishedByEmployeeId"] = id(1); record["publicationReason"] = reason; record["effectiveFrom"] = "2098-01-01 00:00:00+00" }
          if action == "hold" { record = hold(kind); record["publicId"] = pub("PCH", 2); record["reason"] = reason; record["createdByEmployeeId"] = id(1); record["holdUntil"] = path == "hold_until" ? "2098-01-01 00:00:00+00" : NSNull() }
          if action == "release" { record["status"] = "released"; record["releasedByEmployeeId"] = id(1); record["releaseReason"] = reason; record["releasedAt"] = "2026-10-05T10:00:00Z" }
          return ["data": ["employeeId": id(1), "requestKey": step.key, "action": action, "accepted": step.object, "row": record], "meta": ["protocol": 1, "replayed": false]]
        }
        try validateContactGovernanceReply(bytes(response()), step: step); check(true, "valid original receipt")
        for k in ["employeeId", "requestKey", "action"] { var r = response(), d = r["data"] as! [String: Any]; d[k] = "wrong"; r["data"] = d; check(bad { try validateContactGovernanceReply(bytes(r), step: step) }, "wrong reply " + k + " rejected") }
        var changed = response(), data = changed["data"] as! [String: Any], accepted = step.object; accepted["reason"] = "非原原因"; data["accepted"] = accepted; changed["data"] = data
        check(bad { try validateContactGovernanceReply(bytes(changed), step: step) }, "accepted body must exactly match original")
        let fields = ["publicId", "resourceKind", "status", "legalBasisReference", "nativeVersion"] + (area == "policies" ? ["retentionDaysAfterPurposeEnd", "draftedByEmployeeId", action == "approve" ? "approvalReason" : action == "publish" ? "publicationReason" : "draftReason"] : ["resourcePublicId", action == "hold" ? "createdByEmployeeId" : "releasedByEmployeeId", action == "hold" ? "reason" : "releaseReason", "holdUntil"])
        for k in fields { var r = response(), d = r["data"] as! [String: Any], record = d["row"] as! [String: Any]; record[k] = "wrong"; d["row"] = record; r["data"] = d; check(bad { try validateContactGovernanceReply(bytes(r), step: step) }, "wrong original receipt " + k + " rejected") }
        for p in ["privacy.contact.retention.view", contactPermission(action)] { var denied = auth; denied["deniedPermissions"] = [p]; check(bad { _ = try b.command(actor: actor(denied), action: action, body: input, row: action == "draft" ? nil : row) }, "current read or write denial rejects mutation") }
        if action != "draft" { var r = raw; r["nativeVersion"] = String(repeating: "c", count: 64); check(!validContactGovernanceSelection(command: c, board: try board(r, area: area), actor: user), "changed original version invalidates confirmation") }
        var pending = try JSONEncoder().encode(c), sends = 0, commits = 0
        let api = StaffAPI(transport: { request in
          if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
          guard request.url?.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key, request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let b = request.httpBody, membershipEqual(try JSONSerialization.jsonObject(with: b) as! [String: Any], step.object) else { throw StaffAPIError.invalid }
          sends += 1; if commits == 0 { commits += 1; throw URLError(.timedOut) }
          var r = response(); r["meta"] = ["protocol": 1, "replayed": true]; return (try bytes(r), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        _ = try await api.login(code: "staff", pin: "1234", switching: false)
        func send(_ s: LiveCommand.Step) async throws { try validateContactGovernanceReply(await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key]).0, step: s) }
        do { _ = try await LiveCommandRunner.advance(c, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("lost result abandoned") } catch {}
        let restored = try JSONDecoder().decode(LiveCommand.self, from: pending); check(restored == c, "lost response keeps original identity version basis and key")
        let done = try await LiveCommandRunner.advance(restored, send: send, checkpoint: { pending = try JSONEncoder().encode($0) }); check(commits == 1 && sends == 2 && done.completedSteps == 1, "actual API transport replays one effect")
        _ = try await LiveCommandRunner.advance(done, send: send, checkpoint: { _ in }); check(sends == 2, "readback failure cannot send completed mutation twice")
      }
    }
    let kind = "verified_membership_phone", b = try board(policy("verified_membership_phone"))
    for n in [-1, 36501] { check(bad { _ = try b.command(actor: user, action: "draft", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": basis, "retentionDaysAfterPurposeEnd": n]) }, "out of range retention days refused") }
    for n in [0, 36500] { check(try b.command(actor: user, action: "draft", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": String(repeating: "依", count: 240), "retentionDaysAfterPurposeEnd": n]).steps.count == 1, "zero/max days and existing 240-char basis allowed") }
    check(bad { _ = try b.command(actor: user, action: "draft", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": String(repeating: "依", count: 501), "retentionDaysAfterPurposeEnd": 30]) }, "501-char basis exceeds unified contract")
    for length in [241, 500] { check(try b.command(actor: user, action: "draft", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": String(repeating: "依", count: length), "retentionDaysAfterPurposeEnd": 30]).steps.count == 1, "unified 500-char basis contract accepts \(length)") }
    let own = try board(policy(kind, drafter: id(1))); check(own.actions(actor: user, row: own.rows[0]).isEmpty, "own draft approval unavailable")
    let ownApproval = try board(policy(kind, status: "approved", approver: id(1))); check(ownApproval.actions(actor: user, row: ownApproval.rows[0]).isEmpty, "publisher cannot be approver")
    let publish = try board(policy(kind, status: "approved")); check(bad { _ = try publish.command(actor: user, action: "publish", body: ["reason": reason, "effectiveFrom": "2020-01-01T00:00:00Z"], row: publish.rows[0]) }, "past policy effective time rejected")
    let r = try board(resource(kind), area: "resources"); check(bad { _ = try r.command(actor: user, action: "hold", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": basis, "holdUntil": "2020-01-01T00:00:00Z"], row: r.rows[0]) }, "hold expiry must be in future")
    for length in [241, 500] { check(try r.command(actor: user, action: "hold", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": String(repeating: "依", count: length), "holdUntil": NSNull()], row: r.rows[0]).steps.count == 1, "legal hold accepts unified basis length \(length)") }
    check(bad { _ = try r.command(actor: user, action: "hold", body: ["resourceKind": kind, "reason": reason, "legalBasisReference": String(repeating: "依", count: 501), "holdUntil": NSNull()], row: r.rows[0]) }, "legal hold refuses 501-character basis")
    check(bad { _ = try r.command(actor: user, action: "hold", body: ["resourceKind": "activity_registration_contact", "reason": reason, "legalBasisReference": basis, "holdUntil": NSNull()], row: r.rows[0]) }, "different resource kind refused")
    var released = hold(kind); released["status"] = "released"; released["releasedByEmployeeId"] = id(1); released["releasedAt"] = "2026-10-05T08:00:00Z"; released["releaseReason"] = reason
    let rb = try board(released, area: "holds"); check(rb.actions(actor: user, row: rb.rows[0]).isEmpty, "released hold cannot generate new release intent")
    var unmasked = resource(kind); unmasked["maskedContact"] = "13812340000"; check(bad { _ = try board(unmasked, area: "resources") }, "plaintext phone not displayed or persisted as protected row")
    var denied = auth; denied["deniedPermissions"] = ["privacy.contact.legal_hold"]; check(bad { _ = try board(resource(kind), area: "resources", who: actor(denied)) }, "resource picker requires legal hold permission")
    check(try board(policy(kind), who: actor(denied)).rows.count == 1, "policy read does not require legal hold write permission")
    check(bad { _ = try board(policy(kind), enabled: 1) }, "strict durable boolean")
    let path = try ContactGovernanceBoard.query(area: "resources", search: "A+B & 中文")
    check(path.contains("A%2BB"), "literal plus preserved in resource search")
    let read = URLComponents(string: "https://example.test" + path.replacingOccurrences(of: "+", with: " "))!.queryItems!.first { $0.name == "search" }!.value
    check(read == "A+B & 中文", "form query decoder preserves resource search")
    let disposed: [String: Any] = ["resourcePublicId": pub("ACV"), "resourceKind": kind, "maskedContact": "已清除", "policyPublicId": pub("PCR"), "policyVersion": 2, "dispositionMethod": "erase_ciphertext", "purposeEndedAt": "2026-09-01T00:00:00Z", "disposedAt": "2026-10-05T00:00:00Z", "nativeVersion": version]
    let db = try board(disposed, area: "dispositions"); check(db.rows.count == 1 && db.actions(actor: user, row: db.rows[0]).isEmpty, "disposition is readonly evidence, not a deletion control")
    print("Contact governance tests passed (\(count) assertions; \(paths) action-kind recovery paths)")
  }
}
