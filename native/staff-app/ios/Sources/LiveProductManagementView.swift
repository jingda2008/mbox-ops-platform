import SwiftUI

struct LiveProductManagementView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var query = ""
  @State private var editing: ProductManagementBoard.Product?
  @State private var operationalProduct: CatalogConfigurationRecord?
  @State private var companionSource: CatalogConfigurationRecord?
  @State private var configuring: CatalogConfigurationRecord?
  @State private var creating = false
  @State private var categories = false
  @State private var recipeProduct: ProductManagementBoard.Product?
  @State private var phaseProduct: ProductManagementBoard.Product?
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.productState).font(.caption)
          HStack {
            TextField("商品名称或编码", text: $query).textFieldStyle(.roundedBorder)
            Button("查询") { Task { await model.loadProducts(query: query) } }.disabled(model.busy)
          }
          if model.catalogConfigurationBoard?.enabled == true {
            Button("新建商品或套餐") { creating = true }.disabled(!model.canUseProducts)
            Button("菜单分类") { categories = true }.disabled(!model.canUseProducts)
          }
          if let board = model.productBoard {
            if board.products.isEmpty { Text("没有匹配商品") }
            ForEach(board.products) { p in
              Card {
                Text(p.name).font(.headline)
                Text(p.code + " · " + (p.productKind == "bundle" ? "套餐" : "单品")).font(.caption)
                Text(p.summary).font(.subheadline)
                Text(
                  p.priceText.isEmpty ? "未配置标准价" : "¥" + p.priceText + " · 排序 \(p.menuSortOrder)")
                Button("编辑商品") { editing = p }.buttonStyle(
                  Primary(tone: .secondary, symbol: "slider.horizontal.3")
                ).disabled(!model.canUseProducts)
                if let configuration = model.catalogConfigurationBoard?.products.first(where: { $0.id == p.id }) {
                  Button("商品、套餐与供应配置") { configuring = configuration }.disabled(!model.canUseProducts)
                  if model.catalogConfigurationBoard?.operationalEnabled == true {
                    Button("规格、推荐与出品规则") { operationalProduct = configuration }.disabled(!model.canUseProducts)
                    if configuration.text("productKind") == "single", configuration.text("inventoryControlMode") == "tracked",
                      let snapshot = configuration.object["productSnapshot"] as? [String: Any], let specification = snapshot["salesSpecificationType"] as? String,
                      ["whole_bottle", "glass"].contains(specification) {
                      Button(specification == "whole_bottle" ? "新建对应单杯商品" : "新建对应整瓶商品") { companionSource = configuration }.disabled(!model.canUseProducts)
                    }
                  }
                }
                if p.productKind == "single", model.identity?.allows("inventory.manage") == true {
                  Button("配方、耗料与成本") { recipeProduct = p }.disabled(model.busy || model.heartbeatBusy)
                }
                if model.identity?.allows("recommendation.phase.configure") == true {
                  Button("演出阶段供应限制") { phaseProduct = p }.disabled(model.busy || model.heartbeatBusy)
                }
              }
            }
            HStack {
              Button("上一页") {
                Task {
                  await model.loadProducts(query: query, offset: max(0, board.offset - board.limit))
                }
              }.disabled(board.offset == 0 || model.busy)
              Spacer()
              Text("第\(board.offset / board.limit + 1)页")
              Spacer()
              Button("下一页") {
                Task { await model.loadProducts(query: query, offset: board.offset + board.limit) }
              }.disabled(board.products.count < board.limit || model.busy)
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("商品管理").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") {
              Task {
                await model.loadProducts(query: query, offset: model.productBoard?.offset ?? 0)
              }
            }.disabled(model.busy)
          }
        }
    }.task { await model.loadProducts() }.onChange(of: model.workspaceVersion) { dismiss() }
      .onChange(of: model.priorityAccessKey) { dismiss() }.sheet(
      item: $editing
    ) { ProductManagementEditor(product: $0) }
      .sheet(item: $recipeProduct) { LiveRecipeConfigurationView(product: $0) }
      .sheet(item: $phaseProduct) { LiveProductPhasesView(product: $0) }
      .sheet(item: $operationalProduct) { LiveProductOperationsView(product: $0) }
      .sheet(item: $companionSource) { LiveCatalogConfigurationView(product: nil, companionSource: $0) }
      .sheet(item: $configuring) { LiveCatalogConfigurationView(product: $0) }
      .sheet(isPresented: $creating) { LiveCatalogConfigurationView(product: nil) }
      .sheet(isPresented: $categories) { LiveCategoryConfigurationView() }
  }
}
private struct ProductManagementEditor: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let product: ProductManagementBoard.Product
  @State private var status: String
  @State private var visible: Bool
  @State private var sort: String
  @State private var price: String
  @State private var reason = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  init(product: ProductManagementBoard.Product) {
    self.product = product
    _status = State(initialValue: product.status)
    _visible = State(initialValue: product.guestVisible)
    _sort = State(initialValue: String(product.menuSortOrder))
    _price = State(initialValue: product.priceText)
  }
  var body: some View {
    NavigationStack {
      Form {
        Section(product.name) {
          Picker("销售状态", selection: $status) {
            Text("在售").tag("active")
            Text("售罄").tag("sold_out")
            Text("下架").tag("inactive")
          }
          Toggle("客人菜单可见", isOn: $visible)
          TextField("展示顺序 0—10000", text: $sort).keyboardType(.numberPad)
        }
        if model.productBoard?.canPrice == true {
          Section("售价") {
            TextField("人民币元", text: $price).keyboardType(.decimalPad)
            TextField("改价原因", text: $reason)
            Text("已有账单不改价；套餐构成及分类可在商品管理的配置入口调整。恢复在售不代表配方或库存必然满足。").font(.caption)
          }
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("核对变更") {
          do {
            guard let actor = model.identity, let board = model.productBoard else {
              throw CatalogError("请刷新商品")
            }
            proposed = try productManagementCommand(
              actor: actor, board: board, product: product, status: status, visible: visible,
              sort: sort, price: price, reason: reason)
          } catch { self.error = error.localizedDescription }
        }.buttonStyle(Primary(symbol: "checkmark")).disabled(!model.canUseProducts)
      }.navigationTitle("编辑商品").navigationBarTitleDisplayMode(.inline).toolbar {
        Button("取消") { dismiss() }
      }
    }
    .alert(
      "确认商品变更", isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      presenting: proposed
    ) { command in
      Button("确认提交") {
        Task { await model.executeLive(command) }
        dismiss()
      }.disabled(!model.canExecuteLive(command))
      Button("返回核对", role: .cancel) { proposed = nil }
    } message: { command in
      Text(command.steps[0].productManagementProof?["confirmation"] as? String ?? "请核对")
    }
  }
}
