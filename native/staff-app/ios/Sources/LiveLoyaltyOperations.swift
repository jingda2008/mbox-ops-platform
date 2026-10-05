import Foundation
import CoreFoundation
import CryptoKit

enum LoyaltyOperationKind: String, Identifiable {
  case benefit, supplement
  var id: String { rawValue }
  var root: String { "/api/staff/native-" + (self == .benefit ? "benefit-exceptions" : "loyalty-supplements") }
  var readPermission: String { self == .benefit ? "loyalty.redemption.exception" : "loyalty.accrual.exception.view" }
  var title: String { self == .benefit ? "礼遇出品异常" : "积分对账与补发" }
}
let benefitExceptionActions = ["retry": "重试原礼遇出品", "cancel_release": "取消并释放占用", "external_compensation": "登记已完成线下补偿"]
let supplementActions = ["request": "申请原积分核对", "approve": "独立审核并补发", "reject": "驳回原补发申请"]
let supplementStatuses = ["missing": "原订单未入积分", "mismatch": "原账需核对", "matched": "原账已匹配", "refund_review_required": "先复核退款归属", "requested": "待独立审核", "approved": "已审核", "rejected": "已驳回", "executed": "已按原账补发", "not_required": "核对后无需补发"]
func loyaltyPublicReference(_ text: String) -> Bool { text.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$", options: .regularExpression) != nil }
struct LoyaltyOperationRecord: Identifiable, Equatable {
  let data: Data
  init(_ value: [String: Any]) throws { data = try membershipData(value) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { for key in ["id", "publicId", "orderPublicId"] { if !text(key).isEmpty { return text(key) } }; return "" }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  var fingerprint: String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
struct LoyaltyOperationsBoard {
  let kind: LoyaltyOperationKind
  let employeeID: String
  let enabled: Bool
  let section: String
  let page: Int
  let hasMore: Bool
  let rows: [LoyaltyOperationRecord]
  init(kind: LoyaltyOperationKind, data: Data, actor: StaffIdentity, section: String = "reconciliation", page: Int = 0) throws {
    _ = try Self.query(kind: kind, section: section, page: page)
    let d = try walletEnvelope(data)
    guard actor.allows(kind.readPermission), d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1,
      try walletInteger(d["page"]) == page, let items = d["items"] as? [[String: Any]], items.count <= 100,
      kind == .benefit || d["section"] as? String == section else { throw StaffAPIError.invalid }
    self.kind = kind; self.section = section; self.page = page; employeeID = actor.employee.id; enabled = try walletBoolean(d["durableCommands"]); hasMore = try walletBoolean(d["hasMore"])
    rows = try items.map(LoyaltyOperationRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows {
      guard loyaltyPublicReference(row.text("orderPublicId")) else { throw StaffAPIError.invalid }
      if kind == .benefit {
        for key in ["id", "orderId", "benefitId", "tableSessionId"] { guard UUID(uuidString: row.text(key)) != nil else { throw StaffAPIError.invalid } }
        guard ["retry", "failed"].contains(row.text("status")), !row.text("tableCode").isEmpty, assignmentDate(row.text("updatedAt")) != nil else { throw StaffAPIError.invalid }; _ = try row.integer("attemptCount")
      } else {
        guard !row.text("memberNo").isEmpty, supplementStatuses[row.text("status")] != nil else { throw StaffAPIError.invalid }
        if section == "reconciliation" {
          guard ["missing", "mismatch", "matched", "refund_review_required"].contains(row.text("status")), let refunds = row.object["reviewRefundPublicIds"] as? [String], refunds.allSatisfy(loyaltyPublicReference) else { throw StaffAPIError.invalid }
          for key in ["eligibleAmountMinor", "expectedPoints", "expectedGrowth", "existingPoints", "existingGrowth"] { _ = try row.integer(key) }
        } else {
          guard row.text("publicId").hasPrefix("LSP-"), UUID(uuidString: String(row.text("publicId").dropFirst(4))) != nil, UUID(uuidString: row.text("requestedByEmployeeId")) != nil,
            assignmentDate(row.text("createdAt")) != nil, ["requested", "approved", "executed", "not_required", "rejected"].contains(row.text("status")) else { throw StaffAPIError.invalid }
          for key in ["requestedPoints", "requestedGrowth"] { _ = try row.integer(key) }
        }
      }
    }
  }
  static func query(kind: LoyaltyOperationKind, section: String = "reconciliation", page: Int = 0) throws -> String {
    guard (0...10000).contains(page), ["reconciliation", "requests"].contains(section) else { throw StaffAPIError.invalid }
    return kind.root + "?page=\(page)" + (kind == .supplement ? "&section=" + section : "")
  }
  func actions(row: LoyaltyOperationRecord, actor: StaffIdentity) -> [String] {
    guard enabled, employeeID == actor.employee.id, actor.allows(kind.readPermission), rows.contains(row) else { return [] }
    if kind == .benefit { return row.text("status") == "failed" ? ["retry", "cancel_release", "external_compensation"] : row.text("status") == "retry" ? ["retry"] : [] }
    if section == "reconciliation", ["missing", "mismatch"].contains(row.text("status")), actor.allows("loyalty.accrual.request") { return ["request"] }
    if section == "requests", row.text("status") == "requested", actor.allows("loyalty.accrual.approve"), row.text("requestedByEmployeeId") != actor.employee.id { return ["approve", "reject"] }
    return []
  }
  func command(actor: StaffIdentity, action: String, row: LoyaltyOperationRecord, reason rawReason: String, reference rawReference: String = "", externallyCompleted: Bool = false, now: Date = Date()) throws -> LiveCommand {
    guard actions(row: row, actor: actor).contains(action), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("原记录、当前权限或处理状态已变化，请重新读取") }
    let reason = try couponPolicyReason(rawReason), reference = rawReference.trimmingCharacters(in: .whitespacesAndNewlines)
    var body: [String: Any], details: String, binding: [String: Any] = ["orderPublicId": row.text("orderPublicId")]
    let title = kind == .benefit ? benefitExceptionActions[action]! : supplementActions[action]!
    let permission = kind == .benefit ? kind.readPermission : action == "request" ? "loyalty.accrual.request" : "loyalty.accrual.approve"
    if kind == .benefit {
      if action == "external_compensation" { guard externallyCompleted, (2...200).contains(reference.utf16.count) else { throw CatalogError("请核对补偿已实际完成，并填写原凭证编号") } }
      var expected: [String: Any] = [:]
      for key in ["orderId", "benefitId", "tableSessionId", "updatedAt", "attemptCount"] { expected[key] = row.object[key] }
      body = ["intentId": row.id, "expected": expected, "reason": reason, "compensationReference": action == "external_compensation" ? reference : NSNull() as Any]
      details = row.text("tableCode") + "桌 · " + row.text("orderPublicId") + "\n" + (row.text("title").isEmpty ? "原礼遇" : row.text("title")) + "\n已尝试 " + row.text("attemptCount") + " 次"
      details += action == "retry" ? "\n仅重试原履约任务，不新发一份礼遇。请先核对厨房与现场实物，防止重复交付。" : action == "cancel_release" ? "\n取消原零元礼遇出品并释放未消耗占用，不自动恢复已使用权益。" : "\n原补偿凭证：" + reference + "\n只登记已完成补偿，不自动付款、发券或加积分。"
      binding["intentId"] = row.id
    } else {
      let original = action == "request" ? row.text("orderPublicId") : row.text("publicId")
      body = ["publicId": original, "reason": reason]; binding["sourcePublicId"] = original
      details = "订单 " + row.text("orderPublicId") + "\n会员 " + row.text("memberNo")
      if action == "request" { details += "\n原货款 ¥" + walletMoneyText(try row.integer("eligibleAmountMinor")) + "\n原规则积分 " + row.text("expectedPoints") + " / 已记 " + row.text("existingPoints") + "\n原规则成长 " + row.text("expectedGrowth") + " / 已记 " + row.text("existingGrowth") }
      else { details += "\n原申请 " + row.id + "\n申请积分 " + row.text("requestedPoints") + " · 成长 " + row.text("requestedGrowth") }
      details += "\n依据原收退款与原规则重新核算，最终积分及成长以执行回读为准；不手工指定奖励，不执行收退款。"
    }
    let id = UUID().uuidString.lowercased(), proof: [String: Any] = ["kind": kind.rawValue, "action": action, "employeeId": employeeID, "section": section, "page": page, "beforeId": row.id, "beforeSHA256": row.fingerprint, "binding": binding, "confirmation": title + "\n" + details + "\n依据：" + reason]
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: permission, steps: [.init(path: kind.root + "/commands/" + action, body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["loyaltyOperation": proof]))])
  }
}
extension LiveCommand.Step { var loyaltyOperationProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["loyaltyOperation"] as? [String: Any] } }
func validLoyaltyOperationSelection(command: LiveCommand, board: LoyaltyOperationsBoard, actor: StaffIdentity) -> Bool {
  guard command.steps.count == 1, let step = command.steps.first, let p = step.loyaltyOperationProof, command.employeeID == actor.employee.id, p["employeeId"] as? String == actor.employee.id,
    actor.allows(command.permission), actor.allows(board.kind.readPermission), board.employeeID == actor.employee.id, board.enabled, p["kind"] as? String == board.kind.rawValue,
    p["section"] as? String == board.section, let action = p["action"] as? String else { return false }
  return board.rows.contains { $0.id == p["beforeId"] as? String && $0.fingerprint == p["beforeSHA256"] as? String && board.actions(row: $0, actor: actor).contains(action) }
}
func validateLoyaltyOperationReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1,
    let d = root["data"] as? [String: Any], let p = step.loyaltyOperationProof, let kind = LoyaltyOperationKind(rawValue: membershipText(p["kind"])), let action = p["action"] as? String,
    step.path == kind.root + "/commands/" + action, d["employeeId"] as? String == p["employeeId"] as? String, d["action"] as? String == action,
    d["requestKey"] as? String == step.key, let result = d["result"] as? [String: Any], let binding = p["binding"] as? [String: Any] else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); let body = step.object
  if kind == .benefit {
    guard let expected = body["expected"] as? [String: Any], body["intentId"] as? String == binding["intentId"] as? String,
      result["intentId"] as? String == body["intentId"] as? String, result["orderId"] as? String == expected["orderId"] as? String,
      result["benefitId"] as? String == expected["benefitId"] as? String, result["status"] as? String == ["retry": "pending", "cancel_release": "cancelled", "external_compensation": "compensated"][action] else { throw StaffAPIError.invalid }
    if action != "retry" {
      guard result["action"] as? String == action, result["resolvedByEmployeeId"] as? String == p["employeeId"] as? String,
        result["reason"] as? String == body["reason"] as? String, membershipEqual(["reference": result["compensationReference"] ?? NSNull()], ["reference": body["compensationReference"] ?? NSNull()]) else { throw StaffAPIError.invalid }
      for key in ["releasedInventoryReservationCount", "releasedCapacityReservationCount", "cancelledKdsTaskCount", "cancelledOrderItemCount"] { _ = try walletInteger(result[key]) }
    }
  } else {
    guard d["sourcePublicId"] as? String == body["publicId"] as? String, body["publicId"] as? String == binding["sourcePublicId"] as? String,
      let publicID = result["publicId"] as? String, publicID.hasPrefix("LSP-"), UUID(uuidString: String(publicID.dropFirst(4))) != nil else { throw StaffAPIError.invalid }
    if action == "request" { guard result["status"] as? String == "requested" else { throw StaffAPIError.invalid }; _ = try walletInteger(result["requestedPoints"]); _ = try walletInteger(result["requestedGrowth"]) }
    else {
      guard publicID == body["publicId"] as? String, let status = result["status"] as? String, (action == "reject" ? ["rejected"] : action == "approve" ? ["executed", "not_required"] : []).contains(status) else { throw StaffAPIError.invalid }
      let points = try loyaltySignedInteger(result["pointsDelta"]), growth = try loyaltySignedInteger(result["growthDelta"])
      if status == "rejected" { guard points == 0, growth == 0 else { throw StaffAPIError.invalid } }
    }
  }
}

// Supplement execution can also apply original historical refunds. Its final
// account delta is signed even when no new gross award is required.
func loyaltySignedInteger(_ value: Any?) throws -> Int {
  guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
    n.stringValue.range(of: "^-?(0|[1-9][0-9]*)$", options: .regularExpression) != nil,
    let integer = Int(n.stringValue), (-9_007_199_254_740_991...9_007_199_254_740_991).contains(integer) else { throw StaffAPIError.invalid }
  return integer
}
