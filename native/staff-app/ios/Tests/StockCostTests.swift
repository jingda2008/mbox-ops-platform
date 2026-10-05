import Foundation

@main struct StockCostTests {
  @MainActor static func main() async throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath:
      CommandLine.arguments[1] + "/live-stock.json"))) as! [String: Any]
    func bytes(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x, options: .sortedKeys) }
    func decode<T: Decodable>(_ type: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(type, from: bytes(x))
    }
    var n = 0
    func check(_ b: Bool, _ label: String) { precondition(b, label); n += 1; print("PASS " + label) }
    func rejects(_ f: () throws -> Void) -> Bool { do { try f(); return false } catch { return true } }
    var auth = fixture["auth"] as! [String: Any]
    auth["permissions"] = ["inventory.view", "inventory.cost.view", "inventory.cost.correct"]
    var session = auth["session"] as! [String: Any]
    let expires = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
    session["expiresAt"] = expires; session["onlineLeaseUntil"] = expires; auth["session"] = session
    let actor = try decode(StaffIdentity.self, auth)
    var data = fixture["board"] as! [String: Any]
    data["nativeCostCorrections"] = true
    data["inventoryObservedAt"] = "2026-10-05 02:03:04.123456+00"
    data["visibility"] = ["costs": true]
    data["receiptsPage"] = ["page": 0, "hasMore": true]
    var items = data["items"] as! [[String: Any]]
    items[0]["weightedUnitCostMinor"] = NSNull(); data["items"] = items
    let board = try decode(StockBoard.self, data)
    let itemID = board.items[0].id
    let command = try stockCostCommand(actor: actor, board: board, itemID: itemID,
      yuan: "0.00123456", reason: "核对原采购成本")
    let step = command.steps[0]
    check(step.object["weightedUnitCostMinor"] as? String == "0.123456", "fractional-cent cost retained exactly")
    check(step.object["expectedWeightedUnitCostMinor"] is NSNull, "unknown cost remains null instead of zero")
    check(step.object["expectedObservedAt"] as? String == "2026-10-05T02:03:04.123456+00:00", "snapshot precision and timezone preserved")
    check(stockCostText(nil) == "成本未知" && stockCostText("0") == "0元", "unknown and free cost distinguished")
    check(step.stockCostProof?["employeeId"] as? String == actor.employee.id, "original employee bound")
    check(try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(command)) == command, "restart retains original exact payload and key")
    for value in ["-1", "1e2", "NaN", "01", "1,000", "0.000000001", "10000000000", ".5", "1."] {
      check(rejects { _ = try stockCostCommand(actor: actor, board: board, itemID: itemID, yuan: value, reason: "成本核对") }, "reject unsafe decimal " + value)
    }
    for value in ["0", "9999999999.99999999", "1.23000000"] {
      let c = try stockCostCommand(actor: actor, board: board, itemID: itemID, yuan: value, reason: "成本核对")
      check(stockCostDecimal(c.steps[0].object["weightedUnitCostMinor"]) != nil, "accept exact allowed decimal " + value)
    }
    for permission in ["inventory.cost.view", "inventory.cost.correct"] {
      var denied = auth; denied["deniedPermissions"] = [permission]
      check(rejects { _ = try stockCostCommand(actor: decode(StaffIdentity.self, denied), board: board, itemID: itemID, yuan: "1", reason: "成本核对") }, "explicit deny " + permission)
    }
    for (key, value) in [("nativeCostCorrections", false as Any), ("visibility", ["costs": false]), ("currentEmployeeId", UUID().uuidString)] {
      var wrong = data; wrong[key] = value
      check(rejects { _ = try stockCostCommand(actor: actor, board: decode(StockBoard.self, wrong), itemID: itemID, yuan: "1", reason: "成本核对") }, "block stale authority " + key)
    }
    for reason in ["", "x", String(repeating: "字", count: 501)] {
      check(rejects { _ = try stockCostCommand(actor: actor, board: board, itemID: itemID, yuan: "1", reason: reason) }, "reason boundary")
    }
    for instant in [nil, "bad", "2026-13-32T99:00:00Z"] as [String?] {
      check(rejects { _ = try stockServerInstant(instant) }, "reject invalid snapshot")
    }
    var result: [String: Any] = ["id": UUID().uuidString, "inventoryItemId": itemID,
      "weightedUnitCostMinor": "0.123456", "previousWeightedUnitCostMinor": NSNull()]
    let reply = try bytes(["data": result, "meta": ["replayed": true]])
    try validateStockCostReply(reply, step: step); check(true, "original correction reply accepted")
    for (key, value) in [("id", "bad" as Any), ("inventoryItemId", UUID().uuidString),
      ("weightedUnitCostMinor", "0.123457"), ("previousWeightedUnitCostMinor", "0")] {
      var wrong = result; wrong[key] = value
      check(rejects { try validateStockCostReply(bytes(["data": wrong, "meta": ["replayed": true]]), step: step) }, "mismatched reply " + key)
    }
    for replay in [1 as Any, "true", NSNull()] {
      check(rejects { try validateStockCostReply(bytes(["data": result, "meta": ["replayed": replay]]), step: step) }, "strict replay boolean")
    }
    items[0]["weightedUnitCostMinor"] = "10.5000"; data["items"] = items
    let known = try stockCostCommand(actor: actor, board: decode(StockBoard.self, data), itemID: itemID, yuan: "0.00123456", reason: "已知成本核对")
    result["previousWeightedUnitCostMinor"] = "10.5"
    try validateStockCostReply(bytes(["data": result, "meta": ["replayed": false]]), step: known.steps[0])
    check(true, "known old cost compares decimal value without float")
    let q = StockReceiptQuery(page: 2, status: "received", search: "单号 & /茶+", from: "2024-02-29", to: "2026-10-05")
    let parts = URLComponents(string: try q.path())!
    let values = Dictionary(uniqueKeysWithValues: parts.queryItems!.map { ($0.name, $0.value!) })
    check(values["receiptSearch"] == "单号 & /茶+" && values["receiptsPage"] == "2"
      && parts.percentEncodedQuery!.contains("%2B") && !parts.percentEncodedQuery!.contains("+"), "history query preserves literal plus under server form decoding")
    for bad in [StockReceiptQuery(page: -1), StockReceiptQuery(page: 10001), StockReceiptQuery(status: "paid"),
      StockReceiptQuery(search: String(repeating: "x", count: 121)), StockReceiptQuery(from: "2025-02-29"),
      StockReceiptQuery(from: "2026-1-1"), StockReceiptQuery(from: "2026-10-05", to: "2026-10-04")] {
      check(rejects { _ = try bad.path() }, "history invalid filter rejected")
    }
    var requests: [String] = []; var bodies: [Data] = []; var calls = 0
    let api = StaffAPI(transport: { request in
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!
      if request.url!.path == "/api/auth/login" { return (try bytes(["data": auth]), response) }
      check(request.url!.path == step.path, "actual StaffAPI correction endpoint")
      requests.append(request.value(forHTTPHeaderField: "idempotency-key") ?? "")
      bodies.append(request.httpBody!); calls += 1
      if calls == 1 { throw URLError(.networkConnectionLost) }
      return (reply, response)
    })
    _ = try await api.login(code: actor.employee.code, pin: "1234", switching: false)
    var durable = command
    func send(_ s: LiveCommand.Step) async throws {
      let (value, _) = try await api.raw(s.path, body: s.object, headers: [s.keyHeader: s.key])
      try validateStockCostReply(value, step: s)
    }
    do { _ = try await LiveCommandRunner.advance(durable, send: send, checkpoint: { durable = $0 }); preconditionFailure("lost response") }
    catch { check(durable.completedSteps == 0, "lost response stays unresolved") }
    durable = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(durable))
    durable = try await LiveCommandRunner.advance(durable, send: send, checkpoint: { durable = $0 })
    check(requests == [step.key, step.key] && bodies[0] == bodies[1], "restart retries original body and key through real StaffAPI")
    check(durable.completedSteps == 1, "valid replay durably completes once")
    _ = try await LiveCommandRunner.advance(durable, send: send, checkpoint: { durable = $0 })
    check(calls == 2, "refresh recovery never sends completed cost correction again")
    let lineA = try StockLine.make(item: board.items[0], quantity: "1", amount: "1.20", scan: nil, batchCode: "A:1")
    let lineB = try StockLine.make(item: board.items[0], quantity: "1", amount: "1.20", scan: nil, batchCode: "B:1")
    check(lineA.id != lineB.id && lineA.payload["batchCode"] as? String == "A:1", "same material different batches stay distinct")
    var receiveAuth = auth; receiveAuth["permissions"] = ["inventory.receive"]
    let receiveActor = try decode(StaffIdentity.self, receiveAuth)
    let purchase = try stockCommand(actor: receiveActor, board: board, lines: [lineA, lineB], supplierName: "  原供应商  ")
    check((purchase.steps[0].object["supplierSnapshot"] as? [String: String])?["name"] == "原供应商", "supplier retained in original request")
    var book = StockDraftBook(linesByEmployee: [actor.employee.id: [lineA, lineB]], suppliersByEmployee: [actor.employee.id: "原供应商"])
    let roundtrip = try StockDraftBook.read(JSONEncoder().encode(book))
    check(try roundtrip.matches(employee: actor.employee.id, proof: purchase.steps[0].stockProof!), "matching original draft includes supplier and batches")
    book.suppliersByEmployee[actor.employee.id] = "新供应商"
    check(try !book.matches(employee: actor.employee.id, proof: purchase.steps[0].stockProof!), "receipt cannot erase a changed supplier draft")
    let oldLine = try StockLine.make(item: board.items[0], quantity: "1", amount: "1", scan: nil)
    let oldBook = try StockDraftBook.read(JSONEncoder().encode([actor.employee.id: [oldLine]]))
    check(oldBook[actor.employee.id] == [oldLine] && oldBook.suppliersByEmployee.isEmpty, "legacy v1 employee drafts migrate without loss")
    check(oldBook[UUID().uuidString] == nil, "other employee cannot read original draft")
    check(rejects { _ = try StockDraftBook.read(bytes(["version": 3])) }, "unknown draft version preserved as an error")
    for text in ["ab\ncd", "a\tb", String(repeating: "x", count: 129)] {
      check(rejects { _ = try stockBatchCode(text) }, "invalid batch code rejected")
    }
    check(rejects { _ = try stockSupplierName(String(repeating: "x", count: 201)) }, "supplier limit checked")
    print("\(n) stock cost and history checks passed")
  }
}
