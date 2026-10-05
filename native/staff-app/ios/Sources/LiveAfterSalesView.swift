import SwiftUI

struct AfterSalesCenterView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var itemID: String?
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text("跨营业日待办；资金和实物均处理完成才能闭环。打印完成不代表岗位已知悉。").font(.caption)
          if !model.afterSalesState.isEmpty { Text(model.afterSalesState) }
          ForEach(model.afterSalesPendingRows) { row in
            Button {
              itemID = row.orderItemId
            } label: {
              Card {
                Text(row.tableCode + " · " + row.productName).font(.headline)
                Text(row.businessDate + " · " + cashierStatus(row.status)).font(.caption)
                Text(
                  "资金：\(row.moneyComplete ? "已处理" : "待处理") · 实物：\(row.physicalComplete ? "已处理" : "待处理")"
                )
              }
            }.buttonStyle(.plain)
          }
          if model.afterSalesCursor != nil {
            Button("读取更多原售后") { Task { await model.loadAfterSalesPending(more: true) } }.disabled(
              model.busy)
          }
        }.padding(16)
      }.background(paper).navigationTitle("商品售后待办").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadAfterSalesPending() } }.disabled(model.busy)
          }
        }
    }.task { await model.loadAfterSalesPending() }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .sheet(
        isPresented: Binding(get: { itemID != nil }, set: { if !$0 { itemID = nil } }),
        onDismiss: { Task { await model.loadAfterSalesPending() } }
      ) { if let itemID { LiveAfterSalesView(itemID: itemID) } }
  }
}
struct LiveAfterSalesView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let itemID: String
  @State private var quantity = "1"
  @State private var reason = ""
  @State private var showFulfillment = false
  @State private var replacement: LiveReplacement?
  @State private var replacementError = ""
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !replacementError.isEmpty { Text(replacementError).foregroundStyle(.red) }
          if !model.afterSalesState.isEmpty { Text(model.afterSalesState).font(.caption) }
          if let board = model.afterSales, board.item.id == itemID,
            model.afterSalesActor == model.identity?.employee.id
          {
            Text(board.item.tableCode + " · " + board.item.name).font(.headline)
            Text(board.item.orderPublicId).font(.caption).textSelection(.enabled)
            Text("原商品\(board.item.quantity)份 · 原成交 " + money(board.item.originalAmountMinor)).font(
              .subheadline)
            if let unavailable = board.quantityEntryUnavailableReason {
              Text(unavailable).font(.caption).foregroundStyle(.orange)
            }
            if board.canRequest {
              Foldout(title: "申请暂停 / 退菜 · 可选\(board.available)份") {
                TextField("实际份数", text: $quantity).keyboardType(.numberPad).textFieldStyle(
                  .roundedBorder)
                TextField("实际原因（2—1000字）", text: $reason, axis: .vertical).textFieldStyle(
                  .roundedBorder)
                Text("提交后按份暂停；退款、免收或待核价由原成交与原款事实决定。").font(.caption)
                Button("核对份数并申请") {
                  do {
                    proposed = try model.prepareAfterSales(
                      action: "request", quantity: Int(quantity) ?? 0, reason: reason)
                  } catch { model.message = error.localizedDescription }
                }.buttonStyle(Primary(symbol: "pause.circle")).disabled(!model.canUseAfterSales)
              }
            }
            if board.supportsNativePhysicalRecovery == true {
              RemediationCards(board: board, proposed: $proposed)
              if !(board.remakes ?? []).isEmpty && model.canReadFulfillment {
                Button("到出品任务继续制作与取送") { showFulfillment = true }.buttonStyle(
                  Primary(tone: .secondary, symbol: "flame"))
              }
            } else {
              Text("服务器尚未启用安全补送与重做，请使用原网页流程。").font(.caption)
            }
            if let links = board.replacementOrders, !links.isEmpty {
              Foldout(title: "换品新单记录 · \(links.count)笔") {
                ForEach(links, id: \.orderId) { link in
                  Text(
                    link.publicId + " · "
                      + (link.status == "cancelled" ? "已取消" : cashierStatus(link.status))
                  ).font(.caption).textSelection(.enabled)
                }
                Text("包括取消后再次换品的旧记录。新单与原退款分别核对。").font(.caption)
              }
            }
            ForEach(board.cases) { row in
              AfterSalesCaseCard(board: board, row: row, proposed: $proposed) {
                do {
                  guard model.canUseAfterSales, let actor = model.identity else {
                    throw CatalogError("请刷新原商品和权限")
                  }
                  replacement = try LiveReplacement.make(board: board, caseID: row.id, actor: actor)
                  replacementError = ""
                } catch { replacementError = error.localizedDescription }
              }
            }
            if board.cases.isEmpty { Text("暂无原售后申请").font(.caption) }
          }
        }.padding(16)
      }.background(paper).navigationTitle("商品售后与补救").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadAfterSales(itemID) } }.disabled(model.busy)
          }
        }
    }.tint(ink).task { await model.loadAfterSales(itemID) }.onChange(of: model.workspaceVersion) {
      _, _ in dismiss()
    }
    .sheet(
      isPresented: $showFulfillment, onDismiss: { Task { await model.loadAfterSales(itemID) } }
    ) { LiveFulfillmentView() }
    .sheet(item: $replacement, onDismiss: { Task { await model.loadAfterSales(itemID) } }) {
      source in
      LiveCatalogView(session: source.session, tableCode: source.tableCode, replacement: source)
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].afterSalesProof?["confirmation"] as? String ?? "请核对原申请")
            Button("确认以上实际处理") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
        }
      }
    }
  }
}
private struct AfterSalesCaseCard: View {
  @EnvironmentObject var model: AppModel
  let board: LiveAfterSales
  let row: LiveAfterSales.Case
  @Binding var proposed: LiveCommand?
  var replace: () -> Void
  @State private var reason = ""
  @State private var count = "1"
  @State private var funding: [String: String] = [:]
  @State private var refundReferences: [String: String] = [:]
  @State private var unitIDs = Set<String>()
  func propose(_ action: String, refundID: String = "", confirmed: Bool = false) {
    do {
      var shares: [String: Int] = [:]
      if action == "approved" && row.requiresFundingChoice == true {
        for (id, text) in funding
        where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          guard let value = parseMoney(text) else { throw CatalogError("请输入有效的原付款退回金额") }
          shares[id] = value
        }
      }
      proposed = try model.prepareAfterSales(
        action: action, caseID: row.id, quantity: Int(count) ?? 0, reason: reason, funding: shares,
        unitIDs: unitIDs, refundID: refundID, confirmed: confirmed,
        receiptReference: refundReferences[refundID] ?? "")
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    Foldout(title: "\(row.businessDate) · \(row.selectedQuantity)份 · \(cashierStatus(row.status))")
    {
      Text(row.reason)
      if let link = row.replacementOrder {
        Text("换品新单：" + link.publicId + (link.status == "cancelled" ? " · 已取消" : " · 已建立，请在本桌订单处理"))
          .font(.caption).textSelection(.enabled)
        Text("原申请与新单分别结算；修改、撤回原申请不会取消新单。").font(.caption)
      }
      if row.canReplace == true && board.supportsNativeReplacementRecovery != true {
        Text("此门店尚未启用 App 换品恢复，请使用网页处理换品。").font(.caption)
      }
      if board.supportsNativeReplacementRecovery == true && row.canReplace == true
        && board.item.tableSessionId != nil
      {
        Button(row.replacementOrder == nil ? "换商品，另开新单" : "重新换品，另开新单", action: replace)
          .buttonStyle(Primary(tone: .secondary, symbol: "arrow.triangle.swap"))
          .disabled(!model.canUseAfterSales || model.identity?.allows("order.create") != true)
      }
      Text("原申请金额：" + (row.amountMinor.map(money) ?? "待核价"))
      Text(
        "资金\(row.moneyComplete ? "已处理" : "待处理") · 已退\(money(row.succeededMinor))\n实物暂停\(row.heldQuantity)份 · 已停止\(row.stoppedQuantity)份"
      ).font(.caption)
      if let pricing = row.pricing {
        Text(
          "\(pricing.policy == "broken_bundle" ? "套餐按保留商品下单时单点价重算" : "按原实收余额")；本次退款\(money(pricing.refundAmountMinor))，处理后应收\(money(pricing.effectiveAmountMinor))。不自动扣补款。"
        ).font(.caption)
      }
      if row.paymentAllocationReview == true || row.unpaidPaymentChanged == true {
        Text("原付款或分摊有变化，保持商品暂停，请先核对原款。").foregroundStyle(.orange)
      }
      if row.inventoryReviewQuantity > 0 {
        Text("\(row.inventoryReviewQuantity)份库存原记录待核对，未自动回库。").font(.caption)
      }
      if row.refundFailed || row.refundNeedsReview {
        Text("退款失败或结果待核对；不要重新申请相同退款。").font(.caption).foregroundStyle(.orange)
      }
      if let reason = row.resumeUnavailableReason { Text(reason).font(.caption) }
      if let replacement = row.revisedByCaseId {
        Text("本申请已修改，新申请：\(replacement)；减少份数不会自动继续。").font(.caption)
      }
      TextField("本次实际原因（2—1000字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if row.requiresFundingChoice == true {
        Text("按原付款分配本次退款").bold()
        ForEach(board.fundingSources) { source in
          Text(cashierProvider(source.provider) + " · 可退 " + money(source.availableMinor)).font(
            .caption)
          TextField(
            "此原款退回金额",
            text: Binding(get: { funding[source.id] ?? "" }, set: { funding[source.id] = $0 })
          ).keyboardType(.decimalPad).textFieldStyle(.roundedBorder)
        }
      }
      if row.canApprove {
        Button(row.kind == "unpaid_stop" ? "确认停止并免收" : "批准原退款") { propose("approved") }.buttonStyle(
          Primary(symbol: "checkmark.seal")
        ).disabled(!model.canUseAfterSales)
      }
      if row.canReject {
        Button("拒绝原申请") { propose("rejected") }.buttonStyle(
          Primary(tone: .secondary, symbol: "xmark.circle")
        ).disabled(!model.canUseAfterSales)
      }
      if row.canWithdraw {
        Button("撤回本人申请") { propose("withdrawn") }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.uturn.backward")
        ).disabled(!model.canUseAfterSales)
      }
      if row.canRevise == true {
        TextField("修改后的份数", text: $count).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
        Button("修改份数，重新审核") { propose("revision") }.buttonStyle(
          Primary(tone: .secondary, symbol: "square.and.pencil")
        ).disabled(!model.canUseAfterSales)
      }
      if row.canResume {
        Button("确认继续原商品") { propose("resume") }.buttonStyle(Primary(symbol: "play.circle"))
          .disabled(!model.canUseAfterSales)
      }
      if row.canResolveUnpaid {
        Button("原付款确认未收，继续停止减账") { propose("resolve-unpaid") }.buttonStyle(
          Primary(tone: .secondary, symbol: "doc.text.magnifyingglass")
        ).disabled(!model.canUseAfterSales)
      }
      ForEach(row.notices) { notice in
        Text(
          "\(notice.stationCode == "kitchen" ? "后厨" : "吧台")：\(notice.instruction) · \(notice.printState == "printed" ? "程序报已打印，仍需岗位确认" : "待打印或打印异常")"
        ).font(.caption)
      }
      if !row.notices.isEmpty && board.canAcknowledgeNotices {
        Button("已联系所示岗位，确认知悉") { propose("notice-ack", confirmed: true) }.buttonStyle(
          Primary(tone: .secondary, symbol: "bell.badge")
        ).disabled(!model.canUseAfterSales)
      }
      if (row.canDisposeMade ?? (row.status == "approved"))
        && (board.canReceive || board.canRecordUsed)
      {
        ForEach(board.held(row)) { unit in
          Toggle(
            "第\(unit.index)份 · \(unit.productionState == "unmade" ? "未制作" : "已制作")",
            isOn: Binding(
              get: { unitIDs.contains(unit.id) },
              set: { if $0 { unitIDs.insert(unit.id) } else { unitIDs.remove(unit.id) } }))
          if let reason = unit.returnEligibility?.reason { Text(reason).font(.caption) }
        }
        if board.canReceive {
          Button("所选实物已收回 / 未制作预留释放") { propose("returned_unopened", confirmed: true) }.buttonStyle(
            Primary(tone: .secondary, symbol: "shippingbox")
          ).disabled(!model.canUseAfterSales || unitIDs.isEmpty)
        }
        if board.canRecordUsed {
          Button("所选实物确已消耗，不回库") { propose("used_loss", confirmed: true) }.buttonStyle(
            Primary(tone: .danger, symbol: "exclamationmark.triangle")
          ).disabled(!model.canUseAfterSales || unitIDs.isEmpty)
        }
      }
      ForEach(row.refunds) { refund in
        Text(
          cashierProvider(refund.provider) + " · " + money(refund.amountMinor) + " · "
            + cashierStatus(refund.status)
        ).font(.caption)
        if refund.canRetry == true {
          Button("重试此笔已确认失败退款") { propose("refund-retry", refundID: refund.id) }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          ).disabled(!model.canUseAfterSales)
        }
        if board.canExecuteRefund && ["cash", "physical_pos", "external_manual"].contains(refund.provider)
          && ["approved", "processing"].contains(refund.status)
        {
          if refund.provider != "cash" {
            Text("先在原线下工具完成退款，再登记凭证；此操作不会替你扣款或退钱。").font(.caption)
            TextField("原退款凭证号（1—256字）", text: Binding(
              get: { refundReferences[refund.id] ?? "" },
              set: { refundReferences[refund.id] = $0 }
            )).textFieldStyle(.roundedBorder).disabled(model.busy)
          }
          Button("\(cashierProvider(refund.provider))\(money(refund.amountMinor))已实际退给客人") {
            propose(refund.provider == "cash" ? "cash-paid" : "manual-paid",
              refundID: refund.id, confirmed: true)
          }.buttonStyle(Primary(symbol: "banknote"))
            .disabled(!model.canUseAfterSales || (refund.provider != "cash"
              && !(1...256).contains((refundReferences[refund.id] ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)))
        }
      }
    }
  }
}

