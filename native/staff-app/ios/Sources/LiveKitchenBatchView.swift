import SwiftUI

struct LiveKitchenBatchView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let sourceID: String
  @State var selected: [String: Int] = [:]
  @State var equipment = ""
  @State var seconds = ""
  @State var error = ""
  @State var proposed: LiveCommand?
  var rows: [LiveKitchen.Pending] {
    guard let board = model.kitchenBoard,
      let first = board.pending.first(where: { $0.id == sourceID })
    else { return [] }
    return board.pending.filter {
      $0.compatibility == first.compatibility && $0.canPrepare && $0.unmade > 0
    }
  }
  func propose(_ action: String) {
    do {
      guard !selected.isEmpty else { throw CatalogError("请至少选择一项原订单商品") }
      proposed = try model.prepareKitchen(
        action: action, sourceID: sourceID, equipment: equipment,
        seconds: seconds.isEmpty ? nil : Int(seconds), selections: selected)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(rows.first?.productName ?? "商品已变化，请返回刷新").font(.headline)
          Text("只列出商品、规格、商品备注及整单备注完全相同的品项。逐桌核对份数后合批，仍分别保留原订单和桌次。").font(.caption)
          ForEach(rows) { row in
            Card {
              Toggle(
                row.tableCode + " · " + row.orderPublicId,
                isOn: Binding(
                  get: { selected[row.id] != nil },
                  set: {
                    if $0 { selected[row.id] = 1 } else { selected.removeValue(forKey: row.id) }
                  }))
              if selected[row.id] != nil {
                Stepper(
                  "本次 \(selected[row.id] ?? 1) / 待制作 \(row.unmade)份",
                  value: Binding(get: { selected[row.id] ?? 1 }, set: { selected[row.id] = $0 }),
                  in: 1...max(1, min(999, row.unmade)))
              }
              if !row.specification.isEmpty { Text(row.specification).font(.caption) }
              if !row.itemNote.isEmpty { Text("商品备注：" + row.itemNote).font(.caption) }
              if !row.orderNote.isEmpty { Text("整单备注：" + row.orderNote).font(.caption) }
            }
          }
          Picker("设备", selection: $equipment) {
            Text("无需设备").tag("")
            ForEach(model.kitchenBoard?.equipmentLabels ?? [], id: \.self) { Text($0).tag($0) }
          }
          TextField("预计秒数（可不填，1—36000）", text: $seconds).keyboardType(.numberPad).textFieldStyle(
            .roundedBorder)
          Text("已选 \(selected.count) 个品项 · \(selected.values.reduce(0,+))份").font(.headline)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          Button("核对并开始同品合批") { propose("start") }.buttonStyle(Primary(symbol: "flame.fill"))
            .disabled(
              !model.canAct("kds.prepare") || selected.isEmpty
                || !seconds.isEmpty && !(1...36000).contains(Int(seconds) ?? 0))
          Button("所选商品无需制作 · 已实际备齐") { propose("quick-ready") }.buttonStyle(
            Primary(tone: .secondary, symbol: "checkmark.circle")
          ).disabled(!model.canAct("kds.prepare") || selected.isEmpty)
        }.padding(16)
      }.background(paper).navigationTitle("同品跨桌合批").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
      }
    }
    .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
    .confirmationDialog(
      proposed?.title ?? "核对合批",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button("已核对各桌实物份数，确认") {
          proposed = nil
          Task {
            await model.executeLive(command)
            if model.livePending == nil { dismiss() }
          }
        }.disabled(!model.canExecuteLive(command))
      }
    }
  }
}
struct KitchenTimerView: View {
  let batch: LiveKitchen.Batch
  let generatedAt: String
  @State var receivedUptime = ProcessInfo.processInfo.systemUptime
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      if let started = batch.startedAt.flatMap(assignmentDate),
        let server = assignmentDate(generatedAt),
        batch.units.contains(where: { $0.state == "started" && !$0.stopped })
      {
        let elapsed = max(
          0,
          Int(
            server.timeIntervalSince(started) + ProcessInfo.processInfo.systemUptime
              - receivedUptime))
        Text(
          "已制作 \(elapsed/60):\(String(format:"%02d",elapsed%60))"
            + (batch.expectedSeconds.map { limit in
              let delta = abs(limit - elapsed)
              return " · " + (elapsed < limit ? "预计剩余 " : "已超预计 ")
                + "\(delta/60):\(String(format:"%02d",delta%60))"
            } ?? "") + "（参考）"
        ).font(.caption.monospacedDigit()).foregroundStyle(ink)
      }
    }.onChange(of: generatedAt) { _, _ in receivedUptime = ProcessInfo.processInfo.systemUptime }
  }
}
