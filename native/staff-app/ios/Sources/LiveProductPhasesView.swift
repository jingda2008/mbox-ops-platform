import SwiftUI

struct LiveProductPhasesView: View {
  let product: ProductManagementBoard.Product
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var phases: Set<String> = []
  @State private var reason = ""
  @State private var notice = ""
  @State private var proposed: LiveCommand?
  private func load() async {
    proposed = nil
    await model.loadProductPhases(productID: product.id)
    if let board = model.productPhasesBoard, board.productID == product.id { phases = Set(board.phases) }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          LivePendingView()
          Text(product.name).font(.title2.bold())
          Text(model.productPhasesState).font(.subheadline)
          Button("重读原配置") { Task { await load() } }.disabled(model.busy || model.heartbeatBusy)
          if let board = model.productPhasesBoard, board.productID == product.id,
            board.employeeID == model.identity?.employee.id {
            Text("不选择阶段表示取消演出阶段限制；库存、上下架、渠道和时段规则仍分别生效。")
              .font(.subheadline)
            ForEach(productPhaseOrder, id: \.self) { phase in
              Toggle(productPhaseNames[phase]!, isOn: Binding(get: { phases.contains(phase) }, set: { value in
                if value { phases.insert(phase) } else { phases.remove(phase) }
                proposed = nil
              }))
            }
            TextField("修改原因（2—240字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            Button("核对演出阶段配置") {
              do {
                guard let actor = model.identity else { throw StaffAPIError.invalid }
                proposed = try board.command(actor: actor, phases: Array(phases), reason: reason, productName: product.name)
              } catch { notice = error.localizedDescription }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseProductPhases)
          }
        }.padding(20)
      }.background(paper).navigationTitle("商品演出阶段").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    }.task { await load() }.onChange(of: model.workspaceVersion) { _, _ in proposed = nil; dismiss() }
      .onChange(of: model.priorityAccessKey) { _, _ in proposed = nil; dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              Text(command.steps[0].productPhasesProof?["confirmation"] as? String ?? "请重新读取原配置")
              Button("确认保存") { proposed = nil; Task { await model.executeLive(command); await load() } }
                .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canExecuteLive(command))
            }.padding(20)
          }.navigationTitle("核对阶段变更").toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } } }
        }
      }
  }
}
