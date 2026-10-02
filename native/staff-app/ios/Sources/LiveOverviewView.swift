import SwiftUI

struct LiveOverviewView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var period = "day"
  @State private var anchor = ""
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          Text(model.overviewState).font(.caption)
          Picker("周期", selection: $period) {
            Text("日").tag("day")
            Text("周").tag("week")
            Text("月").tag("month")
            Text("季").tag("quarter")
            Text("年").tag("year")
          }.pickerStyle(.segmented)
          TextField("营业日 YYYY-MM-DD，留空为当前", text: $anchor).textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
          Button("查询经营概览") { Task { await model.loadOverview(period: period, anchor: anchor) } }
            .buttonStyle(Primary(symbol: "chart.bar")).disabled(model.busy)
          if period != model.overviewPeriod || anchor != model.overviewAnchor {
            Text("筛选已改变，请查询更新结果").font(.caption)
          }
          if let r = model.overview {
            Text(r.range.startDate + " 至 " + r.range.endDate).font(.headline)
            Text(r.status == "provisional" ? "数据暂估：仍有未对账或缺失成本" : "系统已记录数据已完成当前核算").foregroundStyle(
              r.status == "provisional" ? Color.orange : ink)
            Card {
              Text("收款与退款").font(.headline)
              metric("收款流水", r.revenue.cash["paymentReceiptsMinor"])
              metric("退款流水", r.revenue.cash["refundsMinor"])
              metric("净收款", r.revenue.cash["netReceiptsMinor"])
              Text("净收款不等于营业收入或利润；渠道费和调整以账本口径为准。").font(.caption)
            }
            Card {
              Text("成本与经营利润").font(.headline)
              metric("销售商品成本", r.costs["goodsCostMinor"])
              metric("库存损耗", r.costs["inventoryLossMinor"])
              metric("经营费用", r.costs["operatingExpenseMinor"])
              metric("经营利润（已记录）", r.profit["operatingProfitMinor"])
            }
            Card {
              Text("待核对数据").font(.headline)
              metric("已收未对账", r.gaps.unreconciledCapturedPaymentsMinor)
              metric("券待结算", r.gaps.unsettledVoucherSettlementMinor)
              metric("应计费用待实化", r.gaps.unactualizedAccrualMinor)
              metric("缺付款日期成本", r.gaps.costsMissingCashDateMinor)
              Text(
                "缺成本商品行 \(r.gaps.orderItemsMissingCostCount) · 缺成本损耗 \(r.gaps.inventoryLossesMissingCostCount)"
              ).font(.caption)
            }
            ForEach(Array(r.caveats.enumerated()), id: \.offset) { _, text in
              Text(text).font(.caption)
            }
            Text("数据读取时间：" + r.asOf).font(.caption)
          }
        }.padding(16)
      }.background(paper).navigationTitle("经营概览").navigationBarTitleDisplayMode(.inline).toolbar {
        Button("关闭") { dismiss() }
      }
    }.task { await model.loadOverview() }.onChange(of: model.workspaceVersion) { dismiss() }
      .onChange(of: model.priorityAccessKey) { dismiss() }
  }
  private func metric(_ label: String, _ amount: Int?) -> some View {
    HStack {
      Text(label)
      Spacer()
      Text(amount.map(money) ?? "待核对").monospacedDigit()
    }
  }
}
