import Foundation

func nativeNonnegativeMoney(_ text: String) -> Int? {
  if text.range(of: #"^0{1,6}(\.0{1,2})?$"#, options: .regularExpression) != nil { return 0 }
  return parseMoney(text)
}
struct StockBoard: Decodable {
  struct Item: Decodable, Identifiable {
    let id, sku, name, baseUnit, availableQuantity, onHandQuantity, reservedQuantity: String
    let lowStock, wholeUnitCount: Bool
    let lowStockThreshold: String?
  }
  struct Receipt: Decodable, Identifiable {
    struct Line: Decodable {
      let inventoryItemId, itemName, quantity, baseUnit: String
      let packageCount, totalCostMinor: String?
    }
    let id, publicId, status, currency, createdAt: String
    let lines: [Line]
    let lineCount: Int
    let invoiceTotalMinor: String?
  }
  struct Visibility: Decodable { let costs: Bool }
  let currentEmployeeId: String
  let inventoryObservedAt: String?
  let nativeCommands: Bool
  let items: [Item]
  let receipts: [Receipt]
  let visibility: Visibility
  static let permissions = [
    "inventory.view", "inventory.receive", "inventory.manage", "inventory.count",
    "inventory.count.approve", "inventory.waste", "inventory.cost.view",
  ]
}
struct StockScan: Decodable {
  let currentEmployeeId, code, inventoryItemId, packageQuantity: String
}
struct StockLine: Codable, Identifiable, Equatable {
  var id: String { inventoryItemID + ":" + (scanCode ?? "manual") }
  let inventoryItemID, name, unit, quantity: String
  let scanCode, packageQuantity: String?
  let totalCostMinor: Int
  var payload: [String: Any] {
    var p: [String: Any] = ["totalCostMinor": String(totalCostMinor)]
    if let scanCode {
      p["scanCode"] = scanCode
      p["packages"] = quantity
      p["expectedInventoryItemId"] = inventoryItemID
      p["expectedPackageQuantity"] = packageQuantity
    } else {
      p["inventoryItemId"] = inventoryItemID
      p["quantity"] = quantity
    }
    return p
  }
  var summary: String {
    name + " · " + quantity
      + (scanCode == nil ? unit : "包（每包" + (packageQuantity ?? "?") + unit + "）")
      + " · 本批金额 " + money(totalCostMinor)
  }
  static func make(item: StockBoard.Item, quantity: String, amount: String, scan: StockScan?) throws
    -> Self
  {
    let q = quantity.trimmingCharacters(in: .whitespacesAndNewlines)
    guard q.range(of: #"^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$"#, options: .regularExpression) != nil,
      let decimal = Decimal(string: q, locale: Locale(identifier: "en_US_POSIX")), decimal > 0,
      let amount = nativeNonnegativeMoney(amount), amount >= 0,
      scan == nil || scan?.inventoryItemId == item.id,
      !item.wholeUnitCount || scan != nil || !q.contains(".")
        || decimal == Decimal(NSDecimalNumber(decimal: decimal).intValue)
    else { throw CatalogError("请核对数量、整件单位、条码物料和本批总金额") }
    return Self(
      inventoryItemID: item.id, name: item.name, unit: item.baseUnit, quantity: q,
      scanCode: scan?.code, packageQuantity: scan?.packageQuantity, totalCostMinor: amount)
  }
}
struct StockSavedReceipt: Codable {
  let commandID, employeeID: String
  let bytes: Data
}
func stockCommand(
  actor: StaffIdentity, board: StockBoard, lines: [StockLine] = [], receiptID: String? = nil
) throws -> LiveCommand {
  guard board.nativeCommands, board.currentEmployeeId == actor.employee.id,
    actor.allows("inventory.receive")
  else {
    throw CatalogError("请刷新库存并核对收货权限及服务器支持")
  }
  let path: String
  let body: [String: Any]
  let title: String
  var proof: [String: Any] = ["employeeId": actor.employee.id, "currency": "CNY"]
  if let receiptID {
    guard let receipt = board.receipts.first(where: { $0.id == receiptID }),
      receipt.status == "draft", receipt.currency == "CNY"
    else { throw CatalogError("原采购单状态已变化，请刷新") }
    path = "/api/native/inventory/receipts/" + LiveCommand.pathPart(receiptID) + "/receive"
    body = [:]
    title = "确认实物已收货"
    proof["kind"] = "receive"
    proof["id"] = receiptID
    proof["status"] = "received"
    proof["lineCount"] = receipt.lineCount
    proof["confirmation"] =
      receipt.publicId + "\n"
      + receipt.lines.map { $0.itemName + " ×" + $0.quantity + $0.baseUnit }.joined(separator: "\n")
      + "\n确认以上实物已验收；本操作将正式入库，不自动修改商品上下架。"
  } else {
    guard !lines.isEmpty, lines.count <= 200, Set(lines.map(\.id)).count == lines.count,
      lines.allSatisfy({ line in board.items.contains { $0.id == line.inventoryItemID } })
    else { throw CatalogError("请添加1—200项有效物料；同物料同条码请合并数量") }
    for line in lines {
      guard (0...99_999_999).contains(line.totalCostMinor),
        let item = board.items.first(where: { $0.id == line.inventoryItemID })
      else { throw CatalogError("采购草稿金额或物料无效") }
      if line.scanCode == nil {
        _ = try stockQuantity(line.quantity, item: item, zero: false)
      } else {
        guard
          line.quantity.range(
            of: #"^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$"#, options: .regularExpression) != nil,
          let q = Decimal(string: line.quantity), q > 0
        else { throw CatalogError("包装数量无效") }
      }
    }
    let total = lines.reduce(0) { $0 + $1.totalCostMinor }
    guard total <= 1_000_000_000 else { throw CatalogError("本批金额过大，请重新核对") }
    path = "/api/native/inventory/receipts"
    title = "建立采购待验收单"
    body = [
      "currency": "CNY", "invoiceTotalMinor": String(total), "note": "原生App采购待实物验收",
      "lines": lines.map(\.payload),
    ]
    proof["kind"] = "create"
    proof["status"] = "draft"
    proof["lineCount"] = lines.count
    proof["draftFingerprint"] = try JSONEncoder().encode(lines).base64EncodedString()
    proof["confirmation"] =
      lines.map(\.summary).joined(separator: "\n") + "\n合计 " + money(total)
      + "\n这里只建立待验收单；核对服务器换算后的实际数量，再确认入库。"
  }
  let id = UUID().uuidString.lowercased()
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: "inventory.receive",
    steps: [
      .init(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-stock-" + id,
        recoveryBody: try JSONSerialization.data(
          withJSONObject: ["stock": proof], options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var stockProof: [String: Any]? {
    guard let recoveryBody,
      let p = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return p["stock"] as? [String: Any]
  }
}
func validateStockReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.stockProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    let id = data["id"] as? String, UUID(uuidString: id) != nil,
    !(data["publicId"] as? String ?? "").isEmpty,
    data["status"] as? String == p["status"] as? String,
    data["currency"] as? String == "CNY", data["lineCount"] as? Int == p["lineCount"] as? Int,
    p["id"] == nil || p["id"] as? String == id
  else { throw StaffAPIError.invalid }
}

struct StockCountPage: Decodable {
  struct Count: Decodable, Identifiable {
    struct Line: Decodable {
      let itemName, baseUnit, systemQuantity, countedQuantity, varianceQuantity,
        currentQuantity: String
      let stale: Bool
    }
    let id, publicId, status, createdByEmployeeId, createdByName: String
    let canReview: Bool
    let lines: [Line]
  }
  let currentEmployeeId: String
  let nativeCommands, hasMore, canApprove: Bool
  let page: Int
  let counts: [Count]
}
struct StockWastePage: Decodable {
  struct Entry: Decodable, Identifiable {
    let id, itemName, quantity, baseUnit, wasteType, reason, requestedByEmployeeId, requestedByName,
      status: String
    let canReview: Bool
  }
  let currentEmployeeId: String
  let nativeCommands, hasMore: Bool
  let page: Int
  let items: [Entry]
}
struct StockCountInput: Codable, Identifiable, Equatable {
  var id: String { inventoryItemId }
  let inventoryItemId, name, baseUnit, countedQuantity, reason, expectedOnHandQuantity,
    observedAt: String
  var payload: [String: Any] {
    [
      "inventoryItemId": inventoryItemId, "countedQuantity": countedQuantity, "reason": reason,
      "expectedOnHandQuantity": expectedOnHandQuantity, "observedAt": observedAt,
    ]
  }
}
func stockQuantity(_ raw: String, item: StockBoard.Item, zero: Bool) throws -> String {
  let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard q.range(of: #"^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$"#, options: .regularExpression) != nil,
    let d = Decimal(string: q, locale: Locale(identifier: "en_US_POSIX")), zero ? d >= 0 : d > 0,
    !item.wholeUnitCount || d == Decimal(NSDecimalNumber(decimal: d).intValue)
  else { throw CatalogError("请核对数量；整件物料不能录入小数") }
  return q
}
func stockAuditCommand(
  actor: StaffIdentity, board: StockBoard, kind: String, lines: [StockCountInput] = [],
  itemID: String? = nil, quantity: String = "", reason: String = "", wasteType: String = "other",
  count: StockCountPage.Count? = nil, waste: StockWastePage.Entry? = nil
) throws -> LiveCommand {
  guard board.nativeCommands, board.currentEmployeeId == actor.employee.id else {
    throw CatalogError("请刷新库存")
  }
  var body: [String: Any] = [:]
  var proof: [String: Any] = ["kind": kind]
  let path: String
  let permission: String
  let title: String
  let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  switch kind {
  case "count":
    permission = "inventory.count"
    title = "提交实物盘点"
    path = "/api/native/inventory/stock-count-submissions"
    guard !lines.isEmpty, lines.count <= 500, Set(lines.map(\.id)).count == lines.count else {
      throw CatalogError("请添加1—500项不重复物料")
    }
    for line in lines {
      guard let item = board.items.first(where: { $0.id == line.id }),
        !line.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        line.reason.count <= 500
      else { throw CatalogError("请核对盘点物料与原因") }
      _ = try stockQuantity(line.countedQuantity, item: item, zero: true)
    }
    proof["draftFingerprint"] = try JSONEncoder().encode(lines).base64EncodedString()
    body = ["lines": lines.map(\.payload), "note": "原生App实物盘点，待独立审核"]
    proof["status"] = "submitted"
    proof["confirmation"] =
      lines.map { $0.name + " 实点 " + $0.countedQuantity + $0.baseUnit }.joined(separator: "\n")
      + "\n提交后不立即改库存，需另一位有权员工审核。盘点期间请暂停这些物料的实物移动。"
  case "waste":
    permission = "inventory.waste"
    title = "提交物料报损"
    guard let item = board.items.first(where: { $0.id == itemID }), !note.isEmpty,
      note.count <= 500,
      [
        "mixing_failure", "discarded", "expired", "tasting", "complimentary", "count_difference",
        "other",
      ].contains(wasteType)
    else { throw CatalogError("请选择物料、类型并填写报损原因") }
    let q = try stockQuantity(quantity, item: item, zero: false)
    path = "/api/native/inventory/items/" + LiveCommand.pathPart(item.id) + "/waste"
    body = ["quantity": q, "reason": note, "wasteType": wasteType, "requestApproval": true]
    proof["confirmation"] =
      item.name + " 报损 " + q + item.baseUnit + "\n" + note + "\n后台按现有报损额度规则决定直接记账或进入独立审批；不会绕过原规则。"
  case "countApprove", "countReject":
    permission = "inventory.count.approve"
    title = kind == "countApprove" ? "批准盘点差异" : "驳回盘点"
    guard let count, count.canReview, count.createdByEmployeeId != actor.employee.id,
      count.status == "submitted",
      kind != "countApprove" || !count.lines.contains(where: { $0.stale })
    else { throw CatalogError("不可自审；库存已变化时需驳回旧单重新清点") }
    if kind == "countReject" {
      guard !note.isEmpty, note.count <= 1000 else { throw CatalogError("请填写驳回原因") }
      body = ["reason": note]
    }
    path =
      "/api/native/inventory/stock-counts/" + LiveCommand.pathPart(count.id)
      + (kind == "countApprove" ? "/approve" : "/reject")
    proof["id"] = count.id
    proof["status"] = kind == "countApprove" ? "approved" : "rejected"
    proof["confirmation"] =
      count.publicId + "\n"
      + count.lines.map {
        $0.itemName + " 账面 " + $0.systemQuantity + " / 实点 " + $0.countedQuantity + " / 差异 "
          + $0.varianceQuantity
      }.joined(separator: "\n") + "\n批准将按原盘点差异调整库存；后台再次核对并发出入库。"
  case "wasteApprove", "wasteReject":
    permission = "inventory.count.approve"
    title = kind == "wasteApprove" ? "批准报损" : "驳回报损"
    guard let waste, waste.canReview, waste.requestedByEmployeeId != actor.employee.id,
      waste.status == "pending", !note.isEmpty, note.count <= 500
    else { throw CatalogError("不可自审；请核对原申请并填写审核原因") }
    body = ["reason": note]
    path =
      "/api/native/inventory/waste-requests/" + LiveCommand.pathPart(waste.id)
      + (kind == "wasteApprove" ? "/approve" : "/reject")
    proof["id"] = waste.id
    proof["status"] = kind == "wasteApprove" ? "approved" : "rejected"
    proof["confirmation"] =
      waste.itemName + " ×" + waste.quantity + waste.baseUnit + "\n原原因：" + waste.reason + "\n审核意见："
      + note
  default: throw CatalogError("不支持的库存操作")
  }
  guard actor.allows(permission) else { throw CatalogError("当前岗位无操作权限") }
  let id = UUID().uuidString.lowercased()
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: permission,
    steps: [
      .init(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-stock-audit-" + id,
        recoveryBody: try JSONSerialization.data(
          withJSONObject: ["stockAudit": proof], options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var stockAuditProof: [String: Any]? {
    guard let recoveryBody,
      let p = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return p["stockAudit"] as? [String: Any]
  }
}
func validateStockAuditReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.stockAuditProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool
  else { throw StaffAPIError.invalid }
  if p["kind"] as? String == "waste" {
    guard let state = data["status"] as? String,
      (state == "pending" && UUID(uuidString: data["id"] as? String ?? "") != nil)
        || (state == "recorded" && UUID(uuidString: data["movementId"] as? String ?? "") != nil)
    else { throw StaffAPIError.invalid }
  } else {
    guard let id = data["id"] as? String, UUID(uuidString: id) != nil,
      p["id"] == nil || p["id"] as? String == id,
      data["status"] as? String == p["status"] as? String
    else { throw StaffAPIError.invalid }
  }
}
