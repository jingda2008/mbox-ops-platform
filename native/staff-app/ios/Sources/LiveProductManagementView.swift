import SwiftUI

struct LiveProductManagementView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var query = ""
  @State private var editing: ProductManagementBoard.Product?
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
            Text("已有账单不改价；套餐构成及分类配置仍需网页管理。恢复在售不代表配方或库存必然满足。").font(.caption)
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
