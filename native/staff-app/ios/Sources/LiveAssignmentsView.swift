import SwiftUI

struct LiveAssignmentsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  var initialTableID: String? = nil
  @State private var selected = Set<String>()
  @State private var query = ""
  @State private var employee = ""
  @State private var role = ""
  @State private var kind = "primary"
  @State private var immediate = true
  @State private var start = Date()
  @State private var hasEnd = false
  @State private var end = Date().addingTimeInterval(8 * 3600)
  @State private var reason = ""
  @State private var ending: String?
  @State private var endReason = ""
  @State private var proposed: LiveCommand?
  @State private var error = ""
  private var manager: Bool { model.identity?.allows(LiveAssignments.permission) == true }
  func propose(_ make: () throws -> LiveCommand) {
    do {
      proposed = try make()
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !model.assignmentsState.isEmpty { Text(model.assignmentsState).font(.subheadline) }
          if !model.assignmentReceipt.isEmpty {
            Text(model.assignmentReceipt).font(.subheadline).foregroundStyle(ink)
          }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if let board = model.assignmentsBoard {
            if manager {
              assignmentForm(board)
              AssignmentScheduleSection(board: board, proposed: $proposed)
            }
            Text("当前生效 · \(board.assignments.count)项").font(.headline)
            Text("当前仅显示本账号可见且已生效的责任；未来安排尚不授予责任桌权限。").font(.caption).foregroundStyle(.secondary)
            if board.assignments.isEmpty { Text("当前没有生效的责任安排").foregroundStyle(.secondary) }
            ForEach(board.assignments) { item in
              Card {
                HStack {
                  Text(item.tableCode).font(.title3.bold())
                  Spacer()
                  Text(assignmentKinds[item.assignmentType] ?? item.assignmentType).font(.caption)
                    .foregroundStyle(ink)
                }
                Text(item.employeeName + " · " + item.roleCode).font(.headline)
                Text(
                  assignmentTime(item.startsAt) + " → "
                    + (item.endsAt.map(assignmentTime) ?? "持续有效") + " · 上海时间"
                ).font(.caption)
                Text(item.reason).font(.subheadline).foregroundStyle(.secondary)
                if manager {
                  if ending == item.id {
                    TextField("结束原因（2—1000字）", text: $endReason, axis: .vertical).textFieldStyle(
                      .roundedBorder)
                    Button("核对并结束此责任") {
                      propose { try model.prepareAssignmentEnd(id: item.id, reason: endReason) }
                    }.buttonStyle(Primary(tone: .danger, symbol: "person.crop.circle.badge.minus"))
                      .disabled(!model.canAct(LiveAssignments.permission))
                    Button("取消结束") {
                      ending = nil
                      endReason = ""
                    }
                  } else {
                    Button("结束责任") {
                      ending = item.id
                      endReason = ""
                    }.buttonStyle(
                      Primary(tone: .secondary, symbol: "person.crop.circle.badge.minus")
                    ).disabled(!model.canAct(LiveAssignments.permission))
                  }
                }
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("人员与责任桌").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadAssignments() } }.disabled(model.busy)
          }
        }
    }.tint(ink).environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
      .task {
        if let initialTableID { selected = [initialTableID] }
        await model.loadAssignments()
      }
      .onChange(of: model.assignmentReceipt) { _, value in
        if !value.isEmpty {
          selected = []
          reason = ""
          ending = nil
          endReason = ""
        }
      }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              Text(command.steps.first?.assignmentProof?["confirmation"] as? String ?? "请核对原请求")
              Button("核对无误，提交") {
                proposed = nil
                Task { await model.executeLive(command) }
              }.buttonStyle(Primary(symbol: "checkmark")).disabled(
                !model.canAct(LiveAssignments.permission))
              Button("返回修改") { proposed = nil }.buttonStyle(
                Primary(tone: .secondary, symbol: "arrow.uturn.backward"))
            }.padding(20)
          }.background(paper).navigationTitle("确认责任安排").navigationBarTitleDisplayMode(.inline)
        }.tint(ink)
      }
  }
  @ViewBuilder func assignmentForm(_ board: LiveAssignments) -> some View {
    Foldout(title: "安排责任桌 · 已选\(selected.count)桌") {
      VStack(alignment: .leading, spacing: 12) {
        Picker("员工", selection: $employee) {
          Text("选择员工").tag("")
          ForEach(board.options.employees) { Text($0.displayName + " · " + $0.code).tag($0.id) }
        }
        Picker("责任岗位", selection: $role) {
          Text("选择岗位").tag("")
          ForEach(board.options.roles) { Text($0.name).tag($0.id) }
        }
        Picker("责任类型", selection: $kind) {
          ForEach(["primary", "backup", "temporary"], id: \.self) {
            Text(assignmentKinds[$0]!).tag($0)
          }
        }.pickerStyle(.segmented)
        TextField("搜索桌号或区域（支持部分文字）", text: $query).textFieldStyle(.roundedBorder)
        HStack {
          Text("已开台优先 · \(board.visibleTables(query).count)桌").font(.caption)
          Spacer()
          Button("选择筛选结果") {
            let next = selected.union(board.visibleTables(query).map(\.id))
            if next.count > 80 { error = "一次最多选择80桌" } else { selected = next }
          }
          Button("清空") { selected = [] }
        }.font(.caption)
        Text(
          "已选："
            + board.tables.filter { selected.contains($0.id) }.map(\.code).joined(separator: "、")
        ).font(.caption).fixedSize(horizontal: false, vertical: true)
        ForEach(board.visibleTables(query)) { row in
          Button {
            if selected.contains(row.id) {
              selected.remove(row.id)
            } else if selected.count < 80 {
              selected.insert(row.id)
            } else {
              error = "一次最多选择80桌"
            }
          } label: {
            HStack {
              Image(systemName: selected.contains(row.id) ? "checkmark.circle.fill" : "circle")
                .font(.title3)
              Text(row.code).bold()
              Text(row.areaName).font(.caption)
              Spacer()
              Text(row.activeSessionId == nil ? "空台" : "营业中").font(.caption)
            }.padding(.vertical, 10).contentShape(Rectangle())
          }.buttonStyle(.plain).foregroundStyle(selected.contains(row.id) ? ink : .secondary)
        }
        Toggle("立即生效", isOn: $immediate)
        if !immediate { DatePicker("开始 · 上海时间", selection: $start) }
        Toggle("设置结束时间", isOn: $hasEnd)
        if hasEnd { DatePicker("结束 · 上海时间", selection: $end) }
        TextField("安排原因（2—1000字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        Text("主服务员冲突时整批拒绝；如需换人，先核对并结束原责任。岗位仅记录分工，不更改账号权限。").font(.caption).foregroundStyle(
          .secondary)
        Button("核对并安排 \(selected.count)桌") {
          propose {
            try model.prepareAssignment(
              tableIDs: selected, employeeID: employee, roleID: role, kind: kind,
              start: immediate ? Date() : start, end: hasEnd ? end : nil, reason: reason)
          }
        }.buttonStyle(Primary(symbol: "person.2.badge.gearshape")).disabled(
          !model.canAct(LiveAssignments.permission) || selected.isEmpty || employee.isEmpty
            || role.isEmpty)
        if !model.canAct(LiveAssignments.permission) {
          Text("提交前请刷新，确认最新权限与责任分工。").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
  }
}

private struct AssignmentScheduleSection: View {
  @EnvironmentObject var model: AppModel
  let board: LiveAssignments
  @Binding var proposed: LiveCommand?
  @State private var editing: String?
  @State private var cancelling = false
  @State private var employee = ""
  @State private var role = ""
  @State private var kind = "primary"
  @State private var start = Date()
  @State private var end = Date()
  @State private var hasEnd = false
  @State private var reason = ""
  @State private var error = ""
  private var enabled: Bool { model.canAct(LiveAssignments.permission) }
  var body: some View {
    Foldout(title: "未来安排与历史") {
      if let schedule = board.schedule {
        Picker("查询范围", selection: Binding(
          get: { model.assignmentScheduleMode },
          set: { mode in Task { await model.loadAssignmentSchedule(mode: mode) } }
        )) {
          ForEach(AssignmentSchedule.modes, id: \.self) {
            Text(AssignmentSchedule.labels[$0]!).tag($0)
          }
        }.pickerStyle(.segmented).disabled(model.busy || model.heartbeatBusy)
        Text("\(AssignmentSchedule.labels[schedule.mode]!) · 第\(schedule.page + 1)页 · \(schedule.rows.count)项")
          .font(.subheadline)
        HStack {
          Button("上一页") { Task { await model.loadAssignmentSchedule(mode: schedule.mode, page: schedule.page - 1) } }
            .disabled(model.busy || model.heartbeatBusy || schedule.page == 0)
          Spacer()
          Button("下一页") { Task { await model.loadAssignmentSchedule(mode: schedule.mode, page: schedule.page + 1) } }
            .disabled(model.busy || model.heartbeatBusy || !schedule.hasMore || schedule.page >= 10000)
        }
        if schedule.rows.isEmpty { Text("此页没有\(AssignmentSchedule.labels[schedule.mode]!)记录").foregroundStyle(.secondary) }
        ForEach(schedule.rows) { row in
          Card {
            Text(row.tableCode + " · " + row.employeeName).font(.headline)
            Text("\(assignmentKinds[row.assignmentType] ?? row.assignmentType) · \(row.roleCode)").font(.subheadline)
            Text("\(assignmentTime(row.startsAt)) → \(row.endsAt.map(assignmentTime) ?? "不设结束") · 上海时间")
              .font(.caption)
            Text("安排原因：" + row.reason).font(.caption).foregroundStyle(.secondary)
            if let cancelled = row.cancelledAt {
              Text("已取消 · \(assignmentTime(cancelled))\n取消原因：\(row.cancellationReason ?? "待核对")")
                .font(.caption)
            }
            if schedule.mode == "future" {
              HStack {
                Button("修改安排") { begin(row, cancelling: false) }.disabled(!enabled)
                Spacer()
                Button("取消安排", role: .destructive) { begin(row, cancelling: true) }.disabled(!enabled)
              }
              if editing == row.id { editForm(row) }
            }
          }
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
      } else {
        Text("配套后台尚未提供未来安排管理。已提交的安排请在原管理端核对。").font(.caption)
      }
    }.onChange(of: board.schedule) { _, _ in
      editing = nil; reason = ""; error = ""
    }
  }
  private func begin(_ row: AssignmentSchedule.Row, cancelling: Bool) {
    self.cancelling = cancelling; editing = row.id; reason = ""; error = ""
    employee = board.options.employees.contains(where: { $0.id == row.employeeId }) ? row.employeeId : ""
    role = board.options.roles.contains(where: { $0.id == row.roleId }) ? row.roleId : ""
    kind = row.assignmentType
    start = assignmentDate(row.startsAt) ?? Date()
    hasEnd = row.endsAt != nil
    end = row.endsAt.flatMap(assignmentDate) ?? start.addingTimeInterval(3600)
  }
  @ViewBuilder private func editForm(_ row: AssignmentSchedule.Row) -> some View {
    if cancelling {
      Text("取消后此安排不再生效，原记录和原因保留。已生效责任请使用“结束责任”。").font(.caption)
    } else {
      Picker("员工", selection: $employee) {
        Text("请选择当前在职员工").tag("")
        ForEach(board.options.employees) { Text($0.displayName + " · " + $0.code).tag($0.id) }
      }
      Picker("责任岗位", selection: $role) {
        Text("请选择岗位").tag("")
        ForEach(board.options.roles) { Text($0.name).tag($0.id) }
      }
      Picker("责任类型", selection: $kind) {
        ForEach(["primary", "backup", "temporary"], id: \.self) { Text(assignmentKinds[$0]!).tag($0) }
      }.pickerStyle(.segmented)
      DatePicker("开始 · 上海时间", selection: $start)
      Toggle("设置结束时间", isOn: $hasEnd)
      if hasEnd { DatePicker("结束 · 上海时间", selection: $end) }
    }
    TextField(cancelling ? "取消原因（2—1000字）" : "修改原因（2—1000字）", text: $reason, axis: .vertical)
      .textFieldStyle(.roundedBorder)
    Button(cancelling ? "核对并取消安排" : "核对修改") {
      do {
        let change = cancelling ? nil : try AssignmentSchedule.Change(
          employeeID: employee, roleID: role, kind: kind, start: start, end: hasEnd ? end : nil)
        proposed = try model.prepareAssignmentSchedule(id: row.id, reason: reason, change: change)
        error = ""
      } catch { self.error = error.localizedDescription }
    }.buttonStyle(Primary(tone: cancelling ? .danger : .secondary, symbol: cancelling ? "calendar.badge.minus" : "calendar"))
      .disabled(!enabled)
    Button("放弃编辑") { editing = nil; reason = ""; error = "" }
  }
}
