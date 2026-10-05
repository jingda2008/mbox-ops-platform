import Foundation

let memberCardsRoot = "/api/staff/native-member-cards"
let memberCardPermissions = ["member.card.manage", "member.card.review", "loyalty.policy.publish"]
let cardStateNames = ["draft": "草稿", "open": "开放申请", "paused": "暂停申请", "closed": "已关闭", "pending": "待审核", "approved": "已通过", "rejected": "已拒绝", "active": "有效", "suspended": "暂停使用", "withdrawn": "已退出", "revoked": "已撤销"]
func memberCardSections(_ actor: StaffIdentity) -> [String] {
  (actor.allows("member.card.manage") || actor.allows("loyalty.policy.publish") ? ["projects"] : [])
    + (actor.allows("member.card.review") ? ["applications"] : [])
    + (actor.allows("member.card.manage") ? ["holdings"] : [])
}
struct MemberCardsBoard {
  let employeeID, section: String
  let enabled: Bool
  let rows: [WalletRecord]
  let nextCursor: String?
  init(data: Data, actor: StaffIdentity, section: String) throws {
    let d = try walletEnvelope(data)
    guard d["employeeId"] as? String == actor.employee.id, d["section"] as? String == section,
      memberCardSections(actor).contains(section), try walletInteger(d["protocol"]) == 1,
      let rows = d["items"] as? [[String: Any]], rows.count <= 50 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.section = section; enabled = try walletBoolean(d["durableCommands"])
    self.rows = try walletRecords(rows); nextCursor = d["nextCursor"] as? String
    guard nextCursor == nil || UUID(uuidString: nextCursor!) != nil else { throw StaffAPIError.invalid }
    for row in self.rows {
      let valid = section == "projects" ? ["draft", "open", "paused", "closed"] : section == "applications" ? ["pending"] : ["active", "suspended", "withdrawn", "revoked"]
      guard valid.contains(row.text("status")) else { throw StaffAPIError.invalid }
      if section == "projects" {
        guard !row.text("name").isEmpty, try row.integer("version") > 0,
          assignmentDate(row.text("available_from")) != nil, assignmentDate(row.text("available_until")) != nil,
          assignmentDate(row.text("updated_at")) != nil, UUID(uuidString: row.text("created_by_employee_id")) != nil,
          ["interest", "cobrand"].contains(row.text("kind")) else { throw StaffAPIError.invalid }
      } else {
        guard UUID(uuidString: row.text("project_id")) != nil, !row.text("project_name").isEmpty,
          !row.text("customer_reference").isEmpty else { throw StaffAPIError.invalid }
        if section == "holdings" {
          guard assignmentDate(row.text("updated_at")) != nil, assignmentDate(row.text("valid_until")) != nil else { throw StaffAPIError.invalid }
          _ = try row.boolean("expired")
        } else if assignmentDate(row.text("requested_at")) == nil { throw StaffAPIError.invalid }
      }
    }
  }
  static func query(section: String, cursor: String = "") throws -> String {
    guard ["projects", "applications", "holdings"].contains(section), cursor.isEmpty || UUID(uuidString: cursor) != nil else { throw StaffAPIError.invalid }
    return "?section=" + section + (cursor.isEmpty ? "" : "&cursor=" + cursor)
  }
  func command(actor: StaffIdentity, action: String, fields: [String: String], row: WalletRecord? = nil,
    target: String = "", config: MemberCardConfig? = nil, product: WalletRecord? = nil, now: Date = Date()) throws -> LiveCommand {
    guard enabled, actor.employee.id == employeeID, memberCardSections(actor).contains(section),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("卡项目、登录或权限已变化，请重新读取") }
    if let row, !rows.contains(row) { throw CatalogError("原会员卡记录已变化，请重新读取") }
    func text(_ key: String) -> String { (fields[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    func required(_ key: String, min: Int = 2, max: Int = 300) throws -> String {
      let v = text(key); guard (min...max).contains(v.utf16.count) else { throw CatalogError("请核对必填信息及长度") }; return v
    }
    func boolean(_ key: String) throws -> Bool {
      guard ["true", "false"].contains(text(key)) else { throw StaffAPIError.invalid }; return text(key) == "true"
    }
    let permission = action == "review" ? "member.card.review" : action == "state" && target == "open" ? "loyalty.policy.publish" : "member.card.manage"
    guard actor.allows(permission) else { throw CatalogError("当前岗位没有此项会员卡权限") }
    let title: String
    var body: [String: Any] = [:], details: [String] = []
    if action == "create" {
      guard section == "projects" else { throw StaffAPIError.invalid }
      let code = text("code"), name = try required("name", max: 60), terms = try required("terms", max: 6000), kind = text("kind")
      guard code.range(of: "^[A-Z][A-Z0-9_]{1,39}$", options: .regularExpression) != nil, ["interest", "cobrand"].contains(kind) else { throw CatalogError("编号须为2—40位大写字母、数字或下划线，且以字母开头") }
      let from = try walletDateInput(text("from")), until = try walletDateInput(text("until"))
      guard assignmentDate(until)! > max(assignmentDate(from)!, now) else { throw CatalogError("卡项目须有未来有效期，结束须晚于开始") }
      let cooperation = kind == "cobrand" ? try boolean("cooperationConfirmed") : false
      let reference: Any = kind == "cobrand" ? try required("cooperationReference", max: 500) : NSNull()
      let cooperationUntil: Any = kind == "cobrand" && !text("cooperationUntil").isEmpty ? try walletDateInput(text("cooperationUntil")) : NSNull()
      body = ["code": code, "name": name, "terms": terms, "kind": kind, "availableFrom": from, "availableUntil": until,
        "cooperationConfirmed": cooperation, "cooperationReference": reference, "cooperationValidUntil": cooperationUntil]
      title = "保存会员卡项目草稿"
      details = [name + " · " + code, kind == "cobrand" ? "联名卡" : "兴趣卡", "有效期：\(text("from")) — \(text("until"))", "完整条款：\n" + terms]
      if kind == "cobrand" { details += ["合作确认：" + (cooperation ? "已确认" : "尚未确认"), "合作依据：" + (reference as! String), "合作到期：" + (cooperationUntil as? String ?? "未设置")] }
      details.append("保存后仍是草稿，不会发卡；须配置本店加入门槛，由另一位有发布权限的员工开放。")
    } else {
      guard let row else { throw CatalogError("请先选择原会员卡记录") }
      details = [row.text(section == "projects" ? "name" : "project_name")]
      if section != "projects" { details.append("客户：" + row.text("customer_reference")) }
      switch action {
      case "state":
        guard section == "projects", ["open", "paused", "closed"].contains(target), row.text("status") != "closed", row.text("status") != target else { throw CatalogError("原卡项目状态已变化") }
        if target == "open" {
          guard row.text("created_by_employee_id") != actor.employee.id else { throw CatalogError("创建人不能自行开放本人项目") }
          guard assignmentDate(row.text("available_until")).map({ $0 > max(now, assignmentDate(row.text("available_from"))!) }) == true else { throw CatalogError("卡项目已到期") }
          if (try? row.boolean("social_configuration_required")) == true && (try? row.boolean("require_social_conditions")) != true { throw CatalogError("请先配置本店服务号与企业微信加入门槛") }
          if row.text("kind") == "cobrand" {
            guard try row.boolean("cooperation_confirmed"), assignmentDate(row.text("cooperation_valid_until")).map({ $0 > max(now, assignmentDate(row.text("available_from"))!) }) == true else { throw CatalogError("联名合作尚未确认或已到期") }
          }
        }
        body = ["projectId": row.id, "expectedUpdatedAt": row.text("updated_at"), "state": target, "reason": try required("reason")]
        title = (cardStateNames[target] ?? "") + " · 会员卡项目"; details.append("说明：" + text("reason"))
        details.append("暂停或关闭申请不会撤销已持有的卡。")
      case "review":
        guard section == "applications", row.text("status") == "pending", ["approve", "reject"].contains(target) else { throw CatalogError("原申请已处理或决定无效") }
        body = ["applicationId": row.id, "decision": target, "reason": try required("reason")]
        title = target == "approve" ? "审核通过会员卡申请" : "拒绝会员卡申请"; details += ["会员号：" + row.text("member_no"), "说明：" + text("reason"), "仅审核顾客已提交的申请，不代顾客接受条款或授权。"]
      case "holding":
        let allowed = row.text("status") == "active" ? ["suspend", "revoke"] : row.text("status") == "suspended" ? ["resume", "revoke"] : []
        guard section == "holdings", allowed.contains(target), target != "resume" || ((try? row.boolean("expired")) == false && assignmentDate(row.text("valid_until")).map({ $0 > now }) == true) else { throw CatalogError("持卡状态或有效期已变化") }
        body = ["cardId": row.id, "expectedUpdatedAt": row.text("updated_at"), "action": target, "reason": try required("reason")]
        title = ["suspend": "暂停会员卡", "resume": "恢复会员卡", "revoke": "撤销会员卡"][target]!; details += ["说明：" + text("reason"), target == "revoke" ? "撤销后不能恢复此卡；不自动退款或回退会员等级。" : "本次只改变此卡状态，不变更会员等级或营销许可。"]
      case "social", "menu", "menu-remove":
        guard section == "projects", let config, config.employeeID == employeeID, config.project.id == row.id else { throw CatalogError("请重新读取此项目的加入门槛与菜单") }
        body["projectId"] = row.id
        if action == "social" {
          guard row.text("status") == "draft", config.project.text("status") == "draft", config.project.text("updated_at") == row.text("updated_at") else { throw CatalogError("加入门槛只能在原草稿配置") }
          guard let service = config.accounts.first(where: { $0.id == text("serviceAccountId") && $0.text("kind") == "service_account" }),
            let wecom = config.accounts.first(where: { $0.id == text("wecomAccountId") && $0.text("kind") == "wecom" }) else { throw CatalogError("请选择本店服务号和企业微信") }
          let artist = try required("artistName", min: 1, max: 100), icon = text("iconUrl"), restore = try boolean("autoRestore")
          guard icon.isEmpty || (icon.range(of: "^/(assets|media)/[A-Za-z0-9_./-]+$", options: .regularExpression) != nil && !icon.split(separator: "/").contains("..")) else { throw CatalogError("图标须为站内assets或media路径") }
          body.merge(["expectedUpdatedAt": config.project.text("updated_at"), "serviceAccountId": service.id, "wecomAccountId": wecom.id, "artistName": artist, "iconUrl": icon.isEmpty ? NSNull() : icon as Any, "autoRestore": restore]) { _, v in v }
          title = "保存会员卡加入门槛"; details += ["服务号：" + service.text("name"), "企业微信：" + wecom.text("name"), "卡片艺人：" + artist, "图标：" + (icon.isEmpty ? "未设置" : icon), "自动恢复：" + (restore ? "允许" : "关闭"), "员工不能替顾客完成平台关注、添加或授权。"]
        } else {
          guard let product else { throw CatalogError("请选择原菜单商品或重新查询商品") }
          body["productId"] = product.id; body["expectedMenu"] = config.expectedMenu
          details.append("商品：" + product.text("name"))
          if action == "menu-remove" {
            guard config.menu.contains(product) else { throw CatalogError("原菜单商品已变化，请刷新") }
            title = "移除会员卡菜单项"; details.append("只移出此卡菜单，不删除商品，也不改变已下订单。")
          } else {
            let exclusive = try boolean("exclusive"), active = try boolean("active")
            guard let order = Int(text("sortOrder")), String(order) == text("sortOrder"), (0...10000).contains(order) else { throw CatalogError("排序须为0—10000的整数") }
            if exclusive {
              let alreadyExclusive = config.menu.contains(where: { $0.id == product.id && (try? $0.boolean("exclusive")) == true })
              guard (try? product.boolean("guest_visible")) == false || alreadyExclusive else { throw CatalogError("专属增量不得遮挡公共商品；请重新查询商品可见状态") }
            }
            let price: Any = text("price").isEmpty ? NSNull() : try walletMoney(text("price"))
            body.merge(["exclusive": exclusive, "active": active, "sortOrder": order, "exclusivePriceMinor": price]) { _, v in v }
            title = "保存会员卡专属菜单"; details += [exclusive ? "专属增量商品" : "关联商品", active ? "展示" : "隐藏", "专属价：" + ((price as? Int).map { walletMoneyText($0) + "元" } ?? "沿用标准价"), "排序：\(order)"]
          }
        }
      default: throw StaffAPIError.invalid
      }
    }
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["action": action, "employeeId": employeeID, "confirmation": ([title] + details).joined(separator: "\n")]
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: memberCardsRoot + "/commands/" + action,
      body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys), keyHeader: "idempotency-key", key: "native-business-" + id,
      recoveryBody: try JSONSerialization.data(withJSONObject: ["memberCard": proof], options: .sortedKeys))])
  }
}
struct MemberCardConfig {
  let employeeID, expectedMenu: String
  let project: WalletRecord
  let menu, accounts: [WalletRecord]
  init(data: Data, actor: StaffIdentity, projectID: String) throws {
    let d = try walletEnvelope(data)
    guard actor.allows("member.card.manage"), d["employeeId"] as? String == actor.employee.id,
      let project = d["project"] as? [String: Any], project["id"] as? String == projectID,
      let hash = d["expectedMenu"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let menu = d["menu"] as? [[String: Any]], let accounts = d["accounts"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; expectedMenu = hash; self.project = try WalletRecord(project)
    guard assignmentDate(self.project.text("updated_at")) != nil else { throw StaffAPIError.invalid }
    self.menu = try walletRecords(menu.map { value in var normalized = value; normalized["id"] = value["product_id"]; return normalized })
    self.accounts = try walletRecords(accounts)
    for item in self.menu { _ = try item.boolean("active"); _ = try item.boolean("exclusive"); _ = try item.integer("sort_order") }
    for account in self.accounts { _ = try account.boolean("enabled") }
  }
}
struct MemberCardProducts {
  let employeeID: String
  let rows: [WalletRecord]
  let nextOffset: Int?
  init(data: Data, actor: StaffIdentity) throws {
    let d = try walletEnvelope(data)
    guard actor.allows("member.card.manage"), d["employeeId"] as? String == actor.employee.id,
      let rows = d["items"] as? [[String: Any]], rows.count <= 100 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.rows = try walletRecords(rows)
    nextOffset = d["nextOffset"] is NSNull ? nil : try walletInteger(d["nextOffset"])
    guard nextOffset == nil || (1...1000000).contains(nextOffset!) else { throw StaffAPIError.invalid }
    for row in self.rows { _ = try row.boolean("guest_visible") }
  }
  static func query(search: String, offset: Int) throws -> String {
    let search = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard search.utf16.count <= 120, (0...1000000).contains(offset) else { throw CatalogError("商品查询条件超出范围") }
    var q = URLComponents(); q.queryItems = [URLQueryItem(name: "search", value: search), URLQueryItem(name: "offset", value: String(offset))]
    return "?" + (q.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
}
extension LiveCommand.Step {
  var memberCardProof: [String: Any]? {
    guard let recoveryBody else { return nil }
    return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["memberCard"] as? [String: Any]
  }
}
func validateMemberCardReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let meta = root["meta"] as? [String: Any],
    try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let proof = step.memberCardProof,
    let action = proof["action"] as? String, step.path == memberCardsRoot + "/commands/" + action,
    d["employeeId"] as? String == proof["employeeId"] as? String, d["requestKey"] as? String == step.key,
    d["action"] as? String == action, let result = d["result"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"])
  let b = step.object
  switch action {
  case "create": guard UUID(uuidString: result["projectId"] as? String ?? "") != nil, result["status"] as? String == "draft" else { throw StaffAPIError.invalid }
  case "state": guard result["projectId"] as? String == b["projectId"] as? String, result["status"] as? String == b["state"] as? String else { throw StaffAPIError.invalid }
  case "review":
    guard result["applicationId"] as? String == b["applicationId"] as? String,
      result["status"] as? String == (b["decision"] as? String == "approve" ? "approved" : "rejected") else { throw StaffAPIError.invalid }
    if b["decision"] as? String == "approve", UUID(uuidString: result["cardId"] as? String ?? "") == nil { throw StaffAPIError.invalid }
  case "holding": guard result["cardId"] as? String == b["cardId"] as? String,
    result["status"] as? String == ["suspend": "suspended", "resume": "active", "revoke": "revoked"][b["action"] as? String ?? ""] else { throw StaffAPIError.invalid }
  case "social": guard result["projectId"] as? String == b["projectId"] as? String, try walletBoolean(result["configured"]) else { throw StaffAPIError.invalid }
  case "menu", "menu-remove": guard result["projectId"] as? String == b["projectId"] as? String,
    result["productId"] as? String == b["productId"] as? String, try walletBoolean(result[action == "menu" ? "saved" : "removed"]) else { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
}
