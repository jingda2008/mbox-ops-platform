import SwiftUI

struct MemberCardFormView: View {
  @EnvironmentObject var model: AppModel
  let board: MemberCardsBoard
  let edit: MemberCardEditor
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var fields: [String: String]
  @State private var config: MemberCardConfig?
  @State private var error = ""
  init(board: MemberCardsBoard, edit: MemberCardEditor, close: @escaping () -> Void, propose: @escaping (LiveCommand) -> Void) {
    self.board = board; self.edit = edit; self.close = close; self.propose = propose
    _fields = State(initialValue: ["kind": "interest", "cooperationConfirmed": "false", "autoRestore": (try? edit.row?.boolean("auto_restore")) == true ? "true" : "false",
      "artistName": edit.row?.text("artist_name") ?? "", "iconUrl": edit.row?.text("icon_url") ?? "",
      "serviceAccountId": edit.row?.text("service_account_id") ?? "", "wecomAccountId": edit.row?.text("wecom_account_id") ?? ""])
  }
  private func binding(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func flag(_ key: String) -> Binding<Bool> { Binding(get: { fields[key] == "true" }, set: { fields[key] = $0 ? "true" : "false" }) }
  private func readConfig() {
    guard let project = edit.row else { return }
    Task {
      do { config = try await model.readMemberCardConfig(projectID: project.id); error = "" }
      catch { config = nil; self.error = error.localizedDescription }
    }
  }
  private func submit() {
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      propose(try board.command(actor: actor, action: edit.action, fields: fields, row: edit.row, target: edit.target, config: config))
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text(edit.action == "create" ? "新建卡项目草稿" : edit.action == "social" ? "加入门槛与卡片" : edit.action == "menu" ? "专属菜单" : "核对原记录处理").font(.title3.bold())
      if let row = edit.row { Text(row.text(board.section == "projects" ? "name" : "project_name")).font(.headline) }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if edit.action == "create" {
        field("code", "编号（大写字母、数字或下划线）"); field("name", "卡名称")
        field("terms", "完整申请条款")
        Picker("卡类型", selection: binding("kind")) { Text("兴趣卡").tag("interest"); Text("联名卡").tag("cobrand") }.pickerStyle(.menu)
        field("from", "开始时间（北京时间 YYYY-MM-DD HH:mm）"); field("until", "结束时间（北京时间 YYYY-MM-DD HH:mm）")
        if fields["kind"] == "cobrand" {
          field("cooperationReference", "合作确认依据")
          Toggle("已确认真实合作", isOn: flag("cooperationConfirmed"))
          field("cooperationUntil", "合作到期时间（北京时间，可留空）")
        }
        Text("保存后仍为草稿，须配置服务号和企业微信，再由另一位有发布权限的员工开放。").font(.caption)
      } else if edit.action == "social" {
        if let config {
          Picker("本店服务号", selection: binding("serviceAccountId")) {
            Text("请选择服务号").tag("")
            ForEach(config.accounts.filter { $0.text("kind") == "service_account" }) { Text($0.text("name") + ((try? $0.boolean("enabled")) == true ? "" : "（停用）")).tag($0.id) }
          }.pickerStyle(.menu)
          Picker("本店企业微信", selection: binding("wecomAccountId")) {
            Text("请选择企业微信").tag("")
            ForEach(config.accounts.filter { $0.text("kind") == "wecom" }) { Text($0.text("name") + ((try? $0.boolean("enabled")) == true ? "" : "（停用）")).tag($0.id) }
          }.pickerStyle(.menu)
          field("artistName", "卡片艺人名称"); field("iconUrl", "站内图标路径（可留空）")
          Toggle("顾客重新满足门槛时允许自动恢复", isOn: flag("autoRestore"))
          Text("不会代顾客完成关注、企微添加或授权。开放后不覆盖已接受的历史条款。").font(.caption)
        }
        Button("重读门槛配置") { readConfig() }.disabled(model.busy || model.heartbeatBusy)
      } else if edit.action != "menu" {
        Text("目标：" + (["approve": "通过申请", "reject": "拒绝申请", "suspend": "暂停此卡", "resume": "恢复此卡", "revoke": "撤销此卡"][edit.target] ?? cardStateNames[edit.target] ?? "待核对"))
        if let row = edit.row, !row.text("customer_reference").isEmpty { Text("客户：" + row.text("customer_reference")).font(.caption) }
        field("reason", "实际处理原因（2—300字）")
        if edit.target == "revoke" { Text("撤销后不能恢复此卡；不会自动退款或改变会员等级。").font(.caption) }
      }
      if edit.action == "menu", let row = edit.row {
        MemberCardMenuView(board: board, project: row, config: config, refresh: readConfig, propose: propose)
      } else {
        Button("下一步 · 核对完整内容") { submit() }.buttonStyle(Primary(symbol: "checkmark.shield"))
          .disabled(!model.canUseMemberCards || (edit.action == "social" && config == nil))
      }
      Button("收起编辑", action: close)
    }.task { if ["social", "menu"].contains(edit.action) { readConfig() } }
  }
  private func field(_ key: String, _ label: String) -> some View {
    TextField(label, text: binding(key), axis: .vertical).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
  }
}
private struct MemberCardMenuView: View {
  @EnvironmentObject var model: AppModel
  let board: MemberCardsBoard
  let project: WalletRecord
  let config: MemberCardConfig?
  let refresh: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var query = ""
  @State private var applied = ""
  @State private var products: MemberCardProducts?
  @State private var chosen: WalletRecord?
  @State private var exclusive = false
  @State private var active = true
  @State private var price = ""
  @State private var sort = "0"
  @State private var notice = ""
  private func search(_ offset: Int) {
    Task {
      do {
        let term = offset == 0 ? query : applied
        products = try await model.memberCardProducts(search: term, offset: offset); applied = term; notice = ""
      } catch { notice = error.localizedDescription }
    }
  }
  private func select(_ product: WalletRecord, existing: Bool) {
    chosen = product
    exclusive = existing && (try? product.boolean("exclusive")) == true
    active = !existing || (try? product.boolean("active")) == true
    sort = existing ? String((try? product.integer("sort_order")) ?? 0) : "0"
    price = existing ? ((try? product.integer("exclusive_price_minor")).map(walletMoneyText) ?? "") : ""
  }
  private func submit(_ action: String, product: WalletRecord) {
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let fields = ["exclusive": exclusive ? "true" : "false", "active": active ? "true" : "false", "sortOrder": sort, "price": price]
      propose(try board.command(actor: actor, action: action, fields: fields, row: project, config: config, product: product)); notice = ""
    } catch { notice = error.localizedDescription }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("专属价留空沿用商品标准价。专属增量不得遮挡公共商品；移出菜单不会删除商品。").font(.caption)
      Button("刷新原专属菜单") { chosen = nil; refresh() }.disabled(model.busy || model.heartbeatBusy)
      if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
      if let config {
        ForEach(config.menu) { item in
          Text(item.text("name")).font(.headline)
          Text(((try? item.boolean("active")) == true ? "展示" : "隐藏") + " · " + ((try? item.boolean("exclusive")) == true ? "专属增量" : "关联商品") + " · " + ((try? item.integer("exclusive_price_minor")).map { walletMoneyText($0) + "元" } ?? "标准价")).font(.caption)
          Button("编辑此商品") { select(item, existing: true) }
          Button("移出此卡菜单", role: .destructive) { submit("menu-remove", product: item) }.disabled(!model.canUseMemberCards)
          Divider()
        }
        TextField("搜索可选商品", text: $query).textFieldStyle(.roundedBorder)
        Button("查询商品") { search(0) }.disabled(model.busy || model.heartbeatBusy)
        ForEach(products?.rows ?? []) { product in Button(product.text("name")) { select(product, existing: false) } }
        if let next = products?.nextOffset { Button("下一页商品") { search(next) }.disabled(model.busy || model.heartbeatBusy) }
        if let chosen {
          Text("已选择：" + chosen.text("name")).font(.headline)
          Toggle("专属增量商品", isOn: $exclusive)
          if chosen.object["guest_visible"] == nil && (try? chosen.boolean("exclusive")) != true {
            Text("此旧菜单记录没有公共可见状态；改为专属增量前须从上方重新查询商品。").font(.caption)
          }
          Toggle("显示在此卡菜单", isOn: $active)
          TextField("专属价（元，可留空）", text: $price).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
          TextField("排序 0—10000", text: $sort).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
          Button("核对菜单变更") { submit("menu", product: chosen) }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseMemberCards)
        }
      } else { Text("请先读取原菜单及版本。").font(.caption) }
    }
  }
}
