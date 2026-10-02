import SwiftUI

struct LiveBenefitsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State var search = ""
  @State var proposed: LiveCommand?
  @State var verified = false
  @State var error = ""
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.benefitState).font(.caption).foregroundStyle(.secondary)
          Button("刷新兑付队列") { Task { await model.loadBenefits() } }
            .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
          TextField("搜索桌号、会员号或权益名称", text: $search).textFieldStyle(.roundedBorder)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let board = model.benefitBoard {
            if !board.durable { Text("服务端尚未支持安全兑付，请先使用现有营业入口。") }
            if !board.snacksEnabled { Text("每日点心服务未启用").font(.caption) }
            let rows = board.rows.filter {
              search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || ($0.tableCode + " " + $0.memberNo + " " + $0.title)
                  .localizedCaseInsensitiveContains(
                    search.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            .sorted {
              ($0.status == "reserved" ? 0 : 1, $0.expiresAt, $0.id) < (
                $1.status == "reserved" ? 0 : 1, $1.expiresAt, $1.id
              )
            }
            if rows.isEmpty { Text("当前范围没有权益兑付记录").foregroundStyle(.secondary) }
            ForEach(rows) { row in
              BenefitFulfillmentCard(row: row, enabled: model.canUseBenefits) {
                cancel, product, reason in
                do {
                  guard let actor = model.identity else { throw StaffAPIError.invalid }
                  proposed = try board.command(
                    rowID: row.id, cancel: cancel, product: product, reason: reason, actor: actor)
                  verified = false
                  error = ""
                } catch { self.error = error.localizedDescription }
              }
            }
          }
          Text("核销成功后，仍需在出品与取送工作台完成制作、送达；已核销异常请走权益履约异常处理。").font(.caption).foregroundStyle(
            .secondary)
        }.padding(16)
      }.background(paper).navigationTitle("权益兑付").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
      }.task { await model.loadBenefits() }
        .sheet(item: $proposed) { command in
          NavigationStack {
            ScrollView {
              VStack(alignment: .leading, spacing: 16) {
                Text(command.steps[0].memberProof?["confirmation"] as? String ?? "请核对原权益")
                Toggle("已当面核对会员、桌号、商品和份数", isOn: $verified)
                Button("确认执行") {
                  proposed = nil
                  Task { await model.executeLive(command) }
                }
                .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
                  !verified || !model.canExecuteLive(command))
              }.padding(20)
            }.navigationTitle(command.title).toolbar {
              ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
            }
          }
        }
    }
  }
}
private struct BenefitFulfillmentCard: View {
  let row: BenefitFulfillmentBoard.Row
  let enabled: Bool
  let propose: (Bool, String, String) -> Void
  @State var product = ""
  @State var reason = ""
  var body: some View {
    Card {
      HStack {
        Text(row.tableCode).font(.title3.bold())
        Spacer()
        Text(benefitStatusLabel(row.status)).font(.caption)
      }
      Text(row.title + " · \(row.quantity)份").font(.headline)
      Text(row.memberNo).font(.caption)
      if let status = row.fulfillment { Text("出品进度：" + benefitStatusLabel(status)).font(.caption) }
      if !row.expiresAt.isEmpty {
        Text("暂留至 " + reservationTime(row.expiresAt)).font(.caption).foregroundStyle(.secondary)
      }
      if row.status == "reserved" {
        if row.kind == "annual" {
          Picker("兑付商品", selection: $product) {
            Text("请选择商品").tag("")
            ForEach(row.products) { p in
              Text(p.name + (p.isOriginal ? " · 原商品" : " · 可替换")).tag(p.id)
            }
          }
        }
        TextField("替换或取消原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        Button("确认兑付") { propose(false, product, reason) }.buttonStyle(Primary(symbol: "gift"))
          .disabled(!enabled || !row.available || (row.kind == "annual" && product.isEmpty))
        Button("取消未核销暂留") { propose(true, "", reason) }.buttonStyle(
          Primary(tone: .secondary, symbol: "xmark.circle")
        )
        .disabled(!enabled || reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
      }
    }.onAppear { product = row.products.first(where: { $0.id == row.originalProductId })?.id ?? "" }
  }
}
