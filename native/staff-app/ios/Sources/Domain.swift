import Foundation

struct StaffTable: Codable, Identifiable, Equatable {
  var id: String
  var code: String
  var capacity: Int
  var people: Int = 0
  var session: String? = nil
  var total: Int? = 0
  var paid: Int? = 0
  var unknown: Bool = false
  var service: Bool = false
  var openedAt: Date? = nil
  var due: Int? {
    guard let total, let paid else { return nil }
    return max(0, total - paid)
  }
  var status: String {
    session == nil
      ? "空闲"
      : unknown
        ? "款项确认中" : due == nil ? "账单待核对" : total == 0 ? "已开台 · 未点单" : due == 0 ? "已结清 · 在座" : "待收款"
  }
}
struct Product: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var category: String
  var price: Int
  var available: Bool = true
  var choices: [String] = ["标准"]
}
struct Line: Codable, Identifiable, Equatable {
  var productID: String
  var name: String
  var price: Int
  var quantity: Int
  var variant: String
  var id: String { productID + ":" + variant }
  var amount: Int { price * quantity }
}
struct StaffOrder: Codable, Identifiable, Equatable {
  var id: String
  var session: String
  var tableCode: String
  var lines: [Line]
  var delivered: Bool = false
  var createdAt: Date = Date()
  var amount: Int { lines.reduce(0) { $0 + $1.amount } }
}
struct Receipt: Codable, Equatable {
  var requestID: String
  var session: String
  var kind: String
  var applied: Int = 0
  var given: Int = 0
  var change: Int { max(0, given - applied) }
}
struct Command: Codable, Equatable {
  var id: String = UUID().uuidString
  var kind: String
  var tableID: String
  var expectedSession: String?
  var people: Int = 0
  var targetID: String? = nil
  var lines: [Line] = []
  var given: Int = 0
  var orderID: String? = nil
}
struct JournalEntry: Codable, Equatable {
  var command: Command
  var receipt: Receipt
}
enum RuleError: Error, LocalizedError {
  case rule(String)
  var errorDescription: String? {
    switch self {
    case .rule(let text): return text
    }
  }
}
struct World: Codable, Equatable {
  var tables: [StaffTable]
  var products: [Product]
  var orders: [StaffOrder] = []
  var journal: [String: JournalEntry] = [:]
  var drafts: [String: [Line]] = [:]

