import SwiftUI
struct LiveMembershipOverviewView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var board: MembershipOverview?
  @State private var state = "请读取已发布规则"
  @State private var section = "points"
  @State private var loading = false
  @State private var access: String?
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + String(actor.allows("loyalty.policy.view")) }
  private func load() {
    guard !loading else { return }; loading = true; board = nil; state = "正在核对服务器已发布规则"
    Task {
      defer { loading = false }
      do { let result = try await model.readMembershipOverview(); guard access == accessKey else { return }; board = result; state = "读取完成。时间状态按本机时钟展示，实际会员核算以服务器为准。" }
      catch { board = nil; state = error.localizedDescription }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if access == accessKey, !accessKey.isEmpty {
            Text(state).font(.caption)
            Button("刷新原规则") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(loading || model.busy || model.heartbeatBusy)
            Picker("查看", selection: $section) { Text("积分与成长值").tag("points"); Text("等级评定").tag("tiers"); Text("等级权益").tag("benefits"); Text("积分兑换").tag("catalog") }.pickerStyle(.menu)
            if let board, board.employeeID == model.identity?.employee.id {
              let rows = section == "points" ? board.points : section == "tiers" ? board.tiers : section == "benefits" ? board.benefits : board.catalog
              if section == "catalog" {
                Text("兑换运行状态：" + (["disabled": "未开放", "paused": "暂停", "pilot": "试运行", "enabled": "已启用", "active": "已启用"][board.controlState] ?? "待核对"))
                if !board.controlReason.isEmpty { Text(board.controlReason) }
                Text("展示已发布目录；实际可兑还须核对会员资格、时间、库存和当前开关，不是可用数量承诺。").font(.caption)
              }
              if rows.isEmpty { Text("当前没有已发布记录。").foregroundStyle(.secondary) }
              ForEach(rows) { row in Card { Text((try? membershipOverviewSummary(row, section: section)) ?? "原规则字段暂不可解释，请重新读取核对。") } }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("等级与权益规则").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { board = nil; dismiss() } } }
    }.tint(ink).task { access = accessKey; load() }
      .onChange(of: accessKey) { _, _ in board = nil; dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in board = nil; dismiss() }
  }
}
