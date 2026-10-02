import SwiftUI

struct LiveOrderCheckout: View {
  @EnvironmentObject var model: AppModel
  let session: String
  let tableCode: String
  var replacement: LiveReplacement? = nil
  @State private var gift = false
  @State private var reason = ""
  @State private var note = ""
  @State private var settlement = "table_tab"
  @State private var proposedIDs: [String]?
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      LivePendingView()
      if !model.message.isEmpty { Text(model.message).font(.caption).textSelection(.enabled) }
      if replacement == nil && model.identity?.allows("order.gift") == true {
        Toggle("整单赠送", isOn: $gift)
      }
      if gift {
        TextField("赠送原因（2—200字）", text: $reason).textFieldStyle(.roundedBorder)
      } else {
        Picker("结算方式", selection: $settlement) {
          Text("挂本桌账单").tag("table_tab")
          Text("先付款后出品").tag("immediate_payment")
        }.pickerStyle(.segmented)
        Text(settlement == "table_tab" ? "订单计入本桌，按门店规则进入出品。" : "订单创建后需在原订单收款；未支付不会进入出品。").font(
          .caption
        ).foregroundStyle(.secondary)
      }
      TextField("整单出品备注（最多500字）", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
      Text("最终商品状态、价格和赠送额度由门店系统再次核对。").font(.caption).foregroundStyle(.secondary)
      Button(replacement != nil ? "确认换品，建立新单" : (gift ? "确认赠送下单" : "提交订单")) {
        proposedIDs = model.liveDraft(session, replacement: replacement).map(\.id)
      }
      .buttonStyle(Primary(symbol: "checkmark.circle.fill"))
      .disabled(
        model.busy || model.livePending != nil || model.liveOrderPending != nil
          || model.liveStorageDamaged || model.draftStorageDamaged
          || model.liveDraft(session, replacement: replacement).isEmpty || note.utf16.count > 500
          || (gift
            && !(2...200).contains(
              reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count))
      )
    }
    .confirmationDialog(
      "确认提交 \(tableCode) 的订单？",
      isPresented: Binding(get: { proposedIDs != nil }, set: { if !$0 { proposedIDs = nil } }),
      titleVisibility: .visible
    ) {
      if let ids = proposedIDs {
        Button(gift ? "确认赠送" : "确认下单") {
          proposedIDs = nil
          Task {
            await model.submitLiveOrder(
              session: session, tableCode: tableCode, expectedDraftIDs: ids, gift: gift,
              reason: reason, note: note, settlement: settlement, replacement: replacement)
          }
        }
      }
    } message: {
      Text(
        (replacement?.explanation ?? "") + "本次共 \(proposedIDs?.count ?? 0) 份，将提交到门店。结果未确认前请勿重复操作。")
    }
  }
}
