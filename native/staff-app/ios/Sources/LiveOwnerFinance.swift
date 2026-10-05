import Foundation
import CoreFoundation
import CryptoKit

let ownerFinanceRoot = "/api/native/commercial-ops"
let ownerFinancePermissions = ["commercial.cost.view", "commercial.cost.manage", "commercial.payroll.view", "commercial.payroll.manage", "commercial.payroll.post"]
let ownerCostCategories = ["beverage_purchase": "酒水采购", "personnel": "人工", "performer": "演出人员", "band": "乐队", "rent": "租金", "utilities": "水电", "miscellaneous": "杂项"]
let ownerPeriods = ["day": "日", "week": "周", "month": "月", "quarter": "季度", "year": "年"]
let ownerSources = ["manual": "手工凭证", "lease": "租赁合同", "payroll": "工资", "performance": "演出结算", "utility_bill": "水电账单"]
let ownerPayBases = ["monthly": "月薪", "daily": "日薪", "hourly": "时薪", "per_shift": "每班"]
let ownerStates = ["draft": "草稿", "approved": "已确认", "posted": "已入账", "voided": "已作废", "active": "启用", "paused": "暂停", "ended": "结束", "superseded": "已替代", "actual": "实际", "known": "已知", "accrual": "应计"]
let ownerPayrollAmounts = ["overtimeMinor", "bonusMinor", "commissionMinor", "allowanceMinor", "deductionMinor", "employerContributionMinor"]
let ownerFieldLabels = ["displayName": "费用名称", "name": "名称", "code": "编码", "serviceStartDate": "服务开始", "serviceEndDate": "服务结束", "cashPaidOn": "实际付款日", "startsOn": "开始日", "endsOn": "终止日", "throughDate": "生成截止日", "effectiveFrom": "生效日", "effectiveUntil": "失效日", "periodStart": "周期开始", "periodEnd": "周期结束", "reason": "说明", "correctionReason": "更正原因", "counterparty": "收款方", "note": "备注", "netAmountMinor": "未税金额", "taxAmountMinor": "税额", "baseRateMinor": "薪资标准", "basePayMinor": "基本工资", "overtimeMinor": "加班", "bonusMinor": "奖金", "commissionMinor": "提成", "allowanceMinor": "补贴", "deductionMinor": "扣款", "employerContributionMinor": "雇主承担", "units": "计薪数量"]

