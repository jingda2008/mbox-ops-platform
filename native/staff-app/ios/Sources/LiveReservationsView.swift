import SwiftUI

struct LiveReservationsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State var creating = false
  @State var range = "current"
  @State var from = Date()
  @State var to = Date()
  @State var search = ""
  @State var queue = false
  @State var showFinished = false
  @State var selectedID = ""
  @State var selectedAction = ""
  @State var reason = ""
  @State var override = false
  @State var editing = false
  @State var error = ""
  @State var proposed: LiveCommand?
  var query: ReservationQuery {
    ReservationQuery(range: range, from: ReservationQuery.day(from), to: ReservationQuery.day(to))
  }
  var actionable: Bool { model.canUseReservations && query == model.reservationQuery }
  func choose(_ id: String, _ action: String) {
    selectedID = id
    selectedAction = action
    reason = ""
    override = false
    error = ""
    editing = true
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.reservationState).font(.caption)
          if model.identity?.allows("reservation.manage") == true {
            Button("新建预约") { creating = true }.buttonStyle(Primary(symbol: "calendar.badge.plus"))
              .disabled(!actionable || model.reservationCapabilities?.durableCreate != true)
          }
          Picker("业务", selection: $queue) {
            Text("预约").tag(false)
            Text("候位与排序").tag(true)
          }.pickerStyle(.segmented)
          if !queue {
            Picker("查询范围", selection: $range) {
              Text("当前").tag("current")
              Text("跨日待办").tag("carryover")
              Text("历史").tag("history")
            }.pickerStyle(.segmented)
          }
          if queue || range == "history" {
            Card {
              DatePicker("开始日期", selection: $from, displayedComponents: .date)
              DatePicker("结束日期", selection: $to, in: from..., displayedComponents: .date)
              Text("按上海自然日查询，最多31天。").font(.caption)
            }
          }
          Button("读取所选范围") { Task { await model.loadReservations(query) } }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          ).disabled(model.busy)
          TextField("姓名、桌号或预约编号", text: $search).textFieldStyle(.roundedBorder)
          Toggle("显示已结束记录", isOn: $showFinished)
          if queue {
            let rows = model.reservationIntake.filter {
              (showFinished || $0.active)
                && (search.isEmpty
                  || ($0.customerName + " " + $0.tableCodes.joined(separator: " ") + " "
                    + $0.publicId).localizedCaseInsensitiveContains(search))
            }
            if rows.isEmpty { Text("此范围没有符合条件的安排").foregroundStyle(.secondary) }
            ForEach(rows) { row in
              Card {
                HStack {
                  Text(row.customerName).font(.headline)
                  Spacer()
                  Text(row.kind == "waitlist" ? "候位" : "预约").font(.caption)
                }
                Text(
                  "\(row.guestCount)人 · \(row.tableCodes.isEmpty ? "待安排" : row.tableCodes.joined(separator:"、"))"
                )
                Text(reservationTime(row.arrivalAt)).font(.caption)
                Text(row.maskedContact).font(.caption)
                Text("状态：" + row.statusLabel).font(.caption).foregroundStyle(ink)
                Text(row.priorityBooking == nil ? "普通安排" : "会员优先安排").foregroundStyle(ink)
                if let change = row.queueOverride {
                  Text((ReservationCommands.labels[change.mode] ?? "已调整") + " · " + change.reason)
                    .font(.caption)
                }
                if row.active && model.identity?.allows("reservation.manage") == true {
                  if row.kind == "waitlist" {
                    if model.reservationCapabilities?.durableWaitlist == true {
                      Text("处理候位").font(.subheadline.bold())
                      ForEach(ReservationCommands.waitlistActions(row.status), id: \.self) { next in
                        Button(ReservationCommands.waitlistLabels[next]!) { choose(row.id, "waitlist:" + next) }
                          .buttonStyle(Primary(tone: next == "cancelled" || next == "expired" ? .danger : .secondary,
                            symbol: next == "cancelled" || next == "expired" ? "xmark.circle" : "checkmark.circle"))
                          .disabled(!actionable)
                      }
                    } else {
                      Text("此后台尚未启用 App 候位处理，可查看记录；请在原管理端处理。").font(.caption)
                    }
                  }
                  Text("调整同一时段排序").font(.subheadline.bold())
                  ForEach(["promote", "demote", "clear"], id: \.self) { mode in
                    Button(ReservationCommands.labels[mode] ?? "调整") { choose(row.id, mode) }
                      .buttonStyle(Primary(tone: .secondary, symbol: "arrow.up.arrow.down"))
                      .disabled(!actionable || model.reservationCapabilities?.durablePriority != true)
                  }
                }
              }
            }
          } else {
            let rows = model.reservations.filter {
              (showFinished || range == "history" || !$0.actions.isEmpty)
                && (search.isEmpty
                  || ($0.customerName + " " + $0.tables + " " + $0.publicId)
                    .localizedCaseInsensitiveContains(search))
            }
            if rows.isEmpty { Text("此范围没有符合条件的预约").foregroundStyle(.secondary) }
            ForEach(rows) { row in
              Card {
                HStack {
                  Text(row.customerName).font(.headline)
                  Spacer()
                  Text(row.statusLabel).font(.caption).foregroundStyle(ink)
                }
                Text("\(row.guestCount)人 · \(row.tables)")
                Text(reservationTime(row.arrivalAt) + " — " + reservationTime(row.expectedEndAt))
                  .font(.caption)
                Text(row.contactToken ?? (row.contactAvailable ? "联系方式已保护" : "未留联系方式")).font(
                  .caption)
                Text(
                  [
                    "no_preference": "无位置偏好", "stage_atmosphere": "舞台氛围", "quiet_chat": "安静聊天",
                    "comfortable_booth": "舒适卡座", "outdoor_view": "户外景观",
                  ][row.seatPreference] ?? "位置偏好待确认"
                ).font(.caption)
                if let note = row.note, !note.isEmpty { Text(note).font(.caption) }
                if model.identity?.allows("reservation.manage") == true {
                  ForEach(row.actions, id: \.self) { action in
                    Button(ReservationCommands.labels[action] ?? "处理") { choose(row.id, action) }
                      .buttonStyle(
                        Primary(
                          tone: action == "cancel" ? .danger : .secondary,
                          symbol: action == "cancel" ? "xmark.circle" : "checkmark.circle")
                      ).disabled(!actionable)
                  }
                }
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("预约与排队").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
      }
    }.task { await model.loadReservations(query) }.onChange(of: model.workspaceVersion) { _, _ in
      dismiss()
    }
    .sheet(isPresented: $creating) { ReservationCreateView() }
    .sheet(isPresented: $editing) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(ReservationCommands.waitlistLabels[String(selectedAction.dropFirst("waitlist:".count))]
              ?? ReservationCommands.labels[selectedAction] ?? "处理预约").font(.headline)
            TextField("处理说明（候位、取消、排序调整必填）", text: $reason, axis: .vertical).textFieldStyle(
              .roundedBorder)
            if selectedAction.hasPrefix("waitlist:") {
              Text("请先完成并核对现场处理，再登记结果；此操作不会自动联系客人、开台或退款。").font(.caption)
            }
            if selectedAction == "cancel" {
              Text("取消会释放预约桌位；已有定金仍须按收款与退款记录处理。").font(.caption)
              if model.identity?.allows("reservation.cancel.override") == true {
                Toggle("主管例外取消", isOn: $override)
              }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("下一步 · 核对操作") {
              do {
                if selectedAction.hasPrefix("waitlist:") {
                  proposed = try model.prepareWaitlist(id: selectedID,
                    to: String(selectedAction.dropFirst("waitlist:".count)), reason: reason)
                } else if queue {
                  proposed = try model.prepareReservationPriority(
                    id: selectedID, mode: selectedAction, reason: reason)
                } else {
                  proposed = try model.prepareReservation(
                    id: selectedID, action: selectedAction, reason: reason, override: override)
                }
                editing = false
              } catch { self.error = error.localizedDescription }
            }.buttonStyle(Primary(symbol: "arrow.right")).disabled(!actionable)
          }.padding(20)
        }.navigationTitle("确认事项").navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回") { editing = false } }
        }
      }
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].reservationProof?["confirmation"] as? String ?? "请重新读取")
            Button("确认执行") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
        }
      }
    }
  }
}
func reservationTime(_ value: String) -> String {
  guard let date = assignmentDate(value) else { return "时间待核对" }
  let f = DateFormatter()
  f.locale = Locale(identifier: "zh_CN")
  f.timeZone = TimeZone(identifier: "Asia/Shanghai")
  f.dateFormat = "MM-dd HH:mm"
  return f.string(from: date)
}
