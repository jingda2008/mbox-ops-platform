import SwiftUI
import VisionKit

struct LiveInventorySetupView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var creating = false
  @State private var edit: InventorySetupEdit?
  @State private var search = ""
  var body: some View {
    NavigationStack {
      List {
        LivePendingView()
        Text(model.inventorySetupState).font(.caption)
        Button("重新读取物料") { Task { await model.loadInventorySetup() } }.disabled(model.busy || model.heartbeatBusy)
        Button("新建物料") { creating = true }.disabled(!model.canUseInventorySetup)
        TextField("搜索名称、编号或条码", text: $search)
        ForEach(model.inventorySetupBoard?.items.filter { row in
          search.isEmpty || row.text("name").localizedCaseInsensitiveContains(search) || row.text("sku").localizedCaseInsensitiveContains(search)
            || (row.object["barcodes"] as? [[String: Any]] ?? []).contains { ($0["code"] as? String ?? "").localizedCaseInsensitiveContains(search) }
        } ?? []) { item in
          VStack(alignment: .leading, spacing: 10) {
            Text(item.text("name")).font(.headline)
            Text(item.text("sku") + " · " + item.text("baseUnit")).font(.caption)
            Button("维护物料资料") { edit = InventorySetupEdit(kind: "edit", item: item) }.disabled(!model.canUseInventorySetup)
            Button("绑定包装条码") { edit = InventorySetupEdit(kind: "bind", item: item) }.disabled(!model.canUseInventorySetup)
          }
        }
      }.navigationTitle("物料与包装条码").toolbar { Button("关闭") { dismiss() } }
    }.task { await model.loadInventorySetup() }
      .sheet(isPresented: $creating) { InventorySetupEditor(kind: "create", item: nil) }
      .sheet(item: $edit) { InventorySetupEditor(kind: $0.kind, item: $0.item) }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .onChange(of: model.priorityAccessKey) { _, _ in dismiss() }
  }
}
private struct InventorySetupEdit: Identifiable {
  let kind: String
  let item: CatalogConfigurationRecord
  var id: String { kind + ":" + item.id }
}
private struct InventorySetupEditor: View {
  let kind: String
  let item: CatalogConfigurationRecord?
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var draft = InventorySetupDraft()
  @State private var error = ""
  @State private var scanning = false
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      Form {
        if kind == "bind", let item {
          Section(item.text("name")) {
            ForEach(Array((item.object["barcodes"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, code in
              Text((code["code"] as? String ?? "") + " · 每码 " + (code["packageQuantity"] as? String ?? "待核对") + " " + item.text("baseUnit"))
            }
            TextField("包装条码内容", text: $draft.barcode).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("扫描包装条码") {
              guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else { error = "当前设备暂不可扫码，可手动输入包装原码"; return }
              scanning = true
            }
            Picker("码类型", selection: $draft.barcodeType) { Text("商品条码").tag("barcode"); Text("二维码").tag("qr"); Text("内部编码").tag("internal") }
            TextField("每码代表的基础单位数量", text: $draft.packageQuantity).keyboardType(.decimalPad)
            Text("例如12件/箱填12，750毫升/瓶填750。毫升物料须与登记净含量一致；不会覆盖冲突绑定。").font(.caption)
          }
        } else {
          Section("物料资料") {
            TextField("物料名称", text: $draft.name)
            if item == nil {
              TextField("唯一物料编号", text: $draft.sku).textInputAutocapitalization(.never).autocorrectionDisabled()
              Picker("类型", selection: $draft.itemType) { ForEach(inventorySetupTypes.keys.sorted(), id: \.self) { Text(inventorySetupTypes[$0]!).tag($0) } }
              Picker("基础单位", selection: $draft.baseUnit) { ForEach(inventorySetupUnits.keys.sorted(), id: \.self) { Text(inventorySetupUnits[$0]! + " " + $0).tag($0) } }
              Toggle("盘点只接受整数基础单位", isOn: $draft.wholeUnits)
              TextField("合理损耗量（基础单位）", text: $draft.waste).keyboardType(.decimalPad)
            } else { Text(draft.sku + " · " + draft.baseUnit + "\n编号、类型和基础单位保留，已有库存不重算。").font(.caption) }
            TextField("分类编码，例如 spirits、snack", text: $draft.category).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("每瓶净含量 ml，非液体可留空", text: $draft.volume).keyboardType(.decimalPad)
            TextField("低库存提醒数量，可留空", text: $draft.lowStock).keyboardType(.decimalPad)
            Text("酒水、啤酒、果汁和糖浆按毫升管理。每瓶净含量用于扫码收货换算，不能把1瓶填成1毫升。").font(.caption)
          }
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("核对原物料配置") {
          do {
            guard let actor = model.identity, let board = model.inventorySetupBoard else { throw StaffAPIError.invalid }
            proposed = try draft.command(actor: actor, board: board, item: item)
          } catch { self.error = error.localizedDescription }
        }.disabled(!model.canUseInventorySetup)
      }.navigationTitle(kind == "bind" ? "包装条码" : "物料配置").toolbar { Button("关闭") { dismiss() } }
    }.task { draft = InventorySetupDraft(kind: kind, item: item) }
      .sheet(isPresented: $scanning) {
        NativePaymentScanner(inventory: true) { value in draft.barcode = value; scanning = false }
          failed: { notice in error = notice; scanning = false }
      }.sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              Text(command.steps[0].inventorySetupProof?["confirmation"] as? String ?? "请重新核对")
              Button("确认保存") { Task { await model.executeLive(command); dismiss() } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canExecuteLive(command))
            }.padding(20)
          }.navigationTitle("核对变更").toolbar { Button("返回") { proposed = nil } }
        }
      }.onChange(of: model.workspaceVersion) { _, _ in proposed = nil; dismiss() }
  }
}
