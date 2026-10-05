import SwiftUI
struct RecoveryEditor: Identifiable { let id = UUID(); let action: String; let row: RecoveryRecord? }
struct LiveMembershipRecoveryView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var access: String?
  @State private var history = false
  @State private var editor: RecoveryEditor?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + membershipRecoveryPermissions.filter(actor.allows).joined(separator: ",") }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private func clear() { editor = nil; proposed = nil; confirmed = false }
  private func load(cursor: String = "") { clear(); Task { await model.loadMembershipRecovery(history: history, cursor: cursor) } }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Text("先核验本人及原始会员凭据，再由另一位授权员工独立复核。合并保留原账户、积分和权益历史，不由此开启营销许可。").font(.subheadline)
            Text(model.membershipRecoveryState).font(.caption)
            Picker("查看", selection: $history) { Text("待处理").tag(false); Text("全部历史").tag(true) }.pickerStyle(.menu)
            Button("刷新原申请") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            if let board = model.membershipRecoveryBoard, board.employeeID == model.identity?.employee.id, board.history == history {
              if let editor { MembershipRecoveryForm(board: board, editor: editor, close: { self.editor = nil }, propose: { proposed = $0; confirmed = false }).id(editor.id) }
              if model.identity?.allows(membershipRecoveryPermissions[0]) == true {
                Button("登记人工核验的历史联系方式") { editor = .init(action: "contact", row: nil) }.buttonStyle(Primary(symbol: "person.crop.circle.badge.checkmark")).disabled(!model.canUseMembershipRecovery)
              }
              ForEach(board.rows) { row in
                Card {
                  Text(membershipRecoveryStatuses[row.text("status")] ?? "状态待核对").font(.headline)
                  Text("申请 " + row.id).font(.caption)
                  Text(row.text("maskedPhone") + " · " + row.text("candidateCount") + "个候选")
                  if !row.text("maskedMemberNo").isEmpty { Text("已选会员 " + row.text("maskedMemberNo")) }
                  Text("创建：" + membershipRecordTime(row.text("createdAt"))).font(.caption)
                  if row.text("status") == "manual_review", model.identity?.allows(membershipRecoveryPermissions[0]) == true {
                    Button("核验并选择会员候选") { editor = .init(action: "select", row: row) }.disabled(!model.canUseMembershipRecovery)
                  }
                  if row.text("status") == "pending_review", model.identity?.allows(membershipRecoveryPermissions[1]) == true {
                    let independent = row.text("selectedByEmployeeId") != model.identity?.employee.id
                    Button(independent ? "独立复核并合并" : "等待另一位授权员工独立复核") { editor = .init(action: "approve", row: row) }.disabled(!independent || !model.canUseMembershipRecovery)
                  }
                  if ["manual_review", "pending_review"].contains(row.text("status")), model.identity?.allows(membershipRecoveryPermissions[1]) == true {
                    Button("驳回申请并保留依据", role: .destructive) { editor = .init(action: "reject", row: row) }.disabled(!model.canUseMembershipRecovery)
                  }
                }
              }
              if board.rows.isEmpty { Text("当前页没有符合条件的申请。").foregroundStyle(.secondary) }
              HStack { Button("回到第一页") { load() }; if let cursor = board.nextCursor { Button("下一页") { load(cursor: cursor) } } }.disabled(model.busy || model.heartbeatBusy)
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("历史会员找回与合并").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadMembershipRecovery(history: history, cursor: "") }
      .onChange(of: history) { _, _ in if current { load() } }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if current, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.membershipRecoveryProof?["confirmation"] as? String ?? "请重新读取原申请")
                Toggle("已核对本人、原始凭据及本次操作影响", isOn: $confirmed)
                Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseMembershipRecovery || !model.canExecuteLive(command))
              }
            }.padding(20)
          }.background(paper).navigationTitle("核对会员找回操作").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
}
private struct MembershipRecoveryForm: View {
  @EnvironmentObject var model: AppModel
  let board: MembershipRecoveryBoard
  let editor: RecoveryEditor
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var member = ""
  @State private var phone = ""
  @State private var reason = ""
  @State private var verified = false
  @State private var candidate: RecoveryRecord?
  @State private var picker = false
  @State private var error = ""
  private var reasonLabel: String {
    editor.action == "reject" ? "驳回依据（2—500字）" : "实际核验与复核依据（2—500字）"
  }
  private var verificationLabel: String {
    if editor.action == "contact" { return "已核对本人、原会员凭据及手机号" }
    if editor.action == "approve" { return "已独立核对所选会员，确认进行合并" }
    return "已核对原申请及处理依据"
  }
  private func prepare() {
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let fields = ["memberNo": member, "phone": phone, "reason": reason]
      let command = try board.command(actor: actor, action: editor.action, row: editor.row,
        candidate: candidate, fields: fields, verified: verified)
      propose(command); error = ""
    } catch { self.error = error.localizedDescription }
  }
  private var contactFields: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("完整会员号", text: $member).textFieldStyle(.roundedBorder)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      SecureField("已核验手机号（含国家代码，如+86）", text: $phone)
        .textFieldStyle(.roundedBorder).keyboardType(.phonePad)
      Text("使用原始登记或现场核验凭据，不按猜测填写。应用转入后台会清空本次未提交输入。").font(.caption)
    }
  }
  @ViewBuilder private var applicationFields: some View {
    if let row = editor.row {
      Text("申请 " + row.id)
      Text(row.text("maskedMemberNo") + " · " + row.text("maskedPhone"))
      if editor.action == "select" {
        Button("读取并选择此申请的原候选") { picker = true }.disabled(model.busy || model.heartbeatBusy)
        if let candidate {
          Text("已选 " + candidate.text("maskedMemberNo") + " · " + candidate.text("maskedPhone"))
          Text("入会日期：" + candidate.text("joinedDate"))
        }
      }
      if editor.action == "approve" {
        Text("合并会保留来源账户和历史。请依据真实凭据独立确认，不能仅凭掩码相近进行合并。").font(.caption)
      }
    }
  }
  private var verificationFields: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(reasonLabel, text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      Toggle(verificationLabel, isOn: $verified)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对", action: prepare).buttonStyle(Primary(symbol: "checkmark.shield"))
        .disabled(!verified || !model.canUseMembershipRecovery)
    }
  }
  var body: some View {
    Card {
      Text(membershipRecoveryActions[editor.action] ?? "核对原申请").font(.title3.bold())
      Button("返回列表", action: close)
      if editor.action == "contact" { contactFields } else { applicationFields }
      verificationFields
    }.sheet(isPresented: $picker) {
      if let row = editor.row {
        MembershipRecoveryPicker(row: row) { candidate = $0; picker = false; verified = false }
      }
    }
  }
}
private struct MembershipRecoveryPicker: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let row: RecoveryRecord
  let select: (RecoveryRecord) -> Void
  @State private var rows: [RecoveryRecord] = []
  @State private var next: String?
  @State private var loading = false
  @State private var state = ""
  @State private var access: String?
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + String(actor.allows(membershipRecoveryPermissions[0])) }
  private func load(more: Bool = false) {
    guard !loading else { return }; loading = true
    Task {
      defer { loading = false }
      do {
        let result = try await model.membershipRecoveryCandidates(row: row, cursor: more ? next ?? "" : "")
        guard access == accessKey else { return }
        var ids = Set<String>(); rows = ((more ? rows : []) + result.rows).filter { ids.insert($0.id).inserted }; next = result.nextCursor; state = "只展示掩码，请结合原始凭据核验。"
      } catch { rows = []; next = nil; state = "读取失败，不能判定没有候选：" + error.localizedDescription }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if access == accessKey && !accessKey.isEmpty {
            Text(state).font(.subheadline)
            Button("重新读取此申请的候选") { load() }.disabled(loading || model.busy || model.heartbeatBusy)
            ForEach(rows) { row in Card {
              Text(row.text("maskedMemberNo") + " · " + row.text("maskedPhone")); Text("入会日期：" + row.text("joinedDate")).font(.caption)
              Button("选择此会员") { select(row); dismiss() }.buttonStyle(Primary(tone: .secondary, symbol: "person.crop.circle.badge.checkmark")).disabled(loading)
            } }
            if next != nil { Button("加载更多候选") { load(more: true) }.disabled(loading || model.busy || model.heartbeatBusy) }
          }
        }.padding(16)
      }.background(paper).navigationTitle("选择原会员候选").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.tint(ink).task { access = accessKey; load() }
      .onChange(of: accessKey) { _, _ in rows = []; dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in rows = []; dismiss() }
  }
}
