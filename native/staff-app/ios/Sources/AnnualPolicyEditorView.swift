import SwiftUI
func annualInput(_ label: String, _ text: Binding<String>) -> some View {
  VStack(alignment: .leading, spacing: 4) { Text(label).font(.caption).foregroundStyle(.secondary); TextField(label, text: text, axis: .vertical).textFieldStyle(.roundedBorder).autocorrectionDisabled() }
}
private struct AnnualDraftRule: Identifiable { let id = UUID(); var value: [String: Any] }
private struct AnnualPickerTarget: Identifiable { let id = UUID(); let kind: String; let ruleID: UUID }
struct AnnualPolicyEditorView: View {
  @EnvironmentObject var model: AppModel
  let code: String
  let original: AnnualPolicyRecord?
  let close: () -> Void
  let save: ([String: Any]) -> Void
  @State private var rules: [AnnualDraftRule]
  @State private var timezone: String
  @State private var reason = ""
  @State private var error = ""
  @State private var picker: AnnualPickerTarget?
  init(code: String, original: AnnualPolicyRecord?, close: @escaping () -> Void, save: @escaping ([String: Any]) -> Void) {
    self.code = code; self.original = original; self.close = close; self.save = save
    _rules = State(initialValue: (original?.rules ?? [newAnnualRule()]).map { AnnualDraftRule(value: $0) })
    _timezone = State(initialValue: original?.text("timezone") ?? "Asia/Shanghai")
  }
  private func text(_ id: UUID, _ key: String) -> Binding<String> {
    Binding(get: { membershipText(rules.first { $0.id == id }?.value[key]) }, set: { if let i = rules.firstIndex(where: { $0.id == id }) { rules[i].value[key] = $0 } })
  }
  private func bool(_ id: UUID, _ key: String) -> Binding<Bool> {
    Binding(get: { rules.first { $0.id == id }?.value[key] as? Bool ?? false }, set: { if let i = rules.firstIndex(where: { $0.id == id }) { rules[i].value[key] = $0 } })
  }
  private func kind(_ id: UUID) -> Binding<String> {
    Binding(get: { rules.first { $0.id == id }?.value["ruleKind"] as? String ?? "birthday" }, set: { value in
      guard let i = rules.firstIndex(where: { $0.id == id }) else { return }
      rules[i].value["ruleKind"] = value; rules[i].value["feb29Policy"] = value == "birthday" ? "feb28" : NSNull()
      rules[i].value["reservationHoldMinutes"] = value == "priority_seating" ? 15 : NSNull(); rules[i].value["redemptionHoldMinutes"] = value == "daily_snack" ? 15 : NSNull()
      if ["birthday", "festival"].contains(value) { rules[i].value["stackGroup"] = "festival_gift" }
      if value == "priority_seating" { rules[i].value["onSiteOnly"] = false; rules[i].value["requiresTableSession"] = false; rules[i].value["inventoryRequirement"] = "not_applicable"; rules[i].value["substitutes"] = [[String: Any]](); rules[i].value["stackGroup"] = "priority_seating" }
      if value == "daily_snack" {
        for (k, v) in ["onSiteOnly": true, "requiresTableSession": true, "alcoholHandling": "not_applicable", "validityDays": 1, "windowBeforeDays": 0, "windowAfterDays": 0, "inventoryRequirement": "strict_recipe", "stackGroup": "daily_snack"] as [String: Any] { rules[i].value[k] = v }
      }
    })
  }
  private func choice(_ label: String, _ selection: Binding<String>, _ values: [(String, String)]) -> some View {
    VStack(alignment: .leading, spacing: 4) { Text(label).font(.caption).foregroundStyle(.secondary); Picker(label, selection: selection) { ForEach(values, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu) }
  }
  private func substituteText(_ id: UUID, _ productID: String, _ key: String) -> Binding<String> {
    Binding(get: { let list = rules.first { $0.id == id }?.value["substitutes"] as? [[String: Any]] ?? []; return membershipText(list.first { $0["productId"] as? String == productID }?[key]) }, set: { value in
      guard let i = rules.firstIndex(where: { $0.id == id }), var list = rules[i].value["substitutes"] as? [[String: Any]], let j = list.firstIndex(where: { $0["productId"] as? String == productID }) else { return }; list[j][key] = value; rules[i].value["substitutes"] = list
    })
  }
  private func substitutes(_ rule: AnnualDraftRule) -> some View {
    let list = rule.value["substitutes"] as? [[String: Any]] ?? []
    return VStack(alignment: .leading, spacing: 10) {
      Text("替代商品（最多20种，均需满足配方与库存条件）").font(.headline)
      ForEach(Array(list.enumerated()), id: \.offset) { _, sub in
        let productID = membershipText(sub["productId"])
        Text(sub["productName"] as? String ?? productID)
        annualInput("替代优先级（1至32767）", substituteText(rule.id, productID, "priority"))
        annualInput("替代依据（2至240字）", substituteText(rule.id, productID, "reason"))
        Button("移除此替代品") { if let i = rules.firstIndex(where: { $0.id == rule.id }) { rules[i].value["substitutes"] = list.filter { $0["productId"] as? String != productID } } }
      }
      Button("选择无酒精替代品") { picker = AnnualPickerTarget(kind: "products", ruleID: rule.id) }.disabled(list.count >= 20 || rule.value["ruleKind"] as? String == "priority_seating")
    }
  }
  private func ruleForm(_ rule: AnnualDraftRule) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      annualInput("规则编号（大写字母开头）", text(rule.id, "ruleCode"))
      annualInput("礼遇名称（2至120字）", text(rule.id, "title"))
      choice("礼遇类型", kind(rule.id), annualKinds)
      Text("切换类型后，请重新核对所有份数、日期、现场和库存条件。").font(.caption)
      choice("适用等级", text(rule.id, "eligibleTier"), annualTiers)
      Text("关联权益：" + (rule.value["benefitDefinitionName"] as? String ?? (membershipText(rule.value["benefitDefinitionId"]).isEmpty ? "尚未选择" : membershipText(rule.value["benefitDefinitionId"]))))
      Button("选择已启用权益定义") { picker = AnnualPickerTarget(kind: "definitions", ruleID: rule.id) }
      Text("优先订座须选预约优先权益；每日点心须选绑定商品的赠品权益。服务端仍将核对当前正式配置。").font(.caption)
      ForEach(annualBooleans, id: \.0) { key, label in Toggle(label, isOn: bool(rule.id, key)) }
      ForEach(annualNumeric, id: \.0) { key, label in annualInput(label, text(rule.id, key)) }
      choice("酒水处理", text(rule.id, "alcoholHandling"), annualAlcohol)
      choice("库存要求", text(rule.id, "inventoryRequirement"), annualInventory)
      choice("撤销规则", text(rule.id, "revocationPolicy"), annualRevocation)
      annualInput("叠加组（小写编号）", text(rule.id, "stackGroup"))
      if rule.value["ruleKind"] as? String == "birthday" { choice("2月29日生日处理", text(rule.id, "feb29Policy"), annualFeb) }
      if rule.value["ruleKind"] as? String == "priority_seating" { annualInput("优先订座保留分钟（5至30）", text(rule.id, "reservationHoldMinutes")) }
      if rule.value["ruleKind"] as? String == "daily_snack" { annualInput("每日点心暂留分钟（5至30）", text(rule.id, "redemptionHoldMinutes")) }
      substitutes(rule)
      if rules.count > 1 { Button("从此新草稿移除此规则", role: .destructive) { rules.removeAll { $0.id == rule.id } } }
    }
  }
  private func selected(_ option: AnnualPolicyRecord, target: AnnualPickerTarget) {
    guard let i = rules.firstIndex(where: { $0.id == target.ruleID }) else { return }
    if target.kind == "definitions" { rules[i].value["benefitDefinitionId"] = option.id; rules[i].value["benefitDefinitionName"] = option.text("name") }
    else { var list = rules[i].value["substitutes"] as? [[String: Any]] ?? []; if list.count < 20 && !list.contains(where: { $0["productId"] as? String == option.id }) { list.append(["productId": option.id, "productName": option.text("name"), "priority": list.count + 1, "reason": ""]); rules[i].value["substitutes"] = list } }
    picker = nil
  }
  var body: some View {
    Card {
      Text(code + " · 下一版完整草稿").font(.title3.bold())
      Text("复制会保留全部规则，包括停用项。此处只编辑新版本，不修改历史发放承诺。").font(.subheadline)
      annualInput("规则计算时区", $timezone)
      ForEach(rules) { rule in
        DisclosureGroup(membershipText(rule.value["title"]).isEmpty ? "未命名规则" : membershipText(rule.value["title"])) { ruleForm(rule) }
      }
      Button("添加规则（\(rules.count)/100）") { rules.append(AnnualDraftRule(value: newAnnualRule())) }.disabled(rules.count >= 100)
      annualInput("起草依据（2至500字）", $reason)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对全部规则") {
        do { _ = try annualRules(rules.map(\.value), requireEnabled: true); save(["policyCode": code, "timezone": timezone, "rules": rules.map(\.value), "reason": reason]); error = "" }
        catch { self.error = error.localizedDescription }
      }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseAnnualPolicies || model.annualPolicyBoard?.code != code)
      Button("返回并放弃未提交草稿", action: close)
    }.sheet(item: $picker) { target in AnnualOptionPickerView(kind: target.kind, select: { selected($0, target: target) }) }
  }
}
private struct AnnualOptionPickerView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let kind: String
  let select: (AnnualPolicyRecord) -> Void
  @State private var search = ""
  @State private var error = ""
  @State private var rows: [AnnualPolicyRecord] = []
  @State private var next: String?
  @State private var loading = false
  @State private var loaded = false
  private func load(cursor: String = "") {
    guard !loading else { return }; loading = true
    Task { defer { loading = false }
      do { let page = try await model.readAnnualPolicyOptions(kind: kind, search: search, cursor: cursor); rows = page.rows; next = page.nextCursor; loaded = true; error = "" }
      catch { self.error = error.localizedDescription }
    }
  }
  var body: some View {
    NavigationStack { ScrollView { LazyVStack(alignment: .leading, spacing: 12) {
      annualInput("名称包含（最多80字）", $search).disabled(loading).onChange(of: search) { _, _ in rows = []; next = nil; loaded = false }
      Button("查询 / 刷新") { load() }.disabled(loading)
      if loading { ProgressView("读取当前可用记录") }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if loaded && rows.isEmpty { Text("当前查询没有符合条件的记录。") }
      ForEach(rows) { row in Button { select(row) } label: {
        VStack(alignment: .leading, spacing: 4) {
          Text(row.text("name"))
          if kind == "definitions" { Text(["reservation_priority": "预约优先", "gift_product": "赠品", "service_experience": "服务体验", "discount": "折扣"][row.text("benefitKind")] ?? "其他正式权益").font(.caption) }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.buttonStyle(.bordered).disabled(loading) }
      if let next { Button("下一页") { load(cursor: next) }.disabled(loading) }
    }.padding(16) }.background(paper).navigationTitle(kind == "definitions" ? "选择权益定义" : "选择无酒精替代品").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } } }.tint(ink).task { load() }
  }
}
