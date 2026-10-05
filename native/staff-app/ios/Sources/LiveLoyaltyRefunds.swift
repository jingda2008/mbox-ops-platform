import Foundation
import CoreFoundation
import CryptoKit
let loyaltyRefundRoot = "/api/staff/native-loyalty-refunds"
let loyaltyRefundRequestStatuses = ["requested": "待独立复核", "approved": "已通过", "rejected": "已驳回", "stale": "依据已变化", "superseded": "已被新申请替代"]
func canReadLoyaltyRefunds(_ actor: StaffIdentity) -> Bool { actor.allows("reconciliation.view") && actor.allows("loyalty.accrual.exception.view") }
func canWriteLoyaltyRefunds(_ actor: StaffIdentity, action: String) -> Bool { ["request", "decision"].contains(action) && actor.allows("reconciliation.manage") && actor.allows(action == "request" ? "loyalty.accrual.request" : "loyalty.accrual.approve") }
func loyaltyRefundVersion(_ text: String) -> Bool { text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
struct LoyaltyRefundRecord: Identifiable, Equatable {
  let data: Data
  init(_ value: [String: Any]) throws { data = try membershipData(value) }
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var id: String { text("refundId") }
  func text(_ key: String) -> String { membershipText(object[key]) }
  func rows(_ key: String) -> [[String: Any]] { object[key] as? [[String: Any]] ?? [] }
  func integer(_ key: String) throws -> Int { try walletInteger(object[key]) }
  var fingerprint: String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
func loyaltyRefundGroup(_ row: [String: Any]) throws {
  guard UUID(uuidString: membershipText(row["refundId"])) != nil, loyaltyPublicReference(membershipText(row["refundPublicId"])), let items = row["items"] as? [[String: Any]], items.count <= 1000 else { throw StaffAPIError.invalid }
  let total = try walletInteger(row["refundAmountMinor"]), excess = try walletInteger(row["excessAmountMinor"]), sales = try walletInteger(row["salesRefundAmountMinor"])
  guard excess <= total, sales == total - excess, Set(items.map { membershipText($0["orderItemId"]) }).count == items.count else { throw StaffAPIError.invalid }
  for item in items {
    guard UUID(uuidString: membershipText(item["orderItemId"])) != nil, !(item["productName"] as? String ?? "").isEmpty, let quantity = item["quantity"] as? NSNumber,
      CFGetTypeID(quantity) != CFBooleanGetTypeID(), quantity.doubleValue.isFinite, quantity.doubleValue > 0 else { throw StaffAPIError.invalid }
    let allocated = try walletInteger(item["refundAllocatedAmountMinor"]), max = try walletInteger(item["maxSalesReturnAmountMinor"])
    guard max <= allocated else { throw StaffAPIError.invalid }; _ = try walletBoolean(item["loyaltyEligible"])
  }
}
func loyaltyRefundAllocationLines(_ value: Any?) throws -> [[String: Any]] {
  guard let lines = value as? [[String: Any]], lines.count <= 1000, Set(lines.map { membershipText($0["orderItemId"]) }).count == lines.count else { throw StaffAPIError.invalid }
  for line in lines { guard UUID(uuidString: membershipText(line["orderItemId"])) != nil, try walletInteger(line["salesRefundAmountMinor"]) > 0 else { throw StaffAPIError.invalid } }; return lines
}
struct LoyaltyRefundBoard {
  let employeeID: String
  let enabled: Bool
  let page: Int
  let hasMore: Bool
  let rows: [LoyaltyRefundRecord]
  init(data: Data, actor: StaffIdentity, page: Int = 0) throws {
    _ = try Self.query(page: page); let d = try walletEnvelope(data)
    guard canReadLoyaltyRefunds(actor), d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1,
      try walletInteger(d["page"]) == page, let items = d["items"] as? [[String: Any]], items.count <= 100 else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; enabled = try walletBoolean(d["durableCommands"]); hasMore = try walletBoolean(d["hasMore"]); self.page = page
    rows = try items.map(LoyaltyRefundRecord.init); guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in rows {
      try loyaltyRefundGroup(row.object)
      guard row.text("currency") == "CNY", loyaltyPublicReference(row.text("orderPublicId")), loyaltyRefundVersion(row.text("basisVersion")), ["pending", "resolved"].contains(row.text("status")),
        row.object["blockingRefundPublicId"] is NSNull || loyaltyPublicReference(row.text("blockingRefundPublicId")), let history = row.object["historicalRefunds"] as? [[String: Any]], let requests = row.object["requests"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      guard history.count <= 1000, Set(history.map { membershipText($0["refundId"]) }).count == history.count, !history.contains(where: { $0["refundId"] as? String == row.id }), Set(requests.map { membershipText($0["requestId"]) }).count == requests.count else { throw StaffAPIError.invalid }
      for r in history { try loyaltyRefundGroup(r) }
      for request in requests {
        guard UUID(uuidString: membershipText(request["requestId"])) != nil, UUID(uuidString: membershipText(request["requestedByEmployeeId"])) != nil,
          loyaltyRefundVersion(membershipText(request["basisVersion"])), loyaltyRefundRequestStatuses[membershipText(request["status"])] != nil,
          assignmentDate(membershipText(request["createdAt"])) != nil, let historical = request["historicalAllocations"] as? [[String: Any]] else { throw StaffAPIError.invalid }
        _ = try loyaltyRefundAllocationLines(request["allocations"])
        guard Set(historical.map { membershipText($0["refundId"]) }).count == historical.count else { throw StaffAPIError.invalid }
        for group in historical { guard UUID(uuidString: membershipText(group["refundId"])) != nil else { throw StaffAPIError.invalid }; _ = try loyaltyRefundAllocationLines(group["allocations"]) }
      }
    }
  }
  static func query(page: Int = 0) throws -> String { guard (0...10000).contains(page) else { throw StaffAPIError.invalid }; return loyaltyRefundRoot + "?page=\(page)" }
  func canRequest(actor: StaffIdentity, row: LoyaltyRefundRecord) -> Bool {
    enabled && employeeID == actor.employee.id && canReadLoyaltyRefunds(actor) && canWriteLoyaltyRefunds(actor, action: "request") && rows.contains(row) && row.text("status") == "pending" && row.text("blockingRefundPublicId").isEmpty
  }
  func decisions(actor: StaffIdentity, row: LoyaltyRefundRecord, request: [String: Any]) -> [String] {
    guard enabled, employeeID == actor.employee.id, canReadLoyaltyRefunds(actor), canWriteLoyaltyRefunds(actor, action: "decision"), rows.contains(row),
      row.rows("requests").contains(where: { membershipEqual($0, request) }), request["requestedByEmployeeId"] as? String != actor.employee.id,
      ["requested", "stale", "superseded"].contains(membershipText(request["status"])) else { return [] }
    let canApprove = request["status"] as? String == "requested" && request["basisVersion"] as? String == row.text("basisVersion") && row.text("status") == "pending" && row.text("blockingRefundPublicId").isEmpty
    return canApprove ? ["reject", "approve"] : ["reject"]
  }
  func command(actor: StaffIdentity, row: LoyaltyRefundRecord, request: [String: Any]? = nil, decision: String = "reject", values: [String: String] = [:], reason rawReason: String, now: Date = Date()) throws -> LiveCommand {
    let action = request == nil ? "request" : "decision", reason = rawReason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard rows.contains(row), enabled, employeeID == actor.employee.id, canReadLoyaltyRefunds(actor), canWriteLoyaltyRefunds(actor, action: action), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true, (3...1000).contains(reason.utf16.count) else { throw CatalogError("请重新读取原退款，确认财务及积分权限，并填3至1000字实际依据") }
    var body: [String: Any] = ["reason": reason], details: String, title: String
    if let request {
      guard decisions(actor: actor, row: row, request: request).contains(decision) else { throw CatalogError("须由另一位授权员工核对原申请；变化或被替代的依据不能批准") }
      body["requestId"] = request["requestId"]; body["basisVersion"] = request["basisVersion"]; body["decision"] = decision
      title = decision == "approve" ? "同意原商品归属并调整积分" : "驳回原商品归属申请"
      details = try loyaltyRefundSubmittedSummary(row: row, request: request)
      details += "\n" + (decision == "approve" ? "由服务端按原账冲回积分与成长值，实际变化以原回执为准。" : "本次驳回不改变积分和成长值。")
    } else {
      guard canRequest(actor: actor, row: row) else { throw CatalogError("此退款已处理或有更早退款待复核，请先刷新原依据") }
      let history = try row.rows("historicalRefunds").map { group -> [String: Any] in ["refundId": membershipText(group["refundId"]), "allocations": try loyaltyRefundAllocations(group, values: values)] }
      body["refundId"] = row.id; body["basisVersion"] = row.text("basisVersion"); body["allocations"] = try loyaltyRefundAllocations(row.object, values: values); body["historicalAllocations"] = history
      title = "提交已退款商品归属申请"
      details = try loyaltyRefundEnteredSummary(row: row, values: values)
    }
    let id = UUID().uuidString.lowercased(), confirmation = title + "\n订单 " + row.text("orderPublicId") + "\n退款 " + row.text("refundPublicId") + "\n" + details + "\n依据：" + reason + "\n只核对已成功退款的原商品货款，不会再次退款。"
    let proof: [String: Any] = ["employeeId": employeeID, "action": action, "page": page, "refundId": row.id, "basisVersion": membershipText(body["basisVersion"]), "beforeSHA256": row.fingerprint, "confirmation": confirmation]
    let encoded = try membershipData(body); guard encoded.count <= 262144 else { throw CatalogError("此笔历史退款明细过大，请在网页中逐项复核") }
    return LiveCommand(id: id, employeeID: employeeID, title: title, permission: action == "request" ? "loyalty.accrual.request" : "loyalty.accrual.approve", steps: [.init(path: loyaltyRefundRoot + "/commands/" + action, body: encoded, keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["loyaltyRefund": proof]))])
  }
}
func loyaltyRefundAllocations(_ refund: [String: Any], values: [String: String]) throws -> [[String: Any]] {
  try loyaltyRefundGroup(refund); let prefix = membershipText(refund["refundId"]) + ":", items = refund["items"] as! [[String: Any]]
  var lines: [[String: Any]] = [], total = 0
  for item in items {
    let id = membershipText(item["orderItemId"])
    guard let text = values[prefix + id], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CatalogError("请逐项填写实际退回货款，未涉及必须填0") }
    let amount = try couponPolicyMoney(text)
    guard amount <= (try walletInteger(item["maxSalesReturnAmountMinor"])) else { throw CatalogError(membershipText(item["productName"]) + "超过可归属原货款") }
    guard total <= 9_007_199_254_740_991 - amount else { throw CatalogError("合计超过精确整数范围") }; total += amount
    if amount > 0 { lines.append(["orderItemId": id, "salesRefundAmountMinor": amount]) }
  }
  guard lines.count <= 200, total == (try walletInteger(refund["salesRefundAmountMinor"])) else { throw CatalogError("原货款归属合计必须等于本笔货款退款，不得包含溢收退款；最多200项非零分配") }; return lines
}
func loyaltyRefundEnteredSummary(row: LoyaltyRefundRecord, values: [String: String]) throws -> String {
  var lines: [String] = []
  for group in [row.object] + row.rows("historicalRefunds") {
    _ = try loyaltyRefundAllocations(group, values: values)
    lines.append("退款 " + membershipText(group["refundPublicId"]) + "：总额 ¥" + walletMoneyText(try walletInteger(group["refundAmountMinor"])) + "，溢收 ¥" + walletMoneyText(try walletInteger(group["excessAmountMinor"])) + "，货款 ¥" + walletMoneyText(try walletInteger(group["salesRefundAmountMinor"])))
    for item in group["items"] as! [[String: Any]] { let amount = try couponPolicyMoney(values[membershipText(group["refundId"]) + ":" + membershipText(item["orderItemId"])] ?? ""); lines.append(membershipText(item["productName"]) + " · 原数量 " + membershipText(item["quantity"]) + " · 归属 ¥" + walletMoneyText(amount) + (try walletBoolean(item["loyaltyEligible"]) ? " · 参与积分" : " · 不参与积分")) }
  }; return lines.joined(separator: "\n")
}
func loyaltyRefundSubmittedSummary(row: LoyaltyRefundRecord, request: [String: Any]) throws -> String {
  let groups = [row.object] + row.rows("historicalRefunds")
  var lines = ["申请人：" + membershipText(request["requestedByName"]), "申请依据：" + membershipText(request["reason"])]
  let allocations = [["refundId": row.id, "allocations": request["allocations"] ?? []] as [String: Any]] + (request["historicalAllocations"] as? [[String: Any]] ?? [])
  for group in allocations {
    let original = groups.first { $0["refundId"] as? String == group["refundId"] as? String }
    lines.append("退款 " + (original.map { membershipText($0["refundPublicId"]) } ?? membershipText(group["refundId"])))
    if let original {
      lines.append("退款总额 ¥" + walletMoneyText(try walletInteger(original["refundAmountMinor"])) + " · 溢收 ¥" + walletMoneyText(try walletInteger(original["excessAmountMinor"])) + " · 原货款 ¥" + walletMoneyText(try walletInteger(original["salesRefundAmountMinor"])))
    }
    for line in try loyaltyRefundAllocationLines(group["allocations"]) {
      let item = (original?["items"] as? [[String: Any]] ?? []).first { $0["orderItemId"] as? String == line["orderItemId"] as? String }
      var detail = (item.map { membershipText($0["productName"]) } ?? "原商品 " + membershipText(line["orderItemId"])) + " · 货款归属 ¥" + walletMoneyText(try walletInteger(line["salesRefundAmountMinor"]))
      if let item { detail += " · 原数量 " + membershipText(item["quantity"]) + (try walletBoolean(item["loyaltyEligible"]) ? " · 参与积分" : " · 不参与积分") }
      lines.append(detail)
    }
  }; return lines.joined(separator: "\n")
}
extension LiveCommand.Step { var loyaltyRefundProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["loyaltyRefund"] as? [String: Any] } }
func validLoyaltyRefundSelection(command: LiveCommand, board: LoyaltyRefundBoard, actor: StaffIdentity) -> Bool {
  guard command.steps.count == 1, let step = command.steps.first, let p = step.loyaltyRefundProof, let action = p["action"] as? String, command.employeeID == actor.employee.id, p["employeeId"] as? String == actor.employee.id,
    canReadLoyaltyRefunds(actor), canWriteLoyaltyRefunds(actor, action: action), board.enabled, board.employeeID == actor.employee.id,
    let row = board.rows.first(where: { $0.id == p["refundId"] as? String && $0.fingerprint == p["beforeSHA256"] as? String }) else { return false }
  if action == "request" { return board.canRequest(actor: actor, row: row) }
  guard let request = row.rows("requests").first(where: { $0["requestId"] as? String == step.object["requestId"] as? String }) else { return false }
  return board.decisions(actor: actor, row: row, request: request).contains(membershipText(step.object["decision"]))
}
func validateLoyaltyRefundReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let meta = root["meta"] as? [String: Any], try walletInteger(meta["protocol"]) == 1,
    let d = root["data"] as? [String: Any], let p = step.loyaltyRefundProof, let action = p["action"] as? String, ["request", "decision"].contains(action), step.path == loyaltyRefundRoot + "/commands/" + action,
    d["employeeId"] as? String == p["employeeId"] as? String, d["action"] as? String == action, d["requestKey"] as? String == step.key, let result = d["result"] as? [String: Any],
    UUID(uuidString: membershipText(result["requestId"])) != nil, result["refundId"] as? String == p["refundId"] as? String,
    result["status"] as? String == (action == "request" ? "requested" : step.object["decision"] as? String == "approve" ? "approved" : "rejected") else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"])
  if action == "decision" { guard result["requestId"] as? String == step.object["requestId"] as? String else { throw StaffAPIError.invalid } }
  let points = try loyaltySignedInteger(result["pointsDelta"]), growth = try loyaltySignedInteger(result["growthDelta"])
  if action == "request" || step.object["decision"] as? String == "reject" { guard points == 0, growth == 0 else { throw StaffAPIError.invalid } }
  else { guard points <= 0, growth <= 0 else { throw CatalogError("退款积分回执不能增加原奖励") } }
}
