import SwiftUI
struct LiveCouponCalendarsView: View { var body: some View { LiveCouponPoliciesView(kind: .calendar) } }
struct LiveStackingPoliciesView: View { var body: some View { LiveCouponPoliciesView(kind: .stacking) } }
private struct CouponEditor: Identifiable { let id = UUID(); let row: CouponPolicyRecord? }
struct LiveCouponPoliciesView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let kind: CouponPolicyKind
  @State private var access: String?
  @State private var search = ""
  @State private var editor: CouponEditor?
  @State private var decision: CouponPolicyRecord?
  @State private var decisionAction = ""
  @State private var reason = ""
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var error = ""
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    let permissions = ["loyalty.configuration.view", "loyalty.configuration.edit", "loyalty.configuration.approve", "loyalty.policy.publish", "loyalty.configuration.preview"]
    return actor.employee.id + ":" + actor.session.id + ":" + permissions.filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private var board: CouponPolicyBoard? { guard let b = model.couponPolicyBoard, b.kind == kind, b.employeeID == model.identity?.employee.id else { return nil }; return b }
  private func load(cursor: String = "") { editor = nil; decision = nil; proposed = nil; Task { await model.loadCouponPolicies(kind: kind, search: search, cursor: cursor) } }
  private func propose(_ action: String, body: [String: Any], row: CouponPolicyRecord?) {
    do { guard let board, let actor = model.identity else { throw StaffAPIError.invalid }; proposed = try board.command(actor: actor, action: action, body: body, row: row); confirmed = false; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func actions(_ row: CouponPolicyRecord) -> [String] {
    guard let actor = model.identity else { return [] }
    return ["approve", "publish", "stop_issuing"].filter { action in
      let permission = action == "approve" ? "loyalty.configuration.approve" : "loyalty.policy.publish"
      guard actor.allows(permission), row.text("status") == ["approve": "draft", "publish": "approved", "stop_issuing": "published"][action] else { return false }
      if action != "stop_issuing" && row.text("createdByEmployeeId") == actor.employee.id { return false }
      return action != "publish" || !((row.object["decisions"] as? [[String: Any]] ?? []).contains { $0["action"] as? String == "approve" && $0["employeeId"] as? String == actor.employee.id })
    }
  }
  @ViewBuilder private var list: some View {
    TextField("按规则编号查询", text: $search).textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters)
    Button("查询 / 刷新") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
    if model.identity?.allows("loyalty.configuration.edit") == true {
      Button("新建规则草稿") { editor = CouponEditor(row: nil) }.buttonStyle(Primary(symbol: "plus")).disabled(!model.canUseCouponPolicy)
    }
    if let board {
      ForEach(board.rows) { row in policyCard(row) }
      if board.rows.isEmpty { Text("当前查询范围没有规则。").foregroundStyle(.secondary) }
      HStack { Button("第一页") { load() }; if let cursor = board.nextCursor { Button("下一页") { load(cursor: cursor) } } }.disabled(model.busy || model.heartbeatBusy)
    }
  }
  private func policyCard(_ row: CouponPolicyRecord) -> some View {
    Card {
      Text(row.text("code") + " · 第" + row.text("version") + "版 · " + (couponPolicyStatuses[row.text("status")] ?? "待核对")).font(.headline)
      Text((try? couponPolicySummary(row.object, kind: kind)) ?? "规则详情待核对").font(.subheadline)
      Button(model.identity?.allows("loyalty.configuration.edit") == true ? "读取规则 / 修订新版本 / 预览" : "读取完整规则与预览") { editor = CouponEditor(row: row) }.disabled(!model.canUseCouponPolicy)
      ForEach(actions(row), id: \.self) { action in Button(couponPolicyDecisions[action]!) { decision = row; decisionAction = action; reason = "" }.disabled(!model.canUseCouponPolicy) }
    }
  }
  @ViewBuilder private var editing: some View {
    if let editor {
      if kind == .calendar { CouponCalendarEditorView(row: editor.row, close: { self.editor = nil }, save: { propose("save", body: $0, row: editor.row) }).id(editor.id) }
      else { StackingPolicyEditorView(row: editor.row, close: { self.editor = nil }, save: { propose("save", body: $0, row: editor.row) }).id(editor.id) }
    }
  }
  private var decisionForm: some View {
    Card {
      Text(couponPolicyDecisions[decisionAction] ?? "核对决定").font(.headline)
      Text("请核对上方完整规则。编辑、审批、发布分别由不同授权员工完成；停止新发券不会撤回已发券承诺。")
      TextField("实际核对原因（2至500字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      Button("继续核对") {
        if let row = decision { propose("decision", body: ["versionId": row.id, "expectedStatus": row.text("status"), "action": decisionAction, "reason": reason], row: row) }
      }.disabled(!model.canUseCouponPolicy)
      Button("返回列表") { decision = nil }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Text(model.couponPolicyState).font(.caption)
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if editor != nil { editing } else { list }
            if decision != nil { decisionForm }
          }
        }.padding(16)
      }.background(paper).navigationTitle(kind.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadCouponPolicies(kind: kind, search: "", cursor: "") }
      .onChange(of: accessKey) { _, _ in proposed = nil; editor = nil; decision = nil; dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in proposed = nil; editor = nil; decision = nil; dismiss() }
      .sheet(item: $proposed) { command in confirmation(command) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if current {
            Text(command.steps.first?.couponPolicyProof?["confirmation"] as? String ?? "请重新读取原规则")
            Toggle("已核对原版本、全部规则和金额限制", isOn: $confirmed)
            Button("确认提交") { proposed = nil; editor = nil; decision = nil; Task { await model.executeLive(command) } }
              .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseCouponPolicy || !model.canExecuteLive(command))
          }
        }.padding(20)
      }.background(paper).navigationTitle("确认规则操作").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
    }.tint(ink)
  }
}
