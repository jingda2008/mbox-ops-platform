import SwiftUI

func cashierStatus(_ value: String) -> String {
  [
    "created": "已创建，未确认到账", "pending": "款项待确认", "succeeded": "已成功", "failed": "失败",
    "closed": "本地已关闭", "partially_refunded": "部分退款", "refunded": "已退款", "requested": "待复核",
    "approved": "已复核", "rejected": "已驳回", "processing": "处理中", "cancelled": "已取消",
  ][value] ?? historyStatus(value)
}
func cashierProvider(_ value: String) -> String {
  [
    "cash": "现金", "physical_pos": "实体POS", "external_manual": "其他线下", "postar": "星驿",
    "wechat": "微信", "simulation": "模拟通道",
  ][value] ?? value
}
struct LiveCashierView: View {
  @EnvironmentObject var model: AppModel
  var initialQuery: String? = nil
  @State private var voucherOrder: LiveCashier.Order?
  @State private var showVouchers = false
  @State private var printingOrder: LiveCashier.Order?
  @State private var showPrinting = false
  @State private var showCashHandover = false
  @State private var showFinance = false
  @State private var showAfterSales = false
  @State private var afterSalesItem: String?
  @State private var query = ""
  @State private var proposed: LiveCommand?
  @State private var collection: LiveCashier.Order?
  @State private var historical: LiveCashier.Order?
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        Heading(title: "收银", subtitle: "门店 · 原款与退款")
        LivePendingView()
        if model.canReadVouchers || model.canReadPrinting || model.canReadAfterSales
          || model.canReadFinance
        {
          Foldout(title: "收银工具 · 售后 / 团购 / 交接 / 票据") {
            if model.canReadVouchers {
              Button("团购券核销与原事项恢复") { showVouchers = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "ticket"))
            }
            if model.canReadPrinting {
              Button("票据与打印") { showPrinting = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "printer"))
            }
            if model.canReadAfterSales {
              Button("商品售后 · 跨日待办") { showAfterSales = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "arrow.uturn.backward"))
            }
            if model.canReadFinance {
              Button("现金盘点与双人交接") { showCashHandover = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "banknote"))
              Button("日结与对账 · 财务跟进") { showFinance = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "chart.bar.doc.horizontal"))
            }
          }
        }
        if !model.canReadCashier {
          Text("当前岗位没有收银工作台权限")
        } else {
          HStack {
            TextField("桌号或订单号，最多64字", text: $query).textFieldStyle(.roundedBorder)
            Button("查询") { Task { await model.loadCashier(query) } }.disabled(model.busy)
          }
          if !model.cashierState.isEmpty { Text(model.cashierState) }
          if let board = model.cashier {
            Text("营业日 \(board.businessDate) · 本次返回 \(board.orders.count)单").font(.subheadline)
            Text("最多显示100单，未结款与退款优先；更多历史请在订单页查询。").font(.caption).foregroundStyle(.secondary)
            if query.trimmingCharacters(in: .whitespacesAndNewlines) != model.cashierQuery {
              Text("筛选已更改，请点击查询更新结果。").font(.caption)
            }
            if board.orders.isEmpty { Text("当前查询没有收银记录") }
            if board.actions["canUseActivityCashier"] == true
              && !board.activityRegistrations.isEmpty
            {
              Foldout(title: "活动收银 · \(board.activityRegistrations.count)笔原报名") {
                ForEach(board.activityRegistrations) { registration in
                  ActivityCashierCard(registration: registration, proposed: $proposed)
                }
              }
            }
            ForEach(board.orders) { order in
              Foldout(title: order.tableCode + " · 应收 " + money(order.outstandingAmountMinor)) {
                Text(order.publicId).textSelection(.enabled).font(.subheadline)
                Text(
                  "原营业日：" + (order.businessDate ?? board.businessDate) + " · 桌次："
                    + (order.tableSessionId ?? "未留存")
                ).font(.caption)
                Text(
                  "当前订单应付 " + money(order.totalAmountMinor) + " · "
                    + historyStatus(order.paymentStatus))
                if order.overCollectedAmountMinor > 0 {
                  Text("已确认多收 " + money(order.overCollectedAmountMinor) + "，请核对原付款退款")
                    .foregroundStyle(.orange)
                }
                if order.tableSessionId != nil,
                  ["open", "closing"].contains(order.tableSessionStatus ?? ""),
                  LivePaymentOrder.permissions.contains(where: {
                    model.identity?.allows($0) == true
                  })
                {
                  Button("查看本桌应收 · 登记收款") { collection = order }.buttonStyle(
                    Primary(tone: .secondary, symbol: "creditcard")
                  ).disabled(model.busy)
                }
                if order.closedDebtRecovery?.status == "available" {
                  if board.actions["supportsGuardedClosedDebtCollection"] == true {
                    Button("登记历史欠款已收到") { historical = order }.buttonStyle(
                      Primary(tone: .secondary, symbol: "creditcard")
                    )
                    .disabled(
                      !LiveCashier.collectionMethods.keys.contains(where: {
                        model.canCollectHistorical($0)
                      }))
                  } else {
                    Text("历史补收需要服务器升级后开放，暂请使用网页原单处理。").font(.caption)
                  }
                }
                if model.canReadAfterSales {
                  ForEach(order.items) { item in
                    Button("处理原商品 · " + item.productName) { afterSalesItem = item.id }.buttonStyle(
                      Primary(tone: .secondary, symbol: "shippingbox"))
                  }
                }
                if model.canReadVouchers {
                  Button("关联原单核销团购券") { voucherOrder = order }.buttonStyle(
                    Primary(tone: .secondary, symbol: "ticket"))
                }
                if model.identity?.allows("order.bill.print") == true {
                  Button("账单与打印状态") { printingOrder = order }.buttonStyle(
                    Primary(tone: .secondary, symbol: "printer"))
                }
                UnpaidOrderControls(order: order, proposed: $proposed)
                CashierRecoveryControls(order: order, proposed: $proposed)
                ForEach(order.payments) { payment in
                  CashierPaymentCard(order: order, payment: payment, proposed: $proposed)
                }
                if order.payments.isEmpty { Text("尚无付款记录，不代表订单已结清。").font(.caption) }
              }
            }
          }
        }
      }.padding(16)
    }.background(paper).task {
      query = initialQuery ?? model.cashierQuery
      await model.loadCashier(query)
    }
    .sheet(
      isPresented: $showAfterSales,
      onDismiss: { Task { await model.loadCashier(model.cashierQuery) } }
    ) { AfterSalesCenterView() }
    .sheet(
      isPresented: Binding(
        get: { afterSalesItem != nil }, set: { if !$0 { afterSalesItem = nil } }),
      onDismiss: { Task { await model.loadCashier(model.cashierQuery) } }
    ) { if let afterSalesItem { LiveAfterSalesView(itemID: afterSalesItem) } }
    .sheet(
      isPresented: $showFinance, onDismiss: { Task { await model.loadCashier(model.cashierQuery) } }
    ) { LiveFinanceView() }
    .sheet(item: $historical, onDismiss: { Task { await model.loadCashier(model.cashierQuery) } }) {
      order in HistoricalCollectionView(order: order)
    }
    .sheet(isPresented: $showCashHandover) { LiveCashHandoverView() }
    .sheet(isPresented: $showVouchers) { LiveVouchersView() }
    .sheet(item: $voucherOrder) { order in
      LiveVouchersView(orderID: order.id, sessionID: order.tableSessionId)
    }
    .sheet(isPresented: $showPrinting) { LivePrintingView() }
    .sheet(item: $printingOrder) { order in
      LivePrintingView(orderID: order.id, sessionID: order.tableSessionId)
    }
    .sheet(item: $collection, onDismiss: { Task { await model.loadCashier(model.cashierQuery) } }) {
      order in
      if let session = order.tableSessionId {
        LiveCollectionView(session: session, tableCode: order.tableCode)
      }
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(
              command.steps.first?.activityProof?["confirmation"] as? String ?? command.steps.first?
                .cashierProof?["confirmation"] as? String
                ?? "申请不代表已退款。复核通过可能触发线上原路退款；线下结果只能按实际退付登记。未知结果必须核对原请求。")
            Button("确认以上原交易操作") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
          }.padding(20)
        }.background(paper).navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
          }
      }
    }
  }
}
private struct CashierPaymentCard: View {
  @EnvironmentObject var model: AppModel
  let order: LiveCashier.Order
  let payment: LiveCashier.Payment
  @Binding var proposed: LiveCommand?
  @State private var closeReason = ""
  @State private var refundDraft = false
  func propose(
    _ action: String, refundID: String = "", reason: String = "", reference: String = "",
    succeeded: Bool = true
  ) {
    do {
      proposed = try model.prepareCashier(
        orderID: order.id, paymentID: payment.id, action: action, refundID: refundID,
        reason: reason, reference: reference, succeeded: succeeded)
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Divider()
      Text(cashierProvider(payment.provider) + " · " + cashierStatus(payment.status)).font(
        .headline)
      Text(payment.publicId).font(.caption).textSelection(.enabled)
      Text(
        "本单分摊 " + money(payment.amountMinor) + " · 剩余可退 " + money(payment.remainingRefundableMinor)
          + " · 在途占用 " + money(payment.reservedRefundAmountMinor)
      ).font(.subheadline)
      if let reason = payment.retryReleaseReason { Text("原款保留待核对：" + reason).font(.caption) }
      if payment.provider == "postar" && model.cashier?.actions["canQueryOnlinePayment"] == true {
        Button("查询原付款渠道结果") { propose("payment-query") }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.clockwise")
        ).disabled(!model.canAct("reconciliation.view"))
      }
      if payment.provider == "postar" && ["created", "pending"].contains(payment.status)
        && model.cashier?.actions["supportsProviderClose"] == true
      {
        TextField("渠道关单原因（4—500字）", text: $closeReason, axis: .vertical).textFieldStyle(
          .roundedBorder)
        Button("核对渠道并关闭原付款") { propose("payment-close", reason: closeReason) }.buttonStyle(
          Primary(tone: .secondary, symbol: "xmark.shield")
        ).disabled(!model.canAct("reconciliation.view"))
      }
      if payment.remainingRefundableMinor > 0 && model.cashier?.actions["canRequestRefund"] == true
      {
        Button(
          payment.refunds.contains { ["failed", "rejected", "cancelled"].contains($0.status) }
            ? "重新核对原商品 · 申请退款" : "选择原商品 · 申请退款"
        ) { refundDraft = true }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.uturn.backward")
        ).disabled(!model.canAct("refund.request"))
      }
      ForEach(payment.refunds) { refund in
        CashierRefundCard(refund: refund, payment: payment) {
          action, reason, reference, succeeded in
          propose(
            action, refundID: refund.id, reason: reason, reference: reference, succeeded: succeeded)
        }
      }
    }.sheet(isPresented: $refundDraft) { CashierRefundDraft(order: order, payment: payment) }
  }
}
struct CashierRefundCard: View {
  @EnvironmentObject var model: AppModel
  let refund: LiveCashier.Refund
  let payment: LiveCashier.Payment
  let act: (String, String, String, Bool) -> Void
  @State private var decision = ""
  @State private var reference = ""
  var body: some View {
    Foldout(title: "退款 " + money(refund.amountMinor) + " · " + cashierStatus(refund.status)) {
      Text(refund.publicId).font(.caption).textSelection(.enabled)
      Text(refund.requestedByEmployeeName + " 发起 · " + refund.reason)
      if let purpose = refund.purpose { Text(refundPurposes[purpose] ?? purpose).font(.caption) }
      if let reason = refund.decisionReason { Text("复核说明：" + reason) }
      if let receipt = refund.receiptReference { Text("退款凭证：" + receipt).textSelection(.enabled) }
      if ["failed", "rejected", "cancelled"].contains(refund.status) {
        Text("该次退款未成功，原记录保留。刷新剩余可退金额后，从原付款重新申请并重新复核；在途退款不能这样重开。").font(.caption)
      }
      if refund.afterSalesCase != nil {
        Text("此笔关联商品售后，请打开本单“处理原商品”核对资金与实物进度。").font(.caption)
      } else {
        if refund.status == "requested" {
          if refund.requestedByEmployeeId == model.identity?.employee.id {
            Text("请交给另一名有退款复核权限和额度的员工。").font(.caption)
          } else if model.cashier?.actions["canApproveRefund"] == true {
            TextField("复核说明（2—1000字）", text: $decision, axis: .vertical).textFieldStyle(
              .roundedBorder)
            Button("复核通过") { act("approve", decision, "", true) }.buttonStyle(
              Primary(symbol: "checkmark.seal")
            ).disabled(!model.canAct("refund.approve"))
            Button("驳回申请") { act("reject", decision, "", true) }.buttonStyle(
              Primary(tone: .secondary, symbol: "xmark.circle")
            ).disabled(!model.canAct("refund.approve"))
          }
        }
        if refund.status == "approved"
          || (!payment.manual && refund.status == "processing"
            && refund.providerSubmissionState == "not_started")
        {
          Button(payment.manual ? "开始人工退款" : "提交原路退款") { act("execute", "", "", true) }.buttonStyle(
            Primary(symbol: "arrow.uturn.backward.circle")
          ).disabled(!model.canAct("refund.execute"))
        }
        if payment.manual && refund.status == "processing" {
          Text("先实际退付再登记；本操作不会自动转账。").font(.caption)
          if payment.provider != "cash" {
            TextField("独立退款凭证号", text: $reference).textFieldStyle(.roundedBorder)
          }
          Button("款项已实际退给客人 · 登记成功") { act("manual-result", "", reference, true) }.buttonStyle(
            Primary(symbol: "checkmark.circle")
          ).disabled(!model.canAct("refund.execute"))
          Button("本次未退付成功 · 登记失败") { act("manual-result", "", reference, false) }.buttonStyle(
            Primary(tone: .secondary, symbol: "xmark.circle")
          ).disabled(!model.canAct("refund.execute"))
        }
      }
      if payment.provider == "postar" && refund.status == "processing"
        && refund.providerSubmissionState != "not_started"
      {
        Text("线上退款等待渠道确认，不能手工标为成功。").font(.caption)
        Button("查询原退款结果") { act("refund-query", "", "", true) }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.clockwise")
        ).disabled(!model.canAct("refund.execute"))
      }
    }
  }
}
private struct CashierRefundDraft: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let order: LiveCashier.Order
  let payment: LiveCashier.Payment
  @State private var amounts: [String: String] = [:]
  @State private var reason = ""
  @State private var purpose = "price_adjustment"
  @State private var proposed: LiveCommand?
  @State private var error = ""
  var body: some View {
    NavigationStack {
      Form {
        Section("原付款 " + payment.publicId) {
          Text(order.tableCode + " · 剩余可退 " + money(payment.remainingRefundableMinor))
          Text("本操作提交退款申请，不自动停止出品或恢复库存。").font(.caption)
        }
        Section("用途与原商品") {
          Picker("退款用途", selection: $purpose) {
            ForEach(refundPurposes.keys.sorted(), id: \.self) { Text(refundPurposes[$0]!).tag($0) }
          }
          ForEach(payment.refundableItems) { item in
            VStack(alignment: .leading) {
              Text(item.productName + " · 可退 " + money(item.remainingRefundableMinor))
              if item.fundsOnly == true { Text("仅资金处理，不作为商品退货").font(.caption) }
              TextField(
                "本次退款金额，留空不选",
                text: Binding(get: { amounts[item.id] ?? "" }, set: { amounts[item.id] = $0 })
              ).keyboardType(.decimalPad)
            }
          }
          TextField("退款原因（2—1000字）", text: $reason, axis: .vertical)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          Button("核对退款申请") {
            do {
              var values: [String: Int] = [:]
              for (id, text) in amounts
              where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                guard let amount = parseMoney(text), amount > 0 else {
                  throw CatalogError("退款金额必须为有效金额，最多两位小数")
                }
                values[id] = amount
              }
              proposed = try model.prepareCashier(
                orderID: order.id, paymentID: payment.id, action: "request", amounts: values,
                reason: reason, purpose: purpose)
            } catch { self.error = error.localizedDescription }
          }.buttonStyle(Primary(symbol: "checkmark.seal")).disabled(!model.canAct("refund.request"))
        }
      }.navigationTitle("申请退款").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
      }
    }
    .confirmationDialog(
      proposed?.title ?? "确认退款申请",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button("确认原商品、金额与用途，提交申请") {
          proposed = nil
          Task {
            await model.executeLive(command)
            dismiss()
          }
        }
      }
    } message: {
      Text("用途：" + (refundPurposes[purpose] ?? purpose) + "\n原因：" + reason + "\n由另一名员工复核后才进入退款流程。")
    }
  }
}

