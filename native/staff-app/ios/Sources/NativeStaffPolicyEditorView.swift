import SwiftUI

struct NativeStaffPolicyEditorView: View {
  let board: NativeManagementBoard
  let row: NativeManagementRow
  let employee: Bool
  let proposed: (LiveCommand) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var kind = "role_permission"
  @State private var code = ""
  @State private var search = ""
  @State private var changes: [[String: Any]] = []
  @State private var labels: [String] = []
  @State private var reason = ""
  @State private var notice = ""
  private var definitions: [NativeManagementRow] {
    if kind == "role_permission" || kind == "employee_override" { return board.rows("permissions") }
    return board.rows("configurationDefinitions").filter { $0.text("kind") == String(kind.dropFirst(5)) }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text(row.text(employee ? "displayName" : "name")).font(.headline)
          if !employee {
            Picker("配置类型", selection: $kind) {
              ForEach(nativeStaffChangeKinds.keys.filter { $0 != "employee_override" }.sorted(), id: \.self) { Text(nativeStaffChangeKinds[$0] ?? "").tag($0) }
            }.pickerStyle(.menu)
          }
          TextField("搜索配置名称", text: $search).textFieldStyle(.roundedBorder)
          Picker("选择配置项", selection: $code) {
            Text("请选择").tag("")
            ForEach(definitions.filter { search.isEmpty || $0.text("name").localizedCaseInsensitiveContains(search) || $0.text("label").localizedCaseInsensitiveContains(search) || $0.text("code").contains(search) }) { definition in
              Text(definition.text("label").isEmpty ? definition.text("name") : definition.text("label")).tag(definition.text("code"))
            }
          }.pickerStyle(.menu)
          if let definition = definitions.first(where: { $0.text("code") == code }) {
            NativeStaffPolicyFieldsView(board: board, row: row, definition: definition, kind: kind) { change, label in
              let key = ["permissionCode", "scopeKey", "approvalCode", "navigationCode"].first { change[$0] != nil }!
              if let index = changes.firstIndex(where: { $0["kind"] as? String == kind && $0[key] as? String == change[key] as? String }) {
                changes[index] = change; labels[index] = label
              } else { changes.append(change); labels.append(label) }
              notice = "已加入待发布清单"
            }.id(kind + ":" + code)
          }
          if !changes.isEmpty {
            Text("待发布\(changes.count)项").font(.headline)
            ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
              VStack(alignment: .leading) {
                Text(label)
                Button("移除此项", role: .destructive) { changes.remove(at: index); labels.remove(at: index) }
              }
            }
          }
          TextField("发布原因（2—200字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
          Text("权限与入口分别控制；隐藏入口不会撤销权限。发布使用当前原版本；管理员并发改动时须重新读取。")
          if !notice.isEmpty { Text(notice).font(.caption) }
          Button("核对并发布全部修改") {
            do {
              guard let encoded = String(data: try JSONSerialization.data(withJSONObject: changes, options: .sortedKeys), encoding: .utf8) else { throw StaffAPIError.invalid }
              proposed(try model.prepareNativeManagement(operation: "deploy", fields: ["changes": encoded, "changeSummary": labels.joined(separator: "\n"), "reason": reason]))
            } catch { notice = error.localizedDescription }
          }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseNativeManagement || changes.isEmpty)
        }.padding(16)
      }.navigationTitle("岗位与个人权限").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.task { if employee { kind = "employee_override" } }
      .onChange(of: kind) { _, _ in code = "" }
      .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
