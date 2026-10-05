import SwiftUI

struct MemberGiftFormView: View {
  @EnvironmentObject var model: AppModel
  let board: MemberGiftsBoard
  let row: GiftRecord?
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var draft: MemberGiftDraft?
  @State private var error = ""
  @State private var pickerKey: String?
  private func binding(_ key: String) -> Binding<String> { Binding(get: { draft?.fields[key] ?? "" }, set: { draft?.fields[key] = $0 }) }
  @ViewBuilder private func field(_ key: String) -> some View {
    Text(giftFieldLabels[key] ?? key).font(.caption)
    TextField(giftFieldLabels[key] ?? key, text: binding(key), axis: .vertical).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
  }
  @ViewBuilder private func choice(_ key: String, _ name: String) -> some View {
    Picker(name, selection: binding(key)) { ForEach(giftChoices[key]!.keys.sorted(), id: \.self) { Text(giftChoices[key]![$0]!).tag($0) } }.pickerStyle(.menu)
  }
  private var pickKeys: [String] {
    var keys = ["couponCalendarVersionId", "productIds", "dessertProductId", "cardCodes"]
    if draft?.fields["trigger"] == "card_entry" { keys.append("cardProjectId") }
    if draft?.fields["pricingKind"] == "fixed_price" { keys.append("stackingVersionId") }; return keys
  }
  var body: some View {
    Card {
      Text(row == nil ? "新赠礼活动草稿" : "修订并保存新版本").font(.title3.bold())
      Button("返回列表", action: close)
      if let current = draft {
        Text("保存新版本保留历史。同一活动的触发身份、入卡项目和预算换日不能改写；这些条件变更须使用新活动编号。").font(.caption)
        field("code"); field("name"); choice("trigger", "触发方式")
        ForEach(pickKeys, id: \.self) { key in
          let selected = current.selected[key] ?? []
          Text(giftPickLabels[key]! + "：" + (selected.isEmpty ? "未选择" : selected.map { current.names[$0] ?? (key == "cardCodes" ? $0 : "原绑定编号：" + $0) }.joined(separator: "、"))).font(.subheadline)
          Button("查询并选择" + giftPickLabels[key]!) { pickerKey = key }.disabled(model.busy || model.heartbeatBusy)
          if ["dessertProductId", "cardCodes"].contains(key), !selected.isEmpty { Button("清除" + giftPickLabels[key]!) { draft?.selected[key] = [] } }
        }
        choice("pricingKind", "券价格")
        if current.fields["pricingKind"] == "fixed_price" { field("fixedPriceMinor") }
        choice("minimumTier", "最低会员等级"); choice("cardMatch", "兴趣卡匹配"); choice("tierAndCards", "等级与兴趣卡关系")
        Text("必须明确会员等级或兴趣卡人群，空条件不能自动全量发放。").font(.caption)
        ForEach(["availableFrom", "availableUntil", "quantityPerCustomer", "maximumDailyQuantity", "maximumQuantity", "maximumUnitCostMinor", "maximumDailyCostMinor", "maximumCostMinor"], id: \.self) { field($0) }
        Text("发放时间填写 YYYY-MM-DD HH:mm 或含秒。预算是待兑现商品成本承诺，不是销售额；0元不是不限额，成本未知时后台拒绝发券。").font(.caption)
        choice("budgetDateBasis", "预算按哪天计算")
        if current.fields["budgetDateBasis"] == "business" { field("budgetCutoff") }
        Text("展示统计").font(.headline)
        ForEach(["issued", "redeemed", "remaining", "cost"], id: \.self) { metric in
          Toggle(giftMetrics[metric]!, isOn: Binding(get: { draft?.selected["highlightMetrics"]?.contains(metric) == true }, set: { enabled in
            let values = draft?.selected["highlightMetrics"] ?? []
            draft?.selected["highlightMetrics"] = enabled ? Array(Set(values + [metric])).sorted() : values.filter { $0 != metric }
          }))
        }
        field("reason")
        Button("核对全部规则并保存草稿") {
          do {
            guard let actor = model.identity, let draft else { throw StaffAPIError.invalid }
            propose(try board.command(actor: actor, action: "save", row: row, draft: draft)); error = ""
          } catch { self.error = error.localizedDescription }
        }.buttonStyle(Primary(symbol: "doc.badge.arrow.up")).disabled(!model.canUseMemberGifts)
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
    }.task { do { draft = try MemberGiftDraft(row: row) } catch { self.error = error.localizedDescription } }
      .sheet(isPresented: Binding(get: { pickerKey != nil }, set: { if !$0 { pickerKey = nil } })) {
        if let key = pickerKey {
          MemberGiftOptionPicker(kind: giftPickKinds[key]!, maximum: ["productIds", "cardCodes"].contains(key) ? 100 : 1) { rows in
            draft?.selected[key] = rows.map { key == "cardCodes" ? $0.text("code") : $0.id }
            for row in rows { draft?.names[key == "cardCodes" ? row.text("code") : row.id] = row.text("name") }
            pickerKey = nil
          }
        }
      }
  }
}
struct MemberGiftOptionPicker: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let kind: String
  let maximum: Int
  var initial: [WalletRecord] = []
  var refundRow: GiftRecord? = nil
  let done: ([WalletRecord]) -> Void
  @State private var search = ""
  @State private var queried = ""
  @State private var rows: [WalletRecord] = []
  @State private var chosen: [WalletRecord] = []
  @State private var next: String?
  @State private var loading = false
  @State private var loaded = false
  @State private var notice = ""
  @State private var ticket = 0
  @State private var access: String?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + memberGiftPermissions.filter(actor.allows).joined(separator: ",")
  }
  private func load(more: Bool = false) {
    guard !loading else { return }
    let generation = ticket, query = search, cursor = more ? next ?? "" : ""
    loading = true
    Task {
      defer { loading = false }
      do {
        let page: MemberGiftOptions
        if kind == "refund", let refundRow { page = try await model.memberGiftRefundOptions(refundID: refundRow.text("refund_id"), reservationID: refundRow.text("reservation_id"), cursor: cursor) }
        else { page = try await model.memberGiftOptions(kind: kind, search: query, cursor: cursor) }
        guard generation == ticket, access == accessKey else { return }
        var ids = Set<String>(); rows = ((more ? rows : []) + page.rows).filter { ids.insert($0.id).inserted }
        next = page.nextCursor; queried = query; notice = ""; loaded = true
      } catch { if generation == ticket { notice = "读取失败，不能判定没有记录：" + error.localizedDescription } }
    }
  }
  private func label(_ row: WalletRecord) -> String { kind == "refund" ? row.text("benefit_code") + " · " + row.text("quantity_total") + "份" : row.text("name") + " · " + row.text("code") }
  private func toggle(_ row: WalletRecord) {
    if chosen.contains(where: { $0.id == row.id }) { chosen.removeAll { $0.id == row.id } }
    else if maximum == 1 { chosen = [row] }
    else if chosen.count < maximum { chosen.append(row) }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if access == accessKey, !accessKey.isEmpty {
            Text("确认后替换原选择；返回会保留原值。已选\(chosen.count)/\(maximum)。").font(.subheadline)
            if kind != "refund" { TextField(kind == "customers" ? "会员号或客户编号（至少2字）" : "名称或编号", text: $search).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).onChange(of: search) { _, _ in ticket += 1; rows = []; next = nil; loaded = false } }
            Button(loading ? "读取中" : "查询") { load() }.disabled(loading || model.busy || model.heartbeatBusy || (kind == "customers" && search.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count < 2))
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            ForEach(chosen) { row in HStack { Text("已选：" + label(row)); Spacer(); Button("移除") { chosen.removeAll { $0.id == row.id } } } }
            ForEach(rows) { row in
              Button { toggle(row) } label: {
                HStack { Image(systemName: chosen.contains(where: { $0.id == row.id }) ? "checkmark.circle.fill" : "circle"); Text(label(row)).multilineTextAlignment(.leading) }
              }.buttonStyle(.plain)
              if kind == "refund" { Text("有效至：" + (row.text("valid_until").isEmpty ? "长期" : membershipRecordTime(row.text("valid_until")))).font(.caption) }
            }
            if next != nil { Button("加载更多") { load(more: true) }.disabled(loading || queried != search || model.busy || model.heartbeatBusy) }
            if loaded && rows.isEmpty { Text(kind == "refund" ? "未找到可关联的新券；如需补偿，须先完成已审批活动的实际发放。" : "当前查询没有记录。").font(.caption) }
            Button("确认选择 \(chosen.count) 项") { done(chosen); dismiss() }.buttonStyle(Primary(symbol: "checkmark")).disabled(chosen.isEmpty || loading)
          }
        }.padding(16)
      }.background(paper).navigationTitle("查询并选择").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回，保留原选择") { dismiss() } } }
    }.tint(ink).task { access = accessKey; chosen = initial; if kind != "customers" { load() } }
      .onChange(of: accessKey) { _, _ in chosen = []; rows = []; ticket += 1; dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in chosen = []; rows = []; ticket += 1; dismiss() }
  }
}