private struct CashierRecoveryControls: View {
  @EnvironmentObject var model: AppModel
  let order: LiveCashier.Order
  @Binding var proposed: LiveCommand?
  @State private var reason = ""
  func propose(_ action: String, _ paymentID: String = "") {
    do {
      proposed = try model.prepareCashier(
        orderID: order.id, paymentID: paymentID, action: action, reason: reason)
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let authorization = order.recollectionAuthorization {
        Text("本单重新收款授权：" + money(authorization.amountMinor) + " · 到期 " + authorization.expiresAt)
          .font(.caption)
        Text("授权不代表已收款；使用前由服务器重新核对余额及有效期。").font(.caption)
      }
      if let recovery = order.closedDebtRecovery {
        Text(
          "历史桌次 · "
            + ([
              "available": "允许补收原欠款", "authorization_required": "需重新收款授权",
              "pending_payment": "原付款尚待核对", "permission_required": "需要历史欠款权限",
              "ineligible": "暂不满足补收条件", "settled": "已结清",
            ][recovery.status] ?? "请刷新核对")
        ).font(.caption)
      }
      if order.needsRecollection
        || !(order.closedDebtRecovery?.closableUnpresentedPayments ?? []).isEmpty
      {
        if model.cashier?.actions["canAuthorizeRecollection"] == true {
          TextField("授权或关闭原因（4—500字）", text: $reason, axis: .vertical).textFieldStyle(
            .roundedBorder)
          if order.needsRecollection {
            Button("客人同意再次支付 · 核对授权") { propose("recollect") }
              .buttonStyle(Primary(tone: .secondary, symbol: "checkmark.shield"))
              .disabled(!model.canAct("payment.recollect.authorize"))
          }
          if order.closedDebtRecovery?.status == "pending_payment" {
            ForEach(order.closedDebtRecovery?.closableUnpresentedPayments ?? [], id: \.paymentId) {
              scope in
              Text(
                "整笔 " + money(scope.totalAmountMinor) + " · "
                  + scope.orderPublicIds.joined(separator: "、")
              ).font(.caption)
              Button("核对并关闭历史未外送付款") { propose("close-history", scope.paymentId) }
                .buttonStyle(Primary(tone: .secondary, symbol: "xmark.shield"))
                .disabled(
                  !model.canAct("payment.recollect.authorize")
                    || ![
                      "payment.initiate.staff", "reconciliation.view", "payment.collect.all_tables",
                    ].allSatisfy { model.identity?.allows($0) == true })
            }
          }
        } else {
          Text("请交由具有重新收款授权权限的员工处理。").font(.caption)
        }
      }
    }
  }
}

