import SwiftUI

struct LivePickupView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var proposed: LiveCommand?
  @State private var error = ""
  @State private var label = ""
  func propose(_ action: String, target: String = "", units: Set<String> = [], enabled: Bool = true)
  {
    do {
      proposed = try model.preparePickup(
        action: action, target: target, units: units, label: label, enabled: enabled)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !model.pickupState.isEmpty { Text(model.pickupState) }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let board = model.pickupBoard {
            Text(board.device.map { "取餐设备 · " + $0.label } ?? "本设备尚未授权取餐").font(.subheadline)
            if !board.setup.enabled { Text("新增设备准入已暂停；现有设备以当前操作权限为准。").font(.caption) }
            ForEach(Array(board.attention.enumerated()), id: \.offset) { _, row in
              Text(row.message).font(.caption).foregroundStyle(.orange)
            }
            Text("待取餐 · \(board.tables.count) 桌").font(.headline)
            ForEach(board.tables) { table in
              PickupTableCard(
                table: table, enabled: model.canAct("kds.deliver") && board.actor.canPickup
              ) { selected in propose("take", target: table.id, units: selected) }
            }
            if board.tables.isEmpty { Text("当前没有待取餐商品").foregroundStyle(.secondary) }
            Foldout(title: "领取记录 · \(board.history.count)笔") {
              ForEach(board.history) { receipt in
                Card {
                  Text(receipt.tableCode + " · \(receipt.quantity)份").font(.headline)
                  Text(receipt.takenAt).font(.caption)
                  ForEach(receipt.units) { unit in
                    Text(
                      unit.productName + (unit.kind == "remake" ? " · 重做" : "") + " · "
                        + unit.specification
                    ).font(.subheadline)
                  }
                  if receipt.undo != nil {
                    Text("已撤回领取").foregroundStyle(.secondary)
                  } else if receipt.canUndo {
                    Button("实物仍在取餐区 · 撤回本笔全部领取") { propose("undo", target: receipt.id) }
                      .buttonStyle(Primary(tone: .secondary, symbol: "arrow.uturn.backward"))
                      .disabled(!model.canAct("kds.deliver") || !board.actor.canUndo)
                  } else {
                    Text(receipt.undoBlockedReason ?? "当前不可撤回").font(.caption)
                  }
                }
              }
            }
            if board.actor.canConfigure {
              Foldout(title: "管理本取餐设备") {
                TextField("设备名称（1—40字）", text: $label).textFieldStyle(.roundedBorder)
                Button("授权为共享取餐屏") { propose("device") }.buttonStyle(Primary(symbol: "display"))
                  .disabled(!model.canAct("staff.access.configure") || !board.setup.enabled)
                if board.setup.configured {
                  Button("停用本设备取餐功能") { propose("device", enabled: false) }.buttonStyle(
                    Primary(tone: .secondary, symbol: "pause.circle")
                  ).disabled(!model.canAct("staff.access.configure"))
                }
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("取餐台").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadPickup() } }.disabled(model.busy)
          }
        }
    }.tint(ink).task {
      await model.loadPickup()
      label = model.pickupBoard?.device?.label ?? ""
    }
    .confirmationDialog(
      proposed?.title ?? "确认取餐操作",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button(
          command.steps.first?.object["action"] as? String == "undo" ? "确认全部实物仍在取餐区，撤回领取" : "核对后确认"
        ) {
          proposed = nil
          Task { await model.executeLive(command) }
        }
      }
    } message: {
      Text("取走确认会登记取送完成；撤回会撤销本笔全部领取，必须确认实物仍在取餐区。")
    }
  }
}
private struct PickupTableCard: View {
  let table: LivePickup.Table
  let enabled: Bool
  let take: (Set<String>) -> Void
  @State private var selected: Set<String> = []
  var body: some View {
    Card {
      HStack {
        Text(table.tableCode).font(.title3.bold())
        Spacer()
        Text("\(table.units.count)份待取").font(.subheadline)
      }
      ForEach(Array(table.units.enumerated()), id: \.element.id) { index, unit in
        Button {
          if selected.contains(unit.id) {
            selected.remove(unit.id)
          } else {
            selected.insert(unit.id)
          }
        } label: {
          HStack(alignment: .top) {
            Image(systemName: selected.contains(unit.id) ? "checkmark.circle.fill" : "circle")
            VStack(alignment: .leading, spacing: 4) {
              Text("\(index + 1). " + unit.productName + (unit.kind == "remake" ? " · 重做" : ""))
                .font(.headline)
              if !unit.specification.isEmpty { Text(unit.specification) }
              if !unit.itemNote.isEmpty { Text("商品备注：" + unit.itemNote) }
              if !unit.orderNote.isEmpty { Text("整单备注：" + unit.orderNote) }
              Text(unit.pickupLocation).font(.caption)
            }
            Spacer()
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
        }.disabled(!enabled)
      }
      Button("确认取走所选 \(selected.count) 份") { take(selected) }.buttonStyle(
        Primary(symbol: "tray.and.arrow.up.fill")
      ).disabled(!enabled || selected.isEmpty)
    }.onChange(of: table.units.map(\.id)) { _, ids in selected.formIntersection(Set(ids)) }
  }
}
