import Foundation

struct CashHandoverBoard: Decodable {
  struct Ledger: Decodable { let net, count: Int }
  struct Count: Decodable {
    let countedMinor, expectedMinor, differenceMinor, ledgerNet, ledgerCount: Int
    let employeeId, reason, submittedAt: String
    let denominations: [String: Int]
  }
  struct Row: Decodable, Identifiable {
    let id, businessDate, openedBy, openedAt, openingReason, status: String
    let openingMinor, movementMinor, expectedMinor, revision: Int
    let openingDifferenceMinor: Int?
    let count: Count?
    let closedBy, closedAt: String?
  }
  let businessDate: String
  let ledger: Ledger
  let handovers: [Row]
  let canCount, canManage: Bool
  var active: Row? { handovers.first { $0.status != "closed" } }
}
let cashDenominations = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 2, 1]
func cashCount(_ values: [String: Int]) throws -> Int {
  var total = 0
  for (key, q) in values {
    guard let d = Int(key), cashDenominations.contains(d), (0...99999).contains(q) else {
      throw CatalogError("面额或张数无效")
    }
    total += d * q
  }
  guard total <= 10_000_000_000 else { throw CatalogError("盘点金额超限") }
  return total
}
func cashHandoverCommand(
  actor: StaffIdentity, board: CashHandoverBoard, action: String, amount: Int? = nil,
  direction: String = "in", reference: String = "", reason: String,
  denominations: [String: Int] = [:]
) throws -> LiveCommand {
  let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  let manager = ["movement", "approve"].contains(action)
  let permission =
    manager
    ? "reconciliation.manage"
    : actor.allows("payment.manual.cash.record")
      ? "payment.manual.cash.record" : "reconciliation.manage"
  guard actor.allows("reconciliation.view"), actor.allows(permission), board.canCount,
    !manager || board.canManage, (4...500).contains(note.utf16.count)
  else { throw CatalogError("请刷新交接权限并填写4—500字实际说明") }
  var b: [String: Any] = ["action": action, "reason": note]
  var expectedStatus = "open"
  var detail = ""
  if action == "open" {
    guard board.active == nil, let amount, (0...10_000_000_000).contains(amount) else {
      throw CatalogError("已有交接或备用金金额无效")
    }
    b["amountMinor"] = amount
    detail = "实点期初现金 \(money(amount))"
  } else {
    guard let row = board.active else { throw CatalogError("请先建立门店现金交接") }
    b["id"] = row.id
    b["expectedRevision"] = row.revision
    switch action {
    case "movement":
      guard row.status == "open", let amount, (1...10_000_000_000).contains(amount),
        ["in", "out"].contains(direction),
        (3...256).contains(reference.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw CatalogError("请核对实际取存款及独立凭证") }
      b["amountMinor"] = amount
      b["direction"] = direction
      b["reference"] = reference
      detail = "非营业\(direction=="in" ? "存入":"取出") \(money(amount))\n凭证 \(reference)"
    case "count":
      guard row.status == "open" else { throw CatalogError("请先由原盘点人撤回再重新实点") }
      let counted = try cashCount(denominations)
      b["denominations"] = denominations
      expectedStatus = "count_submitted"
      detail =
        "实点 \(money(counted)) · 当前账面 \(money(row.expectedMinor))\n预计差异 \(money(counted-row.expectedMinor))，差异保留，不自动调平。"
    case "withdraw":
      guard row.status == "count_submitted", row.count?.employeeId == actor.employee.id else {
        throw CatalogError("只能由原盘点人撤回")
      }
      detail = "保留原盘点留痕，撤回后重新实点"
    case "approve":
      guard row.status == "count_submitted", let count = row.count,
        count.employeeId != actor.employee.id, amount == count.countedMinor,
        count.ledgerNet == board.ledger.net, count.ledgerCount == board.ledger.count
      else { throw CatalogError("须由另一人独立实点；收退款变化后原盘点人须撤回重盘") }
      b["reviewCountedMinor"] = amount
      expectedStatus = "closed"
      detail =
        "另一人独立实点 \(money(amount!))\n账面 \(money(count.expectedMinor)) · 差异 \(money(count.differenceMinor))\n确认接收并保留差异待查，不自动修改收退款。"
    default: throw CatalogError("未知交接操作")
    }
  }
  let id = UUID().uuidString.lowercased()
  let title = [
    "open": "建立现金交接", "movement": "登记非营业现金取存", "count": "提交现金盘点", "withdraw": "撤回并重新盘点",
    "approve": "双人确认现金交接",
  ][action]!
  var proof: [String: Any] = [
    "cashHandover": action, "status": expectedStatus,
    "revision": action == "open" ? 1 : board.active!.revision + 1,
    "confirmation": "范围：门店全部现金合计（所有收银点）\n\(detail)\n\(note)\n盘点与交接期间暂停现金收退；新收退款会要求重新盘点。",
  ]
  if let row = board.active { proof["id"] = row.id }
  if action == "open" { proof["openingMinor"] = amount }
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: permission,
    steps: [
      .init(
        path: "/api/commercial-ops/cash-handovers/commands",
        body: try JSONSerialization.data(withJSONObject: b, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-cash-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var cashHandoverProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["cashHandover"] is String
    else { return nil }
    return p
  }
}
func validateCashHandoverReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.cashHandoverProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], meta["protocol"] as? Int == 1,
    let d = root["data"] as? [String: Any], let id = d["id"] as? String,
    UUID(uuidString: id) != nil, d["status"] as? String == p["status"] as? String,
    d["revision"] as? Int == p["revision"] as? Int
  else { throw StaffAPIError.invalid }
  if let original = p["id"] as? String { guard id == original else { throw StaffAPIError.invalid } }
  if let amount = p["openingMinor"] as? Int {
    guard d["openingMinor"] as? Int == amount else { throw StaffAPIError.invalid }
  }
}
