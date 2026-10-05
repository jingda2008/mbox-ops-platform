import Foundation
struct RecipeConfigurationBoard {
  let employeeID, version: String
  let product: CatalogConfigurationRecord
  let recipe: CatalogConfigurationRecord?
  let items: [CatalogConfigurationRecord]
  init(data: Data, actor: StaffIdentity, productID: String) throws {
    guard actor.allows("inventory.manage"), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let d = root["data"] as? [String: Any],
      d["currentEmployeeId"] as? String == actor.employee.id, try catalogConfigInt(d["nativeRecipeProtocol"]) == 1,
      let p = d["product"] as? [String: Any], p["id"] as? String == productID, UUID(uuidString: productID) != nil,
      let v = d["expectedVersion"] as? String, v.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let rows = d["items"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; version = v; product = try CatalogConfigurationRecord(p); items = try rows.map(CatalogConfigurationRecord.init)
    guard Set(items.map(\.id)).count == items.count else { throw StaffAPIError.invalid }
    for row in items { guard UUID(uuidString: row.id) != nil, inventorySetupUnits[row.text("baseUnit")] != nil else { throw StaffAPIError.invalid } }
    if let r = d["recipe"] as? [String: Any] {
      guard r["productId"] as? String == productID, UUID(uuidString: r["id"] as? String ?? "") != nil,
        try catalogConfigInt(r["version"]) > 0, (1...1000).contains(try catalogConfigInt(r["yieldQuantity"])),
        r["instructionsSnapshot"] is [String: Any], let components = r["components"] as? [[String: Any]], (1...100).contains(components.count) else { throw StaffAPIError.invalid }
      let ids = components.compactMap { $0["inventoryItemId"] as? String }; guard ids.count == components.count, Set(ids).count == ids.count else { throw StaffAPIError.invalid }
      for c in components { _ = try inventorySetupDecimal(c["quantity"] as? String ?? "", zero: false); _ = try inventorySetupDecimal(c["expectedWasteQuantity"] as? String ?? "") }
      recipe = try CatalogConfigurationRecord(r)
    } else { guard d["recipe"] is NSNull else { throw StaffAPIError.invalid }; recipe = nil }
  }
  var originalVersion: Int { (try? catalogConfigInt(recipe?.object["version"])) ?? 0 }
}
struct RecipeConfigurationLine: Identifiable {
  let id: String
  var quantity = "1", waste = "0"
}
struct RecipeConfigurationDraft {
  var output = "1", notes = ""
  var lines: [RecipeConfigurationLine] = []
  init(board: RecipeConfigurationBoard) {
    if let recipe = board.recipe {
      output = String((try? catalogConfigInt(recipe.object["yieldQuantity"])) ?? 1); notes = (recipe.object["instructionsSnapshot"] as? [String: Any])?["notes"] as? String ?? ""
      lines = (recipe.object["components"] as? [[String: Any]] ?? []).map { RecipeConfigurationLine(id: $0["inventoryItemId"] as? String ?? "", quantity: $0["quantity"] as? String ?? "", waste: $0["expectedWasteQuantity"] as? String ?? "") }
    }
  }
  func command(actor: StaffIdentity, board: RecipeConfigurationBoard) throws -> LiveCommand {
    guard actor.employee.id == board.employeeID, actor.allows("inventory.manage"), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
      board.product.text("product_kind") == "single", let yield = Int(output), (1...1000).contains(yield), notes.utf16.count <= 2000,
      (1...100).contains(lines.count), Set(lines.map(\.id)).count == lines.count else { throw CatalogError("请核对单品、库存管理权限、1—1000份产出、1—100种不重复物料和2000字内说明") }
    var components: [[String: Any]] = [], description: [String] = []
    for line in lines {
      guard let item = board.items.first(where: { $0.id == line.id }) else { throw CatalogError("原物料已停用，请移除并选择当前有效物料") }
      let quantity = try inventorySetupDecimal(line.quantity, zero: false), waste = try inventorySetupDecimal(line.waste)
      components.append(["inventoryItemId": line.id,"quantity":quantity,"expectedWasteQuantity":waste])
      description.append(item.text("name") + "：用量 " + quantity + " " + item.text("baseUnit") + "，预计损耗 " + waste + " " + item.text("baseUnit"))
    }
    var instructions = board.recipe?.object["instructionsSnapshot"] as? [String: Any] ?? [:]; instructions["notes"] = notes.trimmingCharacters(in: .whitespacesAndNewlines)
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["productId":board.product.id,"originalVersion":board.originalVersion,"employeeId":actor.employee.id,
      "confirmation":"更新 " + board.product.text("name") + " 配方\n每批产出 " + String(yield) + " 份\n" + description.joined(separator:"\n") + "\n制作说明：" + notes + "\n保存按当前库存成本重算；缺失成本保持待核对，原订单耗料不重算。"]
    return LiveCommand(id:id,employeeID:actor.employee.id,title:"核对配方与耗料",permission:"inventory.manage",steps:[.init(path:inventorySetupRoot + "/products/" + board.product.id + "/recipe",body:try catalogConfigData(["expectedVersion":board.version,"yieldQuantity":yield,"instructionsSnapshot":instructions,"components":components]),keyHeader:"idempotency-key",key:"native-recipe-" + id,recoveryBody:try catalogConfigData(["recipeConfiguration":proof]))])
  }
}
extension LiveCommand.Step {
  var recipeConfigurationProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["recipeConfiguration"] as? [String: Any] }
}
func validateRecipeConfigurationReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let d = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    let proof = step.recipeConfigurationProof, UUID(uuidString: d["id"] as? String ?? "") != nil,
    try catalogConfigInt(d["version"]) > catalogConfigInt(proof["originalVersion"]) else { throw StaffAPIError.invalid }
  _ = try catalogConfigBool(meta["replayed"])
}
struct RecipeCostViewData {
  let productID: String
  let recipeVersion: Int
  let amountMinor: Int?
  let components: [CatalogConfigurationRecord]
  init(data: Data, board: RecipeConfigurationBoard) throws {
    guard let root = try JSONSerialization.jsonObject(with:data) as? [String: Any], let d = root["data"] as? [String: Any], d["productId"] as? String == board.product.id,
      d["recipeId"] as? String == board.recipe?.id, d["currency"] as? String == "CNY", try catalogConfigInt(d["recipeVersion"]) == board.originalVersion,
      let rows = d["components"] as? [[String: Any]], !rows.isEmpty else { throw StaffAPIError.invalid }
    productID = board.product.id; recipeVersion = board.originalVersion
    if d["costAmountMinor"] is NSNull { amountMinor = nil } else { let n = try catalogConfigInt(d["costAmountMinor"]); guard n >= 0 else { throw StaffAPIError.invalid }; amountMinor = n }
    components = try rows.map { row in
      guard let id = row["recipeItemId"] as? String, UUID(uuidString:id) != nil, UUID(uuidString:row["inventoryItemId"] as? String ?? "") != nil,
        inventorySetupUnits[row["baseUnit"] as? String ?? ""] != nil else { throw StaffAPIError.invalid }
      _ = try inventorySetupDecimal(row["componentQuantity"] as? String ?? "", zero:false)
      if !(row["componentCostMinor"] is NSNull) { _ = try inventorySetupDecimal(row["componentCostMinor"] as? String ?? "") }
      var object = row; object["id"] = id; return try CatalogConfigurationRecord(object)
    }
  }
}
func recipeMinorText(_ text: String) -> String {
  guard let value = Decimal(string:text,locale:Locale(identifier:"en_US_POSIX")) else { return "待核对" }
  return NSDecimalNumber(decimal:value / 100).stringValue + "元"
}
