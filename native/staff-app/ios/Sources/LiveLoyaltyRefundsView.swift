import SwiftUI
private struct LoyaltyRefundEditor: Identifiable { let id = UUID(); let row: LoyaltyRefundRecord; let request: [String: Any]? }
struct LiveLoyaltyRefundsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access: String?
  @State private var query = ""
  @State private var editor: LoyaltyRefundEditor?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  private var accessKey: String { guard let a = model.identity else { return "" }; return a.employee.id + ":" + a.session.id + ":" + ["reconciliation.view", "reconciliation.manage", "loyalty.accrual.exception.view", "loyalty.accrual.request", "loyalty.accrual.approve"].filter(a.allows).joined(separator: ",") }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private func clear() { editor = nil; proposed = nil; confirmed = false }
  private func load(page: Int = 0) { clear(); Task { await model.loadLoyaltyRefunds(page: page) } }
  @ViewBuilder private var list: some View {
    if let board = model.loyaltyRefundBoard, board.employeeID == model.identity?.employee.id, let actor = model.identity {
      let rows = board.rows.filter { query.isEmpty || $0.text("orderPublicId").localizedCaseInsensitiveContains(query) || $0.text("refundPublicId").localizedCaseInsensitiveContains(query) }
      ForEach(rows) { row in
        Card {
          Text(row.text("orderPublicId") + " · " + (row.text("status") == "resolved" ? "已复核" : "待核对")).font(.headline)
          Text("退款 " + row.text("refundPublicId"))
          LoyaltyRefundGroupSummary(group: row.object)
          if !row.text("blockingRefundPublicId").isEmpty { Text("须先处理较早退款 " + row.text("blockingRefundPublicId")).foregroundStyle(.orange) }
          if canWriteLoyaltyRefunds(actor, action: "request"), row.text("status") == "pending" {
            Button("填写实际商品归属") { editor = LoyaltyRefundEditor(row: row, request: nil) }.buttonStyle(Primary(symbol: "list.bullet.clipboard")).disabled(!model.canUseLoyaltyRefunds || !board.canRequest(actor: actor, row: row))
          }
          ForEach(Array(row.rows("requests").enumerated()), id: \.offset) { _, request in
            Text("申请人 " + membershipText(request["requestedByName"]) + " · " + (loyaltyRefundRequestStatuses[membershipText(request["status"])] ?? "待核对")).font(.headline)
            Text(membershipText(request["reason"]))
            Text(membershipRecordTime(membershipText(request["createdAt"]))).font(.caption)
            if let reason = request["decisionReason"] as? String { Text("复核依据：" + reason) }
            Button("查看完整分配及复核") { editor = LoyaltyRefundEditor(row: row, request: request) }
          }
        }
      }
      if rows.isEmpty { Text("当前页没有符合条件的退款复核。").foregroundStyle(.secondary) }
      Text("第\(board.page + 1)页，每页最多100条").font(.caption)
      HStack { if board.page > 0 { Button("上一页") { load(page: board.page - 1) } }; if board.hasMore { Button("下一页") { load(page: board.page + 1) } } }.disabled(model.busy || model.heartbeatBusy)
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Text("核对已成功退款对应的原商品货款，服务端据此冲回原积分与成长值；不会再次退款。申请人不能审核自己的申请。").font(.subheadline)
            Text(model.loyaltyRefundState).font(.caption)
            TextField("筛选本页订单或退款编号", text: $query).textFieldStyle(.roundedBorder)
            Button("刷新原退款依据") { load(page: model.loyaltyRefundBoard?.page ?? 0) }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            if let editor { LoyaltyRefundFormView(row: editor.row, request: editor.request, close: { self.editor = nil }, propose: { proposed = $0; confirmed = false }).id(editor.id) }
            list
          }
        }.padding(16)
      }.background(paper).navigationTitle("退款积分复核").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadLoyaltyRefunds(page: 0) }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }.onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in confirmation(command) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: 16) {
        if current {
          Text(command.steps.first?.loyaltyRefundProof?["confirmation"] as? String ?? "请重新读取原退款")
          Toggle("已逐笔逐项核对金额、原货款归属和处理影响", isOn: $confirmed)
          Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseLoyaltyRefunds || !model.canExecuteLive(command))
        }
      }.padding(20) }.background(paper).navigationTitle("确认退款积分复核").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
    }.tint(ink)
  }
}
private struct LoyaltyRefundGroupSummary: View {
  let group: [String: Any]
  private func money(_ key: String) -> String { "¥" + walletMoneyText((try? walletInteger(group[key])) ?? 0) }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("退款总额 " + money("refundAmountMinor") + " · 其中溢收 " + money("excessAmountMinor"))
      Text("需分配原货款 " + money("salesRefundAmountMinor"))
      ForEach(Array((group["items"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, item in
        Text(membershipText(item["productName"]) + " · 原数量 " + membershipText(item["quantity"]) + " · 最多归属 ¥" + walletMoneyText((try? walletInteger(item["maxSalesReturnAmountMinor"])) ?? 0) + ((try? walletBoolean(item["loyaltyEligible"])) == true ? " · 参与积分" : " · 不参与积分")).font(.subheadline)
      }
    }
  }
}
private struct LoyaltyRefundFormView: View {
  @EnvironmentObject var model: AppModel
  let row: LoyaltyRefundRecord
  let request: [String: Any]?
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var values: [String: String] = [:]
  @State private var reason = ""
  @State private var decision = "reject"
  @State private var error = ""
  private var allowed: [String] { guard let actor = model.identity, let board = model.loyaltyRefundBoard, let request else { return [] }; return board.decisions(actor: actor, row: row, request: request) }
  private var canSubmit: Bool {
    guard model.canUseLoyaltyRefunds, let actor = model.identity, let board = model.loyaltyRefundBoard else { return false }
    return request == nil ? board.canRequest(actor: actor, row: row) : allowed.contains(decision)
  }
  private func submit() {
    do {
      guard let board = model.loyaltyRefundBoard, let actor = model.identity else { throw StaffAPIError.invalid }
      propose(try board.command(actor: actor, row: row, request: request, decision: decision, values: values, reason: reason)); error = ""
    } catch { self.error = error.localizedDescription }
  }
  private var allocationInputs: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(([row.object] + row.rows("historicalRefunds")).enumerated()), id: \.offset) { _, group in
        Text("退款 " + membershipText(group["refundPublicId"])).font(.headline)
        LoyaltyRefundGroupSummary(group: group)
        ForEach(Array((group["items"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, item in
          let key = membershipText(group["refundId"]) + ":" + membershipText(item["orderItemId"])
          TextField(membershipText(item["productName"]) + " · 退回货款（元，未涉及填0）", text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })).textFieldStyle(.roundedBorder)
        }
      }
    }
  }
  @ViewBuilder private var submitted: some View {
    if let request {
      Text((try? loyaltyRefundSubmittedSummary(row: row, request: request)) ?? "原分配信息待核对")
      if request["requestedByEmployeeId"] as? String == model.identity?.employee.id { Text("须由其他授权员工独立复核。").foregroundStyle(.secondary) }
      if !allowed.isEmpty {
        Picker("审核结论", selection: $decision) { ForEach(allowed, id: \.self) { Text($0 == "approve" ? "同意此分配" : "驳回重新核对").tag($0) } }.pickerStyle(.menu)
      }
      if ["stale", "superseded"].contains(membershipText(request["status"])) { Text("原依据已变化或已有更新申请，此处只能驳回，不能批准旧分配。").font(.caption) }
    }
  }
  var body: some View {
    Card {
      Text(request == nil ? "逐项填写原货款归属" : "核对已提交的完整分配").font(.title3.bold())
      Text(row.text("orderPublicId") + " · " + row.text("refundPublicId"))
      if request == nil { allocationInputs } else { submitted }
      TextField(request == nil ? "商品与退款核对依据（3至1000字）" : "独立复核依据（3至1000字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对", action: submit).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!canSubmit)
      Button("收起", action: close)
    }
  }
}
