import SwiftUI

struct LiveCollectionView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let session: String
  let tableCode: String
  @State private var showOnline = false
  @State private var selected: Set<String> = []
  @State private var provider = "cash"
  @State private var amount = ""
  @State private var tender = ""
  @State private var reference = ""
  @State private var terminal = ""
  @State private var method = "bank_transfer"
  @State private var note = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  private var total: Int {
    model.paymentOrders.filter { selected.contains($0.id) }.reduce(0) {
      $0 + $1.outstandingAmountMinor
    }
  }
  private var providers: [(String, String, String)] {
    [
      ("cash", "现金", "payment.manual.cash.record"),
      ("physical_pos", "实体POS", "payment.manual.pos.record"),
      ("external_manual", "外部收款", "payment.manual.external.record"),
    ]
  }
  var body: some View {
    NavigationStack {
      Form {
        if !model.paymentState.isEmpty { Text(model.paymentState) }
        LivePendingView()
        if model.identity?.allows("payment.initiate.staff") == true {
          Button("扫码 / 展示付款码 · 线上收款") { showOnline = true }.buttonStyle(Primary(symbol: "qrcode"))
        }
        Section("选择本次收款订单") {
          ForEach(model.paymentOrders) { order in
            Button {
              if selected.contains(order.id) {
                selected.remove(order.id)
              } else {
                selected.insert(order.id)
              }
              amount = String(format: "%.2f", Double(total) / 100)
            } label: {
              HStack {
                VStack(alignment: .leading, spacing: 5) {
                  Text(order.publicId).font(.subheadline)
                  Text(
                    "应收 "
                      + (order.currency == "CNY"
                        ? money(order.outstandingAmountMinor) : order.currency + " · 请到收银台处理"))
                  if order.hasOnlinePaymentInProgress || order.unresolvedOnlinePaymentId != nil {
                    Text("原线上付款待确认，暂不能重复收款").font(.caption).foregroundStyle(.orange)
                  } else if order.outstandingAmountMinor == 0 {
                    Text("当前无应收").font(.caption)
                  }
                }
                Spacer()
                Image(systemName: selected.contains(order.id) ? "checkmark.circle.fill" : "circle")
              }
            }.disabled(
              !order.selectable || model.busy || model.livePending != nil
                || model.liveOrderPending != nil)
          }
        }
        if !selected.isEmpty {
          Section("登记已经收到的款项") {
            Text("已选 \(selected.count) 笔 · 应收 " + money(total)).font(.headline)
            Picker("收款方式", selection: $provider) {
              ForEach(providers.filter { model.identity?.allows($0.2) == true }, id: \.0) {
                Text($0.1).tag($0.0)
              }
            }
            TextField("本次登记金额，可部分收款", text: $amount).keyboardType(.decimalPad)
            if provider == "cash" {
              TextField("实际收到现金", text: $tender).keyboardType(.decimalPad)
              if let cash = parseMoney(tender), let due = parseMoney(amount), cash >= due {
                Text("找零 " + money(cash - due)).foregroundStyle(ink)
              }
              Text("只有本次登记金额计入已收；找零不计入收款。").font(.caption)
            } else {
              TextField("原收款凭证号", text: $reference).autocorrectionDisabled()
              TextField("终端编号（如有）", text: $terminal).autocorrectionDisabled()
            }
            if provider == "external_manual" {
              Picker("外部收款方式", selection: $method) {
                Text("银行转账").tag("bank_transfer")
                Text("移动支付").tag("mobile_wallet")
                Text("储值凭证").tag("stored_value_voucher")
                Text("公司账户").tag("corporate_account")
                Text("其他").tag("other")
              }
              TextField("收款说明", text: $note, axis: .vertical)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("核对并登记已收款") {
              do {
                guard let value = parseMoney(amount), value > 0 else {
                  throw CatalogError("请输入正确的收款金额")
                }
                if provider == "cash" {
                  guard let received = parseMoney(tender), received >= value else {
                    throw CatalogError("实际收到现金不能少于本次登记金额")
                  }
                }
                proposed = try model.prepareCollection(
                  session: session, ids: selected, amount: value, provider: provider,
                  reference: reference, terminal: terminal, method: method, note: note)
                error = ""
              } catch { self.error = error.localizedDescription }
            }.buttonStyle(Primary(symbol: "checkmark.seal.fill")).disabled(
              model.busy || model.paymentUpdated == nil || model.livePending != nil
                || model.liveOrderPending != nil)
          }
        }
      }.navigationTitle(tableCode + " · 收款").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadPaymentOrders(session) } }.disabled(model.busy)
          }
        }
    }.tint(ink)
      .sheet(
        isPresented: $showOnline, onDismiss: { Task { await model.loadPaymentOrders(session) } }
      ) { LiveOnlinePaymentView(session: session, tableCode: tableCode) }
      .task {
        if let first = providers.first(where: { model.identity?.allows($0.2) == true }) {
          provider = first.0
        }
        await model.loadPaymentOrders(session)
      }
      .confirmationDialog(
        proposed?.title ?? "确认收款",
        isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
        titleVisibility: .visible
      ) {
        if let command = proposed {
          Button("确认款项已收到，登记") {
            proposed = nil
            Task { await model.executeLive(command) }
          }
        }
      } message: {
        Text("请核对实际到账与原凭证。此操作登记真实收款，不会代替POS或银行扣款。")
      }
  }
}
