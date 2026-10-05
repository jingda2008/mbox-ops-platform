import Foundation
private final class ContentSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws { bytes = nil }
}
@main struct NativeCustomerContentTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ label: String) { precondition(condition, label); count += 1; print("PASS " + label) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func reject(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let hash = String(repeating: "a", count: 64), afterHash = String(repeating: "b", count: 64)
    let permissions = ["community.activity.view", "community.activity.manage", "community.activity.publish", "recommendation.rule.view", "recommendation.rule.draft", "recommendation.rule.approve", "recommendation.rule.publish"]
    var auth: [String: Any] = ["employee": ["id": id(1), "code": "content", "displayName": "内容管理", "roleCodes": []],
      "session": ["id": id(2), "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "permissions": permissions, "deniedPermissions": [], "navigation": [["route": "/staff/customer-experience"]]]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: data(auth))
    let home: [String: Any] = ["code": "HOME-ORIGINAL", "nativeVersion": hash, "status": "draft", "type": "article", "title": "原首页内容", "summary": "原来的展示说明", "imageUrl": NSNull(), "ctaLabel": "查看详情", "targetPath": "/pages/community/index", "priority": 10, "displayMode": "rotation", "visibility": "segment", "audienceMemberLevels": ["gold", "silver"], "audienceLifecycleStages": ["active"], "validFrom": "2098-01-01 08:00:00+00", "validUntil": "2099-01-01 08:00:00+00", "publishedByEmployeeId": NSNull()]
    var liveHome = home; liveHome["status"] = "published"; liveHome["code"] = "HOME-LIVE"; liveHome["publishedByEmployeeId"] = id(5)
    let popup: [String: Any] = ["version": 0, "enabled": false, "title": "原弹窗", "content": "", "frequency": "daily", "productIds": [], "products": []]
    let config: [String: Any] = ["recommendationInput": ["version": 1, "questions": [["code": "occasion", "title": "今天的场景"]], "strategy": ["paidOrderHistoryWeight": 10, "multiGuestHistoryConfidenceBasisPoints": 2000]], "preservedOldOption": ["allow": false]]
    var policy: [String: Any] = ["publicId": "RECOMMEND-original", "nativeVersion": hash, "code": "DEFAULT", "version": 2, "status": "draft", "createdByEmployeeId": id(5), "approvedByEmployeeId": NSNull(), "publishedByEmployeeId": NSNull(), "explanationTemplate": "根据明确偏好推荐", "displayConfiguration": config, "publicationMode": "controlled", "effectiveFrom": NSNull()]
    for key in nativeRecommendationWeights.keys { policy[key] = 10 }
    policy.merge(["minimumGrossMarginBasisPoints": 1500, "preferenceHalfLifeDays": 90, "preferenceMaxAgeDays": 730, "preferenceMinEffectiveScore": 1000, "preferenceMinConfidenceBasisPoints": 2500]) { _, new in new }
    var approved = policy; approved["publicId"] = "RECOMMEND-approved"; approved["status"] = "approved"; approved["approvedByEmployeeId"] = id(6)
    let feature: [String: Any] = ["rolloutState": "disabled", "nativeVersion": hash, "configuration": ["retained": "original-feature-config"], "reason": "尚未开放", "effectiveFrom": NSNull()]
    func boardData(_ module: NativeManagementModule, override: [String: Any] = [:]) -> [String: Any] {
      var d: [String: Any] = ["employeeId": id(1), "protocol": 1, "durableCommands": true]
      if module == .homeContent { d.merge(["rows": [home, liveHome], "next": NSNull()]) { _, new in new } }
      if module == .launchPopup { d["row"] = popup }
      if module == .recommendations { d.merge(["code": "DEFAULT", "latest": 2, "defaultDisplayConfiguration": config, "feature": feature, "rows": [policy, approved], "next": NSNull()]) { _, new in new } }
      d.merge(override) { _, new in new }; return d
    }
    func board(_ module: NativeManagementModule, override: [String: Any] = [:]) throws -> NativeManagementBoard { try NativeManagementBoard(module: module, data: data(["data": boardData(module, override: override)]), actor: actor) }
    var homeFields = home.reduce(into: [String: String]()) { out, item in
      if let value = item.value as? String { out[item.key] = value }; if let value = item.value as? Int { out[item.key] = String(value) }
    }
    homeFields.merge(["code": "HOME-NEW", "reason": "核对真实展示内容", "imageUrl": "", "validFrom": "2098-01-01T08:00:00Z", "validUntil": "2099-01-01T08:00:00Z", "audienceMemberLevels": "[\"silver\",\"gold\"]", "audienceLifecycleStages": "[\"active\"]"]) { _, new in new }
    var recommendationFields = policy.reduce(into: [String: String]()) { out, item in
      if let value = item.value as? String { out[item.key] = value }; if let value = item.value as? Int { out[item.key] = String(value) }
    }
    recommendationFields.merge(["reason": "独立核对推荐规则", "effectiveFrom": "2098-10-06T08:00:00Z", "rolloutState": "enabled"]) { _, new in new }
    let popupFields = ["reason": "调整真实弹窗展示", "enabled": "true", "title": "今日推荐", "content": "实际门店说明", "frequency": "session", "productIds": "[\"\(id(11))\",\"\(id(12))\"]"]
    func make(_ module: NativeManagementModule, _ op: String, row: String? = nil, fields: [String: String]? = nil, override: [String: Any] = [:]) throws -> LiveCommand {
      try board(module, override: override).command(actor: actor, operation: op, fields: fields ?? (module == .homeContent ? homeFields : module == .launchPopup ? popupFields : recommendationFields), rowID: row)
    }
    let originals = try [make(.homeContent, "create"), make(.homeContent, "update", row: "HOME-ORIGINAL"), make(.homeContent, "publish", row: "HOME-ORIGINAL"), make(.homeContent, "pause", row: "HOME-LIVE"), make(.launchPopup, "save"), make(.recommendations, "create"), make(.recommendations, "clone", row: "RECOMMEND-original"), make(.recommendations, "approve", row: "RECOMMEND-original"), make(.recommendations, "publish", row: "RECOMMEND-approved"), make(.recommendations, "rollout")]
    func reply(_ command: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let step = command.steps[0], b = step.object, p = step.nativeManagementProof!, op = p["operation"] as! String
      let module = NativeManagementModule(rawValue: p["module"] as! String)!, before = p["before"] as? [String: Any]
      var row: [String: Any]
      if module == .homeContent {
        row = ["create", "update"].contains(op) ? b : before!
        row["nativeVersion"] = afterHash; row["status"] = op == "publish" ? "published" : op == "pause" ? "paused" : "draft"
        row["publishedByEmployeeId"] = op == "publish" ? id(1) : op == "pause" ? before!["publishedByEmployeeId"]! : NSNull()
        // PostgreSQL text timestamps differ from request ISO formatting.
        row["validFrom"] = "2098-01-01 08:00:00+00"; row["validUntil"] = "2099-01-01 08:00:00+00"
      } else if module == .launchPopup { row = b; row["version"] = 2 }
      else if op == "rollout" { row = feature; row["rolloutState"] = b["rolloutState"]; row["reason"] = b["reason"]; row["nativeVersion"] = afterHash }
      else {
        row = op == "create" ? b : before!; row["nativeVersion"] = afterHash
        row["status"] = op == "approve" ? "approved" : op == "publish" ? "published" : "draft"
        if op == "create" || op == "clone" { row["publicId"] = "RECOMMEND-new"; row["version"] = 3; row["createdByEmployeeId"] = id(1); row["draftReason"] = b["reason"] }
        if op == "approve" { row["approvedByEmployeeId"] = id(1); row["approvalReason"] = b["reason"] }
        if op == "publish" { row["publishedByEmployeeId"] = id(1); row["publicationReason"] = b["reason"]; row["effectiveFrom"] = "2098-10-06 08:00:00+00" }
      }
      var d: [String: Any] = ["employeeId": id(1), "requestKey": step.key, "row": row]
      if module != .launchPopup { d["action"] = op }
      if module == .recommendations { d["accepted"] = b }
      return ["data": d, "meta": ["protocol": 1, "replayed": replayed]]
    }
    for original in originals {
      let step = original.steps[0], p = step.nativeManagementProof!, module = NativeManagementModule(rawValue: p["module"] as! String)!, op = p["operation"] as! String
      check(validNativeManagementSelection(command: original, board: try board(module), actor: actor), "\(module).\(op) current exact board admits original operation")
      var payloads: [String: String] = [:], receipts: [String: String] = [:]
      let secure = try secureNativeManagementCommand(original) { payloads[$0] = $1 }
      let body = try nativeManagementRequestBody(secure, step: secure.steps[0], actor: actor) { payloads[$0]! }
      check(managementJSONEqual(body, original.steps[0].object), "\(module).\(op) immutable safe payload preserves full original request")
      try recordNativeManagementAcknowledgement(data(reply(original)), command: secure, step: secure.steps[0], actor: actor, readPayload: { payloads[$0]! }, readReceipt: { receipts[$0] }, storeReceipt: { receipts[$0] = $1 })
      check(try hasNativeManagementAcknowledgement(secure, readPayload: { payloads[$0]! }, readReceipt: { receipts[$0] }), "\(module).\(op) real-shaped response binds safe acknowledgement")
      var altered = reply(original), changed = altered["data"] as! [String: Any]; changed["employeeId"] = id(99); altered["data"] = changed
      check(reject { try validateNativeManagementReply(data(altered), step: secure.steps[0], body: body) }, "\(module).\(op) foreign actor receipt rejected")
      altered = reply(original); changed = altered["data"] as! [String: Any]; var alteredRow = changed["row"] as! [String: Any]
      if module == .homeContent { alteredRow["targetPath"] = "/pages/privacy/index" }
      else if module == .launchPopup { alteredRow["productIds"] = [id(12), id(11)] }
      else if op == "rollout" { alteredRow["configuration"] = [:] }
      else { alteredRow["preferenceWeight"] = -900 }
      changed["row"] = alteredRow; altered["data"] = changed
      check(reject { try validateNativeManagementReply(data(altered), step: secure.steps[0], body: body) }, "\(module).\(op) changed content, product order or policy cannot become success")
      var requests = 0, saved = try JSONEncoder().encode(secure)
      let api = StaffAPI(transport: { request in
        if request.url!.path == "/api/auth/login" { return (try data(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        requests += 1
        guard request.url!.path == step.path, request.httpMethod == "POST", request.value(forHTTPHeaderField: "idempotency-key") == step.key,
          let posted = request.httpBody, managementJSONEqual(try JSONSerialization.jsonObject(with: posted), body) else { throw StaffAPIError.invalid }
        if requests == 1 { throw URLError(.timedOut) }
        return (try data(reply(original, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      }, store: ContentSessionStore())
      _ = try await api.login(code: "content", pin: "1234", switching: false)
      func send(_ current: LiveCommand, _ s: LiveCommand.Step) async throws {
        let originalBody = try nativeManagementRequestBody(current, step: s, actor: actor) { payloads[$0]! }
        let response = try await api.raw(s.path, body: originalBody, headers: [s.keyHeader: s.key]).0
        try validateNativeManagementReply(response, step: s, body: originalBody)
      }
      do { _ = try await LiveCommandRunner.advance(secure, send: { try await send(secure, $0) }, checkpoint: { saved = try JSONEncoder().encode($0) }); preconditionFailure() } catch {}
      let restart = try JSONDecoder().decode(LiveCommand.self, from: saved)
      let done = try await LiveCommandRunner.advance(restart, send: { try await send(restart, $0) }, checkpoint: { _ in })
      check(done.completedSteps == 1 && requests == 2, "\(module).\(op) lost reply recovers identical original key and body through real StaffAPI")
    }
    check(originals[4].steps[0].path == "/api/staff/native-launch-popup", "popup uses actual unsuffixed POST contract")
    check(originals[5].steps[0].object["rolloutState"] == nil && originals[8].steps[0].object["rolloutState"] == nil, "creating or publishing rules never silently changes customer rollout")
    check(originals[9].steps[0].object["publicId"] == nil && originals[9].steps[0].object["effectiveFrom"] == nil, "rollout is a separate original feature-version request")
    check(reject { _ = try make(.homeContent, "update", row: "HOME-LIVE") }, "published home content must pause before editing")
    check(reject { _ = try make(.homeContent, "pause", row: "HOME-ORIGINAL") }, "draft content cannot pretend it was published")
    var values = homeFields; values["audienceMemberLevels"] = "[]"; values["audienceLifecycleStages"] = "[]"
    check(reject { _ = try make(.homeContent, "create", fields: values) }, "segment visibility requires actual selected audience")
    values = homeFields; values["visibility"] = "public"
    check(reject { _ = try make(.homeContent, "create", fields: values) }, "public content cannot retain hidden segment restrictions")
    values = homeFields; values["targetPath"] = "/pages/community/index?redirect=https://external.invalid"
    check(reject { _ = try make(.homeContent, "create", fields: values) }, "unapproved deep link parameters fail closed")
    values = homeFields; values["imageUrl"] = "https://external.invalid/image.jpg"
    check(reject { _ = try make(.homeContent, "create", fields: values) }, "home images require controlled internal media assets")
    values = homeFields; values["validUntil"] = "2097-01-01T00:00:00Z"
    check(reject { _ = try make(.homeContent, "create", fields: values) }, "home display schedule must end after its start")
    values = popupFields; values["productIds"] = "[\"\(id(11))\",\"\(id(11))\"]"
    check(reject { _ = try make(.launchPopup, "save", fields: values) }, "popup rejects duplicate product selections")
    var ownDraft = policy; ownDraft["createdByEmployeeId"] = id(1)
    check(reject { _ = try make(.recommendations, "approve", row: "RECOMMEND-original", override: ["rows": [ownDraft]]) }, "draft author cannot independently approve own recommendation")
    var ownApproval = approved; ownApproval["approvedByEmployeeId"] = id(1)
    check(reject { _ = try make(.recommendations, "publish", row: "RECOMMEND-approved", override: ["rows": [ownApproval]]) }, "approver cannot also publish recommendation")
    values = recommendationFields; values["preferenceMaxAgeDays"] = "30"; values["preferenceHalfLifeDays"] = "90"
    check(reject { _ = try make(.recommendations, "create", fields: values) }, "recommendation lifetime cannot be shorter than half-life")
    check(!validNativeManagementSelection(command: originals[5], board: try board(.recommendations, override: ["latest": 3]), actor: actor), "stale latest version cannot create a new draft")
    var changedFeature = feature; changedFeature["nativeVersion"] = afterHash
    check(!validNativeManagementSelection(command: originals[9], board: try board(.recommendations, override: ["feature": changedFeature]), actor: actor), "stale rollout state cannot be replaced without re-reading")
    check(try nativeManagementReadPath(module: .recommendations, cursor: "2", code: "SPECIAL") == "/api/staff/native-recommendation-policies?code=SPECIAL&cursor=2", "recommendation policy pagination preserves original selected policy code")
    check(reject { _ = try nativeManagementReadPath(module: .recommendations, cursor: "0") }, "invalid history cursor cannot escape controlled query")
    let safePath = try nativeManagementOptionsPath(module: .homeContent, search: "a&cursor=foreign", cursor: "")
    check(URLComponents(string: safePath)?.queryItems?.first?.value == "a&cursor=foreign", "activity search is URL encoded instead of becoming another parameter")
    check(reject { _ = try nativeManagementOptionsPath(module: .publication, search: "", cursor: "") }, "only explicitly supported modules can read option endpoints")
    var requestPaths: [String] = []
    let api = StaffAPI(transport: { request in
      requestPaths.append(request.url!.absoluteString)
      let reply: [String: Any]
      if ["/api/auth/login", "/api/auth/heartbeat"].contains(request.url!.path) { reply = ["data": auth] }
      else if request.url!.path == "/api/staff/native-home-content/activity-options" { reply = ["data": ["employeeId": id(1), "protocol": 1, "durableCommands": true, "rows": [["id": "activity-real-0001", "name": "真实活动"]], "next": NSNull()]] }
      else { reply = ["data": boardData(.recommendations)] }
      return (try data(reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }, store: ContentSessionStore())
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    model.identity = try await api.login(code: "content", pin: "1234", switching: false)
    await model.loadNativeManagement(.recommendations, cursor: "2", code: "DEFAULT")
    check(model.canUseNativeManagement && requestPaths.last?.hasSuffix("?code=DEFAULT&cursor=2") == true, "real AppModel reads requested original policy page after heartbeat")
    let options = try await model.readNativeManagementOptions(module: .homeContent, search: "真实")
    check(try NativeContentOptions(options, actor: actor, module: .homeContent).rows.count == 1, "real AppModel activity options remain bound to current staff")
    auth["permissions"] = ["community.activity.view"]
    let beforeReads = requestPaths.filter { $0.contains("activity-options") }.count
    var denied = false
    do { _ = try await model.readNativeManagementOptions(module: .homeContent) } catch { denied = true }
    check(denied && requestPaths.filter { $0.contains("activity-options") }.count == beforeReads, "view-only content reader cannot request manage-only activity options")
    print("Native customer content: \(count) checks passed")
  }
}
