import SwiftUI

struct LiveParticipantsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let tableID: String
  @State private var kind = "participant_split"
  @State private var target = ""
  @State private var quantity = "1"
  @State private var selected = Set<String>()
  @State private var reason = ""
  @State private var capacityReason = ""
  @State private var confirmed = false
  @State private var error = ""
  @State private var proposed: LiveCommand?
  private var source: LiveOperations.Table? {
    model.liveOperations?.tables.first { $0.id == tableID }
  }
  private var targets: [LiveOperations.Table] {
    (model.liveOperations?.tables ?? []).filter {
      $0.id != tableID
        && (kind == "participant_split"
          ? $0.status == "available" && $0.activeSession == nil
          : $0.activeSession?.status == "open")
    }.sorted { $0.code.localizedStandardCompare($1.code) == .orderedAscending }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.participantState).font(.caption)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let source, let session = source.activeSession {
            Text("\(source.code) · 当前\(session.guestCount)人").font(.headline)
            if let preview = model.participantPreview, let input = model.participantInput {
              Card {
                Text("\(input.sourceCode) → \(input.targetCode) · \(input.quantity)人").font(
                  .headline)
                Text(preview.accountingBoundary).font(.caption)
                Text("目标桌 \(preview.projectedGuestCount) / \(preview.targetCapacity)人")
                Text("现场原因：" + input.reason)
                if !input.capacityReason.isEmpty { Text("加座说明：" + input.capacityReason) }
                ForEach(Array(preview.blockers.enumerated()), id: \.offset) { _, row in
                  Text("\(row.label) \(row.count)项；\(row.resolution)").foregroundStyle(.orange)
                }
                ForEach(Array(preview.roleAdjustments.enumerated()), id: \.offset) { _, row in
                  Text("主联系人调整：" + row.reason).font(.caption)
                }
                Toggle("已当面确认顾客、人数及目标桌，移动后让顾客重新扫码", isOn: $confirmed)
                Button("核对并执行人员调整") {
                  do {
                    proposed = try model.prepareParticipants(confirmed: confirmed)
                    error = ""
                  } catch { self.error = error.localizedDescription }
                }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
                  !model.canUseParticipants || !confirmed || !preview.blockers.isEmpty
                    || preview.supportsNativeParticipantRecovery != true)
                Button("返回修改") {
                  model.resetParticipantPreview()
                  confirmed = false
                }.buttonStyle(Primary(tone: .secondary, symbol: "pencil")).disabled(
                  model.busy || model.livePending != nil)
              }
            } else {
              Picker("移动方式", selection: $kind) {
                Text("拆到空桌").tag("participant_split")
                Text("并入营业桌").tag("participant_merge")
              }.pickerStyle(.segmented).onChange(of: kind) { _, _ in
                selected = []
                target = ""
                capacityReason = ""
                confirmed = false
              }
              Text("只移动所选顾客的位置；历史订单、付款、任务和观察留在原桌次。").font(.caption)
              if kind == "participant_merge" && !model.participants.isEmpty {
                Button("选择全员 · \(session.guestCount)人") {
                  selected = Set(model.participants.map(\.id))
                  quantity = String(session.guestCount)
                }.buttonStyle(Primary(tone: .secondary, symbol: "person.3"))
              }
              ForEach(Array(model.participants.enumerated()), id: \.element.id) { index, row in
                Toggle(
                  isOn: Binding(
                    get: { selected.contains(row.id) },
                    set: { if $0 { selected.insert(row.id) } else { selected.remove(row.id) } })
                ) {
                  VStack(alignment: .leading) {
                    Text(row.label + " \(index+1)")
                    Text(row.detail).font(.caption)
                  }
                }
              }
              TextField("实际移动人数", text: $quantity).keyboardType(.numberPad).textFieldStyle(
                .roundedBorder)
              Picker("目标桌", selection: $target) {
                Text("请选择目标桌").tag("")
                ForEach(targets) { row in
                  Text(row.code + " · " + (row.activeSession.map { "\($0.guestCount)人" } ?? "空闲"))
                    .tag(row.id)
                }
              }
              TextField("现场原因（2—1000字）", text: $reason, axis: .vertical).textFieldStyle(
                .roundedBorder)
              TextField("超容量时填写加座与通道确认说明", text: $capacityReason, axis: .vertical).textFieldStyle(
                .roundedBorder)
              Text("容量足够时无需填写加座说明；预检会提示实际容量。").font(.caption)
              Button("下一步 · 检查未结业务") {
                do {
                  guard let actor = model.identity,
                    let destination = targets.first(where: { $0.id == target })
                  else { throw CatalogError("请选择目标桌") }
                  let input = try ParticipantInput.make(
                    actor: actor, source: source, target: destination, members: model.participants,
                    selected: selected, quantity: Int(quantity) ?? 0, kind: kind, reason: reason,
                    capacityReason: capacityReason)
                  error = ""
                  confirmed = false
                  Task { await model.previewParticipants(input) }
                } catch { self.error = error.localizedDescription }
              }.buttonStyle(Primary(symbol: "arrow.right")).disabled(
                model.busy || model.livePending != nil || model.liveOrderPending != nil)
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("人员拆并桌").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") {
              selected = []
              confirmed = false
              Task { await model.loadParticipants(tableID: tableID) }
            }.disabled(model.busy)
          }
        }
    }.task { await model.loadParticipants(tableID: tableID) }.onChange(of: model.workspaceVersion) {
      _, _ in dismiss()
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].participantProof?["confirmation"] as? String ?? "请重新预检")
            Button("确认执行") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
          }
      }
    }
  }
}
