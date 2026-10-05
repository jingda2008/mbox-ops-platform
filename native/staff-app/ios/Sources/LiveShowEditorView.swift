import SwiftUI

struct LiveShowEditorView: View {
  @EnvironmentObject var model: AppModel
  let board: ShowBoard, editor: ShowEditor, usable: Bool
  let propose: (() throws -> LiveCommand) -> Void
  @State private var reason = ""
  @State private var start: String
  @State private var end: String
  @State private var kind = "rescheduled"
  @State private var replacementMonth: String
  @State private var replacementBoard: ShowBoard?
  @State private var replacement = ""
  @State private var phase = "band_live"
  @State private var sort: String
  @State private var name: String
  @State private var code = ""
  @State private var status: String
  @State private var genres: String
  @State private var performer = ""
  @State private var slots: [[String: Any]] = []
  @State private var preview: ShowPublishPreview?
  @State private var notice = ""
  @State private var reading = false
  init(board: ShowBoard, editor: ShowEditor, usable: Bool, propose: @escaping (() throws -> LiveCommand) -> Void) {
    self.board = board; self.editor = editor; self.usable = usable; self.propose = propose
    _start = State(initialValue: editor.row.map { showTime($0.text("startsAt")) } ?? board.month + "-01 20:00")
    _end = State(initialValue: editor.row.map { showTime($0.text("endsAt")) } ?? board.month + "-01 22:00")
    _replacementMonth = State(initialValue: board.month); _replacementBoard = State(initialValue: board)
    _sort = State(initialValue: editor.row?.text("sortOrder") ?? "0")
    _name = State(initialValue: editor.row?.text("stageName") ?? "")
    _status = State(initialValue: editor.row?.text("status") ?? "active")
    let profile = editor.row?.object["profileSnapshot"] as? [String: Any]
    _genres = State(initialValue: (profile?["genres"] as? [String] ?? []).joined(separator: "，"))
  }
  private var publishBody: [String: Any] { ["month": board.month, "slots": slots] }
  private var ready: Bool { usable && !reading }
  private func command() throws -> LiveCommand {
    guard let actor = model.identity else { throw StaffAPIError.invalid }
    let action = editor.action, row = editor.row
    var body: [String: Any] = [:], confirmation = ""
    switch action {
    case "publish":
      body = publishBody
      confirmation = "发布 " + board.month + " 演出清单\n" + slots.map { slot in
        let name = board.performers.first { $0.id == slot["performerId"] as? String }?.text("stageName") ?? "待核对"
        return name + " · " + showTime(showText(slot, "startsAt")) + " — " + showTime(showText(slot, "endsAt"))
      }.joined(separator: "\n") + "\n已有相同场次保留原记录；此操作不会取消其他排班。"
    case "revision":
      guard let row else { throw StaffAPIError.invalid }
      let selected = (replacementBoard ?? board).schedules.first { $0.id == replacement }
      body = ["scheduleId": row.id, "expected": row.text("configurationFingerprint"), "kind": kind,
        "startsAt": kind == "rescheduled" ? try showInputTime(start) : NSNull(), "endsAt": kind == "rescheduled" ? try showInputTime(end) : NSNull(),
        "replacementScheduleId": kind == "replaced" ? replacement : NSNull(), "replacementExpected": kind == "replaced" ? selected?.text("configurationFingerprint") ?? "" : NSNull(), "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
      confirmation = "原演出：" + row.text("performerStageName") + " · " + showTime(row.text("startsAt")) + "\n"
      if kind == "rescheduled" { confirmation += "改期为：\(start) — \(end)" }
      else if kind == "replaced" { confirmation += "替代场次：" + (selected?.text("performerStageName") ?? "未选择") + " · " + showTime(selected?.text("startsAt") ?? "") }
      else { confirmation += "取消原场次" }
      confirmation += "\n原因：" + reason + "\n提交后须查看受影响预约；顾客不会被视为自动接受调整。"
    case "phase-start":
      guard let row else { throw StaffAPIError.invalid }
      body = ["scheduleId": row.id, "expected": row.text("configurationFingerprint"), "phaseCode": phase, "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
      confirmation = "启动现场阶段：" + (showPhases[phase] ?? "待核对") + "\n" + row.text("performerStageName") + "\n原因：" + reason
    case "phase-end", "phase-cancel":
      guard let row else { throw StaffAPIError.invalid }
      body = ["publicId": row.id, "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
      confirmation = (showActions[action] ?? "变更阶段") + "\n" + row.text("performerStageName") + " · " + (showPhases[row.text("phaseCode")] ?? "待核对") + "\n原因：" + reason
    case "schedule-sort":
      guard let row, let value = Int(sort) else { throw CatalogError("请输入整数展示顺序") }
      body = ["scheduleId": row.id, "expected": row.text("configurationFingerprint"), "sortOrder": value]
      confirmation = "调整展示顺序\n" + row.text("performerStageName") + " · " + showTime(row.text("startsAt")) + "\n顺序：" + sort
    case "performer-create", "performer-update":
      var profile = row?.object["profileSnapshot"] as? [String: Any] ?? [:]
      profile["genres"] = genres.components(separatedBy: CharacterSet(charactersIn: ",，")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
      body = ["stageName": name.trimmingCharacters(in: .whitespacesAndNewlines), "status": status, "profileSnapshot": profile]
      if let row { body["performerId"] = row.id; body["expected"] = row.text("configurationFingerprint") }
      else { body["code"] = code.trimmingCharacters(in: .whitespacesAndNewlines) }
      confirmation = "保存演员资料\n艺名：" + name + "\n状态：" + (status == "active" ? "启用" : "停用") + "\n风格：" + genres + "\n保留原演员其他扩展资料。"
    default: throw StaffAPIError.invalid
    }
    return try board.command(actor: actor, action: action, body: body, confirmation: confirmation, preview: preview, replacementBoard: replacementBoard)
  }
  var body: some View {
    Card {
      if editor.action == "publish" { publish }
      if editor.action == "revision" { revision }
      if editor.action == "phase-start" { Picker("现场阶段", selection: $phase) { ForEach(["before_show", "acoustic", "band_live", "intermission", "after_show"], id: \.self) { Text(showPhases[$0]!).tag($0) } } }
      if editor.action == "schedule-sort" { TextField("展示顺序（0—100000）", text: $sort).textFieldStyle(.roundedBorder).keyboardType(.numberPad) }
      if ["performer-create", "performer-update"].contains(editor.action) {
        if editor.action == "performer-create" { TextField("演员编码：大写字母开头", text: $code).textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters) }
        TextField("艺名", text: $name).textFieldStyle(.roundedBorder)
        TextField("风格标签，用逗号分隔", text: $genres, axis: .vertical).textFieldStyle(.roundedBorder)
        Picker("状态", selection: $status) { Text("启用").tag("active"); Text("停用").tag("inactive") }
      }
      if editor.action == "revision" || editor.action.hasPrefix("phase-") { TextField("操作原因（2至240字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder) }
      if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
      Button("核对并提交") { propose { try command() } }.buttonStyle(Primary(symbol: "checkmark.shield"))
        .disabled(!ready || (editor.action == "publish" && (preview?.valid != true || preview?.original != (try? showBytes(publishBody)))))
    }
  }
  @ViewBuilder private var publish: some View {
    publishInputs
    publishSlots
    publishPreview
  }
  @ViewBuilder private var publishInputs: some View {
    Text("发布月份：\(board.month)；时间均为北京时间，可逐场添加，最多155场。").font(.subheadline)
    Text("演员").font(.caption)
    Picker("演员", selection: $performer) { Text("请选择").tag(""); ForEach(board.performers.filter { $0.text("status") == "active" }) { Text($0.text("stageName")).tag($0.id) } }
    timeInput("开始（北京时间）", value: $start)
    timeInput("结束（北京时间）", value: $end)
    Button("加入本次发布清单") {
      do {
        let slot: [String: Any] = ["performerId": performer, "startsAt": try showInputTime(start), "endsAt": try showInputTime(end)]
        try validateShowSlots(["month": board.month, "slots": slots + [slot]], board: board)
        slots.append(slot); preview = nil; notice = "已加入本次清单，须重新预检。"
      } catch { notice = error.localizedDescription }
    }.disabled(!ready || slots.count >= 155)
  }
  private func timeInput(_ title: String, value: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.caption)
      TextField("YYYY-MM-DD HH:mm", text: value, axis: .vertical)
        .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityLabel(title)
    }
  }
  private func slotDescription(_ slot: [String: Any], index: Int) -> String {
    let name = board.performers.first { $0.id == slot["performerId"] as? String }?.text("stageName") ?? "待核对"
    let times = showTime(showText(slot, "startsAt")) + " — " + showTime(showText(slot, "endsAt"))
    return "\(index + 1). " + name + " · " + times
  }
  @ViewBuilder private var publishSlots: some View {
    ForEach(slots.indices, id: \.self) { index in
      Text(slotDescription(slots[index], index: index))
      Button("移除第\(index + 1)场", role: .destructive) { slots.remove(at: index); preview = nil }.disabled(!ready)
    }
  }
  @ViewBuilder private var publishPreview: some View {
    Button(reading ? "正在预检…" : "按服务端排班预检重叠与演员状态") {
      let body = publishBody; preview = nil; reading = true
      Task {
        defer { reading = false }
        do {
          let response = try await model.readShow(showRoot + "/preview", body: body)
          let next = try ShowPublishPreview(body: body, response: response, board: board)
          guard next.original == (try showBytes(publishBody)) else { return }; preview = next; notice = next.valid ? "预检通过，请核对完整清单后发布。" : "存在冲突，请调整后重新预检。"
        } catch { notice = error.localizedDescription }
      }
    }.disabled(!ready || slots.isEmpty)
    if let preview {
      ForEach(Array(preview.rows.enumerated()), id: \.offset) { _, slot in
        Text(showText(slot, "performerName") + " · " + showTime(showText(slot, "startsAt")))
        let reasons = slot["reasons"] as? [String] ?? []
        Text(reasons.isEmpty ? (slot["existingId"] is String ? "已存在，将保留原场" : "可新增") : reasons.joined(separator: "；")).font(.caption).foregroundStyle(reasons.isEmpty ? Color.secondary : Color.red)
      }
    }
  }
  @ViewBuilder private var revision: some View {
    Text("原场：" + (editor.row?.text("performerStageName") ?? "") + " · " + showTime(editor.row?.text("startsAt") ?? ""))
    Picker("调整方式", selection: $kind) { Text("改期").tag("rescheduled"); Text("取消").tag("cancelled"); Text("换为已有场次").tag("replaced") }
    if kind == "rescheduled" {
      timeInput("新开始（北京时间）", value: $start)
      timeInput("新结束（北京时间）", value: $end)
    }
    if kind == "replaced" {
      TextField("替代月份 YYYY-MM", text: $replacementMonth).textFieldStyle(.roundedBorder)
      Button("读取替代月份排班") {
        reading = true; replacement = ""
        Task {
          defer { reading = false }
          do {
            guard let actor = model.identity else { throw StaffAPIError.invalid }; let month = try showMonth(replacementMonth)
            let data = try await model.readShow(showRoot + "?month=" + month)
            guard replacementMonth == month else { return }; replacementBoard = try ShowBoard(data, actor: actor, month: month); notice = "替代排班已读取"
          } catch { replacementBoard = nil; notice = error.localizedDescription }
        }
      }.disabled(!ready)
      if let other = replacementBoard, other.month == replacementMonth {
        Picker("替代场次", selection: $replacement) { Text("请选择").tag(""); ForEach(other.schedules.filter { $0.id != editor.row?.id && $0.text("status") == "scheduled" }) { Text($0.text("performerStageName") + " · " + showTime($0.text("startsAt"))).tag($0.id) } }
      }
    }
    Text("提交后会保留原场次与预约影响；请继续核对顾客确认与通知结果。").font(.subheadline)
  }
}
