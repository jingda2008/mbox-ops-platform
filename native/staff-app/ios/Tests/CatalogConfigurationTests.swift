import Foundation

@main struct CatalogConfigurationTests {
  @MainActor static func main() async throws {
    func bytes(_ value: Any) throws -> Data { try catalogConfigData(value) }
    func actor(_ value: [String: Any]) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value)) }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1] + "/live-stock.json"))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]; auth["permissions"] = ["catalog.product.manage", "catalog.price.manage"]
    var session = auth["session"] as! [String: Any]; session["onlineLeaseUntil"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)); session["expiresAt"] = session["onlineLeaseUntil"]; auth["session"] = session
    let staff = try actor(auth)
    let category: [String: Any] = ["id": UUID().uuidString.lowercased(), "code": "drinks", "displayName": "饮品", "parentCode": NSNull(), "updatedAt": "2026-10-05 06:01:02.123456+00", "sortOrder": 10, "guestVisible": true]
    var leaf = category; leaf["id"] = UUID().uuidString.lowercased(); leaf["code"] = "soft"; leaf["parentCode"] = "drinks"; leaf["displayName"] = "软饮"
    let product: [String: Any] = ["id": UUID().uuidString.lowercased(), "code": "TEA", "name": "原茶饮", "categoryCode": "soft", "productKind": "single", "nativeVersion": String(repeating: "a", count: 64), "fulfillmentStation": "bar", "inventoryControlMode": "tracked", "maxOrderQuantity": 99, "allowedChannels": ["guest_qr", "cashier"], "availableFrom": NSNull(), "availableUntil": NSNull(), "productSnapshot": ["description": "原说明"], "bundleComponents": [], "bundleChoiceGroups": []]
    let original: [String: Any] = ["currentEmployeeId": staff.employee.id, "configurationProtocol": 1, "durableProducts": true, "canPrice": true, "offset": 0, "limit": 40, "products": [product], "categories": [category, leaf]]
    func board(_ value: [String: Any]) throws -> CatalogConfigurationBoard { try CatalogConfigurationBoard(data: bytes(["data": value]), actor: staff) }
    let current = try board(original), item = current.products[0]
    var n = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); n += 1; print("PASS " + label) }
    func rejects(_ fn: () throws -> Void) -> Bool { do { try fn(); return false } catch { return true } }
    var draft = try CatalogProductDraft(); draft.code = "NEW"; draft.name = "新商品"; draft.category = "soft"; draft.initialPrice = "0.01"
    let create = try draft.command(actor: staff, board: current, product: nil)
    check(create.steps[0].object["status"] as? String == "inactive", "new products start inactive")
    check((create.steps[0].object["standardPrice"] as? [String: Any])?["amountMinor"] as? Int == 1, "initial price uses exact cents")
    var denied = auth; denied["deniedPermissions"] = ["catalog.price.manage"]
    check(rejects { _ = try draft.command(actor: actor(denied), board: current, product: nil) }, "initial price checks explicit price deny")
    var edit = try CatalogProductDraft(product: item); edit.name = "更新茶饮"; edit.from = "21:00"; edit.until = "02:00"
    for image in ["/api/public/media-assets/MA" + String(repeating: "A", count: 32), "https://mbox.shmbox.com/menu.jpg"] {
      var imageDraft = edit; imageDraft.imageURL = image
      check(!rejects { _ = try imageDraft.command(actor: staff, board: current, product: item) }, "allow valid owned media reference or HTTPS image")
    }
    for image in ["/api/public/media-assets/../../private", "data:image/png;base64,eA==", "https://secret@example.com/image.png"] {
      var imageDraft = edit; imageDraft.imageURL = image
      check(rejects { _ = try imageDraft.command(actor: staff, board: current, product: item) }, "reject unsafe image reference")
    }
    let update = try edit.command(actor: staff, board: current, product: item)
    check(update.steps[0].object["expectedVersion"] as? String == item.text("nativeVersion"), "edit retains original full version")
    for field in ["category", "time", "channels", "station", "quantity", "name", "code"] {
      var invalid = draft
      switch field { case "category": invalid.category = "drinks"; case "time": invalid.from = "25:00"; case "channels": invalid.channels = []; case "station": invalid.station = "unknown"; case "quantity": invalid.maximum = "0"; case "name": invalid.name = ""; default: invalid.code = "bad/code" }
      check(rejects { _ = try invalid.command(actor: staff, board: current, product: nil) }, "reject invalid product " + field)
    }
    var bundle = draft; bundle.kind = "bundle"; bundle.station = "none"; bundle.initialPrice = ""
    check(rejects { _ = try bundle.command(actor: staff, board: current, product: nil) }, "empty bundle rejected")
    bundle.groups = [CatalogBundleGroup()]
    check(rejects { _ = try bundle.command(actor: staff, board: current, product: nil) }, "empty choice group rejected without range crash")
    let component = CatalogBundleItem(productID: item.id, name: item.text("name"), quantity: "2", sortOrder: 10, note: "原备注")
    bundle.components = [component]; bundle.groups = []
    let fixed = try bundle.command(actor: staff, board: current, product: nil)
    check(fixed.steps[0].catalogConfigurationProof?["confirmation"] as? String != nil, "full bundle confirmation available")
    bundle.components.append(component)
    check(rejects { _ = try bundle.command(actor: staff, board: current, product: nil) }, "duplicate fixed product rejected")
    bundle.components = []; var group = CatalogBundleGroup(); group.options = [component]; bundle.groups = [group]
    let choice = try bundle.command(actor: staff, board: current, product: nil)
    group.selectionCount = "2"; bundle.groups = [group]
    check(rejects { _ = try bundle.command(actor: staff, board: current, product: nil) }, "choice count cannot exceed options")
    var selfBundle = edit; selfBundle.kind = "bundle"; selfBundle.station = "none"; selfBundle.components = [component]
    check(rejects { _ = try selfBundle.command(actor: staff, board: current, product: item) }, "bundle cannot contain itself")
    let categoryCreate = try categoryConfigurationCommand(actor: staff, board: current, category: nil, code: "new_leaf", name: "新分类", parent: "drinks", sort: "10", visible: false)
    let categoryUpdate = try categoryConfigurationCommand(actor: staff, board: current, category: current.categories[1], code: "soft", name: "更新分类", parent: "drinks", sort: "20", visible: true)
    check(categoryUpdate.steps[0].object["expectedUpdatedAt"] as? String == leaf["updatedAt"] as? String, "category microsecond version retained")
    check(rejects { _ = try categoryConfigurationCommand(actor: staff, board: current, category: nil, code: "new", name: "分类", parent: "soft", sort: "1", visible: true) }, "third level category rejected")
    for command in [create, update, fixed, choice, categoryCreate, categoryUpdate] {
      let step = command.steps[0], proof = command.steps[0].catalogConfigurationProof!
      var response = proof["expected"] as! [String: Any]
      response["id"] = proof["creating"] as? Bool == true ? UUID().uuidString.lowercased() : (proof["id"] as? String ?? leaf["id"]!)
      if proof["kind"] as? String == "category" { response["code"] = proof["code"] }
      if let price = response["standardPrice"] as? [String: Any] { response["standardPrice"] = ["amountMinor": String(price["amountMinor"] as! Int), "currency": "CNY"] }
      if let from = response["availableFrom"] as? String { response["availableFrom"] = from + ":00" }
      if let until = response["availableUntil"] as? String { response["availableUntil"] = until + ":00" }
      let reply = try bytes(["data": response, "meta": ["replayed": true]])
      try validateCatalogConfigurationReply(reply, step: step); check(true, "original configuration receipt accepted")
      var wrong = response; wrong[proof["kind"] as? String == "category" ? "displayName" : "name"] = "错误名称"
      check(rejects { try validateCatalogConfigurationReply(bytes(["data": wrong, "meta": ["replayed": true]]), step: step) }, "wrong name receipt rejected")
      check(rejects { try validateCatalogConfigurationReply(bytes(["data": response, "meta": ["replayed": 1]]), step: step) }, "numeric boolean rejected")
      var requests: [Data] = [], keys: [String] = []
      let api = StaffAPI(transport: { request in
        let result = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!
        if request.url!.path == "/api/auth/login" { return (try bytes(["data": auth]), result) }
        check(request.url!.path == step.path && request.httpMethod == "POST", "real transport uses original endpoint")
        requests.append(request.httpBody!); keys.append(request.value(forHTTPHeaderField: "idempotency-key") ?? "")
        if requests.count == 1 { throw URLError(.networkConnectionLost) }; return (reply, result)
      })
      _ = try await api.login(code: staff.employee.code, pin: "1234", switching: false)
      var pending = command
      func send(_ step: LiveCommand.Step) async throws { let (value, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key]); try validateCatalogConfigurationReply(value, step: step) }
      do { _ = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 }); preconditionFailure("lost response") } catch { check(pending.completedSteps == 0, "unknown result retains pending") }
      pending = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(pending))
      pending = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 })
      check(requests[0] == requests[1] && keys == [step.key, step.key], "restart reuses exact original body and key")
      _ = try await LiveCommandRunner.advance(pending, send: send, checkpoint: { pending = $0 })
      check(requests.count == 2, "completed mutation not resent")
    }
    print("\(n) catalog configuration checks passed")
  }
}