  static func training() -> World {
    World(
      tables: [
        StaffTable(
          id: "a5", code: "A5", capacity: 4, people: 4, session: "training-a5", total: 36800,
          paid: 10000, service: true, openedAt: Date().addingTimeInterval(-4320)),
        StaffTable(
          id: "a6", code: "A6", capacity: 4, people: 3, session: "training-a6", total: 22800,
          paid: 22800, openedAt: Date().addingTimeInterval(-2880)),
        StaffTable(
          id: "b2", code: "B2", capacity: 4, people: 2, session: "training-b2", total: 15600,
          paid: 0, unknown: true, openedAt: Date().addingTimeInterval(-2100)),
        StaffTable(
          id: "b3", code: "B3", capacity: 4, people: 2, session: "training-b3", total: 12800,
          paid: 0, openedAt: Date().addingTimeInterval(-1320)),
        StaffTable(id: "a8", code: "A8", capacity: 4),
        StaffTable(id: "a9", code: "A9", capacity: 6),
      ],
      products: [
        Product(
          id: "set", name: "经典双人套餐", category: "套餐", price: 8800, choices: ["标准搭配", "无酒精搭配"]),
        Product(
          id: "water", name: "鲜柠气泡水", category: "饮品", price: 2800, choices: ["正常冰", "少冰", "去冰"]),
        Product(id: "fries", name: "薯条拼盘", category: "小食", price: 3800),
        Product(id: "beer", name: "单杯精酿", category: "酒水", price: 3800),
        Product(id: "sold", name: "当日甜品", category: "小食", price: 3200, available: false),
      ])
  }
  func orderedTables(query: String = "", filter: String = "全部") -> [StaffTable] {
    let key = query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    return tables.filter {
      (key.isEmpty || $0.code.uppercased().contains(key))
        && (filter == "全部" || (filter == "营业中" ? $0.session != nil : $0.session == nil))
    }
    .sorted {
      let leftExact = !key.isEmpty && $0.code.uppercased() == key
      let rightExact = !key.isEmpty && $1.code.uppercased() == key
      if leftExact != rightExact { return leftExact }
      return ($0.session != nil) != ($1.session != nil)
        ? $0.session != nil : $0.code.localizedStandardCompare($1.code) == .orderedAscending
    }
  }
  mutating func apply(_ command: Command) throws -> Receipt {
    if let prior = journal[command.id] {
      guard prior.command == command else { throw RuleError.rule("同一请求不能更换内容，请核对原操作") }
      return prior.receipt
    }
    guard let index = tables.firstIndex(where: { $0.id == command.tableID }) else {
      throw RuleError.rule("桌台不存在")
    }
    var table = tables[index]
    guard table.session == command.expectedSession else {
      throw RuleError.rule("桌次已变化，请返回刷新；已保留原草稿")
    }
    var receipt = Receipt(requestID: command.id, session: table.session ?? "", kind: command.kind)
    switch command.kind {
    case "open":
      guard table.session == nil, command.people > 0, command.people <= table.capacity else {
        throw RuleError.rule("请核对桌台状态与人数")
      }
      table.session = "training-" + command.id
      table.people = command.people
      table.total = 0
      table.paid = 0
      table.unknown = false
      table.service = false
      table.openedAt = Date()
      receipt.session = table.session!
    case "order":
      guard let session = table.session, !command.lines.isEmpty else {
        throw RuleError.rule("请先开台并选择商品")
      }
      guard Set(command.lines.map(\.id)).count == command.lines.count else {
        throw RuleError.rule("商品行重复，请重新核对")
      }
      var amount = 0
      for line in command.lines {
        guard let p = products.first(where: { $0.id == line.productID }), p.available,
          p.price == line.price, p.name == line.name, p.choices.contains(line.variant),
          line.quantity > 0, line.quantity <= 99
        else { throw RuleError.rule("商品或规格已变化，请重新核对") }
        amount += line.amount
      }
      guard amount > 0, amount <= 100_000_000, let total = table.total else {
        throw RuleError.rule("金额无法确认，请核对账单")
      }
      table.total = total + amount
      orders.append(
        StaffOrder(id: command.id, session: session, tableCode: table.code, lines: command.lines))
      drafts.removeValue(forKey: session)
    case "cash":
      guard table.session != nil, !table.unknown, let due = table.due, let paid = table.paid,
        due > 0, command.given > 0, command.given <= 100_000_000
      else { throw RuleError.rule("金额或原款状态不允许收款，请先核对") }
      receipt.applied = min(command.given, due)
      receipt.given = command.given
      table.paid = paid + receipt.applied
    case "service":
      guard table.session != nil, table.service else { throw RuleError.rule("服务任务已变化") }
      table.service = false
    case "deliver":
      guard
        let order = orders.firstIndex(where: {
          $0.id == command.orderID && $0.session == table.session
        })
      else { throw RuleError.rule("订单不属于当前桌次") }
      orders[order].delivered = true
    case "close":
      guard let session = table.session, table.due == 0, !table.unknown, !table.service,
        !orders.contains(where: { $0.session == session && !$0.delivered })
      else { throw RuleError.rule("请先处理未结款项、待送商品和服务任务") }
      table.people = 0
      table.session = nil
      table.total = 0
      table.paid = 0
      table.openedAt = nil
      drafts.removeValue(forKey: session)
    case "transfer":
      guard let session = table.session,
        let target = tables.firstIndex(where: { $0.id == command.targetID }), target != index,
        tables[target].session == nil, tables[target].capacity >= table.people
      else { throw RuleError.rule("目标桌不可用或容量不足") }
      let destination = tables[target]
      table.id = destination.id
      table.code = destination.code
      table.capacity = destination.capacity
      tables[target] = table
      table = StaffTable(
        id: tables[index].id, code: tables[index].code, capacity: tables[index].capacity)
      for i in orders.indices where orders[i].session == session {
        orders[i].tableCode = destination.code
      }
    default: throw RuleError.rule("不支持的操作")
    }
    tables[index] = table
    journal[command.id] = JournalEntry(command: command, receipt: receipt)
    return receipt
  }
}
func parseMoney(_ text: String) -> Int? {
  guard text.range(of: #"^[0-9]{1,6}(\.[0-9]{1,2})?$"#, options: .regularExpression) != nil else {
    return nil
  }
  let pieces = text.split(separator: ".")
  guard let whole = Int(pieces[0]) else { return nil }
  let cents =
    pieces.count == 2
    ? Int(String(pieces[1]).padding(toLength: 2, withPad: "0", startingAt: 0))! : 0
  let result = whole * 100 + cents
  return result > 0 ? result : nil
}
func money(_ value: Int?) -> String {
  guard let value else { return "待核对" }
  return value % 100 == 0 ? "¥\(value/100)" : String(format: "¥%d.%02d", value / 100, value % 100)
}
