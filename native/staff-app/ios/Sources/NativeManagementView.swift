import SwiftUI

struct NativeManagementView: View {
  let module: NativeManagementModule
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var section = "devices"
  @State private var editing: NativeDeviceForm?
  @State private var proposed: LiveCommand?
  @State private var pairingReason = ""
  @State private var pairingConfirm = false
  private var board: NativeManagementBoard? {
    model.nativeManagementBoard?.module == module ? model.nativeManagementBoard : nil
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          LivePendingView()
          Text(model.nativeManagementState).font(.caption)
          Button("刷新配置与执行结果") { Task { await model.loadNativeManagement(module) } }
            .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
          if module == .devices {
            Picker("查看", selection: $section) {
              Text("打印机").tag("devices"); Text("打印路由").tag("routes")
              Text("票据策略").tag("policies"); Text("桥接器").tag("bridges")
              Text("设备操作记录").tag("commands")
            }.pickerStyle(.menu)
            if section == "devices" {
              Button("添加打印机") { editing = .init(operation: "device-create", row: nil) }
                .buttonStyle(Primary(symbol: "plus")).disabled(!model.canUseNativeManagement)
            }
            if section == "routes" {
              Button("添加打印路由") { editing = .init(operation: "route-save", row: nil) }
                .buttonStyle(Primary(symbol: "plus")).disabled(!model.canUseNativeManagement)
            }
            if section == "bridges" { bridgePairing }
            if let board {
              ForEach(board.rows(section)) { row in
                Card { deviceRow(row, board: board) }
              }
              if board.rows(section).isEmpty { Text("当前没有记录").foregroundStyle(.secondary) }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle(module.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    }
    .task { await model.loadNativeManagement(module) }
    .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
    .onChange(of: model.priorityAccessKey) { _, _ in dismiss() }
    .onDisappear { model.clearBridgePairing() }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { model.clearBridgePairing() }
    }
    .task(id: model.bridgePairing?.id) {
      guard let pairing = model.bridgePairing else { return }
      let delay = max(0, min(601, pairing.expiresAt.timeIntervalSinceNow))
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      if model.bridgePairing?.id == pairing.id { model.clearBridgePairing() }
    }
    .sheet(item: $editing) { form in
      if let board {
        NativeDeviceFormView(form: form, board: board) { command in
          editing = nil; proposed = command
        }
      }
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps.first?.nativeManagementProof?["confirmation"] as? String ?? "请重新读取原配置")
            Button("确认执行") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
          .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } } }
      }
    }
    .confirmationDialog("授权门店打印电脑配对", isPresented: $pairingConfirm, titleVisibility: .visible) {
      Button("生成10分钟配对码") { Task { await model.createBridgePairing(reason: pairingReason) } }
      Button("取消", role: .cancel) {}
    } message: {
      Text("配对码可授权门店电脑接收打印任务，只应输入认可的 M-BOX 打印桥程序。\n说明：\(pairingReason)\n失去响应不会自动重试；之前可能生成的码会到期。")
    }
  }
  @ViewBuilder private var bridgePairing: some View {
    Text("在门店 Windows 打印电脑的 M-BOX 桥接程序输入配对码，完成后刷新并绑定该电脑上报的队列。")
      .font(.caption).foregroundStyle(.secondary)
    TextField("配对说明，至少3字", text: $pairingReason, axis: .vertical).textFieldStyle(.roundedBorder)
    Button("生成配对码") { pairingConfirm = true }.buttonStyle(Primary(tone: .secondary, symbol: "link"))
      .disabled(!model.canUseNativeManagement || !(3...500).contains(pairingReason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count))
    if let pairing = model.bridgePairing {
      Card {
        Text(pairing.pairingCode).font(.title3.monospaced()).textSelection(.enabled)
        Text("仅在门店打印电脑输入；到期或关闭此页将隐藏。到期：" + pairing.expiresAt.formatted(date: .omitted, time: .standard)).font(.caption)
        Button("隐藏配对码") { model.clearBridgePairing() }
      }.privacySensitive()
    }
  }
  @ViewBuilder private func deviceRow(_ row: NativeManagementRow, board: NativeManagementBoard) -> some View {
    switch section {
    case "devices":
      Text(row.text("name")).font(.headline)
      Text(row.text("code") + " · " + (nativeDeviceStations[row.text("stationCode")] ?? "未分配岗位")
        + " · " + (nativeDeviceStatuses[row.text("status")] ?? "待核对"))
      Text("连接：" + (["online": "在线", "offline": "离线", "degraded": "异常", "unknown": "未确认"][row.text("connectivityStatus")] ?? "待核对"))
      Text("队列：" + (row.text("windowsQueueName").isEmpty ? "未绑定" : row.text("windowsQueueName"))).font(.caption)
      if !row.text("lastSeenAt").isEmpty { Text("最近上报 " + reservationTime(row.text("lastSeenAt"))).font(.caption) }
      Button("编辑配置") { editing = .init(operation: "device-update", row: row) }
        .buttonStyle(Primary(tone: .secondary, symbol: "pencil")).disabled(!model.canUseNativeManagement)
      if row.text("status") != "retired" {
        ForEach(["test_print", "ping", "reconnect"], id: \.self) { action in
          Button(nativeDeviceActions[action] ?? "核对设备") {
            editing = .init(operation: "device-test", row: row, command: action)
          }.disabled(!model.canUseNativeManagement)
        }
      }
    case "routes":
      Text(row.text("name")).font(.headline)
      Text((nativeDeviceStations[row.text("stationCode")] ?? "待核对") + " · " + row.text("copies") + "份 · "
        + (nativeDeviceStatuses[row.text("status")] ?? "待核对"))
      Text("打印机：" + (board.rows("devices").first { $0.id == row.text("printerDeviceId") }?.text("name") ?? "待核对"))
      Text("商品分类：" + (row.text("productCategoryCode").isEmpty ? "岗位全部分类" : row.text("productCategoryCode"))).font(.caption)
      Button("编辑路由") { editing = .init(operation: "route-save", row: row) }
        .buttonStyle(Primary(tone: .secondary, symbol: "pencil")).disabled(!model.canUseNativeManagement)
    case "policies":
      Text(nativeTicketKinds[row.text("ticketKind")] ?? "票据类型待核对").font(.headline)
      Text((row.bool("enabled") ? "自动打印开启" : "自动打印关闭") + " · "
        + (row.object["copies"] is NSNull ? "份数跟随打印路由" : "固定\(row.text("copies"))份"))
      Text("影响后续自动票据；已有任务和手动打印分别处理。").font(.caption)
      Button("调整策略") { editing = .init(operation: "policy-save", row: row) }
        .buttonStyle(Primary(tone: .secondary, symbol: "slider.horizontal.3")).disabled(!model.canUseNativeManagement)
    case "bridges":
      Text(row.text("name")).font(.headline)
      Text(row.text("hostname") + " · " + (row.text("status") == "revoked" ? "已撤销" : row.bool("online") ? "在线" : "离线"))
      Text("桥接器版本 " + row.text("softwareVersion")).font(.caption)
      ForEach(row.strings("queues"), id: \.self) { Text($0).font(.caption) }
      if row.text("status") == "active" {
        Button("撤销此桥接器", role: .destructive) { editing = .init(operation: "bridge-revoke", row: row) }
          .disabled(!model.canUseNativeManagement || !board.bridgeRevocationEnabled)
      }
      if !board.bridgeRevocationEnabled { Text("后台未开放安全撤销，当前仅可查看。").font(.caption) }
    default:
      Text(row.text("deviceName")).font(.headline)
      Text((nativeDeviceActions[row.text("commandType")] ?? "设备操作") + " · "
        + (["requested": "等待设备", "executing": "执行中", "succeeded": "设备回报成功", "failed": "执行失败", "cancelled": "已取消"][row.text("status")] ?? "待核对"))
      Text(reservationTime(row.text("createdAt"))).font(.caption)
      if !row.text("errorCode").isEmpty { Text("设备错误：" + row.text("errorCode")).foregroundStyle(.red) }
      Text("设备回报与现场实际出纸仍需分别核对。").font(.caption)
    }
  }
}
