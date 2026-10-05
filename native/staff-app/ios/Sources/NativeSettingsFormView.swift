import SwiftUI

struct NativeSettingsFormView: View {
  let form: NativeSettingsForm
  let board: NativeManagementBoard
  let proposed: (LiveCommand) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: String]
  @State private var notice = ""
  @State private var starts = Date()
  @State private var ends = Date().addingTimeInterval(86400)
  @State private var media = false
  init(form: NativeSettingsForm, board: NativeManagementBoard, proposed: @escaping (LiveCommand) -> Void) {
    self.form = form; self.board = board; self.proposed = proposed
    var values: [String: String] = ["status": board.module == .tableConfiguration && form.operation.hasPrefix("table") ? "available" : "active",
      "areaType": "indoor", "sortOrder": "0", "capacity": "4", "minimumSpendMinor": "", "reason": "", "rolloutState": "disabled",
      "phoneLabel": "门店电话", "wecomName": "门店客服", "enabled": "false", "paymentReservationMinutes": "15"]
    if let row = form.row {
      for key in row.object.keys { values[key] = row.text(key) }
      if let amount = row.integer("minimumSpendMinor") { values["minimumSpendMinor"] = ownerMinorText(amount) }
    }
    if let policy = board.data["row"] as? [String: Any] {
      values["enabled"] = ((try? managementBool(policy["policyOnlinePaymentEnabled"])) ?? false) ? "false" : "true"
      values["paymentReservationMinutes"] = String((try? managementInt(policy["paymentReservationMinutes"])) ?? 15)
    }
    if form.operation == "contact", let contact = board.data["contact"] as? [String: Any] {
      values["rolloutState"] = contact["rolloutState"] as? String ?? "disabled"
      for (key, value) in contact["contact"] as? [String: Any] ?? [:] { values[key] = value as? String ?? "" }
    }
    _fields = State(initialValue: values)
  }
  private func binding(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func field(_ label: String, _ key: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      TextField(label, text: binding(key), axis: .vertical).autocorrectionDisabled().accessibilityLabel(label)
    }
  }
  private func picker(_ label: String, _ key: String, _ options: [String: String]) -> some View {
    Picker(label, selection: binding(key)) { ForEach(options.keys.sorted(), id: \.self) { Text(options[$0] ?? "").tag($0) } }.pickerStyle(.menu)
  }
  private func choices(_ key: String, label: String) -> [String: String] {
    ["": "请选择"].merging(Dictionary(uniqueKeysWithValues: board.rows(key).map { ($0.id, $0.text(label)) })) { _, new in new }
  }
  var body: some View {
    NavigationStack {
      Form {
        if let row = form.row { Text(row.text("displayName").isEmpty ? row.text("name").isEmpty ? row.text("policyVersion").isEmpty ? row.text("publicDisplayName") : row.text("policyVersion") : row.text("name") : row.text("displayName")).font(.headline) }
        switch board.module {
        case .staff: staffFields
        case .tableConfiguration: tableFields
        case .commercePolicy: commerceFields
        case .publication: publicationFields
        default: EmptyView()
        }
        field("操作原因", "reason")
        if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
        Button("下一步 · 核对修改") {
          do {
            if form.operation == "credential" {
              fields["validFrom"] = ISO8601DateFormatter().string(from: starts)
              fields["validUntil"] = ISO8601DateFormatter().string(from: ends)
            }
            proposed(try model.prepareNativeManagement(operation: form.operation, fields: fields, rowID: form.row?.id))
          } catch { notice = error.localizedDescription }
        }.disabled(!model.canUseNativeManagement)
      }.navigationTitle(board.module.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.privacySensitive(board.module == .staff || board.module == .publication)
      .onChange(of: model.workspaceVersion) { _, _ in fields = [:]; dismiss() }
      .sheet(isPresented: $media) { NativeManagementMediaPickerView(purpose: "support_contact") { url in fields["wecomQrImageUrl"] = url; media = false } }
  }
  @ViewBuilder private var staffFields: some View {
    if form.operation == "create" {
      field("员工账号", "employeeCode").textInputAutocapitalization(.never)
      field("员工姓名", "displayName")
      picker("初始岗位", "roleId", ["": "请选择"].merging(Dictionary(uniqueKeysWithValues: board.rows("roles").filter { $0.text("status") == "active" }.map { ($0.id, $0.text("name")) })) { _, new in new })
    }
    if form.operation == "status" { picker("账号状态", "status", ["active": "启用", "suspended": "暂停并禁止登录"]) }
    else {
      SecureField(form.operation == "credential" ? "新门店口令（6—128位）" : "4位数字PIN", text: binding(form.operation == "credential" ? "credential" : "pin"))
      SecureField("再次输入", text: binding("repeatSecret"))
    }
    if form.operation == "pin" { Text("重置后该员工的已有登录全部失效，须使用新PIN重新登录。") }
    if form.operation == "credential" {
      DatePicker("生效时间", selection: $starts)
      DatePicker("失效时间", selection: $ends)
      Text("口令仅用于本次安全原请求，不显示在历史记录。旧口令验证的设备须重新验证。")
    }
  }
  @ViewBuilder private var tableFields: some View {
    let table = form.operation.hasPrefix("table")
    if table || form.operation.hasSuffix("create") { field("编号", "code").textInputAutocapitalization(.never) }
    field("名称", table ? "displayName" : "name")
    if table {
      picker("营业区域", "areaId", choices("areas", label: "name"))
      field("容量（1—200人）", "capacity").keyboardType(.numberPad)
      field("最低消费（元，留空不设置）", "minimumSpendMinor").keyboardType(.decimalPad)
    } else {
      picker("区域类型", "areaType", nativeAreaTypes)
      field("排序（-100000—100000）", "sortOrder").keyboardType(.numbersAndPunctuation)
    }
    picker("状态", "status", table ? nativeTableStates : nativeAreaStates)
    Text("有营业中桌次时不能修改桌台配置；区域暂停或停用前须结束区域内原桌次。")
  }
  @ViewBuilder private var commerceFields: some View {
    if form.operation == "online-payment" {
      picker("新线上支付", "enabled", ["true": "开放", "false": "关闭"])
      Text("关闭只阻止新线上支付；原有在途支付、回调、查单、退款和对账继续处理。")
    } else {
      picker("新订单待付款库存保留", "paymentReservationMinutes", Dictionary(uniqueKeysWithValues: (2...30).map { (String($0), "\($0)分钟") }))
      Text("新时限只影响后续新订单，不改写在途订单原截止时间。")
    }
  }
  @ViewBuilder private var publicationFields: some View {
    let op = form.operation
    if op == "profile-draft" {
      picker("服务员工", "employeeId", choices("employees", label: "displayName"))
      field("顾客可见服务名", "publicDisplayName")
      Text("保存为草稿；所属员工与草拟人均不能自行发布。")
    }
    if op == "privacy-draft" {
      field("政策版本编号", "policyVersion")
      field("运营主体", "operatorName"); field("联系渠道", "contact")
      field("数据保留规则版本", "dataRetentionPolicyVersion"); field("第三方服务清单版本", "thirdPartyRegisterVersion")
      Text("已批准的政策正文（80—50000字）").font(.caption)
      TextEditor(text: binding("content")).frame(minHeight: 220)
      Text("草稿不会向顾客发布。已发布内容不能改写；更正须新版本及独立批准。")
    }
    if op.hasSuffix("publish") {
      Text("发布后立即替换当前版本。请先核对原全文与真实批准材料。")
      if op == "privacy-publish" { field("实际法务或运营批准人", "approvedBy") }
      field("真实批准材料编号（8—240字）", "approvalReference")
    }
    if op.hasSuffix("withdraw") { Text("撤下后顾客不再看到该版本。撤下隐私政策不会自动回退到其他送审稿。") }
    if op == "contact" {
      picker("顾客入口状态", "rolloutState", ["disabled": "关闭", "pilot": "试点", "enabled": "开放"])
      field("联系电话", "phone").keyboardType(.phonePad)
      field("电话名称", "phoneLabel"); field("企业微信名称", "wecomName")
      if fields["wecomQrImageUrl"]?.isEmpty == false {
        Text("已选择图片库二维码")
        Button("移除二维码", role: .destructive) { fields["wecomQrImageUrl"] = "" }
      }
      Button("从图片库选择二维码") { media = true }
    }
  }
}
