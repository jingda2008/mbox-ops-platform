import Foundation

/// Decoding chooses a business mode before reading the payload. A barcode is
/// never interpreted as authority, a payment result, or a command to execute.
enum NativeScanMode { case payment, member, inventory, table }

func nativeScannedCode(_ value: String, mode: NativeScanMode) throws -> String {
  switch mode {
  case .payment:
    // Keep the payment-provider contract exactly; no trimming or URL extraction.
    guard value.range(of: "^[0-9]{16,32}$", options: .regularExpression) != nil,
      value.utf8.allSatisfy({ (48...57).contains($0) })
    else { throw CatalogError("识别的不是有效付款码，请顾客打开付款码后重试") }
    return value
  case .member:
    guard value.uppercased().hasPrefix("MBOX_MEMBER_V1:") else {
      throw CatalogError("请扫描顾客小程序中的会员码")
    }
    return try MemberCommands.code(value)
  case .inventory:
    let code = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !code.isEmpty, code.utf16.count <= 128,
      !code.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else { throw CatalogError("库存条码无效，请手动输入并核对原物料") }
    return code
  case .table:
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.utf16.count <= 4096,
      !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else { throw CatalogError("桌码无效，请手动搜索桌号") }
    let code: String
    if text.lowercased().hasPrefix("https://") {
      guard let url = URLComponents(string: text), url.scheme?.lowercased() == "https",
        url.host?.lowercased() == "mbox.shmbox.com", url.user == nil, url.password == nil,
        url.port == nil || url.port == 443,
        // This is the actual printed table entry, not an arbitrary web link.
        url.percentEncodedPath == "/guest",
        let items = url.queryItems, items.count == 1, items[0].name == "table",
        let table = items[0].value
      else { throw CatalogError("这不是本门店桌码，请手动搜索桌号") }
      code = table
      // Printed #token credentials are intentionally neither returned nor used.
    } else { code = text }
    guard code.range(of: "^[A-Za-z0-9\\p{Han}_-]{1,32}$", options: .regularExpression) != nil,
      !code.contains(where: { $0.isWhitespace })
    else { throw CatalogError("未识别到有效桌号，请手动搜索") }
    return code.uppercased(with: Locale(identifier: "en_US_POSIX"))
  }
}

func resolveNativeScannedTable(_ value: String, tables: [StaffTable]) throws -> StaffTable {
  let code = try nativeScannedCode(value, mode: .table)
  let rows = tables.filter { $0.code.uppercased(with: Locale(identifier: "en_US_POSIX")) == code }
  guard rows.count == 1 else { throw CatalogError("当前岗位可见桌台中没有唯一匹配的桌号，请刷新后手动搜索") }
  return rows[0]
}

struct NativeTableScanSelection {
  let tableID: String
  let tableCode: String
  let staffNavigationKey: String
  let workspace: Int
  init(table: StaffTable, actor: StaffIdentity, workspace: Int) {
    self.tableID = table.id; self.tableCode = table.code
    self.staffNavigationKey = actor.staffNavigationKey; self.workspace = workspace
  }
  func validate(actor: StaffIdentity?, workspace: Int, tables: [StaffTable]) throws -> String {
    guard let actor, actor.staffNavigationKey == staffNavigationKey, self.workspace == workspace,
      StaffDestination.tables.available(to: actor) else { throw CatalogError("员工、权限或工作区已变化，请重新扫码") }
    let table = try resolveNativeScannedTable(tableCode, tables: tables)
    guard table.id == tableID else { throw CatalogError("桌台名单已变化，请重新扫码确认") }
    return table.id
  }
}