private struct HistoricalCollectionView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let order: LiveCashier.Order
  @State private var provider = "cash"
  @State private var tender = ""
  @State private var reference = ""
  @State private var terminal = ""
  @State private var method = "bank_transfer"
  @State private var note = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      Form {
        LivePendingView()
        Section("原历史订单") {
          Text(order.tableCode + " · " + order.publicId)
          Text("原营业日：" + (order.closedDebtRecovery?.originalBusinessDate ?? ""))
          Text("本次全额补收 " + money(order.outstandingAmountMinor)).font(.headline)
          Text("只登记已实际收到的款项；保持原桌次关闭，不新增出品。本入口暂不支持部分补收。").font(.caption)
        }
        Section("实际收款凭证") {
          Picker("收款方式", selection: $provider) {
            ForEach(
              ["cash", "physical_pos", "external_manual"].filter {
                model.identity?.allows(LiveCashier.collectionMethods[$0]!.0) == true
              }, id: \.self
            ) { Text(LiveCashier.collectionMethods[$0]!.3).tag($0) }
          }
          if provider == "cash" {
            TextField("实际收到现金", text: $tender).keyboardType(.decimalPad)
            if let value = parseMoney(tender), value >= order.outstandingAmountMinor {
              Text("找零 " + money(value - order.outstandingAmountMinor))
            }
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
          Button("核对原单与实际到账") {
            do {
              proposed = try model.prepareHistoricalCollection(
                order: order, provider: provider, tender: parseMoney(tender), reference: reference,
                terminal: provider == "cash" ? "" : terminal, method: method, note: note)
              error = ""
            } catch { self.error = error.localizedDescription }
          }.buttonStyle(Primary(symbol: "checkmark.seal")).disabled(
            !model.canCollectHistorical(provider))
          Text("资料超过60秒或发生变化时，请关闭表单并重新查询原单；不要重复收取客人款项。").font(.caption)
        }
      }.navigationTitle("历史欠款补收").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
      }
    }.task {
      provider =
        ["cash", "physical_pos", "external_manual"].first(where: { model.canCollectHistorical($0) })
        ?? "cash"
    }.confirmationDialog(
      proposed?.title ?? "确认原单补收",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button("确认以上款项已收到，登记原单") {
          proposed = nil
          Task {
            await model.executeLive(command)
            dismiss()
          }
        }
      }
    } message: {
      Text(proposed?.steps.first?.cashierProof?["confirmation"] as? String ?? "")
    }
  }
}

