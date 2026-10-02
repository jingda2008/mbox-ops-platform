import SwiftUI

struct LiveStockAuditView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var page = "count"
  @State private var filter = "submitted"
  @State private var query = ""
  @State private var selected: StockBoard.Item?
  @State private var observedAt = ""
  @State private var quantity = ""
  @State private var reason = ""
  @State private var wasteType = "other"
  @State private var reviewReasons: [String: String] = [:]
  @State private var error = ""
  @State private var proposed: LiveCommand?
  private func propose(
    _ kind: String, count: StockCountPage.Count? = nil, waste: StockWastePage.Entry? = nil
  ) {
    do {
      guard let actor = model.identity, let board = model.stockBoard else {
        throw CatalogError("请刷新库存")
      }
      proposed = try stockAuditCommand(
        actor: actor, board: board, kind: kind, lines: model.stockCountDraft, itemID: selected?.id,
        quantity: quantity,
        reason: (count?.id ?? waste?.id).map { reviewReasons[$0] ?? "" } ?? reason,
        wasteType: wasteType, count: count, waste: waste)
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.stockAuditState).font(.caption)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let r = model.stockReceipt,
            let root = try? JSONSerialization.jsonObject(with: r.bytes) as? [String: Any],
            let data = root["data"] as? [String: Any], let status = data["status"] as? String
          {
            Text(
              "最近库存回执："
                + ([
                  "submitted": "盘点已提交待审", "approved": "已批准", "rejected": "已驳回", "pending": "报损待审核",
                  "recorded": "报损已记账", "draft": "采购待验收", "received": "采购已入库",
                ][status] ?? "请核对原单")
            ).font(.caption)
          }
          Picker("工作区", selection: $page) {
            Text("盘点").tag("count")
            Text("报损").tag("waste")
          }.pickerStyle(.segmented)
          if let board = model.stockBoard {
            if model.identity?.allows(page == "count" ? "inventory.count" : "inventory.waste")
              == true
            {
              Card {
                Text(page == "count" ? "录入实物盘点" : "登记报损").font(.headline)
                if let selected {
                  Text(selected.name + " · 当前账面 " + selected.onHandQuantity + selected.baseUnit)
                  TextField(page == "count" ? "实点数量，可为0" : "报损数量", text: $quantity).keyboardType(
                    .decimalPad
                  ).textFieldStyle(.roundedBorder)
                  TextField(page == "count" ? "盘点说明或差异原因" : "报损原因", text: $reason).textFieldStyle(
                    .roundedBorder)
                  if page == "waste" {
                    Picker("报损类型", selection: $wasteType) {
                      Text("调酒失败").tag("mixing_failure")
                      Text("报废").tag("discarded")
                      Text("过期").tag("expired")
                      Text("试饮").tag("tasting")
                      Text("赠送").tag("complimentary")
                      Text("其他").tag("other")
                    }
                  }
                  Button(page == "count" ? "加入本员工盘点草稿" : "核对报损") {
                    if page == "waste" {
                      propose("waste")
                      return
                    }
                    do {
                      let q = try stockQuantity(quantity, item: selected, zero: true)
                      guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        reason.count <= 500, !observedAt.isEmpty,
                        !model.stockCountDraft.contains(where: { $0.id == selected.id })
                      else { throw CatalogError("请填写原因；已有物料请先移除再重新清点") }
                      let line = StockCountInput(
                        inventoryItemId: selected.id, name: selected.name,
                        baseUnit: selected.baseUnit, countedQuantity: q, reason: reason,
                        expectedOnHandQuantity: selected.onHandQuantity, observedAt: observedAt)
                      try model.saveCountDraft(model.stockCountDraft + [line])
                      self.selected = nil
                      quantity = ""
                      reason = ""
                    } catch { self.error = error.localizedDescription }
                  }.buttonStyle(Primary(symbol: "checkmark")).disabled(!model.canUseStockAudit)
                  Button("重新选择物料") { self.selected = nil }
                } else {
                  TextField("搜索物料名称或编码", text: $query).textFieldStyle(.roundedBorder)
                  Text("选择物料后录入实际数量；刷新不会替换已保存草稿的原库存基准。").font(.caption)
                }
              }
              if selected == nil && !query.isEmpty {
                ForEach(
                  board.items.filter {
                    ($0.name + " " + $0.sku).localizedCaseInsensitiveContains(query)
                  }
                ) { item in
                  Button(item.name + " · " + item.sku) {
                    selected = item
                    observedAt = board.inventoryObservedAt ?? ""
                    quantity = ""
                    reason = ""
                  }.disabled(!model.canUseStockAudit)
                }
              }
            }
            if page == "count" {
              if !model.stockCountDraft.isEmpty {
                Card {
                  Text("本员工盘点草稿 · \(model.stockCountDraft.count)项").font(.headline)
                  ForEach(model.stockCountDraft) { line in
                    HStack {
                      Text(line.name + " 实点 " + line.countedQuantity + line.baseUnit)
                      Spacer()
                      Button("移除") {
                        do {
                          try model.saveCountDraft(
                            model.stockCountDraft.filter { $0.id != line.id })
                        } catch { self.error = error.localizedDescription }
                      }.disabled(!model.canUseStock)
                    }
                  }
                  Button("核对并提交盘点") { propose("count") }.buttonStyle(Primary(symbol: "checklist"))
                    .disabled(!model.canUseStockAudit)
                }
              }
              Picker("盘点状态", selection: $filter) {
                Text("待审").tag("submitted")
                Text("已处理").tag("processed")
              }.pickerStyle(.segmented).onChange(of: filter) {
                Task { await model.loadStockAudit(filter: filter) }
              }
              if let counts = model.stockCounts {
                if counts.counts.isEmpty { Text("本页没有盘点单") }
                ForEach(counts.counts) { count in
                  Card {
                    Text(count.publicId).font(.headline)
                    Text(
                      count.createdByName + " · "
                        + (["submitted": "待审", "approved": "已批准", "rejected": "已驳回"][count.status]
                          ?? count.status))
                    ForEach(Array(count.lines.enumerated()), id: \.offset) { _, l in
                      Text(
                        l.itemName + " · 账面 " + l.systemQuantity + " / 实点 " + l.countedQuantity
                          + " / 差异 " + l.varianceQuantity
                      ).font(.caption)
                      if l.stale { Text("库存已有变动，请驳回后重新清点").foregroundStyle(.red) }
                    }
                    if count.canReview {
                      TextField(
                        "驳回原因",
                        text: Binding(
                          get: { reviewReasons[count.id] ?? "" },
                          set: { reviewReasons[count.id] = $0 })
                      ).textFieldStyle(.roundedBorder)
                      HStack {
                        Button("批准差异") { propose("countApprove", count: count) }.disabled(
                          !model.canUseStockAudit || count.lines.contains { $0.stale })
                        Button("驳回") { propose("countReject", count: count) }.disabled(
                          !model.canUseStockAudit)
                      }
                    }
                  }
                }
                HStack {
                  Button("上一页") {
                    Task { await model.loadStockAudit(filter: filter, page: counts.page - 1) }
                  }.disabled(counts.page == 0 || model.busy)
                  Spacer()
                  Button("下一页") {
                    Task { await model.loadStockAudit(filter: filter, page: counts.page + 1) }
                  }.disabled(!counts.hasMore || model.busy)
                }
              }
            } else if let waste = model.stockWaste {
              if waste.items.isEmpty { Text("本页没有需审核的报损申请；直接记账以原回执为准") }
              ForEach(waste.items) { row in
                Card {
                  Text(row.itemName + " ×" + row.quantity + row.baseUnit).font(.headline)
                  Text(
                    row.requestedByName + " · "
                      + (["pending": "待审", "approved": "已批准", "rejected": "已驳回"][row.status]
                        ?? row.status))
                  Text(row.reason)
                  if row.canReview {
                    TextField(
                      "审核原因",
                      text: Binding(
                        get: { reviewReasons[row.id] ?? "" }, set: { reviewReasons[row.id] = $0 })
                    ).textFieldStyle(.roundedBorder)
                    HStack {
                      Button("批准报损") { propose("wasteApprove", waste: row) }
                      Button("驳回") { propose("wasteReject", waste: row) }
                    }.disabled(!model.canUseStockAudit)
                  }
                }
              }
              HStack {
                Button("上一页") { Task { await model.loadStockAudit(wastePage: waste.page - 1) } }
                  .disabled(waste.page <= 1 || model.busy)
                Spacer()
                Button("下一页") { Task { await model.loadStockAudit(wastePage: waste.page + 1) } }
                  .disabled(!waste.hasMore || model.busy)
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("盘点与报损").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button("刷新") {
            selected = nil
            quantity = ""
            Task {
              await model.loadStockAudit(
                filter: filter, page: model.stockCounts?.page ?? 0,
                wastePage: model.stockWaste?.page ?? 1)
            }
          }.disabled(model.busy)
        }
      }
    }
    .task { await model.loadStockAudit() }.onChange(of: model.workspaceVersion) { dismiss() }
      .onChange(of: model.priorityAccessKey) { dismiss() }
    .onChange(of: page) {
      selected = nil
      quantity = ""
      reason = ""
    }
    .alert(
      "确认库存操作", isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      presenting: proposed
    ) { command in
      Button("确认执行") {
        Task { await model.executeLive(command) }
        selected = nil
        quantity = ""
        reason = ""
      }.disabled(!model.canExecuteLive(command))
      Button("返回核对", role: .cancel) { proposed = nil }
    } message: { command in
      Text(command.steps[0].stockAuditProof?["confirmation"] as? String ?? "请核对原单")
    }
  }
}
