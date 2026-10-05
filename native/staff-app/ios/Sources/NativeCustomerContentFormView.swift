import SwiftUI

struct NativeCustomerContentFormView: View {
  let form: NativeContentForm
  let board: NativeManagementBoard
  let completed: (LiveCommand) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var fields: [String: String] = [:]
  @State private var reason = ""
  @State private var levels = Set<String>()
  @State private var stages = Set<String>()
  @State private var productIds: [String] = []
  @State private var names: [String: String] = [:]
  @State private var from = Date()
  @State private var until = Date().addingTimeInterval(7 * 86400)
  @State private var effective = Date()
  @State private var imagePicker = false
  @State private var optionPicker = false
  @State private var error = ""
  private var isHomeDraft: Bool { board.module == .homeContent && ["create", "update"].contains(form.action) }
  private func text(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func toggle(_ key: String) -> Binding<Bool> { Binding(get: { fields[key] == "true" }, set: { fields[key] = $0 ? "true" : "false" }) }
  @ViewBuilder private func field(_ label: String, _ key: String, numeric: Bool = false) -> some View {
    TextField(label, text: text(key), axis: .vertical).keyboardType(numeric ? .numbersAndPunctuation : .default).textFieldStyle(.roundedBorder)
  }
  @ViewBuilder private func picker(_ label: String, _ key: String, _ values: [String: String]) -> some View {
    Picker(label, selection: text(key)) { ForEach(values.keys.sorted(), id: \.self) { Text(values[$0] ?? "").tag($0) } }.pickerStyle(.menu)
  }
  private func load() {
    if let row = form.row {
      fields = row.object.reduce(into: [:]) { values, pair in if let value = pair.value as? String { values[pair.key] = value }; if let value = pair.value as? NSNumber { values[pair.key] = value.stringValue } }
      from = (try? nativeContentDate(row.text("validFrom"))) ?? from; until = (try? nativeContentDate(row.text("validUntil"))) ?? until
      levels = Set(row.strings("audienceMemberLevels")); stages = Set(row.strings("audienceLifecycleStages"))
    }
    if board.module == .homeContent && form.action == "create" {
      fields = ["code": "", "title": "", "summary": "", "type": "article", "displayMode": "rotation", "visibility": "public", "priority": "100", "ctaLabel": "查看详情", "targetPath": "/pages/community/index", "imageUrl": ""]
    }
    if board.module == .launchPopup, let row = board.data["row"] as? [String: Any] {
      fields = ["enabled": row["enabled"] as? Bool == true ? "true" : "false", "title": row["title"] as? String ?? "", "content": row["content"] as? String ?? "", "frequency": row["frequency"] as? String ?? "daily"]
      productIds = row["productIds"] as? [String] ?? []
      for item in (row["products"] as? [[String: Any]]) ?? [] { if let id = item["id"] as? String { names[id] = item["name"] as? String ?? "原商品" } }
    }
    if board.module == .recommendations {
      if form.action == "rollout" { fields["rolloutState"] = (board.data["feature"] as? [String: Any])?["rolloutState"] as? String ?? "disabled" }
      if form.action == "create" {
        let defaults = ["preferenceWeight": 100, "sceneWeight": 60, "marginWeight": 50, "priorityWeight": 50, "performanceWeight": 0, "inventoryWeight": 0, "capacityWeight": 0, "minimumGrossMarginBasisPoints": 1500, "preferenceHalfLifeDays": 90, "preferenceMaxAgeDays": 730, "preferenceMinEffectiveScore": 1000, "preferenceMinConfidenceBasisPoints": 2500]
        for (key, value) in defaults where fields[key] == nil { fields[key] = String(value) }
        fields["explanationTemplate"] = fields["explanationTemplate"] ?? "按明确偏好、价格与当前可售条件提供建议"
      }
    }
  }
  private func propose() {
    do {
      guard let actor = model.identity, actor.employee.id == board.employeeID else { throw StaffAPIError.invalid }
      var values = fields; values["reason"] = reason
      if isHomeDraft {
        values["validFrom"] = ISO8601DateFormatter().string(from: from); values["validUntil"] = ISO8601DateFormatter().string(from: until)
        let segmented = fields["visibility"] == "segment"
        values["audienceMemberLevels"] = String(data: try JSONEncoder().encode(segmented ? levels.sorted() : []), encoding: .utf8)
        values["audienceLifecycleStages"] = String(data: try JSONEncoder().encode(segmented ? stages.sorted() : []), encoding: .utf8)
      }
      if board.module == .launchPopup { values["productIds"] = String(data: try JSONEncoder().encode(productIds), encoding: .utf8) }
      if board.module == .recommendations && form.action == "publish" { values["effectiveFrom"] = ISO8601DateFormatter().string(from: effective) }
      completed(try board.command(actor: actor, operation: form.action, fields: values, rowID: form.row?.id))
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if isHomeDraft { homeFields }
          else if board.module == .launchPopup { popupFields }
          else if board.module == .recommendations { recommendationFields }
          else { Text(form.row?.text("title") ?? "原内容"); Text(form.action == "pause" ? "暂停后不再向顾客展示此内容。" : "将按原草稿的排期与客群展示，请核对原内容。") }
          TextField("本次操作原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
          Button("预览并核对变更") { propose() }.buttonStyle(Primary(symbol: "checklist")).disabled(model.busy || !model.canUseNativeManagement)
        }.padding(18)
      }.navigationTitle(board.module.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.task { load() }
      .onChange(of: model.workspaceVersion) { _, _ in fields = [:]; reason = ""; dismiss() }
      .onChange(of: phase) { _, phase in if phase != .active { fields = [:]; reason = ""; dismiss() } }
      .sheet(isPresented: $imagePicker) { NativeMediaPickerView(purpose: "home_content") { fields["imageUrl"] = $0; imagePicker = false } }
      .sheet(isPresented: $optionPicker) { NativeContentOptionsView(module: board.module) { item in
        if board.module == .launchPopup {
          if !productIds.contains(item.id) && productIds.count < 8 { productIds.append(item.id); names[item.id] = item.text("name") }
        } else {
          var path = URLComponents(); path.path = "/pages/community-detail/index"; path.queryItems = [.init(name: "id", value: item.id)]
          fields["targetPath"] = path.string; fields["activityName"] = item.text("name")
        }
        optionPicker = false
      } }
  }
  @ViewBuilder private var homeFields: some View {
    if form.action == "create" { field("内容编号（3—64位）", "code") } else { Text("原编号：" + (fields["code"] ?? "")) }
    picker("内容类型", "type", nativeHomeTypes); field("标题", "title"); field("内容摘要", "summary"); field("按钮文字", "ctaLabel")
    picker("首页展示方式", "displayMode", ["pinned": "固定展示", "rotation": "轮播展示"]); field("展示顺序（0—10000）", "priority", numeric: true)
    picker("顾客范围", "visibility", ["public": "全部顾客", "member": "全部会员", "segment": "指定会员客群"])
    if fields["visibility"] == "segment" {
      Text("等级或活跃阶段至少选择一项").font(.caption)
      ForEach(nativeHomeLevels.keys.sorted(), id: \.self) { key in Toggle(nativeHomeLevels[key] ?? "", isOn: Binding(get: { levels.contains(key) }, set: { if $0 { levels.insert(key) } else { levels.remove(key) } })) }
      ForEach(nativeHomeStages.keys.sorted(), id: \.self) { key in Toggle(nativeHomeStages[key] ?? "", isOn: Binding(get: { stages.contains(key) }, set: { if $0 { stages.insert(key) } else { stages.remove(key) } })) }
    }
    DatePicker("开始展示", selection: $from); DatePicker("结束展示", selection: $until)
    Picker("站内目标页面", selection: text("targetPath")) {
      ForEach(nativeHomeTargets.keys.sorted(), id: \.self) { Text(nativeHomeTargets[$0] ?? "").tag($0) }
      if let path = fields["targetPath"], path.hasPrefix("/pages/community-detail/") { Text(fields["activityName"] ?? "原活动详情").tag(path) }
    }.pickerStyle(.menu)
    Button("选择已发布活动详情") { optionPicker = true }
    Button(fields["imageUrl", default: ""].isEmpty ? "选择内容图片" : "更换内容图片") { imagePicker = true }
    if !fields["imageUrl", default: ""].isEmpty { Text("已选择站内图片；保存草稿后仍须单独发布。").font(.caption); Button("移除内容图片") { fields["imageUrl"] = "" } }
  }
  @ViewBuilder private var popupFields: some View {
    Toggle("启用打开弹窗", isOn: toggle("enabled")); field("标题", "title"); field("正文", "content")
    picker("出现频次", "frequency", ["daily": "每天一次", "session": "每次打开", "always": "每次进入首页"])
    Text("推荐商品按下列顺序展示，最多8款。").font(.caption)
    ForEach(Array(productIds.enumerated()), id: \.element) { index, id in
      VStack(alignment: .leading) {
        Text("\(index + 1). " + (names[id] ?? "原商品"))
        HStack {
          Button("上移") { if index > 0 { productIds.swapAt(index, index - 1) } }.disabled(index == 0)
          Button("下移") { if index + 1 < productIds.count { productIds.swapAt(index, index + 1) } }.disabled(index + 1 == productIds.count)
          Button("移除") { productIds.removeAll { $0 == id } }
        }
      }
    }
    Button("搜索并加入可公开商品") { optionPicker = true }.disabled(productIds.count >= 8)
  }
  @ViewBuilder private var recommendationFields: some View {
    if form.action == "create" {
      Text("问卷与历史配置沿用原规则；新建版本仍须独立审批和发布。").font(.caption)
      ForEach(["preferenceWeight", "sceneWeight", "marginWeight", "priorityWeight"], id: \.self) { key in field((nativeRecommendationWeights[key] ?? key) + "（-1000—1000）", key, numeric: true) }
      ForEach(nativeRecommendationLimits.keys.sorted(), id: \.self) { key in field(nativeRecommendationLimits[key]?.0 ?? key, key, numeric: true) }
      field("顾客可见推荐解释", "explanationTemplate")
    } else if form.action == "rollout" {
      picker("顾客开放状态", "rolloutState", nativeRecommendationRollouts)
      Text("此开关与规则发布独立。关闭不删除历史；试运行或正式开放仍须有当前生效且独立审批发布的规则。").font(.caption)
    } else {
      Text((form.row?.text("code") ?? "") + " 第" + (form.row?.text("version") ?? "") + "版")
      if form.action == "publish" { DatePicker("规则生效时间", selection: $effective) }
      Text(form.action == "clone" ? "复制为新草稿，不修改原历史版本。" : "审批或发布不会自动打开顾客推荐。").font(.caption)
    }
  }
}

struct NativeContentOptionsView: View {
  let module: NativeManagementModule
  let selected: (NativeManagementRow) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var rows: [NativeManagementRow] = []
  @State private var next: String?
  @State private var search = ""
  @State private var error = ""
  @State private var loading = false
  @State private var owner = ""
  private func load(_ cursor: String = "") async {
    guard !loading, owner == model.identity?.staffNavigationKey else { return }; loading = true; defer { loading = false }
    do {
      let bytes = try await model.readNativeManagementOptions(module: module, search: search, cursor: cursor)
      guard let actor = model.identity, owner == actor.staffNavigationKey else { return }
      let page = try NativeContentOptions(bytes, actor: actor, module: module)
      rows = cursor.isEmpty ? page.rows : rows + page.rows.filter { candidate in !rows.contains { $0.id == candidate.id } }; next = page.next; error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView { LazyVStack(alignment: .leading, spacing: 14) {
        TextField(module == .homeContent ? "搜索已发布活动" : "搜索可公开商品", text: $search).textFieldStyle(.roundedBorder)
        Button("搜索第一页") { Task { await load() } }.disabled(loading || model.busy)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        ForEach(rows) { item in Button(item.text("name") + (item.text("code").isEmpty ? "" : " · " + item.text("code"))) { if owner == model.identity?.staffNavigationKey { selected(item) } }.disabled(loading || model.busy) }
        if let next { Button("加载更多") { Task { await load(next) } }.disabled(loading || model.busy) }
        if rows.isEmpty && !loading { Text("没有匹配记录") }
      }.padding(18) }.navigationTitle(module == .homeContent ? "选择活动" : "选择商品").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.task { owner = model.identity?.staffNavigationKey ?? ""; await load() }
      .onChange(of: model.workspaceVersion) { _, _ in rows = []; dismiss() }
  }
}
