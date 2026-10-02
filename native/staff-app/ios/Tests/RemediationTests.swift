import Foundation

@main struct RemediationTests {
  static func main() async throws {
    let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(
      "live-remediation.json")
    let f = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    func bytes(_ x: Any) throws -> Data {
      try JSONSerialization.data(withJSONObject: x, options: .sortedKeys)
    }
    func decode<T: Decodable>(_ type: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(type, from: bytes(x))
    }
    var count = 0
    func check(_ yes: Bool, _ title: String) {
      precondition(yes, title)
      count += 1
      print("PASS \(title)")
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    var oldAF = f["afterSales"] as! [String: Any]
    oldAF.removeValue(forKey: "supportsNativePhysicalRecovery")
    check(
      rejects {
        _ = try decode(LiveAfterSales.self, oldAF).remediationCommand(
          actor: actor, action: "request", quantity: 1, reason: "原实物补送", confirmed: true)
      }, "old server never receives unsafe native remedy")
    var oldQueue = f["fulfillment"] as! [String: Any]
    var oldActor = oldQueue["actor"] as! [String: Any]
    oldActor.removeValue(forKey: "supportsNativePhysicalRecovery")
    oldQueue["actor"] = oldActor
    check(
      rejects {
        _ = try decode(LiveFulfillment.self, oldQueue).command(
          identity: actor, taskID: "task-remake", action: "complete", quantity: 1, reason: "实际备齐",
          confirmed: true)
      }, "old server remains read-only for native production")

    let af = try decode(LiveAfterSales.self, f["afterSales"]!)
    var badAF = f["afterSales"] as! [String: Any]
    var badRows = badAF["redeliveries"] as! [[String: Any]]
    badRows[0]["pausedQuantity"] = 9
    badAF["redeliveries"] = badRows
    check(
      rejects { try decode(LiveAfterSales.self, badAF).validate(itemID: "item-original") },
      "invalid physical counts cannot enable action")
    check(
      StaffAPIError(
        status: 409, code: "NATIVE_PHYSICAL_NOT_COMMITTED", message: "未提交",
        commitDisposition: "not_committed"
      ).definitivelyRejected, "explicit rollback permits refresh and correction")
    check(
      !StaffAPIError(status: 409, code: "NATIVE_PHYSICAL_NOT_COMMITTED", message: "待确认")
        .definitivelyRejected, "missing rollback proof preserves unknown")

    try af.validate(itemID: "item-original")
    let request = try af.remediationCommand(
      actor: actor, action: "request", quantity: 2, reason: "原实物补送", confirmed: true)
    check(
      request.steps[0].object["originalGoodsAvailable"] as? Bool == true
        && request.steps[0].object["orderItemId"] as? String == "item-original",
      "redelivery preserves original physical goods")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "request", quantity: 1, reason: "原实物补送", confirmed: false)
      }, "no implicit physical confirmation")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "request", quantity: 3, reason: "原实物补送", confirmed: true)
      }, "redelivery caps available original units")
    let complete = try af.remediationCommand(
      actor: actor, action: "complete", target: "redelivery-1", quantity: 1, reason: "实际补送完成",
      confirmed: true)
    check(complete.permission == "kds.deliver", "actual delivery uses delivery permission")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "complete", target: "redelivery-1", quantity: 2, reason: "实际补送完成",
          confirmed: true)
      }, "held redelivery cannot be delivered")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "cancel", target: "other", reason: "客人取消补送", confirmed: true)
      }, "cannot cancel another original task")
    let cancel = try af.remediationCommand(
      actor: actor, action: "cancel", target: "redelivery-1", reason: "客人取消补送", confirmed: true)
    check(
      cancel.permission == "service.execute" && cancel.steps[0].object["quantity"] == nil,
      "cancel only remaining original service")
    let remake = try af.remediationCommand(
      actor: actor, action: "remake", target: "task-original", quantity: 1, reason: "实物损坏需重做",
      confirmed: true)
    check(
      remake.steps[0].object["originalGoodsLost"] as? Bool == true
        && remake.steps[0].object["reasonCode"] as? String == "production_remake",
      "remake explicit loss and new material generation")
    let successor = try af.remediationCommand(
      actor: actor, action: "remake", target: "task-remake", quantity: 2, reason: "新批实物损坏",
      confirmed: true)
    check(
      successor.steps[0].path.contains("task-remake/remake"),
      "successor targets actual physical generation")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "remake", target: "task-original", quantity: 2, reason: "实物损坏需重做",
          confirmed: true)
      }, "cannot remake excess original quantities")
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: actor, action: "remake", target: "task-remake", quantity: 1,
          reason: String(repeating: "字", count: 501), confirmed: true)
      }, "remake reason honors KDS maximum")
    var denied = f["auth"] as! [String: Any]
    denied["deniedPermissions"] = ["kds.exception.manage", "kds.deliver"]
    let limited = try decode(StaffIdentity.self, denied)
    check(
      rejects {
        _ = try af.remediationCommand(
          actor: limited, action: "remake", target: "task-original", quantity: 1, reason: "实物损坏需重做",
          confirmed: true)
      }, "explicit permission denial wins over server capability")
    var d: [String: Any] = [
      "id": "redelivery-1", "itemId": "item-original", "taskId": "service-1",
      "status": "in_progress", "selectedQuantity": 3, "pendingQuantity": 1, "pausedQuantity": 1,
      "deliveredQuantity": 2, "cancelledQuantity": 0,
      "units": [
        ["id": "u1", "outcome": "delivered"], ["id": "u2", "outcome": "delivered"],
        ["id": "u3", "outcome": NSNull()],
      ],
    ]
    try validateAfterSalesReply(bytes(["data": d, "replayed": true]), step: complete.steps[0])
    check(true, "partial delivery receipt accepted")
    for (key, value) in [
      ("itemId", "other" as Any), ("id", "other"), ("selectedQuantity", 2), ("pendingQuantity", 0),
    ] {
      var bad = d
      bad[key] = value
      check(
        rejects {
          try validateAfterSalesReply(
            bytes(["data": bad, "replayed": true]), step: complete.steps[0])
        }, "reject redelivery receipt mismatch \(key)")
    }
    check(
      rejects {
        try validateAfterSalesReply(bytes(["data": d, "replayed": true]), step: cancel.steps[0])
      }, "cancel cannot retain pending units")
    d = ["batchId": "batch-new", "taskId": "task-new", "itemId": "item-original", "quantity": 2]
    try validateAfterSalesReply(bytes(["data": d, "replayed": true]), step: successor.steps[0])
    check(true, "successor receipt names new physical batch")
    d["quantity"] = 1
    check(
      rejects {
        try validateAfterSalesReply(bytes(["data": d, "replayed": true]), step: successor.steps[0])
      }, "remake receipt quantity must match")
    var queue = f["fulfillment"] as! [String: Any]
    let board = try decode(LiveFulfillment.self, queue)
    try board.validate(employeeID: actor.employee.id)
    check(rejects { try board.validate(employeeID: "other") }, "queue bound to current employee")
    func make(_ board: LiveFulfillment, _ action: String, _ quantity: Int = 1) throws -> LiveCommand
    {
      try board.command(
        identity: actor, taskID: "task-remake", action: action, quantity: quantity,
        reason: "核对实际进度", confirmed: true)
    }
    let start = try make(board, "start")
    let ready = try make(board, "complete", 2)
    check(
      start.steps[0].object["quantity"] as? Int == 1
        && ready.steps[0].object["quantity"] as? Int == 2,
      "remake production uses actual eligible quantities")
    check(rejects { _ = try make(board, "start", 2) }, "cannot start more than unmade")
    check(rejects { _ = try make(board, "complete", 3) }, "cannot repeat already ready portion")
    check(rejects { _ = try make(board, "deliver") }, "shared pickup forbids direct delivery")
    check(rejects { _ = try make(board, "fail") }, "quantity-managed item cannot fail whole line")
    var rows = queue["workItems"] as! [[String: Any]]
    rows[0]["productionScreen"] = "kitchen"
    queue["workItems"] = rows
    check(
      rejects { _ = try make(decode(LiveFulfillment.self, queue), "complete") },
      "batch board completion cannot be bypassed")
    rows[0]["productionScreen"] = NSNull()
    rows[0]["quantities"] = NSNull()
    rows[0]["kdsStatus"] = "failed"
    rows[0]["canPrepare"] = false
    rows[0]["canRemake"] = true
    queue["workItems"] = rows
    let failed = try decode(LiveFulfillment.self, queue)
    let oldRemake = try make(failed, "remake")
    let stop = try make(failed, "manager-cancel")
    check(
      oldRemake.steps[0].object["quantity"] == nil
        && stop.steps[0].path.hasSuffix("manager-cancel"),
      "failed legacy task preserves original exception protocol")
    var receipt: [String: Any] = [
      "id": "task-remake", "orderId": "order-original", "orderItemId": "item-original",
      "stationCode": "kitchen", "normalizedStatus": "ready", "affectedQuantity": 2,
      "affectedUnitIds": ["new-unit-1", "new-unit-2"], "meta": ["replayed": true],
    ]
    try validateFulfillmentReply(bytes(receipt), step: ready.steps[0])
    check(true, "quantity receipt matches original task and physical units")
    receipt["affectedUnitIds"] = ["new-unit-1", "new-unit-1"]
    check(
      rejects { try validateFulfillmentReply(bytes(receipt), step: ready.steps[0]) },
      "duplicate physical units rejected")
    receipt = [
      "id": "new-task", "orderId": "order-original", "orderItemId": "item-original",
      "stationCode": "kitchen", "normalizedStatus": "pending", "remakeOf": "task-remake",
      "meta": ["replayed": true],
    ]
    try validateFulfillmentReply(bytes(receipt), step: oldRemake.steps[0])
    check(true, "legacy remake receipt binds failed source")
    receipt["remakeOf"] = "other"
    check(
      rejects { try validateFulfillmentReply(bytes(receipt), step: oldRemake.steps[0]) },
      "wrong remake source rejected")
    var disk = successor
    var calls: [LiveCommand.Step] = []
    do {
      _ = try await LiveCommandRunner.advance(
        disk,
        send: { step in
          calls.append(step)
          throw URLError(.timedOut)
        }, checkpoint: { disk = $0 })
    } catch {}
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(disk))
    _ = try await LiveCommandRunner.advance(
      restored, send: { calls.append($0) }, checkpoint: { disk = $0 })
    check(
      calls.count == 2 && calls[0] == calls[1] && disk.completedSteps == 1,
      "lost reply restart resends exact original key body and generation")
    _ = try await LiveCommandRunner.advance(
      disk, send: { _ in preconditionFailure("confirmed step resubmitted") }, checkpoint: { _ in })
    check(true, "read refresh recovery never resubmits confirmed action")
    print("\(count) remediation checks passed")
  }
}
