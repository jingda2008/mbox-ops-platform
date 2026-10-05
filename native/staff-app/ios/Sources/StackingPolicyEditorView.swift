import SwiftUI
struct StackingPolicyEditorView: View {
  @EnvironmentObject var model: AppModel
  let row: CouponPolicyRecord?
  let close: () -> Void
  let save: ([String: Any]) -> Void
  @State private var draft: StackingPolicyDraft
  @State private var error = ""
  init(row: CouponPolicyRecord?, close: @escaping () -> Void, save: @escaping ([String: Any]) -> Void) {
    self.row = row; self.close = close; self.save = save; _draft = State(initialValue: StackingPolicyDraft(row: row))
  }
  private func field(_ key: String) -> Binding<String> { Binding(get: { draft.fields[key] ?? "" }, set: { draft.fields[key] = $0 }) }
  private func input(_ key: String, _ title: String) -> some View { VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption); TextField(title, text: field(key)).textFieldStyle(.roundedBorder) } }
  private var rules: some View {
    VStack(alignment: .leading, spacing: 12) {
      input("code", "规则编号（2—40位大写字母、数字、下划线）")
      ForEach(stackingSwitches, id: \.0) { item in Toggle(item.1, isOn: Binding(get: { draft.switches[item.0] ?? false }, set: { draft.switches[item.0] = $0 })) }
      input("maxCoupons", "最多使用优惠券张数（1—10）")
      Picker("优惠计算顺序", selection: field("order")) {
        ForEach(stackingOrders, id: \.self) { order in Text(order.map { stackingStages[$0]! }.joined(separator: " → ")).tag(order.joined(separator: ",")) }
      }.pickerStyle(.menu)
      input("maximumDiscountMinor", "总优惠上限（元，留空不额外限制）")
      input("minimumPayableMinor", "最低实付（元）")
      Text("固定兑换价或免费承诺与最低实付冲突时会拒绝核价。已发券继续使用发放时的规则版本。").font(.caption)
      input("reason", "保存原因（2至500字）")
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if model.identity?.allows("loyalty.configuration.edit") == true {
        Button("核对并保存新草稿") { do { save(try draft.save(row: row)); error = "" } catch { self.error = error.localizedDescription } }
          .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseCouponPolicy)
      }
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Card { Text(row == nil ? "新叠加规则草稿" : "读取第" + row!.text("version") + "版，修订另建新版本").font(.headline); Button("返回列表", action: close); rules }
      if model.identity?.allows("loyalty.configuration.preview") == true { StackingScenarioView(draft: draft) }
    }
  }
}
private struct StackingScenarioView: View {
  @EnvironmentObject var model: AppModel
  let draft: StackingPolicyDraft
  @State private var units = [StackingUnitDraft()]
  @State private var effects: [StackingEffectDraft] = []
  @State private var preview: StackingPolicyPreview?
  @State private var error = ""
  @State private var generation = 0
  @State private var loading = false
  private func invalidate() { generation += 1; preview = nil }
  private func calculate() {
    guard !loading else { return }
    do {
      let body: [String: Any] = ["policy": try draft.policy(), "scenario": try stackingScenario(units: units, effects: effects)], ticket = generation
      loading = true
      Task {
        defer { loading = false }
        do {
          let bytes = try await model.readCouponPolicyPreview(kind: .stacking, body: body)
          guard generation == ticket, let actor = model.identity else { return }
          preview = try StackingPolicyPreview(data: bytes, actor: actor, body: body); error = ""
        } catch { if generation == ticket { preview = nil; self.error = error.localizedDescription } }
      }
    } catch { preview = nil; self.error = error.localizedDescription }
  }
  private var unitInputs: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach($units) { $unit in
        StackingUnitFields(unit: $unit, position: units.firstIndex { $0.id == unit.id } ?? 0, canRemove: units.count > 1) { units.removeAll { $0.id == unit.id } }
      }
      Button("添加商品份次（\(units.count)/100）") { units.append(StackingUnitDraft()) }.disabled(units.count >= 100)
    }
  }
  private var effectInputs: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach($effects) { $effect in
        StackingEffectFields(effect: $effect, units: units, position: effects.firstIndex { $0.id == effect.id } ?? 0) { effects.removeAll { $0.id == effect.id } }
      }
      Button("添加模拟优惠（\(effects.count)/20）") { effects.append(StackingEffectDraft()) }.disabled(effects.count >= 20)
      Text("同类优惠按上方顺序计算；改变顺序可能改变结果。会员价和积分各最多一项。").font(.caption)
    }
  }
  @ViewBuilder private var result: some View {
    if let preview {
      Card {
        Text("模拟应付 " + preview.money("payableMinor") + " · 优惠 " + preview.money("discountMinor")).font(.headline)
        Text("原价 " + preview.money("subtotalMinor") + " · 成本 " + preview.money("costMinor") + " · 模拟毛利 " + preview.money("grossProfitMinor"))
        ForEach(Array((preview.object["steps"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { index, step in
          Text("第\(index + 1)步 " + (stackingStages[membershipText(step["stage"])] ?? "待核对") + "：减免 ¥" + walletMoneyText((try? walletInteger(step["discountMinor"])) ?? 0) + "，剩余 ¥" + walletMoneyText((try? walletInteger(step["payableMinor"])) ?? 0))
        }
        ForEach(Array((preview.object["units"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, row in
          let index = units.firstIndex { $0.id == row["id"] as? String } ?? 0
          Text("商品第\(index + 1)份应付 ¥" + walletMoneyText((try? walletInteger(row["payableMinor"])) ?? 0))
        }
      }
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Card {
        Text("模拟报价，不修改订单").font(.headline)
        Text("每行代表一份可独立退款的商品。金额为人工模拟值，真实下单由后台重新核价。成本留空表示未知，不按零估算利润。").font(.caption)
        unitInputs; effectInputs
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button(loading ? "正在试算" : "试算此规则", action: calculate).buttonStyle(Primary(tone: .secondary, symbol: "sum")).disabled(loading || model.busy || model.heartbeatBusy)
      }
      result
    }.onChange(of: draft) { _, _ in invalidate() }.onChange(of: units) { _, _ in invalidate() }.onChange(of: effects) { _, _ in invalidate() }
  }
}
private struct StackingUnitFields: View {
  @Binding var unit: StackingUnitDraft
  let position: Int
  let canRemove: Bool
  let remove: () -> Void
  var body: some View {
    DisclosureGroup("模拟商品第\(position + 1)份") {
      VStack(alignment: .leading, spacing: 12) {
        TextField("原价（元）", text: $unit.amount).textFieldStyle(.roundedBorder)
        TextField("成本（元，可留空）", text: $unit.cost).textFieldStyle(.roundedBorder)
        Toggle("套餐价商品", isOn: $unit.bundle); Toggle("升级套餐", isOn: $unit.upgraded)
        if canRemove { Button("删除此份；相关优惠需重新选择份次", role: .destructive, action: remove) }
      }.padding(.vertical, 8)
    }
  }
}
private struct StackingEffectFields: View {
  @Binding var effect: StackingEffectDraft
  let units: [StackingUnitDraft]
  let position: Int
  let remove: () -> Void
  var body: some View {
    DisclosureGroup("第\(position + 1)项优惠 · " + (stackingStages[effect.stage] ?? "待核对")) {
      VStack(alignment: .leading, spacing: 12) {
        Picker("优惠来源", selection: $effect.stage) { ForEach(["member", "coupon", "points"], id: \.self) { Text(stackingStages[$0]!).tag($0) } }.pickerStyle(.menu)
        Picker("优惠方式", selection: $effect.kind) { ForEach(stackingKinds, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu)
        if effect.kind != "free" { TextField(effect.kind == "rate" ? "实付比例（%，80表示八折）" : "金额（元）", text: $effect.value).textFieldStyle(.roundedBorder) }
        TextField("本步骤适用金额门槛（元）", text: $effect.minimumSpend).textFieldStyle(.roundedBorder)
        Text("适用商品份次（免费或固定价只能一份）").font(.caption)
        ForEach(Array(units.enumerated()), id: \.element.id) { index, unit in
          Toggle("第\(index + 1)份 · ¥" + (unit.amount.isEmpty ? "未填写" : unit.amount), isOn: Binding(get: { effect.unitIDs.contains(unit.id) }, set: { if $0 { effect.unitIDs.insert(unit.id) } else { effect.unitIDs.remove(unit.id) } }))
        }
        if !effect.unitIDs.isSubset(of: Set(units.map(\.id))) { Button("清除已删除商品的选择") { effect.unitIDs.formIntersection(Set(units.map(\.id))) } }
        Button("移除此优惠", role: .destructive, action: remove)
      }.padding(.vertical, 8)
    }
  }
}