private struct RemediationCards: View {
  let board: LiveAfterSales
  @Binding var proposed: LiveCommand?
  var body: some View {
    if board.canRequestRedelivery == true {
      RemediationForm(
        title: "补送原实物", action: "request", maximum: board.redeliveryAvailableQuantity ?? 0,
        confirmation: "原实物仍在且可以交付，无需重新制作", proposed: $proposed)
    }
    ForEach(board.redeliveries ?? []) { row in
      Card {
        Text("补送 · \(row.selectedQuantity)份").font(.headline)
        Text(row.reason).font(.caption)
        Text(
          "已送\(row.deliveredQuantity) · 待送\(row.pendingQuantity) · 其中暂停\(row.pausedQuantity) · 已取消\(row.cancelledQuantity)"
        ).font(.caption)
        if row.active && board.canConfirmRedelivery == true && row.available > 0 {
          RemediationForm(
            title: "登记实际补送", action: "complete", target: row.id, maximum: row.available,
            confirmation: "所填份数已实际补送给客人", proposed: $proposed)
        }
        if row.active && board.canCancelRedelivery == true {
          RemediationForm(
            title: "取消剩余补送", action: "cancel", target: row.id, maximum: 0,
            confirmation: "仅取消本次尚未完成的补送，不退菜、不退款", proposed: $proposed)
        }
      }
    }
    if board.canManageRemake == true, let task = board.originalKdsTaskId,
      (board.firstRemakeAvailableQuantity ?? 0) > 0
    {
      RemediationForm(
        title: "按份重新制作", action: "remake", target: task,
        maximum: board.firstRemakeAvailableQuantity ?? 0,
        confirmation: "本批原实物无法直接补送，确需重新制作", proposed: $proposed)
    }
    ForEach(Array((board.remakes ?? []).enumerated()), id: \.element.id) { index, batch in
      Card {
        Text("重做第\(index + 1)批 · \(batch.total)份").font(.headline)
        Text(batch.reason).font(.caption)
        Text(
          "未制作\(batch.unmade) · 制作中\(batch.started) · 待送\(batch.ready) · 已送\(batch.delivered) · 已结束\(batch.cancelled) · 暂停\(batch.held)"
        ).font(.caption)
        Text("制作进度在出品任务中继续，备齐后由取餐岗位确认。").font(.caption)
        if board.canManageRemake == true && batch.successorAvailableQuantity > 0 {
          RemediationForm(
            title: "本批再次重做", action: "remake", target: batch.taskId,
            maximum: batch.successorAvailableQuantity,
            confirmation: "本批原实物无法直接补送，确需再次制作", proposed: $proposed)
        }
      }
    }
  }
}
private struct RemediationForm: View {
  @EnvironmentObject var model: AppModel
  let title, action: String
  var target = ""
  let maximum: Int
  let confirmation: String
  @Binding var proposed: LiveCommand?
  @State private var quantity = "1"
  @State private var reason = ""
  @State private var checked = false
  @State private var validationError = ""
  var body: some View {
    Foldout(title: title) {
      if action != "cancel" {
        TextField("实际份数（最多\(maximum)份）", text: $quantity).keyboardType(.numberPad).textFieldStyle(
          .roundedBorder)
      }
      TextField("实际原因（2—\(action == "remake" ? 500 : 1000)字）", text: $reason, axis: .vertical)
        .textFieldStyle(.roundedBorder)
      Toggle(confirmation, isOn: $checked)
      if !validationError.isEmpty { Text(validationError).font(.caption).foregroundStyle(.red) }
      Button("核对并" + title) {
        do {
          proposed = try model.prepareRemediation(
            action: action, target: target, quantity: Int(quantity) ?? 0, reason: reason,
            confirmed: checked)
          validationError = ""
          checked = false
        } catch { validationError = error.localizedDescription }
      }.buttonStyle(
        Primary(
          tone: action == "cancel" ? .danger : .secondary,
          symbol: action == "remake" ? "flame" : "shippingbox")
      )
      .disabled(!model.canUseAfterSales || !checked)
    }
  }
}