private struct UnpaidOrderControls: View {
  @EnvironmentObject var model: AppModel
  let order: LiveCashier.Order
  @Binding var proposed: LiveCommand?
  @State private var editing = false
  @State private var reasonCode = ""
  @State private var note = ""
  private var settle: Bool { order.status == "cancelled" }
  private var permission: String { settle ? "order.settle_exception" : "order.cancel_unpaid" }
  var body: some View {
    if let receipt = order.settlementException {
      Text("已异常结清 " + money(receipt.settledAmountMinor) + " · 未生成实际收款").font(.caption)
    }
    if order.paymentStatus == "unpaid", model.identity?.allows(permission) == true,
      !settle
        || (order.outstandingAmountMinor > 0 && order.settlementException == nil
          && order.items.contains { $0.status == "delivered" })
    {
      if editing {
        Picker("处理原因", selection: $reasonCode) {
          if settle {
            Text("店长确认免单").tag("manager_comp")
            Text("确认无法收回").tag("uncollectible")
            if model.identity?.employee.roleCodes.contains("OWNER") == true {
              Text("测试数据清理（老板）").tag("test_cleanup")
            }
          } else {
            Text("客人离店未付款").tag("guest_left")
            Text("重复订单").tag("duplicate_order")
            Text("测试或跨日清理").tag("test_cleanup")
            Text("其他").tag("other")
          }
        }
        TextField("现场核对说明（4—500字）", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
        Text("不生成实际收款；已送达商品、库存和原营业日记录保留。在途款项必须先核对。").font(.caption)
        Button("核对原单并继续") {
          do {
            proposed = try model.prepareUnpaid(
              orderID: order.id, settle: settle, reasonCode: reasonCode, note: note)
          } catch { model.message = error.localizedDescription }
        }.buttonStyle(Primary(tone: .danger, symbol: "exclamationmark.triangle")).disabled(
          !model.canAct(permission))
        Button("取消编辑") {
          editing = false
          note = ""
        }
      } else {
        Button(settle ? "异常结清已送达未付款金额" : "处理未付款原订单") {
          reasonCode = settle ? "manager_comp" : "guest_left"
          editing = true
        }.buttonStyle(Primary(tone: .secondary, symbol: "doc.badge.gearshape")).disabled(
          !model.canAct(permission))
      }
    }
  }
}
