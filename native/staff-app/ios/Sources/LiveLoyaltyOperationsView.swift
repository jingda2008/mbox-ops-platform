import SwiftUI
struct LiveBenefitExceptionsView: View { var body: some View { LiveLoyaltyOperationsView(kind: .benefit) } }
struct LiveLoyaltySupplementsView: View { var body: some View { LiveLoyaltyOperationsView(kind: .supplement) } }
struct LiveLoyaltyOperationsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let kind: LoyaltyOperationKind
  @State private var access: String?
  @State private var section = "reconciliation"
  @State private var query = ""
  @State private var selected: LoyaltyOperationRecord?
  @State private var action = ""
  @State private var reason = ""
  @State private var reference = ""
  @State private var completed = false
  @State private var confirmed = false
  @State private var error = ""
  @State private var proposed: LiveCommand?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + [kind.readPermission, "loyalty.accrual.request", "loyalty.accrual.approve"].filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private var board: LoyaltyOperationsBoard? { guard let board = model.loyaltyOperationsBoard, board.kind == kind, board.section == section, board.employeeID == model.identity?.employee.id else { return nil }; return board }
  private func clear() { selected = nil; proposed = nil; reason = ""; reference = ""; completed = false; confirmed = false }
  private func load(page: Int = 0) { clear(); Task { await model.loadLoyaltyOperations(kind: kind, section: section, page: page) } }
  private func pick(_ row: LoyaltyOperationRecord, _ action: String) { selected = row; self.action = action; reason = ""; reference = ""; completed = false; error = "" }
  private var intro: String {
    kind == .benefit ? "先核对厨房和现场实物。只有自动重试已停止的原零元礼遇，才能取消或登记已完成线下补偿；不能重复交付。" : "依据原订单、实际收退款和原积分规则核算。申请人不能审核自己的申请；有退款归属待核时须先完成退款复核。"
  }
  @ViewBuilder private var filter: some View {
    Text(intro).font(.subheadline)
    Text(model.loyaltyOperationsState).font(.caption)
    if kind == .supplement {
      Picker("查看", selection: $section) { Text("原订单对账").tag("reconciliation"); Text("申请与审核历史").tag("requests") }.pickerStyle(.menu)
      TextField("筛选本页订单或会员号", text: $query).textFieldStyle(.roundedBorder)
    }
    Button("刷新原记录") { load(page: board?.page ?? 0) }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
  }
  private func summary(_ row: LoyaltyOperationRecord) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if kind == .benefit {
        Text(row.text("tableCode") + "桌 · " + (row.text("title").isEmpty ? "原礼遇" : row.text("title"))).font(.headline)
        Text(row.text("orderPublicId"))
        Text((row.text("status") == "failed" ? "自动重试已停止" : "等待系统重试") + " · 已尝试 " + row.text("attemptCount") + "次")
        Text("最后异常：" + (row.text("lastErrorAt").isEmpty ? "时间未知" : membershipRecordTime(row.text("lastErrorAt")))).font(.caption)
        if !row.text("memberNo").isEmpty { Text("会员 " + row.text("memberNo")) }
        if !row.text("lastErrorCode").isEmpty { Text("异常原因代码：" + row.text("lastErrorCode")).font(.caption) }
      } else { supplementSummary(row) }
    }
  }
  @ViewBuilder private func supplementSummary(_ row: LoyaltyOperationRecord) -> some View {
    Text(row.text("orderPublicId")).font(.headline)
    Text(row.text("memberNo") + " · " + (supplementStatuses[row.text("status")] ?? "状态待核对"))
    if section == "reconciliation" {
      Text("符合积分条件的原货款 ¥" + walletMoneyText((try? row.integer("eligibleAmountMinor")) ?? 0))
      Text("原规则积分 " + row.text("expectedPoints") + " / 已记积分 " + row.text("existingPoints"))
      Text("原规则成长 " + row.text("expectedGrowth") + " / 已记成长 " + row.text("existingGrowth"))
      if let refunds = row.object["reviewRefundPublicIds"] as? [String], !refunds.isEmpty { Text("须先复核退款：" + refunds.joined(separator: "、")).foregroundStyle(.orange) }
    } else {
      Text("申请 " + row.id).font(.caption)
      Text("申请人 " + row.text("requestedByName") + " · " + membershipRecordTime(row.text("createdAt"))).font(.caption)
      Text("申请补积分 " + row.text("requestedPoints") + " · 成长 " + row.text("requestedGrowth"))
      Text(row.text("reason"))
      if !row.text("decisionReason").isEmpty { Text("审核：" + row.text("approvedByName") + " · " + row.text("decisionReason")) }
      if row.text("status") == "requested", row.text("requestedByEmployeeId") == model.identity?.employee.id { Text("等待其他授权员工独立审核。").font(.caption) }
    }
  }
  private var editor: some View {
    Card {
      if let row = selected {
        summary(row)
        Text((kind == .benefit ? benefitExceptionActions[action] : supplementActions[action]) ?? "请核对原操作").font(.headline)
        TextField("实际核对依据（2至500字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        if action == "external_compensation" {
          TextField("已完成线下补偿的原凭证编号", text: $reference).textFieldStyle(.roundedBorder)
          Toggle("已核对补偿实际完成；此处只登记，不自动付款或发券", isOn: $completed)
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("继续核对") {
          do {
            guard let board, let actor = model.identity else { throw StaffAPIError.invalid }
            proposed = try board.command(actor: actor, action: action, row: row, reason: reason, reference: reference, externallyCompleted: completed); confirmed = false; error = ""
          } catch { self.error = error.localizedDescription }
        }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseLoyaltyOperations)
        Button("收起") { selected = nil }
      }
    }
  }
  @ViewBuilder private var list: some View {
    if let board, let actor = model.identity {
      let rows = board.rows.filter { query.isEmpty || $0.text("orderPublicId").localizedCaseInsensitiveContains(query) || $0.text("memberNo").localizedCaseInsensitiveContains(query) }
      if rows.isEmpty { Text("当前页没有符合条件的记录。").foregroundStyle(.secondary) }
      ForEach(rows) { row in
        Card {
          summary(row)
          ForEach(board.actions(row: row, actor: actor), id: \.self) { action in
            Button((kind == .benefit ? benefitExceptionActions[action] : supplementActions[action])!) { pick(row, action) }.disabled(!model.canUseLoyaltyOperations)
          }
        }
      }
      Text("第\(board.page + 1)页，每页最多100条").font(.caption)
      HStack {
        if board.page > 0 { Button("上一页") { load(page: board.page - 1) } }
        if board.hasMore { Button("下一页") { load(page: board.page + 1) } }
      }.disabled(model.busy || model.heartbeatBusy)
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView { LazyVStack(alignment: .leading, spacing: 12) { LivePendingView(); if current { filter; if selected != nil { editor }; list } }.padding(16) }
        .background(paper).navigationTitle(kind.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadLoyaltyOperations(kind: kind, section: section, page: 0) }
      .onChange(of: section) { _, _ in load() }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }.onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in confirmation(command) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: 16) {
        if current {
          Text(command.steps.first?.loyaltyOperationProof?["confirmation"] as? String ?? "请重新读取原记录")
          Toggle("已核对原记录、现场事实和处理影响", isOn: $confirmed)
          Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseLoyaltyOperations || !model.canExecuteLive(command))
        }
      }.padding(20) }.background(paper).navigationTitle("确认原记录处理").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
    }.tint(ink)
  }
}
