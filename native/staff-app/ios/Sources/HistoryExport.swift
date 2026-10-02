import Foundation

func historyExportTime(_ value: String?) -> String {
  guard let value, !value.isEmpty else { return "" }
  guard let date = StaffIdentity.date(value) else { return value }
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
  formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
  return formatter.string(from: date)
}
func historyExportAmount(_ minor: Int) -> String {
  (minor < 0 ? "-" : "") + String(abs(minor / 100)) + "." + String(format: "%02d", abs(minor % 100))
}
extension HistoryQuery {
  func exportPath(page: Int, all: Bool) throws -> String {
    try path(page: all ? 0 : page) + (all ? "&exportAll=true" : "")
  }
}
extension LiveHistory {
  static func csvCell(_ value: String) -> String {
    let risky =
      value.unicodeScalars.first.map { ["=", "+", "-", "@", "\t", "\r", "\n"].contains(String($0)) } ?? false
    return "\"" + (risky ? "'" : "") + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }
  func exportCSV() throws -> Data {
    guard orders.count <= 5000 else { throw CatalogError("导出超过5000单，请缩小日期或筛选范围；不会只导出部分记录") }
    var rows = [
      [
        "营业日", "订单", "桌台", "桌次", "下单员工", "下单时间", "菜品", "数量", "计价说明", "单价", "优惠后小计", "履约状态", "商品备注",
        "制作员工", "制作完成时间", "送达员工", "送达时间",
      ]
    ]
    for order in orders {
      for item in order.items {
        rows.append([
          order.businessDate ?? businessDate, order.publicId, order.tableCode,
          order.sessionPublicId ?? order.tableSessionId ?? "未留存", order.employeeName ?? "顾客自助",
          historyExportTime(order.submittedAt), item.name, String(item.quantity),
          item.includedInBundle == true ? "套餐内商品，不另收费" : "订单成交价",
          item.includedInBundle == true ? "" : historyExportAmount(item.unitPriceMinor),
          item.includedInBundle == true ? "" : historyExportAmount(item.totalMinor),
          item.fulfillmentClosureNote ?? historyStatus(item.status), item.note ?? "",
          item.preparedBy ?? "", historyExportTime(item.preparedAt), item.deliveredBy ?? "",
          historyExportTime(item.deliveredAt),
        ])
      }
    }
    return Data(
      ("\u{FEFF}"
        + rows.map { $0.map(Self.csvCell).joined(separator: ",") }.joined(separator: "\r\n")).utf8)
  }
}
