import SwiftUI

struct LiveBottleStorageView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var access = ""
  @State private var board: BottleStorageBoard?
  @State private var tab = "records"
  @State private var rows: [BottleStorageRow] = []
  @State private var summary = ""
  @State private var detail: BottleStorageDetail?
  @State private var nextCursor: String?
  @State private var filters: [String: Any] = [:]
  @State private var member = ""
  @State private var query = ""
  @State private var status = ""
  @State private var category = ""
  @State private var from = ""
  @State private var to = ""
  @State private var reading = false
  @State private var generation = 0
  @State private var notice = ""
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var refreshedReceiptKey = ""
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + bottleStoragePermissions.filter(actor.allows).joined(separator: ",")
  }
  private var active: Bool { access == accessKey && !access.isEmpty && model.identity?.allows("bottle.manage.all") == true }
  private var usable: Bool { active && !reading && !model.busy && !model.heartbeatBusy && board?.enabled == true }
  private func propose(_ operation: String, _ body: [String: Any], _ original: BottleStorageDetail? = nil, _ category: BottleStorageRow? = nil) {
    do {
      guard active, let board, let actor = model.identity else { throw StaffAPIError.invalid }
      proposed = try board.command(actor: actor, operation: operation, body: body, detail: original, category: category,
        confirmation: bottleStorageConfirmation(operation, body: body, detail: original))
      confirmed = false; notice = ""
    } catch { notice = error.localizedDescription }
  }
  private func reload(cursor: String? = nil) async {
    let stamp = accessKey; generation += 1; let ticket = generation
    reading = true; proposed = nil; detail = nil
    defer { if ticket == generation { reading = false } }
    do {
      guard active, let actor = model.identity else { throw StaffAPIError.invalid }
      var input = try bottleStorageDateFilters(member: member, from: from, to: to)
      if !query.isEmpty { input["query"] = query.trimmingCharacters(in: .whitespacesAndNewlines) }
      if !status.isEmpty { input["status"] = status }; if !category.isEmpty { input["categoryId"] = category }
      if cursor != nil { input = filters }
      let exportFilters = input; if let cursor { input["cursor"] = cursor }
      let path = try bottleStorageQuery(input)
      let policy = try await model.readBottleStorage("/policy")
      let capability = try await model.readBottleStorage("/native-capabilities")
      let result = try await model.readBottleStorage(path)
      let fresh = try BottleStorageBoard(policy: policy, capability: capability, actor: actor)
      let list = try bottleData(result)
      guard let items = list["items"] as? [[String: Any]], let rawSummary = list["summary"] as? [String: Any] else { throw StaffAPIError.invalid }
      let newRows = try items.map(BottleStorageRow.init)
      let next = list["nextCursor"] as? String; if let next { _ = try bottleUUID(next) }
      guard active, stamp == accessKey, ticket == generation else { return }
      board = fresh; rows = newRows; nextCursor = next; filters = exportFilters
      refreshedReceiptKey = model.bottleStorageReceipt?.requestKey ?? ""
      summary = "当前页 \(newRows.count) 笔；筛选范围共 " + bottleText(rawSummary, "count") + " 笔。登记价值不等于营业收入。"
      notice = fresh.enabled ? "" : "此服务未启用原请求回执，当前仅可查看。"
    } catch { if active && stamp == accessKey && ticket == generation { rows = []; board = nil; nextCursor = nil; notice = "读取失败：" + error.localizedDescription } }
  }
  private func loadDetail(_ id: String) async {
    let stamp = accessKey; generation += 1; let ticket = generation; reading = true; detail = nil; proposed = nil
    defer { if ticket == generation { reading = false } }
    do {
      let next = try BottleStorageDetail(bottleData(await model.readBottleStorage("/" + bottleUUID(id))))
      guard active, stamp == accessKey, ticket == generation else { return }; detail = next
    } catch { if active && stamp == accessKey && ticket == generation { notice = "存酒单读取失败：" + error.localizedDescription } }
  }
  private func clear() { generation += 1; proposed = nil; board = nil; detail = nil; rows = []; member = ""; query = ""; notice = "" }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          LivePendingView()
          if active {
            Picker("办理内容", selection: $tab) {
              Text("存酒记录").tag("records"); Text("新存酒").tag("create"); Text("规则品类").tag("policy"); Text("报表").tag("report")
            }.pickerStyle(.menu)
            Button(reading ? "正在读取…" : "重新读取存酒资料") { Task { await reload() } }.disabled(reading || model.busy || model.heartbeatBusy)
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            if let receipt = model.bottleStorageReceipt, receipt.employeeID == model.identity?.employee.id {
              BottleStorageReceiptView(receipt: receipt)
            }
            if let board {
              if tab == "records" { records(board) }
              if tab == "create" { BottleStorageCreateView(board: board, usable: usable, propose: { propose("create", $0) }).id("create:\(board.version):\(board.sessionID)") }
              if tab == "policy" { BottleStoragePolicyView(board: board, usable: usable, propose: { propose($0, $1, nil, $2) }).id("policy:\(board.version):\(board.sessionID)") }
              if tab == "report" { BottleStorageReportView(board: board, usable: usable, propose: { propose("report_export", $0) }).id("report:\(board.sessionID)") }
            }
          } else { Text("登录或存酒权限已变化，请重新进入。") }
        }.padding(16)
      }.background(paper).navigationTitle("会员存酒").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await reload() }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: model.busy) { _, busy in
        guard !busy, !reading, active, let key = model.bottleStorageReceipt?.requestKey, key != refreshedReceiptKey else { return }
        refreshedReceiptKey = key; let selected = detail?.order.id
        Task { await reload(); if let selected { await loadDetail(selected) } }
      }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if active, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.bottleStorageProof?["confirmation"] as? String ?? "请重新读取原资料")
                Toggle("已核对会员、实物及本次办理内容", isOn: $confirmed)
                Button("确认办理") { proposed = nil; confirmed = false; Task { await model.executeLive(command) } }
                  .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !usable || !model.canExecuteLive(command))
              } else { Text("原账号或权限已变化，内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
  @ViewBuilder private func records(_ board: BottleStorageBoard) -> some View {
    Card {
      TextField("会员号（可留空）", text: $member).textFieldStyle(.roundedBorder)
      TextField("单号或品名关键词", text: $query).textFieldStyle(.roundedBorder)
      Picker("状态", selection: $status) { Text("全部状态").tag(""); ForEach(["stored", "collected", "archived", "voided"], id: \.self) { Text(bottleStorageStates[$0]!).tag($0) } }
      Picker("品类", selection: $category) { Text("全部品类").tag(""); ForEach(board.categories) { Text($0.text("name")).tag($0.id) } }
      TextField("开始日期 YYYY-MM-DD（可留空）", text: $from).textFieldStyle(.roundedBorder)
      TextField("截至日期 YYYY-MM-DD（含当日，可留空）", text: $to).textFieldStyle(.roundedBorder)
      Button("按当前条件查询") { Task { await reload() } }.buttonStyle(Primary(symbol: "magnifyingglass")).disabled(reading || model.busy)
      Text(summary).font(.subheadline)
      if model.identity?.allows("bottle.custody.export") == true {
        Button("导出已查询范围") { propose("export", filters) }.disabled(!usable)
        Text("修改条件后须先查询；导出使用上次查询的筛选范围。").font(.caption)
      }
    }
    ForEach(rows) { row in
      Button { Task { await loadDetail(row.id) } } label: {
        VStack(alignment: .leading, spacing: 6) {
          Text(row.text("item_name") + " · " + row.text("member_no")).font(.headline)
          Text(row.text("public_id")).font(.caption)
          Text("剩余 " + row.text("remaining_quantity") + row.text("unit") + " · " + (bottleStorageStates[row.text("status")] ?? "待核对"))
          Text("到期 " + bottleDisplayTime(row.text("expires_at"))).font(.caption)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
      }.buttonStyle(.plain).disabled(reading || model.busy)
    }
    if let nextCursor { Button("下一页") { Task { await reload(cursor: nextCursor) } }.disabled(reading || model.busy) }
    if let detail { BottleStorageDetailView(board: board, detail: detail, usable: usable,
      refresh: { Task { await loadDetail(detail.order.id) } }, propose: { propose($0, $1, detail) }).id(detail.bytes) }
  }
}
func bottleStorageDateFilters(member: String, from: String, to: String) throws -> [String: Any] {
  var values: [String: Any] = [:]
  if !member.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { values["memberNo"] = member.trimmingCharacters(in: .whitespacesAndNewlines) }
  if !from.isEmpty { values["from"] = try bottleDate(from) + "T00:00:00+08:00" }
  if !to.isEmpty {
    let day = try bottleDate(to), d = try bottleInstant(day + "T00:00:00+08:00")
    values["to"] = bottleISO(d.addingTimeInterval(86400))
  }
  return values
}
func bottleStorageConfirmation(_ op: String, body: [String: Any], detail: BottleStorageDetail?) -> String {
  var lines = [bottleStorageTitles[op] ?? "核对存酒操作"]
  if let detail { lines += ["会员：" + detail.order.text("member_no"), "原单：" + detail.order.text("public_id"), "物品：" + detail.order.text("item_name")] }
  for (key, label) in [("memberNo", "会员号"), ("itemName", "物品"), ("quantity", "数量"), ("unit", "单位"), ("location", "存放位置"), ("reason", "原因"), ("name", "品类名称")] {
    if let value = body[key] as? String, !value.isEmpty { lines.append(label + "：" + value) }
  }
  if op == "resolve_collection" { lines.append(body["quantity"] is NSNull ? "确认本次取酒已饮用完毕，不再寄存。" : (body["restorageMode"] as? String == "new" ? "再次寄存将生成新单，并保留原取酒关联。" : "再次寄存沿用原单、原到期时间。")) }
  if op == "create" || (op == "resolve_collection" && !(body["quantity"] is NSNull)) { lines.append("已现场核对实物照片与取酒联系人；照片将添加服务端水印。存酒登记不扣库存，不收款。") }
  if let days = body["days"] { lines.append("存期：" + String(describing: days) + "天") }
  if let expiry = body["expiresAt"] as? String { lines.append("到期：" + bottleDisplayTime(expiry)) }
  if let value = body["declaredValueMinor"] as? NSNumber { lines.append("登记价值：" + bottleStorageMinor(value.stringValue) + "元（非收入）") }
  if let source = body["sourceReference"] as? String { lines.append("外部来源：" + source) }
  if let source = body["sourceOrderId"] as? String { lines.append("已核实消费订单：" + source) }
  if op == "category" { lines.append("编码：" + bottleText(body, "code") + "；默认" + bottleText(body, "defaultDays") + "天；" + ((try? bottleBoolean(body["active"])) == true ? "启用" : "停用") + "；排序" + bottleText(body, "sortOrder")) }
  if op == "collect" { lines.append("请确认实物已交给核验会员；此操作将减少在存数量。") }
  if op == "verify" { lines.append("仅核验验证码，不代表实物已取走。") }
  if op == "policy", let values = body["policy"] as? [String: Any] {
    for (key, label) in [("enabled", "新存酒"), ("allowPartial", "部分取用"), ("allowRestorage", "再次寄存"), ("requireOriginalOrder", "再存须沿用原单"), ("remindersEnabled", "到期提醒")] {
      lines.append(label + "：" + ((try? bottleBoolean(values[key])) == true ? "是" : "否"))
    }
    lines += ["默认存期：" + bottleText(values, "defaultDays") + "天；归档：" + (bottleText(values, "archiveMode") == "automatic" ? "自动" : "手工"),
      "验证码：" + bottleText(values, "codeDigits") + "位 / 有效" + bottleText(values, "codeTtlSeconds") + "秒 / 重发间隔" + bottleText(values, "resendSeconds") + "秒 / 最多" + bottleText(values, "maximumAttempts") + "次", "凭证标题：" + bottleText(values, "printTitle"), "规则将对后续办理生效，原单历史保持。"]
  }
  if op.contains("export") {
    for key in ["scope", "memberNo", "categoryId", "category", "status", "query", "from", "to"] {
      if let value = body[key] as? String { lines.append((["scope": "范围", "memberNo": "会员", "categoryId": "品类", "category": "品类", "status": "状态", "query": "关键词", "from": "起始", "to": "截止（不含）"][key] ?? key) + "：" + (bottleStorageStates[value] ?? ["all": "分列全部", "custody": "存酒", "sales": "消费"][value] ?? value)) }
    }
    lines.append("导出含会员资料，请只保存到获准的位置；存酒登记价值不是收入，消费订单金额不是实收。") }
  return lines.joined(separator: "\n")
}
