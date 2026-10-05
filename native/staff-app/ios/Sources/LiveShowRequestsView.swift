import SwiftUI

struct LiveShowRequestsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access = ""
  @State private var filter = "requested"
  @State private var board: ShowSongBoard?
  @State private var reading = false
  @State private var notice = ""
  @State private var selected: ShowSong?
  @State private var action = ""
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var receiptKey = ""
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + showPermissions.filter(actor.allows).joined(separator: ",") }
  private var active: Bool { !access.isEmpty && access == accessKey }
  private var ready: Bool { active && !reading && !model.busy && !model.heartbeatBusy && board?.enabled == true && board?.status == filter }
  private func load() async {
    reading = true; selected = nil; proposed = nil
    defer { reading = false }
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let key = accessKey, status = filter
      let data = try await model.readShow("/api/staff/song-requests" + (filter.isEmpty ? "" : "?status=" + filter))
      let capability = try await model.readShow("/api/staff/native-song-capabilities")
      let next = try ShowSongBoard(data: data, capability: capability, actor: actor, status: status)
      guard active, key == accessKey, filter == status else { return }
      board = next; notice = "已读取最新\(next.rows.count)条；服务端最多返回500条当前筛选记录。"
      if !next.enabled { notice += "当前服务未启用原生点歌原请求回执，仅可查看。" }
    } catch { board = nil; notice = error.localizedDescription }
  }
  private func clear() { board = nil; proposed = nil; selected = nil; notice = "" }
  private func propose(_ operation: () throws -> LiveCommand) {
    do { proposed = try operation(); confirmed = false; notice = "" } catch { notice = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          LivePendingView()
          if active {
            Picker("点歌状态", selection: $filter) { Text("全部状态").tag(""); ForEach(["requested", "confirming", "accepted", "paid", "performed", "rejected", "cancelled"], id: \.self) { Text(showSongStatuses[$0]!).tag($0) } }.pickerStyle(.menu)
            Button(reading ? "正在读取…" : "读取点歌队列") { Task { await load() } }.buttonStyle(Primary(symbol: "music.note.list")).disabled(reading || model.busy || model.heartbeatBusy)
            Text(notice).font(.subheadline)
            if filter != board?.status, board != nil { Text("筛选已变化，请读取新的队列后办理。").foregroundStyle(.orange) }
            if let receipt = model.showReceipt, receipt.kind == "song", receipt.employeeID == model.identity?.employee.id { Text(receipt.message).font(.subheadline) }
            if let board {
              if board.rows.isEmpty { Text("所查状态暂无点歌记录。") }
              ForEach(board.rows) { row in
                Card {
                  Text(row.title).font(.title3.bold())
                  Text((model.world.tables.first { $0.session == row.tableSessionID }.map { $0.code + " 桌" } ?? "历史桌次 " + String(row.tableSessionID.suffix(8))) + " · " + (showSongStatuses[row.status] ?? "待核对"))
                  if let amount = row.amount { Text("报价：" + showMinor(amount) + " " + row.row.text("currency")) }
                  if !row.row.text("note").isEmpty { Text(row.row.text("note")) }
                  Text("提交：" + showTime(row.row.text("createdAt"))).font(.caption)
                  if let actor = model.identity {
                    ForEach(row.actions(actor), id: \.self) { action in
                      Button(showSongActions[action]!) { self.action = action; selected = row; proposed = nil; notice = "" }.disabled(!ready)
                    }
                  }
                }
              }
            }
          } else { Text("账号或权限已变化，请重新进入。") }
        }.padding(16)
      }.background(paper).navigationTitle("演出点歌").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; receiptKey = model.showReceipt?.requestKey ?? ""; await load() }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: filter) { _, _ in selected = nil; proposed = nil }
      .onChange(of: model.busy) { _, busy in
        guard !busy, !reading, active, let receipt = model.showReceipt, receipt.kind == "song", receipt.requestKey != receiptKey else { return }
        receiptKey = receipt.requestKey; Task { await load() }
      }
      .sheet(isPresented: Binding(get: { selected != nil || proposed != nil }, set: { if !$0 { selected = nil; proposed = nil } })) {
        ZStack {
          if let row = selected, let board {
            NavigationStack {
              ScrollView {
                if !notice.isEmpty { Text(notice).foregroundStyle(.red).padding(16) }
                LiveShowRequestForm(board: board, row: row, action: action, usable: ready, propose: propose).padding(16)
              }.background(paper).navigationTitle(showSongActions[action] ?? "点歌办理").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { selected = nil; proposed = nil } } }
            }.opacity(proposed == nil ? 1 : 0).allowsHitTesting(proposed == nil).accessibilityHidden(proposed != nil)
          }
          if let command = proposed {
            ShowConfirmationView(command: command, active: active && ready, confirmed: $confirmed, close: { proposed = nil }, execute: { proposed = nil; selected = nil; Task { await model.executeLive(command) } })
          }
        }.tint(ink)
      }
  }
}
private struct LiveShowRequestForm: View {
  @EnvironmentObject var model: AppModel
  let board: ShowSongBoard, row: ShowSong, action: String, usable: Bool
  let propose: (() throws -> LiveCommand) -> Void
  @State private var reason = ""
  @State private var amount = ""
  @State private var evidence: [ShowPaymentEvidence] = []
  @State private var selected = ""
  @State private var notice = ""
  @State private var reading = false
  private func loadEvidence() async {
    reading = true; selected = ""; evidence = []
    defer { reading = false }
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let bytes = try await model.readShow("/api/staff/native-song-requests/" + row.id + "/payment-evidence")
      guard let rows = try showObject(bytes)["data"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      evidence = try rows.map { try ShowPaymentEvidence($0, request: row, actor: actor) }
      notice = evidence.isEmpty ? "没有符合条件的原付款，请先在收银工作台核对实际收款与对账状态。" : "已读取同桌次、同币种且金额等于报价的原凭证。"
    } catch { notice = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text(row.title).font(.headline)
      if action == "confirm" { TextField("报价（元），免费填写0", text: $amount).textFieldStyle(.roundedBorder).keyboardType(.decimalPad) }
      if action == "paid" {
        Text("只关联已收妥的原付款与对账凭证，不发起扣款。请当面核对该付款确实用于此点歌。").font(.subheadline)
        ForEach(evidence) { payment in
          Button {
            selected = payment.id
          } label: {
            HStack(alignment: .top) { Image(systemName: selected == payment.id ? "checkmark.circle.fill" : "circle"); VStack(alignment: .leading) { Text(payment.publicID + " · " + showMinor(payment.amount) + "元"); Text(showTime(payment.createdAt) + " · " + payment.provider).font(.caption) } }
          }.buttonStyle(.plain).disabled(!usable || reading)
        }
        Button(reading ? "正在读取…" : "重新读取原付款凭证") { Task { await loadEvidence() } }.disabled(reading || !usable)
        Text(notice).font(.subheadline)
      }
      TextField("处理说明（2至500字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      Button("下一步：核对原操作") {
        propose {
          guard let actor = model.identity else { throw StaffAPIError.invalid }
          return try board.command(actor: actor, row: row, action: action, reason: reason, amountText: amount, evidence: evidence.first { $0.id == selected })
        }
      }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!usable || reading || (action == "paid" && selected.isEmpty))
    }.task { if action == "paid" { await loadEvidence() } }
  }
}
