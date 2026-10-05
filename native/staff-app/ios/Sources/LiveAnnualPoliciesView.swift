import SwiftUI
private struct AnnualEditorSelection: Identifiable { let id = UUID(); let action: String; let row: AnnualPolicyRecord?; var rule: [String: Any]? = nil }
struct LiveAnnualPoliciesView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access: String?
  @State private var code = ""
  @State private var editor: AnnualEditorSelection?
  @State private var occurrences: AnnualPolicyRecord?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var error = ""
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + (["loyalty.annual-benefit.view"] + annualActions.keys.map(annualPermission)).filter(actor.allows).sorted().joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private func clear() { editor = nil; occurrences = nil; proposed = nil; confirmed = false; error = "" }
  private func load(cursor: String = "") { clear(); Task { await model.loadAnnualPolicies(code: code, cursor: cursor) } }
  private func propose(_ body: [String: Any], selection: AnnualEditorSelection) {
    do { guard current, let actor = model.identity, let board = model.annualPolicyBoard else { throw StaffAPIError.invalid }; proposed = try board.command(actor: actor, action: selection.action, body: body, row: selection.row); confirmed = false; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func allowed(_ action: String, _ row: AnnualPolicyRecord) -> Bool {
    guard let actor = model.identity, actor.allows(annualPermission(action)) else { return false }
    if action == "approve" { return row.text("status") == "draft" && row.text("draftedByEmployeeId") != actor.employee.id }
    if action == "publish" { return row.text("status") == "approved" && ![row.text("draftedByEmployeeId"), row.text("approvedByEmployeeId")].contains(actor.employee.id) }
    return true
  }
  private func card(_ row: AnnualPolicyRecord) -> some View {
    Card {
      Text(row.text("policyCode") + " · 第" + row.text("version") + "版").font(.headline)
      Text((annualStatuses[row.text("status")] ?? "待核对") + " · " + row.text("timezone"))
      Text("依据：" + row.text("reason")).font(.subheadline)
      if !row.text("effectiveFrom").isEmpty { Text("生效：" + membershipRecordTime(row.text("effectiveFrom")) + "\n截止：" + (row.text("effectiveUntil").isEmpty ? "长期" : membershipRecordTime(row.text("effectiveUntil")))).font(.caption) }
      DisclosureGroup("查看全部 \(row.rules.count) 条规则（含停用项）") {
        ForEach(Array(row.rules.enumerated()), id: \.offset) { _, rule in
          VStack(alignment: .leading, spacing: 8) {
            Text((try? annualRuleSummary(rule)) ?? "原规则待核对").font(.subheadline)
            if rule["ruleKind"] as? String == "festival" {
              Button("查看已确认节日日期") { occurrences = try? AnnualPolicyRecord(rule) }
              if rule["enabled"] as? Bool == true, allowed("occurrence", row) { Button("确认此节日的新年度日期") { editor = AnnualEditorSelection(action: "occurrence", row: row, rule: rule) }.disabled(!model.canUseAnnualPolicies) }
            }
            Divider()
          }
        }
      }
      if allowed("draft", row) {
        Button("复制完整规则为新版草稿") {
          clear(); code = row.text("policyCode")
          Task {
            let originalAccess = accessKey, workspace = model.workspaceVersion
            await model.loadAnnualPolicies(code: row.text("policyCode"), cursor: "")
            guard current, accessKey == originalAccess, model.workspaceVersion == workspace, model.canUseAnnualPolicies, model.annualPolicyBoard?.code == row.text("policyCode") else { return }
            editor = AnnualEditorSelection(action: "draft", row: row)
          }
        }.disabled(model.busy || model.heartbeatBusy)
      }
      ForEach(["approve", "publish"].filter { allowed($0, row) }, id: \.self) { action in Button(annualActions[action]!) { editor = AnnualEditorSelection(action: action, row: row) }.disabled(!model.canUseAnnualPolicies) }
    }
  }
  @ViewBuilder private var content: some View {
    Text("完整规则须经不同员工起草、审批和第三人发布，按未来生效时间执行。生日授权、库存和现场核验仍需满足；此页不直接发放礼遇。").font(.subheadline)
    Text(model.annualPolicyState).font(.caption)
    TextField("政策编号（大写，留空看全部）", text: $code).textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters)
    Button("读取 / 刷新") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
    if model.identity?.allows(annualPermission("draft")) == true {
      Button("新建此编号的下一版草稿") { editor = AnnualEditorSelection(action: "draft", row: nil) }.buttonStyle(Primary(symbol: "plus")).disabled(!model.canUseAnnualPolicies || code.isEmpty || model.annualPolicyBoard?.code != code)
    }
    if !error.isEmpty { Text(error).foregroundStyle(.red) }
    if let editor {
      if editor.action == "draft" { AnnualPolicyEditorView(code: code, original: editor.row, close: { self.editor = nil }, save: { propose($0, selection: editor) }).id(editor.id) }
      else { AnnualPolicyDecisionView(action: editor.action, rule: editor.rule, close: { self.editor = nil }, submit: { propose($0, selection: editor) }).id(editor.id) }
    }
    if let board = model.annualPolicyBoard {
      ForEach(board.rows) { card($0) }
      if board.rows.isEmpty { Text("当前范围没有政策版本。").foregroundStyle(.secondary) }
      HStack { Button("第一页") { load() }; if let next = board.nextCursor { Button("下一页") { load(cursor: next) } } }.disabled(model.busy || model.heartbeatBusy)
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView { LazyVStack(alignment: .leading, spacing: 12) { LivePendingView(); if current { content } }.padding(16) }.background(paper)
        .navigationTitle("年度权益配置").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadAnnualPolicies(code: "", cursor: "") }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }.onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in confirmation(command) }
      .sheet(item: $occurrences) { rule in AnnualOccurrencesView(rule: rule) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack { ScrollView { VStack(alignment: .leading, spacing: 16) {
      if current {
        Text(command.steps.first?.annualPolicyProof?["confirmation"] as? String ?? "请重新读取原政策")
        Toggle("已核对全部规则、日期、份数、履约条件及原因", isOn: $confirmed)
        Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseAnnualPolicies || !model.canExecuteLive(command))
      }
    }.padding(20) }.background(paper).navigationTitle("核对年度权益").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } } }.tint(ink)
  }
}
private struct AnnualPolicyDecisionView: View {
  @EnvironmentObject var model: AppModel
  let action: String, rule: [String: Any]?
  let close: () -> Void
  let submit: ([String: Any]) -> Void
  @State private var reason = ""
  @State private var from = ""
  @State private var until = ""
  @State private var year = String(Calendar.current.component(.year, from: Date()))
  @State private var start = ""
  @State private var end = ""
  @State private var reference = ""
  @State private var error = ""
  private func prepare() {
    do {
      var body: [String: Any] = ["reason": reason]
      if action == "publish" { body["effectiveFrom"] = try membershipDate(from); body["effectiveUntil"] = until.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : try membershipDate(until) as Any }
      if action == "occurrence" { guard let rule else { throw StaffAPIError.invalid }; body["ruleId"] = rule["id"]; body["cycleYear"] = try couponPolicyInteger(year, 2020...2200); body["startsOn"] = start; body["endsOn"] = end; body["confirmationReference"] = reference }
      submit(body); error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text(annualActions[action] ?? "核对原配置").font(.title3.bold())
      if action == "publish" {
        Text("以下时间按北京时间输入。必须安排未来生效；服务端将核对与上一已发布版本的衔接。").font(.caption)
        annualInput("生效时间（YYYY-MM-DD HH:mm:ss）", $from)
        annualInput("截止时间（留空长期）", $until)
      }
      if action == "occurrence" {
        Text(membershipText(rule?["title"]))
        annualInput("自然年（2020至2200）", $year)
        annualInput("开始日期（YYYY-MM-DD）", $start)
        annualInput("结束日期（YYYY-MM-DD）", $end)
        annualInput("已核对的节日日期依据", $reference)
        Text("同一规则同一年只能确认一次，不会提前发放或取消原权益。").font(.caption)
      }
      annualInput("实际操作原因（2至500字）", $reason)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对完整配置", action: prepare).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseAnnualPolicies)
      Button("返回列表", action: close)
    }
  }
}
private struct AnnualOccurrencesView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let rule: AnnualPolicyRecord
  @State private var rows: [AnnualPolicyRecord] = []
  @State private var next: String?
  @State private var loading = false
  @State private var loaded = false
  @State private var error = ""
  private func load(cursor: String = "") {
    guard !loading else { return }; loading = true
    Task {
      defer { loading = false }
      do { let page = try await model.readAnnualOccurrences(ruleId: rule.id, cursor: cursor); rows = page.rows; next = page.nextCursor; loaded = true; error = "" }
      catch { self.error = error.localizedDescription }
    }
  }
  var body: some View {
    NavigationStack { ScrollView { LazyVStack(alignment: .leading, spacing: 12) {
      Text(rule.text("title")).font(.headline)
      Button("刷新第一页") { load() }.disabled(loading)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if loading { ProgressView("读取节日日期") }
      if loaded && rows.isEmpty { Text("当前页尚无已确认日期。") }
      ForEach(rows) { row in Card { Text(row.text("cycleYear") + "年 · " + row.text("startsOn") + " 至 " + row.text("endsOn")); Text(row.text("confirmationReference")); Text("确认时间：" + membershipRecordTime(row.text("confirmedAt"))).font(.caption) } }
      if let next { Button("下一页") { load(cursor: next) }.disabled(loading) }
    }.padding(16) }.background(paper).navigationTitle("已确认节日日期").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } } }.tint(ink).task { load() }
  }
}
