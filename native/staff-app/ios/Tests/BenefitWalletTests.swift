import Foundation

@main struct BenefitWalletTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func bad(_ work: () throws -> Void) -> Bool { do { try work(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "wallet-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "staff", "displayName": "当班员工", "roleCodes": ["SERVER"]], "permissions": walletPermissions, "deniedPermissions": []]
    func actor(_ value: [String: Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value)) }
    let user = try actor()
    let product: [String: Any] = ["id": id(6), "name": "柠檬气泡水", "status": "active"]
    let hold: [String: Any] = ["id": id(5), "benefitId": id(3), "tableSessionId": id(4), "tableCode": "A01", "quantity": 1, "status": "reserved", "expiresAt": "2099-01-01T00:00:00Z", "canRedeem": true]
    let item: [String: Any] = ["id": id(3), "title": "原会员赠品", "type": "gift_product", "state": "available", "status": "reserved", "snackClaim": false,
      "quantityTotal": 3, "quantityReserved": 1, "quantityRedeemed": 0, "quantityAvailable": 2,
      "validFrom": "2026-01-01T00:00:00Z", "validUntil": NSNull(), "version": 4, "valueAmountMinor": NSNull(), "calendar": NSNull(), "pricePromise": NSNull(), "products": [product], "reservations": [hold]]
    let source: [String: Any] = ["protocol": 1, "employeeId": id(1), "durableCommands": true, "customerId": id(2), "memberNo": "MEMBER_001", "displayName": "已核对会员", "items": [item],
      "tables": [["id": id(4), "code": "A01"]], "limits": [["id": id(7), "currency": "CNY", "amountMinor": "10000", "name": "当班赠送额度"]], "nextCursor": "2026-10-01T00:00:00Z|" + id(3)]
    func board(_ data: [String: Any] = source, as user: StaffIdentity? = nil) throws -> BenefitWalletBoard { try BenefitWalletBoard(data: bytes(["data": data]), actor: user ?? actor()) }
    let current = try board(), selected = try [WalletRecord(product)]
    let issue: [String: Any] = ["customerId": id(2), "title": "到店赠饮", "benefitCode": "GIFT_001", "benefitType": "gift_product", "valueAmountMinor": 2500,
      "quantity": 2, "authorizationLimitId": id(7), "allowedProductIds": [id(6)], "validFrom": "2026-10-05T00:00:00Z", "validUntil": NSNull(), "reason": "按岗位额度赠送"]
    let reserve: [String: Any] = ["customerId": id(2), "benefitId": id(3), "tableSessionId": id(4), "quantity": 1, "expectedVersion": 4]
    let redeem: [String: Any] = ["customerId": id(2), "benefitId": id(3), "tableSessionId": id(4), "reservationId": id(5), "quantity": 1, "selectedProductId": id(6)]
    let cancel: [String: Any] = ["customerId": id(2), "benefitId": id(3), "tableSessionId": id(4), "reservationId": id(5), "quantity": 1, "reason": "会员取消未核销暂留"]
    let actions = [("issue", issue), ("reserve", reserve), ("redeem", redeem), ("cancel", cancel)]
    func command(_ action: String, _ body: [String: Any], from: BenefitWalletBoard? = nil, as user: StaffIdentity? = nil) throws -> LiveCommand {
      try (from ?? current).command(actor: user ?? actor(), action: action, body: body, selectedProducts: action == "issue" ? selected : [])
    }
    check(current.rows.count == 1 && current.nextCursor != nil && current.rows[0].object["valueAmountMinor"] is NSNull,
      "legacy gift without money and opaque history cursor remain readable")
    for value: Any in [true, 1.5, -1, "9007199254740992", "1e2"] { check(bad { _ = try walletInteger(value) }, "wallet refuses unsafe integer") }
    for value in ["-1", "1e2", "1.001", "1000000.01", "01", ""] { check(bad { _ = try walletMoney(value) }, "issue refuses invalid or excessive money \(value)") }
    check(try walletMoney("1000000.00") == 100000000 && walletMoney("0.01") == 1, "issue money uses exact integer cents")
    check(try walletDateInput("2026-10-05 20:30") == "2026-10-05T12:30:00Z", "form time interpreted as Shanghai independent of device timezone")
    for value in ["2026-02-30 20:30", "2026-10-05 25:00", "2026-1-5 01:01"] { check(bad { _ = try walletDateInput(value) }, "issue refuses invalid local date") }
    var hidden = source; hidden["employeeId"] = id(9)
    check(bad { _ = try board(hidden) }, "wallet board from another actor refused")
    for field in ["protocol", "durableCommands"] { var changed = source; changed[field] = field == "protocol" ? 2 : 1; check(bad { _ = try board(changed) }, "wallet rejects malformed capability \(field)") }
    var duplicate = source; duplicate["items"] = [item, item]
    check(bad { _ = try board(duplicate) }, "wallet duplicate records refused")
    var changedItem = item; changedItem["quantityAvailable"] = 10; var malformed = source; malformed["items"] = [changedItem]
    check(bad { _ = try board(malformed) }, "wallet counters cannot exceed original total")
    var revoked = auth; revoked["deniedPermissions"] = ["loyalty.account.view"]
    check(bad { _ = try board(as: actor(revoked)) }, "revoked account visibility hides wallet")
    var old = source; old["durableCommands"] = false
    check(bad { _ = try command("reserve", reserve, from: board(old)) }, "old wallet without durable commands remains readonly")
    var expired = auth; var session = expired["session"] as! [String: Any]; session["onlineLeaseUntil"] = "2000-01-01T00:00:00Z"; expired["session"] = session
    check(bad { _ = try command("reserve", reserve, as: actor(expired)) }, "expired employee lease cannot create a new claim")
    func receipt(_ action: String, _ command: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let b = command.steps[0].object
      var result: [String: Any] = ["id": action == "cancel" ? id(5) : id(30), "customerId": id(2)]
      if action == "issue" {
        for key in ["benefitCode", "benefitType", "valueAmountMinor", "validFrom", "validUntil", "authorizationLimitId"] { result[key] = b[key] }
        result["quantityTotal"] = b["quantity"]; result["currency"] = "CNY"; result["issuedByEmployeeId"] = id(1)
      } else {
        for key in ["benefitId", "tableSessionId", "quantity"] { result[key] = b[key] }
        if action == "redeem" { result["benefitReservationId"] = b["reservationId"]; result["authorizationSource"] = ["kind": "employee", "employeeId": id(1)]; result["redeemedAt"] = "2026-10-05 12:00:00+00" }
        else { result["status"] = action == "cancel" ? "cancelled" : "reserved"; if action == "cancel" { result["cancelReason"] = b["reason"] } }
      }
      return ["meta": ["protocol": 1, "replayed": replayed], "data": ["action": action, "employeeId": id(1), "requestKey": command.steps[0].key, "customerId": id(2), "result": result]]
    }
    for (action, body) in actions {
      let work = try command(action, body), step = work.steps[0]
      check(work.employeeID == id(1) && step.key == "native-business-" + work.id && step.path == benefitWalletRoot + "/commands/" + action,
        "\(action) freezes original actor path and request key")
      let persisted = try JSONEncoder().encode(work), restored = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      check(restored == work, "\(action) original payload survives relaunch")
      var denied = auth; denied["deniedPermissions"] = [try walletPermission(action)]
      check(bad { _ = try command(action, body, as: actor(denied)) }, "\(action) current explicit permission denial wins")
      var wrong = body; wrong["customerId"] = id(9)
      check(bad { _ = try command(action, wrong) }, "\(action) another member cannot consume loaded wallet")
      wrong = body; wrong["quantity"] = true
      check(bad { _ = try command(action, wrong) }, "\(action) boolean cannot become one benefit")
      wrong = body; wrong["unknown"] = "extra"
      check(bad { _ = try command(action, wrong) }, "\(action) unknown request fields refused")
      try validateBenefitWalletReply(bytes(receipt(action, work)), step: step)
      check(true, "\(action) exact server-shaped receipt accepted")
      for key in ["action", "employeeId", "requestKey", "customerId"] {
        var reply = receipt(action, work); var d = reply["data"] as! [String: Any]; d[key] = "wrong"; reply["data"] = d
        check(bad { try validateBenefitWalletReply(bytes(reply), step: step) }, "\(action) rejects mismatched \(key)")
      }
      var reply = receipt(action, work); reply["meta"] = ["protocol": 1, "replayed": 1]
      check(bad { try validateBenefitWalletReply(bytes(reply), step: step) }, "\(action) integer replay flag refused")
      let resultFields = action == "issue" ? ["benefitCode", "quantityTotal", "benefitType", "currency", "valueAmountMinor", "issuedByEmployeeId", "authorizationLimitId", "validFrom", "validUntil"] : ["benefitId", "tableSessionId", "quantity", action == "redeem" ? "benefitReservationId" : "status"]
      for key in resultFields {
        var reply = receipt(action, work); var d = reply["data"] as! [String: Any]; var result = d["result"] as! [String: Any]
        result[key] = key == "quantity" || key == "quantityTotal" || key == "valueAmountMinor" ? 999 : "2090-01-01T00:00:00Z"
        d["result"] = result; reply["data"] = d
        check(bad { try validateBenefitWalletReply(bytes(reply), step: step) }, "\(action) rejects wrong original result \(key)")
      }
      var sends = 0, committed = 0, saved = persisted
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        sends += 1
        guard request.httpMethod == "POST", request.url?.path == step.path, request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == id(1), let sent = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: sent) as! [String: Any]).isEqual(to: body) else { throw StaffAPIError.invalid }
        if committed == 0 { committed += 1; throw URLError(.timedOut) }
        return (try bytes(receipt(action, work, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "staff", pin: "1234", switching: false)
      func send(_ step: LiveCommand.Step) async throws {
        try validateBenefitWalletReply(await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key]).0, step: step)
      }
      do { _ = try await LiveCommandRunner.advance(work, send: send, checkpoint: { saved = try JSONEncoder().encode($0) }); preconditionFailure("unknown result discarded") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self, from: saved) == work, "\(action) lost success reply retains original command")
      let pending = try JSONDecoder().decode(LiveCommand.self, from: saved)
      let complete = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { saved = try JSONEncoder().encode($0) })
      check(complete.completedSteps == 1 && sends == 2 && committed == 1, "\(action) StaffAPI adapter restores same request receipt without second effect")
      _ = try await LiveCommandRunner.advance(complete, send: send, checkpoint: { _ in })
      check(sends == 2, "\(action) failed list refresh cannot resubmit acknowledged mutation")
    }
    for field in ["expectedVersion", "tableSessionId", "benefitId", "quantity"] {
      var input = reserve; input[field] = (field == "expectedVersion" || field == "quantity") ? 3 as Any : id(9) as Any
      check(bad { _ = try command("reserve", input) }, "reserve refuses stale version or wrong table benefit quantity \(field)")
    }
    for field in ["reservationId", "tableSessionId", "quantity", "selectedProductId"] {
      var input = redeem; input[field] = field == "quantity" ? 2 : id(9)
      check(bad { _ = try command("redeem", input) }, "redeem requires original hold and allowed product \(field)")
    }
    for field in ["pricePromise", "snackClaim"] {
      var special = item; special[field] = field == "pricePromise" ? ["fixedPriceMinor": 100] : true
      var source = source; source["items"] = [special]; let specialBoard = try board(source)
      check(bad { _ = try command("reserve", reserve, from: specialBoard) } && bad { _ = try command("redeem", redeem, from: specialBoard) },
        "\(field) remains on dedicated use flow")
      check(try command("cancel", cancel, from: specialBoard).steps.count == 1, "\(field) unused hold may still be cancelled")
    }
    var staleHold = hold; staleHold["expiresAt"] = "2000-01-01T00:00:00Z"; staleHold["canRedeem"] = false
    var staleItem = item; staleItem["reservations"] = [staleHold]; var staleSource = source; staleSource["items"] = [staleItem]
    check(try bad { _ = try command("redeem", redeem, from: board(staleSource)) } && command("cancel", cancel, from: board(staleSource)).steps.count == 1,
      "expired hold allows release but cannot redeem")
    for (action, input) in actions {
      let work = try command(action, input); var reply = receipt(action, work)
      var d = reply["data"] as! [String: Any]; var result = d["result"] as! [String: Any]; result["customerId"] = id(40); d["result"] = result; reply["data"] = d
      try validateBenefitWalletReply(bytes(reply), step: work.steps[0])
      check(true, "\(action) accepts family canonicalization while durable envelope binds original member")
    }
    var costly = issue; costly["valueAmountMinor"] = 6000
    check(bad { _ = try command("issue", costly) }, "issue total value respects selected current role limit")
    costly = issue; costly["authorizationLimitId"] = id(9)
    check(bad { _ = try command("issue", costly) }, "issue cannot use unlisted role allowance")
    costly = issue; costly["validUntil"] = costly["validFrom"]
    check(bad { _ = try command("issue", costly) }, "issue validity must be a positive interval")
    check(bad { _ = try current.command(actor: user, action: "issue", body: issue) }, "issue must confirm names for original selected products")
    let confirmation = try command("issue", issue).steps[0].benefitWalletProof!["confirmation"] as! String
    for label in ["MEMBER_001", "柠檬气泡水", "25.00", "50.00", "当班赠送额度", "2份", "到期"] { check(confirmation.contains(label), "issuance confirmation includes \(label)") }
    let products = try BenefitWalletProducts(data: bytes(["data": ["employeeId": id(1), "items": [product], "nextOffset": 50]]), actor: user)
    check(products.rows.count == 1 && products.nextOffset == 50, "product lookup binds staff with pagination")
    let query = try BenefitWalletProducts.query(search: "柠檬+&offset=99", offset: 0)
    check(query.contains("%26") && query.hasSuffix("offset=0"), "product search is encoded and cannot replace offset")
    let decodedSearch = query.dropFirst().split(separator: "&")[0].dropFirst("search=".count)
      .replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    check(decodedSearch == "柠檬+&offset=99", "form-style server decoding preserves literal plus in product search")
    check(bad { _ = try BenefitWalletProducts.query(search: "", offset: -1) }, "negative product page refused")
    print("Benefit wallet tests: \(count) passed")
  }
}
