import SwiftUI
private struct MarketingEditorSelection: Identifiable { let id = UUID(); let action: String; let row: MarketingRecord?; var decision: String = "" }
struct LiveMarketingView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var access: String?
  @State private var area = "notices"
  @State private var code = ""
  @State private var error = ""
  @State private var reason = ""
  @State private var editor: MarketingEditorSelection?
  @State private var customer: MarketingCustomerSelection?
  @State private var picker = false
  @State private var confirmed = false
  @State private var refused = false
  @State private var historyLoading = false
  @State private var history: MarketingHistoryPage?
  @State private var proposed: LiveCommand?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }; let permissions = marketingAreas.map(\.2) + ["marketing.notice.edit", "marketing.notice.approve", "marketing.notice.publish"]
    return actor.employee.id + ":" + actor.session.id + ":" + permissions.filter(actor.allows).sorted().joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private var areas: [(String, String, String)] { marketingAreas.filter { model.identity?.allows($0.2) == true } }
  private var queryArea: String { ["refusal", "audit"].contains(area) ? "workspace" : area }
  private func clear() { editor = nil; customer = nil; history = nil; proposed = nil; picker = false; confirmed = false; refused = false; reason = ""; error = "" }
  private func load(cursor: String = "") { clear(); Task { await model.loadMarketing(area: queryArea, code: area == "notices" ? code : "", cursor: cursor) } }
  private func propose(_ action: String, body: [String: Any], row: MarketingRecord? = nil) {
    do { guard current, let actor = model.identity, let board = model.marketingBoard else { throw StaffAPIError.invalid }; proposed = try board.command(actor: actor, action: action, body: body, row: row, customer: customer); confirmed = false; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func readHistory(cursor: String = "") {
    guard let customer, customer.purpose == "audit", !historyLoading else { return }
    historyLoading = true; let chosen = customer.row.id, access = accessKey, workspace = model.workspaceVersion
    Task {
      defer { historyLoading = false }
      do { let page = try await model.readMarketingHistory(customerId: chosen, reason: reason, cursor: cursor)
        guard current, access == accessKey, workspace == model.workspaceVersion, self.customer?.row.id == chosen, area == "audit" else { return }; history = page; error = ""
      } catch { if current && access == accessKey && self.customer?.row.id == chosen { self.error = error.localizedDescription } }
    }
  }
  private func copy(_ row: MarketingRecord) {
    clear(); code = row.text("code"); let originalAccess = accessKey, workspace = model.workspaceVersion
    Task { await model.loadMarketing(area: "notices", code: code, cursor: ""); guard current, accessKey == originalAccess, model.workspaceVersion == workspace, model.canUseMarketing, model.marketingBoard?.code == row.text("code") else { return }; editor = MarketingEditorSelection(action: "save", row: row) }
  }
  private func noticeCard(_ row: MarketingRecord, board: MarketingBoard) -> some View {
    Card {
      Text(row.text("code") + " · 第" + row.text("version") + "版 · " + (marketingStatuses[row.text("status")] ?? "待核对")).font(.headline)
      if let rule = row.object["rule"] as? [String: Any] { Text((try? marketingRuleSummary(rule)) ?? "告知内容待核对").font(.subheadline) }
      if model.identity?.allows("marketing.notice.edit") == true { Button("复制完整告知为下一版") { copy(row) }.disabled(model.busy || model.heartbeatBusy) }
      if let actor = model.identity { ForEach(board.decisionActions(actor: actor, row: row), id: \.self) { decision in Button(["approve": "独立审核", "publish": "第三人发布", "stop": "停止告知"][decision]!) { editor = MarketingEditorSelection(action: "decision", row: row, decision: decision); reason = "" }.disabled(!model.canUseMarketing) } }
      if row.text("status") == "published", model.identity?.allows("marketing.send") == true { Button("建立联系任务") { customer = nil; editor = MarketingEditorSelection(action: "queue", row: row) }.disabled(!model.canUseMarketing) }
    }
  }
  private func jobCard(_ row: MarketingRecord) -> some View {
    Card {
      Text(row.text("campaignKey")).font(.headline)
      Text("顾客：" + row.text("customerRef") + " · " + (marketingChannels.first { $0.0 == row.text("channel") }?.1 ?? "原渠道"))
      Text(marketingStatuses[row.text("status")] ?? "待核对")
      if !row.text("blockedReason").isEmpty { Text(marketingReasons[row.text("blockedReason")] ?? "暂不可发送，请核对原任务") }
      Text(row.text("content")).font(.subheadline)
      Text("截止：" + membershipRecordTime(row.text("expiresAt")) + " · 已核验 " + row.text("checks") + " 次").font(.caption)
      if ["queued", "blocked"].contains(row.text("status")) { Button("取消未发送的原任务") { editor = MarketingEditorSelection(action: "cancel", row: row); reason = "" }.disabled(!model.canUseMarketing) }
    }
  }
  @ViewBuilder private var editing: some View {
    if let editor {
      if editor.action == "save" { MarketingNoticeEditorView(code: code, source: editor.row, close: { self.editor = nil }, save: { propose("save", body: $0) }).id(editor.id) }
      else if editor.action == "queue", let row = editor.row { MarketingQueueFormView(row: row, customer: customer, pick: { picker = true }, close: { self.editor = nil; customer = nil }, submit: { propose("queue", body: $0, row: row) }).id(editor.id) }
      else { Card {
        Text(editor.action == "cancel" ? "取消未交给渠道的任务" : "核对原告知决定").font(.headline)
        Text(editor.row?.text(editor.action == "cancel" ? "campaignKey" : "code") ?? "原记录")
        annualInput("实际核对原因（2至500字）", $reason)
        Button("继续核对") { var b: [String: Any] = ["reason": reason]; if editor.action == "decision" { b["decision"] = editor.decision }; propose(editor.action, body: b, row: editor.row) }.disabled(!model.canUseMarketing)
        Button("返回列表") { self.editor = nil }
      } }
    }
  }
  @ViewBuilder private var customerActions: some View {
    if ["refusal", "audit"].contains(area) {
      Card {
        Text(customer.map { $0.row.text("name") + " · " + $0.row.text("code") } ?? "请选择准确的会员号或顾客编号")
        Button("选择顾客") { picker = true }.disabled(historyLoading || model.busy || model.heartbeatBusy)
        annualInput(area == "refusal" ? "顾客明确拒绝的说明" : "查询本人许可历史的依据", $reason)
        if area == "refusal" {
          Toggle("顾客已明确表达拒绝全部营销", isOn: $refused)
          Button("核对后记录全部拒绝") { if let customer { propose("refusal", body: ["customerId": customer.row.id, "reason": reason]) } }.disabled(customer == nil || !refused || !model.canUseMarketing)
        } else { Button("查询并记录审计") { history = nil; readHistory() }.disabled(customer == nil || historyLoading || !model.canUseMarketing) }
      }
      if historyLoading { ProgressView("正在读取原顾客许可历史") }
      if let history {
        ForEach(history.rows) { row in Card {
          Text(["granted": "本人同意", "withdrawn": "本人撤回", "denied": "本人拒绝", "stop_all": "停止全部营销"][row.text("action")] ?? "原许可动作").font(.headline)
          Text((marketingChannels.first { $0.0 == row.text("channel") }?.1 ?? "全部渠道") + " · " + (marketingPurposes.first { $0.0 == row.text("purpose") }?.1 ?? "全部用途"))
          Text(membershipRecordTime(row.text("createdAt")))
          if !row.text("validUntil").isEmpty { Text("许可截至：" + membershipRecordTime(row.text("validUntil"))) }
          Text(row.text("source") == "customer_self" ? "顾客自行操作" : "员工记录拒绝：" + row.text("actorName"))
          if !row.text("reason").isEmpty { Text(row.text("reason")) }
          if let notice = row.object["notice"] as? [String: Any] { Text(membershipText(notice["code"]) + " 第" + membershipText(notice["version"]) + "版\n" + membershipText(notice["summary"])) }
        } }
        if history.rows.isEmpty { Text("当前页没有许可历史。") }
        if let next = history.nextCursor { Button("下一页（继续记录查询依据）") { readHistory(cursor: next) }.disabled(historyLoading) }
      }
    }
  }
  @ViewBuilder private var content: some View {
    Text("本人同意由顾客自行选择，员工只能记录明确拒绝。联合活动仍由本店联系，不提供合作方名单；排队、渠道受理和送达是不同状态。").font(.subheadline)
    Text(model.marketingState).font(.caption)
    Picker("工作区", selection: $area) { ForEach(areas, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu).disabled(historyLoading || model.busy || model.heartbeatBusy).onChange(of: area) { _, _ in load() }
    if area == "notices" { annualInput("告知编号（大写，留空看全部）", $code) }
    Button("读取 / 刷新") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(historyLoading || model.busy || model.heartbeatBusy)
    if area == "notices", model.identity?.allows("marketing.notice.edit") == true { Button("新建此编号下一版告知") { editor = MarketingEditorSelection(action: "save", row: nil) }.disabled(!model.canUseMarketing || code.isEmpty || model.marketingBoard?.code != code) }
    if !error.isEmpty { Text(error).foregroundStyle(.red) }
    editing
    if let board = model.marketingBoard, board.area == queryArea {
      ForEach(board.rows) { row in if area == "notices" { noticeCard(row, board: board) } else if area == "jobs" { jobCard(row) } }
      if ["notices", "jobs"].contains(area) {
        if board.rows.isEmpty { Text("当前范围没有记录。").foregroundStyle(.secondary) }
        HStack { Button("第一页") { load() }; if let next = board.nextCursor { Button("下一页") { load(cursor: next) } } }.disabled(model.busy || model.heartbeatBusy)
      }
    }
    customerActions
  }
  var body: some View {
    NavigationStack { ScrollView { LazyVStack(alignment: .leading, spacing: 12) { LivePendingView(); if current { content } }.padding(16) }.background(paper).navigationTitle("营销告知与联系许可").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } } }.tint(ink)
      .task { access = accessKey; area = areas.first?.0 ?? "notices"; await model.loadMarketing(area: queryArea, code: "", cursor: "") }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }.onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }.onChange(of: scenePhase) { _, phase in if phase == .background { clear() } }
      .sheet(item: $proposed) { command in confirmation(command) }
      .sheet(isPresented: $picker) { MarketingCustomerPickerView(purpose: editor?.action == "queue" ? "send" : area, select: { customer = $0; history = nil; refused = false; picker = false }) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack { ScrollView { VStack(alignment: .leading, spacing: 16) {
      if current {
        Text(command.steps.first?.marketingProof?["confirmation"] as? String ?? "请重新读取原营销记录")
        Toggle("已核对原顾客、完整告知或任务内容及本次影响", isOn: $confirmed)
        Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseMarketing || !model.canExecuteLive(command))
      }
    }.padding(20) }.background(paper).navigationTitle("确认营销操作").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } } }.tint(ink)
  }
}
private struct MarketingCustomerPickerView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let purpose: String
  let select: (MarketingCustomerSelection) -> Void
  @State private var search = ""
  @State private var error = ""
  @State private var page: MarketingCustomerPage?
  @State private var loading = false
  private func load(cursor: String = "") { guard !loading else { return }; loading = true
    Task { defer { loading = false }; do { page = try await model.readMarketingCustomers(purpose: purpose, search: search, cursor: cursor); error = "" } catch { self.error = error.localizedDescription } }
  }
  var body: some View {
    NavigationStack { ScrollView { LazyVStack(alignment: .leading, spacing: 12) {
      annualInput("会员号或顾客编号（至少2字）", $search).disabled(loading).onChange(of: search) { _, _ in page = nil }
      Button("查询") { load() }.disabled(loading || search.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }; if loading { ProgressView("读取此用途可用的顾客") }
      if let page {
        ForEach(page.rows) { row in Button(row.text("name") + " · " + row.text("code")) { do { select(try page.selection(row: row)) } catch { self.error = error.localizedDescription } }.buttonStyle(.bordered).disabled(loading) }
        if page.rows.isEmpty { Text("当前查询没有匹配的会员号或顾客编号。") }
        if let next = page.nextCursor { Button("下一页") { load(cursor: next) }.disabled(loading) }
      }
    }.padding(16) }.background(paper).navigationTitle("选择准确顾客").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } } }.tint(ink)
  }
}
private struct MarketingQueueFormView: View {
  @EnvironmentObject var model: AppModel
  let row: MarketingRecord, customer: MarketingCustomerSelection?
  let pick: () -> Void, close: () -> Void, submit: ([String: Any]) -> Void
  @State private var channel: String
  @State private var purpose: String
  @State private var campaign = ""
  @State private var content = ""
  @State private var time = ""
  @State private var error = ""
  init(row: MarketingRecord, customer: MarketingCustomerSelection?, pick: @escaping () -> Void, close: @escaping () -> Void, submit: @escaping ([String: Any]) -> Void) {
    self.row = row; self.customer = customer; self.pick = pick; self.close = close; self.submit = submit
    let r = row.object["rule"] as? [String: Any] ?? [:]; _channel = State(initialValue: (r["channels"] as? [String])?.first ?? ""); _purpose = State(initialValue: (r["purposes"] as? [String])?.first ?? "")
  }
  private func choice(_ label: String, selection: Binding<String>, values: [(String, String)]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Menu {
        ForEach(values, id: \.0) { value, title in Button(title) { selection.wrappedValue = value } }
      } label: {
        HStack(alignment: .center, spacing: 8) {
          Text(values.first { $0.0 == selection.wrappedValue }?.1 ?? "请选择").fixedSize(horizontal: false, vertical: true)
          Image(systemName: "chevron.up.chevron.down")
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.accessibilityLabel(label).accessibilityValue(values.first { $0.0 == selection.wrappedValue }?.1 ?? "尚未选择")
    }
  }
  var body: some View {
    Card {
      Text("建立联系任务 · " + row.text("code") + " 第" + row.text("version") + "版").font(.headline)
      Text(customer.map { $0.row.text("name") + " · " + $0.row.text("code") } ?? "尚未选择顾客")
      Button("选择顾客", action: pick)
      choice("联系渠道", selection: $channel, values: marketingChannels.filter { ((row.object["rule"] as? [String: Any])?["channels"] as? [String] ?? []).contains($0.0) })
      choice("联系用途", selection: $purpose, values: marketingPurposes.filter { ((row.object["rule"] as? [String: Any])?["purposes"] as? [String] ?? []).contains($0.0) })
      annualInput("原活动批次（8至128位字母、数字或 : _ -）", $campaign)
      annualInput("准确发送内容（2至2000字）", $content)
      annualInput("任务截止（北京时间 YYYY-MM-DD HH:mm:ss）", $time)
      Text("保留原活动批次。服务端将核验本人许可、当前告知、渠道及频次；排队不表示已送达。结果未知不得新建批次重发。").font(.caption)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对") {
        do { guard let customer else { throw StaffAPIError.invalid }; submit(["customerId": customer.row.id, "channel": channel, "purpose": purpose, "campaignKey": campaign.trimmingCharacters(in: .whitespacesAndNewlines), "content": content, "expiresAt": try membershipDate(time)]); error = "" } catch { self.error = error.localizedDescription }
      }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(customer == nil || !model.canUseMarketing)
      Button("返回原告知", action: close)
    }
  }
}
