import SwiftUI

struct OwnerFinanceEditor: Identifiable {
  let id = UUID()
  let operation: String
  var row: OwnerFinanceRow? = nil
  var line: OwnerFinanceRow? = nil
}

struct LiveOwnerFinanceView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var section = "costs"
  @State private var start = ""
  @State private var end = ""
  @State private var query = ""
  @State private var editor: OwnerFinanceEditor?
  @State private var proposed: LiveCommand?
  @State private var notice = ""
  @State private var access: String?
  @State private var confirmed = false
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":"
      + ownerFinancePermissions.filter(actor.allows).joined(separator: ",")
  }
  private var currentAccess: Bool { access != nil && access == accessKey && !accessKey.isEmpty }
  private func permitted(_ permission: String) -> Bool { model.identity?.allows(permission) == true }
  private func sections(_ board: OwnerFinanceBoard) -> [String] {
    (board.canViewCost ? ["costs", "recurring"] : [])
      + (board.canViewPayroll ? ["payroll", "employees"] : []) + ["settings"]
  }
  private let labels = ["costs": "经营费用", "recurring": "周期费用", "payroll": "工资批次",
    "employees": "薪资标准", "settings": "分类与成本中心"]
  private func matches(_ row: OwnerFinanceRow, keys: [String]) -> Bool {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return term.isEmpty || keys.map(row.text).joined(separator: " ").localizedCaseInsensitiveContains(term)
  }
  private func costCategory(_ row: OwnerFinanceRow, _ board: OwnerFinanceBoard) -> String {
    if let category = board.rows("categories").first(where: { $0.id == row.text("categoryDefinitionId") }) {
      return category.text("name")
    }
    return ownerCostCategories[row.text("category")] ?? "分类待核对"
  }
  private func clearPrivateView() {
    editor = nil; proposed = nil; notice = ""; query = ""; confirmed = false
  }
  private func prepareRemoval(_ run: OwnerFinanceRow, line: OwnerFinanceRow) {
    do {
      proposed = try model.prepareOwnerFinance(operation: "payroll-run.create", fields: [:],
        row: run, line: nil, removeEmployeeID: line.text("employeeId"))
      confirmed = false; notice = ""
    } catch { notice = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !model.ownerFinanceState.isEmpty { Text(model.ownerFinanceState).font(.subheadline) }
          if currentAccess {
            Foldout(title: "查询日期与记录") {
              TextField("费用开始日期 YYYY-MM-DD", text: $start).textFieldStyle(.roundedBorder)
              TextField("费用结束日期 YYYY-MM-DD", text: $end).textFieldStyle(.roundedBorder)
              Text("起止日期都留空表示当前营业月；工资按原批次周期展示。").font(.caption)
            }
            Button("刷新费用与工资") {
              clearPrivateView()
              Task { await model.loadOwnerFinance(start: start, end: end) }
            }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise"))
              .disabled(model.busy || model.heartbeatBusy)
            if let board = model.ownerFinanceBoard, board.employeeID == model.identity?.employee.id {
              Picker("工作区", selection: $section) {
                ForEach(sections(board), id: \.self) { Text(labels[$0]!).tag($0) }
              }.pickerStyle(.menu)
              TextField("筛选名称、员工或单号", text: $query).textFieldStyle(.roundedBorder)
              if let editor {
                OwnerFinanceFormView(board: board, edit: editor, close: { self.editor = nil }) { command in
                  proposed = command; confirmed = false; notice = ""
                }.id(editor.id)
              }
              if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
              if !board.enabled { Text("此后台尚未启用安全账务提交，当前仅可查看。").font(.caption) }
              switch section {
              case "costs": if board.canViewCost { costs(board) }
              case "recurring": if board.canViewCost { recurring(board) }
              case "employees": if board.canViewPayroll { compensation(board) }
              case "payroll": if board.canViewPayroll { payroll(board) }
              default: settings(board)
              }
            }
          } else { Text("请使用有权限的员工账号重新读取经营财务资料。").font(.subheadline) }
        }.padding(16)
      }.background(paper).navigationTitle("费用与工资").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clearPrivateView(); dismiss() } } }
    }.tint(ink)
      .task { access = accessKey; await model.loadOwnerFinance(start: "", end: ""); selectAvailableSection() }
      .onChange(of: accessKey) { _, _ in clearPrivateView(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clearPrivateView(); dismiss() }
      .onChange(of: model.ownerFinanceBoard?.canViewPayroll) { old, new in
        if old == true && new != true { clearPrivateView() }
        selectAvailableSection()
      }
      .onChange(of: model.ownerFinanceBoard?.canViewCost) { old, new in
        if old == true && new != true { clearPrivateView() }
        selectAvailableSection()
      }
      .onChange(of: section) { _, _ in clearPrivateView() }
      .sheet(item: $proposed, onDismiss: { confirmed = false }) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if currentAccess, model.ownerFinanceBoard?.employeeID == command.employeeID {
                Text(command.steps.first?.ownerFinanceProof?["confirmation"] as? String ?? "原请求内容不可用，请返回重新核对")
                  .textSelection(.enabled)
                Text("本次提交会登记真实账务，不会执行银行转账或扣款。").font(.subheadline)
                Toggle("已逐项核对原记录、人员、金额和说明", isOn: $confirmed)
                Button("确认提交") {
                  proposed = nil; editor = nil; confirmed = false
                  Task { await model.executeLive(command) }
                }.buttonStyle(Primary(symbol: "checkmark.shield"))
                  .disabled(!confirmed || !model.canUseOwnerFinance || !model.canExecuteLive(command))
              } else { Text("账号或查看权限已变化，确认内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle("核对经营财务操作").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
  private func selectAvailableSection() {
    guard let board = model.ownerFinanceBoard else { return }
    let choices = sections(board)
    if !choices.contains(section) { section = choices.first ?? "settings" }
  }
  @ViewBuilder private func costs(_ board: OwnerFinanceBoard) -> some View {
    if permitted("commercial.cost.manage") {
      Button("登记经营费用") { editor = OwnerFinanceEditor(operation: "cost.create") }
        .buttonStyle(Primary(symbol: "doc.badge.plus")).disabled(!model.canUseOwnerFinance)
    }
    let rows = board.rows("costs").filter { row in
      matches(row, keys: ["name", "publicId", "counterparty", "costCenterName"])
        || costCategory(row, board).localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    if rows.isEmpty { Text("当前范围没有符合条件的费用记录。").foregroundStyle(.secondary) }
    ForEach(rows) { row in
      Card {
        Text(row.text("name")).font(.headline)
        Text("含税 \(ownerAmount(row, "grossAmountMinor")) 元 · \(ownerStates[row.text("recognitionState")] ?? "待核对")")
        Text("未税 \(ownerAmount(row, "netAmountMinor")) 元 · 税额 \(ownerAmount(row, "taxAmountMinor")) 元").font(.caption)
        Text("\(row.text("serviceStartDate")) — \(row.text("serviceEndDate")) · \(row.text("costCenterName"))").font(.caption)
        Text("\(costCategory(row, board)) · \(ownerSources[row.text("sourceType")] ?? row.text("sourceType"))").font(.caption)
        Text(row.text("publicId")).font(.caption).textSelection(.enabled)
        if !row.text("note").isEmpty { Text(row.text("note")).font(.caption) }
        if row.bool("corrected") { Text("已有更正，原凭证保留").font(.caption) }
        else if permitted("commercial.cost.manage") {
          Button("新增更正凭证") { editor = OwnerFinanceEditor(operation: "cost.correct", row: row) }
            .buttonStyle(Primary(tone: .secondary, symbol: "doc.text")).disabled(!model.canUseOwnerFinance)
        }
      }
    }
  }
  @ViewBuilder private func recurring(_ board: OwnerFinanceBoard) -> some View {
    if permitted("commercial.cost.manage") {
      Button("新建周期费用") { editor = OwnerFinanceEditor(operation: "recurring-cost.create") }
        .buttonStyle(Primary(symbol: "calendar.badge.plus")).disabled(!model.canUseOwnerFinance)
      Button("生成截至指定日的费用") { editor = OwnerFinanceEditor(operation: "recurring-cost.materialize") }
        .buttonStyle(Primary(tone: .secondary, symbol: "calendar")).disabled(!model.canUseOwnerFinance)
    }
    let rows = board.rows("recurringRules").filter { matches($0, keys: ["name", "publicId", "counterparty"]) }
    if rows.isEmpty { Text("没有符合条件的周期费用规则。").foregroundStyle(.secondary) }
    ForEach(rows) { row in
      Card {
        Text(row.text("name")).font(.headline)
        Text("每\(ownerPeriods[row.text("recurrence")] ?? "待核对") \(ownerAmount(row, "grossAmountMinor")) 元 · \(ownerStates[row.text("status")] ?? "待核对")")
        Text("\(row.text("startsOn")) — \(row.text("endsOn").isEmpty ? "长期" : row.text("endsOn"))").font(.caption)
        Text("未税 \(ownerAmount(row, "netAmountMinor")) · 税额 \(ownerAmount(row, "taxAmountMinor")) 元").font(.caption)
        Text(row.text("publicId")).font(.caption)
        if ["active", "paused"].contains(row.text("status")) && permitted("commercial.cost.manage") {
          Button("暂停、恢复或结束") { editor = OwnerFinanceEditor(operation: "recurring-cost.status", row: row) }
            .buttonStyle(Primary(tone: .secondary, symbol: "calendar.badge.clock")).disabled(!model.canUseOwnerFinance)
        }
      }
    }
  }
  @ViewBuilder private func compensation(_ board: OwnerFinanceBoard) -> some View {
    if permitted("commercial.payroll.manage") {
      Button("新增或调整薪资标准") { editor = OwnerFinanceEditor(operation: "compensation-rule.create") }
        .buttonStyle(Primary(symbol: "person.text.rectangle")).disabled(!model.canUseOwnerFinance)
    }
    let rows = board.rows("compensationRules").filter { matches($0, keys: ["employeeName", "publicId", "reason"]) }
    if rows.isEmpty { Text("没有符合条件的薪资标准。").foregroundStyle(.secondary) }
    ForEach(rows) { row in
      Card {
        Text(row.text("employeeName")).font(.headline)
        Text("\(ownerPayBases[row.text("payBasis")] ?? "待核对") \(ownerAmount(row, "baseRateMinor")) 元 · \(ownerStates[row.text("status")] ?? "待核对")")
        Text("\(row.text("effectiveFrom")) — \(row.text("effectiveUntil").isEmpty ? "长期" : row.text("effectiveUntil"))").font(.caption)
        Text("\(row.text("costCenterName")) · \(row.text("reason"))").font(.caption)
      }
    }
  }
  @ViewBuilder private func payroll(_ board: OwnerFinanceBoard) -> some View {
    Text("工资入账只记录雇主费用，不会向员工转账；发薪须另行核对银行记录。").font(.subheadline)
    if permitted("commercial.payroll.manage") {
      Button("创建工资草稿") { editor = OwnerFinanceEditor(operation: "payroll-run.create") }
        .buttonStyle(Primary(symbol: "doc.badge.plus")).disabled(!model.canUseOwnerFinance)
    }
    let runs = board.rows("payrollRuns").filter { run in
      matches(run, keys: ["publicId", "periodStart", "periodEnd"])
        || board.rows("payrollLines").contains { $0.text("payrollRunId") == run.id && matches($0, keys: ["employeeName"]) }
    }
    if runs.isEmpty { Text("没有符合条件的工资批次。").foregroundStyle(.secondary) }
    ForEach(runs) { run in
      Card {
        Text("\(run.text("periodStart")) — \(run.text("periodEnd"))").font(.headline)
        Text("\(ownerStates[run.text("status")] ?? "待核对") · \(run.text("lineCount")) 人 · 实发 \(ownerAmount(run, "netPayMinor")) 元")
        Text("应发 \(ownerAmount(run, "grossPayMinor")) 元 · 雇主费用 \(ownerAmount(run, "employerCostMinor")) 元").font(.caption)
        Text(run.text("publicId")).font(.caption).textSelection(.enabled)
        Foldout(title: "查看工资明细") {
          ForEach(board.rows("payrollLines").filter { $0.text("payrollRunId") == run.id }) { line in
            VStack(alignment: .leading, spacing: 8) {
              Text("\(line.text("employeeName")) · 计薪数量 \(line.text("units"))").font(.headline)
              Text("基本工资 \(ownerAmount(line, "basePayMinor")) 元").font(.caption)
              ForEach(ownerPayrollAmounts, id: \.self) { key in
                Text("\(ownerFieldLabels[key]!)：\(ownerAmount(line, key)) 元").font(.caption)
              }
              if !line.text("note").isEmpty { Text(line.text("note")).font(.caption) }
              if run.text("status") == "draft" && permitted("commercial.payroll.manage") {
                Button("编辑 \(line.text("employeeName"))") { editor = OwnerFinanceEditor(operation: "payroll-run.create", row: run, line: line) }
                  .buttonStyle(Primary(tone: .secondary, symbol: "pencil")).disabled(!model.canUseOwnerFinance)
                if ((try? run.integer("lineCount")) ?? 0) > 1 {
                  Button("移除此人草稿明细", role: .destructive) { prepareRemoval(run, line: line) }
                    .disabled(!model.canUseOwnerFinance)
                }
              }
            }.padding(.vertical, 8)
          }
        }
        if run.text("status") == "draft" && permitted("commercial.payroll.manage") {
          Button("追加员工明细") { editor = OwnerFinanceEditor(operation: "payroll-run.create", row: run) }
            .buttonStyle(Primary(tone: .secondary, symbol: "person.badge.plus")).disabled(!model.canUseOwnerFinance)
          Button("核对并确认工资单") { editor = OwnerFinanceEditor(operation: "payroll-run.approve", row: run) }
            .buttonStyle(Primary(tone: .secondary, symbol: "checkmark.seal")).disabled(!model.canUseOwnerFinance)
        }
        if ["draft", "approved"].contains(run.text("status")) && permitted("commercial.payroll.manage") {
          Button("作废未入账工资单", role: .destructive) { editor = OwnerFinanceEditor(operation: "payroll-run.void", row: run) }
            .disabled(!model.canUseOwnerFinance)
        }
        if run.text("status") == "approved" && permitted("commercial.payroll.post") {
          Button("核对并记入经营费用") { editor = OwnerFinanceEditor(operation: "payroll-run.post", row: run) }
            .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseOwnerFinance)
        }
      }
    }
  }
  @ViewBuilder private func settings(_ board: OwnerFinanceBoard) -> some View {
    Card {
      Text("费用分类").font(.headline)
      ForEach(board.rows("categories")) { row in Text("\(row.text("name")) · \(ownerCostCategories[row.text("systemCategory")] ?? "待核对")").font(.subheadline) }
      Text("成本中心").font(.headline)
      ForEach(board.rows("costCenters")) { Text($0.text("name")).font(.subheadline) }
      if permitted("commercial.cost.manage") {
        Button("新增费用分类") { editor = OwnerFinanceEditor(operation: "cost-category.create") }
          .buttonStyle(Primary(tone: .secondary, symbol: "folder.badge.plus")).disabled(!model.canUseOwnerFinance)
        Button("新增成本中心") { editor = OwnerFinanceEditor(operation: "cost-center.create") }
          .buttonStyle(Primary(tone: .secondary, symbol: "building.2")).disabled(!model.canUseOwnerFinance)
      }
    }
  }
}
