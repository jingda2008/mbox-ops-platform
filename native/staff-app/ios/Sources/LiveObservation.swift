import Foundation

let observationExpressions = [
  "objective_fact": "客观事实", "customer_quote": "客人原话", "staff_judgement": "员工判断",
  "system_inference": "系统推测",
]
let observationTypes = [
  "remaining": "剩余情况", "consumed_little": "食用较少", "praise": "表扬", "complaint": "投诉",
  "too_sweet": "太甜", "too_cold": "太冷", "served_late": "上菜较晚", "presentation": "呈现问题",
  "portion": "份量问题", "other": "其他",
]
let observationDegrees = [
  "little": "少量", "half": "约一半", "most": "大部分", "almost_untouched": "几乎未动", "unknown": "不确定",
]
let recommendationReasons = [
  "customer_request": "客人要求", "availability_substitution": "库存替代", "service_recovery": "服务补救",
  "staff_judgement": "员工判断",
]
struct ObservationDraft: Decodable {
  struct Candidate: Decodable, Identifiable {
    let id, productId, productName, orderItemId, rawMention: String
    let confidence: Double
  }
  let publicId, status, inputKind, rawContent: String
  let parseConfidence: Double
  let needsImmediateAction, clarificationRequired: Bool
  let serviceTaskId, clarificationPrompt: String?
  let candidates: [Candidate]
}
struct ObservationEvent: Decodable, Identifiable {
  let id, eventGroupId, expressionKind, scopeKind, eventType: String
  let revision: Int
  let degree, reasonCode, seatLabel, customerId, productId, productName, selectedCandidateId,
    rawExcerpt: String?
  let confidence: Double
}
struct ObservationBoard: Decodable {
  struct History: Decodable {
    struct Permissions: Decodable { let canCorrect, canViewRaw: Bool }
    struct Item: Decodable, Identifiable {
      struct Revision: Decodable, Identifiable { let id, reason, createdAt, correctedBy: String }
      let publicId, recordedBy, confirmedBy, confirmedAt: String
      let rawContent, serviceTaskId, serviceTaskStatus: String?
      let events: [ObservationEvent]
      let revisions: [Revision]
      var id: String { publicId }
    }
    let permissions: Permissions
    let items: [Item]
  }
  let tableSessionId: String
  let durable: Bool
  let draft: ObservationDraft?
  let history: History
  func parse(raw: String, immediate: Bool, actor: StaffIdentity) throws -> LiveCommand {
    let raw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard durable, actor.allows("observation.record"), (2...2000).contains(raw.utf16.count) else {
      throw CatalogError("请填写2—2000字现场事实，并核对记录权限")
    }
    return try ObservationCommands.make(
      actor: actor, title: "识别桌台观察", permission: "observation.record",
      path: "/api/staff/native-table-sessions/" + LiveCommand.pathPart(tableSessionId)
        + "/observations/parse",
      body: ["rawContent": raw, "inputKind": "text", "needsImmediateAction": immediate],
      proof: [
        "kind": "parse", "tableSessionId": tableSessionId,
        "confirmation": raw + "\n" + (immediate ? "核对确认后会生成现场服务任务。" : "识别结果仍需逐项核对后确认。"),
      ])
  }
  func confirm(
    candidate: String, expression: String, type: String, degree: String, excerpt: String,
    actor: StaffIdentity
  ) throws -> LiveCommand {
    guard durable, actor.allows("observation.confirm"), let draft, draft.status == "draft",
      candidate.isEmpty || draft.candidates.contains(where: { $0.id == candidate })
    else { throw CatalogError("原草稿已变化或无确认权限，请刷新") }
    let selected = draft.candidates.first { $0.id == candidate }
    let event = try ObservationCommands.event(
      expression: expression, type: type, degree: degree, excerpt: excerpt,
      scope: selected == nil ? "table" : "product", candidate: selected?.id,
      product: selected?.productId,
      confidence: selected?.confidence ?? min(draft.parseConfidence, 0.5))
    return try ObservationCommands.make(
      actor: actor, title: "确认桌台观察", permission: "observation.confirm",
      path: "/api/staff/native-observations/" + LiveCommand.pathPart(draft.publicId) + "/confirm",
      body: ["events": [event]],
      proof: [
        "kind": "confirm", "tableSessionId": tableSessionId, "publicId": draft.publicId,
        "immediate": draft.needsImmediateAction,
        "confirmation": excerpt + "\n" + (observationExpressions[expression] ?? "") + " · "
          + (observationTypes[type] ?? "") + "\n" + (selected?.productName ?? "不关联具体商品")
          + "\n确认后保留原记录；资金和赠送须另行处理。",
      ])
  }
  func revise(
    publicId: String, eventID: String, expression: String, type: String, degree: String,
    reason: String, actor: StaffIdentity
  ) throws -> LiveCommand {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard durable, history.permissions.canCorrect, history.permissions.canViewRaw,
      actor.allows("observation.correct"), (2...500).contains(reason.utf16.count),
      let row = history.items.first(where: { $0.publicId == publicId }),
      let old = row.events.first(where: { $0.id == eventID }), let excerpt = old.rawExcerpt
    else { throw CatalogError("请核对原观察、原文权限和修订原因") }
    var event = try ObservationCommands.event(
      expression: expression, type: type, degree: degree, excerpt: excerpt, scope: old.scopeKind,
      candidate: old.selectedCandidateId, product: old.productId, confidence: old.confidence)
    event["reasonCode"] = old.reasonCode as Any? ?? NSNull()
    event["seatLabel"] = old.seatLabel as Any? ?? NSNull()
    event["customerId"] = old.customerId as Any? ?? NSNull()
    return try ObservationCommands.make(
      actor: actor, title: "修订桌台观察", permission: "observation.correct",
      path: "/api/staff/native-observations/" + LiveCommand.pathPart(publicId) + "/events/"
        + LiveCommand.pathPart(eventID) + "/revise",
      body: ["reason": reason, "replacement": event],
      proof: [
        "kind": "revise", "tableSessionId": tableSessionId, "publicId": publicId,
        "eventId": eventID, "eventGroupId": old.eventGroupId, "revision": old.revision + 1,
        "confirmation": excerpt + "\n修订为：" + (observationExpressions[expression] ?? "") + " · "
          + (observationTypes[type] ?? "") + "\n" + reason + "\n追加修订，保留原记录及商品关联。",
      ])
  }
}
struct RecommendationBoard: Decodable {
  struct Snapshot: Decodable {
    struct Option: Decodable, Identifiable {
      let productId, productName, tier, currency: String
      let rank, amountMinor: Int
      var id: String { productId }
    }
    let recommendationPublicId, tableSessionId, createdAt: String
    let options: [Option]
  }
  let durable: Bool
  let tableSessionId: String
  let snapshot: Snapshot?
  func command(source: String, target: String, reason: String, actor: StaffIdentity) throws
    -> LiveCommand
  {
    guard durable, actor.allows("recommendation.staff.modify"), let snapshot,
      snapshot.tableSessionId == tableSessionId, source != target,
      recommendationReasons[reason] != nil,
      let a = snapshot.options.first(where: { $0.productId == source }),
      let b = snapshot.options.first(where: { $0.productId == target })
    else { throw CatalogError("请在本桌原推荐快照中选择不同商品及调整原因") }
    return try ObservationCommands.make(
      actor: actor, title: "调整本桌推荐", permission: "recommendation.staff.modify",
      path: "/api/staff/native-customer-experience/recommendations/"
        + LiveCommand.pathPart(snapshot.recommendationPublicId) + "/modifications",
      body: ["sourceProductId": source, "targetProductId": target, "reasonCode": reason],
      proof: [
        "kind": "recommendation", "tableSessionId": tableSessionId,
        "publicId": snapshot.recommendationPublicId, "employeeId": actor.employee.id,
        "confirmation": a.productName + " → " + b.productName + "\n" + recommendationReasons[
          reason]! + "\n仅记录推荐调整，不修改订单、价格或收款。",
      ])
  }
}
enum ObservationCommands {
  static func event(
    expression: String, type: String, degree: String, excerpt: String, scope: String,
    candidate: String?, product: String?, confidence: Double
  ) throws -> [String: Any] {
    let excerpt = excerpt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard observationExpressions[expression] != nil, observationTypes[type] != nil,
      degree.isEmpty || observationDegrees[degree] != nil, (1...1000).contains(excerpt.utf16.count),
      confidence.isFinite, (0...1).contains(confidence)
    else { throw CatalogError("请明确区分客观事实、原话和判断，并核对原文片段") }
    return [
      "expressionKind": expression, "scopeKind": scope, "eventType": type,
      "degree": degree.isEmpty ? NSNull() : degree as Any, "reasonCode": NSNull(),
      "seatLabel": NSNull(), "customerId": NSNull(), "candidateId": candidate as Any? ?? NSNull(),
      "productId": product as Any? ?? NSNull(), "confidence": confidence, "rawExcerpt": excerpt,
    ]
  }
  static func make(
    actor: StaffIdentity, title: String, permission: String, path: String, body: [String: Any],
    proof: [String: Any]
  ) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-business-" + id,
          recoveryBody: try JSONSerialization.data(
            withJSONObject: ["observation": proof], options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var observationProof: [String: Any]? {
    guard let recoveryBody,
      let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return root["observation"] as? [String: Any]
  }
}
func validateObservationReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.observationProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool
  else { throw StaffAPIError.invalid }
  let body = step.object
  func event(_ data: [String: Any], _ expected: [String: Any]) throws {
    guard let id = data["id"] as? String, !id.isEmpty else { throw StaffAPIError.invalid }
    for (key, input) in [
      "expressionKind": "expressionKind", "scopeKind": "scopeKind", "eventType": "eventType",
      "degree": "degree", "productId": "productId", "selectedCandidateId": "candidateId",
      "rawExcerpt": "rawExcerpt",
    ] {
      guard (data[key] as? NSObject) == (expected[input] as? NSObject) else {
        throw StaffAPIError.invalid
      }
    }
  }
  switch p["kind"] as? String {
  case "parse":
    guard let id = data["publicId"] as? String, !id.isEmpty, data["status"] as? String == "draft",
      data["rawContent"] as? String == body["rawContent"] as? String,
      data["needsImmediateAction"] as? Bool == body["needsImmediateAction"] as? Bool,
      data["candidates"] is [[String: Any]]
    else { throw StaffAPIError.invalid }
  case "confirm":
    guard data["publicId"] as? String == p["publicId"] as? String,
      data["status"] as? String == "confirmed", let rows = data["events"] as? [[String: Any]],
      let input = body["events"] as? [[String: Any]], rows.count == input.count, rows.count == 1,
      p["immediate"] as? Bool != true || !(data["serviceTaskId"] as? String ?? "").isEmpty
    else { throw StaffAPIError.invalid }
    try event(rows[0], input[0])
  case "revise":
    guard let replacement = body["replacement"] as? [String: Any],
      data["eventGroupId"] as? String == p["eventGroupId"] as? String,
      data["revision"] as? Int == p["revision"] as? Int,
      data["id"] as? String != p["eventId"] as? String
    else { throw StaffAPIError.invalid }
    try event(data, replacement)
  case "recommendation":
    guard !(data["eventId"] as? String ?? "").isEmpty,
      data["recommendationPublicId"] as? String == p["publicId"] as? String,
      data["tableSessionId"] as? String == p["tableSessionId"] as? String,
      data["employeeId"] as? String == p["employeeId"] as? String
    else { throw StaffAPIError.invalid }
    for key in ["sourceProductId", "targetProductId", "reasonCode"] {
      guard data[key] as? String == body[key] as? String else { throw StaffAPIError.invalid }
    }
  default: throw StaffAPIError.invalid
  }
}