struct OwnerFinanceRow: Identifiable, Equatable {
  let bytes: Data
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] ?? [:] }
  var id: String { text("id") }
  init(_ object: [String: Any]) throws {
    guard let id = object["id"] as? String, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
    bytes = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
  }
  func text(_ key: String) -> String {
    if let value = object[key] as? String { return value }
    if let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() { return value.stringValue }
    return ""
  }
  func bool(_ key: String) -> Bool { (object[key] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false }
  func integer(_ key: String) throws -> Int { try ownerInteger(object[key]) }
}
func ownerInteger(_ value: Any?) throws -> Int {
  let string: String
  if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { string = number.stringValue }
  else if let value = value as? String { string = value }
  else { throw StaffAPIError.invalid }
  guard string.range(of: "^(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
    let number = Int(string), number <= 9_007_199_254_740_991 else { throw StaffAPIError.invalid }
  return number
}
func ownerMoney(_ value: String) throws -> Int {
  guard value.range(of: "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else {
    throw CatalogError("金额须为非负数字，最多两位小数")
  }
  let parts = value.split(separator: ".").map(String.init)
  return Int(parts[0])! * 100 + (parts.count == 2 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
}
func ownerAmount(_ row: OwnerFinanceRow, _ key: String) -> String {
  guard let value = try? row.integer(key) else { return "待核对" }
  return ownerMinorText(value)
}
func ownerMinorText(_ value: Int) -> String {
  "\(value / 100)." + String(format: "%02d", value % 100)
}
func ownerDate(_ value: String) throws -> String {
  let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX")
  parser.timeZone = TimeZone(secondsFromGMT: 0); parser.dateFormat = "yyyy-MM-dd"; parser.isLenient = false
  guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil,
    let date = parser.date(from: value), parser.string(from: date) == value else {
    throw CatalogError("请填写有效日期 YYYY-MM-DD")
  }
  return value
}

struct OwnerFinanceBoard {
  let businessDate: String
  let employeeID: String
  let enabled: Bool
  let canViewCost: Bool
  let canViewPayroll: Bool
  private let collections: [String: [OwnerFinanceRow]]
  func rows(_ key: String) -> [OwnerFinanceRow] { collections[key] ?? [] }
  init(data: Data, capability: Data, actor: StaffIdentity) throws {
    guard let raw = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["data"] as? [String: Any],
      let cap = (try JSONSerialization.jsonObject(with: capability) as? [String: Any])?["data"] as? [String: Any],
      let id = cap["employeeId"] as? String, id == actor.employee.id,
      try ownerInteger(cap["protocol"]) == 1,
      let commands = cap["durableCommands"] as? NSNumber, CFGetTypeID(commands) == CFBooleanGetTypeID(),
      let cost = raw["canViewCost"] as? NSNumber, CFGetTypeID(cost) == CFBooleanGetTypeID(),
      let payroll = raw["canViewPayroll"] as? NSNumber, CFGetTypeID(payroll) == CFBooleanGetTypeID(),
      let day = raw["businessDate"] as? String,
      ownerFinancePermissions.contains(where: actor.allows)
    else { throw StaffAPIError.invalid }
    businessDate = try ownerDate(day); employeeID = id; enabled = commands.boolValue
    canViewCost = cost.boolValue; canViewPayroll = payroll.boolValue
    guard !canViewCost || actor.allows("commercial.cost.view"),
      !canViewPayroll || actor.allows("commercial.payroll.view") else { throw StaffAPIError.invalid }
    var collections: [String: [OwnerFinanceRow]] = [:]
    for key in ["categories", "costCenters", "recurringRules", "costs", "employees", "compensationRules", "payrollRuns", "payrollLines"] {
      guard let values = raw[key] as? [[String: Any]] else { throw StaffAPIError.invalid }
      let rows = try values.map(OwnerFinanceRow.init)
      guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
      collections[key] = rows
    }
    guard canViewCost || (collections["costs"]!.isEmpty && collections["recurringRules"]!.isEmpty),
      canViewPayroll || ["employees", "compensationRules", "payrollRuns", "payrollLines"].allSatisfy({ collections[$0]!.isEmpty }) else { throw StaffAPIError.invalid }
    self.collections = collections
  }
  static func query(start: String, end: String) throws -> String {
    if start.isEmpty && end.isEmpty { return "" }
    let first = try ownerDate(start), last = try ownerDate(end)
    guard first <= last else { throw CatalogError("结束日期不能早于开始日期") }
    return "?startDate=\(first)&endDate=\(last)"
  }
  func command(actor: StaffIdentity, operation: String, fields: [String: String],
    row: OwnerFinanceRow? = nil, line: OwnerFinanceRow? = nil, removeEmployeeID: String? = nil) throws -> LiveCommand {
    let permission = try ownerPermission(operation)
    guard enabled, actor.employee.id == employeeID, actor.allows(permission),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else {
      throw CatalogError("费用或工资资料、登录或权限已变化，请刷新")
    }
    func value(_ key: String) -> String { (fields[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    func required(_ key: String, min: Int = 1, max: Int = 1000) throws -> String {
      let text = value(key)
      guard (min...max).contains(text.utf16.count) else { throw CatalogError("请核对" + (ownerFieldLabels[key] ?? "必填信息") + "长度") }
      return text
    }
    func choice(_ key: String, values: [String: String]) throws -> String {
      let text = value(key); guard values[text] != nil else { throw CatalogError("请选择有效的费用或薪资选项") }; return text
    }
    func optional(_ key: String, max: Int = 1000) throws -> Any {
      if value(key).isEmpty { return NSNull() }; return try required(key, max: max)
    }
    func date(_ key: String, optional: Bool = false) throws -> Any {
      if optional && value(key).isEmpty { return NSNull() }; return try ownerDate(value(key))
    }
    func selected(_ key: String, collection: String) throws -> OwnerFinanceRow {
      guard let selected = rows(collection).first(where: { $0.id == value(key) }) else { throw CatalogError("所选分类、员工或规则已变化，请刷新") }; return selected
    }
    let targetCollection: String? = operation == "cost.correct" ? "costs" : operation == "recurring-cost.status" ? "recurringRules" : operation.hasPrefix("payroll-run.") ? "payrollRuns" : nil
    if let row {
      guard let targetCollection, rows(targetCollection).contains(row) else { throw CatalogError("原记录已变化，请刷新后重新选择") }
    }
    var body: [String: Any] = [:]
    var proof: [String: Any] = ["operation": "commercial." + operation, "employeeId": actor.employee.id]
    var suffix = ""
    var title = ""
    switch operation {
    case "cost.create", "cost.correct", "recurring-cost.create":
      guard canViewCost else { throw CatalogError("需要费用查看权限") }
      let category = try selected("categoryDefinitionId", collection: "categories")
      let center = try selected("costCenterId", collection: "costCenters")
      let net = try ownerMoney(value("netAmountMinor")), tax = try ownerMoney(value("taxAmountMinor"))
      let source = try choice("sourceType", values: ownerSources)
      body = ["categoryDefinitionId": category.id, "costCenterId": center.id, "netAmountMinor": net, "taxAmountMinor": tax,
        "recognitionState": try choice("recognitionState", values: ["actual": "实际", "known": "已知", "accrual": "应计"]),
        "allocationPeriod": try choice("allocationPeriod", values: ownerPeriods), "sourceType": source,
        "counterparty": try optional("counterparty", max: 128), "note": try optional("note")]
      if operation == "recurring-cost.create" {
        let start = try ownerDate(value("startsOn")); let end = try date("endsOn", optional: true)
        guard !(end is String) || (end as! String) >= start else { throw CatalogError("结束日期不能早于开始日期") }
        let expectedSource = ["rent": "lease", "band": "performance", "performer": "performance", "utilities": "utility_bill"][category.text("systemCategory")] ?? "manual"
        guard source == expectedSource else { throw CatalogError("凭证来源与费用分类不一致") }
        body.merge(["name": try required("name", max: 128), "startsOn": start, "endsOn": end, "recurrence": try choice("recurrence", values: ownerPeriods)]) { _, new in new }
        suffix = "/recurring-costs"; title = "创建周期费用"
      } else {
        let start = try ownerDate(value("serviceStartDate")), end = try ownerDate(value("serviceEndDate"))
        guard end >= start else { throw CatalogError("服务结束日期不能早于开始日期") }
        body.merge(["displayName": try required("displayName", max: 128), "category": category.text("systemCategory"), "currency": "CNY", "serviceStartDate": start, "serviceEndDate": end, "cashPaidOn": try date("cashPaidOn", optional: true)]) { _, new in new }
        if operation == "cost.correct" {
          guard let row, !row.bool("corrected") else { throw CatalogError("请核对尚未更正的原费用") }
          body["correctionReason"] = try required("correctionReason", min: 2)
          suffix = "/costs/\(row.id)/corrections"; title = "新增费用更正凭证"
        } else { suffix = "/costs"; title = "登记经营费用" }
      }
    case "cost-category.create", "cost-center.create":
      let code = try required("code", max: 64)
      guard code.range(of: "^[a-zA-Z0-9_]+$", options: .regularExpression) != nil else { throw CatalogError("编码只能包含字母、数字和下划线") }
      body = ["code": code, "name": try required("name", max: 64)]
      if operation == "cost-category.create" { body["systemCategory"] = try choice("systemCategory", values: ownerCostCategories) }
      suffix = operation == "cost-category.create" ? "/cost-categories" : "/cost-centers"; title = "保存费用分类配置"
    case "recurring-cost.materialize":
      guard canViewCost else { throw CatalogError("需要费用查看权限") }
      body["throughDate"] = try ownerDate(value("throughDate")); suffix = "/recurring-costs/materialize"; title = "生成截至指定日的周期费用"
    case "recurring-cost.status":
      guard canViewCost, let row, ["active", "paused"].contains(row.text("status")) else { throw CatalogError("周期规则已变化或已结束") }
      let next = try choice("status", values: ["active": "启用", "paused": "暂停", "ended": "结束"])
      guard next != row.text("status") else { throw CatalogError("请选择变化后的状态") }
      body = ["status": next, "reason": try required("reason", min: 2)]; suffix = "/recurring-costs/\(row.id)/status"; title = "变更周期费用状态"
    case "compensation-rule.create":
      guard canViewPayroll else { throw CatalogError("需要工资查看权限") }
      let employee = try selected("employeeId", collection: "employees"), center = try selected("costCenterId", collection: "costCenters")
      guard employee.text("status") == "active" else { throw CatalogError("所选员工已停用") }
      let active = rows("compensationRules").filter { $0.text("employeeId") == employee.id && $0.text("status") == "active" }
      guard active.count <= 1 else { throw StaffAPIError.invalid }
      let start = try ownerDate(value("effectiveFrom")), end = try date("effectiveUntil", optional: true)
      guard !(end is String) || (end as! String) >= start, active.first.map({ start > $0.text("effectiveFrom") }) ?? true else { throw CatalogError("新标准的生效日须晚于原标准，失效日不得更早") }
      body = ["employeeId": employee.id, "costCenterId": center.id, "payBasis": try choice("payBasis", values: ownerPayBases), "baseRateMinor": try ownerMoney(value("baseRateMinor")), "effectiveFrom": start, "effectiveUntil": end, "reason": try required("reason", min: 2)]
      proof["compensation"] = active.first?.id ?? "none"; suffix = "/compensation-rules"; title = "新增或调整薪资标准"
    case "payroll-run.create":
      guard canViewPayroll, row == nil || row?.text("status") == "draft" else { throw CatalogError("只能编辑工资草稿") }
      let start = try ownerDate(row?.text("periodStart") ?? value("periodStart")), end = try ownerDate(row?.text("periodEnd") ?? value("periodEnd"))
      guard end >= start else { throw CatalogError("工资周期不正确") }
      body = ["periodStart": start, "periodEnd": end]
      if let row { body["draftRunId"] = row.id; body["expectedVersion"] = try row.integer("version") }
      if let removeEmployeeID {
        guard let row, try row.integer("lineCount") > 1,
          rows("payrollLines").contains(where: { $0.text("payrollRunId") == row.id && $0.text("employeeId") == removeEmployeeID }) else { throw CatalogError("最后一条明细请作废整张草稿；原明细变化时须刷新") }
        body["removeEmployeeId"] = removeEmployeeID; body["lines"] = [[String: Any]](); title = "移除工资草稿中的员工明细"
      } else {
        let employee = try selected("employeeId", collection: "employees"), rule = try selected("compensationRuleId", collection: "compensationRules")
        guard employee.text("status") == "active", rule.text("employeeId") == employee.id else { throw CatalogError("薪资标准不属于当前在职员工") }
        if let line {
          guard let row, rows("payrollLines").contains(line), line.text("payrollRunId") == row.id, line.text("employeeId") == employee.id else { throw CatalogError("原工资明细已变化") }
          body["replaceEmployeeLine"] = true
        } else if let row {
          guard try row.integer("lineCount") < 200,
            !rows("payrollLines").contains(where: { $0.text("payrollRunId") == row.id && $0.text("employeeId") == employee.id }) else { throw CatalogError("该员工已有明细或已达人数上限，请编辑原明细") }
        }
        let units = value("units")
        guard units.range(of: "^(0|[1-9][0-9]{0,5})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil,
          let quantity = Decimal(string: units, locale: Locale(identifier: "en_US_POSIX")), quantity > 0,
          rule.text("payBasis") != "monthly" || quantity == 1 else { throw CatalogError("计薪数量须为正数且最多两位小数；月薪填1") }
        var product = Decimal(try rule.integer("baseRateMinor")) * quantity, rounded = Decimal()
        NSDecimalRound(&rounded, &product, 0, .plain)
        let base = try ownerInteger(NSDecimalNumber(decimal: rounded).stringValue)
        var detail: [String: Any] = ["employeeId": employee.id, "compensationRuleId": rule.id, "units": units, "basePayMinor": base, "note": try optional("note")]
        for key in ownerPayrollAmounts { detail[key] = try ownerMoney(value(key)) }
        let gross = try ["basePayMinor", "overtimeMinor", "bonusMinor", "commissionMinor", "allowanceMinor"].reduce(0) { try $0 + ownerInteger(detail[$1]) }
        guard gross <= 9_007_199_254_740_991,
          gross + (try ownerInteger(detail["employerContributionMinor"])) <= 9_007_199_254_740_991,
          try ownerInteger(detail["deductionMinor"]) <= gross else { throw CatalogError("扣款不能大于应发工资") }
        body["lines"] = [detail]; title = "保存工资草稿明细"
      }
      suffix = "/payroll-runs"
    case "payroll-run.approve", "payroll-run.void", "payroll-run.post":
      guard canViewPayroll, let row else { throw CatalogError("请先选择工资单") }
      let allowed = operation == "payroll-run.approve" ? ["draft"] : operation == "payroll-run.post" ? ["approved"] : ["draft", "approved"]
      guard allowed.contains(row.text("status")), try row.integer("lineCount") > 0 else { throw CatalogError("工资单状态已变化，请刷新") }
      body["reason"] = try required("reason", min: 2)
      suffix = "/payroll-runs/\(row.id)/" + operation.components(separatedBy: ".")[1]
      title = operation == "payroll-run.post" ? "工资记入经营费用" : operation == "payroll-run.approve" ? "确认工资单" : "作废未入账工资单"
    default: throw CatalogError("未识别的经营财务操作")
    }
    if let row { proof["target"] = row.id; if let version = try? row.integer("version") { proof["version"] = version } }
    var confirmation = [title]
    if let row { confirmation.append("原记录：" + row.text("publicId")) }
    for key in ownerFieldLabels.keys.sorted() {
      if let number = body[key] as? Int, key.hasSuffix("Minor") { confirmation.append(ownerFieldLabels[key]! + "：" + ownerMinorText(number) + "元") }
      else if let text = body[key] as? String, !text.isEmpty { confirmation.append(ownerFieldLabels[key]! + "：" + text) }
    }
    let enumGroups: [(String, String, [String: String])] = [
      ("recognitionState", "确认状态", ownerStates), ("allocationPeriod", "分摊周期", ownerPeriods),
      ("recurrence", "发生周期", ownerPeriods), ("sourceType", "凭证来源", ownerSources),
      ("payBasis", "计薪方式", ownerPayBases), ("status", "新状态", ownerStates),
      ("systemCategory", "会计分类", ownerCostCategories)]
    for (key, label, options) in enumGroups {
      if let value = body[key] as? String { confirmation.append(label + "：" + (options[value] ?? "待核对")) }
    }
    if body["netAmountMinor"] != nil {
      confirmation.append("含税合计：" + ownerMinorText(try ownerInteger(body["netAmountMinor"]) + ownerInteger(body["taxAmountMinor"])) + "元")
    }
    for (key, collection, label) in [("categoryDefinitionId", "categories", "分类"), ("costCenterId", "costCenters", "成本中心"), ("employeeId", "employees", "员工")] {
      if let id = body[key] as? String, let item = rows(collection).first(where: { $0.id == id }) { confirmation.append(label + "：" + item.text(collection == "employees" ? "displayName" : "name")) }
    }
    for detail in body["lines"] as? [[String: Any]] ?? [] {
      let name = rows("employees").first { $0.id == detail["employeeId"] as? String }?.text("displayName") ?? "待核对"
      confirmation.append("员工：" + name + " · 数量 " + (detail["units"] as? String ?? ""))
      for key in ["basePayMinor"] + ownerPayrollAmounts { confirmation.append(ownerFieldLabels[key]! + "：" + ownerMinorText(try ownerInteger(detail[key])) + "元") }
    }
    if let removeEmployeeID { confirmation.append("移除员工：" + (rows("employees").first { $0.id == removeEmployeeID }?.text("displayName") ?? "待核对")) }
    if let row, row.object["netPayMinor"] != nil {
      let details = rows("payrollLines").filter { $0.text("payrollRunId") == row.id }
      guard details.count == (try row.integer("lineCount")) else { throw CatalogError("工资整单明细不完整，请刷新后核对") }
      confirmation.append("整单周期：" + row.text("periodStart") + " — " + row.text("periodEnd") + " · " + String(details.count) + "人")
      confirmation.append("整单应发：" + ownerMinorText(try row.integer("grossPayMinor")) + "元 · 实发：" + ownerMinorText(try row.integer("netPayMinor")) + "元 · 雇主费用：" + ownerMinorText(try row.integer("employerCostMinor")) + "元")
      for detail in details {
        confirmation.append("原明细：" + detail.text("employeeName") + " · 数量 " + detail.text("units"))
        for key in ["basePayMinor"] + ownerPayrollAmounts {
          confirmation.append(ownerFieldLabels[key]! + "：" + ownerMinorText(try detail.integer(key)) + "元")
        }
      }
    }
    confirmation.append("只登记账务，不执行转账或扣款。")
    proof["confirmation"] = confirmation.joined(separator: "\n")
    let id = UUID().uuidString.lowercased()
    return LiveCommand(id: id, employeeID: actor.employee.id, title: title, permission: permission, steps: [.init(path: ownerFinanceRoot + suffix, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try JSONSerialization.data(withJSONObject: ["ownerFinance": proof], options: .sortedKeys))])
  }
}
func ownerPermission(_ operation: String) throws -> String {
  let allowed = ["cost.create", "cost.correct", "cost-category.create", "cost-center.create", "recurring-cost.create", "recurring-cost.materialize", "recurring-cost.status", "compensation-rule.create", "payroll-run.create", "payroll-run.approve", "payroll-run.void", "payroll-run.post"]
  guard allowed.contains(operation) else { throw CatalogError("未识别的经营财务操作") }
  if operation.hasPrefix("cost") || operation.hasPrefix("recurring-cost") { return "commercial.cost.manage" }
  return operation == "payroll-run.post" ? "commercial.payroll.post" : "commercial.payroll.manage"
}
extension LiveCommand.Step {
  var ownerFinanceProof: [String: Any]? {
    guard let recoveryBody else { return nil }
    return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["ownerFinance"] as? [String: Any]
  }
}
func secureOwnerFinanceCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, var proof = step.ownerFinanceProof else { return command }
  guard command.steps.count == 1 else { throw StaffAPIError.invalid }
  guard proof["payloadKey"] == nil else { throw CatalogError("请从未决记录恢复原费用或工资请求") }
  let key = "owner-finance-" + command.id
  guard let text = String(data: step.body, encoding: .utf8) else { throw StaffAPIError.invalid }
  try store(key, text)
  proof.removeValue(forKey: "confirmation"); proof["payloadKey"] = key
  proof["payloadSHA256"] = SHA256.hash(data: step.body).map { String(format: "%02x", $0) }.joined()
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对费用或工资原请求", permission: command.permission, steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key, recoveryBody: try JSONSerialization.data(withJSONObject: ["ownerFinance": proof], options: .sortedKeys))], completedSteps: command.completedSteps, rejected: command.rejected)
}
func ownerFinanceRequestBody(_ command: LiveCommand, step: LiveCommand.Step,
  read: (String) throws -> String) throws -> [String: Any] {
  guard command.steps.count == 1, command.steps.first == step,
    UUID(uuidString: command.id) != nil, step.keyHeader == "idempotency-key",
    step.key == "native-business-" + command.id,
    let proof = step.ownerFinanceProof, proof["employeeId"] as? String == command.employeeID,
    let operation = proof["operation"] as? String, operation.hasPrefix("commercial."),
    let payloadKey = proof["payloadKey"] as? String, payloadKey == "owner-finance-" + command.id,
    let digest = proof["payloadSHA256"] as? String, digest.count == 64,
    step.object.isEmpty, String(data: step.body, encoding: .utf8) == "{}",
    proof["confirmation"] == nil else { throw StaffAPIError.invalid }
  let op = String(operation.dropFirst("commercial.".count))
  guard command.permission == (try ownerPermission(op)) else { throw StaffAPIError.invalid }
  let target = proof["target"] as? String
  let suffix: String
  switch op {
  case "cost.create": suffix = "/costs"
  case "cost.correct": suffix = "/costs/" + (target ?? "") + "/corrections"
  case "cost-category.create": suffix = "/cost-categories"
  case "cost-center.create": suffix = "/cost-centers"
  case "recurring-cost.create": suffix = "/recurring-costs"
  case "recurring-cost.materialize": suffix = "/recurring-costs/materialize"
  case "recurring-cost.status": suffix = "/recurring-costs/" + (target ?? "") + "/status"
  case "compensation-rule.create": suffix = "/compensation-rules"
  case "payroll-run.create": suffix = "/payroll-runs"
  default: suffix = "/payroll-runs/" + (target ?? "") + "/" + op.components(separatedBy: ".")[1]
  }
  guard step.path == ownerFinanceRoot + suffix, target == nil || UUID(uuidString: target!) != nil else { throw StaffAPIError.invalid }
  if ["payroll-run.approve", "payroll-run.post", "payroll-run.void", "recurring-cost.status"].contains(op) {
    guard target != nil, try ownerInteger(proof["version"]) > 0 else { throw StaffAPIError.invalid }
  }
  if op == "cost.correct", target == nil { throw StaffAPIError.invalid }
  if op == "compensation-rule.create" {
    guard let expected = proof["compensation"] as? String,
      expected == "none" || UUID(uuidString: expected) != nil else { throw StaffAPIError.invalid }
  }
  let bytes = Data(try read(payloadKey).utf8)
  guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == digest,
    let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], !body.isEmpty else {
    throw CatalogError("原费用或工资安全载荷不一致，未发送")
  }
  if op == "payroll-run.create", let draft = body["draftRunId"] as? String {
    guard draft == target, try ownerInteger(body["expectedVersion"]) == ownerInteger(proof["version"]) else { throw StaffAPIError.invalid }
  }
  return body
}
func ownerFinanceHeaders(_ step: LiveCommand.Step) throws -> [String: String] {
  guard let proof = step.ownerFinanceProof else { throw StaffAPIError.invalid }
  var headers = [step.keyHeader: step.key]
  if let value = proof["version"] { headers["x-owner-version"] = String(try ownerInteger(value)) }
  if let compensation = proof["compensation"] as? String { headers["x-owner-compensation"] = compensation }
  return headers
}
func validateOwnerFinanceReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], try ownerInteger(meta["protocol"]) == 1,
    let replayed = meta["replayed"] as? NSNumber, CFGetTypeID(replayed) == CFBooleanGetTypeID(),
    let data = root["data"] as? [String: Any], let proof = step.ownerFinanceProof,
    let operation = proof["operation"] as? String, operation.hasPrefix("commercial."), data["operation"] as? String == operation,
    data["employeeId"] as? String == proof["employeeId"] as? String,
    data["requestKey"] as? String == step.key, let raw = data["result"] as? [String: Any]
  else { throw StaffAPIError.invalid }
  let result = try OwnerFinanceRow(raw)
  guard !result.text("publicId").isEmpty, try result.integer("aggregateVersion") > 0 else { throw StaffAPIError.invalid }
  let op = String(operation.dropFirst("commercial.".count))
  _ = try ownerPermission(op)
  let status: String
  switch op {
  case "payroll-run.create": status = "draft"
  case "payroll-run.approve": status = "approved"
  case "payroll-run.void": status = "voided"
  case "payroll-run.post": status = "posted"
  case "recurring-cost.materialize": status = "completed"
  case "recurring-cost.status": status = body["status"] as? String ?? ""
  case "cost.create", "cost.correct": status = "recorded"
  default: status = "active"
  }
  guard result.text("status") == status else { throw StaffAPIError.invalid }
  if ["payroll-run.approve", "payroll-run.post", "payroll-run.void", "recurring-cost.status"].contains(op) {
    guard result.id == proof["target"] as? String, try result.integer("aggregateVersion") > ownerInteger(proof["version"]) else { throw StaffAPIError.invalid }
  }
  if op == "payroll-run.create", let draft = body["draftRunId"] as? String {
    guard result.id == draft, try result.integer("aggregateVersion") > ownerInteger(body["expectedVersion"]) else { throw StaffAPIError.invalid }
  }
  if ["cost.create", "cost.correct"].contains(op) {
    guard try result.integer("netAmountMinor") == ownerInteger(body["netAmountMinor"]),
      try result.integer("taxAmountMinor") == ownerInteger(body["taxAmountMinor"]) else { throw StaffAPIError.invalid }
    if op == "cost.correct", result.text("correctsCostEntryId") != proof["target"] as? String { throw StaffAPIError.invalid }
  }
}
