import SwiftUI

struct LiveFinanceView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var date = ""
  @State private var entryType = ""
  @State private var editing: String?
  @State private var note = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  @State private var cashierQuery: String?
  func openCashier(_ value: String) {
    guard value.utf16.count <= 64 else {
      error = "原凭证超过查询长度，请复制完整凭证并在收银按桌号核对"
      return
    }
    cashierQuery = value
  }
  func propose(row: String? = nil, resolve: Bool = false, closeDay: Bool = false) {
    do {
      proposed = try model.prepareFinance(
        rowID: row, note: note, resolve: resolve, closeDay: closeDay)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if !model.financeState.isEmpty { Text(model.financeState).font(.caption) }
          if model.identity?.allows("reconciliation.view") == true {
            HStack {
              TextField("营业日 YYYY-MM-DD，留空为当前", text: $date).textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
              Button("查询") {
                Task { await model.loadFinance(query: .init(date: date, type: entryType)) }
              }.disabled(model.busy)
            }
            Picker("流水类型", selection: $entryType) {
              Text("全部").tag("")
              Text("收款").tag("payment")
              Text("退款").tag("refund")
              Text("费用").tag("fee")
              Text("调整").tag("adjustment")
            }.pickerStyle(.segmented)
            if model.financeUpdated != nil
              && (entryType != model.financeQuery.type
                || (!date.isEmpty && date != model.financeQuery.date))
            {
              Text("筛选已更改，请点击查询更新结果。").font(.caption)
            }
            if let day = model.financeSummary, day.financialSummaryVisible != false {
              Card {
                Text("营业日 \(day.businessDate)").font(.headline)
                Text("净收 " + money(day.receipts.reduce(0) { $0 + $1.netMinor })).font(
                  .title2.bold())
                Text(
                  "收款 " + money(day.receipts.reduce(0) { $0 + $1.receivedMinor }) + " · 退款 "
                    + money(day.receipts.reduce(0) { $0 + $1.refundedMinor }))
                if let summary = day.summary {
                  Text(
                    "待收 " + (Int(summary.outstandingMinor).map(money) ?? "待核对")
                      + " · 未结 \(summary.unsettledCount)单"
                  ).font(.subheadline)
                  Text("待定付款 \(summary.pendingPaymentCount) · 待处理退款 \(summary.pendingRefundCount)")
                    .font(.caption)
                }
                ForEach(day.receipts, id: \.provider) { row in
                  Text(
                    cashierProvider(row.provider) + " · 收 " + money(row.receivedMinor) + " / 退 "
                      + money(row.refundedMinor)
                  ).font(.caption)
                }
                Text("06:00划分营业日。销售按订单营业日，收退款按资金入账营业日；未知支付不算到账。").font(.caption).foregroundStyle(
                  .secondary)
              }
            }
            Foldout(title: "已入账流水 · 当前已读\(model.financeEntries.count)条") {
              ForEach(model.financeEntries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                  Text(
                    (["payment": "收款 ", "refund": "退款 ", "fee": "费用 ", "adjustment": "调整 "][
                      entry.entryType] ?? "未知类型 ")
                      + (entry.currency == "CNY"
                        ? money(entry.amountMinor) : entry.currency + " \(entry.amountMinor)分")
                  ).bold()
                  Text(cashierProvider(entry.provider) + " · " + assignmentTime(entry.occurredAt))
                    .font(.caption)
                  Text(entry.providerReference).font(.caption).textSelection(.enabled)
                  Button("按原凭证核对") { openCashier(entry.providerReference) }.disabled(
                    !model.canReadCashier)
                }.padding(.vertical, 6)
              }
              if model.financeEntries.isEmpty && model.financeUpdated != nil {
                Text("当前已查询范围没有入账流水").font(.caption)
              }
              if model.financeNext != nil {
                Button("读取下一页流水") {
                  Task {
                    await model.loadFinance(reviewPage: model.financeReviewPage, moreEntries: true)
                  }
                }.disabled(model.busy)
              }
            }
            Text("财务异常跟进 · 第\(model.financeReviewPage + 1)页").font(.headline)
            Text("此列表包含跨营业日待核对款项，不受上方日期筛选限制。").font(.caption)
            ForEach(model.financeReviews) { row in
              Card {
                Text((row.tableCode ?? "待核对桌号") + " · " + cashierStatus(row.status)).font(.headline)
                Text(row.publicId).font(.caption).textSelection(.enabled)
                Text("原付款金额 " + (Int(row.amountMinor).map(money) ?? "待核对") + " · 不代表已到账").font(
                  .caption)
                Text("负责人：" + (row.ownerName ?? "待接手") + "\n" + (row.note ?? "尚无核对记录")).font(
                  .subheadline)
                if !(row.financialSignals ?? []).isEmpty {
                  Text("有财务异常信号，需核对原款与退款后处理。").font(.caption).foregroundStyle(.orange)
                }
                Button("打开原订单收银核对") { openCashier(row.orderPublicId ?? row.publicId) }.buttonStyle(
                  Primary(tone: .secondary, symbol: "magnifyingglass"))
                if model.identity?.allows("reconciliation.manage") == true {
                  if editing == row.id {
                    TextField("核对记录（3—1000字）", text: $note, axis: .vertical).textFieldStyle(
                      .roundedBorder)
                    Button("本人接手并保存进展") { propose(row: row.id) }.buttonStyle(
                      Primary(symbol: "person.crop.circle.badge.checkmark")
                    ).disabled(!model.canAct("reconciliation.manage"))
                    if row.canResolve {
                      Button("核对完成，结案") { propose(row: row.id, resolve: true) }.buttonStyle(
                        Primary(tone: .secondary, symbol: "checkmark.seal")
                      ).disabled(!model.canAct("reconciliation.manage"))
                    }
                    Button("取消编辑") {
                      editing = nil
                      note = ""
                    }
                  } else {
                    Button("记录核对进展") {
                      editing = row.id
                      note = row.note ?? ""
                    }.buttonStyle(Primary(tone: .secondary, symbol: "square.and.pencil"))
                  }
                }
              }
            }
            HStack {
              Button("上一页") {
                Task { await model.loadFinance(reviewPage: model.financeReviewPage - 1) }
              }.disabled(model.busy || model.financeReviewPage == 0)
              Spacer()
              Button("下一页") {
                Task { await model.loadFinance(reviewPage: model.financeReviewPage + 1) }
              }.disabled(model.busy || !model.financeMoreReviews)
            }
          }
          if model.identity?.allows("business_day.close") == true {
            Button("检查并结束上一营业日") { propose(closeDay: true) }.buttonStyle(
              Primary(symbol: "calendar.badge.checkmark")
            ).disabled(!model.canAct("business_day.close"))
          }
          if let receipt = model.financeReceipt, receipt.employeeID == model.identity?.employee.id {
            if let closure = receipt.closure {
              closureView(closure)
            } else {
              Text("财务核对记录已保存，已回读当前处理列表。").font(.caption)
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("日结与对账").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button("刷新") { Task { await model.loadFinance() } }.disabled(model.busy)
        }
      }
    }.tint(ink).task { await model.loadFinance(query: .init()) }
      .onChange(of: cashierQuery) { _, value in
        if value == nil { Task { await model.loadFinance() } }
      }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              Text(command.steps.first?.financeProof?["confirmation"] as? String ?? "请核对原操作")
              Button("确认提交") {
                proposed = nil
                Task { await model.executeLive(command) }
              }.buttonStyle(Primary(symbol: "checkmark")).disabled(
                !model.canAct(command.permission))
              Button("返回修改") { proposed = nil }
            }.padding(20)
          }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
        }
      }
      .sheet(
        isPresented: Binding(get: { cashierQuery != nil }, set: { if !$0 { cashierQuery = nil } })
      ) {
        NavigationStack {
          LiveCashierView(initialQuery: cashierQuery).toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("返回对账") { cashierQuery = nil } }
          }
        }
      }
  }
  @ViewBuilder func closureView(_ value: DayClosure) -> some View {
    Text(
      "结束处理回执 · 已关\(value.closedBusinessDayCount)日 / \(value.closedTableSessionCount)桌，待处理\(value.blockedTableSessionCount)桌"
    ).font(.headline)
    if value.businessDays.isEmpty { Text("没有等待结束的上一营业日").font(.caption) }
    ForEach(value.businessDays) { day in
      Text(day.businessDate + (day.status == "closed" ? " · 已结束" : " · 仍有未完成事项")).font(.subheadline)
      ForEach(day.blockers) { blocker in
        Foldout(title: blocker.tableCode + " · " + blocker.label + " \(blocker.count)项") {
          Text(blocker.resolution).font(.caption)
          ForEach(blocker.facts) { fact in
            Text(fact.title + " · " + fact.statusLabel).bold()
            Text(fact.reference).font(.caption).textSelection(.enabled)
            if let amount = fact.amountMinor { Text(money(amount)).font(.caption) }
            if let order = fact.orderPublicId {
              Button("核对原订单") { openCashier(order) }.disabled(!model.canReadCashier)
            }
          }
        }
      }
    }
  }
}
