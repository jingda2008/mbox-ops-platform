import Foundation

struct OperatingOverview: Decodable {
  struct Range: Decodable { let startDate, endDate: String }
  struct Revenue: Decodable {
    let cash: [String: Int]
    let accrual: [String: Int]
  }
  struct Gaps: Decodable {
    let unreconciledCapturedPaymentsMinor, unsettledVoucherSettlementMinor,
      unactualizedAccrualMinor, costsMissingCashDateMinor, orderItemsMissingCostCount,
      inventoryLossesMissingCostCount: Int
    let unknownUnrecordedCostsMeasurable: Bool
  }
  let period, currency, asOf, status: String
  let range: Range
  let revenue: Revenue
  let costs, profit: [String: Int]
  let gaps: Gaps
  let caveats: [String]
  func validate(period: String) throws {
    guard self.period == period, currency == "CNY", ["complete", "provisional"].contains(status),
      !gaps.unknownUnrecordedCostsMeasurable,
      ["paymentReceiptsMinor", "refundsMinor", "netReceiptsMinor"].allSatisfy({
        revenue.cash[$0] != nil
      }),
      ["goodsCostMinor", "inventoryLossMinor", "operatingExpenseMinor"].allSatisfy({
        costs[$0] != nil
      }), profit["operatingProfitMinor"] != nil
    else { throw StaffAPIError.invalid }
  }
}
func overviewPath(period: String, anchor: String) throws -> String {
  guard ["day", "week", "month", "quarter", "year"].contains(period) else {
    throw CatalogError("统计周期无效")
  }
  if !anchor.isEmpty {
    var q = HistoryQuery()
    q.date = anchor
    q.endDate = anchor
    _ = try q.path()
  }
  return "/api/commercial-ops/profit?period=" + period
    + (anchor.isEmpty ? "" : "&anchor=" + LiveCommand.pathPart(anchor))
}
