import SwiftUI

struct LiveKitchenView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var station = "kitchen"
  @State private var showTasks = false
  @State private var handoff: LiveKitchenHandoff?
  @State private var proposed: LiveCommand?
  @State private var bulkID: String?
  @State private var error = ""
  func propose(
    _ action: String, _ id: String, quantity: Int = 1, equipment: String = "", seconds: Int? = nil,
    unitIDs: Set<String> = []
  ) {
    do {
      proposed = try model.prepareKitchen(
        action: action, sourceID: id, quantity: quantity, equipment: equipment, seconds: seconds,
        unitIDs: unitIDs)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          Picker("制作档口", selection: $station) {
            Text("厨房").tag("kitchen")
            Text("吧台").tag("bar")
          }.pickerStyle(.segmented).disabled(model.busy)
          LivePendingView()
          if !model.kitchenState.isEmpty { Text(model.kitchenState).font(.subheadline) }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let board = model.kitchenBoard, board.stationCode == station {
            if !board.canStart { Text("当前暂停新增制作，已有批次可按权限继续处理。").font(.caption) }
            if !board.legacyTaskIds.isEmpty {
              Button("旧任务 / 重做 · \(board.legacyTaskIds.count)项") { showTasks = true }.buttonStyle(
                Primary(tone: .secondary, symbol: "exclamationmark.bubble"))
            }
            Text("待制作 · \(board.pending.count) 项").font(.headline)
            ForEach(board.pending) { row in
              if board.pending.filter({ $0.compatibility == row.compatibility && $0.canPrepare })
                .count > 1
              {
                Button("同品跨桌合批 · " + row.productName) { bulkID = row.id }.buttonStyle(
                  Primary(tone: .secondary, symbol: "square.stack.3d.up")
                ).disabled(!model.canAct("kds.prepare") || !board.canStart)
              }
              KitchenStartCard(
                row: row, equipmentLabels: board.equipmentLabels,
                enabled: model.canAct("kds.prepare") && board.canStart && row.canPrepare
              ) { action, count, equipment, seconds in
                propose(action, row.id, quantity: count, equipment: equipment, seconds: seconds)
              }
            }
            Text("制作批次 · \(board.batches.count) 批").font(.headline)
            ForEach(board.batches) { batch in
              KitchenTimerView(batch: batch, generatedAt: board.generatedAt)
              KitchenBatchCard(
                batch: batch,
                enabled: model.canAct("kds.prepare")
                  && batch.employeeId == model.identity?.employee.id
              ) { action, units in propose(action, batch.id, unitIDs: units) }
              if board.canHandoff && batch.employeeId != model.identity?.employee.id
                && model.identity?.allows("kds.exception.manage") == true
              {
                Button("预览接班范围 · " + batch.productName) {
                  Task { handoff = await model.loadKitchenHandoff(batch.id) }
                }.buttonStyle(Primary(tone: .secondary, symbol: "person.2")).disabled(
                  !model.canAct("kds.prepare"))
              }
            }
            if board.pending.isEmpty && board.batches.isEmpty {
              Text("当前没有制作任务").foregroundStyle(.secondary)
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("出品工作台").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadKitchen(station) } }.disabled(model.busy)
          }
        }
    }.tint(ink).sheet(
      isPresented: Binding(get: { bulkID != nil }, set: { if !$0 { bulkID = nil } })
    ) { if let id = bulkID { LiveKitchenBatchView(sourceID: id) } }.sheet(
      isPresented: $showTasks, onDismiss: { Task { await model.loadKitchen(station) } }
    ) { LiveFulfillmentView() }.sheet(item: $handoff) { preview in
      LiveKitchenHandoffView(preview: preview)
    }.task(
      id: station
    ) { await model.loadKitchen(station) }
    .confirmationDialog(
      proposed?.title ?? "确认出品",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button("核对实物后确认") {
          proposed = nil
          Task { await model.executeLive(command) }
        }
      }
    } message: {
      Text("请按实际制作或备齐份数确认。释放设备不等于商品已完成或已取走。")
    }
  }
}
private struct KitchenStartCard: View {
  let row: LiveKitchen.Pending
  let equipmentLabels: [String]
  let enabled: Bool
  let action: (String, Int, String, Int?) -> Void
  @State private var quantity = 1
  @State private var equipment = ""
  @State private var seconds = ""
  var body: some View {
    Card {
      HStack {
        Text(row.productName).font(.headline)
        Spacer()
        Text(row.tableCode).font(.headline).foregroundStyle(ink)
      }
      if !row.specification.isEmpty { Text(row.specification).font(.subheadline) }
      if !row.itemNote.isEmpty { Text("商品备注：" + row.itemNote) }
      if !row.orderNote.isEmpty { Text("整单备注：" + row.orderNote) }
      Stepper(
        "本次 \(quantity) / 待制作 \(row.unmade) 份", value: $quantity,
        in: 1...max(1, min(999, row.unmade)))
      Picker("设备", selection: $equipment) {
        Text("无需设备").tag("")
        ForEach(equipmentLabels, id: \.self) { Text($0).tag($0) }
      }
      TextField("预计秒数（可不填，最长36000）", text: $seconds).keyboardType(.numberPad)
      Button("开始制作") { action("start", quantity, equipment, Int(seconds)) }.buttonStyle(
        Primary(symbol: "flame.fill")
      ).disabled(!enabled || (!seconds.isEmpty && !(1...36000).contains(Int(seconds) ?? 0)))
      Button("无需制作 · 已实际备齐") { action("quick-ready", quantity, "", nil) }.buttonStyle(
        Primary(tone: .secondary, symbol: "checkmark.circle")
      ).disabled(!enabled)
    }
  }
}
private struct KitchenBatchCard: View {
  let batch: LiveKitchen.Batch
  let enabled: Bool
  let action: (String, Set<String>) -> Void
  @State private var selected: Set<String> = []
  var body: some View {
    Card {
      Text(batch.productName).font(.headline)
      Text(
        "负责人：" + batch.employeeName + " · " + (batch.equipment ?? "无需设备")
          + (batch.releasedAt == nil ? "" : " · 已释放")
      ).font(.caption)
      if !batch.specification.isEmpty { Text(batch.specification) }
      if !batch.itemNote.isEmpty { Text("商品备注：" + batch.itemNote) }
      if !batch.orderNote.isEmpty { Text("整单备注：" + batch.orderNote) }
      ForEach(Array(batch.units.enumerated()), id: \.element.id) { index, unit in
        Button {
          if selected.contains(unit.id) {
            selected.remove(unit.id)
          } else {
            selected.insert(unit.id)
          }
        } label: {
          HStack {
            Text(
              unit.tableCode + " · 第\(index + 1)份 · "
                + (unit.stopped
                  ? "已停止"
                  : unit.held
                    ? "已暂停"
                    : ["unmade": "待制作", "started": "制作中", "ready": "已备齐", "delivered": "已取送"][
                      unit.state] ?? "待核对"))
            Spacer()
            Image(systemName: selected.contains(unit.id) ? "checkmark.circle.fill" : "circle")
          }
        }.disabled(!enabled || !unit.canReady)
      }
      Button("确认所选 \(selected.count) 份已实际备齐") { action("ready", selected) }.buttonStyle(
        Primary(symbol: "checkmark.circle.fill")
      ).disabled(!enabled || selected.isEmpty)
      Button("实物已移出 · 释放设备") { action("release", []) }.buttonStyle(
        Primary(tone: .secondary, symbol: "tray.and.arrow.up")
      ).disabled(!enabled || batch.releasedAt != nil)
    }.onChange(of: batch.units.filter(\.canReady).map(\.id)) { _, ids in
      selected.formIntersection(Set(ids))
    }
  }
}

