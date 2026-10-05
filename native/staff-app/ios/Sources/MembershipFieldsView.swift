import SwiftUI
import CoreFoundation

func membershipRecordTime(_ value: String) -> String {
  guard let local = try? membershipLocal(value) else { return "时间待核对" }
  return local + "（北京）"
}

struct MembershipFieldsView: View {
  let content: [String: Any]
  let domain: String
  let references: [WalletRecord]
  let enabled: Bool
  let change: ([String: Any]) -> Void
  private func set(_ key: String, _ value: Any) { var next = content; next[key] = value; change(next) }
  private func textBinding(_ key: String) -> Binding<String> {
    Binding(get: { membershipText(content[key]) }, set: { set(key, $0) })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(content.keys.sorted().filter { !["domain", "publicId", "currency"].contains($0) }, id: \.self) { key in
        field(key, value: content[key]!)
      }
    }
  }
  @ViewBuilder private func field(_ key: String, value: Any) -> some View {
    let label = membershipFieldLabels[key] ?? membershipExtraLabels[key] ?? "规则内容"
    if key == "eligibleMemberLevels", let levels = value as? [String] {
      Text(label).font(.headline)
      ForEach(["member", "silver", "gold"], id: \.self) { tier in
        Toggle(membershipFieldChoices["eligibleTier"]?[tier] ?? tier, isOn: Binding(get: { levels.contains(tier) }, set: {
          set(key, $0 ? Array(Set(levels + [tier])).sorted() : levels.filter { $0 != tier })
        })).disabled(!enabled)
      }
    } else if let rows = value as? [[String: Any]] {
      Text("\(label) · \(rows.count)项").font(.headline)
      ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
        Foldout(title: "第\(index + 1)项 · " + (row["name"] as? String ?? row["ruleCode"] as? String ?? "待填写")) {
          AnyView(MembershipFieldsView(content: row, domain: domain, references: references, enabled: enabled) { replacement in
            var copy = rows; copy[index] = replacement; set(key, copy)
          })
          Button("移除第\(index + 1)项草稿", role: .destructive) { var copy = rows; copy.remove(at: index); set(key, copy) }.disabled(!enabled)
        }
      }
      if membershipDefaultItems[domain] != nil {
        Button("添加" + (key == "items" ? "兑换项" : "规则")) {
          if let item = try? newMembershipItem(domain) { set(key, rows + [item]) }
        }.buttonStyle(Primary(tone: .secondary, symbol: "plus")).disabled(!enabled || rows.count >= 200)
      }
    } else if let boolean = value as? NSNumber, CFGetTypeID(boolean) == CFBooleanGetTypeID() {
      Toggle(label, isOn: Binding(get: { boolean.boolValue }, set: { set(key, $0) })).disabled(!enabled)
    } else if membershipReferenceFields.contains(key) {
      let selected = membershipText(value), options = references.filter { $0.text("kind") == key }
      Picker(label, selection: textBinding(key)) {
        Text(key == "tierPolicyVersionId" ? "请选择等级规则" : "未关联").tag("")
        ForEach(options) { Text($0.text("name") + " · " + (membershipConfigStatuses[$0.text("status")] ?? ["active": "启用", "inactive": "停用", "open": "开放"][ $0.text("status")] ?? "请核对状态")).tag($0.id) }
        if !selected.isEmpty && !options.contains(where: { $0.id == selected }) { Text("原关联当前不可用，请核对").tag(selected) }
      }.pickerStyle(.menu).disabled(!enabled)
    } else if let choices = membershipFieldChoices[key] {
      Picker(label, selection: textBinding(key)) {
        ForEach(choices.keys.sorted(), id: \.self) { Text(choices[$0]!).tag($0) }
      }.pickerStyle(.menu).disabled(!enabled)
    } else {
      let suffix = ["availableFrom", "availableUntil"].contains(key) ? "（北京时间 YYYY-MM-DD HH:mm:ss）"
        : ["totalInventory", "dailyInventory", "memberLifetimeLimit"].contains(key) ? "（留空不限；库存0表示无库存）"
        : membershipNullableText.contains(key) || key == "expiryLeadDays" ? "（可留空）" : ""
      Text(label + suffix).font(.caption)
      if enabled {
        TextField(label, text: textBinding(key), axis: .vertical).textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
      } else { Text(membershipText(value).isEmpty ? "未设置" : membershipText(value)).textSelection(.enabled) }
    }
  }
}
