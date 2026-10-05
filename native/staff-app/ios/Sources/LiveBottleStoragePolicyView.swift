import SwiftUI

struct BottleStoragePolicyView: View {
  @EnvironmentObject var model: AppModel
  let board: BottleStorageBoard, usable: Bool
  let propose: (String, [String: Any], BottleStorageRow?) -> Void
  @State private var policy: BottleStoragePolicy
  @State private var reminderDays: String
  @State private var reason = ""
  @State private var notice = ""
  @State private var editing: BottleStorageRow?
  @State private var code = ""
  @State private var name = ""
  @State private var days = 20
  @State private var sort = 0
  @State private var categoryActive = true
  init(board: BottleStorageBoard, usable: Bool, propose: @escaping (String, [String: Any], BottleStorageRow?) -> Void) {
    self.board = board; self.usable = usable; self.propose = propose
    _policy = State(initialValue: board.policy); _reminderDays = State(initialValue: board.policy.reminderDays.map(String.init).joined(separator: ","))
  }
  private var allowed: Bool { usable && model.identity?.allows("member.card.manage") == true }
  private func selection(_ key: String, values: Binding<[String]>) -> Binding<Bool> {
    Binding(get: { values.wrappedValue.contains(key) }, set: { yes in if yes { if !values.wrappedValue.contains(key) { values.wrappedValue.append(key) } } else { values.wrappedValue.removeAll { $0 == key } } })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Card {
        Text("存酒规则 · 版本 \(board.version)").font(.title3.bold())
        if !allowed { Text("当前只能查看规则，修改需要会员卡管理权限及可用原请求回执。").font(.subheadline) }
        Group {
          Toggle("启用新存酒", isOn: $policy.enabled)
          number("默认存期（1—3660天）", $policy.defaultDays)
          Toggle("允许部分取酒及部分再存", isOn: $policy.allowPartial)
          Toggle("允许再次寄存", isOn: $policy.allowRestorage)
          Toggle("再次寄存必须沿用原单", isOn: $policy.requireOriginalOrder)
          Picker("归档方式", selection: $policy.archiveMode) { Text("全部处理后自动归档").tag("automatic"); Text("手工核对归档").tag("manual") }
        }.disabled(!allowed)
        DisclosureGroup("验证码和到期提醒") {
          Group {
            number("验证码位数（4—8）", $policy.codeDigits)
            number("有效秒数（60—600）", $policy.codeTtlSeconds)
            number("重发间隔秒数（30—600）", $policy.resendSeconds)
            number("最多尝试次数（1—10）", $policy.maximumAttempts)
            Toggle("开启到期提醒", isOn: $policy.remindersEnabled)
            Picker("服务号", selection: Binding(get: { policy.serviceAccountId ?? "" }, set: { policy.serviceAccountId = $0.isEmpty ? nil : $0 })) {
              Text("未选择").tag(""); ForEach(board.accounts) { Text($0.text("name")).tag($0.id) }
            }
            TextField("提前提醒天数（英文逗号分隔，最多12个）", text: $reminderDays).textFieldStyle(.roundedBorder)
            number("北京时间发送分钟（960=16:00，1020=17:00）", $policy.sendMinute)
            TextField("提醒文字，可用 {expiry}", text: $policy.reminderText, axis: .vertical).textFieldStyle(.roundedBorder)
            Text("服务号配置可用、任务已登记和用户实际收到是不同环节；本页不证明提醒送达。").font(.caption)
          }.disabled(!allowed)
        }
        DisclosureGroup("编号、凭证及报表维度") {
          Group {
            TextField("编号模板：须包含 {date}{time}{member}{serial}", text: $policy.numberPattern).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
            TextField("打印标题", text: $policy.printTitle).textFieldStyle(.roundedBorder)
            ForEach([("category", "品类"), ("item", "物品"), ("quantity", "原存数量"), ("remaining", "剩余数量"), ("expiry", "到期时间"), ("location", "位置"), ("status", "状态"), ("source", "来源")], id: \.0) { key, label in Toggle("打印" + label, isOn: selection(key, values: $policy.printFields)) }
            TextField("打印页脚", text: $policy.printFooter, axis: .vertical).textFieldStyle(.roundedBorder)
            ForEach([("category", "品类"), ("status", "状态"), ("date", "日期")], id: \.0) { key, label in Toggle("报表维度：" + label, isOn: selection(key, values: $policy.reportDimensions)) }
          }.disabled(!allowed)
        }
        DisclosureGroup("自定义登记字段") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(policy.extraFieldDefinitions.indices, id: \.self) { index in
              VStack {
                TextField("字段编码：小写字母开头", text: $policy.extraFieldDefinitions[index].key).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
                TextField("字段名称", text: $policy.extraFieldDefinitions[index].label).textFieldStyle(.roundedBorder)
                Picker("类型", selection: $policy.extraFieldDefinitions[index].type) { Text("文字").tag("text"); Text("数值").tag("number"); Text("日期").tag("date") }
                Toggle("必填", isOn: $policy.extraFieldDefinitions[index].required)
                Button("移除此字段", role: .destructive) { policy.extraFieldDefinitions.remove(at: index) }
              }
            }
            Button("增加登记字段") { policy.extraFieldDefinitions.append(.init(key: "field_" + String(policy.extraFieldDefinitions.count + 1), label: "", type: "text", required: false)) }.disabled(policy.extraFieldDefinitions.count >= 20)
          }.disabled(!allowed)
        }
        TextField("规则变更原因（至少两字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).disabled(!allowed)
        Button("核对并保存全部规则") {
          do {
            let values = reminderDays.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard values.allSatisfy({ $0.range(of: "^[1-9][0-9]{0,3}$", options: .regularExpression) != nil }) else { throw CatalogError("提前天数须为英文逗号分隔的正整数") }
            policy.reminderDays = values.compactMap(Int.init); try policy.validate()
            propose("policy", ["policy": policy.object, "version": board.version, "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)], nil)
          } catch { notice = error.localizedDescription }
        }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!allowed)
        if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
      }
      Card {
        Text("存酒品类").font(.title3.bold())
        ForEach(board.categories) { row in
          HStack { Text(row.text("name") + " · " + row.text("default_days") + "天 · " + (row.flag("active") ? "启用" : "停用")); Spacer(); Button("编辑") { editing = row; code = row.text("code"); name = row.text("name"); days = Int(row.text("default_days")) ?? 20; sort = Int(row.text("sort_order")) ?? 0; categoryActive = row.flag("active") }.disabled(!allowed) }
        }
        Text(editing == nil ? "新增品类" : "编辑品类：" + (editing?.text("name") ?? "")).font(.headline)
        Group {
          TextField("品类编码", text: $code).textFieldStyle(.roundedBorder)
          TextField("品类名称", text: $name).textFieldStyle(.roundedBorder)
          number("默认存期（1—3660天）", $days); number("排序（0—10000）", $sort)
          Toggle("品类启用", isOn: $categoryActive)
        }.disabled(!allowed)
        Button("核对并保存品类") {
          var body: [String: Any] = ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "defaultDays": days, "active": categoryActive, "sortOrder": sort]
          if let editing { body["id"] = editing.id }; propose("category", body, editing)
        }.disabled(!allowed)
        if editing != nil { Button("改为新增品类") { editing = nil; code = ""; name = ""; days = 20; sort = 0; categoryActive = true } }
      }
    }
  }
  private func number(_ title: String, _ value: Binding<Int>) -> some View {
    VStack(alignment: .leading) { Text(title).font(.caption); TextField(title, value: value, format: .number.grouping(.never)).textFieldStyle(.roundedBorder).keyboardType(.numberPad) }
  }
}
struct BottleStorageReportView: View {
  @EnvironmentObject var model: AppModel
  let board: BottleStorageBoard, usable: Bool
  let propose: ([String: Any]) -> Void
  @State private var scope = "custody"
  @State private var member = ""
  @State private var category = ""
  @State private var from = ""
  @State private var to = ""
  @State private var rows: [BottleStorageRow] = []
  @State private var summary: [[String: Any]] = []
  @State private var filters: [String: Any]?
  @State private var offset: Int?
  @State private var reading = false
  @State private var generation = 0
  @State private var notice = ""
  private func load(offset: Int = 0) async {
    generation += 1; let ticket = generation; reading = true
    defer { if ticket == generation { reading = false } }
    do {
      var input = try bottleStorageDateFilters(member: member, from: from, to: to); input["scope"] = scope
      if !category.isEmpty { input["category"] = category.trimmingCharacters(in: .whitespacesAndNewlines) }
      if offset > 0, let filters { input = filters }
      let saved = input; input["offset"] = offset
      let result = try bottleData(await model.readBottleStorage("/report" + bottleStorageQuery(input, report: true)))
      guard ticket == generation, let list = result["items"] as? [[String: Any]], let sums = result["summary"] as? [[String: Any]] else { return }
      rows = try list.map(BottleStorageRow.init); summary = sums; filters = saved
      self.offset = result["nextOffset"] is NSNull ? nil : try bottleInteger(result["nextOffset"], max: 1_000_000)
      notice = "查询完成：当前页 \(rows.count) 笔"
    } catch { if ticket == generation { rows = []; summary = []; filters = nil; self.offset = nil; notice = "查询失败：" + error.localizedDescription } }
  }
  var body: some View {
    Card {
      Text("按范围查看寄存与消费").font(.title3.bold())
      Text("寄存登记价值不是营业收入；消费订单应付金额不是实收。消费品类筛选按命中品类的整张订单统计，不能作为该品类净销售额。").font(.subheadline)
      Picker("范围", selection: $scope) { Text("仅存酒").tag("custody"); if model.identity?.allows("order.history.all") == true { Text("仅消费").tag("sales"); Text("存酒与消费分列").tag("all") } }
      TextField("会员号（可留空）", text: $member).textFieldStyle(.roundedBorder)
      TextField("品类名称或编码（可留空）", text: $category).textFieldStyle(.roundedBorder)
      TextField("开始日期 YYYY-MM-DD", text: $from).textFieldStyle(.roundedBorder)
      TextField("截至日期 YYYY-MM-DD（含当日）", text: $to).textFieldStyle(.roundedBorder)
      Button(reading ? "正在查询…" : "查询当前范围") { Task { await load() } }.disabled(reading || !usable)
      if !notice.isEmpty { Text(notice).font(.subheadline) }
      ForEach(Array(summary.enumerated()), id: \.offset) { _, value in
        Text("\(bottleText(value, "type") == "custody" ? "存酒登记" : "消费应付") / \(bottleText(value, "currency"))：\(bottleText(value, "count"))笔，已登记金额 \(bottleStorageMinor(bottleText(value, "amount_minor"))) 元；未知金额 \(bottleText(value, "unknown_amount_count"))笔").font(.subheadline)
      }
      ForEach(rows) { row in
        VStack(alignment: .leading, spacing: 4) {
          Text(row.text("public_id") + " · " + row.text("member_no")).font(.headline)
          Text(row.text("item_name") + " · " + row.text("category"))
          Text(bottleDisplayTime(row.text("occurred_at")) + " · " + row.text("amount_basis") + " " + bottleStorageMinor(row.text("amount_minor")) + " " + row.text("currency")).font(.caption)
        }
      }
      if let offset { Button("下一页") { Task { await load(offset: offset) } }.disabled(reading || !usable) }
      if let filters, model.identity?.allows("bottle.custody.export") == true { Button("导出已查询范围") { propose(filters) }.disabled(reading || !usable) }
    }
  }
}
func bottleStorageMinor(_ text: String) -> String {
  guard let amount = Int64(text), amount >= 0 else { return "未登记" }
  return String(amount / 100) + "." + String(format: "%02d", amount % 100)
}
