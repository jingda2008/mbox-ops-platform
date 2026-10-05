import SwiftUI

struct NativeSettingsForm: Identifiable {
  let id = UUID()
  let operation: String
  let row: NativeManagementRow?
}
struct NativeSettingsView: View {
  let module: NativeManagementModule
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var section = ""
  @State private var editing: NativeSettingsForm?
  @State private var policyTarget: NativeManagementRow?
  @State private var policyEmployee = false
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var search = ""
  private var board: NativeManagementBoard? { model.nativeManagementBoard?.module == module ? model.nativeManagementBoard : nil }
  private var sections: [String: String] {
    switch module {
    case .staff: return ["employees": "员工账号", "roles": "岗位权限", "credentials": "门店口令"]
    case .tableConfiguration: return ["areas": "营业区域", "tables": "桌台配置"]
    case .publication:
      var result: [String: String] = [:]
      let permissions = board?.data["permissions"] as? [String] ?? []
      if permissions.contains(where: { $0.hasPrefix("customer.public-profile.") }) { result["profiles"] = "公开服务名" }
      if permissions.contains(where: { $0.hasPrefix("privacy.policy.") }) { result["policies"] = "隐私政策" }
      if permissions.contains("customer.experience.feature.manage") { result["contact"] = "联系门店" }
      return result
    default: return [:]
    }
  }
  private func can(_ operation: String) -> Bool {
    model.canUseNativeManagement && (try? nativeSettingsPermission(module, operation: operation)).map { model.identity?.allows($0) == true } == true
  }
  private func choose(_ operation: String, _ row: NativeManagementRow? = nil) { editing = .init(operation: operation, row: row) }
  private func clearSecrets() { editing = nil; policyTarget = nil; proposed = nil; confirmed = false }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.nativeManagementState).font(.caption)
          Button("重新读取原配置") { clearSecrets(); Task { await model.loadNativeManagement(module) } }
            .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
          if let board {
            if !sections.isEmpty {
              Picker("管理项目", selection: $section) { ForEach(sections.keys.sorted(), id: \.self) { Text(sections[$0] ?? "").tag($0) } }.pickerStyle(.menu)
              if section != "credentials" && section != "contact" { TextField("搜索名称或编号", text: $search).textFieldStyle(.roundedBorder) }
            }
            if module == .commercePolicy { commerce(board) }
            else if section == "contact" { contact(board) }
            else {
              createButtons
              ForEach(board.rows(section).filter { search.isEmpty || String(data: $0.bytes, encoding: .utf8)?.localizedCaseInsensitiveContains(search) == true }) { row in
                Card { settingsRow(row, board: board) }
              }
              if board.rows(section).isEmpty { Text("当前没有记录").foregroundStyle(.secondary) }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle(module.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clearSecrets(); dismiss() } } }
    }.privacySensitive(module == .staff || module == .publication)
      .task { await model.loadNativeManagement(module); section = sections.keys.sorted().first ?? "" }
      .onChange(of: model.workspaceVersion) { _, _ in clearSecrets(); dismiss() }
      .onChange(of: scenePhase) { _, phase in if phase != .active { clearSecrets() } }
      .sheet(item: $editing) { form in
        if let board { NativeSettingsFormView(form: form, board: board) { command in editing = nil; proposed = command; confirmed = false } }
      }
      .sheet(item: $policyTarget) { row in
        if let board { NativeStaffPolicyEditorView(board: board, row: row, employee: policyEmployee) { command in policyTarget = nil; proposed = command; confirmed = false } }
      }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 14) {
              Text(command.steps.first?.nativeManagementProof?["confirmation"] as? String ?? "请重新读取原配置")
              Toggle("已逐项核对原对象、变更内容与影响", isOn: $confirmed)
              Button("确认提交") { clearSecrets(); Task { await model.executeLive(command) } }
                .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canExecuteLive(command))
            }.padding(20)
          }.navigationTitle("核对门店配置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil; confirmed = false } } }
        }.privacySensitive()
      }
  }
  @ViewBuilder private var createButtons: some View {
    if module == .staff && section == "employees" { Button("新建员工") { choose("create") }.disabled(!can("create")) }
    if module == .staff && section == "credentials" {
      Text("口令不会显示在历史回执中。更换后旧口令验证的设备需要重新验证。").font(.caption)
      Button("更换门店口令") { choose("credential") }.disabled(!can("credential"))
    }
    if module == .tableConfiguration { Button(section == "areas" ? "新增区域" : "新增桌台") { choose(section == "areas" ? "area-create" : "table-create") }.disabled(!model.canUseNativeManagement) }
    if module == .publication && section == "profiles" && can("profile-draft") { Button("新建公开服务名草稿") { choose("profile-draft") } }
    if module == .publication && section == "policies" && can("privacy-draft") { Button("新建隐私政策草稿") { choose("privacy-draft") } }
  }
  @ViewBuilder private func settingsRow(_ row: NativeManagementRow, board: NativeManagementBoard) -> some View {
    switch module {
    case .staff:
      if section == "employees" {
        Text(row.text("displayName") + " · " + row.text("code")).font(.headline)
        Text((row.text("status") == "active" ? "在职可登录" : "已暂停") + " · " + row.strings("roleCodes").joined(separator: "、"))
        Button("启停账号") { choose("status", row) }.disabled(!can("status"))
        Button("重置PIN") { choose("pin", row) }.disabled(!can("pin"))
        Button("个人权限例外") { policyEmployee = true; policyTarget = row }.disabled(!can("deploy"))
      } else if section == "roles" {
        Text(row.text("name")).font(.headline); Text(row.text("memberCount") + "名员工 · " + row.text("code"))
        Button("权限、额度、数据范围与入口") { policyEmployee = false; policyTarget = row }.disabled(!can("deploy"))
      } else { Text("有效期 " + row.text("validFrom") + " 至 " + row.text("validUntil")); Text("营业日 " + row.text("businessDate")).font(.caption) }
    case .tableConfiguration:
      Text(row.text(section == "tables" ? "displayName" : "name") + " · " + row.text("code")).font(.headline)
      Text((section == "tables" ? nativeTableStates : nativeAreaStates)[row.text("status")] ?? "待核对")
      if section == "tables" {
        Text("容量 " + row.text("capacity") + "人 · " + (board.rows("areas").first { $0.id == row.text("areaId") }?.text("name") ?? "区域待核对"))
        if !(row.object["activeSessionId"] is NSNull) { Text("正在营业；原桌次结束后才能调整配置。").foregroundStyle(.secondary) }
      }
      Button("编辑原配置") { choose(section == "tables" ? "table-update" : "area-update", row) }.disabled(!model.canUseNativeManagement || (section == "tables" && !(row.object["activeSessionId"] is NSNull)))
    case .publication:
      let privacy = section == "policies", prefix = privacy ? "privacy" : "profile"
      Text(row.text(privacy ? "policyVersion" : "publicDisplayName")).font(.headline)
      Text(["draft": "草稿", "published": "已发布", "withdrawn": "已撤回"][row.text("status")] ?? "待核对")
      if privacy {
        Text(row.text("operatorName") + " · " + row.text("contact")).font(.caption)
        DisclosureGroup("阅读此版本全文") { Text(row.text("content")).textSelection(.enabled) }
      } else { Text(row.text("employeeDisplayName")) }
      if row.text("status") == "draft" {
        if can(prefix + "-draft") { Button("编辑草稿") { choose(prefix + "-draft", row) } }
        if can(prefix + "-publish") { Button("独立复核并发布") { choose(prefix + "-publish", row) } }
      } else if row.text("status") == "published" && can(prefix + "-withdraw") { Button("撤下此版本", role: .destructive) { choose(prefix + "-withdraw", row) } }
    default: EmptyView()
    }
  }
  @ViewBuilder private func commerce(_ board: NativeManagementBoard) -> some View {
    if let row = board.data["row"] as? [String: Any] {
      Card {
        Text("线上支付").font(.headline)
        Text((try? managementBool(row["onlinePaymentEnabled"])) == true ? "当前生效：开放" : "当前生效：关闭")
        Text((try? managementBool(row["providerConfigured"])) == true ? "后台已配置支付渠道；真实支付结果另行核验。" : "后台未配置可用支付渠道，不能开放新线上支付。")
        Button("调整线上支付开关") { choose("online-payment") }.disabled(!can("online-payment"))
      }
      Card {
        Text("新订单待付款保留时间：\((try? managementInt(row["paymentReservationMinutes"])) ?? 0)分钟")
        Button("调整保留时间") { choose("payment-reservation") }.disabled(!can("payment-reservation"))
      }
    }
  }
  @ViewBuilder private func contact(_ board: NativeManagementBoard) -> some View {
    let data = board.data["contact"] as? [String: Any] ?? [:], details = data["contact"] as? [String: Any] ?? [:]
    Card {
      Text("门店公开联系信息").font(.headline)
      Text(["disabled": "关闭", "pilot": "试点", "enabled": "开放"][data["rolloutState"] as? String ?? ""] ?? "待设置")
      Text((details["phoneLabel"] as? String ?? "") + " " + (details["phone"] as? String ?? ""))
      Text(details["wecomName"] as? String ?? "")
      Button("修改联系信息") { choose("contact") }.disabled(!can("contact"))
    }
  }
}
