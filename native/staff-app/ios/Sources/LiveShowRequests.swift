import Foundation

let showSongStatuses = ["requested": "待受理", "confirming": "待确认", "accepted": "已报价", "paid": "已收款", "performed": "已演唱", "rejected": "已拒绝", "cancelled": "已取消"]
let showSongActions = ["confirm": "确认点歌报价", "reject": "拒绝点歌", "paid": "关联已收原付款", "performed": "确认已演唱", "cancel": "取消点歌"]
struct ShowSong: Identifiable, Equatable {
  let row: ShowRow
  var id: String { row.id }
  var tableSessionID: String { row.text("tableSessionId") }
  var status: String { row.text("status") }
  var title: String { row.text("songTitle") }
  var amount: Int? { try? showInteger(row.object["quotedAmountMinor"]) }
  init(_ value: [String: Any]) throws {
    row = try ShowRow(value); _ = try showUUID(value["tableSessionId"])
    guard showSongStatuses[status] != nil, !title.isEmpty else { throw StaffAPIError.invalid }
    if !(value["quotedAmountMinor"] is NSNull) { _ = try showInteger(value["quotedAmountMinor"]) }
  }
  func actions(_ actor: StaffIdentity) -> [String] {
    var result: [String] = []
    if actor.allows("song.manage") {
      if ["requested", "confirming"].contains(status) { result += ["confirm", "reject"] }
      if ["requested", "confirming", "accepted"].contains(status) { result.append("cancel") }
      if status == "paid" || (status == "accepted" && amount == 0) { result.append("performed") }
    }
    if actor.allows("song.payment.record"), status == "accepted", (amount ?? 0) > 0, row.text("currency") == "CNY" { result.append("paid") }
    return result
  }
}
struct ShowSongBoard {
  let employeeID: String, sessionID: String, status: String
  let enabled: Bool
  let rows: [ShowSong]
  init(data: Data, capability: Data, actor: StaffIdentity, status: String) throws {
    guard actor.allows("song.view") || actor.allows("song.manage"), status.isEmpty || showSongStatuses[status] != nil,
      let list = try showObject(data)["data"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; self.status = status; enabled = try showFlag(showData(capability)["durableTransitions"])
    rows = try list.map(ShowSong.init)
    guard rows.count <= 500, Set(rows.map(\.id)).count == rows.count, rows.allSatisfy({ status.isEmpty || $0.status == status }) else { throw StaffAPIError.invalid }
  }
  func command(actor: StaffIdentity, row: ShowSong, action: String, reason: String, amountText: String = "", evidence: ShowPaymentEvidence? = nil) throws -> LiveCommand {
    guard enabled, employeeID == actor.employee.id, sessionID == actor.session.id, rows.contains(row), row.actions(actor).contains(action),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else { throw CatalogError("点歌原状态、登录或权限已变化，请刷新") }
    let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...500).contains(explanation.utf16.count) else { throw CatalogError("请填写2至500字处理说明") }
    var body: [String: Any] = ["expectedStatus": row.status, "reason": explanation]
    let next = ["confirm": "accepted", "reject": "rejected", "paid": "paid", "performed": "performed", "cancel": "cancelled"][action]!
    var amount = row.amount; var currency: Any = row.row.object["currency"] ?? NSNull()
    if action == "confirm" { amount = try showMoneyInput(amountText); currency = "CNY"; body["quotedAmountMinor"] = amount!; body["currency"] = "CNY" }
    if action == "paid" {
      guard let evidence, evidence.requestID == row.id, evidence.employeeID == employeeID, evidence.sessionID == sessionID,
        evidence.amount == amount, evidence.currency == row.row.text("currency") else { throw CatalogError("请重新读取并选择此点歌对应的原付款和对账凭证") }
      body["paymentId"] = evidence.paymentID; body["reconciliationEntryId"] = evidence.reconciliationID
    }
    let expectation: [String: Any] = ["id": row.id, "tableSessionId": row.tableSessionID, "status": next,
      "quotedAmountMinor": amount.map { $0 as Any } ?? NSNull(), "currency": currency]
    var lines = [row.title, (showSongStatuses[row.status] ?? row.status) + " → " + (showSongStatuses[next] ?? next)]
    if let amount { lines.append("报价：" + showMinor(amount) + "元") }
    if let evidence { lines.append("原付款：" + evidence.publicID) }
    lines.append("说明：" + explanation)
    lines.append(action == "paid" ? "仅关联已经收妥的原付款与对账凭证，不再次扣款；请核对该付款确用于本次点歌。" : action == "performed" ? "请在实际演唱完成后确认。" : action == "confirm" ? "确认报价不会收款，付费点歌须核对原付款后才能确认演唱。" : action == "cancel" ? "取消点歌不会自动退款；已收款点歌不能在此取消。" : "请确认已向客人说明。")
    let command = try makeShowCommand(actor: actor, kind: "song", action: action, body: body, target: row.id, confirmation: lines.joined(separator: "\n"))
    let step = command.steps[0]; var proof = step.showProof!; proof["expectation"] = expectation
    return LiveCommand(id: command.id, employeeID: command.employeeID, title: command.title, permission: command.permission,
      steps: [.init(path: step.path, body: step.body, keyHeader: step.keyHeader, key: step.key, recoveryBody: try showBytes(["show": proof]))])
  }
}
struct ShowPaymentEvidence: Identifiable {
  let employeeID: String, sessionID: String, requestID: String, paymentID: String, reconciliationID: String, publicID: String, currency: String, createdAt: String, provider: String
  let amount: Int
  var id: String { reconciliationID }
  init(_ raw: [String: Any], request: ShowSong, actor: StaffIdentity) throws {
    guard actor.allows("song.payment.record"), request.status == "accepted", request.row.text("currency") == "CNY",
      let text = raw["amountMinor"] as? String, text.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
      let amount = Int(text), amount <= 9_007_199_254_740_991, amount == request.amount,
      raw["currency"] as? String == request.row.text("currency") else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; requestID = request.id
    paymentID = try showUUID(raw["paymentId"]); reconciliationID = try showUUID(raw["reconciliationEntryId"])
    publicID = try showString(raw, "publicId", max: 128); currency = "CNY"; self.amount = amount
    createdAt = showText(raw, "createdAt"); provider = showText(raw, "provider")
  }
}
func showMoneyInput(_ text: String) throws -> Int {
  guard text.range(of: "^(0|[1-9][0-9]{0,13})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError("报价须为非负金额，最多两位小数，免费填0") }
  let parts = text.split(separator: ".").map(String.init)
  let amount = Int(parts[0])! * 100 + (parts.count == 2 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
  guard amount <= 9_007_199_254_740_991 else { throw CatalogError("报价超过支持范围") }; return amount
}
func showMinor(_ amount: Int) -> String { String(amount / 100) + "." + String(format: "%02d", amount % 100) }
func validateShowSongReceipt(_ bytes: Data, step: LiveCommand.Step, body: [String: Any], expectation: [String: Any]) throws -> ShowReceipt {
  let root = try showObject(bytes)
  guard let meta = root["meta"] as? [String: Any], let data = root["data"] as? [String: Any], let raw = data["request"] as? [String: Any],
    let proof = step.showProof, proof["kind"] as? String == "song", let action = proof["action"] as? String, let employee = proof["employeeId"] as? String,
    data["action"] as? String == action, data["previousStatus"] as? String == body["expectedStatus"] as? String,
    data["reason"] as? String == body["reason"] as? String else { throw StaffAPIError.invalid }
  _ = try showFlag(meta["replayed"]); let request = try ShowSong(raw)
  guard request.id == proof["target"] as? String else { throw StaffAPIError.invalid }
  for key in ["id", "tableSessionId", "status", "quotedAmountMinor", "currency"] {
    guard let expected = expectation[key], let actual = raw[key], try showBytes(["value": expected]) == showBytes(["value": actual]) else { throw CatalogError("点歌原对象、状态或金额回执不一致，请保留原请求") }
  }
  for key in ["paymentId", "reconciliationEntryId"] {
    guard let actual = data[key], try showBytes(["value": actual]) == showBytes(["value": body[key] ?? NSNull()]) else { throw CatalogError("原付款关联回执不一致，请保留原请求") }
  }
  return ShowReceipt(employeeID: employee, requestKey: step.key, kind: "song", action: action, result: try showBytes(data))
}
