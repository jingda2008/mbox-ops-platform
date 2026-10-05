import Foundation

extension NativeManagementBoard {
  func publicationCommand(actor: StaffIdentity, operation: String, fields: [String: String], rowID: String?) throws -> LiveCommand {
    guard let permission = nativePublicationPermissions[operation], actor.allows(permission),
      (data["permissions"] as? [String] ?? []).contains(permission) else { throw CatalogError("当前员工没有此内容操作权限") }
    let section = operation.hasPrefix("profile") ? "profile" : operation.hasPrefix("privacy") ? "privacy" : "contact"
    guard let versions = data["versions"] as? [String: Any], let version = versions[section] as? String, managementHash(version) else { throw StaffAPIError.invalid }
    let f = NativeManagementInput(values: fields)
    var body: [String: Any] = ["expectedVersion": version, "reason": try f.required("reason", 2...500)]
    var target: Any = NSNull(), code: Any = NSNull(), summary = ""
    if operation == "profile-draft" {
      let employee = try originalRow("employees", id: f.text("employeeId"))
      body["employeeId"] = employee.id; target = employee.id; body["publicDisplayName"] = try f.required("publicDisplayName", 1...80)
      summary = "为 " + employee.text("displayName") + " 新建公开服务名草稿：" + f.text("publicDisplayName")
    } else if operation == "privacy-draft" {
      let value = f.text("policyVersion")
      guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$", options: .regularExpression) != nil else { throw CatalogError("政策版本编号格式不正确") }
      body["policyVersion"] = value; code = value
      for (key, limits) in [("content", 80...50000), ("operatorName", 2...200), ("contact", 2...500), ("dataRetentionPolicyVersion", 2...80), ("thirdPartyRegisterVersion", 2...80)] { body[key] = try f.required(key, limits) }
      summary = "新建隐私草稿 " + value + "\n运营主体：" + f.text("operatorName") + "\n联系渠道：" + f.text("contact") + "\n保留规则：" + f.text("dataRetentionPolicyVersion") + "\n第三方清单：" + f.text("thirdPartyRegisterVersion") + "\n\n" + f.text("content")
    } else if operation == "contact" {
      let phone = f.text("phone"), state = f.text("rolloutState"), qr = f.text("wecomQrImageUrl")
      guard phone.range(of: "^[+0-9][0-9 -]{5,30}$", options: .regularExpression) != nil,
        ["disabled", "pilot", "enabled"].contains(state),
        qr.isEmpty || qr.range(of: "^/api/public/media-assets/MA[0-9A-F]{32}$", options: .regularExpression) != nil else { throw CatalogError("请核对电话号码、开放状态和图片库二维码") }
      body["rolloutState"] = state
      body["configuration"] = ["phone": phone, "phoneLabel": try f.required("phoneLabel", 2...40),
        "wecomName": try f.required("wecomName", 2...40), "wecomQrImageUrl": qr.isEmpty ? NSNull() : qr as Any]
      summary = "联系门店：" + f.text("phoneLabel") + " " + phone + "\n企业微信：" + f.text("wecomName") + "\n开放状态：" + (["disabled": "关闭", "pilot": "试点", "enabled": "开放"][state] ?? "")
    } else {
      let row = try originalRow(section == "profile" ? "profiles" : "policies", id: rowID)
      let publishing = operation.hasSuffix("publish")
      guard row.text("status") == (publishing ? "draft" : "published") else { throw CatalogError("原内容状态已变化，请刷新") }
      target = row.id
      if section == "profile" { body["profileId"] = row.id; summary = row.text("publicDisplayName") }
      else { body["policyVersion"] = row.text("policyVersion"); code = row.text("policyVersion"); summary = "隐私政策 " + row.text("policyVersion") }
      if publishing {
        guard !row.text("draftedByEmployeeId").isEmpty, row.text("draftedByEmployeeId") != actor.employee.id,
          section != "profile" || row.text("employeeId") != actor.employee.id else { throw CatalogError("必须由独立员工核对并发布") }
        body["approvalReference"] = try f.required("approvalReference", 8...240)
        // This API accepts immediate release only. Freeze its exact original time
        // in the payload before sending; uncertain recovery never updates it.
        body["effectiveAt"] = ISO8601DateFormatter().string(from: Date())
        if section == "privacy" { body["approvedBy"] = try f.required("approvedBy", 2...200) }
        summary = "立即发布 " + summary + "\n批准材料：" + f.text("approvalReference")
        if section == "privacy" { summary += "\n实际批准人：" + f.text("approvedBy") }
      } else { summary = "撤回 " + summary + "\n顾客将不再看到该发布内容。" }
    }
    summary += "\n原因：" + f.text("reason") + "\n只登记实际已取得的批准；不生成或代签批准材料。"
    return try makeSettingsCommand(actor: actor, operation: operation, body: body,
      target: target, targetCode: code, expected: version, confirmation: summary)
  }
}
