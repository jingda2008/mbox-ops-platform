import Foundation

@main struct LiveTests {
  @MainActor static func main() async throws {
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    func decode<T: Decodable>(_ key: String) throws -> T {
      try JSONDecoder().decode(T.self, from: encode(fixture[key]!))
    }
    let auth: StaffIdentity = try decode("auth")
    let ops: LiveOperations = try decode("operations")
    var count = 0
    func check(_ value: Bool, _ label: String) {
      precondition(value, label)
      count += 1
      print("PASS \(label)")
    }
    func rejected(_ action: () throws -> Void) -> Bool {
      do {
        try action()
        return false
      } catch { return true }
    }
    check(
      auth.allows("table.open") && !auth.allows("payment.refund"),
      "server denial overrides allowed permission")
    var responseData = try encode(["data": fixture["auth"]!])
    var status = 200
    var requests: [URLRequest] = []
    let api = StaffAPI(transport: { request in
      requests.append(request)
      return (
        responseData,
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
      )
    })
    do {
      _ = try await api.login(code: "staff", pin: "12", switching: false)
      preconditionFailure()
    } catch {}
    check(requests.isEmpty, "invalid PIN never reaches network")
    responseData = try encode([
      "data": ["businessDate": "2026-09-26", "expiresAt": "2099-01-01T00:00:00Z"]
    ])
    _ = try await api.grant(credential: "fixture-only", deviceKey: "ios-fixture")
    check(requests.last!.url!.path == "/api/auth/device-access", "device admission precedes login")
    responseData = try encode(["data": fixture["auth"]!])
    _ = try await api.login(code: " staff ", pin: "1234", switching: false)
    check(api.identity?.employee.id == "employee-1", "valid employee/session binding")
    _ = try await api.heartbeat()
    check(
      requests.last!.value(forHTTPHeaderField: "x-mbox-staff-session-id") == "session-1"
        && requests.last!.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == "employee-1",
      "heartbeat binds both session and employee")
    status = 403
    responseData = try encode(["error": ["code": "CAPABILITY_FORBIDDEN", "message": "无权操作"]])
    do {
      _ = try await api.raw("/api/operations")
      preconditionFailure()
    } catch {}
    check(api.identity != nil, "403 retains identity but is not success")
    status = 401
    do {
      _ = try await api.raw("/api/operations")
      preconditionFailure()
    } catch {}
    check(api.identity == nil, "401 invalidates identity")
    status = 200
    responseData = try encode(["data": fixture["auth"]!])
    _ = try await api.login(code: "staff", pin: "1234", switching: false)
    var altered = fixture["auth"] as! [String: Any]
    var changedSession = altered["session"] as! [String: Any]
    changedSession["id"] = "other-session"
    altered["session"] = changedSession
    responseData = try encode(["data": altered])
    do {
      _ = try await api.heartbeat()
      preconditionFailure()
    } catch {}
    check(api.identity == nil, "unexpected heartbeat identity never replaces active employee")
    responseData = try encode(["data": fixture["auth"]!])
    _ = try await api.login(code: "staff", pin: "1234", switching: false)
    status = 204
    responseData = Data()
    try await api.logout()
    check(api.identity == nil, "logout handles empty 204 and clears identity")
    let before = requests.count
    do {
      _ = try await api.raw("https://untrusted.invalid/api/login")
      preconditionFailure()
    } catch {}
    check(requests.count == before, "reject off-origin request before transport")
    check(
      ops.displayTables()[0].due == 0 && ops.displayTables()[0].service,
      "operations maps authoritative table and tasks")
    var refunded = fixture["operations"] as! [String: Any]
    var rows = refunded["tables"] as! [[String: Any]]
    var session = rows[0]["activeSession"] as! [String: Any]
    session["financialState"] = "partially_refunded"
    session["netCollectedAmountMinor"] = 8000
    rows[0]["activeSession"] = session
    refunded["tables"] = rows
    let refundOps = try JSONDecoder().decode(LiveOperations.self, from: encode(refunded))
    check(
      refundOps.displayTables()[0].due == nil, "refund never becomes invented outstanding balance")
    let open = try LiveCommand.make(kind: "open", table: ops.tables[1], actor: auth, people: 2)
    check(
      open.steps[0].keyHeader == "x-idempotency-key"
        && open.steps[0].object["guestCount"] as? Int == 2,
      "open uses actual server payload and key header")
    check(
      rejected {
        _ = try LiveCommand.make(kind: "open", table: ops.tables[2], actor: auth, people: 2)
      }, "paused table cannot open")
    responseData = Data("<html>proxy login</html>".utf8)
    status = 200
    do {
      try await api.execute(open.steps[0])
      preconditionFailure()
    } catch {}
    check(
      requests.last!.value(forHTTPHeaderField: "x-idempotency-key") == open.steps[0].key,
      "malformed success retains original command and its key")
    responseData = try encode(["data": ["id": "server-receipt"], "meta": ["replayed": true]])
    try await api.execute(open.steps[0])
    check(true, "server command envelope accepted")
    let transfer = try LiveCommand.make(
      kind: "transfer", table: ops.tables[0], actor: auth, target: ops.tables[1])
    check(
      transfer.steps[0].object["expectedLocationVersion"] as? Int == 7,
      "transfer carries source location version")
    check(
      rejected {
        _ = try LiveCommand.make(kind: "freeze", table: ops.tables[0], actor: auth, frozen: true)
      }, "freeze requires explicit reason")
    let close = try LiveCommand.make(kind: "close", table: ops.tables[0], actor: auth)
    check(
      close.steps.count == 2 && close.steps[0].path.hasSuffix("begin-closing")
        && close.steps[1].path.hasSuffix("/close"), "close keeps server two-phase protocol")
    var disk = close
    var applied = Set<String>()
    var calls: [String] = []
    var loseReply = true
    func send(_ step: LiveCommand.Step) async throws {
      calls.append(step.key)
      applied.insert(step.key)
      if step.path.hasSuffix("/close") && loseReply {
        loseReply = false
        throw URLError(.timedOut)
      }
    }
    do {
      _ = try await LiveCommandRunner.advance(disk, send: send, checkpoint: { disk = $0 })
      preconditionFailure()
    } catch {}
    check(disk.completedSteps == 1, "interrupted close persists completed begin step")
    disk = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(disk))
    _ = try await LiveCommandRunner.advance(disk, send: send, checkpoint: { disk = $0 })
    check(
      calls.count == 3 && calls[1] == calls[2] && applied.count == 2,
      "relaunch replay reuses original key without duplicate effects")
    let completedCalls = calls.count
    _ = try await LiveCommandRunner.advance(disk, send: send, checkpoint: { disk = $0 })
    check(calls.count == completedCalls, "completed writes are never repeated for refresh recovery")
    check(
      !StaffAPIError(status: 409, code: "TABLE_OPERATION_CONFLICT", message: "")
        .definitivelyRejected
        && !StaffAPIError(status: 409, code: "IDEMPOTENCY_IN_PROGRESS", message: "")
          .definitivelyRejected,
      "ambiguous 409 must retain original request")
    let catalogFixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
    let product = try JSONDecoder().decode(
      LiveProduct.self, from: encode(catalogFixture["product"]!))
    var decorated = catalogFixture["product"] as! [String: Any]
    decorated["productSnapshot"] = [
      "imageUrl": "/menu/food/fries.jpg", "description": "现炸小食", "specification": "一份",
    ]
    let menuProduct = try JSONDecoder().decode(LiveProduct.self, from: encode(decorated))
    check(
      menuProduct.productSnapshot?.description == "现炸小食"
        && menuProduct.productSnapshot?.specification == "一份"
        && menuImageURL(menuProduct.productSnapshot?.imageUrl)?.absoluteString
          == "https://mbox.shmbox.com/menu/food/fries.jpg",
      "menu presentation uses actual optional snapshot")
    decorated["productSnapshot"] =
      ["imageUrl": 1, "description": [:], "specification": false] as [String: Any]
    let malformed = try JSONDecoder().decode(LiveProduct.self, from: encode(decorated))
    check(
      malformed.productSnapshot?.imageUrl == nil && malformed.productSnapshot?.description == nil
        && malformed.productSnapshot?.specification == nil && malformed.unavailable == nil,
      "malformed decorative fields do not break ordering")
    for path in [
      "/menu/food/fries.jpg", "/menu/DRINK.PNG",
      "/api/public/media-assets/MA" + String(repeating: "A", count: 32),
    ] {
      check(
        menuImageURL(path)?.absoluteString == "https://mbox.shmbox.com" + path,
        "approved public menu asset")
    }
    for path in [
      "https://example.com/x.jpg", "//example.com/x.jpg", "/menu/../private.jpg",
      "/menu/%2e%2e/x.jpg", "/menu/a.jpg?token=secret", "/api/staff/photo", "/menu/a.svg",
    ] {
      check(menuImageURL(path) == nil, "reject external or private menu asset")
    }
    check(
      product.price == 19800 && product.unavailable == nil && product.matches("pk0"),
      "server price and fuzzy product search")
    check(
      rejected { _ = try LiveDraftLine(product: product, choices: [:], note: "") },
      "bundle choice is mandatory")
    check(
      rejected { _ = try LiveDraftLine(product: product, choices: ["g1": ["p3"]], note: "") },
      "sold out choice rejected")
    check(
      rejected {
        _ = try LiveDraftLine(product: product, choices: ["g1": ["p1", "p1"]], note: "")
      }, "duplicate selections rejected")
    let first = try LiveDraftLine(product: product, choices: ["g1": ["p1"]], note: "少冰")
    let second = try LiveDraftLine(product: product, choices: ["g1": ["p2"]], note: "少冰")
    var book = LiveDraftBook()
    try book.add(first, employee: "e1", session: "s1")
    try book.add(second, employee: "e1", session: "s1")
    check(
      rejected { try book.add(first, employee: "e1", session: "s1") },
      "product limit aggregates different bundle selections")
    let restored = try JSONDecoder().decode(LiveDraftBook.self, from: JSONEncoder().encode(book))
    check(
      restored.entries["e1:s1"]?.map(\.selectionLabel) == ["饮品甲 ×2", "饮品乙 ×2"]
        && restored.entries["e2:s1"] == nil && restored.entries["e1:s2"] == nil,
      "restart preserves unit choices and isolates employees and sessions")
    let selections = first.payload["bundleSelections"] as! [[String: Any]]
    let groups = selections[0]["groups"] as! [[String: Any]]
    check(
      groups[0]["productIds"] as? [String] == ["p1"] && first.payload["quantity"] as? Int == 1
        && first.payload["note"] as? String == "少冰",
      "one bundle unit carries exact selected ids and note")
    for (field, value) in [
      ("allowedChannels", ["guest_qr"] as Any), ("inventoryAvailable", false),
      ("standardPrice", ["amountMinor": "-1", "currency": "CNY"]),
    ] {
      var altered = catalogFixture["product"] as! [String: Any]
      altered[field] = value
      let blocked = try JSONDecoder().decode(LiveProduct.self, from: encode(altered))
      check(
        rejected { _ = try LiveDraftLine(product: blocked, choices: ["g1": ["p1"]], note: "") },
        "catalog blocks invalid \(field)")
    }
    let items = try LiveDraftBook.orderItems([first, second])
    check(
      items.count == 1 && items[0]["quantity"] as? Int == 2
        && (items[0]["bundleSelections"] as? [[String: Any]])?.count == 2,
      "same product submits one line with per-unit bundle choices")
    let differentNote = try LiveDraftLine(product: product, choices: ["g1": ["p2"]], note: "常温")
    check(
      rejected { _ = try LiveDraftBook.orderItems([first, differentNote]) },
      "conflicting product notes are never silently merged")
    check(
      rejected {
        _ = try LiveDraftLine(
          product: product, choices: ["g1": ["p1"]], note: String(repeating: "字", count: 301))
      }, "item note follows server 300 UTF16 limit")
    print("\(count) live contract checks passed")
  }
}
