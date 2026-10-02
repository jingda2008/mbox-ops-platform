import Foundation

struct LiveProduct: Codable, Identifiable {
  struct Price: Codable {
    let amountMinor: String?
    let currency: String?
  }
  struct Component: Codable {
    let productId: String
    let name: String
    let quantity: Int
    let note: String?
  }
  struct Group: Codable, Identifiable {
    struct Option: Codable, Identifiable {
      let productId: String
      let name: String
      let quantity: Int
      let available: Bool
      let unavailableReason: String?
      var id: String { productId }
    }
    let id: String
    let name: String
    let selectionCount: Int
    let options: [Option]
  }
  let id: String
  let code: String
  let name: String
  let categoryCode: String
  let categoryName: String?
  struct Presentation: Codable {
    let imageUrl, description, specification: String?
    enum CodingKeys: String, CodingKey { case imageUrl, description, specification }
    init(from decoder: Decoder) throws {
      let fields = try decoder.container(keyedBy: CodingKeys.self)
      imageUrl = try? fields.decode(String.self, forKey: .imageUrl)
      description = try? fields.decode(String.self, forKey: .description)
      specification = try? fields.decode(String.self, forKey: .specification)
    }
  }
  let productSnapshot: Presentation?
  let productKind: String
  let bundleComponents: [Component]
  let bundleChoiceGroups: [Group]?
  let allowedChannels: [String]
  let maxOrderQuantity: Int
  let menuSortOrder: Int
  let status: String
  let isAvailable: Bool
  let inventoryConfigurationComplete: Bool
  let inventoryAvailable: Bool
  let availabilityReasons: [String]?
  let standardPrice: Price?
  var price: Int? {
    guard standardPrice?.currency == "CNY", let value = standardPrice?.amountMinor,
      let amount = Int(value), amount >= 0, amount <= 1_000_000_000
    else { return nil }
    return amount
  }
  var groups: [Group] { bundleChoiceGroups ?? [] }
  var unavailable: String? {
    if !allowedChannels.contains("staff_assisted") { return "未开放员工点单渠道" }
    if status == "sold_out" { return "已售罄" }
    if status != "active" { return "已下架" }
    if price == nil { return "缺少有效人民币售价" }
    if !inventoryConfigurationComplete { return "库存配方未配置完整" }
    if !inventoryAvailable { return "库存不足" }
    if !isAvailable { return availabilityReasons?.first ?? "当前不可售" }
    if maxOrderQuantity < 1 { return "未开放可购数量" }
    if groups.contains(where: {
      $0.selectionCount < 1 || $0.options.filter(\.available).count < $0.selectionCount
    }) {
      return "套餐可选商品不足"
    }
    return nil
  }
  func matches(_ query: String) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return needle.isEmpty
      || (name + " " + code + " " + (categoryName ?? categoryCode)).localizedStandardContains(
        needle)
  }
}
struct LiveDraftLine: Codable, Identifiable {
  let id: String
  let product: LiveProduct
  // Each row is one unit; bundle choices vary per unit, notes are shared per product.
  let choices: [String: [String]]
  let note: String
  init(product: LiveProduct, choices: [String: [String]], note: String) throws {
    if let reason = product.unavailable { throw CatalogError(reason) }
    guard note.utf16.count <= 300 else { throw CatalogError("商品备注最多300字") }
    guard Set(choices.keys).isSubset(of: Set(product.groups.map(\.id))) else {
      throw CatalogError("套餐分组已变化，请重新选择")
    }
    for group in product.groups {
      let picked = choices[group.id] ?? []
      guard picked.count == group.selectionCount, Set(picked).count == picked.count,
        picked.allSatisfy({ id in group.options.contains { $0.productId == id && $0.available } })
      else { throw CatalogError("请为“\(group.name)”选择\(group.selectionCount)款可售商品") }
    }
    id = UUID().uuidString
    self.product = product
    self.choices = choices
    self.note = note.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  var selectionLabel: String {
    product.groups.flatMap { group in
      group.options.filter { choices[group.id]?.contains($0.productId) == true }.map {
        "\($0.name) ×\($0.quantity)"
      }
    }.joined(separator: "、")
  }
  var payload: [String: Any] {
    var value: [String: Any] = ["productId": product.id, "quantity": 1]
    if !note.isEmpty { value["note"] = note }
    if !product.groups.isEmpty {
      value["bundleSelections"] = [
        [
          "groups": product.groups.map {
            ["groupId": $0.id, "productIds": choices[$0.id] ?? []] as [String: Any]
          }
        ]
      ]
    }
    return value
  }
}
struct CatalogError: Error, LocalizedError {
  let text: String
  init(_ text: String) { self.text = text }
  var errorDescription: String? { text }
}
struct LiveDraftBook: Codable {
  var entries: [String: [LiveDraftLine]] = [:]
  static func key(employee: String, session: String) -> String { employee + ":" + session }
  mutating func add(_ line: LiveDraftLine, employee: String, session: String) throws {
    let key = Self.key(employee: employee, session: session)
    let lines = entries[key] ?? []
    guard lines.count < 100 else { throw CatalogError("每次草稿最多100份，请分次处理") }
    guard lines.filter({ $0.product.id == line.product.id }).count < line.product.maxOrderQuantity
    else { throw CatalogError("已达到该商品每单限量") }
    guard lines.filter({ $0.product.id == line.product.id }).allSatisfy({ $0.note == line.note })
    else { throw CatalogError("同一商品共用备注，请使用相同备注，或先移除旧份数") }
    guard Set(lines.map { $0.product.id } + [line.product.id]).count <= 50 else {
      throw CatalogError("每次订单最多50种商品")
    }
    entries[key] = lines + [line]
  }
  static func orderItems(_ lines: [LiveDraftLine]) throws -> [[String: Any]] {
    guard !lines.isEmpty else { throw CatalogError("请先选择商品") }
    var ids: [String] = []
    for line in lines where !ids.contains(line.product.id) { ids.append(line.product.id) }
    guard ids.count <= 50 else { throw CatalogError("每次订单最多50种商品") }
    return try ids.map { id in
      let units = lines.filter { $0.product.id == id }
      let first = units[0]
      guard units.count <= min(999, first.product.maxOrderQuantity),
        units.allSatisfy({ $0.note == first.note })
      else { throw CatalogError("商品数量或共用备注不一致，请重新核对") }
      var item = first.payload
      item["quantity"] = units.count
      if !first.product.groups.isEmpty {
        item["bundleSelections"] = units.map {
          ($0.payload["bundleSelections"] as! [[String: Any]])[0]
        }
      }
      return item
    }
  }

}

// Only accepted public menu assets; never attach employee cookies to arbitrary image hosts.
func menuImageURL(_ value: String?) -> URL? {
  guard let path = value?.trimmingCharacters(in: .whitespacesAndNewlines),
    path.range(
      of:
        #"^(/api/public/media-assets/MA[0-9A-F]{32}|/menu/([A-Za-z0-9][A-Za-z0-9_.-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(jpg|jpeg|png|webp))$"#,
      options: [.regularExpression, .caseInsensitive]) != nil
  else { return nil }
  return URL(string: "https://mbox.shmbox.com" + path)
}
