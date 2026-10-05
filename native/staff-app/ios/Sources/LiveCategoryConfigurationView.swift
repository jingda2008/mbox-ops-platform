import SwiftUI

struct LiveCategoryConfigurationView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var editing: CatalogConfigurationRecord?
  @State private var creating = false
  var body: some View {
    NavigationStack {
      List {
        LivePendingView()
        Button("新增分类") { creating = true }.disabled(!model.canUseProducts || model.catalogConfigurationBoard?.enabled != true)
        Button("刷新分类") { Task { await model.loadProducts() } }.disabled(model.busy || model.heartbeatBusy)
        Text(model.productState).font(.caption)
        ForEach(model.catalogConfigurationBoard?.categories ?? []) { category in
          VStack(alignment: .leading, spacing: 8) {
            Text(category.text("displayName")).font(.headline)
            Text(category.text("code") + " · " + (category.object["parentCode"] is NSNull ? "一级分类" : "二级分类")).font(.caption)
            Button("编辑此分类") { editing = category }.disabled(!model.canUseProducts)
          }
        }
      }.navigationTitle("菜单分类").toolbar { Button("关闭") { dismiss() } }
    }.sheet(isPresented: $creating) { CategoryConfigurationEditor(category: nil) }
      .sheet(item: $editing) { CategoryConfigurationEditor(category: $0) }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .onChange(of: model.priorityAccessKey) { _, _ in dismiss() }
  }
}
private struct CategoryConfigurationEditor: View {
  let category: CatalogConfigurationRecord?
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var name = ""
  @State private var parent = ""
  @State private var sort = "100"
  @State private var visible = true
  @State private var error = ""
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      Form {
        if category == nil { TextField("唯一分类编号", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled() }
        else { Text(code) }
        TextField("分类名称", text: $name)
        Picker("上级分类", selection: $parent) {
          Text("无（一级分类）").tag("")
          ForEach(model.catalogConfigurationBoard?.categories.filter { $0.object["parentCode"] is NSNull && $0.text("code") != code } ?? []) { row in
            Text(row.text("displayName")).tag(row.text("code"))
          }
        }
        TextField("排序（0—100000）", text: $sort).keyboardType(.numberPad)
        Toggle("顾客菜单显示", isOn: $visible)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("核对分类配置") {
          do {
            guard let actor = model.identity, let board = model.catalogConfigurationBoard else { throw StaffAPIError.invalid }
            proposed = try categoryConfigurationCommand(actor: actor, board: board, category: category,
              code: code, name: name, parent: parent, sort: sort, visible: visible)
          } catch { self.error = error.localizedDescription }
        }.disabled(!model.canUseProducts)
      }.navigationTitle(category == nil ? "新增分类" : "编辑分类").toolbar { Button("关闭") { dismiss() } }
    }.task {
      if let category {
        code = category.text("code"); name = category.text("displayName"); parent = category.text("parentCode")
        sort = String((try? catalogConfigInt(category.object["sortOrder"])) ?? -1)
        visible = (try? catalogConfigBool(category.object["guestVisible"])) == true
      }
    }.sheet(item: $proposed) { command in CatalogConfigurationConfirmation(command: command) { proposed = nil; dismiss() } }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
