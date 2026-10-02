import SwiftUI

struct LiveObservationView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let session: String
  let tableCode: String
  @State var recommendation = false
  @State var raw = ""
  @State var immediate = false
  @State var candidate = ""
  @State var expression = ""
  @State var type = ""
  @State var degree = ""
  @State var excerpt = ""
  @State var source = ""
  @State var target = ""
  @State var reason = ""
  @State var correctionReason = ""
  @State var correctionPublicId = ""
  @State var correction: ObservationEvent?
  @State var proposed: LiveCommand?
  @State var physical = false
  @State var error = ""
  func propose(_ work: () throws -> LiveCommand) {
    do {
      proposed = try work()
      physical = false
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  func select(
    _ title: String, _ value: Binding<String>, _ values: [String: String], empty: String = "请选择"
  ) -> some View {
    Picker(title, selection: value) {
      Text(empty).tag("")
      ForEach(values.keys.sorted(), id: \.self) { Text(values[$0]!).tag($0) }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.observationState).font(.caption)
          Button("刷新本桌记录") { Task { await model.loadObservation(session) } }
            .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
          if model.identity?.allows("observation.record") == true
            && model.identity?.allows("recommendation.staff.modify") == true
          {
            Picker("现场服务", selection: $recommendation) {
              Text("桌台观察").tag(false)
              Text("推荐调整").tag(true)
            }.pickerStyle(.segmented)
          }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if recommendation { recommendationContent } else { observationContent }
        }.padding(16)
      }.background(paper).navigationTitle(tableCode + " · 现场服务").navigationBarTitleDisplayMode(
        .inline
      )
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    }
    .task {
      recommendation = model.identity?.allows("observation.record") != true
      await model.loadObservation(session)
    }
    .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
    .onChange(of: model.observationBoard?.draft?.publicId) { _, _ in
      candidate = ""
      expression = ""
      type = ""
      degree = ""
      excerpt = String((model.observationBoard?.draft?.rawContent ?? "").prefix(1000))
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(tableCode + " · 本次开台")
            Text(command.steps[0].observationProof?["confirmation"] as? String ?? "请核对原记录")
            Toggle("已核对本桌、原文与现场事实", isOn: $physical)
            Button("确认执行") {
              proposed = nil
              correction = nil
              Task { await model.executeLive(command) }
            }
            .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !physical || !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
        }
      }
    }
  }
  @ViewBuilder var observationContent: some View {
    if let board = model.observationBoard, board.tableSessionId == session {
      if let draft = board.draft, correction == nil {
        Card {
          Text("待确认观察").font(.headline)
          Text(draft.rawContent)
          if let prompt = draft.clarificationPrompt {
            Text(prompt).font(.caption).foregroundStyle(.secondary)
          }
          if draft.needsImmediateAction { Text("确认后生成现场服务任务").font(.caption).foregroundStyle(gold) }
          Picker("关联本桌真实订单商品", selection: $candidate) {
            Text("不关联具体商品").tag("")
            ForEach(draft.candidates) { Text($0.productName + " · " + $0.rawMention).tag($0.id) }
          }
          eventSelectors
          TextField("原文片段（最多1000字）", text: $excerpt, axis: .vertical).textFieldStyle(.roundedBorder)
          Button("核对并确认观察") {
            propose {
              try board.confirm(
                candidate: candidate, expression: expression, type: type, degree: degree,
                excerpt: excerpt, actor: model.identity!)
            }
          }
          .buttonStyle(Primary(symbol: "checkmark.circle")).disabled(
            !model.canUseObservation || model.identity?.allows("observation.confirm") != true)
        }
      }
      if board.draft == nil {
        Foldout(title: "记录新观察") {
          TextField("记录现场事实、客人原话或员工判断", text: $raw, axis: .vertical).textFieldStyle(.roundedBorder)
          Toggle("需要立即跟进", isOn: $immediate)
          Text("仅按本桌真实订单识别商品，识别后仍需员工确认。").font(.caption)
          Button("识别并核对") {
            propose { try board.parse(raw: raw, immediate: immediate, actor: model.identity!) }
          }
          .buttonStyle(Primary(symbol: "text.magnifyingglass")).disabled(!model.canUseObservation)
        }
      }
      if let old = correction {
        Card {
          Text("修订观察 · 第\(old.revision)版").font(.headline)
          Text(old.rawExcerpt ?? "")
          eventSelectors
          TextField("修订原因（2—500字）", text: $correctionReason, axis: .vertical).textFieldStyle(
            .roundedBorder)
          Button("核对修订") {
            propose {
              try board.revise(
                publicId: correctionPublicId, eventID: old.id, expression: expression, type: type,
                degree: degree, reason: correctionReason, actor: model.identity!)
            }
          }
          .buttonStyle(Primary(symbol: "pencil.circle")).disabled(!model.canUseObservation)
          Button("取消修订") {
            correction = nil
            expression = ""
            type = ""
            degree = ""
          }
        }
      }
      Text("最近5条已确认观察").font(.headline)
      if board.history.items.isEmpty { Text("本次开台暂无已确认观察").foregroundStyle(.secondary) }
      ForEach(board.history.items) { row in
        Card {
          Text(reservationTime(row.confirmedAt) + " · " + row.confirmedBy).font(.caption)
          Text(row.rawContent ?? "原文受岗位权限保护")
          ForEach(row.events) { e in
            Text(
              (observationExpressions[e.expressionKind] ?? "待核对") + " · "
                + (observationTypes[e.eventType] ?? "待核对"))
            Text((e.productName ?? "桌台情况") + " · 第\(e.revision)版").font(.caption)
            if let degree = e.degree { Text(observationDegrees[degree] ?? "待核对").font(.caption) }
            if board.history.permissions.canCorrect && board.history.permissions.canViewRaw {
              Button("修订此条") {
                correctionPublicId = row.publicId
                correction = e
                expression = e.expressionKind
                type = e.eventType
                degree = e.degree ?? ""
                correctionReason = ""
              }.disabled(!model.canUseObservation)
            }
          }
          if row.serviceTaskId != nil {
            Text(
              "现场任务："
                + ([
                  "requested": "待接单", "acknowledged": "已接单", "in_progress": "处理中",
                  "completed": "已完成", "cancelled": "已取消",
                ][row.serviceTaskStatus ?? ""] ?? "待核对") + " · 在服务任务中心处理"
            ).font(.caption)
          }
          ForEach(row.revisions) { revision in
            Text("修订：" + revision.reason + " · " + revision.correctedBy).font(.caption)
          }
        }
      }
    }
  }
  var eventSelectors: some View {
    Group {
      select("表达性质", $expression, observationExpressions)
      select("观察类型", $type, observationTypes)
      select("程度", $degree, observationDegrees, empty: "不适用 / 未记录")
    }
  }
  @ViewBuilder var recommendationContent: some View {
    if let board = model.recommendationBoard, board.tableSessionId == session {
      if let snapshot = board.snapshot {
        Card {
          Text("本桌推荐 · " + reservationTime(snapshot.createdAt)).font(.headline)
          Text("仅记录推荐调整，不修改订单、价格或收款。").font(.caption)
          let options = Dictionary(
            uniqueKeysWithValues: snapshot.options.map {
              (
                $0.productId,
                $0.productName + " · ¥" + String(format: "%.2f", Double($0.amountMinor) / 100)
              )
            })
          select("原推荐", $source, options)
          select("调整为", $target, options)
          select("调整原因", $reason, recommendationReasons)
          Button("核对推荐调整") {
            propose {
              try board.command(
                source: source, target: target, reason: reason, actor: model.identity!)
            }
          }
          .buttonStyle(Primary(symbol: "arrow.triangle.swap")).disabled(!model.canUseObservation)
        }
      } else {
        Text("本桌暂无可调整的推荐快照").foregroundStyle(.secondary)
      }
    }
  }
}
