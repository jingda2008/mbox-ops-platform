import Foundation

@main struct OrderTests {
  @MainActor static func main() async throws {
    func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-contract.json"))) as! [String: Any]
    var rawAuth = fixture["auth"] as! [String: Any]
    rawAuth["permissions"] = ["order.create", "order.gift", "service.execute"]
    let auth = try JSONDecoder().decode(StaffIdentity.self, from: encode(rawAuth))
    let menu =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-catalog.json"))) as! [String: Any]
    let product = try JSONDecoder().decode(LiveProduct.self, from: encode(menu["product"]!))
    let line = try LiveDraftLine(product: product, choices: ["g1": ["p1"]], note: "少冰")
    let access = LiveOrderAccess(
      employeeId: "employee-1", canCreateOrder: true,
      gift: .init(enabled: true, maximumAmountMinor: 20000, currency: "CNY"))
    let context = LiveOrderContext(
      token: String(repeating: "A", count: 43), employeeId: "employee-1",
      staffSessionId: "session-1", tableSessionId: "table-session-1",
      expiresAt: "2099-01-01T00:00:00Z")
    func make(
      gift: Bool = false, reason: String = "顾客回访", lines: [LiveDraftLine]? = nil,
      products: [LiveProduct]? = nil, actor: StaffIdentity? = nil
    ) throws -> LiveOrderSubmission {
      try LiveOrderSubmission.make(
        lines: lines ?? [line], products: products ?? [product], identity: actor ?? auth,
        access: access, context: context, session: "table-session-1", tableCode: "A5", gift: gift,
        reason: reason, note: "一起出品", settlement: "immediate_payment")
    }
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
    let order = try make()
    check(
      order.object["settlementMode"] as? String == "immediate_payment"
        && order.object["orderMode"] as? String == "paid", "paid order retains settlement choice")
    let gift = try make(gift: true)
    check(
      gift.object["settlementMode"] as? String == "table_tab"
        && gift.object["giftReason"] as? String == "顾客回访",
      "gift uses authorized table account and reason")
    check(rejected { _ = try make(gift: true, reason: "") }, "gift reason required")
    check(
      rejected { _ = try make(gift: true, lines: [line, line]) },
      "gift cap checked on complete order")
    check(rejected { _ = try make(products: []) }, "removed product rejected before submission")
    var changedProduct = menu["product"] as! [String: Any]
    changedProduct["standardPrice"] = ["amountMinor": "19900", "currency": "CNY"]
    let repriced = try JSONDecoder().decode(LiveProduct.self, from: encode(changedProduct))
    check(
      rejected { _ = try make(products: [repriced]) },
      "changed price requires renewed staff confirmation")
    let restored = try JSONDecoder().decode(
      LiveOrderSubmission.self, from: JSONEncoder().encode(order))
    try restored.validate()
    check(
      restored.key == order.key && restored.body == order.body
        && restored.draftIDs == order.draftIDs,
      "restart retains exact request identity payload and draft units")
    check(order.canReplay(auth), "same session can replay original request")
    var newAuth = rawAuth
    var session = newAuth["session"] as! [String: Any]
    session["id"] = "new-session"
    newAuth["session"] = session
    let relogged = try JSONDecoder().decode(StaffIdentity.self, from: encode(newAuth))
    check(!order.canReplay(relogged), "relogin cannot replay under a different staff session")
    check(
      !order.canReplay(auth, now: order.createdAt.addingTimeInterval(13 * 3600)),
      "aged request requires readback rather than blind replay")
    newAuth = rawAuth
    newAuth["deniedPermissions"] = ["order.create"]
    let denied = try JSONDecoder().decode(StaffIdentity.self, from: encode(newAuth))
    check(
      rejected { _ = try make(actor: denied) },
      "explicit deny blocks order even when access response allows it")
    var receipt: [String: Any] = [
      "id": "order-id", "publicId": order.publicId, "tableSessionId": order.tableSessionID,
      "currency": "CNY", "totalAmountMinor": 19800, "paymentNextStep": ["orderId": "order-id"],
    ]
    var response = try encode(receipt)
    var requests: [URLRequest] = []
    let api = StaffAPI(transport: { request in
      requests.append(request)
      return (
        response,
        HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
      )
    })
    let confirmed = try await api.submitOrder(order)
    check(
      confirmed.publicId == order.publicId && confirmed.totalAmountMinor == 19800,
      "server receipt establishes order amount")
    _ = try await api.submitOrder(restored)
    check(
      requests.count == 2
        && requests.allSatisfy {
          $0.value(forHTTPHeaderField: "idempotency-key") == order.key
            && $0.value(forHTTPHeaderField: "x-assisted-order-context") == order.token
        }, "retry transport preserves original key and context")
    receipt["publicId"] = "another-order"
    response = try encode(receipt)
    do {
      _ = try await api.submitOrder(order)
      preconditionFailure()
    } catch {}
    check(true, "another order receipt cannot clear pending request")
    check(
      LiveOrderSubmission.initialRejection(
        StaffAPIError(status: 409, code: "INVENTORY_INSUFFICIENT", message: "")) != nil
        && LiveOrderSubmission.initialRejection(
          StaffAPIError(status: 409, code: "IDEMPOTENCY_CONFLICT", message: "")) == nil
        && LiveOrderSubmission.initialRejection(
          StaffAPIError(status: 503, code: "REQUEST_INVALID", message: "")) == nil,
      "initial rejection whitelist keeps ambiguous or gateway errors pending")
    var cashierRaw = rawAuth
    cashierRaw["permissions"] = [
      "payment.manual.cash.record", "payment.manual.pos.record", "payment.manual.external.record",
    ]
    let cashier = try JSONDecoder().decode(StaffIdentity.self, from: encode(cashierRaw))
    let due = LivePaymentOrder(
      id: "order-id", publicId: "original-order", currency: "CNY", paymentStatus: "partially_paid",
      outstandingAmountMinor: 1000, hasOnlinePaymentInProgress: false,
      unresolvedOnlinePaymentId: nil)
    let due2 = LivePaymentOrder(
      id: "order-2", publicId: "original-2", currency: "CNY", paymentStatus: "unpaid",
      outstandingAmountMinor: 500, hasOnlinePaymentInProgress: false, unresolvedOnlinePaymentId: nil
    )
    func cash(_ orders: [LivePaymentOrder], amount: Int = 500) throws -> LiveCommand {
      try LiveCommand.manualCollection(
        orders: orders, actor: cashier, amount: amount, provider: "cash", reference: "",
        terminal: "", method: "", note: "")
    }
    let partial = try cash([due])
    let batch = try cash([due, due2], amount: 1500)
    check(
      partial.steps[0].object["amountMinor"] as? Int == 500
        && partial.steps[0].object["orderIds"] == nil,
      "partial collection preserves exact amount and single order recovery path")
    check(
      batch.steps[0].object["orderIds"] as? [String] == ["order-id", "order-2"],
      "batch collection contains only selected original order ids")
    check(
      rejected { _ = try cash([due], amount: 1001) } && rejected { _ = try cash([due, due]) },
      "overpayment and duplicate batch targets rejected")
    let pending = LivePaymentOrder(
      id: due.id, publicId: due.publicId, currency: "CNY", paymentStatus: "unpaid",
      outstandingAmountMinor: 1000, hasOnlinePaymentInProgress: true,
      unresolvedOnlinePaymentId: "payment-original")
    check(rejected { _ = try cash([pending]) }, "unknown online payment blocks manual collection")
    check(
      rejected {
        _ = try LiveCommand.manualCollection(
          orders: [due], actor: auth, amount: 500, provider: "cash", reference: "", terminal: "",
          method: "", note: "")
      }, "cash permission required independently of ordering")
    check(
      rejected {
        _ = try LiveCommand.manualCollection(
          orders: [due], actor: cashier, amount: 500, provider: "physical_pos", reference: "",
          terminal: "", method: "", note: "")
      }, "POS collection requires original reference")
    let external = try LiveCommand.manualCollection(
      orders: [due], actor: cashier, amount: 500, provider: "external_manual",
      reference: "BANK-123", terminal: "", method: "bank_transfer", note: "原转账已核对")
    check(
      external.steps[0].object["externalMethodCode"] as? String == "bank_transfer"
        && external.steps[0].object["receiptReference"] as? String == "BANK-123",
      "external receipt records method and original evidence")
    let expected = partial.steps[0].object
    response = try encode([
      "data": [
        "publicId": expected["publicId"]!, "status": "succeeded", "currency": "CNY",
        "amountMinor": 500,
      ], "meta": ["replayed": true],
    ])
    try await api.execute(partial.steps[0])
    check(true, "manual payment acknowledges only matching successful receipt")
    response = try encode([
      "data": [
        "publicId": expected["publicId"]!, "status": "pending", "currency": "CNY",
        "amountMinor": 500,
      ], "meta": ["replayed": false],
    ])
    do {
      try await api.execute(partial.steps[0])
      preconditionFailure()
    } catch {}
    check(true, "pending provider response never becomes received money")
    let board = try JSONDecoder().decode(
      LiveKitchen.self, from: Data(contentsOf: dir.appending(path: "live-kitchen.json")))
    var cookRaw = rawAuth
    cookRaw["permissions"] = ["kds.prepare", "table.close", "table.turnover_unsettled"]
    let cook = try JSONDecoder().decode(StaffIdentity.self, from: encode(cookRaw))
    let start = try board.command(
      actor: cook, action: "start", sourceID: "task1", quantity: 2, equipment: "炸炉", seconds: 180)
    let startBody = start.steps[0].object["command"] as! [String: Any]
    let startItems = startBody["items"] as! [[String: Any]]
    check(
      startBody["compatibilityKey"] as? String == "[\"product1\",\"规格/A\",\"少盐\",\"\"]"
        && startItems[0]["expectedUnmade"] as? Int == 3
        && startItems[0]["locationVersion"] as? Int == 7,
      "production carries exact group identity remaining quantity and table location")
    check(
      rejected {
        _ = try board.command(actor: cook, action: "start", sourceID: "task1", quantity: 4)
      }, "cannot start more portions than remain")
    let quick = try board.command(
      actor: cook, action: "quick-ready", sourceID: "task1", quantity: 1, equipment: "炸炉",
      seconds: 180)
    let quickBody = quick.steps[0].object["command"] as! [String: Any]
    check(
      quickBody["equipment"] is NSNull && quickBody["expectedSeconds"] is NSNull,
      "direct readiness never implies using or releasing equipment")
    let ready = try board.command(
      actor: cook, action: "ready", sourceID: "batch1", unitIDs: ["unit1"])
    let readyBody = ready.steps[0].object["command"] as! [String: Any]
    check(
      readyBody["expectedOwnershipVersion"] as? Int == 4
        && ((readyBody["items"] as! [[String: Any]])[0]["unitIds"] as? [String]) == ["unit1"],
      "readiness binds exact units and original batch ownership version")
    check(
      rejected {
        _ = try board.command(actor: cook, action: "ready", sourceID: "batch1", unitIDs: ["held"])
      }, "held portion cannot be declared ready")
    check(
      rejected { _ = try board.command(actor: auth, action: "start", sourceID: "task1") },
      "ordering permission cannot start production")
    response = try encode([
      "data": ["batchId": "batch1", "action": "ready", "quantity": 1, "released": false],
      "replayed": true,
    ])
    try await api.execute(ready.steps[0])
    check(true, "kitchen command uses its distinct receipt envelope")
    response = try encode([
      "data": ["batchId": "wrong-batch", "action": "ready", "quantity": 1, "released": false],
      "replayed": true,
    ])
    do {
      try await api.execute(ready.steps[0])
      preconditionFailure()
    } catch {}
    check(true, "other batch receipt cannot clear production request")
    let ops = try JSONDecoder().decode(LiveOperations.self, from: encode(fixture["operations"]!))
    let turnover = try LiveCommand.make(
      kind: "turnover", table: ops.tables[0], actor: cook, reason: "顾客已离店，主管继续追账")
    check(
      turnover.steps.count == 1 && turnover.steps[0].path.hasSuffix("close-after-customer-left"),
      "customer departure follows dedicated retained debt contract")
    check(
      rejected {
        _ = try LiveCommand.make(
          kind: "turnover", table: ops.tables[0], actor: auth, reason: "顾客已离店")
      }, "ordinary staff cannot authorize unsettled turnover")

    rawAuth["permissions"] = [
      "kds.prepare", "kds.exception.manage", "kds.deliver", "staff.access.configure",
    ]
    let worker = try JSONDecoder().decode(StaffIdentity.self, from: encode(rawAuth))
    let pickup = try JSONDecoder().decode(
      LivePickup.self, from: Data(contentsOf: dir.appending(path: "live-pickup.json")))
    let take = try pickup.make(
      actor: worker, action: "take", target: "ts1", units: ["original:unit1", "remake:unit1"])
    check(
      (take.steps[0].object["units"] as? [[String: Any]])?.count == 2
        && take.steps[0].object["locationVersion"] as? Int == 7,
      "original and remake units remain distinct and bind table location")
    check(
      rejected {
        _ = try pickup.make(actor: worker, action: "take", target: "ts1", units: ["missing"])
      }, "stale selection cannot record pickup")
    check(
      rejected {
        _ = try pickup.make(actor: auth, action: "take", target: "ts1", units: ["original:unit1"])
      }, "pickup requires delivery permission")
    let undo = try pickup.make(actor: worker, action: "undo", target: "receipt1")
    check(
      undo.steps[0].object["physicalStillAtPickupPoint"] as? Bool == true
        && undo.steps[0].object["expectedRevision"] as? Int == 8,
      "undo binds receipt revision and explicit physical confirmation")
    check(
      rejected { _ = try pickup.make(actor: worker, action: "device", label: "门店屏") },
      "paused admission cannot authorize new device")
    check(
      try pickup.make(actor: worker, action: "device", label: "门店屏", enabled: false).steps[0]
        .object["enabled"] as? Bool == false,
      "existing device can be disabled while admission paused")
    let preserved = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(take))
    check(
      preserved.steps[0] == take.steps[0], "pickup recovery proof and original body survive restart"
    )
    let oldStep = try JSONDecoder().decode(
      LiveCommand.Step.self,
      from: encode([
        "path": "/api/example", "body": Data("{}".utf8).base64EncodedString(),
        "keyHeader": "idempotency-key", "key": "old",
      ]))
    check(oldStep.recoveryBody == nil, "previous persisted steps remain readable")
    var rawKitchen =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-kitchen.json"))) as! [String: Any]
    rawKitchen["canHandoff"] = true
    let handoffBoard = try JSONDecoder().decode(LiveKitchen.self, from: encode(rawKitchen))
    let preview = try JSONDecoder().decode(
      LiveKitchenHandoff.self, from: Data(contentsOf: dir.appending(path: "live-handoff.json")))
    check(
      rejected {
        _ = try preview.command(
          actor: worker, board: handoffBoard, reason: "交班接管", physicalChecked: false)
      }, "handoff requires physical scope verification")
    let handoff = try preview.command(
      actor: worker, board: handoffBoard, reason: "交班接管", physicalChecked: true)
    let handoffBody = handoff.steps[0].object["command"] as! [String: Any]
    check(
      (handoffBody["expectedTasks"] as! [[String: Any]])[0]["expectedEmployeeId"] is NSNull,
      "unassigned task remains explicit null in handoff scope")
    check(
      rejected {
        _ = try preview.command(
          actor: auth, board: handoffBoard, reason: "交班接管", physicalChecked: true)
      }, "handoff needs management permission")
    response = try encode(["data": ["batchId":"batch1", "action":"handoff", "quantity":0, "released":false, "affectedBatchIds":["batch1"], "ownershipVersions":["batch1":5]], "replayed":true])
    try await api.execute(handoff.steps[0])
    check(true, "handoff acknowledges entire affected scope and incremented ownership version")
    response = try encode(["data": ["batchId":"batch1", "action":"handoff", "quantity":0, "released":false, "affectedBatchIds":["batch1"], "ownershipVersions":["batch1":4]], "replayed":true])
    do { try await api.execute(handoff.steps[0]); preconditionFailure() } catch {}
    check(true, "unchanged ownership version cannot acknowledge handoff")
    response = try encode(["data": ["batchId":"batch1", "action":"ready", "quantity":2, "released":false], "replayed":true])
    do { try await api.execute(ready.steps[0]); preconditionFailure() } catch {}
    check(true, "wrong production quantity cannot acknowledge command")
    let rawPickup =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-pickup.json"))) as! [String: Any]
    let pickupReceipt = (rawPickup["history"] as! [[String: Any]])[0]
    var pickupReply = try encode(["data": rawAuth])
    var pickupRequests: [URLRequest] = []
    let pickupAPI = StaffAPI(transport: { req in
      pickupRequests.append(req)
      return (
        pickupReply,
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    })
    _ = try await pickupAPI.login(code: "staff", pin: "1234", switching: false)
    pickupReply = try encode(["data": ["receipt": pickupReceipt, "revision": 8, "replayed": false]])
    try await pickupAPI.execute(take.steps[0])
    check(
      pickupRequests.last?.url?.path == "/api/commerce/pickup-board/commands",
      "same login sends original pickup command")
    var nextAuth = rawAuth
    var nextSession = nextAuth["session"] as! [String: Any]
    nextSession["id"] = "session-2"
    nextAuth["session"] = nextSession
    pickupReply = try encode(["data": nextAuth])
    _ = try await pickupAPI.login(code: "staff", pin: "1234", switching: false)
    pickupReply = try encode([
      "data": [
        "kind": "command", "data": ["receipt": pickupReceipt, "revision": 8, "replayed": true],
      ]
    ])
    try await pickupAPI.execute(take.steps[0])
    let recoveryRequest = pickupRequests.last!
    let recoveryBody =
      try JSONSerialization.jsonObject(with: recoveryRequest.httpBody!) as! [String: Any]
    check(
      recoveryRequest.url?.path == "/api/commerce/pickup-board/recovery"
        && recoveryBody["staffSessionId"] as? String == worker.session.id
        && recoveryBody["idempotencyKey"] as? String == take.steps[0].key,
      "new login recovers exact original device session and key")
    check(
      (recoveryBody["request"] as! [String: Any])["command"] as? NSDictionary == take.steps[0]
        .object as NSDictionary, "new login does not rewrite original pickup body")
    var wrong = pickupReceipt
    wrong["tableSessionId"] = "wrong"
    pickupReply = try encode([
      "data": ["kind": "command", "data": ["receipt": wrong, "revision": 8, "replayed": true]]
    ])
    do {
      try await pickupAPI.execute(take.steps[0])
      preconditionFailure()
    } catch {}
    check(true, "wrong table receipt cannot clear original pickup")
    check(
      !StaffAPIError(
        status: 409, code: "PICKUP_STALE", message: "unknown", commitDisposition: "unknown"
      ).definitivelyRejected, "unknown pickup commit disposition preserves request")
    check(
      StaffAPIError(
        status: 409, code: "PICKUP_STALE", message: "stale", commitDisposition: "not_committed"
      ).definitivelyRejected, "explicit uncommitted stale pickup can return to selection")

    let initialPath = try HistoryQuery().path()
    check(
      !initialPath.contains("businessDate"), "initial history date comes from server business clock"
    )
    let query = HistoryQuery(
      date: "2024-02-29", endDate: "2024-03-01", table: "A&employee=other+5", search: "少冰/桌")
    let historyPath = try query.path(page: 3)
    let queryItems = URLComponents(string: historyPath)!.queryItems!
    check(
      queryItems.first(where: { $0.name == "table" })?.value == query.table
        && queryItems.first(where: { $0.name == "page" })?.value == "3",
      "history filters encode literals without widening employee scope")
    check(
      rejected { _ = try HistoryQuery(date: "2025-02-29", endDate: "2025-03-01").path() },
      "invalid leap day rejected")
    check(
      rejected { _ = try HistoryQuery(date: "2026-09-27", endDate: "2026-09-26").path() },
      "reversed history date range rejected")
    check(
      rejected { _ = try HistoryQuery(date: "2024-01-01", endDate: "2026-01-01").path() },
      "history date range remains bounded")
    check(
      rejected { _ = try HistoryQuery(paymentStatus: "invented").path() },
      "unsupported payment filter rejected")
    let history = try JSONDecoder().decode(
      LiveHistory.self, from: Data(contentsOf: dir.appending(path: "live-history.json")))
    try history.validate(page: 0)
    check(
      history.orders[0].effectiveAmountMinor == 8000
        && history.orders[0].items[0].includedInBundle == true
        && history.financialSummaryVisible == false,
      "history retains effective amount bundle inclusion and financial visibility")
    check(
      rejected { try history.validate(page: 1) }, "wrong history page cannot replace selected page")
    let tableActor = try JSONDecoder().decode(StaffIdentity.self, from:encode(fixture["auth"]!))
    let openWithSeats = try LiveCommand.make(kind:"open",table:ops.tables[1],actor:tableActor,people:5,reason:"现场加椅，通道已核对")
    check(openWithSeats.steps[0].object["capacityOverrideReason"] as? String == "现场加椅，通道已核对", "over capacity opening retains explicit physical seating reason")
    check(rejected { _ = try LiveCommand.make(kind:"open",table:ops.tables[1],actor:tableActor,people:5) }, "over capacity opening without reason rejected")
    check(rejected { _ = try LiveCommand.make(kind:"open",table:ops.tables[1],actor:tableActor,people:201,reason:"现场加椅") }, "server maximum guest count enforced")
    let ordinaryOpen = try LiveCommand.make(kind:"open",table:ops.tables[1],actor:tableActor,people:2,reason:"上次加座说明")
    check(ordinaryOpen.steps[0].object["capacityOverrideReason"] == nil, "ordinary capacity omits stale override reason")
    var targetRaw = (fixture["operations"] as! [String:Any])["tables"] as! [[String:Any]]
    targetRaw[1]["capacity"] = 1
    let smallTarget = try JSONDecoder().decode(LiveOperations.Table.self, from:encode(targetRaw[1]))
    check(rejected { _ = try LiveCommand.make(kind:"transfer",table:ops.tables[0],actor:tableActor,target:smallTarget) }, "transfer to smaller table requires reason")
    let transferWithSeats = try LiveCommand.make(kind:"transfer",table:ops.tables[0],actor:tableActor,target:smallTarget,reason:"现场加椅并核对通道")
    check(transferWithSeats.steps[0].object["capacityOverrideReason"] as? String == "现场加椅并核对通道" && transferWithSeats.steps[0].object["expectedLocationVersion"] as? Int == 7, "over capacity transfer retains original location guard and reason")
    print("\(count) ordering checks passed")
  }
}
