import Foundation

let nativeHomeTypes = ["activity": "活动", "presale": "预售", "benefit": "会员权益", "article": "资讯", "return_offer": "回店礼遇", "show": "演出"]
let nativeHomeLevels = ["member": "普通会员", "silver": "银卡会员", "gold": "金卡会员"]
let nativeHomeStages = ["new": "新会员", "active": "活跃会员", "high_value": "高价值会员", "at_risk": "待唤回会员", "dormant": "沉睡会员"]
let nativeHomeTargets = ["/pages/home/index": "首页", "/pages/reservations/index": "预约", "/pages/order/index": "点单", "/pages/community/index": "活动列表", "/pages/profile/index": "会员中心", "/pages/songs/index": "点歌", "/pages/privacy/index": "隐私政策", "/pages/performances/index": "演出", "/pages/points/index": "积分", "/pages/account/index": "会员账户"]
let nativeRecommendationWeights = ["preferenceWeight": "偏好权重", "sceneWeight": "场景权重", "marginWeight": "毛利权重", "priorityWeight": "经营优先级权重", "performanceWeight": "历史演出权重", "inventoryWeight": "历史库存权重", "capacityWeight": "历史产能权重"]
let nativeRecommendationLimits: [String: (String, ClosedRange<Int>)] = ["minimumGrossMarginBasisPoints": ("最低毛利率（基点，100=1%）", 0...9999), "preferenceHalfLifeDays": ("偏好半衰期（天）", 7...730), "preferenceMaxAgeDays": ("偏好最长有效期（天）", 30...3650), "preferenceMinEffectiveScore": ("最低有效偏好分", 1...10000), "preferenceMinConfidenceBasisPoints": ("最低匹配把握（基点，100=1%）", 0...10000)]
let nativeRecommendationRollouts = ["disabled": "关闭", "shadow": "仅后台观察", "pilot": "门店试运行", "enabled": "正式开放"]
extension NativeManagementModule {
  var isCustomerContent: Bool { [.homeContent, .launchPopup, .recommendations].contains(self) }
}
func nativeManagementReadPath(module: NativeManagementModule, search: String = "", cursor: String = "", code: String = "DEFAULT") throws -> String {
  var query: [URLQueryItem] = []
  guard search.utf16.count <= 80 else { throw CatalogError("搜索文字最多80字") }
  if module == .homeContent {
    if !search.isEmpty { query.append(.init(name: "search", value: search)) }
    if !cursor.isEmpty { guard nativeHomeCode(cursor) else { throw StaffAPIError.invalid }; query.append(.init(name: "cursor", value: cursor)) }
  } else if module == .recommendations {
    guard nativeRecommendationCode(code) else { throw CatalogError("请输入有效的大写策略编号") }
    query.append(.init(name: "code", value: code))
    if !cursor.isEmpty { guard let n = Int(cursor), n > 0, String(n) == cursor else { throw StaffAPIError.invalid }; query.append(.init(name: "cursor", value: cursor)) }
  } else { guard search.isEmpty, cursor.isEmpty, code == "DEFAULT" else { throw StaffAPIError.invalid } }
  var result = URLComponents(); result.path = module.path; if !query.isEmpty { result.queryItems = query }
  guard let path = result.string else { throw StaffAPIError.invalid }; return path
}
func nativeManagementOptionsPath(module: NativeManagementModule, search: String, cursor: String) throws -> String {
  guard [.homeContent, .launchPopup].contains(module), search.utf16.count <= 80 else { throw StaffAPIError.invalid }
  if !cursor.isEmpty {
    if module == .launchPopup { _ = try managementUUID(cursor) }
    else { guard cursor.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid } }
  }
  var result = URLComponents(); result.path = module.path + (module == .homeContent ? "/activity-options" : "/product-options")
  result.queryItems = [.init(name: "search", value: search)] + (cursor.isEmpty ? [] : [.init(name: "cursor", value: cursor)])
  guard let path = result.string else { throw StaffAPIError.invalid }; return path
}
func nativeHomeCode(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$", options: .regularExpression) != nil }
func nativeRecommendationCode(_ value: String) -> Bool { value.range(of: "^[A-Z][A-Z0-9_-]{2,63}$", options: .regularExpression) != nil }
func nativeContentTarget(_ value: String) -> Bool {
  if nativeHomeTargets[value] != nil { return true }
  guard let url = URLComponents(string: value), url.scheme == nil, url.host == nil, url.fragment == nil,
    url.path == "/pages/community-detail/index", let query = url.queryItems, query.count == 1, query[0].name == "id", let id = query[0].value,
    id.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$", options: .regularExpression) != nil else { return false }
  return !value.contains("..") && value.utf16.count <= 256
}
func nativeContentPermission(_ module: NativeManagementModule, _ action: String) throws -> String {
  switch module {
  case .homeContent:
    guard ["create", "update", "publish", "pause"].contains(action) else { throw StaffAPIError.invalid }
    return ["create", "update"].contains(action) ? "community.activity.manage" : "community.activity.publish"
  case .launchPopup: guard action == "save" else { throw StaffAPIError.invalid }; return "community.activity.manage"
  case .recommendations:
    guard ["create", "clone", "approve", "publish", "rollout"].contains(action) else { throw StaffAPIError.invalid }
    return ["create", "clone"].contains(action) ? "recommendation.rule.draft" : action == "approve" ? "recommendation.rule.approve" : "recommendation.rule.publish"
  default: throw StaffAPIError.invalid
  }
}
func nativeContentDate(_ value: String) throws -> Date {
  guard let date = assignmentDate(value) else { throw CatalogError("服务器时间或排期格式不能确认") }; return date
}
func nativeContentStrings(_ fields: NativeManagementInput, _ key: String) throws -> [String] {
  guard let values = try JSONSerialization.jsonObject(with: Data((fields.values[key] ?? "[]").utf8)) as? [String] else { throw StaffAPIError.invalid }
  guard values.count == Set(values).count else { throw CatalogError("选项不能重复") }; return values
}
extension NativeManagementBoard {
  func customerContentCommand(actor: StaffIdentity, operation: String, fields: [String: String], rowID: String?) throws -> LiveCommand {
    let permission = try nativeContentPermission(module, operation)
    guard actor.allows(permission) else { throw CatalogError("当前岗位没有此项配置权限") }
    let f = NativeManagementInput(values: fields), row = rows("rows").first { $0.id == rowID }
    var body: [String: Any] = ["reason": try f.required("reason", 2...500)]
    var target: Any = NSNull(), targetCode: Any = NSNull(), expected: Any = NSNull(), before: Any = NSNull()
    var confirmation = module.title + "\n"
    if module == .homeContent {
      let code = operation == "create" ? f.text("code") : row?.text("code") ?? ""
      guard nativeHomeCode(code) else { throw CatalogError("内容编号须为3—64位字母、数字、点、横线或下划线") }
      body["code"] = code; targetCode = code
      if operation == "create" {
        guard rowID == nil, !rows("rows").contains(where: { $0.id == code }) else { throw CatalogError("已有此内容，请编辑原草稿") }
      } else {
        guard let row, managementHash(row.text("nativeVersion")), operation == "pause" ? row.text("status") == "published" : ["draft", "paused"].contains(row.text("status")) else { throw CatalogError("原内容状态已变化；已发布内容须先暂停再编辑") }
        expected = row.text("nativeVersion"); target = code; before = row.object
        if operation == "publish" { guard try nativeContentDate(row.text("validUntil")) > Date() else { throw CatalogError("展示排期已结束，请先调整原草稿") } }
      }
      body["expectedVersion"] = expected
      if ["create", "update"].contains(operation) {
        for (key, limits) in [("title", 2...120), ("summary", 2...400), ("ctaLabel", 1...20)] { body[key] = try f.required(key, limits) }
        body["type"] = f.text("type"); body["displayMode"] = f.text("displayMode"); body["visibility"] = f.text("visibility")
        body["priority"] = try f.integer("priority", 0...10000)
        body["audienceMemberLevels"] = try nativeContentStrings(f, "audienceMemberLevels").sorted()
        body["audienceLifecycleStages"] = try nativeContentStrings(f, "audienceLifecycleStages").sorted()
        body["validFrom"] = f.text("validFrom"); body["validUntil"] = f.text("validUntil"); body["targetPath"] = f.text("targetPath")
        body["imageUrl"] = f.text("imageUrl").isEmpty ? NSNull() : f.text("imageUrl") as Any
        try validateHomeDraft(body)
        confirmation += (body["title"] as! String) + "\n" + (body["summary"] as! String) + "\n展示排期：" + f.text("validFrom") + " 至 " + f.text("validUntil")
      } else { confirmation += row?.text("title") ?? "" }
      confirmation += "\n" + (["create": "建立草稿，不向顾客显示", "update": "更新草稿，不向顾客显示", "publish": "发布后按排期与客群显示", "pause": "暂停此内容展示"][operation] ?? "")
    } else if module == .launchPopup {
      guard let current = data["row"] as? [String: Any] else { throw StaffAPIError.invalid }
      expected = try managementInt(current["version"])
      body.merge(["enabled": try f.boolean("enabled"), "title": try f.required("title", 1...80), "content": f.values["content"] ?? "", "frequency": f.text("frequency"), "productIds": try nativeContentStrings(f, "productIds"), "version": expected]) { _, new in new }
      before = current
      try validatePopupDraft(body)
      confirmation += (body["enabled"] as! Bool ? "启用" : "关闭") + "打开弹窗\n" + f.text("title") + "\n" + (body["content"] as! String) + "\n商品按已选顺序展示，实际价格与可售条件由服务器核对。"
    } else {
      guard module == .recommendations, let feature = data["feature"] as? [String: Any] else { throw StaffAPIError.invalid }
      if operation == "create" {
        let code = data["code"] as? String ?? "", latest = try managementInt(data["latest"])
        guard nativeRecommendationCode(code), latest >= 0 else { throw StaffAPIError.invalid }
        targetCode = code; expected = latest; body["code"] = code; body["expectedLatest"] = latest
        for key in nativeRecommendationWeights.keys { body[key] = try f.integer(key, -1000...1000) }
        for (key, field) in nativeRecommendationLimits { body[key] = try f.integer(key, field.1) }
        body["explanationTemplate"] = try f.required("explanationTemplate", 2...500)
        // Keep the current server-owned questionnaire/configuration; no raw JSON editor.
        guard let configuration = (row?.object["displayConfiguration"] ?? data["defaultDisplayConfiguration"]) as? [String: Any] else { throw StaffAPIError.invalid }
        body["displayConfiguration"] = configuration
        try validateRecommendationDraft(body)
        confirmation += "新建第\(latest + 1)版草稿\n" + (body["explanationTemplate"] as! String)
      } else if operation == "rollout" {
        expected = feature["nativeVersion"] ?? NSNull(); before = feature
        guard nativeRecommendationRollouts[f.text("rolloutState")] != nil else { throw StaffAPIError.invalid }
        body["expectedVersion"] = expected; body["rolloutState"] = f.text("rolloutState")
        confirmation += "顾客开放：" + nativeRecommendationRollouts[f.text("rolloutState")]! + "\n开放仍须有当前生效、三人分离的规则，并满足库存与出品条件。"
      } else {
        guard let row else { throw CatalogError("请重新读取原规则") }
        expected = row.text("nativeVersion"); before = row.object; target = row.id; targetCode = row.text("code")
        body["publicId"] = row.id; body["expectedVersion"] = expected
        if operation == "approve" { guard row.text("status") == "draft", row.text("createdByEmployeeId") != actor.employee.id else { throw CatalogError("请由另一位员工审批原草稿") } }
        if operation == "publish" {
          guard row.text("status") == "approved", row.text("createdByEmployeeId") != actor.employee.id, row.text("approvedByEmployeeId") != actor.employee.id else { throw CatalogError("发布人须与起草和审批人不同") }
          _ = try managementInstant(f.text("effectiveFrom")); body["effectiveFrom"] = f.text("effectiveFrom")
        }
        confirmation += row.text("code") + " 第" + row.text("version") + "版 · " + (["clone": "复制为新草稿", "approve": "独立审批", "publish": "安排规则生效"][operation] ?? "")
      }
      if operation != "rollout" { confirmation += "\n此操作不会自动向顾客开放推荐。" }
    }
    confirmation += "\n原因：" + f.text("reason")
    return try makeSettingsCommand(actor: actor, operation: operation, body: body, target: target,
      targetCode: targetCode, expected: expected, extra: ["before": before], confirmation: confirmation)
  }
}
struct NativeContentOptions {
  let rows: [NativeManagementRow]
  let next: String?
  init(_ bytes: Data, actor: StaffIdentity, module: NativeManagementModule) throws {
    let value = try managementData(bytes)
    guard value["employeeId"] as? String == actor.employee.id, try managementInt(value["protocol"]) == 1,
      try managementBool(value["durableCommands"]), let source = value["rows"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    rows = try source.map { row in
      let item = try NativeManagementRow(row); guard !item.text("name").isEmpty else { throw StaffAPIError.invalid }
      if module == .launchPopup { _ = try managementUUID(item.id) }
      else { guard item.id.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid } }
      return item
    }
    guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    if value["next"] is NSNull { next = nil }
    else { guard let cursor = value["next"] as? String else { throw StaffAPIError.invalid }; _ = try nativeManagementOptionsPath(module: module, search: "", cursor: cursor); next = cursor }
  }
}