struct NativeStaffPolicyFieldsView: View {
  let board: NativeManagementBoard
  let row: NativeManagementRow
  let definition: NativeManagementRow
  let kind: String
  let added: ([String: Any], String) -> Void
  @State private var fields: [String: String]
  @State private var values: Set<String>
  @State private var error = ""
  private var config: [String: Any] { definition.object["config"] as? [String: Any] ?? [:] }
  init(board: NativeManagementBoard, row: NativeManagementRow, definition: NativeManagementRow, kind: String, added: @escaping ([String: Any], String) -> Void) {
    self.board = board; self.row = row; self.definition = definition; self.kind = kind; self.added = added
    let config = definition.object["config"] as? [String: Any] ?? [:], code = definition.text("code")
    let collection = ["employee_override": "overrides", "role_approval_limit": "approvalLimits", "role_data_scope": "dataScopes", "role_navigation": "navigation"][kind] ?? ""
    let codeKey = kind == "employee_override" ? "permissionCode" : kind == "role_data_scope" ? "key" : "code"
    let current = (row.object[collection] as? [[String: Any]] ?? []).first { $0[codeKey] as? String == code }
    let enabled = kind == "role_permission" ? row.strings("permissionCodes").contains(code) : (try? managementBool(current?["enabled"])) ?? false
    var result = ["enabled": enabled ? "true" : "false", "effect": current?["effect"] as? String ?? "default",
      "amountMinor": "", "discountBasisPoints": "0", "label": current?["label"] as? String ?? definition.text("label"),
      "sortOrder": String((try? managementInt(current?["sortOrder"] ?? definition.object["sortOrder"])) ?? 100), "highFrequency": "false"]
    if let amount = try? managementInt(current?["amountMinor"]) { result["amountMinor"] = ownerMinorText(amount) }
    if let rules = current?["rules"] as? [String: Any] ?? config["defaultRules"] as? [String: Any], let discount = try? managementInt(rules["discountBasisPoints"]) { result["discountBasisPoints"] = String(discount) }
    if let display = current?["displayConfig"] as? [String: Any] { result["highFrequency"] = (try? managementBool(display["highFrequency"])) == true ? "true" : "false" }
    _fields = State(initialValue: result); _values = State(initialValue: Set(current?["value"] as? [String] ?? []))
  }
  private func value(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func toggle(_ key: String) -> Binding<Bool> { Binding(get: { fields[key] == "true" }, set: { fields[key] = $0 ? "true" : "false" }) }
  private var options: [(String, String)] {
    switch config["editor"] as? String {
    case "area_multi": return board.rows("areas").map { ($0.id, $0.text("name")) }
    case "employee_multi": return board.rows("employees").filter { $0.text("status") == "active" }.map { ($0.id, $0.text("displayName")) }
    default: return (config["options"] as? [String] ?? []).map { ($0, $0) }
    }
  }
  var body: some View {
    Card {
      Text(definition.text("description")).font(.caption)
      if kind == "employee_override" {
        Picker("个人授权", selection: value("effect")) { Text("遵循岗位").tag("default"); Text("额外允许").tag("grant"); Text("明确禁止").tag("deny") }.pickerStyle(.menu)
      } else { Toggle("启用此配置", isOn: toggle("enabled")) }
      if kind == "role_approval_limit" {
        TextField("单次上限（元；空白不设金额上限）", text: value("amountMinor")).keyboardType(.decimalPad)
        if (config["controls"] as? [String] ?? []).contains("discount_percent") { TextField("最高折扣基点（100基点=1%，0—10000）", text: value("discountBasisPoints")).keyboardType(.numberPad) }
        if (config["controls"] as? [String] ?? []).contains("second_actor") { Text("强制由不同员工复核，不可关闭。") }
      }
      if kind == "role_data_scope" && config["editor"] as? String != "boolean" {
        ForEach(options, id: \.0) { option in
          Toggle(option.1, isOn: Binding(get: { values.contains(option.0) }, set: { checked in if checked { values.insert(option.0) } else { values.remove(option.0) } }))
        }
      }
      if kind == "role_navigation" {
        TextField("入口名称（1—30字）", text: value("label"))
        TextField("排序（0—999）", text: value("sortOrder")).keyboardType(.numberPad)
        Toggle("手机高频入口（最多4个）", isOn: toggle("highFrequency"))
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("加入待发布清单") {
        do {
          fields["values"] = String(data: try JSONSerialization.data(withJSONObject: values.sorted()), encoding: .utf8)
          let change = try nativeStaffChange(board: board, targetID: row.id, kind: kind, code: definition.text("code"), fields: fields)
          var summary = (definition.text("label").isEmpty ? definition.text("name") : definition.text("label")) + "："
          if kind == "employee_override" { summary += ["default": "遵循岗位", "grant": "额外允许", "deny": "明确禁止"][fields["effect"] ?? ""] ?? "" }
          else { summary += fields["enabled"] == "true" ? "启用" : "停用" }
          if kind == "role_approval_limit" { summary += "，上限：" + ((fields["amountMinor"] ?? "").isEmpty ? "不设金额上限" : (fields["amountMinor"] ?? "") + "元") + "，折扣基点：" + (fields["discountBasisPoints"] ?? "0") }
          if kind == "role_navigation" { summary += "，" + (fields["label"] ?? "") + "，排序" + (fields["sortOrder"] ?? "") + (fields["highFrequency"] == "true" ? "，高频" : "，普通") }
          if kind == "role_data_scope" { summary += "，" + options.filter { values.contains($0.0) }.map(\.1).joined(separator: "、") }
          added(change, summary); error = ""
        } catch { self.error = error.localizedDescription }
      }
    }
  }
}
