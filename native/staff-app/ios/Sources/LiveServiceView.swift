import SwiftUI

struct LiveServiceView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  var focusedTask: String? = nil
  var focusedSession: String? = nil
  @State private var showAll = false
  @State var search = ""
  @State var filter = "all"
  @State var selected: LiveServiceBoard.Task?
  @State var action = "complete"
  @State var note = ""
  @State var employee = ""
  @State var priority = "high"
  @State var checked = false
  @State var error = ""
  @State var proposed: LiveCommand?
  @State var itemID: String?
  @State private var showExperiencePlans = false
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if model.identity?.allows("customer.experience.manage") == true && model.identity?.allows("service.execute") == true {
            Button("桌边体验计划与主管处理") { showExperiencePlans = true }
              .buttonStyle(Primary(tone: .secondary, symbol: "list.bullet.clipboard"))
          }
          Text(model.serviceState).font(.caption)
          if focusedTask != nil && !showAll {
            Text("正在核对提醒对应的原桌次任务").font(.caption)
            Button("查看全部服务任务") { showAll = true }
          }
          TextField("桌号、任务或处理说明", text: $search).textFieldStyle(.roundedBorder)
          Picker("任务范围", selection: $filter) {
            Text("全部").tag("all")
            Text("我负责").tag("mine")
            Text("紧急").tag("urgent")
            Text("主管").tag("manager")
          }.pickerStyle(.segmented)
          if let board = model.serviceBoard {
            let rows = board.tasks.filter {
              (showAll || focusedTask == nil
                || $0.id == focusedTask && $0.tableSessionId == focusedSession)
                && (search.isEmpty
                  || ($0.tableCode + " " + $0.title + " " + ($0.detail ?? ""))
                    .localizedCaseInsensitiveContains(search))
                && (filter == "all" || filter == "mine" && $0.assignedToActor
                  || filter == "urgent" && ["urgent", "high"].contains($0.priority)
                  || filter == "manager" && $0.interactionMode == "manager_resolution")
            }
            if rows.isEmpty {
              Text(focusedTask != nil && !showAll ? "原任务已完成、已转交或当前不可见；请刷新核对。" : "没有符合条件的未完成任务")
                .foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
              Card {
                HStack {
                  Text(row.tableCode + " · " + row.title).font(.headline)
                  Spacer()
                  Text(LiveServiceBoard.priorities[row.priority] ?? "待核对").font(.caption)
                    .foregroundStyle(row.priority == "urgent" ? .red : ink)
                }
                if let detail = row.detail, !detail.isEmpty { Text(detail).font(.subheadline) }
                Text(
                  ["pending": "待处理", "acknowledged": "已接收", "in_progress": "处理中"][row.status]
                    ?? "待核对"
                ).font(.caption)
                Text(
                  "提出时间：" + reservationTime(row.createdAt)
                    + (row.dueAt.map { " · 应于 " + reservationTime($0) } ?? "")
                ).font(.caption)
                if row.experience { Text("体验服务：完成时同步原计划节点；中止计划须由主管在体验管理中处理。").font(.caption) }
                if row.specialized {
                  if let id = row.originalOrderItemId,
                    model.identity?.allows("refund.request") == true
                  {
                    Button("核对原商品与补送份数") { itemID = id }.buttonStyle(
                      Primary(tone: .secondary, symbol: "shippingbox"))
                  } else {
                    Text("请在原商品或体验计划中处理，保留份数与原计划记录。").font(.caption)
                  }
                } else {
                  Button(row.interactionMode == "manager_resolution" ? "主管处理 · 留下处理结果" : "处理此服务任务")
                  {
                    selected = row
                    action = "complete"
                    note = ""
                    employee = ""
                    priority = row.priority
                    checked = false
                    error = ""
                  }.buttonStyle(Primary(tone: .secondary, symbol: "checklist")).disabled(
                    !model.canUseService || row.experience && board.durableExperience != true
                      || row.interactionMode == "manager_resolution"
                        && model.identity?.allows("service.manage") != true
                  )
                }
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("服务任务中心").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button("刷新") { Task { await model.loadService() } }.disabled(model.busy)
        }
      }
    }
    .task { await model.loadService() }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
    .sheet(isPresented: $showExperiencePlans, onDismiss: { Task { await model.loadService() } }) { LiveExperiencePlansView() }
    .sheet(item: $selected) { row in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(row.tableCode + " · " + row.title).font(.headline)
            Picker("处理方式", selection: $action) {
              ForEach(
                row.actions.filter {
                  $0 != "cancel" || model.identity?.allows("service.manage") == true
                }
                  + (model.identity?.allows("service.manage") == true
                    ? ["assign", "priority"] : []),
                id: \.self
              ) { Text(LiveServiceBoard.labels[$0] ?? "处理").tag($0) }
            }
            if action == "assign" {
              Picker("接手员工", selection: $employee) {
                Text("请选择员工").tag("")
                ForEach(
                  (model.serviceBoard?.employees ?? []).filter {
                    row.taskType != "guest.complaint" || $0.canManage
                  }
                ) { Text($0.name).tag($0.id) }
              }
            }
            if action == "priority" {
              Picker("新的优先级", selection: $priority) {
                ForEach(["urgent", "high", "normal", "low"], id: \.self) {
                  Text(LiveServiceBoard.priorities[$0]!).tag($0)
                }
              }
            }
            TextField("处理原因与结果；投诉至少4个字", text: $note, axis: .vertical).textFieldStyle(
              .roundedBorder)
            Toggle("已核对原任务和现场情况", isOn: $checked)
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("下一步 · 核对处理结果") {
              do {
                proposed = try model.prepareService(
                  id: row.id, action: action, note: note, employee: employee, priority: priority)
                selected = nil
              } catch { self.error = error.localizedDescription }
            }.buttonStyle(Primary(symbol: "arrow.right")).disabled(!model.canUseService || !checked)
          }.padding(20)
        }.navigationTitle("处理服务任务").navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回") { selected = nil } }
        }
      }
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].serviceProof?["confirmation"] as? String ?? "请刷新")
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
    .sheet(
      isPresented: Binding(get: { itemID != nil }, set: { if !$0 { itemID = nil } }),
      onDismiss: { Task { await model.loadService() } }
    ) { if let itemID { LiveAfterSalesView(itemID: itemID) } }
  }
}
