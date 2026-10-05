import Foundation

let inventorySetupRoot = "/api/native/inventory"
let inventorySetupTypes = ["ingredient": "原料", "bottle": "酒水", "food": "食品", "packaging": "包装", "consumable": "耗材", "other": "其他"]
let inventorySetupUnits = ["ml": "毫升", "g": "克", "piece": "件", "bottle": "瓶（非酒水历史用途）", "portion": "份"]
func inventorySetupText(_ text: String, maximum: Int) throws -> String {
  let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !value.isEmpty, value.utf16.count <= maximum, value.rangeOfCharacter(from: .controlCharacters) == nil else { throw CatalogError("请核对必填名称、编号和条码，不能包含换行") }; return value
}
func inventorySetupDecimal(_ text: String, zero: Bool = true) throws -> String {
  let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard value.range(of: "^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?$", options: .regularExpression) != nil,
    let number = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")), zero ? number >= 0 : number > 0 else { throw CatalogError("数量须为有效非负数，用量及包装量须大于0，最多6位小数") }
  return value
}
func inventoryLiquidCategory(_ text: String) -> Bool {
  ["spirits", "wine", "mixer", "beer", "bottled_spirits", "alcohol"].contains { text == $0 || text.hasPrefix($0 + ".") }
}
struct InventorySetupBoard {
  let employeeID: String
  let enabled: Bool
  let items: [CatalogConfigurationRecord]
  init(data: Data, actor: StaffIdentity) throws {
    guard actor.allows("inventory.manage"), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let d = root["data"] as? [String: Any],
      d["currentEmployeeId"] as? String == actor.employee.id, try catalogConfigInt(d["nativeInventorySetupProtocol"]) == 1,
      let rows = d["items"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; enabled = true; items = try rows.map(CatalogConfigurationRecord.init)
    guard Set(items.map(\.id)).count == items.count, Set(items.map { $0.text("sku") }).count == items.count else { throw StaffAPIError.invalid }
    for item in items {
      guard UUID(uuidString: item.id) != nil, item.text("status") == "active", !item.text("updatedAt").isEmpty,
        inventorySetupTypes[item.text("itemType")] != nil, inventorySetupUnits[item.text("baseUnit")] != nil,
        item.object["barcodes"] is [[String: Any]] else { throw StaffAPIError.invalid }
      _ = try stockServerInstant(item.text("updatedAt"))
    }
  }
}
struct InventorySetupDraft {
  var kind = "create", sku = "", name = "", itemType = "ingredient", baseUnit = "g", category = "uncategorized"
  var lowStock = "", volume = "", waste = "0", wholeUnits = false
  var barcode = "", barcodeType = "barcode", packageQuantity = "1"
  init(kind: String = "create", item: CatalogConfigurationRecord? = nil) {
    self.kind = kind
    if let item {
      sku = item.text("sku"); name = item.text("name"); itemType = item.text("itemType"); baseUnit = item.text("baseUnit")
      category = item.text("categoryCode"); lowStock = item.text("lowStockThreshold"); volume = item.text("packageVolumeMl")
      waste = item.text("reasonableWasteQuantity"); wholeUnits = (try? catalogConfigBool(item.object["wholeUnitCount"])) == true
      if baseUnit == "ml" { packageQuantity = volume }
    }
  }
  func command(actor: StaffIdentity, board: InventorySetupBoard, item: CatalogConfigurationRecord?) throws -> LiveCommand {
    guard board.enabled, board.employeeID == actor.employee.id, actor.allows("inventory.manage"),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
      kind == "create" ? item == nil : item.map(board.items.contains) == true else { throw CatalogError("请重新读取原物料并核对管理权限") }
    var body: [String: Any] = [:], proof: [String: Any] = ["kind": kind, "employeeId": actor.employee.id]
    let path: String, title: String
    var detail: [String] = []
    if kind == "bind", let item {
      let code = try inventorySetupText(barcode, maximum: 128), quantity = try inventorySetupDecimal(packageQuantity, zero: false)
      guard ["barcode", "qr", "internal"].contains(barcodeType) else { throw CatalogError("请选择条码类型") }
      if item.text("baseUnit") == "ml" {
        let original = try inventorySetupDecimal(item.text("packageVolumeMl"), zero: false)
        guard Decimal(string: original) == Decimal(string: quantity) else { throw CatalogError("毫升物料每码包装量须等于已登记的每瓶净含量") }
      }
      for other in board.items {
        for existing in other.object["barcodes"] as? [[String: Any]] ?? [] where existing["code"] as? String == code {
          guard other.id == item.id, existing["codeType"] as? String == barcodeType,
            let q = existing["packageQuantity"] as? String, Decimal(string: q) == Decimal(string: quantity) else { throw CatalogError("此条码已绑定其他物料或包装量，请核对原绑定") }
        }
      }
      body = ["code": code, "codeType": barcodeType, "packageQuantity": quantity, "expectedUpdatedAt": item.text("updatedAt")]
      proof["itemId"] = item.id; path = inventorySetupRoot + "/items/" + item.id + "/barcodes"; title = "绑定包装条码"
      detail = [item.text("name") + " · " + item.text("sku"), "条码：" + code, "每码代表 " + quantity + " " + item.text("baseUnit"), "收货扫描按此包装量换算；不会修改旧收货单或替换冲突绑定。"]
    } else {
      guard kind == "create" || kind == "edit" else { throw StaffAPIError.invalid }
      let name = try inventorySetupText(name, maximum: 200), category = try inventorySetupText(category, maximum: 64)
      guard category.range(of: "^[a-z][a-z0-9_.-]{1,63}$", options: .regularExpression) != nil else { throw CatalogError("分类编码须为2—64位小写英文、数字或._-，首位为字母") }
      let threshold = lowStock.isEmpty ? nil : try inventorySetupDecimal(lowStock), volume = volume.isEmpty ? nil : try inventorySetupDecimal(volume, zero: false)
      let unit = item?.text("baseUnit") ?? baseUnit
      if inventoryLiquidCategory(category) {
        guard volume != nil, unit == "ml" || item.map({ inventoryLiquidCategory($0.text("categoryCode")) }) == true else { throw CatalogError("新酒水按毫升建库存，并填写每瓶净含量；历史物料须由原迁移流程处理") }
      }
      body = ["name": name, "categoryCode": category, "packageVolumeMl": volume as Any? ?? NSNull()]
      if let item {
        guard !inventoryLiquidCategory(item.text("categoryCode")) || unit == "ml" || inventoryLiquidCategory(category) else { throw CatalogError("历史酒水须保留酒水分类，不能借更名绕过毫升迁移") }
        body["expectedUpdatedAt"] = item.text("updatedAt"); body["lowStockThreshold"] = threshold as Any? ?? NSNull()
        proof["itemId"] = item.id; proof["sku"] = item.text("sku"); proof["baseUnit"] = unit; proof["itemType"] = item.text("itemType")
        path = inventorySetupRoot + "/items/" + item.id; title = "更新物料资料"
        detail = ["编号：" + item.text("sku") + " · 基础单位 " + unit + " 保留", "原名称：" + item.text("name") + " → " + name]
      } else {
        let sku = try inventorySetupText(sku, maximum: 64)
        guard inventorySetupTypes[itemType] != nil, inventorySetupUnits[unit] != nil, !board.items.contains(where: { $0.text("sku") == sku }) else { throw CatalogError("请选择有效类型与基础单位，物料编号不得重复") }
        body.merge(["sku": sku, "itemType": itemType, "baseUnit": unit, "wholeUnitCount": wholeUnits, "reasonableWasteQuantity": try inventorySetupDecimal(waste)]) { _, x in x }
        if let threshold { body["lowStockThreshold"] = threshold }
        path = inventorySetupRoot + "/items"; title = "新建库存物料"
        detail = ["编号：" + sku, "类型：" + inventorySetupTypes[itemType]! + " · 单位：" + unit, "初始库存为0，请通过采购收货入库。"]
      }
      detail += ["名称：" + name, "分类：" + category, "低库存提醒：" + (threshold ?? "不设置"), "每瓶净含量：" + (volume.map { $0 + " ml" } ?? "不设置"), "此操作不修改库存余额和历史订单。"]
    }
    proof["confirmation"] = ([title] + detail).joined(separator: "\n")
    let id = UUID().uuidString.lowercased()
    return LiveCommand(id: id, employeeID: actor.employee.id, title: title, permission: "inventory.manage",
      steps: [.init(path: path, body: try catalogConfigData(body), keyHeader: "idempotency-key", key: "native-inventory-setup-" + id, recoveryBody: try catalogConfigData(["inventorySetup": proof]))])
  }
}
extension LiveCommand.Step {
  var inventorySetupProof: [String: Any]? {
    guard let recoveryBody, let object = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any] else { return nil }; return object["inventorySetup"] as? [String: Any]
  }
}
func validInventorySetupSelection(_ command: LiveCommand, board: InventorySetupBoard) -> Bool {
  guard command.steps.count == 1, command.permission == "inventory.manage", board.employeeID == command.employeeID,
    board.enabled, let step = command.steps.first, let proof = step.inventorySetupProof else { return false }
  if proof["kind"] as? String == "create" { return step.path == inventorySetupRoot + "/items" && proof["itemId"] == nil }
  guard let id = proof["itemId"] as? String, let item = board.items.first(where: { $0.id == id }),
    step.object["expectedUpdatedAt"] as? String == item.text("updatedAt") else { return false }
  return step.path == inventorySetupRoot + "/items/" + id + (proof["kind"] as? String == "bind" ? "/barcodes" : "")
}
func validateInventorySetupReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let data = root["data"] as? [String: Any],
    let meta = root["meta"] as? [String: Any], let proof = step.inventorySetupProof,
    let id = data["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
  _ = try catalogConfigBool(meta["replayed"])
  let body = step.object
  if proof["kind"] as? String == "bind" {
    guard data["inventoryItemId"] as? String == proof["itemId"] as? String, data["code"] as? String == body["code"] as? String,
      data["codeType"] as? String == body["codeType"] as? String,
      let quantity = data["packageQuantity"] as? String, let expected = body["packageQuantity"] as? String,
      Decimal(string: quantity) == Decimal(string: expected) else { throw StaffAPIError.invalid }
    return
  }
  guard data["status"] as? String == "active" else { throw StaffAPIError.invalid }
  if proof["kind"] as? String == "edit" {
    guard id == proof["itemId"] as? String else { throw StaffAPIError.invalid }
    for key in ["sku", "baseUnit", "itemType"] { guard data[key] as? String == proof[key] as? String else { throw StaffAPIError.invalid } }
  }
  for key in ["name", "categoryCode", "sku", "baseUnit", "itemType"] where body[key] != nil {
    guard data[key] as? String == body[key] as? String else { throw StaffAPIError.invalid }
  }
  for key in ["packageVolumeMl", "lowStockThreshold", "reasonableWasteQuantity"] where key != "reasonableWasteQuantity" || body[key] != nil {
    if let expected = body[key] as? String {
      guard let raw = data[key] as? String, let amount = Decimal(string: raw), amount == Decimal(string: expected) else { throw StaffAPIError.invalid }
    } else { guard data[key] is NSNull else { throw StaffAPIError.invalid } }
  }
  if body["wholeUnitCount"] != nil { guard try catalogConfigBool(data["wholeUnitCount"]) == catalogConfigBool(body["wholeUnitCount"]) else { throw StaffAPIError.invalid } }
}
