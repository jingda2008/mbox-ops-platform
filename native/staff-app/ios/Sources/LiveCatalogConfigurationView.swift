import SwiftUI

struct LiveCatalogConfigurationView: View {
  let product: CatalogConfigurationRecord?
  var companionSource: CatalogConfigurationRecord? = nil
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var draft = try! CatalogProductDraft()
  @State private var ready = false
  @State private var error = ""
  @State private var proposed: LiveCommand?
  @State private var picking = false
  @State private var pickingImage = false
  @State private var selectedGroup: String?
  var body: some View {
    NavigationStack {
      Form {
        Section { LivePendingView() }
        if ready {
          Section(product == nil ? "新建下架商品" : "商品基本信息") {
            if product == nil {
              TextField("唯一商品编号", text: $draft.code).textInputAutocapitalization(.never).autocorrectionDisabled()
              if model.catalogConfigurationBoard?.canPrice == true { TextField("初始售价（元，可留空）", text: $draft.initialPrice).keyboardType(.decimalPad) }
              Text("先保存为下架商品，核对售价、配方和可用库存后再上架。").font(.caption)
            } else { Text(draft.code).font(.caption) }
            TextField("商品名称", text: $draft.name)
            TextField("商品介绍", text: $draft.description, axis: .vertical)
            Picker("二级菜单分类", selection: $draft.category) {
              Text("请选择分类").tag("")
              ForEach(model.catalogConfigurationBoard?.categories.filter { $0.object["parentCode"] is String } ?? []) { row in
                Text(row.text("displayName")).tag(row.text("code"))
              }
            }
            Picker("类型", selection: $draft.kind) { Text("单品").tag("single"); Text("套餐").tag("bundle") }
            Picker("出品位置", selection: $draft.station) { ForEach(["bar", "kitchen", "cashier", "none"], id: \.self) { Text(catalogStationNames[$0]!).tag($0) } }
            Picker("库存", selection: $draft.inventoryMode) { Text("按配方跟踪").tag("tracked"); Text("不管理库存").tag("not_managed") }
            Text("套餐由组成单品分别出品。库存模式及构成影响后续备料与成本，已有订单保留原快照。").font(.caption)
          }
          Section("供应范围") {
            TextField("单次最大数量（1—9999）", text: $draft.maximum).keyboardType(.numberPad)
            TextField("供应开始 HH:mm（可留空）", text: $draft.from).keyboardType(.numbersAndPunctuation)
            TextField("供应结束 HH:mm（可留空）", text: $draft.until).keyboardType(.numbersAndPunctuation)
            ForEach(catalogChannelNames.keys.sorted(), id: \.self) { channel in
              Toggle(catalogChannelNames[channel]!, isOn: Binding(get: { draft.channels.contains(channel) }, set: { on in if on { draft.channels.insert(channel) } else { draft.channels.remove(channel) } }))
            }
          }
          if draft.kind == "bundle" { bundleSections }
          Section("商品图片") {
            Text(draft.imageURL.isEmpty ? "尚未选择图片" : "已选择商品图片")
            if model.identity?.allows("media.asset.menu.manage") == true {
              Button("从门店图库选择或上传") { pickingImage = true }
            }
            Text("选图或上传只保存图片，确认商品配置后才影响菜单展示。").font(.caption)
            if !draft.imageURL.isEmpty { Button("移除图片") { draft.imageURL = "" } }
          }
          Section {
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("核对商品配置") {
              do {
                guard let actor = model.identity, let board = model.catalogConfigurationBoard else { throw StaffAPIError.invalid }
                proposed = try draft.command(actor: actor, board: board, product: product)
              } catch { self.error = error.localizedDescription }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseProducts)
          }
        } else if !error.isEmpty { Text(error).foregroundStyle(.red) }
      }.navigationTitle("商品与套餐配置").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    }.task { do { if let companionSource { draft = try companionProductDraft(companionSource) } else { draft = try CatalogProductDraft(product: product) }; ready = true } catch { self.error = error.localizedDescription } }
      .onChange(of: model.workspaceVersion) { _, _ in proposed = nil; dismiss() }
      .onChange(of: model.priorityAccessKey) { _, _ in proposed = nil; dismiss() }
      .sheet(isPresented: $picking) {
        CatalogConfigurationPicker(excluding: product?.id ?? "") { row in
          let item = CatalogBundleItem(productID: row.id, name: row.text("name"))
          if let selectedGroup, let index = draft.groups.firstIndex(where: { $0.id == selectedGroup }) {
            if !draft.groups[index].options.contains(where: { $0.id == item.id }) {
              var next = item; next.sortOrder = (draft.groups[index].options.count + 1) * 10; draft.groups[index].options.append(next)
            }
          } else if selectedGroup == nil, !draft.components.contains(where: { $0.id == item.id }) {
            var next = item; next.sortOrder = (draft.components.count + 1) * 10; draft.components.append(next)
          }
          picking = false
        }
      }.sheet(isPresented: $pickingImage) { NativeMediaPickerView(purpose: "menu") { draft.imageURL = $0; pickingImage = false } }
      .sheet(item: $proposed) { command in CatalogConfigurationConfirmation(command: command) { proposed = nil; dismiss() } }
  }
  @ViewBuilder private var bundleSections: some View {
    Section("固定组成单品") {
      ForEach($draft.components) { $item in
        VStack(alignment: .leading) {
          Text(item.name).font(.headline)
          TextField("每套份数", text: $item.quantity).keyboardType(.numberPad)
          TextField("备注", text: $item.note)
          Button("移除此固定单品") { draft.components.removeAll { $0.id == item.id } }
        }
      }
      Button("添加固定单品") { selectedGroup = nil; picking = true }.disabled(draft.components.count >= 50)
    }
    Section("套餐自选组") {
      ForEach($draft.groups) { $group in
        VStack(alignment: .leading, spacing: 12) {
          TextField("自选组名称", text: $group.name)
          TextField("每套选几种", text: $group.selectionCount).keyboardType(.numberPad)
          ForEach($group.options) { $item in
            VStack(alignment: .leading) {
              Text(item.name)
              TextField("选中后的份数", text: $item.quantity).keyboardType(.numberPad)
              Button("移除此候选") { group.options.removeAll { $0.id == item.id } }
            }
          }
          Button("添加候选单品") { selectedGroup = group.id; picking = true }.disabled(group.options.count >= 100)
          Button("删除此自选组") { draft.groups.removeAll { $0.id == group.id } }
        }
      }
      Button("新增自选组") { var group = CatalogBundleGroup(); group.sortOrder = (draft.groups.count + 1) * 10; draft.groups.append(group) }.disabled(draft.groups.count >= 20)
    }
  }
}
struct CatalogConfigurationPicker: View {
  let excluding: String
  let choose: (CatalogConfigurationRecord) -> Void
  var singleOnly = true
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var appliedQuery = ""
  @State private var offset = 0
  @State private var rows: [CatalogConfigurationRecord] = []
  @State private var more = false
  @State private var error = ""
  private func load(_ page: Int, search: String) async {
    do {
      let board = try await model.queryCatalogConfigurationChoices(query: search, offset: page)
      rows = board.products.filter { $0.id != excluding && (!singleOnly || $0.text("productKind") == "single") }
      more = board.products.count == board.limit && page + board.limit <= 10000
      offset = page; appliedQuery = search; error = ""
    } catch { rows = []; more = false; self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      List {
        TextField(singleOnly ? "搜索单品名称或编号" : "搜索商品名称或编号", text: $query)
        Button("查询") { Task { await load(0, search: query) } }.disabled(model.busy || model.heartbeatBusy)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        ForEach(rows) { row in Button(row.text("name") + " · " + row.text("code")) { choose(row) } }
        if rows.isEmpty { Text("本页没有可选商品，可翻页或更换搜索词。") }
        HStack {
          Button("上一页") { Task { await load(max(0, offset - 50), search: appliedQuery) } }.disabled(offset == 0 || model.busy)
          Spacer()
          Button("下一页") { Task { await load(offset + 50, search: appliedQuery) } }.disabled(!more || model.busy)
        }
      }.navigationTitle(singleOnly ? "选择门店单品" : "选择门店商品").toolbar { Button("关闭") { dismiss() } }
    }.task { await load(0, search: "") }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
struct CatalogConfigurationConfirmation: View {
  let command: LiveCommand
  let submitted: () -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var confirmed = false
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(command.steps[0].catalogConfigurationProof?["confirmation"] as? String ?? "请重新核对")
          Toggle("已核对上述配置及影响", isOn: $confirmed)
          Button("确认保存") { Task { await model.executeLive(command); submitted() } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canExecuteLive(command))
        }.padding(20)
      }.navigationTitle("核对原配置").toolbar { Button("返回") { dismiss() } }
    }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
