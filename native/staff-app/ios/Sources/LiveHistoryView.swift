import SwiftUI
import UniformTypeIdentifiers

private struct HistoryCSVDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.commaSeparatedText] }
  var data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws {
    data = configuration.file.regularFileContents ?? Data()
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}

struct LiveHistoryView: View {
  @EnvironmentObject var model: AppModel
  @State private var query = HistoryQuery()
  @State private var exportDocument: HistoryCSVDocument?
  @State private var exportVisible = false
  @State private var exportName = "营业明细"
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        Heading(title: "订单", subtitle: "门店 · 营业日查询")
        if !model.canReadHistory {
          Text("当前岗位没有订单历史查询权限").padding()
        } else {
          VStack(alignment: .leading, spacing: 12) {
            Picker("记录类型", selection: $query.workKind) {
              Text("全部订单").tag("")
              if model.identity?.allows("kds.prepare") == true { Text("我的已制作").tag("prepared") }
              if model.identity?.allows("kds.deliver") == true { Text("已送达").tag("delivered") }
            }.pickerStyle(.segmented)
            TextField("桌号、订单号或金额", text: $query.search).textFieldStyle(.roundedBorder)
            Foldout(title: "日期与更多筛选") {
              Text("营业日以门店06:00分界，默认日期由服务器提供。").font(.caption)
              TextField("开始营业日 yyyy-MM-dd", text: $query.date).textFieldStyle(.roundedBorder)
              TextField("结束营业日 yyyy-MM-dd", text: $query.endDate).textFieldStyle(.roundedBorder)
              TextField("桌号（支持模糊查询）", text: $query.table).textFieldStyle(.roundedBorder)
              TextField("下单员工，留空含顾客自助", text: $query.employee).textFieldStyle(.roundedBorder)
              TextField("区域", text: $query.area).textFieldStyle(.roundedBorder)
              Picker("支付状态", selection: $query.paymentStatus) {
                ForEach(HistoryQuery.statuses, id: \.self) {
                  Text($0.isEmpty ? "全部状态" : historyStatus($0)).tag($0)
                }
              }
            }
            HStack {
              Button("查询") { Task { await model.loadHistory(query) } }.buttonStyle(
                Primary(symbol: "magnifyingglass"))
              Button("当前营业日") {
                query = HistoryQuery()
                Task { await model.loadHistory() }
              }.buttonStyle(Primary(tone: .secondary, symbol: "calendar"))
            }
          }.disabled(model.busy)
          if !model.historyState.isEmpty { Text(model.historyState) }
          if let data = model.history {
            Text(
              data.businessDate + " 至 " + (data.endDate ?? data.businessDate)
                + " · 第\(data.page + 1)页"
            ).font(.subheadline)
            if query != model.historyQuery {
              Text("筛选已修改；下方仍为上次查询结果，请点击查询。").font(.caption).foregroundStyle(.orange)
            }
            if data.financialSummaryVisible != false {
              Foldout(title: "所选营业日 · 全店已入账资金") {
                Text("资金流水不受桌号、员工筛选影响；待确认支付不计入收款。").font(.caption)
                if let start = data.financialStartDate, start != data.businessDate {
                  Text("岗位资金可见范围自 " + start + " 起").font(.caption)
                }
                if let summary = data.summary {
                  Text(
                    "期间销售 " + money(Int(summary.orderAmountMinor)) + " · 当前尚待收款 "
                      + money(Int(summary.outstandingMinor)))
                  Text(
                    "未结\(summary.unsettledCount)单 · 待确认支付\(summary.pendingPaymentCount)笔 · 待处理退款\(summary.pendingRefundCount)笔"
                  ).font(.caption)
                }
                ForEach(Array(data.receipts.enumerated()), id: \.offset) { _, row in
                  Text(
                    row.provider + " · 收款 " + money(row.receivedMinor) + " · 退款 "
                      + money(row.refundedMinor) + " · 净收 " + money(row.netMinor))
                }
                if data.receipts.isEmpty { Text("所选期间没有已入账收退款流水；不代表没有待核对款项。").font(.caption) }
              }
            }
            ForEach(data.orders) { order in HistoryOrderCard(order: order) }
            if data.orders.isEmpty { Text("没有符合筛选条件的订单").foregroundStyle(.secondary) }
            HStack {
              Button("上一页") {
                Task { await model.loadHistory(model.historyQuery, page: data.page - 1) }
              }.disabled(model.busy || data.page == 0 || query != model.historyQuery)
              Spacer()
              Text("第\(data.page + 1)页")
              Spacer()
              Button("下一页") {
                Task { await model.loadHistory(model.historyQuery, page: data.page + 1) }
              }.disabled(model.busy || !data.hasMore || query != model.historyQuery)
            }.frame(minHeight: 44)
            HStack {
              Button("导出本页") {
                Task {
                  if let bytes = await model.exportHistory(all: false) {
                    exportDocument = HistoryCSVDocument(data: bytes)
                    exportName = "营业明细-\(data.businessDate)-第\(data.page+1)页"
                    exportVisible = true
                  }
                }
              }
              Spacer()
              Button("导出全部筛选结果") {
                Task {
                  if let bytes = await model.exportHistory(all: true) {
                    exportDocument = HistoryCSVDocument(data: bytes)
                    exportName = "营业明细-\(data.businessDate)-全部"
                    exportVisible = true
                  }
                }
              }
            }.disabled(model.busy || query != model.historyQuery || data.orders.isEmpty)
            Text("导出前重新读取同一筛选范围，最多5000单；系统保存窗口由你选择位置。").font(.caption)

          }
        }
      }.padding(16)
    }.background(paper).task {
      if model.history == nil { await model.loadHistory() }
      query = model.historyQuery
    }
    .fileExporter(
      isPresented: $exportVisible, document: exportDocument, contentType: .commaSeparatedText,
      defaultFilename: exportName
    ) { result in
      if case .failure(let error) = result { model.message = "导出未完成：" + error.localizedDescription }
      exportDocument = nil
    }
    .onChange(of: model.historyQuery) { _, value in query = value }
  }
}
private struct HistoryOrderCard: View {
  let order: LiveHistory.Order
  var body: some View {
    Foldout(
      title: order.tableCode + " · " + money(order.effectiveAmountMinor ?? order.totalMinor) + " · "
        + historyStatus(order.paymentStatus)
    ) {
      Text(order.publicId).textSelection(.enabled).font(.subheadline)
      Text(
        "桌次：" + (order.sessionPublicId ?? order.tableSessionId ?? "未留存") + " · "
          + (order.areaName ?? "")
      ).font(.caption)
      Text(
        order.submittedAt + " · " + (order.employeeName ?? "顾客自助") + " · "
          + historyStatus(order.status)
      ).font(.caption)
      if let amount = order.receivableIncreaseMinor, amount > 0 {
        Text("原应付 " + money(order.totalMinor) + " · 套餐补差 " + money(amount))
      }
      if let amount = order.stoppedAmountMinor, amount > 0 { Text("退菜减额 " + money(amount)) }
      ForEach(order.items) { item in
        VStack(alignment: .leading, spacing: 5) {
          Text(item.name + " ×\(item.quantity)").font(.headline)
          Text(
            item.includedInBundle == true
              ? "套餐内商品，不另收费"
              : "成交单价 " + money(item.unitPriceMinor) + " · 小计 " + money(item.totalMinor))
          Text(item.fulfillmentClosureNote ?? historyStatus(item.status)).font(.subheadline)
          if let q = item.quantities {
            Text(
              "暂停\(q.held) · 停止\(q.stopped) · 备齐\(q.ready) · 送达\(q.delivered) · 恢复库存\(item.returnedQuantity ?? 0) · 已耗不回库\(q.usedLoss)"
            ).font(.caption)
          }
          if let note = item.note, !note.isEmpty { Text("商品备注：" + note) }
          if let at = item.preparedAt {
            Text("制作完成：" + (item.preparedBy ?? "员工未留存") + " · " + at).font(.caption)
          }
          if item.status == "delivered" {
            Text(
              item.deliveredAt.map { "送达：" + (item.deliveredBy ?? "员工未留存") + " · " + $0 }
                ?? "历史送达凭据未留存"
            ).font(.caption)
          }
        }.padding(.vertical, 6)
      }
    }
  }
}
