import SwiftUI

struct OwnerFinanceFormView: View {
  @EnvironmentObject var model: AppModel
  let board: OwnerFinanceBoard
  let edit: OwnerFinanceEditor
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var fields: [String: String]
  @State private var error = ""
  init(board: OwnerFinanceBoard, edit: OwnerFinanceEditor, close: @escaping () -> Void,
    propose: @escaping (LiveCommand) -> Void) {
    self.board = board; self.edit = edit; self.close = close; self.propose = propose
    _fields = State(initialValue: Self.initialFields(board: board, edit: edit))
  }
  private static func initialFields(board: OwnerFinanceBoard, edit: OwnerFinanceEditor) -> [String: String] {
    let row = edit.row, line = edit.line, day = board.businessDate
    func text(_ key: String, fallback: String = "") -> String {
      let result = row?.text(key) ?? ""
      return result.isEmpty ? fallback : result
    }
    let monthStart = String(day.prefix(7)) + "-01"
    let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX")
    parser.timeZone = TimeZone(secondsFromGMT: 0); parser.dateFormat = "yyyy-MM-dd"
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let monthEnd = parser.date(from: monthStart).flatMap { calendar.date(byAdding: .month, value: 1, to: $0) }
      .flatMap { calendar.date(byAdding: .day, value: -1, to: $0) }.map(parser.string) ?? day
    var values = ["name": text("name"), "displayName": text("name"),
      "categoryDefinitionId": text("categoryDefinitionId", fallback: board.rows("categories").first?.id ?? ""),
      "costCenterId": text("costCenterId", fallback: board.rows("costCenters").first?.id ?? ""),
      "systemCategory": "miscellaneous", "recognitionState": text("recognitionState", fallback: "actual"),
      "allocationPeriod": text("allocationPeriod", fallback: "month"), "recurrence": "month",
      "sourceType": text("sourceType", fallback: "manual"),
      "serviceStartDate": text("serviceStartDate", fallback: day), "serviceEndDate": text("serviceEndDate", fallback: day),
      "cashPaidOn": text("cashPaidOn"), "startsOn": day, "endsOn": "", "effectiveFrom": day, "effectiveUntil": "",
      "periodStart": text("periodStart", fallback: monthStart), "periodEnd": text("periodEnd", fallback: monthEnd),
      "throughDate": day, "employeeId": line?.text("employeeId") ?? "",
      "compensationRuleId": line?.text("compensationRuleId") ?? "", "payBasis": "monthly",
      "units": line?.text("units") ?? "1", "counterparty": text("counterparty"),
      "note": line?.text("note") ?? text("note"), "reason": "", "correctionReason": "",
      "status": text("status") == "paused" ? "active" : "paused"]
    for key in ["netAmountMinor", "taxAmountMinor", "baseRateMinor"] + ownerPayrollAmounts {
      if let original = line ?? row, original.object[key] != nil { values[key] = ownerAmount(original, key) }
      else { values[key] = "0" }
    }
    if row == nil, let category = board.rows("categories").first(where: { $0.id == values["categoryDefinitionId"] }) {
      values["sourceType"] = categorySource(category.text("systemCategory"))
    }
    return values
  }
  private static func categorySource(_ category: String) -> String {
    ["rent": "lease", "band": "performance", "performer": "performance", "utilities": "utility_bill"][category] ?? "manual"
  }
  private func binding(_ key: String) -> Binding<String> {
    Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 })
  }
  private var operation: String { edit.operation }
  private var title: String {
    ["cost.create": "登记费用", "cost.correct": "更正原费用，保留原记录", "recurring-cost.create": "创建周期费用",
      "recurring-cost.materialize": "生成周期费用", "recurring-cost.status": "变更周期规则",
      "cost-category.create": "新增费用分类", "cost-center.create": "新增成本中心",
      "compensation-rule.create": "新增或调整薪资标准", "payroll-run.create": edit.line == nil ? "新增工资明细" : "编辑工资明细",
      "payroll-run.approve": "确认整张工资单", "payroll-run.void": "作废工资单", "payroll-run.post": "工资记入经营费用"][operation] ?? "核对账务"
  }
  var body: some View {
    Card {
      Text(title).font(.title3.bold())
      if ["cost.create", "cost.correct", "recurring-cost.create"].contains(operation) { costFields }
      if operation == "recurring-cost.materialize" {
        field("throughDate", "生成截止日 YYYY-MM-DD")
        Text("将按启用规则生成尚未登记的各期费用，请先核对规则金额与有效期。").font(.caption)
      }
      if operation == "recurring-cost.status" {
        choice("status", "新状态", edit.row?.text("status") == "active"
          ? [("paused", "暂停"), ("ended", "永久结束")] : [("active", "恢复"), ("ended", "永久结束")])
        field("reason", "变更原因（必填）")
      }
      if ["cost-category.create", "cost-center.create"].contains(operation) {
        field("code", "编码（字母、数字或下划线）")
        field("name", "名称")
        if operation == "cost-category.create" { choice("systemCategory", "会计分类", ownerCostCategories.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }) }
      }
      if operation == "compensation-rule.create" { compensationFields }
      if operation == "payroll-run.create" { payrollFields }
      if ["payroll-run.approve", "payroll-run.void", "payroll-run.post"].contains(operation), let row = edit.row {
        Text("\(row.text("periodStart")) — \(row.text("periodEnd")) · \(row.text("lineCount")) 人")
        Text("应发 \(ownerAmount(row, "grossPayMinor")) 元 · 实发 \(ownerAmount(row, "netPayMinor")) 元")
        Text("雇主费用 \(ownerAmount(row, "employerCostMinor")) 元")
        field("reason", "核对说明（必填）")
        if operation == "payroll-run.post" { Text("入账后不能作废；此处不执行银行转账。").font(.caption) }
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("下一步 · 核对完整账务") {
        do {
          let command = try model.prepareOwnerFinance(operation: operation, fields: fields,
            row: edit.row, line: edit.line, removeEmployeeID: nil)
          error = ""; propose(command)
        } catch { self.error = error.localizedDescription }
      }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseOwnerFinance)
      Button("取消编辑", action: close)
    }
  }
  @ViewBuilder private func field(_ key: String, _ label: String, money: Bool = false) -> some View {
    if money {
      TextField(label, text: binding(key)).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
    } else {
      TextField(label, text: binding(key), axis: .vertical).textFieldStyle(.roundedBorder)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
    }
  }
  private func choice(_ key: String, _ label: String, _ values: [(String, String)]) -> some View {
    Picker(label, selection: binding(key)) {
      Text("请选择").tag("")
      ForEach(values, id: \.0) { Text($0.1).tag($0.0) }
    }.pickerStyle(.menu)
  }
  private var centers: [(String, String)] { board.rows("costCenters").map { ($0.id, $0.text("name")) } }
  private var employees: [(String, String)] {
    board.rows("employees").filter { $0.text("status") == "active" }
      .map { ($0.id, $0.text("displayName") + " · " + $0.text("employeeCode")) }
  }
  @ViewBuilder private var costFields: some View {
    field(operation == "recurring-cost.create" ? "name" : "displayName", "费用名称")
    Picker("费用分类", selection: Binding(get: { fields["categoryDefinitionId"] ?? "" }, set: { value in
      fields["categoryDefinitionId"] = value
      if let category = board.rows("categories").first(where: { $0.id == value }) {
        fields["sourceType"] = Self.categorySource(category.text("systemCategory"))
      }
    })) {
      Text("请选择分类").tag("")
      ForEach(board.rows("categories")) { Text($0.text("name")).tag($0.id) }
    }.pickerStyle(.menu)
    choice("costCenterId", "成本中心", centers)
    choice("recognitionState", "确认状态", [("actual", "实际"), ("known", "已知"), ("accrual", "应计")])
    choice("allocationPeriod", "分摊周期", ["day", "week", "month", "quarter", "year"].map { ($0, ownerPeriods[$0]!) })
    if operation == "recurring-cost.create" {
      choice("recurrence", "发生周期", ["day", "week", "month", "quarter", "year"].map { ($0, ownerPeriods[$0]!) })
      field("startsOn", "开始日 YYYY-MM-DD"); field("endsOn", "结束日（可留空）")
    } else {
      field("serviceStartDate", "服务开始日 YYYY-MM-DD"); field("serviceEndDate", "服务结束日 YYYY-MM-DD")
      field("cashPaidOn", "实际付款日（未付留空）")
    }
    field("netAmountMinor", "未税金额（元）", money: true); field("taxAmountMinor", "税额（元）", money: true)
    choice("sourceType", "凭证来源", ["manual", "lease", "payroll", "performance", "utility_bill"].map { ($0, ownerSources[$0]!) })
    field("counterparty", "收款方（可选）"); field("note", "备注（可选）")
    Text("此处登记真实账务，不发起扣款。货品采购应通过采购入库处理，避免重复记录成本。").font(.caption)
    if operation == "cost.correct" { field("correctionReason", "更正原因（必填）") }
  }
  @ViewBuilder private var compensationFields: some View {
    choice("employeeId", "员工", employees)
    if let rule = board.rows("compensationRules").first(where: { $0.text("employeeId") == fields["employeeId"] && $0.text("status") == "active" }) {
      Text("当前标准：\(ownerPayBases[rule.text("payBasis")] ?? "待核对") \(ownerAmount(rule, "baseRateMinor")) 元，\(rule.text("effectiveFrom")) 生效").font(.caption)
    }
    choice("costCenterId", "成本中心", centers)
    choice("payBasis", "计薪方式", ["monthly", "daily", "hourly", "per_shift"].map { ($0, ownerPayBases[$0]!) })
    field("baseRateMinor", "薪资标准（元）", money: true)
    field("effectiveFrom", "生效日 YYYY-MM-DD"); field("effectiveUntil", "失效日（可留空）")
    field("reason", "调整原因（必填）")
    Text("新标准会替代该员工当前标准，并保留历史；生效日须晚于原标准。").font(.caption)
  }
  @ViewBuilder private var payrollFields: some View {
    if edit.row == nil {
      field("periodStart", "工资周期开始日 YYYY-MM-DD"); field("periodEnd", "工资周期结束日 YYYY-MM-DD")
    } else { Text("周期 \(fields["periodStart"] ?? "") — \(fields["periodEnd"] ?? "")") }
    if let line = edit.line { Text("员工：" + line.text("employeeName")).font(.headline) }
    else {
      Picker("员工", selection: Binding(get: { fields["employeeId"] ?? "" }, set: { value in
        fields["employeeId"] = value; fields["compensationRuleId"] = ""
      })) {
        Text("请选择员工").tag("")
        ForEach(employees, id: \.0) { Text($0.1).tag($0.0) }
      }.pickerStyle(.menu)
    }
    choice("compensationRuleId", "适用薪资标准", board.rows("compensationRules")
      .filter { $0.text("employeeId") == fields["employeeId"] }
      .map { ($0.id, "\(ownerPayBases[$0.text("payBasis")] ?? "待核对") \(ownerAmount($0, "baseRateMinor")) 元 · \($0.text("effectiveFrom"))") })
    field("units", "计薪数量（月薪填1，日/时/班填实际数量）", money: true)
    ForEach(ownerPayrollAmounts, id: \.self) { field($0, "\(ownerFieldLabels[$0]!)（元）", money: true) }
    field("note", "明细备注（可选）")
    Text("基本工资按原薪资标准和实际数量计算。保存草稿后须核对整单明细，再确认或入账；不向员工转账。").font(.caption)
  }
}
