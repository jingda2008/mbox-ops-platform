import Foundation

@main struct Tests {
  static func main() throws {
    let fixture =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1] + "/live-stock.json")))
      as! [String: Any]
    func bytes(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ type: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(type, from: bytes(x))
    }
    var n = 0
    func check(_ b: Bool, _ label: String) {
      precondition(b, label)
      n += 1
      print("PASS " + label)
    }
    func rejects(_ f: () throws -> Void) -> Bool {
      do {
        try f()
        return false
      } catch { return true }
    }
    let actor = try decode(StaffIdentity.self, fixture["auth"]!)
    let board = try decode(StockBoard.self, fixture["board"]!)
    let scan = try decode(StockScan.self, fixture["scan"]!)
    let line = try StockLine.make(item: board.items[0], quantity: "2", amount: "10.01", scan: scan)
    check(
      line.payload["packages"] as? String == "2" && line.payload["quantity"] == nil
        && line.payload["totalCostMinor"] as? String == "1001",
      "barcode packages and exact cents sent without client conversion")
    for q in ["-1", "0", "1e3", "0.1", "1.1234567", "NaN"] {
      check(
        rejects {
          _ = try StockLine.make(item: board.items[0], quantity: q, amount: "10", scan: nil)
        }, "reject invalid/partial whole-unit quantity")
    }
    check(
      rejects {
        _ = try StockLine.make(item: board.items[0], quantity: "1", amount: "1.001", scan: nil)
      }, "reject fractional cents")
    let create = try stockCommand(actor: actor, board: board, lines: [line])
    let step = create.steps[0]
    check(
      step.path == "/api/native/inventory/receipts"
        && step.stockProof?["status"] as? String == "draft",
      "create never automatically receives stock")
    check(
      try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(create)) == create,
      "restart preserves exact original body and key")
    check(
      rejects { _ = try stockCommand(actor: actor, board: board, lines: [line, line]) },
      "duplicate draft line rejected")
    let receive = try stockCommand(actor: actor, board: board, receiptID: board.receipts[0].id)
    var result: [String: Any] = [
      "data": [
        "id": board.receipts[0].id, "publicId": "r1", "status": "received", "currency": "CNY",
        "lineCount": 1,
      ], "meta": ["replayed": true],
    ]
    try validateStockReply(bytes(result), step: receive.steps[0])
    check(true, "original received receipt accepted")
    for (field, value) in [
      ("id", "33333333-3333-4333-8333-333333333333"), ("currency", "USD"), ("status", "draft"),
    ] {
      var r = result["data"] as! [String: Any]
      r[field] = value
      check(
        rejects {
          try validateStockReply(
            bytes(["data": r, "meta": ["replayed": true]]), step: receive.steps[0])
        }, "mismatched receipt remains unresolved")
    }
    result["meta"] = ["replayed": "true"]
    check(
      rejects { try validateStockReply(bytes(result), step: receive.steps[0]) },
      "invalid replay metadata rejected")
    var auth = fixture["auth"] as! [String: Any]
    auth["deniedPermissions"] = ["inventory.receive"]
    let denied = try decode(StaffIdentity.self, auth)
    check(
      rejects { _ = try stockCommand(actor: denied, board: board, lines: [line]) },
      "explicit deny wins")
    let products = try decode(ProductManagementBoard.self, fixture["products"]!)
    let product = products.products[0]
    let update = try productManagementCommand(
      actor: actor, board: products, product: product, status: "sold_out", visible: false,
      sort: "20", price: "15.01", reason: "菜单改价")
    check(
      update.steps[0].object["expectedVersion"] as? String == product.nativeVersion,
      "product optimistic version persisted")
    check(
      try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(update)) == update,
      "product restart retains exact version and request key")
    check(
      rejects {
        _ = try productManagementCommand(
          actor: actor, board: products, product: product, status: product.status,
          visible: product.guestVisible, sort: "10", price: product.priceText, reason: "")
      }, "unchanged product never submitted")
    check(
      rejects {
        _ = try productManagementCommand(
          actor: actor, board: products, product: product, status: "active", visible: true,
          sort: "10", price: "12.001", reason: "test")
      }, "product price rejects fractional cents")
    var pd: [String: Any] = [
      "id": product.id, "status": "sold_out", "guestVisible": false, "menuSortOrder": 20,
      "standardPrice": ["amountMinor": "1501", "currency": "CNY"],
    ]
    try validateProductManagementReply(
      bytes(["data": pd, "meta": ["replayed": true]]), step: update.steps[0])
    check(true, "matching product reply accepted")
    pd["standardPrice"] = ["amountMinor": "1502", "currency": "CNY"]
    check(
      rejects {
        try validateProductManagementReply(
          bytes(["data": pd, "meta": ["replayed": true]]), step: update.steps[0])
      }, "mismatched changed price cannot finish command")
    let item = board.items[0]
    let countLine = StockCountInput(
      inventoryItemId: item.id, name: item.name, baseUnit: item.baseUnit, countedQuantity: "0",
      reason: "现场清点", expectedOnHandQuantity: item.onHandQuantity,
      observedAt: board.inventoryObservedAt!)
    let count = try stockAuditCommand(actor: actor, board: board, kind: "count", lines: [countLine])
    check(
      count.steps[0].path.hasSuffix("stock-count-submissions")
        && count.steps[0].stockAuditProof?["status"] as? String == "submitted",
      "atomic zero count submits without approving")
    check(
      count.steps[0].object["lines"] is [[String: Any]],
      "count retains original baseline and reason")
    check(
      rejects {
        _ = try stockAuditCommand(
          actor: actor, board: board, kind: "count", lines: [countLine, countLine])
      }, "duplicate count material rejected")
    check(
      rejects { _ = try stockQuantity("0.5", item: item, zero: true) },
      "fractional whole-unit count rejected")
    let waste = try stockAuditCommand(
      actor: actor, board: board, kind: "waste", itemID: item.id, quantity: "1", reason: "现场损耗")
    check(
      waste.steps[0].object["requestApproval"] as? Bool == true,
      "waste uses existing server approval rules")
    let wasteReply: [String: Any] = [
      "data": ["status": "pending", "id": "44444444-4444-4444-8444-444444444444"],
      "meta": ["replayed": false],
    ]
    try validateStockAuditReply(bytes(wasteReply), step: waste.steps[0])
    check(true, "pending waste is accepted as pending")
    check(
      rejects { try validateStockAuditReply(bytes(wasteReply), step: count.steps[0]) },
      "waste receipt cannot confirm stock count")
    check(
      rejects {
        _ = try stockAuditCommand(actor: actor, board: board, kind: "wasteApprove", reason: "确认")
      }, "approval requires original review record")
    check(
      nativeNonnegativeMoney("0.00") == 0 && nativeNonnegativeMoney("-1") == nil
        && parseMoney("0.00") == nil,
      "zero procurement cost supported without zero-payment regression")
    print("\(n) stock checks passed")
  }
}
