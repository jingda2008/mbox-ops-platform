import Foundation
import CryptoKit

@main struct BottleStorageTests {
  @MainActor static func main() async throws {
    var checks = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1; print("PASS " + label) }
    func rejects(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try JSONDecoder().decode(type, from: bottleBytes(value)) }
    let auth: [String: Any] = ["session": ["id": "bottle-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "custody", "displayName": "存酒员工", "roleCodes": ["OWNER"]], "permissions": bottleStoragePermissions, "deniedPermissions": []]
    let actor = try decode(StaffIdentity.self, auth)
    let rawPolicy: [String: Any] = ["allowRestorage": true, "requireOriginalOrder": false, "archiveMode": "automatic", "extraFieldDefinitions": [["key": "seal", "label": "封口编号", "type": "text", "required": true]], "serviceAccountId": NSNull(),
      "enabled": true, "defaultDays": 20, "remindersEnabled": false, "reminderDays": [7, 3, 1], "sendMinute": 990, "codeDigits": 4,
      "codeTtlSeconds": 300, "resendSeconds": 60, "maximumAttempts": 5, "allowPartial": true,
      "numberPattern": "{date}-{time}-{member}-{serial}", "printFields": ["category", "item", "quantity", "remaining", "expiry", "location", "status", "source"], "printFooter": "取酒须核验本人", "reportDimensions": ["category", "status", "date"], "printTitle": "M-BOX存酒凭证", "reminderText": "您的存酒于{expiry}到期"]
    let category: [String: Any] = ["id": id(2), "name": "威士忌", "code": "whisky", "default_days": 20, "active": true, "sort_order": 1, "configurationFingerprint": String(repeating: "a", count: 64)]
    func board(user: StaffIdentity? = nil, changes: [String: Any] = [:], enabled: Any = true) throws -> BottleStorageBoard {
      var policy = rawPolicy; policy.merge(changes) { _, next in next }
      return try BottleStorageBoard(policy: bottleBytes(["data": ["policy": policy, "version": 2, "categories": [category], "accounts": []]]),
        capability: bottleBytes(["data": ["employeeId": (user ?? actor).employee.id, "durableCommands": enabled]]), actor: user ?? actor)
    }
    let current = try board()
    let order: [String: Any] = ["id": id(3), "public_id": "CUSTODY-MEMBER-000123", "member_no": "000123", "category_id": id(2), "category_name": "威士忌", "item_name": "真实余酒", "unit": "瓶", "remaining_quantity": "0.5", "original_quantity": "1", "status": "stored", "version": 7, "expires_at": "2099-01-01T00:00:00Z", "location": "A1", "note": "会员私密备注"]
    let challenge: [String: Any] = ["id": id(4), "quantity": "0.25", "delivery_status": "accepted", "expires_at": "2099-01-01T00:00:00Z", "verified_at": "2026-10-05T12:00:00Z", "consumed_at": NSNull(), "invalidated_at": NSNull(), "attempts": 1, "maximum_attempts": 5]
    let collection: [String: Any] = ["id": id(5), "quantity": "0.5", "returned_quantity": "0", "status": "collected", "restored_order_id": NSNull(), "collected_at": "2026-10-05T12:00:00Z"]
    func detail(order changes: [String: Any] = [:], challenges: [[String: Any]]? = nil, collections: [[String: Any]]? = nil) throws -> BottleStorageDetail {
      var value = order; value.merge(changes) { _, next in next }
      return try BottleStorageDetail(["order": value, "collections": collections ?? [collection], "challenges": challenges ?? [challenge], "deposits": [], "events": [], "reminders": []])
    }
    let original = try detail(), archivable = try detail(order: ["remaining_quantity": "0", "status": "collected"], collections: [])
    // A real canonical PNG. Server additionally validates dimensions/decoding and adds its watermark.
    let photo = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
    let evidence: [String: Any] = ["photoBase64": photo + "", "phone": "+8613812345678", "fraction": "1/2"]
    // Use a larger JPEG-like client fixture; actual camera image decoding is covered by the iOS build/device gate.
    let photoBytes = Data([0xff, 0xd8, 0xff] + Array(repeating: UInt8(42), count: 160))
    var validEvidence = evidence; validEvidence["photoBase64"] = photoBytes.base64EncodedString()
    let create: [String: Any] = ["evidence": validEvidence, "memberNo": "000123", "categoryId": id(2), "itemName": "真实余酒", "unit": "瓶", "quantity": "0.5", "location": "A1", "note": "会员私密备注", "days": 20, "declaredValueMinor": 10001, "sourceOrderId": NSNull(), "sourceReference": NSNull(), "extraFields": ["seal": "专属封签"]]
    let categoryBody: [String: Any] = ["id": id(2), "code": "whisky", "name": "威士忌更新", "defaultDays": 30, "active": false, "sortOrder": 5]
    let cases: [(String, [String: Any], BottleStorageDetail?)] = [
      ("create", create, nil), ("request_code", ["quantity": "0.25"], original), ("verify", ["challengeId": id(4), "code": "0123"], original),
      ("collect", ["challengeId": id(4)], original), ("resolve_collection", ["collectionId": id(5), "quantity": "0.5", "restorageMode": "original", "evidence": validEvidence, "reason": "当面核对再次寄存"], original),
      ("resolve_collection", ["collectionId": id(5), "quantity": NSNull(), "restorageMode": "original", "reason": "本次已经饮用完毕"], original),
      ("resolve_collection", ["collectionId": id(5), "quantity": "0.5", "restorageMode": "new", "evidence": validEvidence, "reason": "当面核对新单寄存"], original),
      ("archive", ["reason": "全部处理完成"], archivable), ("expiry", ["reason": "会员确认延期", "expiresAt": "2099-02-01T00:00:00Z"], original),
      ("category", categoryBody, nil), ("policy", ["policy": current.policy.object, "version": 2, "reason": "门店确认规则"], nil),
      ("print_prepared", [:], original), ("export", ["memberNo": "000123", "status": "stored"], nil),
      ("report_export", ["scope": "all", "memberNo": "000123"], nil)]
    func command(_ op: String, _ body: [String: Any], _ detail: BottleStorageDetail? = nil, source: BottleStorageBoard? = nil, user: StaffIdentity? = nil) throws -> LiveCommand {
      try (source ?? current).command(actor: user ?? actor, operation: op, body: body, detail: detail, category: op == "category" && body["id"] != nil ? current.categories[0] : nil,
        confirmation: "会员000123；私密手机号13812345678；原内容核对")
    }
    func receipt(_ command: LiveCommand, replayed: Bool = false) throws -> [String: Any] {
      let step = command.steps[0], proof = step.bottleStorageProof!, op = proof["operation"] as! String, body = step.object
      var result: [String: Any]
      switch op {
      case "create": result = try detail(order: ["original_quantity": "0.5", "remaining_quantity": "0.5", "version": 1]).object
      case "collect": result = try detail(order: ["remaining_quantity": "0.25", "version": 8]).object
      case "resolve_collection":
        var resolved = collection; resolved["status"] = body["quantity"] is NSNull ? "archived" : "restored"
        resolved["returned_quantity"] = body["quantity"] is NSNull ? "0" : "0.5"
        result = try detail(order: ["version": 8], collections: [resolved]).object; result["restoredOrderId"] = body["quantity"] is NSNull ? NSNull() : body["restorageMode"] as? String == "new" ? id(9) : id(3)
      case "archive": result = try detail(order: ["remaining_quantity": "0", "status": "archived", "version": 8], collections: []).object
      case "expiry": result = try detail(order: ["version": 8, "expires_at": body["expiresAt"]!]).object
      case "request_code": result = ["challengeId": id(4), "deliveryStatus": "pending"]
      case "verify": result = ["verified": false, "message": "验证码不正确，请重新核对"]
      case "category": result = ["id": id(2)]
      case "policy": result = ["policy": body["policy"]!, "version": 3]
      case "print_prepared": result = ["publicId": order["public_id"]!, "html": "untrusted HTML not executed", "document": ["order": order, "policy": rawPolicy]]
      default: result = ["filename": op == "export" ? "MBOX-存酒明细.xlsx" : "MBOX-可选范围报表.xlsx", "base64": Data([0x50, 0x4b, 3, 4]).base64EncodedString(), "count": 1, "amountStatus": "declared_value_not_revenue"]
      }
      return ["data": ["operation": op, "employeeId": actor.employee.id, "requestKey": step.key, "result": result], "meta": ["protocol": 1, "replayed": replayed]]
    }
    for (op, body, target) in cases {
      let plain = try command(op, body, target)
      var vault: [String: String] = [:]
      let secured = try secureBottleStorageCommand(plain) { vault[$0] = $1 }
      let step = secured.steps[0], disk = try JSONEncoder().encode(secured)
      let text = String(decoding: disk, as: UTF8.self)
      check(!text.contains("000123") && !text.contains("13812345678") && !text.contains("0123") && !text.contains(photoBytes.base64EncodedString()) && !text.contains("私密") && step.object.isEmpty,
        "\(op) ordinary pending contains no phone/member/PIN/photo/confirmation")
      check(step.bottleStorageProof?["payloadSHA256"] == nil && step.bottleStorageProof?["payloadAuthentication"] is String,
        "\(op) pending exposes keyed authentication only")
      let restarted = try JSONDecoder().decode(LiveCommand.self, from: disk)
      let restored = try bottleStorageRequestBody(restarted, step: restarted.steps[0], read: { vault[$0]! })
      check(NSDictionary(dictionary: restored).isEqual(to: body), "\(op) exact request survives restart in secure slot")
      let accepted = try validateBottleStorageReceipt(bottleBytes(receipt(plain)), step: step, body: restored)
      let savedReceipt = try JSONEncoder().encode(accepted)
      check(try JSONDecoder().decode(BottleStorageReceipt.self, from: savedReceipt) == accepted, "\(op) exact receipt can persist in actor-bound Keychain")
      if op == "verify" { check(accepted.message.contains("不正确"), "wrong-code result commits attempt and never means validated") }
      for key in ["employeeId", "requestKey", "operation"] {
        var value = try receipt(plain); var data = value["data"] as! [String: Any]; data[key] = "wrong"; value["data"] = data
        check(rejects { _ = try validateBottleStorageReceipt(bottleBytes(value), step: step, body: restored) }, "\(op) rejects mismatched receipt \(key)")
      }
      var sends = 0, commits = 0, pending = disk, storedReceipt: Data?
      let headers = try bottleStorageHeaders(step)
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bottleBytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.httpMethod == "POST", request.url?.path == step.path,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == actor.employee.id,
          headers.allSatisfy({ request.value(forHTTPHeaderField: $0.key) == $0.value }), let sent = request.httpBody,
          NSDictionary(dictionary: try bottleObject(sent)).isEqual(to: body) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1; throw URLError(.timedOut) }
        return (try bottleBytes(receipt(plain, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "custody", pin: "1234", switching: false)
      func send(_ original: LiveCommand, _ step: LiveCommand.Step) async throws {
        let body = try bottleStorageRequestBody(original, step: step, read: { vault[$0]! })
        let bytes = try await api.raw(step.path, body: body, headers: bottleStorageHeaders(step)).0
        let receipt = try validateBottleStorageReceipt(bytes, step: step, body: body)
        storedReceipt = try JSONEncoder().encode(receipt) // production saves this to Keychain before checkpoint
      }
      do { _ = try await LiveCommandRunner.advance(secured, send: { try await send(secured, $0) }, checkpoint: { pending = try JSONEncoder().encode($0) }); preconditionFailure("lost receipt must fail") } catch {}
      check(pending == disk && storedReceipt == nil, "\(op) unknown network outcome retains original intent")
      let resumed = try JSONDecoder().decode(LiveCommand.self, from: pending)
      let complete = try await LiveCommandRunner.advance(resumed, send: { try await send(resumed, $0) }, checkpoint: { pending = try JSONEncoder().encode($0) })
      check(sends == 2 && commits == 1 && complete.completedSteps == 1 && storedReceipt != nil, "\(op) actual StaffAPI transport retries original key with one simulated business effect")
      _ = try await LiveCommandRunner.advance(complete, send: { try await send(complete, $0) }, checkpoint: { _ in })
      check(sends == 2, "\(op) completed checkpoint does not repeat operation after read failure")
    }
    check(try bottleQuantity("999999999999.999999") == 999999999999999999 && bottleQuantity("0.000001") == 1, "quantity uses exact millionths at upper/lower limits")
    for quantity in ["0", "-1", "01", "1.0000001", "1e2", "NaN", "1000000000000"] { check(rejects { _ = try bottleQuantity(quantity) }, "reject invalid quantity \(quantity)") }
    check(try bottlePhone("138 1234 5678") == "+8613812345678", "normalize Chinese contact without storing raw contact in ordinary metadata")
    for value: Any in [true, 1.5, -1, "1"] { check(rejects { _ = try bottleInteger(value) }, "strict JSON integers reject boolean/fraction/string") }
    var alteredAuth = auth; alteredAuth["deniedPermissions"] = ["bottle.manage.all"]
    check(rejects { _ = try board(user: decode(StaffIdentity.self, alteredAuth)) }, "explicit base-permission denial prevents custody access")
    let disabled = try board(enabled: false)
    check(rejects { _ = try command("create", create, source: disabled) }, "old server capability is read-only")
    let closed = try board(changes: ["enabled": false])
    check(rejects { _ = try command("create", create, source: closed) }, "new storage disabled prevents create")
    _ = try command("collect", ["challengeId": id(4)], original, source: closed); check(true, "existing collection remains usable when new storage disabled")
    var sessionAuth = auth; var session = sessionAuth["session"] as! [String: Any]; session["id"] = "other-session"; sessionAuth["session"] = session
    check(rejects { _ = try command("collect", ["challengeId": id(4)], original, user: decode(StaffIdentity.self, sessionAuth)) }, "cached board cannot cross current employee session")
    var last = challenge; last["attempts"] = 5
    _ = try command("collect", ["challengeId": id(4)], detail(challenges: [last])); check(true, "successful final allowed verification attempt still permits physical handover")
    check(rejects { _ = try command("verify", ["challengeId": id(4), "code": "0123"], detail(challenges: [last])) }, "used-up attempt limit prevents another verification")
    for field in ["consumed_at", "invalidated_at"] {
      var value = challenge; value[field] = "2026-10-05T12:00:00Z"
      check(rejects { _ = try command("collect", ["challengeId": id(4)], detail(challenges: [value])) }, "handover rejects challenge \(field)")
    }
    var unverified = challenge; unverified["verified_at"] = NSNull()
    check(rejects { _ = try command("collect", ["challengeId": id(4)], detail(challenges: [unverified])) }, "physical handover requires durable verified_at, not only code entry")
    for status in ["pending", "failed"] {
      var value = challenge; value["delivery_status"] = status
      check(rejects { _ = try command("verify", ["challengeId": id(4), "code": "0123"], detail(challenges: [value])) }, "\(status) send state cannot authorize verification")
    }
    check(rejects { _ = try command("request_code", ["quantity": "0.6"], original) }, "cannot request more than remaining")
    let wholeOnly = try board(changes: ["allowPartial": false])
    check(rejects { _ = try command("request_code", ["quantity": "0.25"], original, source: wholeOnly) }, "whole-only policy applies to collection")
    var restore = cases[4].1; restore["quantity"] = "0.6"
    check(rejects { _ = try command("resolve_collection", restore, original) }, "restorage cannot exceed original collection")
    restore = cases[6].1
    check(rejects { _ = try command("resolve_collection", restore, original, source: board(changes: ["requireOriginalOrder": true])) }, "original-order policy refuses new restorage order")
    check(rejects { _ = try command("resolve_collection", cases[4].1, detail(order: ["expires_at": "2000-01-01T00:00:00Z"])) }, "expired original requires expiry adjustment before restorage")
    check(rejects { _ = try command("resolve_collection", cases[4].1, original, source: board(changes: ["allowRestorage": false])) }, "restorage disabled remains fail-closed")
    _ = try command("resolve_collection", cases[5].1, original, source: board(changes: ["allowRestorage": false])); check(true, "used-up resolution remains possible with restorage disabled")
    check(rejects { _ = try command("archive", ["reason": "当面核对"], original) }, "remaining custody or unresolved collection prevents archive")
    for modification: [String: Any] in [["evidence": NSNull()], ["extraFields": [:]], ["extraFields": ["unknown": "x"]], ["expiresAt": "2099-01-01T00:00:00Z"], ["categoryId": id(100)]] {
      var value = create; value.merge(modification) { _, next in next }
      check(rejects { _ = try command("create", value) }, "create validates evidence/required fields/exclusive dates/category")
    }
    var badEvidence = validEvidence; badEvidence["fraction"] = "1/4"
    check(rejects { try validateBottleStorageEvidence(badEvidence, unit: "瓶", quantity: "0.5") }, "fraction must equal exact quantity")
    check(rejects { try validateBottleStorageEvidence(validEvidence, unit: "杯", quantity: "0.5") }, "fraction only applies to bottles")
    var reminder = current.policy; reminder.remindersEnabled = true
    check(rejects { try reminder.validate() }, "reminders require configured service account")
    reminder = current.policy; reminder.reminderDays = [1, 1]
    check(rejects { try reminder.validate() }, "duplicate reminder days rejected")
    check(rejects { _ = try bottleStorageQuery(["cursor": id(2)], page: false) }, "export never reuses list cursor")
    check(rejects { _ = try bottleStorageQuery(["scope": "all", "offset": 100], report: true, page: false) }, "report export never accidentally exports only paginated offset")
    check(rejects { _ = try bottleStorageQuery(["from": "2026-10-02T00:00:00+08:00", "to": "2026-10-01T00:00:00+08:00"]) }, "inverted report dates rejected")
    let plain = try command("verify", cases[2].1, original)
    var vault: [String: String] = [:]
    let secure = try secureBottleStorageCommand(plain) { vault[$0] = $1 }
    var secondVault: [String: String] = [:]
    let another = try secureBottleStorageCommand(plain) { secondVault[$0] = $1 }
    check(secure.steps[0].bottleStorageProof?["payloadAuthentication"] as? String != another.steps[0].bottleStorageProof?["payloadAuthentication"] as? String,
      "same low-entropy PIN gets distinct keyed authentication, preventing public offline guesses")
    check(rejects { _ = try bottleStorageRequestBody(secure, step: secure.steps[0], read: { secondVault[$0]! }) }, "another secure envelope does not match original authenticated slot")
    check(rejects { _ = try secureBottleStorageCommand(plain) { _, _ in throw URLError(.cannotWriteToFile) } }, "secure storage failure prevents submission without plaintext fallback")
    check(rejects { _ = try bottleStorageRequestBody(secure, step: secure.steps[0], read: { _ in throw URLError(.cannotOpenFile) }) }, "locked/missing Keychain keeps original request unresolved")
    func changed(_ change: [String: Any], actor: String? = nil, path: String? = nil) throws -> LiveCommand {
      let old = secure.steps[0]; var proof = old.bottleStorageProof!; proof.merge(change) { _, next in next }
      return LiveCommand(id: secure.id, employeeID: actor ?? secure.employeeID, title: secure.title, permission: secure.permission,
        steps: [.init(path: path ?? old.path, body: old.body, keyHeader: old.keyHeader, key: old.key, recoveryBody: try bottleBytes(["bottleStorage": proof]))])
    }
    for bad in try [changed(["employeeId": id(9)]), changed([:], actor: id(9)), changed(["payloadKey": "other-slot"]), changed([:], path: "/api/refunds/x/execute"), changed(["confirmation": "leak"])] {
      var reads = 0
      check(rejects { _ = try bottleStorageRequestBody(bad, step: bad.steps[0], read: { _ in reads += 1; return "{}" }) } && reads == 0, "tampered actor/path/slot/plaintext refused before private read")
    }
    let wrongVersion = try changed(["version": 8])
    check(rejects { _ = try bottleStorageRequestBody(wrongVersion, step: wrongVersion.steps[0], read: { vault[$0]! }) }, "original version cannot be replaced even with valid secure payload")
    check(!StaffAPIError(status: 409, code: "CUSTODY_COMMAND_CONFLICT", message: "原请求未明").definitivelyRejected, "ambiguous custody conflict retains original key")
    check(StaffAPIError(status: 409, code: "NATIVE_BUSINESS_NOT_COMMITTED", message: "未提交", commitDisposition: "not_committed").definitivelyRejected,
      "explicit rolled-back native result can be acknowledged then refreshed")
    check(bottleStoredDate("2099-01-01 00:00:00+00") == StaffIdentity.date("2099-01-01T00:00:00Z"), "PostgreSQL text timestamp hour offset parses without device timezone")
    check(bottleStoredDate("2099-01-01 08:00:00.123456+08") == StaffIdentity.date("2099-01-01T00:00:00.123456Z"), "PostgreSQL microseconds and non-UTC hour offset parse")
    var pg = challenge; pg["expires_at"] = "2099-01-01 00:00:00+00"; pg["verified_at"] = "2026-10-05 12:00:00.123456+00"
    _ = try command("collect", ["challengeId": id(4)], detail(order: ["expires_at": "2099-01-01 00:00:00+00"], challenges: [pg]))
    check(true, "actual custody SQL text timestamp permits valid verified handover")
    check(bottleDisplayTime("2026-10-05 04:00:00+00") == "2026-10-05 12:00", "custody timestamp displayed in store timezone")
    print("Bottle storage tests: \(checks) passed")
  }
}
