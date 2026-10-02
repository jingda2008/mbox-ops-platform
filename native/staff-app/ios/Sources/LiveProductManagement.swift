import Foundation

struct ProductManagementBoard: Decodable {
  struct Product: Decodable, Identifiable {
    struct Price: Decodable { let amountMinor, currency: String? }
    let id, code, name, status, nativeVersion, productKind: String
    let guestVisible: Bool
    let menuSortOrder: Int
    let standardPrice: Price?
    var priceText: String {
      standardPrice?.amountMinor.flatMap(Int.init).map { String(format: "%.2f", Double($0) / 100) }
        ?? ""
    }
    var summary: String {
      name + " · " + (["active": "在售", "sold_out": "售罄", "inactive": "下架"][status] ?? status)
        + (guestVisible ? " · 客人可见" : " · 客人不可见")
    }
  }
  let currentEmployeeId: String
  let durableProducts, canPrice: Bool
  let products: [Product]
  let offset, limit: Int
}
func productManagementCommand(
  actor: StaffIdentity, board: ProductManagementBoard, product: ProductManagementBoard.Product,
  status: String, visible: Bool, sort: String, price: String, reason: String
) throws -> LiveCommand {
  guard board.durableProducts, board.currentEmployeeId == actor.employee.id,
    actor.allows("catalog.product.manage"),
    board.products.contains(where: {
      $0.id == product.id && $0.nativeVersion == product.nativeVersion
    }), ["active", "sold_out", "inactive"].contains(status), let order = Int(sort),
    (0...10_000).contains(order)
  else { throw CatalogError("请刷新原商品并核对权限和排序（0—10000）") }
  var patch: [String: Any] = [:]
  var changes: [String] = []
  if status != product.status {
    patch["status"] = status
    let labels=["active":"在售","sold_out":"售罄","inactive":"下架"]
    changes.append("状态："+(labels[product.status] ?? product.status)+" → "+(labels[status] ?? status))
  }
  if visible != product.guestVisible {
    patch["guestVisible"] = visible
    changes.append(visible ? "客人菜单显示" : "客人菜单隐藏")
  }
  if order != product.menuSortOrder {
    patch["menuSortOrder"] = order
    changes.append("排序：\(product.menuSortOrder) → \(order)")
  }
  if price != product.priceText {
    guard board.canPrice, actor.allows("catalog.price.manage"),
      product.standardPrice?.currency == nil || product.standardPrice?.currency == "CNY",
      let amount = nativeNonnegativeMoney(price), (0...100_000_000).contains(amount),
      !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, reason.count <= 500
    else { throw CatalogError("修改价格需价格权限、人民币有效金额及变更原因") }
    patch["standardPrice"] = ["amountMinor": amount, "currency": "CNY", "reason": reason]
    changes.append("新售价：" + money(amount) + "；仅影响后续报价，已有账单不改价。")
  }
  guard !patch.isEmpty else { throw CatalogError("没有需要提交的变更") }
  let id = UUID().uuidString.lowercased()
  let proof: [String: Any] = [
    "id": product.id, "expected": patch,
    "confirmation": product.name + "\n" + changes.joined(separator: "\n")
      + "\n恢复在售仍须通过服务器的配方、库存和套餐校验。",
  ]
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: "确认商品变更", permission: "catalog.product.manage",
    steps: [
      .init(
        path: "/api/native/catalog/products/" + LiveCommand.pathPart(product.id),
        body: try JSONSerialization.data(
          withJSONObject: ["expectedVersion": product.nativeVersion, "patch": patch],
          options: .sortedKeys), keyHeader: "idempotency-key", key: "native-product-" + id,
        recoveryBody: try JSONSerialization.data(
          withJSONObject: ["productManagement": proof], options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var productManagementProof: [String: Any]? {
    guard let recoveryBody,
      let p = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return p["productManagement"] as? [String: Any]
  }
}
func validateProductManagementReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.productManagementProof, let patch = p["expected"] as? [String: Any],
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], data["id"] as? String == p["id"] as? String,
    let meta = root["meta"] as? [String: Any], meta["replayed"] is Bool
  else { throw StaffAPIError.invalid }
  for key in ["status", "guestVisible", "menuSortOrder"] {
    if let expected = patch[key],
      !NSDictionary(dictionary: ["v": expected]).isEqual(to: ["v": data[key] ?? NSNull()])
    {
      throw StaffAPIError.invalid
    }
  }
  if let price = patch["standardPrice"] as? [String: Any] {
    guard let got = data["standardPrice"] as? [String: Any], got["currency"] as? String == "CNY",
      let raw = got["amountMinor"] as? String, Int(raw) == price["amountMinor"] as? Int
    else { throw StaffAPIError.invalid }
  }
}
