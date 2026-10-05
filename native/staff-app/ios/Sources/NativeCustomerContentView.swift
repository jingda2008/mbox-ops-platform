import SwiftUI

struct NativeContentForm: Identifiable {
  let id = UUID()
  let action: String
  let row: NativeManagementRow?
}
struct NativeCustomerContentView: View {
  let module: NativeManagementModule
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var search = ""
  @State private var code = "DEFAULT"
  @State private var editing: NativeContentForm?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  private var board: NativeManagementBoard? { model.nativeManagementBoard?.module == module ? model.nativeManagementBoard : nil }
  private func can(_ action: String) -> Bool { model.canUseNativeManagement && (try? nativeContentPermission(module, action)).map { model.identity?.allows($0) == true } == true }
  private func load(_ cursor: String = "") { editing = nil; proposed = nil; Task { await model.loadNativeManagement(module, search: module == .homeContent ? search : "", cursor: cursor, code: module == .recommendations ? code : "DEFAULT") } }
  private func clear() { editing = nil; proposed = nil; confirmed = false }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          LivePendingView()
          Text(model.nativeManagementState).font(.caption)
          if module == .homeContent { TextField("搜索内容名称或编号", text: $search).textFieldStyle(.roundedBorder) }
          if module == .recommendations { TextField("策略编号（常用 DEFAULT）", text: $code).textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters) }
          Button("重新读取第一页") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
          if let board {
            if module == .launchPopup { popup(board) }
            else {
              if module == .recommendations { recommendationFeature(board) }
              Button(module == .homeContent ? "新增首页内容草稿" : "新建推荐规则草稿") { editing = .init(action: "create", row: module == .recommendations ? board.rows("rows").first : nil) }.disabled(!can("create"))
              if board.rows("rows").isEmpty { Text("这一页没有记录").foregroundStyle(.secondary) }
              ForEach(board.rows("rows")) { row in Card { contentRow(row) } }
              if let next = board.data["next"] as? String { Button("读取下一页原记录") { load(next) }.disabled(model.busy) }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle(module.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.task { load() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: phase) { _, phase in if phase != .active { clear() } }
      .sheet(item: $editing) { form in if let board { NativeCustomerContentFormView(form: form, board: board) { editing = nil; proposed = $0; confirmed = false } } }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView { VStack(alignment: .leading, spacing: 16) {
            Text(command.steps.first?.nativeManagementProof?["confirmation"] as? String ?? "请重新读取原请求")
            Toggle("已核对原版本、内容、客群与生效影响", isOn: $confirmed)
            Button("确认提交原修改") { clear(); Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canExecuteLive(command))
          }.padding(18) }.navigationTitle("核对顾客展示变更").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil; confirmed = false } } }
        }
      }
  }
  @ViewBuilder private func popup(_ board: NativeManagementBoard) -> some View {
    if let row = board.data["row"] as? [String: Any] {
      Text((row["enabled"] as? Bool == true ? "已启用" : "已关闭") + " · 第\((row["version"] as? Int) ?? 0)版").font(.headline)
      Text(row["title"] as? String ?? ""); Text(row["content"] as? String ?? "")
      Text("出现频次：" + (["daily": "每天一次", "session": "每次打开", "always": "每次进入首页"][row["frequency"] as? String ?? ""] ?? "待核对"))
      ForEach(Array(((row["products"] as? [[String: Any]]) ?? []).enumerated()), id: \.offset) { index, item in Text("\(index + 1). " + (item["name"] as? String ?? "商品待核对")) }
      Button("调整弹窗内容、商品与开关") { editing = .init(action: "save", row: nil) }.disabled(!can("save"))
    }
  }
  @ViewBuilder private func recommendationFeature(_ board: NativeManagementBoard) -> some View {
    if let feature = board.data["feature"] as? [String: Any] {
      Card {
        Text("顾客推荐：" + (nativeRecommendationRollouts[feature["rolloutState"] as? String ?? ""] ?? "待核对")).font(.headline)
        Text(feature["reason"] as? String ?? "")
        Text("发布规则与顾客开放分别控制。开放仍受已生效规则、库存、演出阶段及出品能力约束。").font(.caption)
        Button("单独调整顾客开放状态") { editing = .init(action: "rollout", row: nil) }.disabled(!can("rollout"))
      }
    }
  }
  @ViewBuilder private func contentRow(_ row: NativeManagementRow) -> some View {
    if module == .homeContent {
      Text(row.text("title") + " · " + row.text("code")).font(.headline)
      Text(["draft": "草稿", "published": "已发布", "paused": "已暂停", "retired": "已退役"][row.text("status")] ?? "状态待核对")
      Text(row.text("summary"))
      Text(reservationTime(row.text("validFrom")) + " 至 " + reservationTime(row.text("validUntil"))).font(.caption)
      Text("展示范围：" + (["public": "全部顾客", "member": "全部会员", "segment": "指定客群"][row.text("visibility")] ?? "待核对"))
      if ["draft", "paused"].contains(row.text("status")) {
        Button("编辑原内容草稿") { editing = .init(action: "update", row: row) }.disabled(!can("update"))
        Button("发布原内容") { editing = .init(action: "publish", row: row) }.disabled(!can("publish"))
      }
      if row.text("status") == "published" { Button("暂停原内容") { editing = .init(action: "pause", row: row) }.disabled(!can("pause")) }
    } else {
      Text(row.text("code") + " · 第" + row.text("version") + "版").font(.headline)
      Text(["draft": "草稿", "approved": "已审批待发布", "published": "已发布", "retired": "历史版本"][row.text("status")] ?? "待核对")
      Text(row.text("publicationMode") == "legacy" ? "历史直接发布版本；不作为当前受控开放条件。" : "按独立起草、审批与发布流程核对。")
      Text(row.text("explanationTemplate"))
      DisclosureGroup("查看原规则参数") { ForEach(nativeRecommendationWeights.keys.sorted(), id: \.self) { key in Text((nativeRecommendationWeights[key] ?? key) + "：" + row.text(key)) }; ForEach(nativeRecommendationLimits.keys.sorted(), id: \.self) { key in Text((nativeRecommendationLimits[key]?.0 ?? key) + "：" + row.text(key)) } }
      Text("生效：" + reservationTime(row.text("effectiveFrom"))).font(.caption)
      Button("复制原规则为新草稿") { editing = .init(action: "clone", row: row) }.disabled(!can("clone"))
      if row.text("status") == "draft" { Button("独立审批原草稿") { editing = .init(action: "approve", row: row) }.disabled(!can("approve") || row.text("createdByEmployeeId") == model.identity?.employee.id) }
      if row.text("status") == "approved" { Button("安排原规则生效") { editing = .init(action: "publish", row: row) }.disabled(!can("publish") || row.text("createdByEmployeeId") == model.identity?.employee.id || row.text("approvedByEmployeeId") == model.identity?.employee.id) }
    }
  }
}
