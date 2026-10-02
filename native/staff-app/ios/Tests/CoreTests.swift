import Foundation

@main struct CoreTests {
  static func main() throws {
    var passed = 0
    func check(_ condition: Bool, _ label: String) {
      precondition(condition, label)
      passed += 1
      print("PASS \(label)")
    }
    func rejected(_ operation: () throws -> Void) -> Bool {
      do {
        try operation()
        return false
      } catch { return true }
    }
    check(parseMoney("0.01") == 1 && parseMoney("12.3") == 1230, "exact cents")
    check(
      ["0", "-1", "1.001", "1e3", "NaN", "1.１２"].allSatisfy { parseMoney($0) == nil },
      "reject malformed amounts")
    var w = World.training()
    check(w.orderedTables().prefix(4).allSatisfy { $0.session != nil }, "occupied before empty")
    check(w.orderedTables(query: "A5").map(\.code) == ["A5"], "exact table search")
    check(
      w.orderedTables(query: " a ").map(\.code) == ["A5", "A6", "A8", "A9"],
      "partial area search ignores case and edge whitespace")
    check(w.orderedTables(query: "5").map(\.code) == ["A5"], "partial numeric search")
    check(
      w.orderedTables(query: " a ", filter: "空闲").map(\.code) == ["A8", "A9"],
      "partial search respects empty filter")
    check(
      w.orderedTables(query: "a", filter: "营业中").map(\.code) == ["A5", "A6"],
      "partial search respects occupied filter")
    check(w.orderedTables(query: "  ") == w.orderedTables(), "blank search restores all tables")
    check(w.orderedTables(query: "368").isEmpty, "search table code only, never bill amount")
    var searchWorld = w
    searchWorld.tables += [
      StaffTable(id: "a50", code: "A50", capacity: 4),
      StaffTable(id: "ba5", code: "BA5", capacity: 4, session: "search-ba5"),
    ]
    check(
      searchWorld.orderedTables(query: "a5").map(\.code) == ["A5", "BA5", "A50"],
      "exact hit first then occupied partial hits")
    searchWorld.tables[0].session = nil
    check(
      searchWorld.orderedTables(query: "a5").map(\.code) == ["A5", "BA5", "A50"],
      "exact table wins while searching even if empty")
    check(searchWorld.orderedTables(query: "ZZ").isEmpty, "no matching table")
    check(w.tables[1].status == "已结清 · 在座", "paid remains occupied")
    check(
      rejected {
        _ = try w.apply(
          Command(kind: "cash", tableID: "b2", expectedSession: "training-b2", given: 15600))
      }, "unknown payment blocks another collection")
    let open = Command(kind: "open", tableID: "a8", expectedSession: nil, people: 2)
    let opened = try w.apply(open)
    check(w.tables[4].session == opened.session, "open table")
    let session = opened.session
    w.drafts[session] = [
      Line(productID: "water", name: "鲜柠气泡水", price: 2800, quantity: 2, variant: "少冰")
    ]
    let order = Command(
      kind: "order", tableID: "a8", expectedSession: session, lines: w.drafts[session]!)
    _ = try w.apply(order)
    check(
      w.tables[4].due == 5600 && w.drafts[session] == nil,
      "submit correct amount and clear scoped draft")
    _ = try w.apply(order)
    check(
      w.orders.count == 1 && w.tables[4].total == 5600,
      "same request replay does not duplicate order")
    var conflict = order
    conflict.lines[0].quantity = 3
    check(rejected { _ = try w.apply(conflict) }, "same key different payload rejected")
    let partial = Command(kind: "cash", tableID: "a8", expectedSession: session, given: 1000)
    _ = try w.apply(partial)
    check(w.tables[4].due == 4600, "partial cash collection")
    let cash = Command(kind: "cash", tableID: "a8", expectedSession: session, given: 5000)
    let receipt = try w.apply(cash)
    check(receipt.applied == 4600 && receipt.change == 400, "change excluded from received amount")
    _ = try w.apply(cash)
    check(w.tables[4].paid == 5600, "cash replay idempotent")
    check(
      rejected { _ = try w.apply(Command(kind: "close", tableID: "a8", expectedSession: session)) },
      "undelivered order blocks close")
    _ = try w.apply(
      Command(kind: "deliver", tableID: "a8", expectedSession: session, orderID: order.id))
    w.drafts[session] = [
      Line(productID: "beer", name: "单杯精酿", price: 3800, quantity: 1, variant: "标准")
    ]
    _ = try w.apply(
      Command(kind: "transfer", tableID: "a8", expectedSession: session, targetID: "a9"))
    check(
      w.tables[4].session == nil && w.tables[5].session == session && w.orders[0].tableCode == "A9"
        && w.drafts[session] != nil, "transfer preserves session orders and draft")
    _ = try w.apply(Command(kind: "close", tableID: "a9", expectedSession: session))
    check(
      w.tables[5].session == nil && w.drafts[session] == nil, "close releases table and old draft")
    check(
      rejected {
        _ = try w.apply(Command(kind: "cash", tableID: "a9", expectedSession: session, given: 1))
      }, "stale session blocked")
    let restored = try JSONDecoder().decode(World.self, from: JSONEncoder().encode(w))
    check(restored == w, "persistent journal roundtrip")
    var restart = restored
    let replay = try restart.apply(cash)
    check(
      replay == receipt && restart == restored,
      "recovery after restart does not repeat settled command")
    let bad = Command(
      kind: "order", tableID: "a5", expectedSession: "training-a5",
      lines: [Line(productID: "sold", name: "当日甜品", price: 3200, quantity: 1, variant: "标准")])
    let before = w
    check(rejected { _ = try w.apply(bad) } && w == before, "sold out order rejected atomically")
    print("\(passed) core checks passed")
  }
}
