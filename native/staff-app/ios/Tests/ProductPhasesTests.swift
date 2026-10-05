import Foundation

@main struct ProductPhasesTests {
  @MainActor static func main() async throws {
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func actor(_ value: [String: Any]) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value)) }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1] + "/live-stock.json"))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]
    auth["permissions"] = ["recommendation.phase.configure"]
    var session = auth["session"] as! [String: Any]
    session["onlineLeaseUntil"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
    session["expiresAt"] = session["onlineLeaseUntil"]; auth["session"] = session
    let staff = try actor(auth), product = UUID().uuidString.lowercased()
    let original: [String: Any] = ["protocol": 1, "durableCommands": true, "employeeId": staff.employee.id,
      "productId": product, "expectedVersion": String(repeating: "a", count: 64), "phaseCodes": ["acoustic"]]
    var n = 0
    func check(_ valid: Bool, _ label: String) { precondition(valid, label); n += 1; print("PASS " + label) }
    func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func board(_ data: [String: Any]) throws -> ProductPhasesBoard { try ProductPhasesBoard(data: bytes(["data": data]), actor: staff, productID: product) }
    let snapshot = try board(original)
    let command = try snapshot.command(actor: staff, phases: ["after_show", "before_show"], reason: "调整演出安排", productName: "原商品")
    let step = command.steps[0]
    check(step.object["phaseCodes"] as? [String] == ["before_show", "after_show"], "selection has stable phase ordering")
    check(step.object["expectedVersion"] as? String == original["expectedVersion"] as? String, "original version retained")
    check(step.key == "native-business-" + command.id && step.path == productPhasesRoot + "/" + product, "target and idempotency bound")
    check(try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(command)) == command, "restart retains request")
    check(try snapshot.command(actor: staff, phases: [], reason: "取消阶段限制", productName: "原商品").steps[0].object["phaseCodes"] as? [String] == [], "empty selection explicitly removes phase restriction")
    for phases in [["acoustic"], ["unknown"], ["band_live", "band_live"]] {
      check(rejects { _ = try snapshot.command(actor: staff, phases: phases, reason: "调整阶段", productName: "原商品") }, "reject unchanged or invalid phases")
    }
    for reason in ["", "字", String(repeating: "字", count: 241)] {
      check(rejects { _ = try snapshot.command(actor: staff, phases: [], reason: reason, productName: "原商品") }, "require bounded explanation")
    }
    var denied = auth; denied["deniedPermissions"] = ["recommendation.phase.configure"]
    check(rejects { _ = try snapshot.command(actor: actor(denied), phases: [], reason: "调整阶段", productName: "原商品") }, "explicit deny overrides allow")
    var expired = auth; session["onlineLeaseUntil"] = "2020-01-01T00:00:00Z"; expired["session"] = session
    check(rejects { _ = try snapshot.command(actor: actor(expired), phases: [], reason: "调整阶段", productName: "原商品") }, "expired online lease cannot submit")
    for (key, value) in [("protocol", true as Any), ("protocol", 1.5), ("durableCommands", 1),
      ("employeeId", UUID().uuidString), ("productId", UUID().uuidString), ("expectedVersion", "bad"),
      ("phaseCodes", ["unknown"]), ("phaseCodes", ["acoustic", "acoustic"])] {
      var wrong = original; wrong[key] = value
      check(rejects { _ = try board(wrong) }, "reject invalid board " + key)
    }
    var disabled = original; disabled["durableCommands"] = false
    check(rejects { _ = try board(disabled).command(actor: staff, phases: [], reason: "调整阶段", productName: "原商品") }, "server disabled commands respected")
    let result: [String: Any] = ["employeeId": staff.employee.id, "productId": product, "requestKey": step.key, "phaseCodes": ["after_show", "before_show"]]
    let reply = try bytes(["data": result, "meta": ["protocol": 1, "replayed": true]])
    try validateProductPhasesReply(reply, step: step); check(true, "server replay with same set accepted")
    for (key, value) in [("employeeId", UUID().uuidString as Any), ("productId", UUID().uuidString),
      ("requestKey", "new-key"), ("phaseCodes", []), ("phaseCodes", ["after_show", "after_show"])] {
      var wrong = result; wrong[key] = value
      check(rejects { try validateProductPhasesReply(bytes(["data": wrong, "meta": ["protocol": 1, "replayed": false]]), step: step) }, "mismatched receipt " + key)
    }
    for meta in [["protocol": true, "replayed": true] as [String: Any], ["protocol": 1, "replayed": 1], ["protocol": 1.5, "replayed": true]] {
      check(rejects { try validateProductPhasesReply(bytes(["data": result, "meta": meta]), step: step) }, "strict receipt metadata")
    }
    var bodies: [Data] = [], keys: [String] = []
    let api = StaffAPI(transport: { request in
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!
      if request.url!.path == "/api/auth/login" { return (try bytes(["data": auth]), response) }
      check(request.url!.path == step.path && request.httpMethod == "POST", "actual transport endpoint and method")
      bodies.append(request.httpBody!); keys.append(request.value(forHTTPHeaderField: "idempotency-key") ?? "")
      if bodies.count == 1 { throw URLError(.networkConnectionLost) }
      return (reply, response)
    })
    _ = try await api.login(code: staff.employee.code, pin: "1234", switching: false)
    var pending = command
    func send(_ value: LiveCommand.Step) async throws {
      let (response, _) = try await api.raw(value.path, body: value.object, headers: [value.keyHeader: value.key])
      try validateProductPhasesReply(response, step: value)
    }
    do { _ = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 }); preconditionFailure("expected network uncertainty") }
    catch { check(pending.completedSteps == 0, "lost reply remains unresolved") }
    pending = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(pending))
    pending = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 })
    check(keys == [step.key, step.key] && bodies[0] == bodies[1], "restore reuses original exact key and body")
    _ = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 })
    check(bodies.count == 2 && pending.completedSteps == 1, "confirmed request never resent during refresh")
    print("\(n) product phase checks passed")
  }
}
