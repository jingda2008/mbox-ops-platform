import SwiftUI

struct ShowEditor: Identifiable {
  let action: String
  let row: ShowRow?
  var id: String { action + ":" + (row?.id ?? "new") }
}
struct LiveShowView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access = ""
  @State private var month = showNowMonth()
  @State private var loadedMonth = ""
  @State private var board: ShowBoard?
  @State private var section = "schedules"
  @State private var search = ""
  @State private var notice = ""
  @State private var impacts: [[String: Any]] = []
  @State private var impactsID = ""
  @State private var reading = false
  @State private var editor: ShowEditor?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var receiptKey = ""
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + showPermissions.filter(actor.allows).joined(separator: ",") }
  private var active: Bool { !access.isEmpty && access == accessKey }
  private var ready: Bool { active && !reading && !model.busy && !model.heartbeatBusy && board?.enabled == true && loadedMonth == month }
  private func load() async {
    reading = true; editor = nil; proposed = nil; impacts = []; impactsID = ""
    defer { reading = false }
    do {
      guard let actor = model.identity, active else { throw StaffAPIError.invalid }
      let requested = try showMonth(month), key = accessKey
      let result = try await model.readShow(showRoot + "?month=" + requested)
      let next = try ShowBoard(result, actor: actor, month: requested)
      guard active, accessKey == key, month == requested else { return }
      board = next; loadedMonth = requested; notice = next.enabled ? "已读取北京时间月份：" + requested : "服务未启用原请求回执，仅可查看"
    } catch { board = nil; notice = "演出资料读取失败：" + error.localizedDescription }
  }
  private func propose(_ command: () throws -> LiveCommand) {
    do { proposed = try command(); confirmed = false; notice = "" } catch { notice = error.localizedDescription }
  }
  private func clear() { board = nil; impacts = []; editor = nil; proposed = nil; notice = "" }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          LivePendingView()
          if active {
            TextField("月份 YYYY-MM", text: $month).textFieldStyle(.roundedBorder)
            Button(reading ? "正在读取…" : "读取月排班与演员") { Task { await load() } }.buttonStyle(Primary(symbol: "calendar")).disabled(reading || model.busy || model.heartbeatBusy)
            if month != loadedMonth && board != nil { Text("月份已改变，请重新读取后办理。").foregroundStyle(.orange) }
            if !notice.isEmpty { Text(notice).font(.subheadline) }
            if let receipt = model.showReceipt, receipt.employeeID == model.identity?.employee.id, receipt.kind == "performance" { Text(receipt.message).font(.subheadline) }
            if let board {
              Picker("查看内容", selection: $section) { Text("排班与现场阶段").tag("schedules"); Text("演员与曲库").tag("performers"); Text("修订与预约影响").tag("revisions") }.pickerStyle(.menu)
              TextField("筛选艺名或场次", text: $search).textFieldStyle(.roundedBorder)
              if section == "schedules" { schedules(board) }
              if section == "performers" { performers(board) }
              if section == "revisions" { revisions(board) }
            }
          } else { Text("登录或演出权限已变化，请重新进入。") }
        }.padding(16)
      }.background(paper).navigationTitle("演出与曲库").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; receiptKey = model.showReceipt?.requestKey ?? ""; await load() }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: section) { _, _ in editor = nil; proposed = nil }
      .onChange(of: month) { _, _ in editor = nil; proposed = nil }
      .onChange(of: model.busy) { _, busy in
        guard !busy, !reading, active, let receipt = model.showReceipt, receipt.kind == "performance", receipt.requestKey != receiptKey else { return }
        receiptKey = receipt.requestKey; Task { await load() }
      }
      .sheet(isPresented: Binding(get: { editor != nil || proposed != nil }, set: { if !$0 { editor = nil; proposed = nil } })) {
        ZStack {
          if let edit = editor, let board {
            NavigationStack {
              ScrollView {
                if !notice.isEmpty { Text(notice).foregroundStyle(.red).padding(16) }
                if edit.action == "songs", let row = edit.row { LiveShowCatalogView(board: board, performer: row, usable: ready, propose: propose).padding(16) }
                else { LiveShowEditorView(board: board, editor: edit, usable: ready, propose: propose).padding(16) }
              }.background(paper).navigationTitle(edit.action == "songs" ? "演员曲库" : showActions[edit.action] ?? "演出办理").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭编辑") { editor = nil } } }
            }.opacity(proposed == nil ? 1 : 0).allowsHitTesting(proposed == nil).accessibilityHidden(proposed != nil)
          }
          if let command = proposed {
            ShowConfirmationView(command: command, active: active && ready, confirmed: $confirmed, close: { proposed = nil }, execute: {
              proposed = nil; editor = nil; Task { await model.executeLive(command) }
            })
          }
        }.tint(ink)
      }
  }
  @ViewBuilder private func schedules(_ board: ShowBoard) -> some View {
    if model.identity?.allows("song.manage") == true { Button("新增单场或月度排班") { editor = ShowEditor(action: "publish", row: nil) }.buttonStyle(Primary(symbol: "calendar.badge.plus")).disabled(!ready) }
    ForEach(board.phases) { phase in
      Card {
        Text("当前阶段：" + (showPhases[phase.text("phaseCode")] ?? "待核对")).font(.headline)
        Text(phase.text("performerStageName") + " · " + showTime(phase.text("startedAt")))
        if model.identity?.allows("performance.phase.manage") == true {
          Button("结束此阶段") { editor = ShowEditor(action: "phase-end", row: phase) }.disabled(!ready)
          Button("取消误启动阶段") { editor = ShowEditor(action: "phase-cancel", row: phase) }.disabled(!ready)
        }
      }
    }
    ForEach(board.schedules.filter { search.isEmpty || $0.text("performerStageName").localizedCaseInsensitiveContains(search) || showTime($0.text("startsAt")).contains(search) }) { row in
      Card {
        Text(row.text("performerStageName")).font(.title3.bold())
        Text(showTime(row.text("startsAt")) + " — " + showTime(row.text("endsAt")))
        Text(showStatuses[row.text("status")] ?? "状态待核对")
        if model.identity?.allows("song.manage") == true && ["scheduled", "performing"].contains(row.text("status")) {
          Button(row.text("status") == "scheduled" ? "核对并开始演出" : "核对并结束演出") {
            propose {
              guard let actor = model.identity else { throw StaffAPIError.invalid }
              return try board.command(actor: actor, action: "schedule-status", body: ["scheduleId": row.id, "expected": row.text("configurationFingerprint"), "targetStatus": row.text("status") == "scheduled" ? "performing" : "completed"],
                confirmation: row.text("performerStageName") + "\n" + showTime(row.text("startsAt")) + "\n" + (row.text("status") == "scheduled" ? "确认演出已开始。" : "确认演出已结束；后续不再接受本场点歌。"))
            }
          }.disabled(!ready || (row.text("status") == "performing" && board.phases.contains { $0.text("scheduleId") == row.id }))
          if row.text("status") == "scheduled" { Button("调整展示顺序") { editor = ShowEditor(action: "schedule-sort", row: row) }.disabled(!ready) }
        }
        if model.identity?.allows("performance.phase.manage") == true, row.text("status") == "performing" {
          Button(board.phases.isEmpty ? "启动现场阶段" : "请先结束当前现场阶段") { editor = ShowEditor(action: "phase-start", row: row) }.disabled(!ready || !board.phases.isEmpty)
        }
        if model.identity?.allows("performance.schedule.revise") == true, row.text("status") == "scheduled" { Button("改期、取消或替换场次") { editor = ShowEditor(action: "revision", row: row) }.disabled(!ready) }
      }
    }
    if board.schedules.isEmpty { Text("所查月份没有演出排班。") }
  }
  @ViewBuilder private func performers(_ board: ShowBoard) -> some View {
    if model.identity?.allows("song.manage") == true { Button("新增演员") { editor = ShowEditor(action: "performer-create", row: nil) }.buttonStyle(Primary(symbol: "person.badge.plus")).disabled(!ready) }
    ForEach(board.performers.filter { search.isEmpty || $0.text("stageName").localizedCaseInsensitiveContains(search) || $0.text("code").localizedCaseInsensitiveContains(search) }) { row in
      Card {
        Text(row.text("stageName")).font(.title3.bold()); Text(row.text("code") + " · " + (row.text("status") == "active" ? "启用" : "停用"))
        if let profile = row.object["profileSnapshot"] as? [String: Any], let genres = profile["genres"] as? [String] { Text(genres.joined(separator: "、")).font(.subheadline) }
        if model.identity?.allows("song.manage") == true { Button("编辑演员资料") { editor = ShowEditor(action: "performer-update", row: row) }.disabled(!ready) }
        if model.identity?.allows("song.view") == true || model.identity?.allows("song.manage") == true { Button("查看与管理完整曲库") { editor = ShowEditor(action: "songs", row: row) }.disabled(!ready) }
      }
    }
  }
  @ViewBuilder private func revisions(_ board: ShowBoard) -> some View {
    Text("修订会保留原场次与预约影响。请分别核对顾客是否接受、通知是否实际送达；这里不会代替顾客确认。").font(.subheadline)
    ForEach(board.revisions) { row in
      Card {
        Text(((["rescheduled": "改期", "cancelled": "取消", "replaced": "换场"][row.text("kind")]) ?? "修订") + " · 第" + row.text("revisionNumber") + "次").font(.headline)
        Text(row.text("reason")); Text(showTime(row.text("createdAt"))).font(.caption)
        if model.identity?.allows("reservation.view") == true {
          Button("查看受影响预约") {
            impacts = []; impactsID = ""; let key = accessKey
            Task {
              do {
                let data = try showData(await model.readShow(showRoot + "/revisions/" + LiveCommand.pathPart(row.id) + "/impacts"))
                guard key == accessKey, active, let values = data["impacts"] as? [[String: Any]] else { return }; impacts = values; impactsID = row.id
              } catch { notice = error.localizedDescription }
            }
          }.disabled(!ready)
        }
      }
    }
    if !impactsID.isEmpty {
      Card {
        Text("所选修订受影响预约").font(.headline)
        if impacts.isEmpty { Text("没有关联预约。") }
        ForEach(Array(impacts.enumerated()), id: \.offset) { _, impact in
          Text(showText(impact, "reservationPublicId") + " · " + showTime(showText(impact, "arrivalAt")))
          Text("预约状态：" + (LiveReservation.labels[showText(impact, "reservationStatus")] ?? "待核对"))
          if let acknowledgement = impact["acknowledgement"] as? [String: Any] { Text(["keep": "顾客保留选择", "reselect": "顾客已重新选场", "clear": "顾客取消演出偏好"][showText(acknowledgement, "decision")] ?? "确认状态待核对") }
          else { Text("等待顾客确认").foregroundStyle(.orange) }
        }
      }
    }
  }
}
struct ShowConfirmationView: View {
  @EnvironmentObject var model: AppModel
  let command: LiveCommand, active: Bool
  @Binding var confirmed: Bool
  let close: () -> Void, execute: () -> Void
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if active && model.identity?.employee.id == command.employeeID {
            Text(command.steps.first?.showProof?["confirmation"] as? String ?? "原内容不可用，请重新读取")
            Toggle("已核对本次原对象、状态及办理内容", isOn: $confirmed)
            Button("确认办理", action: execute).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canExecuteLive(command))
          } else { Text("原账号或权限已变化，内容已隐藏。") }
        }.padding(20)
      }.background(paper).navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对", action: close) } }
    }.tint(ink)
  }
}
