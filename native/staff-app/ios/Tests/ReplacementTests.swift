import Foundation

@main struct ReplacementTests {
  static func main() async throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    func bytes(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ t: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(t, from: bytes(x))
    }
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-replacement.json"))) as! [String: Any]
    let raw = f["afterSales"] as! [String: Any]
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let board = try decode(LiveAfterSales.self, raw)
    let source = try LiveReplacement.make(board: board, caseID: "case-original", actor: actor)
    var count = 0
    func check(_ yes: Bool, _ label: String) {
      precondition(yes, label)
      count += 1
      print("PASS " + label)
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    func changed(_ transform: (inout [String: Any], inout [String: Any]) -> Void) throws
      -> LiveAfterSales
    {
      var copy = raw
      var row = (raw["cases"] as! [[String: Any]])[0]
      transform(&copy, &row)
      copy["cases"] = [row]
      return try decode(LiveAfterSales.self, copy)
    }
    let menu =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-catalog.json"))) as! [String: Any]
    let product = try decode(LiveProduct.self, menu["product"]!)
    let line = try LiveDraftLine(product: product, choices: ["g1": ["p1"]], note: "少冰")
    let access = LiveOrderAccess(employeeId: actor.employee.id, canCreateOrder: true, gift: nil)
    let context = LiveOrderContext(
      token: "context", employeeId: actor.employee.id, staffSessionId: actor.session.id,
      tableSessionId: source.session, expiresAt: "2099-01-01T00:00:00Z")
    func make(
      _ replacement: LiveReplacement? = nil, _ current: LiveAfterSales? = nil, gift: Bool = false
    ) throws -> LiveOrderSubmission {
      try LiveOrderSubmission.make(
        lines: [line], products: [product], identity: actor, access: access, context: context,
        session: source.session, tableCode: source.tableCode, gift: gift, reason: "换品核对", note: "",
        settlement: "table_tab", replacement: replacement, source: current)
    }
    let order = try make(source, board)
    try order.validate()
    check(
      order.object["replacementCaseId"] as? String == source.caseID
        && order.object["replacementPreviousOrderId"] == nil, "new order binds exact original case")
    check(
      order.object["orderMode"] as? String == "paid" && order.object["amountMinor"] == nil
        && order.object["refundAmountMinor"] == nil,
      "normal server pricing without client refund deduction")
    check(
      rejects { _ = try make(source, board, gift: true) },
      "replacement cannot silently become a gift")
    check(rejects { _ = try make(source) }, "submission requires a fresh source read")
    for flag in ["canReplace"] {
      let stale = try changed { _, row in row[flag] = false }
      check(
        rejects { try source.validate(board: stale, actor: actor) },
        "server permission withdrawal blocks submission")
    }
    let revised = try changed { _, row in row["revisedByCaseId"] = "another-case" }
    check(
      rejects { try source.validate(board: revised, actor: actor) },
      "revised original case requires reopening")
    let withdrawn = try changed { _, row in row["status"] = "withdrawn" }
    check(
      rejects { try source.validate(board: withdrawn, actor: actor) },
      "withdrawn source blocked even with stale capability")
    let empty = try changed { _, row in
      row["heldQuantity"] = 0
      row["stoppedQuantity"] = 0
    }
    check(
      rejects { try source.validate(board: empty, actor: actor) },
      "no held or stopped portions blocks replacement")
    let old = try changed { b, _ in b.removeValue(forKey: "supportsNativeReplacementRecovery") }
    check(
      rejects { try source.validate(board: old, actor: actor) },
      "old backend cannot enable unrecoverable replacement")
    let moved = try changed { b, _ in
      var item = b["item"] as! [String: Any]
      item["tableSessionId"] = "another-visit"
      b["item"] = item
    }
    check(
      rejects { try source.validate(board: moved, actor: actor) },
      "changed visit blocks captured source")
    var auth = f["auth"] as! [String: Any]
    auth["deniedPermissions"] = ["refund.request"]
    let denied = try decode(StaffIdentity.self, auth)
    check(
      rejects { try source.validate(board: board, actor: denied) },
      "explicit denial overrides visible replacement button")
    let existing: [String: Any] = [
      "orderId": "new-1", "publicId": "APP-FIRST", "status": "submitted",
      "sourceCaseId": source.caseID,
    ]
    let occupied = try changed { _, row in row["replacementOrder"] = existing }
    check(
      rejects { try source.validate(board: occupied, actor: actor) },
      "another staff replacement prevents another order")
    var cancelled = existing
    cancelled["status"] = "cancelled"
    let againBoard = try changed { _, row in row["replacementOrder"] = cancelled }
    let again = try LiveReplacement.make(board: againBoard, caseID: source.caseID, actor: actor)
    let second = try make(again, againBoard)
    check(
      second.object["replacementPreviousOrderId"] as? String == "new-1",
      "explicit cancelled predecessor retained")
    check(
      rejects { try source.validate(board: againBoard, actor: actor) },
      "old draft cannot adopt a different replacement generation")
    var book = LiveDraftBook()
    try book.add(line, employee: actor.employee.id, session: source.session)
    let replacementLine = try LiveDraftLine(product: product, choices: ["g1": ["p1"]], note: "少冰")
    try book.add(replacementLine, employee: actor.employee.id, session: source.draftSession)
    check(
      book.entries.count == 2 && source.draftSession != again.draftSession,
      "ordinary and each replacement generation have separate drafts")
    let restored = try JSONDecoder().decode(
      LiveOrderSubmission.self, from: JSONEncoder().encode(order))
    try restored.validate()
    check(
      restored.body == order.body && restored.key == order.key && restored.replacement == source
        && restored.draftSession == source.draftSession,
      "restart retains exact source request and draft namespace")
    var corrupt = order
    corrupt.replacement = again
    check(rejects { try corrupt.validate() }, "mismatched persisted predecessor cannot be sent")
    let ordinary = try make()
    var legacy =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(ordinary)) as! [String: Any]
    legacy.removeValue(forKey: "replacement")
    let oldOrder = try decode(LiveOrderSubmission.self, legacy)
    try oldOrder.validate()
    check(
      oldOrder.draftSession == source.session, "previous ordinary pending requests still decode")
    var receiptLink = existing
    receiptLink["publicId"] = order.publicId
    let recoveredBoard = try changed { b, row in
      // A newer replacement is now the visible link; recover the previous cancelled one.
      row["replacementOrder"] = existing
      var oldLink = receiptLink
      oldLink["status"] = "cancelled"
      b["replacementOrders"] = [
        oldLink,
        [
          "orderId": "new-2", "publicId": "APP-NEWER", "status": "submitted",
          "sourceCaseId": source.caseID,
        ],
      ]
    }
    let recovered = try source.recoveredReceipt(board: recoveredBoard, publicID: order.publicId)
    check(
      recovered?.id == "new-1" && recovered?.recovered == true,
      "cancelled superseded original order still recovers by immutable history")
    check(
      try source.recoveredReceipt(board: recoveredBoard, publicID: "absent") == nil,
      "another staff new order is not proof of this submission")
    check(
      rejects {
        _ = try source.recoveredReceipt(
          board: recoveredBoard, publicID: order.publicId, orderID: "wrong-id")
      }, "order ID mismatch preserves pending")
    let wrongCase = try changed { b, _ in
      var x = receiptLink
      x["sourceCaseId"] = "other-case"
      b["replacementOrders"] = [x]
    }
    check(
      rejects { _ = try source.recoveredReceipt(board: wrongCase, publicID: order.publicId) },
      "original case mismatch preserves pending")
    let duplicate = try changed { b, _ in b["replacementOrders"] = [receiptLink, receiptLink] }
    check(
      rejects { _ = try source.recoveredReceipt(board: duplicate, publicID: order.publicId) },
      "duplicate recovery evidence rejected")
    check(
      !order.canReplay(actor, now: order.createdAt.addingTimeInterval(13 * 3600)),
      "expired context never triggers blind replacement resubmission")
    check(
      LiveOrderSubmission.initialRejection(
        StaffAPIError(status: 409, code: "QUANTITY_UNAVAILABLE", message: "")) == nil,
      "ambiguous source conflict keeps original request")
    var acknowledged = order
    acknowledged.receipt = LiveOrderReceipt(
      publicId: order.publicId, id: "new-1", totalAmountMinor: 19800, recovered: false)
    let checkpoint = try JSONDecoder().decode(
      LiveOrderSubmission.self, from: JSONEncoder().encode(acknowledged))
    check(
      checkpoint.receipt != nil && !checkpoint.canFinish,
      "secondary read failure preserves creation receipt without clearing draft")
    acknowledged.replacementVerified = true
    try acknowledged.validate()
    check(acknowledged.canFinish, "only verified source linkage allows replacement completion")
    var impossible = order
    impossible.replacementVerified = true
    check(
      rejects { try impossible.validate() }, "verification without creation receipt is rejected")
    print("\(count) replacement checks passed")
  }
}
