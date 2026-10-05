import Foundation
import CoreFoundation

let catalogConfigurationRoot = "/api/native/catalog"
let catalogChannelNames = ["guest_qr": "顾客扫码", "staff_assisted": "员工点单", "cashier": "收银", "reservation": "预约", "integration": "外部接入"]
let catalogStationNames = ["bar": "吧台", "kitchen": "厨房", "cashier": "收银", "none": "无需制作"]
func catalogConfigData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
func catalogConfigInt(_ value: Any?) throws -> Int {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
    number.doubleValue == Double(number.intValue) else { throw StaffAPIError.invalid }
  return number.intValue
}
func catalogConfigBool(_ value: Any?) throws -> Bool {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw StaffAPIError.invalid }; return number.boolValue
}
func catalogConfigCode(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", options: .regularExpression) != nil }
struct CatalogConfigurationRecord: Identifiable, Equatable {
  let data: Data
  init(_ object: [String: Any]) throws { data = try catalogConfigData(object) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  func text(_ key: String) -> String { object[key] as? String ?? "" }
}
struct CatalogConfigurationBoard {
  let employeeID: String
  let canPrice, enabled, operationalEnabled: Bool
  let products, categories: [CatalogConfigurationRecord]
  let offset, limit: Int
  init(data: Data, actor: StaffIdentity) throws {
    guard actor.allows("catalog.product.manage"), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let d = root["data"] as? [String: Any], d["currentEmployeeId"] as? String == actor.employee.id,
      try catalogConfigInt(d["configurationProtocol"]) == 1,
      let products = d["products"] as? [[String: Any]], let categories = d["categories"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; enabled = try catalogConfigBool(d["durableProducts"]); operationalEnabled = (try? catalogConfigInt(d["operationalProtocol"])) == 1
    canPrice = try catalogConfigBool(d["canPrice"]); offset = try catalogConfigInt(d["offset"]); limit = try catalogConfigInt(d["limit"])
    guard (0...10000).contains(offset), (1...100).contains(limit) else { throw StaffAPIError.invalid }
    self.products = try products.map(CatalogConfigurationRecord.init); self.categories = try categories.map(CatalogConfigurationRecord.init)
    guard Set(self.products.map(\.id)).count == products.count, Set(self.categories.map { $0.text("code") }).count == categories.count else { throw StaffAPIError.invalid }
    for p in self.products {
      guard UUID(uuidString: p.id) != nil, p.text("nativeVersion").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
        ["single", "bundle"].contains(p.text("productKind")) else { throw StaffAPIError.invalid }
    }
    for c in self.categories {
      guard UUID(uuidString: c.id) != nil, catalogConfigCode(c.text("code")), !c.text("displayName").isEmpty,
        (c.object["parentCode"] is NSNull || c.object["parentCode"] is String), !c.text("updatedAt").isEmpty,
        (0...100000).contains(try catalogConfigInt(c.object["sortOrder"])) else { throw StaffAPIError.invalid }
      _ = try catalogConfigBool(c.object["guestVisible"])
    }
  }
}
struct CatalogBundleItem: Identifiable, Equatable {
  let productID: String
  var name: String
  var quantity = "1"
  var sortOrder = 10
  var note = ""
  var id: String { productID }
  func payload(selfID: String, withNote: Bool) throws -> [String: Any] {
    guard UUID(uuidString: productID) != nil, productID != selfID, let amount = Int(quantity), (1...999).contains(amount),
      (0...10000).contains(sortOrder), note.utf16.count <= 500 else { throw CatalogError("套餐单品、份数或备注无效") }
    var result: [String: Any] = ["productId": productID, "quantity": amount, "sortOrder": sortOrder]
    if withNote { result["note"] = note.isEmpty ? NSNull() : note as Any }
    return result
  }
}
struct CatalogBundleGroup: Identifiable, Equatable {
  var id: String { code }
  var serverID: String?
  var code = "choice_" + UUID().uuidString.prefix(8).lowercased()
  var name = "自选组"
  var selectionCount = "1"
  var sortOrder = 10
  var options: [CatalogBundleItem] = []
  func payload(selfID: String) throws -> [String: Any] {
    guard catalogConfigCode(code), (1...80).contains(name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      (1...100).contains(options.count), let count = Int(selectionCount), (1...min(20, options.count)).contains(count),
      Set(options.map(\.id)).count == options.count, (0...10000).contains(sortOrder),
      serverID == nil || UUID(uuidString: serverID!) != nil else { throw CatalogError("请核对自选组名称、可选单品及每套选择数量") }
    return ["id": serverID as Any? ?? NSNull(), "code": code, "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
      "selectionCount": count, "sortOrder": sortOrder, "options": try options.map { try $0.payload(selfID: selfID, withNote: false) }]
  }
}
struct CatalogProductDraft {
  var code = "", name = "", category = "", kind = "single", station = "bar", inventoryMode = "tracked"
  var maximum = "99", from = "", until = "", description = "", imageURL = "", initialPrice = ""
  var channels = Set(["guest_qr", "staff_assisted", "cashier"])
  var initialSnapshot: [String: Any] = [:]
  var components: [CatalogBundleItem] = []
  var groups: [CatalogBundleGroup] = []
  init(product: CatalogConfigurationRecord? = nil) throws {
    guard let product else { return }
    let p = product.object
    code = product.text("code"); name = product.text("name"); category = product.text("categoryCode")
    kind = product.text("productKind"); station = product.text("fulfillmentStation"); inventoryMode = product.text("inventoryControlMode")
    maximum = String(try catalogConfigInt(p["maxOrderQuantity"])); from = String(product.text("availableFrom").prefix(5)); until = String(product.text("availableUntil").prefix(5))
    let snapshot = p["productSnapshot"] as? [String: Any] ?? [:]
    description = snapshot["description"] as? String ?? ""; imageURL = snapshot["imageUrl"] as? String ?? ""
    guard let allowed = p["allowedChannels"] as? [String], let raw = p["bundleComponents"] as? [[String: Any]], let rawGroups = p["bundleChoiceGroups"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    channels = Set(allowed)
    func item(_ x: [String: Any]) throws -> CatalogBundleItem {
      guard let id = x["productId"] as? String else { throw StaffAPIError.invalid }
      return CatalogBundleItem(productID: id, name: x["name"] as? String ?? id,
        quantity: String(try catalogConfigInt(x["quantity"])), sortOrder: try catalogConfigInt(x["sortOrder"]), note: x["note"] as? String ?? "")
    }
    components = try raw.map(item)
    groups = try rawGroups.map { g in
      guard let id = g["id"] as? String, let code = g["code"] as? String, let name = g["name"] as? String,
        let options = g["options"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      return CatalogBundleGroup(serverID: id, code: code, name: name, selectionCount: String(try catalogConfigInt(g["selectionCount"])), sortOrder: try catalogConfigInt(g["sortOrder"]), options: try options.map(item))
    }
  }
  func command(actor: StaffIdentity, board: CatalogConfigurationBoard, product: CatalogConfigurationRecord?) throws -> LiveCommand {
    guard board.enabled, board.employeeID == actor.employee.id, actor.allows("catalog.product.manage"),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else { throw CatalogError("请刷新商品并核对权限") }
    let creating = product == nil, selfID = product?.id ?? "new"
    guard creating || board.products.contains(product!), (1...160).contains(name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      board.categories.contains(where: { $0.text("code") == category && $0.object["parentCode"] is String }),
      ["single", "bundle"].contains(kind), catalogStationNames[station] != nil, ["tracked", "not_managed"].contains(inventoryMode),
      let max = Int(maximum), (1...9999).contains(max), !channels.isEmpty, channels.allSatisfy({ catalogChannelNames[$0] != nil }),
      description.utf16.count <= 2000 else { throw CatalogError("请核对原商品、名称、二级分类、出品方式、渠道及数量") }
    let timePattern = "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"
    guard (from.isEmpty && until.isEmpty) || (from.range(of: timePattern, options: .regularExpression) != nil && until.range(of: timePattern, options: .regularExpression) != nil) else { throw CatalogError("供应时间须成对填写HH:mm，跨午夜按服务器营业规则判断") }
    guard components.count <= 50, Set(components.map(\.id)).count == components.count, groups.count <= 20,
      Set(groups.map(\.code)).count == groups.count, kind != "bundle" || (station == "none" && (!components.isEmpty || !groups.isEmpty)) else { throw CatalogError("套餐须选择无需制作，并配置不重复的固定单品或自选组") }
    var snapshot = product?.object["productSnapshot"] as? [String: Any] ?? initialSnapshot
    snapshot["description"] = description.trimmingCharacters(in: .whitespacesAndNewlines); snapshot["imageUrl"] = imageURL
    if !imageURL.isEmpty && imageURL.range(of: "^/api/public/media-assets/MA[0-9A-F]{32}$", options: .regularExpression) == nil {
      guard let url = URL(string: imageURL), url.scheme == "https", url.user == nil, url.password == nil else { throw CatalogError("请选择有效HTTPS商品图片") }
    }
    var patch: [String: Any] = ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "categoryCode": category,
      "productKind": kind, "fulfillmentStation": station, "inventoryControlMode": inventoryMode, "maxOrderQuantity": max,
      "allowedChannels": channels.sorted(), "availableFrom": from.isEmpty ? NSNull() : from as Any,
      "availableUntil": until.isEmpty ? NSNull() : until as Any, "productSnapshot": snapshot,
      "bundleComponents": kind == "bundle" ? try components.map { try $0.payload(selfID: selfID, withNote: true) } : [],
      "bundleChoiceGroups": kind == "bundle" ? try groups.map { try $0.payload(selfID: selfID) } : []]
    if creating {
      guard catalogConfigCode(code) else { throw CatalogError("商品编号须为1—64位字母、数字、点、下划线或横线，首位为字母或数字") }
      patch["code"] = code; patch["status"] = "inactive"
      if !initialPrice.isEmpty {
        guard board.canPrice, actor.allows("catalog.price.manage"), let amount = nativeNonnegativeMoney(initialPrice), amount <= 100000000 else { throw CatalogError("初始人民币售价需价格权限及有效金额") }
        patch["standardPrice"] = ["amountMinor": amount, "currency": "CNY", "reason": "原生创建商品初始售价"]
      }
    }
    var lines = [(creating ? "新建下架商品：" : "配置原商品：") + name, "编号：" + code,
      "分类：" + (board.categories.first { $0.text("code") == category }?.text("displayName") ?? category),
      "出品：" + catalogStationNames[station]!, "库存：" + (inventoryMode == "tracked" ? "按配方跟踪" : "不管理"),
      "渠道：" + channels.sorted().compactMap { catalogChannelNames[$0] }.joined(separator: "、"),
      "供应：" + (from.isEmpty ? "全天" : from + " 至 " + until), "单次最大数量：" + maximum]
    if kind == "bundle" {
      lines += components.map { "固定单品：" + $0.name + " × " + $0.quantity + ($0.note.isEmpty ? "" : "；" + $0.note) }
      for g in groups { lines.append("自选组：" + g.name + "，每套选" + g.selectionCount + "种"); lines += g.options.map { "候选：" + $0.name + " × " + $0.quantity } }
    }
    if creating { lines.append("初始售价：" + (initialPrice.isEmpty ? "未配置" : initialPrice + "元")) }
    if product?.text("productKind") == "bundle" && kind == "single" {
      lines.append("套餐改为单品：本次将移除后续销售使用的全部固定组成与自选组。")
    }
    lines += ["介绍：" + description, "图片：" + (imageURL.isEmpty ? "无" : "按当前选择保存"), "保存影响后续报价、出品和备料；已有订单保留原快照。新商品须完成售价、配方核对后再上架。"]
    let id = UUID().uuidString.lowercased()
    let proof: [String: Any] = ["kind": "product", "employeeId": actor.employee.id, "id": selfID, "creating": creating, "expected": patch, "confirmation": lines.joined(separator: "\n")]
    let body: [String: Any] = creating ? patch : ["expectedVersion": product!.text("nativeVersion"), "patch": patch]
    return LiveCommand(id: id, employeeID: actor.employee.id, title: "核对商品与套餐配置", permission: "catalog.product.manage",
      steps: [.init(path: catalogConfigurationRoot + "/products" + (creating ? "" : "/" + selfID), body: try catalogConfigData(body), keyHeader: "idempotency-key", key: "native-product-" + id,
        recoveryBody: try catalogConfigData(["catalogConfiguration": proof]))])
  }
}
func categoryConfigurationCommand(actor: StaffIdentity, board: CatalogConfigurationBoard, category: CatalogConfigurationRecord?, code: String,
  name: String, parent: String, sort: String, visible: Bool) throws -> LiveCommand {
  guard board.enabled, actor.employee.id == board.employeeID, actor.allows("catalog.product.manage"),
    StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
    category == nil || board.categories.contains(category!), catalogConfigCode(code), category == nil || category!.text("code") == code,
    (1...32).contains(name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count), let order = Int(sort), (0...100000).contains(order),
    parent.isEmpty || board.categories.contains(where: { $0.text("code") == parent && $0.object["parentCode"] is NSNull && parent != code }) else { throw CatalogError("请核对原分类、编号、名称、排序和一级父分类") }
  var patch: [String: Any] = ["displayName": name.trimmingCharacters(in: .whitespacesAndNewlines), "parentCode": parent.isEmpty ? NSNull() : parent as Any, "sortOrder": order, "guestVisible": visible]
  if category == nil { patch["code"] = code }
  let body: [String: Any] = category == nil ? patch : ["expectedUpdatedAt": category!.text("updatedAt"), "patch": patch]
  let id = UUID().uuidString.lowercased()
  let proof: [String: Any] = ["kind": "category", "employeeId": actor.employee.id, "code": code, "creating": category == nil, "expected": patch,
    "confirmation": "分类：" + name + "\n编号：" + code + "\n上级：" + (parent.isEmpty ? "无（一级分类）" : board.categories.first { $0.text("code") == parent }!.text("displayName")) + "\n排序：" + sort + "\n" + (visible ? "顾客菜单显示" : "顾客菜单隐藏") + "\n已有订单内容不变；仍有商品的层级调整由服务器检查。"]
  return LiveCommand(id: id, employeeID: actor.employee.id, title: "核对菜单分类", permission: "catalog.product.manage",
    steps: [.init(path: catalogConfigurationRoot + "/menu-categories" + (category == nil ? "" : "/" + LiveCommand.pathPart(code)), body: try catalogConfigData(body), keyHeader: "idempotency-key", key: "native-category-" + id,
      recoveryBody: try catalogConfigData(["catalogConfiguration": proof]))])
}
extension LiveCommand.Step {
  var catalogConfigurationProof: [String: Any]? {
    guard let recoveryBody, let object = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any] else { return nil }; return object["catalogConfiguration"] as? [String: Any]
  }
}
func validateCatalogConfigurationReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.catalogConfigurationProof, let patch = proof["expected"] as? [String: Any],
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let data = root["data"] as? [String: Any],
    let meta = root["meta"] as? [String: Any], let id = data["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
  _ = try catalogConfigBool(meta["replayed"])
  let creating = try catalogConfigBool(proof["creating"])
  guard (proof["kind"] as? String == "category" ? data["code"] as? String == proof["code"] as? String : creating || id == proof["id"] as? String) else { throw StaffAPIError.invalid }
  for (key, expected) in patch where key != "costChangeReason" {
    let actual = data[key] ?? NSNull()
    if key == "costAmountMinor" {
      if expected is NSNull { guard actual is NSNull else { throw StaffAPIError.invalid } }
      else { guard let text = actual as? String, let value = Int(text), value == (try catalogConfigInt(expected)) else { throw StaffAPIError.invalid } }
    } else if key == "standardPrice" {
      guard let e = expected as? [String: Any], let a = actual as? [String: Any], a["currency"] as? String == "CNY",
        let amount = a["amountMinor"] as? String, Int(amount) == e["amountMinor"] as? Int else { throw StaffAPIError.invalid }
    } else if key == "bundleComponents" || key == "bundleChoiceGroups" {
      let normalized = try catalogComparableBundle(actual, groups: key == "bundleChoiceGroups")
      let original = try catalogComparableBundle(expected, groups: key == "bundleChoiceGroups")
      guard try catalogConfigData(normalized) == catalogConfigData(original) else { throw StaffAPIError.invalid }
    } else if key == "availableFrom" || key == "availableUntil" {
      if let text = expected as? String { guard (actual as? String).map({ String($0.prefix(5)) }) == text else { throw StaffAPIError.invalid } }
      else { guard actual is NSNull else { throw StaffAPIError.invalid } }
    } else if key == "allowedChannels" {
      guard let a = actual as? [String], let e = expected as? [String], Set(a) == Set(e), Set(a).count == a.count else { throw StaffAPIError.invalid }
    } else { guard try catalogConfigData([actual]) == catalogConfigData([expected]) else { throw StaffAPIError.invalid } }
  }
}
private func catalogComparableBundle(_ value: Any, groups: Bool) throws -> [[String: Any]] {
  guard let rows = value as? [[String: Any]] else { throw StaffAPIError.invalid }
  var result: [[String: Any]] = []
  for row in rows {
    let keys = groups ? ["code", "name", "selectionCount", "sortOrder"] : ["productId", "quantity", "sortOrder"]
    var x: [String: Any] = [:]
    for key in keys { guard let v = row[key] else { throw StaffAPIError.invalid }; x[key] = v }
    if groups { x["options"] = try catalogComparableBundle(row["options"] as Any, groups: false) }
    else if let note = row["note"] { x["note"] = note }
    // Options have no note; fixed components have an explicit nullable note.
    result.append(x)
  }
  return result.sorted { String(describing: $0[groups ? "code" : "productId"]!) < String(describing: $1[groups ? "code" : "productId"]!) }
}
