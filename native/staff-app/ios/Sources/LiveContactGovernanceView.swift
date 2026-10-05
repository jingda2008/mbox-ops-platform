import SwiftUI
private struct ContactGovernanceSelection: Identifiable { let id = UUID(); let action: String; let row: ContactGovernanceRecord? }
struct LiveContactGovernanceView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access: String?
  @State private var area = "policies"
  @State private var search = ""
  @State private var error = ""
  @State private var selection: ContactGovernanceSelection?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + (["privacy.contact.retention.view"] + contactActions.keys.map(contactPermission)).filter(actor.allows).sorted().joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private var areas: [(String, String)] { contactAreas.filter { $0.0 != "resources" || model.identity?.allows("privacy.contact.legal_hold") == true } }
  private func clear() { selection = nil; proposed = nil; confirmed = false; error = "" }
  private func load(cursor: String = "") { clear(); Task { await model.loadContactGovernance(area: area, search: area == "resources" ? search : "", cursor: cursor) } }
  private func propose(_ body: [String: Any], selection: ContactGovernanceSelection) {
    do { guard current, let actor = model.identity, let board = model.contactGovernanceBoard else { throw StaffAPIError.invalid }; proposed = try board.command(actor: actor, action: selection.action, body: body, row: selection.row); confirmed = false; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func card(_ row: ContactGovernanceRecord, board: ContactGovernanceBoard) -> some View {
    Card {
      Text(contactResourceKinds.first { $0.0 == row.text("resourceKind") }?.1 ?? "原联系方式记录").font(.headline)
      if area == "policies" {
        Text("第" + row.text("version") + "版 · " + (contactStatuses[row.text("status")] ?? "待核对"))
        Text((try? contactPolicySummary(row.object)) ?? "原策略待核对")
        Text("起草：" + row.text("draftedBy") + " · " + row.text("draftReason")).font(.subheadline)
        if !row.text("approvedBy").isEmpty { Text("审批：" + row.text("approvedBy") + " · " + row.text("approvalReason")).font(.subheadline) }
        if !row.text("publishedBy").isEmpty { Text("发布：" + row.text("publishedBy") + " · " + row.text("publicationReason")).font(.subheadline) }
        if !row.text("effectiveFrom").isEmpty { Text("生效：" + membershipRecordTime(row.text("effectiveFrom")) + "\n截止：" + (row.text("effectiveUntil").isEmpty ? "尚未安排结束" : membershipRecordTime(row.text("effectiveUntil")))).font(.caption) }
      } else if area == "holds" {
        Text(row.text("maskedContact") + " · " + (contactStatuses[row.text("status")] ?? "待核对"))
        Text("原联系方式版本：" + row.text("resourcePublicId")).font(.caption)
        Text("依据：" + row.text("legalBasisReference") + "\n原因：" + row.text("reason"))
        Text("创建：" + row.text("createdBy") + " · " + membershipRecordTime(row.text("createdAt"))).font(.caption)
        Text("保留至：" + (row.text("holdUntil").isEmpty ? "无预定截止" : membershipRecordTime(row.text("holdUntil"))))
        if row.text("status") == "released" { Text("释放：" + row.text("releasedBy") + " · " + membershipRecordTime(row.text("releasedAt")) + "\n" + row.text("releaseReason")).font(.caption) }
      } else if area == "resources" {
        Text(row.text("businessLabel")); Text(row.text("maskedContact"))
        Text("原联系方式版本：" + row.id).font(.caption)
      } else {
        Text(row.text("resourcePublicId")); Text("已清除 · 原策略第" + row.text("policyVersion") + "版")
        Text("目的结束：" + membershipRecordTime(row.text("purposeEndedAt")) + "\n清除时间：" + membershipRecordTime(row.text("disposedAt"))).font(.caption)
        Text("依据策略：" + row.text("policyPublicId")).font(.caption)
      }
      if let actor = model.identity { ForEach(board.actions(actor: actor, row: row), id: \.self) { action in Button(contactActions[action]!) { selection = ContactGovernanceSelection(action: action, row: row) }.disabled(!model.canUseContactGovernance) } }
    }
  }
  @ViewBuilder private var content: some View {
    Text("这里只显示联系方式掩码、保留策略和清除证据。期限和依据须由门店核实；不要在原因中录入完整手机号或其他无关个人信息。").font(.subheadline)
    Text(model.contactGovernanceState).font(.caption)
    Picker("查看", selection: $area) { ForEach(areas, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu).onChange(of: area) { _, _ in search = ""; load() }
    if area == "resources" { annualInput("活动、掩码或版本编号（支持部分文字）", $search) }
    Button("读取 / 刷新") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
    if area == "policies", model.identity?.allows(contactPermission("draft")) == true { Button("新建保留策略草稿") { selection = ContactGovernanceSelection(action: "draft", row: nil) }.buttonStyle(Primary(symbol: "plus")).disabled(!model.canUseContactGovernance) }
    if !error.isEmpty { Text(error).foregroundStyle(.red) }
    if let selection { ContactGovernanceFormView(action: selection.action, row: selection.row, close: { self.selection = nil }, submit: { propose($0, selection: selection) }).id(selection.id) }
    if let board = model.contactGovernanceBoard, board.area == area {
      ForEach(board.rows) { card($0, board: board) }
      if board.rows.isEmpty { Text("当前范围没有记录。").foregroundStyle(.secondary) }
      HStack { Button("第一页") { load() }; if let next = board.nextCursor { Button("下一页") { load(cursor: next) } } }.disabled(model.busy || model.heartbeatBusy)
    }
  }
  var body: some View {
    NavigationStack { ScrollView { LazyVStack(alignment: .leading, spacing: 12) { LivePendingView(); if current { content } }.padding(16) }.background(paper).navigationTitle("联系方式保留与清除").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } } }.tint(ink)
      .task { access = accessKey; await model.loadContactGovernance(area: "policies", search: "", cursor: "") }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }.onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in confirmation(command) }
  }
  private func confirmation(_ command: LiveCommand) -> some View {
    NavigationStack { ScrollView { VStack(alignment: .leading, spacing: 16) {
      if current {
        Text(command.steps.first?.contactGovernanceProof?["confirmation"] as? String ?? "请重新读取原保留记录")
        Toggle("已核实原对象、保留期限、依据和本次处理影响", isOn: $confirmed)
        Button("确认提交") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseContactGovernance || !model.canExecuteLive(command))
      }
    }.padding(20) }.background(paper).navigationTitle("确认保留与清除操作").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } } }.tint(ink)
  }
}
private struct ContactGovernanceFormView: View {
  @EnvironmentObject var model: AppModel
  let action: String, row: ContactGovernanceRecord?
  let close: () -> Void
  let submit: ([String: Any]) -> Void
  @State private var kind = "activity_registration_contact"
  @State private var days = ""
  @State private var basis = ""
  @State private var reason = ""
  @State private var time = ""
  @State private var error = ""
  private func prepare() {
    do {
      var body: [String: Any] = ["reason": reason]
      if ["draft", "hold"].contains(action) { body["resourceKind"] = action == "hold" ? row?.text("resourceKind") : kind; body["legalBasisReference"] = basis }
      if action == "draft" { body["retentionDaysAfterPurposeEnd"] = try couponPolicyInteger(days, 0...36500) }
      if action == "publish" { body["effectiveFrom"] = try membershipDate(time) }
      if action == "hold" { body["holdUntil"] = time.isEmpty ? NSNull() : try membershipDate(time) as Any }
      submit(body); error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text(contactActions[action] ?? "原保留操作").font(.title3.bold())
      if action == "draft" {
        Picker("资源", selection: $kind) { ForEach(contactResourceKinds, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu)
        annualInput("目的结束后保留天数（0至36500）", $days)
        Text("零天表示目的结束后即可按清除任务处理。请填写门店核准的期限。").font(.caption)
      }
      if let row {
        if ["hold", "release"].contains(action) { Text(row.text("maskedContact") + " · " + (action == "hold" ? row.id : row.text("resourcePublicId"))) }
        else { Text("原第" + row.text("version") + "版\n" + ((try? contactPolicySummary(row.object)) ?? "请重新读取原策略")) }
      }
      if ["draft", "hold"].contains(action) { annualInput("已核实的法定或争议依据（3至500字）", $basis) }
      if ["hold", "publish"].contains(action) { annualInput(action == "hold" ? "保留截止（北京时间，留空须有无预定截止依据）" : "生效时间（北京时间 YYYY-MM-DD HH:mm:ss）", $time) }
      if action == "release" { Text("只解除原法定保留；符合已发布期限的旧版本将由清除任务处理，不表示立即删除当前联系方式。").font(.caption) }
      annualInput("实际操作原因 / 审核意见（2至500字）", $reason)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对", action: prepare).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseContactGovernance)
      Button("返回记录", action: close)
    }
  }
}
