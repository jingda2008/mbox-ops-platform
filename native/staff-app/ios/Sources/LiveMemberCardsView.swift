import SwiftUI

struct MemberCardEditor: Identifiable {
  let id = UUID()
  let action: String
  var row: WalletRecord? = nil
  var target = ""
}
struct LiveMemberCardsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var section = "projects"
  @State private var editor: MemberCardEditor?
  @State private var proposed: LiveCommand?
  @State private var notice = ""
  @State private var verified = false
  @State private var access: String?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + memberCardPermissions.filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access != nil && access == accessKey && !accessKey.isEmpty }
  private var sections: [String] { model.identity.map(memberCardSections) ?? [] }
  private func clear() { editor = nil; proposed = nil; notice = ""; verified = false }
  private func reload(cursor: String = "") { clear(); Task { await model.loadMemberCards(section: section, cursor: cursor) } }
  private func propose(_ command: LiveCommand) { proposed = command; verified = false; notice = "" }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Text("会员卡与会员等级独立。员工只审核顾客已提交的申请，不代顾客接受条款、关注平台或授权。").font(.subheadline)
            Picker("查看", selection: $section) {
              ForEach(sections, id: \.self) { Text(["projects": "卡项目", "applications": "申请审核", "holdings": "持卡记录"][$0]!).tag($0) }
            }.pickerStyle(.menu)
            Button("刷新当前范围") { reload() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            Text(model.memberCardsState).font(.caption)
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            if let board = model.memberCardsBoard, board.employeeID == model.identity?.employee.id, board.section == section {
              if let editor { MemberCardFormView(board: board, edit: editor, close: { self.editor = nil }, propose: propose).id(editor.id) }
              if section == "projects", model.identity?.allows("member.card.manage") == true {
                Button("新建卡项目草稿") { editor = MemberCardEditor(action: "create") }.buttonStyle(Primary(symbol: "plus.rectangle")).disabled(!model.canUseMemberCards)
              }
              if board.rows.isEmpty { Text("当前页没有记录。").foregroundStyle(.secondary) }
              ForEach(board.rows) { row in
                Card {
                  Text(row.text(section == "projects" ? "name" : "project_name")).font(.headline)
                  Text(cardStateNames[row.text("status")] ?? "待核对").font(.subheadline)
                  if section == "projects" { project(row) } else { customer(row) }
                }
              }
              HStack {
                Button("回到第一页") { reload() }
                if let cursor = board.nextCursor { Button("下一页") { reload(cursor: cursor) } }
              }.disabled(model.busy || model.heartbeatBusy)
              Text("每页最多50条。暂停新申请不撤销已持卡记录；暂停或撤卡不会自动退款、增减积分或改变等级。").font(.caption)
            }
          } else { Text("账号或会员卡权限已变化，请重新读取。") }
        }.padding(16)
      }.background(paper).navigationTitle("会员卡管理").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink)
      .task { access = accessKey; section = sections.first ?? "projects"; await model.loadMemberCards(section: section, cursor: "") }
      .onChange(of: section) { _, _ in if current { reload() } }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if current, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.memberCardProof?["confirmation"] as? String ?? "请重新读取原记录")
                Toggle("已核对顾客原申请、权限和本次处理范围", isOn: $verified)
                Button("确认提交") { clear(); Task { await model.executeLive(command) } }
                  .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!verified || !model.canUseMemberCards || !model.canExecuteLive(command))
              } else { Text("账号或权限已变化，内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle("核对会员卡操作").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
  @ViewBuilder private func project(_ row: WalletRecord) -> some View {
    Text("\(row.text("code")) · 第\((try? row.integer("version")) ?? 0)版 · \(row.text("kind") == "cobrand" ? "联名卡" : "兴趣卡")").font(.caption)
    Text("\(membershipRecordTime(row.text("available_from"))) — \(membershipRecordTime(row.text("available_until")))").font(.caption)
    Foldout(title: "查看完整申请条款") { Text(row.text("terms")) }
    if row.text("status") != "closed" {
      if model.identity?.allows("loyalty.policy.publish") == true && row.text("status") != "open" {
        let own = row.text("created_by_employee_id") == model.identity?.employee.id
        Button(own ? "由另一位发布人开放" : "核对后开放申请") { editor = MemberCardEditor(action: "state", row: row, target: "open") }
          .buttonStyle(Primary(tone: .secondary, symbol: "checkmark.seal")).disabled(own || !model.canUseMemberCards)
      }
      if model.identity?.allows("member.card.manage") == true {
        if row.text("status") == "open" {
          Button("暂停新申请") { editor = MemberCardEditor(action: "state", row: row, target: "paused") }.disabled(!model.canUseMemberCards)
        }
        Button("关闭卡项目", role: .destructive) { editor = MemberCardEditor(action: "state", row: row, target: "closed") }.disabled(!model.canUseMemberCards)
        if row.text("status") == "draft" {
          Button("配置加入门槛与卡片") { editor = MemberCardEditor(action: "social", row: row) }
            .buttonStyle(Primary(tone: .secondary, symbol: "person.badge.key")).disabled(!model.canUseMemberCards)
        }
      }
    }
    if model.identity?.allows("member.card.manage") == true {
      Button("专属菜单与价格") { editor = MemberCardEditor(action: "menu", row: row) }.buttonStyle(Primary(tone: .secondary, symbol: "menucard")).disabled(!model.canUseMemberCards)
    }
  }
  @ViewBuilder private func customer(_ row: WalletRecord) -> some View {
    Text("客户：" + row.text("customer_reference")).font(.caption)
    if !row.text("member_no").isEmpty { Text("会员号：" + row.text("member_no")).font(.caption) }
    if section == "applications" {
      Text("申请时间：" + membershipRecordTime(row.text("requested_at"))).font(.caption)
      Button("核对后通过申请") { editor = MemberCardEditor(action: "review", row: row, target: "approve") }
        .buttonStyle(Primary(tone: .secondary, symbol: "checkmark.seal")).disabled(!model.canUseMemberCards)
      Button("拒绝并记录原因", role: .destructive) { editor = MemberCardEditor(action: "review", row: row, target: "reject") }.disabled(!model.canUseMemberCards)
    } else {
      Text("有效至：" + membershipRecordTime(row.text("valid_until")) + ((try? row.boolean("expired")) == true ? " · 已到期" : "")).font(.caption)
      if row.text("status") == "active" { Button("暂停此卡") { editor = MemberCardEditor(action: "holding", row: row, target: "suspend") }.disabled(!model.canUseMemberCards) }
      if row.text("status") == "suspended" && (try? row.boolean("expired")) == false { Button("核对后恢复") { editor = MemberCardEditor(action: "holding", row: row, target: "resume") }.disabled(!model.canUseMemberCards) }
      if ["active", "suspended"].contains(row.text("status")) { Button("撤销此卡", role: .destructive) { editor = MemberCardEditor(action: "holding", row: row, target: "revoke") }.disabled(!model.canUseMemberCards) }
    }
  }
}
