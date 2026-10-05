import SwiftUI

struct LiveExperiencePlansView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var query = ExperiencePlanQuery()
  @State private var applied = ExperiencePlanQuery()
  @State private var board: ExperiencePlansBoard?
  @State private var rows: [ShowRow] = []
  @State private var reading = false
  @State private var notice = "请读取当前可见的体验计划"
  @State private var access = ""
  @State private var receiptKey = ""
  @State private var editor: ExperiencePlanEditor?
  @State private var proposed: LiveCommand?
  private var accessKey: String { "\(model.workspaceVersion)|" + (model.identity?.employee.id ?? "") + "|" + (model.identity?.session.id ?? "") + "|" + (model.identity?.permissions.sorted().joined(separator:",") ?? "") + "|" + (model.identity?.deniedPermissions.sorted().joined(separator:",") ?? "") }
  private var usable: Bool { !model.busy && !model.heartbeatBusy && !reading && model.livePending == nil && model.liveOrderPending == nil && !model.liveStorageDamaged }
  private func load(more: Bool = false) async {
    guard !reading else { return }
    reading = true; defer { reading = false }
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let filter = more ? applied : query, captured = accessKey
      let suffix = try filter.suffix(next: more ? board?.next : nil)
      if more && board?.next == nil { throw StaffAPIError.invalid }
      let bytes = try await model.readExperiencePlans(suffix)
      guard captured == accessKey, actor.employee.id == model.identity?.employee.id else { return }
      let next = try ExperiencePlansBoard(bytes, actor: actor)
      if more {
        let existing = Set(rows.map(\.id)); rows += next.rows.filter { !existing.contains($0.id) }
      } else { rows = next.rows; applied = filter }
      board = next; editor = nil; proposed = nil; receiptKey = model.experiencePlanReceipt?.requestKey ?? ""
      notice = "已读取\(rows.count)项原计划" + (next.next != nil ? "，还有后续记录" : "")
    } catch { if !more { rows = []; board = nil }; notice = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment:.leading,spacing:14) {
          LivePendingView()
          Text(notice).font(.subheadline)
          Toggle("按营业日查询历史", isOn:$query.history)
          if query.history {
            TextField("开始营业日 YYYY-MM-DD",text:$query.from).textFieldStyle(.roundedBorder)
            TextField("结束营业日 YYYY-MM-DD",text:$query.to).textFieldStyle(.roundedBorder)
          }
          Button("查询 / 刷新") { Task { await load() } }.disabled(!usable)
          if let board {
            if !board.enabled { Text("当前后台只提供查询，尚未开放原生计划操作。").foregroundStyle(.secondary) }
            if rows.isEmpty { Text("当前权限与查询范围内没有体验计划。") }
            ForEach(rows) { row in plan(row,board:board) }
            if board.next != nil { Button("加载更多原查询结果") { Task { await load(more:true) } }.disabled(!usable) }
          }
        }.padding(16)
      }.background(paper).navigationTitle("桌边体验计划").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement:.cancellationAction) { Button("关闭") { dismiss() } } }
    }.task { access = accessKey; await load() }
      .onChange(of:accessKey) { _, next in if next != access { rows = []; board = nil; editor = nil; proposed = nil; dismiss() } }
      .onChange(of:model.busy) { _, busy in
        if !busy, !reading, let receipt = model.experiencePlanReceipt, receipt.requestKey != receiptKey { receiptKey = receipt.requestKey; Task { await load() } }
      }
      .sheet(isPresented:Binding(get:{editor != nil || proposed != nil},set:{if !$0 { editor=nil; proposed=nil }})) {
        NavigationStack {
          ScrollView {
            ZStack(alignment:.topLeading) {
              if let editor { ExperiencePlanForm(editor:editor,enabled:usable,propose:{ reason,minutes in
                do {
                  guard let actor=model.identity,let board, let current=rows.first(where:{$0.id==editor.row.id}) else {throw StaffAPIError.invalid}
                  // Retain the selected page's precise row/version in the board used to create the command.
                  let raw:[String:Any] = ["data":["employeeId":board.employeeID,"protocol":1,"durableCommands":board.enabled,"canManage":board.canManage,"rows":[current.object],"hasMore":false,"next":NSNull()]]
                  let selected = try ExperiencePlansBoard(showBytes(raw),actor:actor)
                  proposed = try selected.command(actor:actor,row:current,action:editor.action,reason:reason,cueID:editor.cue?.id,minutes:minutes)
                } catch { notice=error.localizedDescription }
              }).opacity(proposed == nil ? 1:0).allowsHitTesting(proposed == nil).accessibilityHidden(proposed != nil) }
              if let command=proposed {
                VStack(alignment:.leading,spacing:16) {
                  Text(command.steps.first?.experiencePlanProof?["confirmation"] as? String ?? "原请求待核对")
                  Button("确认现场处理") { proposed=nil; editor=nil; Task { await model.executeLive(command) } }.buttonStyle(Primary(symbol:"checkmark.shield")).disabled(!model.canExecuteLive(command))
                  Button("返回核对") { proposed=nil }
                }
              }
            }
            if !notice.isEmpty { Text(notice).font(.subheadline) }
          }.padding(16).navigationTitle("核对原计划").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.cancellationAction) { Button("关闭") { editor=nil; proposed=nil } } }
        }
      }
  }
  @ViewBuilder private func plan(_ row:ShowRow,board:ExperiencePlansBoard) -> some View {
    Card {
      Text(row.text("table_code") + " · " + (experiencePlanStates[row.text("plan_state")] ?? "待核对")).font(.headline)
      Text(row.text("business_date") + " · " + row.text("party_size") + "人")
      Text(row.text("promise_summary"))
      if !row.text("activated_at").isEmpty { Text("激活：" + showTime(row.text("activated_at"))).font(.caption) }
      let cues = ((row.object["cues"] as? [[String:Any]]) ?? []).compactMap { try? ShowRow($0) }.sorted { (Int($0.text("sequence_no")) ?? 0) < (Int($1.text("sequence_no")) ?? 0) }
      ForEach(cues) { cue in
        Divider()
        Text(cue.text("sequence_no") + ". " + (experienceActions[cue.text("action_kind")] ?? "服务节点") + " · " + (experienceCueStates[cue.text("status")] ?? "待核对"))
        if let payload=cue.object["action_payload"] as? [String:Any],let title=payload["title"] as? String { Text(title) }
        if !cue.text("due_at").isEmpty { Text("计划时间：" + showTime(cue.text("due_at"))).font(.caption) }
        if manageable(row,board:board),cue.text("trigger_kind")=="elapsed",["pending","ready"].contains(cue.text("status")),cue.object["service_task_id"] is NSNull {
          Button("调整此未派出节点时间") { editor=ExperiencePlanEditor(row:row,action:"reschedule",cue:cue) }.disabled(!usable)
        }
      }
      if manageable(row,board:board) {
        let tasks = row.object["tasks"] as? [[String:Any]] ?? []
        if row.text("plan_state")=="active",!tasks.contains(where:{["pending","acknowledged","in_progress"].contains(showText($0,"status"))}) { Button("暂停未派出计划") { editor=ExperiencePlanEditor(row:row,action:"pause",cue:nil) }.disabled(!usable) }
        if row.text("plan_state")=="paused" { Button("恢复计划") { editor=ExperiencePlanEditor(row:row,action:"resume",cue:nil) }.disabled(!usable) }
        Button("主管中止计划",role:.destructive) { editor=ExperiencePlanEditor(row:row,action:"cancel",cue:nil) }.disabled(!usable)
      }
    }
  }
  private func manageable(_ row:ShowRow,board:ExperiencePlansBoard)->Bool {
    board.enabled && board.canManage && model.identity.map { experiencePlanPermissions.allSatisfy($0.allows) } == true && ["active","paused"].contains(row.text("plan_state")) && ["open","closing"].contains(row.text("session_status"))
  }
}
private struct ExperiencePlanEditor { let row:ShowRow,action:String,cue:ShowRow? }
private struct ExperiencePlanForm:View {
  let editor:ExperiencePlanEditor,enabled:Bool
  let propose:(String,Int?)->Void
  @State private var reason=""
  @State private var minutes=""
  @State private var confirmed=false
  var body:some View {
    VStack(alignment:.leading,spacing:16) {
      Text(editor.row.text("table_code") + " · " + editor.row.text("promise_summary")).font(.headline)
      if editor.action=="cancel" { Text("请先确认现场服务已停止。本次中止整个原计划，不退款、撤单或删除已完成记录。") }
      if editor.action=="reschedule" { TextField("激活后分钟数 0—240",text:$minutes).textFieldStyle(.roundedBorder).keyboardType(.numberPad) }
      TextField("现场原因及处理结果（4—500字）",text:$reason,axis:.vertical).textFieldStyle(.roundedBorder)
      Toggle("已核对原计划与现场情况",isOn:$confirmed)
      Button("继续核对") { propose(reason,editor.action=="reschedule" ? Int(minutes):nil) }.buttonStyle(Primary(symbol:"checkmark.shield")).disabled(!enabled || !confirmed)
    }
  }
}
