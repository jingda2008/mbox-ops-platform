import Foundation

struct HistoryQuery: Equatable {
  var workKind = ""
  var date = ""
  var endDate = ""
  var table = ""
  var employee = ""
  var search = ""
  var area = ""
  var paymentStatus = ""
  static let statuses = [
    "", "unpaid", "pending", "partially_paid", "paid", "partially_refunded", "refunded",
  ]
  func path(page: Int = 0) throws -> String {
    guard (0...2000).contains(page),
      [table, employee, search, area].allSatisfy({ $0.utf16.count <= 80 }),
      Self.statuses.contains(paymentStatus), ["", "prepared", "delivered"].contains(workKind)
    else { throw CatalogError("查询条件过长或页码无效") }
    var pairs = [
      "table": table, "employee": employee, "search": search, "area": area,
      "paymentStatus": paymentStatus, "page": String(page),
    ]
    if !workKind.isEmpty { pairs["workKind"] = workKind }
    if !date.isEmpty || !endDate.isEmpty {
      let format = DateFormatter()
      format.locale = Locale(identifier: "en_US_POSIX")
      format.timeZone = TimeZone(secondsFromGMT: 0)
      format.dateFormat = "yyyy-MM-dd"
      format.isLenient = false
      guard let start = format.date(from: date), let end = format.date(from: endDate),
        format.string(from: start) == date, format.string(from: end) == endDate, end >= start,
        end.timeIntervalSince(start) <= 366 * 86400
      else { throw CatalogError("请填写有效营业日，起止范围最多366天") }
      pairs["businessDate"] = date
      pairs["endDate"] = endDate
    }
    var url = URLComponents()
    url.path = "/api/operations/history"
    url.queryItems = pairs.sorted(by: { $0.key < $1.key }).map {
      URLQueryItem(name: $0.key, value: $0.value)
    }
    return url.string!.replacingOccurrences(of: "+", with: "%2B")
  }
}
func historyStatus(_ raw: String) -> String {
  [
    "draft": "草稿", "submitted": "已下单", "confirmed": "已确认", "fulfilling": "履约中", "completed": "已完成",
    "cancelled": "已取消", "accepted": "已接单", "preparing": "制作中", "ready": "待送达", "delivered": "已送达",
    "unpaid": "待支付", "pending": "处理中", "partially_paid": "部分付款", "paid": "已支付",
    "partially_refunded": "部分退款", "refunded": "已退款", "stopped": "已停止", "held": "已暂停",
  ][raw] ?? "状态待核对（\(raw)）"
}
struct LiveHistory: Decodable {
  struct Receipt: Decodable {
    let provider: String
    let receivedMinor: Int
    let refundedMinor: Int
    let netMinor: Int
  }
  struct Summary: Decodable {
    let orderCount: Int
    let orderAmountMinor: String
    let unsettledCount: Int
    let outstandingMinor: String
    let pendingPaymentCount: Int
    let pendingRefundCount: Int
  }
  struct Order: Decodable, Identifiable {
    let id: String
    let businessDate: String?
    let publicId: String
    let tableCode: String
    let employeeName: String?
    let tableSessionId: String?
    let sessionPublicId: String?
    let areaName: String?
    let submittedAt: String
    let status: String
    let paymentStatus: String
    let totalMinor: Int
    let effectiveAmountMinor: Int?
    let receivableIncreaseMinor: Int?
    let stoppedAmountMinor: Int?
    let items: [Item]
  }
  struct Item: Decodable, Identifiable {
    struct Quantities: Decodable {
      let total: Int
      let held: Int
      let stopped: Int
      let ready: Int
      let delivered: Int
      let usedLoss: Int
    }
    let id: String
    let name: String
    let quantity: Int
    let unitPriceMinor: Int
    let totalMinor: Int
    let includedInBundle: Bool?
    let status: String
    let note: String?
    let fulfillmentClosureNote: String?
    let quantities: Quantities?
    let returnedQuantity: Int?
    let preparedAt: String?
    let preparedBy: String?
    let deliveredAt: String?
    let deliveredBy: String?
  }
  let financialSummaryVisible: Bool?
  let financialStartDate: String?
  let summary: Summary?
  let businessDate: String
  let endDate: String?
  let generatedAt: String
  let page: Int
  let hasMore: Bool
  let receipts: [Receipt]
  let orders: [Order]
  func validate(page expected: Int) throws {
    guard page == expected, Set(orders.map(\.id)).count == orders.count else {
      throw StaffAPIError.invalid
    }
  }
}
