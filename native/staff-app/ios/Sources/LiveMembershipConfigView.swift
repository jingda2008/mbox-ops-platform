import SwiftUI

struct LiveMembershipConfigView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var section = "rules"
  @State private var createDomain = ""
  @State private var filter = ""
  @State private var notice = ""
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var access: String?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + membershipConfigPermissions.filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access != nil && access == accessKey && !accessKey.isEmpty }
  private var sections: [String] { ["rules", "controls"].filter { model.identity?.allows($0 == "rules" ? "loyalty.configuration.view" : "loyalty.operations.view") == true } }
  private func clear() { createDomain = ""; proposed = nil; confirmed = false; notice = ""; filter = "" }
  private func propose(_ command: LiveCommand) { proposed = command; confirmed = false; notice = "" }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Picker("查看", selection: $section) {
              ForEach(sections, id: \.self) { Text($0 == "rules" ? "规则版本" : "运行控制").tag($0) }
            }.pickerStyle(.menu)
            Button("刷新规则与状态") { clear(); Task { await model.loadMembershipConfig(section: section, target: nil) } }
              .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            Text(model.membershipConfigState).font(.caption)
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            if let board = model.membershipConfigBoard, board.employeeID == model.identity?.employee.id, board.section == section {
              if section == "rules" { rules(board) }
              else {
                Text("暂停只影响选定能力，不撤回既有积分、权益或支付。计划复核时间不会自动恢复；恢复积分累积后仍须核对原订单。").font(.subheadline)
                ForEach(board.rows) { row in MembershipControlView(board: board, row: row, propose: propose).id(row.id + ":" + row.text("version")) }
              }
            }
          } else { Text("账号或会员规则权限已变化，请重新读取。") }
        }.padding(16)
      }.background(paper).navigationTitle("会员规则与运行控制").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink)
      .task { access = accessKey; section = sections.first ?? "rules"; await model.loadMembershipConfig(section: section, target: nil) }
      .onChange(of: section) { _, _ in clear(); if current { Task { await model.loadMembershipConfig(section: section, target: nil) } } }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if current, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.membershipConfigProof?["confirmation"] as? String ?? "请重新读取原规则")
                Toggle("已逐项核对规则、影响和当前岗位权限", isOn: $confirmed)
                Button("确认提交") { clear(); Task { await model.executeLive(command) } }
                  .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseMembershipConfig || !model.canExecuteLive(command))
              } else { Text("权限或账号已变化，确认内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle("核对会员规则操作").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
  @ViewBuilder private func rules(_ board: MembershipConfigBoard) -> some View {
    Text("所有编辑者都不能审批本人规则；发布人须与编辑者和审批人不同。已发布版本只读，调整须另起草稿。微信通知仅处理已有后台托管版本。").font(.subheadline)
    TextField("筛选规则名称", text: $filter).textFieldStyle(.roundedBorder)
    let choices = membershipDomainNames.keys.sorted().filter { domain in
      domain != "wechat_notifications" && (try? membershipPermission("create", domain: domain)).map { model.identity?.allows($0) == true } == true
    }
    if !choices.isEmpty {
      Picker("新建草稿", selection: $createDomain) {
        Text("请选择规则类型").tag("")
        ForEach(choices, id: \.self) { Text(membershipDomainNames[$0]!).tag($0) }
      }.pickerStyle(.menu)
    }
    if !createDomain.isEmpty {
      MembershipRuleEditorView(board: board, domain: createDomain, detail: nil, close: { createDomain = "" }, propose: propose).id("new:" + createDomain)
    }
    if createDomain.isEmpty, let detail = model.membershipConfigDetail {
      MembershipRuleEditorView(board: board, domain: detail.domain, detail: detail, close: { model.clearMembershipConfigDetail() }, propose: propose)
        .id(detail.configurationID + ":" + detail.draft.text("revision") + ":" + detail.draft.text("status"))
    }
    ForEach(board.rows.filter { filter.isEmpty || $0.text("title").localizedCaseInsensitiveContains(filter) || (membershipDomainNames[$0.text("domain")] ?? "").contains(filter) }) { row in
      Card {
        Text((membershipDomainNames[row.text("domain")] ?? "待核对") + " · 第\(row.text("version"))版").font(.headline)
        Text(row.text("title")); Text(membershipConfigStatuses[row.text("status")] ?? "待核对").font(.caption)
        if !row.text("effectiveFrom").isEmpty { Text("生效：" + membershipRecordTime(row.text("effectiveFrom"))).font(.caption) }
        if !row.text("effectiveUntil").isEmpty { Text("结束：" + membershipRecordTime(row.text("effectiveUntil"))).font(.caption) }
        Button("查看与处理此版本") {
          createDomain = ""
          Task { await model.loadMembershipConfig(section: "rules", target: row.text("domain") + "/" + row.id) }
        }.buttonStyle(Primary(tone: .secondary, symbol: "doc.text.magnifyingglass")).disabled(model.busy || model.heartbeatBusy)
      }
    }
    if board.rows.isEmpty { Text("尚无规则版本。").foregroundStyle(.secondary) }
  }
}
private struct MembershipRuleEditorView: View {
  @EnvironmentObject var model: AppModel
  let board: MembershipConfigBoard
  let domain: String
  let detail: MembershipConfigDetail?
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var editing: [String: Any]
  @State private var error: String
  @State private var reason = ""
  @State private var from = ""
  @State private var until = ""
  @State private var copying = false
  init(board: MembershipConfigBoard, domain: String, detail: MembershipConfigDetail?, close: @escaping () -> Void, propose: @escaping (LiveCommand) -> Void) {
    self.board = board; self.domain = domain; self.detail = detail; self.close = close; self.propose = propose
    do { _editing = State(initialValue: try detail.map { try membershipEditingContent($0.content) } ?? newMembershipContent(domain)); _error = State(initialValue: "") }
    catch { _editing = State(initialValue: [:]); _error = State(initialValue: "原规则字段暂不可解析，请刷新后核对：" + error.localizedDescription) }
  }
  private var creating: Bool { detail == nil || copying }
  private var status: String { creating ? "draft" : detail!.draft.text("status") }
  private func allowed(_ action: String) -> Bool { (try? membershipPermission(action, domain: domain)).map { model.identity?.allows($0) == true } == true }
  private var editable: Bool { status == "draft" && allowed(creating ? "create" : "edit") }
  private var unchanged: Bool { !creating && detail.flatMap { try? membershipEditingContent($0.content) }.map { membershipEqual($0, editing) } == true }
  private func submit(_ action: String) {
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let content = ["create", "edit"].contains(action) ? try membershipNormalizeContent(editing) : nil
      propose(try board.command(actor: actor, action: action, domain: domain, content: content, detail: detail,
        reason: reason, from: from, until: until)); error = ""
    } catch { self.error = error.localizedDescription }
  }
  private func copyDraft() {
    do {
      guard let detail else { return }
      var content = detail.content
      if domain == "redemption_catalog", let items = content["items"] as? [[String: Any]] {
        content["items"] = items.map { row in var next = row; next["publicId"] = "RDI-" + UUID().uuidString.lowercased(); next["status"] = "active"; return next }
      }
      editing = try membershipEditingContent(content); copying = true; reason = ""; error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text((membershipDomainNames[domain] ?? "会员规则") + " · " + (creating ? "新草稿" : membershipConfigStatuses[status] ?? "待核对")).font(.title3.bold())
      if creating { Text("默认值仅供起草，请逐项填写门店实际规则；保存不立即生效。").font(.caption) }
      MembershipFieldsView(content: editing, domain: domain, references: board.references, enabled: editable) { editing = $0 }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if ["draft", "approved"].contains(status) { TextField("修改、审批或发布依据（2—500字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder) }
      if editable { Button("核对并保存草稿") { submit(creating ? "create" : "edit") }.buttonStyle(Primary(symbol: "doc.badge.arrow.up")).disabled(!model.canUseMembershipConfig) }
      if !creating && status == "draft" {
        if !unchanged { Text("有未保存修改，请先保存，再生成影响预览或审批。").font(.caption) }
        if allowed("preview") { Button("生成服务器影响预览") { submit("preview") }.buttonStyle(Primary(tone: .secondary, symbol: "chart.bar.doc.horizontal")).disabled(!unchanged || !model.canUseMembershipConfig) }
        if let preview = detail?.preview {
          Text((try? membershipImpactSummary(preview)) ?? "影响预览数据不完整，请重新生成。").font(.subheadline)
          if allowed("approve") {
            let independent = !(detail?.makers.contains(model.identity?.employee.id ?? "") ?? true)
            let fresh = assignmentDate(preview.text("expiresAt")).map { $0 > Date() } == true
            Button(!independent ? "等待其他员工独立审批" : !fresh ? "预览已过期，请重新生成" : "核对影响后独立审批") { submit("approve") }
              .buttonStyle(Primary(symbol: "checkmark.seal")).disabled(!independent || !fresh || !unchanged || !model.canUseMembershipConfig)
          }
        }
      }
      if !creating && status == "approved" && allowed("publish") {
        TextField("生效时间（北京时间 YYYY-MM-DD HH:mm）", text: $from).textFieldStyle(.roundedBorder)
        if domain != "membership_terms" { TextField("结束时间（可留空，北京时间）", text: $until).textFieldStyle(.roundedBorder) }
        let summary = board.rows.first { $0.id == detail?.configurationID }
        let separate = !(detail?.makers.contains(model.identity?.employee.id ?? "") ?? true)
          && !(summary?.text("approvedByEmployeeId").isEmpty ?? true) && summary?.text("approvedByEmployeeId") != model.identity?.employee.id
        Button(separate ? "核对后正式发布" : "须由第三位授权员工发布") { submit("publish") }
          .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!separate || !model.canUseMembershipConfig)
      }
      if !creating && domain != "wechat_notifications" && allowed("create") {
        Button("以此内容起草新版本") { copyDraft() }.buttonStyle(Primary(tone: .secondary, symbol: "doc.on.doc")).disabled(!model.canUseMembershipConfig)
      }
      Button("收起详情", action: close)
    }
  }
}
private struct MembershipControlView: View {
  @EnvironmentObject var model: AppModel
  let board: MembershipConfigBoard
  let row: MembershipRecord
  let propose: (LiveCommand) -> Void
  @State private var reason = ""
  @State private var review = ""
  @State private var error = ""
  var body: some View {
    Card {
      Text(membershipControls[row.text("capability")] ?? "待核对").font(.headline)
      let paused = row.text("state") == "paused"
      Text(paused ? "已暂停" : "运行中")
      if !row.text("reason").isEmpty { Text("原说明：" + row.text("reason")).font(.caption) }
      if !row.text("reviewAt").isEmpty { Text("计划复核：" + membershipRecordTime(row.text("reviewAt"))).font(.caption) }
      Text("待核原积分订单：" + row.text("pendingAccrualCount")).font(.caption)
      if model.identity?.allows("loyalty.operations.control") == true {
        TextField("实际处理原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        if !paused { TextField("计划复核时间（可留空，北京时间）", text: $review).textFieldStyle(.roundedBorder) }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button(paused ? "核对后恢复此能力" : "暂停此项能力") {
          do {
            guard let actor = model.identity else { throw StaffAPIError.invalid }
            propose(try board.command(actor: actor, action: "control", control: row, reason: reason, reviewAt: review)); error = ""
          } catch { self.error = error.localizedDescription }
        }.buttonStyle(Primary(tone: .secondary, symbol: paused ? "play.circle" : "pause.circle")).disabled(!model.canUseMembershipConfig)
      }
    }
  }
}
