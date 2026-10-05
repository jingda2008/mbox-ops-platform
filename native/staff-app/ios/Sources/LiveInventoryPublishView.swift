import SwiftUI
struct LiveInventoryPublishView: View {
  let receipt: StockBoard.Receipt
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var productID = ""
  @State private var error = ""
  @State private var confirmed = false
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment:.leading,spacing:16) {
          LivePendingView()
          Text(model.inventoryPublishState).font(.caption)
          Button("重新读取原采购单") { confirmed=false; proposed=nil; Task { await model.loadInventoryPublish(receiptID:receipt.id) } }.disabled(model.busy || model.heartbeatBusy)
          if let board=model.inventoryPublishBoard,board.receipt.id==receipt.id {
            Text("原采购单 " + board.receipt.text("publicId")).font(.headline)
            if board.products.isEmpty {Text("本单尚无关联有效配方的库存单品，请先完成物料和商品配方配置。")}
            Picker("选择本单要发布的商品",selection:$productID) {
              Text("请选择").tag("")
              ForEach(board.products) {p in Text(p.text("name")).tag(p.id)}
            }
            Button("读取整单收货与发布预览") {confirmed=false;proposed=nil;Task {await model.loadInventoryPublishPreview(productID:productID)}}.disabled(productID.isEmpty || model.busy || model.heartbeatBusy)
            if let preview=model.inventoryPublishPreview,preview.productID==productID {
              Text(preview.confirmation).textSelection(.enabled)
              if !preview.ready {Text("发布条件未齐：请检查顾客可见、扫码和员工点单渠道、有效库存。").foregroundStyle(.red)}
              Toggle("已逐行核实整张采购单的全部实物",isOn:$confirmed)
              Button("核对整单收货与商品发布") {
                do {guard let actor=model.identity else {throw StaffAPIError.invalid};proposed=try preview.command(actor:actor,board:board,confirmedWholeReceipt:confirmed)}catch{self.error=error.localizedDescription}
              }.buttonStyle(Primary(symbol:"checklist")).disabled(!confirmed || !model.canUseInventoryPublish)
            }
          }
          if !error.isEmpty {Text(error).foregroundStyle(.red)}
        }.padding(16)
      }.navigationTitle("整单收货与发布").toolbar {Button("关闭"){dismiss()}}
    }.task{await model.loadInventoryPublish(receiptID:receipt.id)}
      .onChange(of:productID){_,_ in confirmed=false;proposed=nil}
      .onChange(of:model.workspaceVersion){_,_ in dismiss()}.onChange(of:model.priorityAccessKey){_,_ in dismiss()}
      .sheet(item:$proposed){command in
        NavigationStack {ScrollView {VStack(alignment:.leading,spacing:20){
          Text(command.steps[0].inventoryPublishProof?["confirmation"] as? String ?? "")
          Button("确认整单收货并发布"){Task{await model.executeLive(command);confirmed=false;proposed=nil}}.buttonStyle(Primary(symbol:"checkmark.shield")).disabled(!model.canExecuteLive(command))
        }.padding(20)}.navigationTitle("确认原采购单").toolbar{Button("返回"){proposed=nil}}}
      }
  }
}
