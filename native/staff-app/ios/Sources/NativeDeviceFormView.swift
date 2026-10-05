import SwiftUI

struct NativeDeviceForm: Identifiable {
  let id = UUID()
  let operation: String
  let row: NativeManagementRow?
  var command = ""
  var fields: [String: String] {
    var result: [String: String] = ["code": "", "name": "", "stationCode": "cashier", "status": "active",
      "printBridgeId": "", "windowsQueueName": "", "printProfile": "", "printerDeviceId": "",
      "productCategoryCode": "", "copies": "1", "priority": "100", "enabled": "true", "reason": "", "command": command]
    if let row {
      for key in result.keys where key != "reason" && key != "command" { result[key] = row.text(key) }
      result["enabled"] = row.bool("enabled") ? "true" : "false"
      if operation == "device-test" { result["reason"] = (nativeDeviceActions[command] ?? "核对设备") + " · " + row.text("name") }
    }
    return result
  }
}
struct NativeDeviceFormView: View {
  let form: NativeDeviceForm
  let board: NativeManagementBoard
  let proposed: (LiveCommand) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: String]
  @State private var error = ""
  init(form: NativeDeviceForm, board: NativeManagementBoard, proposed: @escaping (LiveCommand) -> Void) {
    self.form = form; self.board = board; self.proposed = proposed
    _fields = State(initialValue: form.fields)
  }
  private func value(_ key: String) -> Binding<String> {
    Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 })
  }
  private func choice(_ title: String, _ key: String, _ options: [String: String]) -> some View {
    Picker(title, selection: value(key)) {
      ForEach(options.keys.sorted(), id: \.self) { Text(options[$0] ?? "").tag($0) }
    }.pickerStyle(.menu)
  }
  private var availableQueues: [String] {
    var queues = board.rows("bridges").first { $0.id == fields["printBridgeId"] }?.strings("queues") ?? []
    if fields["printBridgeId"] == form.row?.text("printBridgeId"),
      let original = form.row?.text("windowsQueueName"), !original.isEmpty { queues.append(original) }
    return Set(queues).sorted()
  }
  var body: some View {
    NavigationStack {
      Form {
        if ["device-create", "device-update", "route-save"].contains(form.operation) {
          TextField("编码", text: value("code")).textInputAutocapitalization(.never)
            .autocorrectionDisabled().disabled(form.row != nil)
          TextField("名称", text: value("name"))
          choice("岗位", "stationCode", form.operation == "route-save" ? nativeDeviceStations.filter { $0.key != "service" } : nativeDeviceStations)
          if form.operation != "device-create" { choice("状态", "status", nativeDeviceStatuses) }
        }
        if ["device-create", "device-update"].contains(form.operation) {
          choice("桥接器", "printBridgeId", ["": "暂不绑定"].merging(
            Dictionary(uniqueKeysWithValues: board.rows("bridges").filter { $0.text("status") == "active" || $0.id == form.row?.text("printBridgeId") }.map { ($0.id, $0.text("name")) })
          ) { _, new in new })
          .onChange(of: fields["printBridgeId"]) { _, bridge in
            fields["windowsQueueName"] = ""
            if bridge?.isEmpty != false { fields["printProfile"] = "" }
          }
          choice("Windows打印队列", "windowsQueueName", ["": "未选择"].merging(Dictionary(uniqueKeysWithValues: availableQueues.map { ($0, $0) })) { _, new in new })
          choice("打印格式", "printProfile", ["": "未选择"].merging(nativePrintProfiles) { _, new in new })
          Text("退役后不能重新启用。配置保存不会证明设备在线或已经出纸。").font(.caption)
        }
        if form.operation == "route-save" {
          choice("打印机", "printerDeviceId", ["": "请选择"].merging(Dictionary(uniqueKeysWithValues:
            board.rows("devices").filter { $0.text("status") != "retired" }.map { ($0.id, $0.text("name")) })) { _, new in new })
          TextField("分类编码，留空为岗位全部分类", text: value("productCategoryCode"))
          TextField("优先级 0—1000", text: value("priority")).keyboardType(.numberPad)
          choice("份数", "copies", Dictionary(uniqueKeysWithValues: (1...5).map { (String($0), "\($0)份") }))
        }
        if form.operation == "policy-save" {
          Text(nativeTicketKinds[form.row?.text("ticketKind") ?? ""] ?? "票据策略").font(.headline)
          choice("自动打印", "enabled", ["true": "开启", "false": "关闭"])
          choice("份数", "copies", ["": "跟随实际打印路由"].merging(Dictionary(uniqueKeysWithValues:
            (1...5).map { (String($0), "固定\($0)份") })) { _, new in new })
          Text("跟随路由使用实际命中路由的份数；固定份数覆盖路由设置。不补打旧票据。").font(.caption)
        }
        if form.operation == "bridge-revoke" {
          Text("撤销 " + (form.row?.text("name") ?? "原桥接器")).font(.headline)
          Text("该电脑将停止接收打印任务。已排队票据不会自动转移，需要重新配对或绑定其他电脑。")
        }
        if form.operation == "device-test" {
          Text((nativeDeviceActions[form.command] ?? "核对设备") + " · " + (form.row?.text("name") ?? ""))
          Text("只创建设备任务，随后刷新设备回报并核对现场出纸。")
        }
        TextField("处理说明，3—500字", text: value("reason"), axis: .vertical)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("下一步 · 核对原配置") {
          do { proposed(try model.prepareNativeManagement(operation: form.operation, fields: fields, rowID: form.row?.id)) }
          catch { self.error = error.localizedDescription }
        }.disabled(!model.canUseNativeManagement)
      }.navigationTitle("打印配置").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