private struct LiveKitchenHandoffView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let preview: LiveKitchenHandoff
  @State private var checked = false
  @State private var reason = ""
  @State private var error = ""
  var body: some View {
    NavigationStack {
      Form {
        Section("本次接班范围") {
          Text(
            "共 \(preview.batches.count) 批制作、\(preview.tasks.count) 项任务，将交给当前员工：" + model.staffName)
          ForEach(preview.displayLines) { row in
            VStack(alignment: .leading, spacing: 5) {
              Text(row.productName + " · 剩余\(row.remaining)份").font(.headline)
              Text(row.tableCodes.joined(separator: "、"))
              if !row.specification.isEmpty { Text(row.specification) }
              if !row.itemNote.isEmpty { Text("商品备注：" + row.itemNote) }
              if !row.orderNote.isEmpty { Text("整单备注：" + row.orderNote) }
              Text((row.equipment ?? "无需设备") + (row.released ? " · 已释放" : " · 占用中")).font(.caption)
            }
          }
        }
        Section {
          Toggle("已逐项核对以上实物与制作进度", isOn: $checked)
          TextField("接班原因（2—1000字）", text: $reason, axis: .vertical)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          Button("确认按以上完整范围接班") {
            do {
              guard model.canAct("kds.prepare"), let actor = model.identity,
                let board = model.kitchenBoard
              else { throw CatalogError("请返回刷新后重新预览") }
              let command = try preview.command(
                actor: actor, board: board, reason: reason, physicalChecked: checked)
              dismiss()
              Task { await model.executeLive(command) }
            } catch { self.error = error.localizedDescription }
          }.buttonStyle(Primary(symbol: "person.badge.plus")).disabled(
            !checked || model.busy
              || !(2...1000).contains(
                reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
          )
        }
      }.navigationTitle("接班确认").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
    }.tint(ink)
  }
}
