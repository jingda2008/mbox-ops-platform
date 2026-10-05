import SwiftUI

struct LivePendingView: View {
  @EnvironmentObject var model: AppModel
  @State private var supervisorCommand: LiveCommand?
  var body: some View {
    if model.liveStorageDamaged {
      Text("未决操作记录异常，真实操作已锁定，请联系管理员").font(.caption).foregroundStyle(.red)
    }
    if let order = model.liveOrderPending {
      VStack(alignment: .leading, spacing: 8) {
        Text(order.tableCode + (order.rejectedCode == nil ? " · 订单结果待确认" : " · 下单被拒绝")).font(
          .headline)
        Text(order.publicId).font(.caption).textSelection(.enabled)
        if let replacement = order.replacement { Text(replacement.explanation).font(.caption) }
        Text(order.rejectedCode == nil ? "原请求已保存。核对前不能重新下单、换员工或操作其他真实业务。" : "服务器明确拒绝本次下单，原清单已保留。")
          .font(.caption)
        Button(order.rejectedCode == nil ? "核对原订单" : "返回修改清单") {
          if order.rejectedCode != nil {
            model.dismissRejectedOrder()
          } else {
            Task { await model.recoverLiveOrder() }
          }
        }
        .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise"))
        .disabled(model.busy || model.identity?.employee.id != order.employeeID)
      }.padding(10).background(gold.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
    if let command = model.livePending {
      VStack(alignment: .leading, spacing: 8) {
        Text(command.title + (command.rejected ? " · 未完成" : " · 结果待确认")).font(.subheadline)
        Text("原请求已保留，请由原员工核对。").font(.caption).foregroundStyle(.secondary)
        if command.rejected {
          Button("已知晓，清除失败请求") { model.dismissRejectedLive() }.buttonStyle(
            Primary(tone: .secondary, symbol: "xmark.circle")
          )
          .disabled(model.busy || command.employeeID != model.identity?.employee.id)
        } else {
          Button("核对原操作结果") { Task { await model.recoverLive() } }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          )
          .disabled(model.busy || command.employeeID != model.identity?.employee.id)
        }
        if (try? serviceRecoveryStep(command)) != nil {
          Button("原员工无法核对 · 主管处理") { supervisorCommand = command }
            .buttonStyle(Primary(tone: .secondary, symbol: "person.badge.shield.checkmark"))
            .disabled(model.busy || model.heartbeatBusy || model.liveStorageDamaged || model.liveOrderPending != nil)
        }
      }.padding(10).background(gold.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .sheet(item: $supervisorCommand) { original in LiveServiceRecoveryView(command: original) }
    }
  }
}
struct LiveTableActions: View {
  @EnvironmentObject var model: AppModel
  let tableID: String
  @State private var people = 1
  @State private var target = ""
  @State private var reason = ""
  @State private var turnoverReason = ""
  @State private var capacityReason = ""
  @State private var proposed: LiveCommand?
  @State private var showAssignments = false
  @State private var showParticipants = false
  @State private var observationSession: String?
  @State private var showOrders = false
  @State private var menuDestination: MenuDestination?
  @State private var showCollection = false
  private var table: LiveOperations.Table? {
    model.liveOperations?.tables.first { $0.id == tableID }
  }
  func propose(_ kind: String, taskID: String? = nil, frozen: Bool = false) {
    do {
      proposed = try model.prepareLive(
        kind: kind, tableID: tableID, people: people, targetID: target, taskID: taskID,
        frozen: frozen,
        reason: kind == "turnover"
          ? turnoverReason : ["open", "transfer"].contains(kind) ? capacityReason : reason)
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    VStack(spacing: 12) {
      if let table {
        if let session = table.activeSession, session.status == "open",
          model.identity?.allows("order.create") == true
        {
          Button("点菜 / 加菜 · 已选 \(model.liveDraft(session.id).count) 份") {
            menuDestination = MenuDestination(session: session.id, tableCode: table.code)
          }.buttonStyle(Primary(symbol: "fork.knife")).disabled(model.busy)
        }
        Button("人员与责任桌") { showAssignments = true }.buttonStyle(
          Primary(tone: .secondary, symbol: "person.2")
        ).disabled(model.busy)

        if table.activeSession?.status == "open"
          && model.identity?.allows(ParticipantInput.permission) == true
        {
          Button("人员拆桌 / 并桌") { showParticipants = true }.buttonStyle(
            Primary(tone: .secondary, symbol: "person.2.wave.2")
          ).disabled(model.busy)
        }
        if table.status == "paused" { Text("此桌台已停用，不能开台").foregroundStyle(.secondary) }
        if table.activeSession == nil {
          if model.identity?.allows("table.open") == true {
            Stepper("用餐人数：\(people)", value: $people, in: 1...200)
            Text("常规容量 \(table.capacity)人").font(.caption)
            if people > table.capacity {
              TextField("现场加座说明（2—1000字）", text: $capacityReason, axis: .vertical).textFieldStyle(
                .roundedBorder)
            }
            Button("确认开台") { propose("open") }.buttonStyle(Primary(symbol: "person.2.fill"))
              .disabled(!model.canAct("table.open") || table.status != "available")
          }
        } else if let session = table.activeSession {
          if ["open", "closing"].contains(session.status)
            && (model.identity?.allows("observation.record") == true
              || model.identity?.allows("recommendation.staff.modify") == true)
          {
            Button("桌台观察 · 推荐调整") { observationSession = session.id }.buttonStyle(
              Primary(tone: .secondary, symbol: "text.bubble")
            ).disabled(model.busy)
          }
          if let identity = model.identity,
            LivePaymentOrder.permissions.contains(where: identity.allows)
          {
            Button("查看应收 · 登记收款") { showCollection = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "creditcard")
            ).disabled(model.busy)
          }
          Button("查看本桌订单") {
            showOrders = true
            Task { await model.loadLiveOrders(session: session.id) }
          }
          .buttonStyle(Primary(tone: .secondary, symbol: "list.bullet.rectangle")).disabled(
            model.busy)
          let tasks = model.liveOperations?.tasks.filter { $0.tableSessionId == session.id } ?? []
          ForEach(tasks) { task in
            Card {
              Text(task.title).font(.headline)
              if let detail = task.detail { Text(detail).font(.subheadline) }
              if task.interactionMode == "quick_complete",
                model.identity?.allows("service.execute") == true
              {
                Button("完成服务") { propose("service", taskID: task.id) }.buttonStyle(
                  Primary(tone: .secondary, symbol: "checkmark.circle")
                ).disabled(!model.canAct("service.execute"))
              } else {
                Text("请由主管处理此任务").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          if model.identity?.allows("table.transfer") == true {
            Card {
              Picker("转台目标", selection: $target) {
                Text("选择空闲桌").tag("")
                ForEach(
                  (model.liveOperations?.tables ?? []).filter {
                    $0.id != tableID && $0.status == "available" && $0.activeSession == nil

                  }
                ) { option in Text(option.code + " · \(option.capacity)人桌").tag(option.id) }
              }
              if let destination = model.liveOperations?.tables.first(where: { $0.id == target }),
                session.guestCount > destination.capacity
              {
                TextField("现场加座说明（2—1000字）", text: $capacityReason, axis: .vertical).textFieldStyle(
                  .roundedBorder)
              }
              Button("转台") { propose("transfer") }.buttonStyle(
                Primary(tone: .secondary, symbol: "arrow.left.arrow.right")
              ).disabled(target.isEmpty || !model.canAct("table.transfer"))
            }
          }
          if model.identity?.allows("guest.cart.freeze") == true {
            Card {
              if !session.guestCartWritesFrozen {
                TextField("暂停客人加购的原因", text: $reason).textFieldStyle(.roundedBorder)
              }
              Button(session.guestCartWritesFrozen ? "恢复客人加购" : "暂停客人加购") {
                propose("freeze", frozen: !session.guestCartWritesFrozen)
              }
              .buttonStyle(
                Primary(
                  tone: .secondary,
                  symbol: session.guestCartWritesFrozen ? "play.circle" : "pause.circle")
              )
              .disabled(
                !model.canAct("guest.cart.freeze")
                  || (!session.guestCartWritesFrozen
                    && !(2...500).contains(
                      reason.trimmingCharacters(in: .whitespacesAndNewlines).count))
              )
            }
          }
          if model.identity?.allows("table.turnover_unsettled") == true
            && model.identity?.allows("table.close") == true
          {
            Foldout(title: "顾客已离店 · 特殊翻台") {
              Text("仅在顾客确已离店时使用。原订单、欠款及退款继续保留，不代表结清或免单。").font(.caption)
              TextField("填写实际离店与翻台原因", text: $turnoverReason).textFieldStyle(.roundedBorder)
              Button("确认已离店，保留原账翻台") { propose("turnover") }.buttonStyle(
                Primary(tone: .danger, symbol: "rectangle.portrait.and.arrow.right")
              ).disabled(
                !model.canAct("table.turnover_unsettled")
                  || turnoverReason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count < 2)
            }
          }
          if model.identity?.allows("table.close") == true {
            Button(session.status == "closing" ? "继续结束用餐" : "结束用餐 · 释放桌台") { propose("close") }
              .buttonStyle(Primary(tone: .danger, symbol: "rectangle.portrait.and.arrow.right"))
              .disabled(!model.canAct("table.close"))
            Text("门店系统将核对未收款、退款与未完成服务，未满足条件不会释放桌台。").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
    }
    .confirmationDialog(
      proposed?.title ?? "确认操作",
      isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }),
      titleVisibility: .visible
    ) {
      if let command = proposed {
        Button(
          "确认操作",
          role: ["table.close", "table.turnover_unsettled"].contains(command.permission)
            ? .destructive : nil
        ) {
          proposed = nil
          Task { await model.executeLive(command) }
        }
      }
    } message: {
      Text(
        (proposed?.steps.first?.object["capacityOverrideReason"] as? String).map {
          "加座说明：" + $0 + "\n请确认现场安排和原桌号。"
        } ?? "将更新门店真实数据，请核对桌号和操作内容。")
    }
    .sheet(
      isPresented: Binding(
        get: { observationSession != nil }, set: { if !$0 { observationSession = nil } })
    ) {
      if let session = observationSession {
        LiveObservationView(session: session, tableCode: table?.code ?? "本桌")
      }
    }
    .sheet(isPresented: $showParticipants) { LiveParticipantsView(tableID: tableID) }
    .sheet(isPresented: $showAssignments) { LiveAssignmentsView(initialTableID: tableID) }
    .sheet(isPresented: $showCollection) {
      if let table, let session = table.activeSession {
        LiveCollectionView(session: session.id, tableCode: table.code)
      }
    }
    .fullScreenCover(item: $menuDestination) { destination in
      LiveCatalogView(session: destination.session, tableCode: destination.tableCode)
    }
    .onChange(of: table?.activeSession?.id) { _, current in
      if let destination = menuDestination, destination.session != current { menuDestination = nil }
    }
    .sheet(isPresented: $showOrders) {
      NavigationStack {
        List {
          if !model.orderDetailState.isEmpty { Text(model.orderDetailState) }
          ForEach(model.liveOrders) { order in
            Section("\(order.publicId) · \(money(order.totalAmountMinor))") {
              ForEach(order.items) { item in
                VStack(alignment: .leading, spacing: 5) {
                  Text("\(item.productName) ×\(item.quantity)")
                  Text(item.stateLabel + " · " + money(item.totalAmountMinor)).font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
            }
          }
        }.navigationTitle("本桌订单").navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("关闭") { showOrders = false } }
            ToolbarItem(placement: .primaryAction) {
              Button("刷新") {
                if let id = table?.activeSession?.id {
                  Task { await model.loadLiveOrders(session: id) }
                }
              }.disabled(model.busy)
            }
          }
      }.tint(ink)
    }
  }
}
