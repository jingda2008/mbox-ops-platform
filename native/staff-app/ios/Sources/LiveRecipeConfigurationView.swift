import SwiftUI
struct LiveRecipeConfigurationView: View {
  let product: ProductManagementBoard.Product
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment:.leading,spacing:16) {
          LivePendingView()
          Text(model.recipeConfigurationState).font(.caption)
          Button("重新读取原配方") { Task { await model.loadRecipeConfiguration(productID:product.id) } }.disabled(model.busy || model.heartbeatBusy)
          if let board = model.recipeConfigurationBoard, board.product.id == product.id {
            if let cost = model.recipeCostPreview {
              Card {
                Text("已保存配方的当前成本").font(.headline)
                Text(cost.amountMinor.map(money) ?? "待核对（物料成本缺失）")
                ForEach(cost.components) { c in
                  Text(c.text("itemName") + " · " + c.text("componentQuantity") + " " + c.text("baseUnit") + " · " + (c.object["componentCostMinor"] is NSNull ? "成本待核对" : recipeMinorText(c.text("componentCostMinor"))))
                }
              }
            }
            RecipeConfigurationEditor(board:board).id(board.version)
          }
        }.padding(16)
      }.navigationTitle("配方与耗料").toolbar { Button("关闭") { dismiss() } }
    }.task { await model.loadRecipeConfiguration(productID:product.id) }
      .onChange(of:model.workspaceVersion) { _,_ in dismiss() }.onChange(of:model.priorityAccessKey) { _,_ in dismiss() }
  }
}
private struct RecipeConfigurationEditor: View {
  let board: RecipeConfigurationBoard
  @EnvironmentObject var model: AppModel
  @State private var draft: RecipeConfigurationDraft
  @State private var query = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  init(board:RecipeConfigurationBoard) { self.board=board; _draft=State(initialValue:RecipeConfigurationDraft(board:board)) }
  var body: some View {
    VStack(alignment:.leading,spacing:16) {
      Text(board.product.text("name")).font(.title2)
      Text(board.recipe == nil ? "尚无配方" : "原配方版本 \(board.originalVersion)")
      TextField("每批产出份数（1—1000）",text:$draft.output).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
      TextField("制作说明",text:$draft.notes,axis:.vertical).textFieldStyle(.roundedBorder)
      Text("所有用量按物料基础单位填写；包装瓶数不能直接当作毫升。").font(.caption)
      ForEach($draft.lines) { $line in
        Card {
          let item = board.items.first { $0.id == line.id }
          Text(item.map { $0.text("name") + " · " + $0.text("baseUnit") } ?? "原物料已停用，请移除并替换")
          TextField("每批实际用量",text:$line.quantity).keyboardType(.decimalPad).textFieldStyle(.roundedBorder)
          TextField("每批预计损耗",text:$line.waste).keyboardType(.decimalPad).textFieldStyle(.roundedBorder)
          Button("移除此物料",role:.destructive) { draft.lines.removeAll { $0.id == line.id } }
        }
      }
      TextField("搜索物料名称或编号",text:$query).textFieldStyle(.roundedBorder)
      ForEach(Array(board.items.filter { item in !draft.lines.contains { $0.id == item.id } && (query.isEmpty || (item.text("name") + item.text("sku")).localizedCaseInsensitiveContains(query)) }.prefix(30))) { item in
        Button("加入 " + item.text("name") + " · " + item.text("baseUnit")) { draft.lines.append(RecipeConfigurationLine(id:item.id)) }.disabled(draft.lines.count >= 100)
      }
      Text("每次显示前30项，可搜索缩小范围。").font(.caption)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("核对配方与耗料") {
        do { guard let actor=model.identity else { throw StaffAPIError.invalid }; proposed=try draft.command(actor:actor,board:board) }
        catch { self.error=error.localizedDescription }
      }.buttonStyle(Primary(symbol:"list.clipboard")).disabled(!model.canUseRecipeConfiguration)
    }.sheet(item:$proposed) { command in
      NavigationStack {
        ScrollView { VStack(alignment:.leading,spacing:20) {
          Text(command.steps[0].recipeConfigurationProof?["confirmation"] as? String ?? "")
          Button("确认保存配方") { Task { await model.executeLive(command); proposed=nil } }.buttonStyle(Primary(symbol:"checkmark.shield")).disabled(!model.canExecuteLive(command))
        }.padding(20) }.navigationTitle("核对配方").toolbar { Button("返回") { proposed=nil } }
      }
    }
  }
}
