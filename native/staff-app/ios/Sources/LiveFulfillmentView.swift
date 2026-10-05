import SwiftUI

struct LiveFulfillmentView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var proposed: LiveCommand?
  @State private var itemID: String?
  @State private var showKitchen = false
  @State private var showPickup = false
  @State private var filter = "all"
  @State private var showHistory = false
  @State private var showRemakeHandover = false
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if canReadFulfillmentHistory(model.identity) {
            Button("制作与送达历史") { showHistory = true }
          }
          if model.identity?.allows("refund.request") == true && (model.identity?.allows("inventory.receive") == true || model.identity?.allows("inventory.waste") == true) {
            Button("离店重做实物交接") { showRemakeHandover = true }
          }
          Picker("任务范围", selection: $filter) {
            Text("全部").tag("all")
            Text("异常").tag("failed")
            Text("跨日").tag("carryover")
          }.pickerStyle(.segmented)
          if !model.fulfillmentState.isEmpty { Text(model.fulfillmentState).font(.caption) }
          if let board = model.fulfillmentBoard,
            board.actor.employeeId == model.identity?.employee.id
          {
            let rows = board.workItems.filter {
              filter == "all" || (filter == "failed" ? $0.kdsStatus == "failed" : $0.carryover)
            }
            Text("\(rows.count)项任务 · 按原订单记录制作与取送").font(.caption)
            if rows.isEmpty { Text("当前范围没有待处理任务").foregroundStyle(.secondary) }
            ForEach(rows) { row in
              FulfillmentTaskCard(
                board: board, row: row, proposed: $proposed,
                openItem: { itemID = row.item.id }, openKitchen: { showKitchen = true },
                openPickup: { showPickup = true })
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("出品任务与异常").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadFulfillment() } }.disabled(model.busy)
          }
        }
    }.tint(ink).task { await model.loadFulfillment() }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .sheet(isPresented: $showKitchen, onDismiss: refresh) { LiveKitchenView() }
      .sheet(isPresented: $showPickup, onDismiss: refresh) { LivePickupView() }
      .sheet(isPresented: $showHistory) { LiveFulfillmentHistoryView() }
      .sheet(isPresented: $showRemakeHandover, onDismiss: refresh) { LiveRemakeHandoverView() }
      .sheet(
        isPresented: Binding(get: { itemID != nil }, set: { if !$0 { itemID = nil } }),
        onDismiss: refresh
      ) {
        if let itemID { LiveAfterSalesView(itemID: itemID) }
      }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              Text(command.steps[0].fulfillmentProof?["confirmation"] as? String ?? "请核对原任务")
              Button("确认以上实际操作") {
                proposed = nil
                Task { await model.executeLive(command) }
              }
              .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
                !model.canExecuteLive(command))
            }.padding(20)
          }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
            }
        }
      }
  }
  private func refresh() { Task { await model.loadFulfillment() } }
}
private struct FulfillmentTaskCard: View {
  @EnvironmentObject var model: AppModel
  let board: LiveFulfillment
  let row: LiveFulfillment.Row
  @Binding var proposed: LiveCommand?
  let openItem, openKitchen, openPickup: () -> Void
  @State private var quantity = "1"
  @State private var reason = ""
  @State private var checked = false
  @State private var validationError = ""
  func propose(_ action: String) {
    do {
      proposed = try model.prepareFulfillment(
        taskID: row.id, action: action, quantity: Int(quantity) ?? 0, reason: reason,
        confirmed: checked)
      validationError = ""
      checked = false
    } catch { validationError = error.localizedDescription }
  }
  var body: some View {
    Card {
      HStack {
        Text(row.table.code + " · " + row.item.productName).font(.headline)
        Spacer()
        Text(
          [
            "pending": "待制作", "accepted": "已接单", "preparing": "制作中", "ready": "已备齐", "failed": "异常",
          ][row.kdsStatus] ?? "待核对"
        ).font(.caption)
      }
      Text(
        (row.stationCode == "bar" ? "吧台" : "后厨") + " · " + row.businessDate
          + (row.carryover ? " · 前营业日遗留" : "")
      ).font(.caption)
      Text(row.order.publicId).font(.caption).textSelection(.enabled)
      if let q = row.quantities {
        Text(
          "未制作\(q.unmade) · 制作中\(q.started) · 已备齐\(q.ready) · 已送\(q.delivered) · 暂停\(q.held) · 停止\(q.stopped)"
        ).font(.caption)
      }
      if let note = row.item.note, !note.isEmpty { Text("商品备注：" + note) }
      if let note = row.order.note, !note.isEmpty { Text("整单备注：" + note) }
      if let failure = row.failureReason { Text(failure).foregroundStyle(.red) }
      ForEach(Array(row.attentionMessages.enumerated()), id: \.offset) { _, message in
        Text(message).font(.caption)
      }
      if model.canReadAfterSales {
        Button("商品售后 · 补送 / 重做") { openItem() }.buttonStyle(
          Primary(tone: .secondary, symbol: "shippingbox"))
      }
      if row.productionScreen != nil {
        Button("到对应制作批次处理") { openKitchen() }.buttonStyle(
          Primary(tone: .secondary, symbol: "flame"))
      }
      if row.canDeliver && board.usesPickup {
        Button("到取餐台核对实物") { openPickup() }.buttonStyle(
          Primary(tone: .secondary, symbol: "tray.and.arrow.up"))
      }
      if row.canPrepare && row.productionScreen == nil || row.canRemake || row.allowsManagerCancel && row.quantities == nil
        || row.canDeliver && !board.usesPickup
      {
        Foldout(title: "处理此任务") {
          if row.quantities != nil {
            TextField("本次实际份数", text: $quantity).keyboardType(.numberPad).textFieldStyle(
              .roundedBorder)
          } else {
            Text("旧流程按原任务整批 \(row.item.quantity)份确认。").font(.caption)
          }
          TextField("异常或主管处理原因（2—500字）", text: $reason, axis: .vertical).textFieldStyle(
            .roundedBorder)
          Toggle("已核对本桌、原商品、实际进度及本次操作", isOn: $checked)
          if !validationError.isEmpty { Text(validationError).font(.caption).foregroundStyle(.red) }
          if row.canPrepare && row.productionScreen == nil {
            if row.maximum("start") > 0
              && (row.quantities != nil || ["pending", "accepted"].contains(row.kdsStatus))
            {
              Button("开始实际制作") { propose("start") }.buttonStyle(Primary(symbol: "flame")).disabled(
                !model.canUseFulfillment || !checked)
            }
            Button("所填份数已实际备齐") { propose("complete") }.buttonStyle(
              Primary(symbol: "checkmark.circle")
            ).disabled(!model.canUseFulfillment || !checked)
            if row.quantities == nil {
              Button("登记制作异常") { propose("fail") }.buttonStyle(
                Primary(tone: .danger, symbol: "exclamationmark.triangle")
              ).disabled(!model.canUseFulfillment || !checked)
            }
          }
          if row.canRemake && row.quantities == nil {
            Button("按原异常重新制作") { propose("remake") }.buttonStyle(Primary(symbol: "arrow.clockwise"))
              .disabled(!model.canUseFulfillment || !checked)
          }
          if row.allowsManagerCancel && row.quantities == nil {
            Button("主管结束原制作任务") { propose("manager-cancel") }.buttonStyle(
              Primary(tone: .danger, symbol: "xmark.circle")
            ).disabled(!model.canUseFulfillment || !checked)
          }
          if row.canDeliver && !board.usesPickup {
            Button("确认已实际送达客桌") { propose("deliver") }.buttonStyle(
              Primary(symbol: "checkmark.circle")
            ).disabled(!model.canUseFulfillment || !checked)
          }
        }
      }
    }
  }
}
