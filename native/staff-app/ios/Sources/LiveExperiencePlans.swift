import Foundation
import CryptoKit

let experiencePlansRoot = "/api/staff/native-experience-plans"
let experiencePlanStates = ["planned": "待原订单确认", "active": "服务中", "paused": "已暂停", "completed": "已完成", "cancelled": "已中止"]
let experienceCueStates = ["pending": "等待触发", "ready": "待派出", "dispatched": "任务已派出", "completed": "已完成", "skipped": "已停止", "failed": "异常待核对"]
let experienceActions = ["welcome": "迎宾", "service": "桌边服务", "drink": "酒水服务", "food": "餐食服务", "music": "音乐提醒", "interaction": "互动服务", "checkin": "到店关怀", "upsell": "加购建议", "farewell": "离店服务"]
let experiencePlanPermissions = ["customer.experience.manage", "service.manage", "service.execute"]
struct ExperiencePlanQuery: Equatable {
  var history = false
  var from = ""
  var to = ""
  func suffix(next: [String: Any]? = nil) throws -> String {
    var values = [URLQueryItem(name: "history", value: history ? "true" : "false")]
    func date(_ value: String) throws -> Date {
      let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
      guard value.range(of: "^20[0-9]{2}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil, let d = f.date(from: value), f.string(from: d) == value else { throw CatalogError("请填写有效营业日 YYYY-MM-DD") }; return d
    }
    if history {
      let a = try date(from), b = try date(to)
      guard b >= a, b.timeIntervalSince(a) <= 60 * 86400 else { throw CatalogError("营业日范围须在60天内") }
      values += [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to)]
    }
    if let next {
      let value = try showString(next, "beforeDate"); _ = try date(value)
      values += [URLQueryItem(name: "beforeDate", value: value), URLQueryItem(name: "beforeId", value: try showUUID(next["beforeId"]))]
    }
    var c = URLComponents(); c.queryItems = values; return "?" + (c.percentEncodedQuery ?? "")
  }
}
struct ExperiencePlansBoard {
  let employeeID: String, sessionID: String
  let enabled: Bool, canManage: Bool
  let rows: [ShowRow]
  let next: [String: Any]?
  init(_ bytes: Data, actor: StaffIdentity) throws {
    let data = try showData(bytes)
    guard data["employeeId"] as? String == actor.employee.id, actor.allows("customer.experience.manage"), actor.allows("service.execute"), try showInteger(data["protocol"]) == 1, let rows = data["rows"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; enabled = try showFlag(data["durableCommands"]); canManage = try showFlag(data["canManage"]); self.rows = try rows.map(ShowRow.init)
    guard Set(self.rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    for row in self.rows {
      _ = try showUUID(row.object["table_session_id"]); _ = try showFingerprint(row.object["expectedVersion"]); _ = try showInteger(row.object["plan_version"], min: 1)
      guard experiencePlanStates[row.text("plan_state")] != nil, let cues = row.object["cues"] as? [[String: Any]], let tasks = row.object["tasks"] as? [[String: Any]] else { throw StaffAPIError.invalid }
      for value in cues + tasks { _ = try showUUID(value["id"]) }
      guard Set(cues.map { showText($0,"id") }).count == cues.count, Set(tasks.map { showText($0,"id") }).count == tasks.count else { throw StaffAPIError.invalid }
    }
    let hasMore = try showFlag(data["hasMore"])
    next = data["next"] as? [String: Any]
    guard hasMore == (next != nil) else { throw StaffAPIError.invalid }
    if let next { _ = try ExperiencePlanQuery().suffix(next: next) }
  }
  func command(actor: StaffIdentity, row: ShowRow, action: String, reason: String, cueID: String? = nil, minutes: Int? = nil) throws -> LiveCommand {
    guard enabled, canManage, employeeID == actor.employee.id, sessionID == actor.session.id, experiencePlanPermissions.allSatisfy(actor.allows), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
      rows.contains(row), ["active", "paused"].contains(row.text("plan_state")), ["open", "closing"].contains(row.text("session_status")) else { throw CatalogError("当前身份、权限或计划状态已变化，请重新读取") }
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (4...500).contains(reason.utf16.count) else { throw CatalogError("请填写4至500字的现场处理依据") }
    let state = row.text("plan_state"), tasks = row.object["tasks"] as? [[String: Any]] ?? []
    var body: [String: Any] = ["action": action, "expectedVersion": row.text("expectedVersion"), "reason": reason]
    let label: String, message: String
    switch action {
    case "pause":
      guard state == "active", !tasks.contains(where: { ["pending", "acknowledged", "in_progress"].contains(showText($0, "status")) }), cueID == nil, minutes == nil else { throw CatalogError("已有派出任务时不能暂停，请先完成任务或整体中止") }
      label = "暂停计划"; message = "暂停后不再派出新节点；恢复时已到期的节点可能立即派出。"
    case "resume":
      guard state == "paused", cueID == nil, minutes == nil else { throw CatalogError("该计划不在暂停状态") }; label = "恢复计划"; message = "恢复后已到期的节点可能立即派出，请核对现场。"
    case "cancel":
      guard cueID == nil, minutes == nil else { throw StaffAPIError.invalid }; label = "中止计划"; message = "停止未完成节点并取消关联服务任务。已完成记录、原订单和付款保留；退款或补偿须另走原流程。"
    case "reschedule":
      guard let cueID, let minutes, (0...240).contains(minutes), let cue = (row.object["cues"] as? [[String: Any]])?.first(where: { $0["id"] as? String == cueID }), cue["trigger_kind"] as? String == "elapsed", ["pending", "ready"].contains(showText(cue,"status")), cue["service_task_id"] is NSNull,
        let activated = showServerDate(row.text("activated_at")), activated.addingTimeInterval(Double(minutes) * 60) > Date() else { throw CatalogError("只能调整未派出节点，时间须在激活后0至240分钟内且尚未到达") }
      body["cueId"] = cueID; body["offsetMinutes"] = minutes; label = "调整服务时间"; message = "将节点调整为计划激活后\(minutes)分钟；已派出任务不能在这里改时。"
    default: throw StaffAPIError.invalid
    }
    let id = UUID().uuidString.lowercased()
    let proof: [String: Any] = ["employeeId": employeeID, "planId": row.id, "tableSessionId": row.text("table_session_id"), "action": action,
      "state": action == "cancel" ? "cancelled" : action == "pause" ? "paused" : action == "resume" ? "active" : state, "planVersion": try showInteger(row.object["plan_version"], min: 1) + 1,
      "cueId": cueID as Any? ?? NSNull(), "offsetMinutes": minutes as Any? ?? NSNull(), "confirmation": row.text("table_code") + " · " + label + "\n" + message + "\n原因：" + reason]
    return LiveCommand(id: id, employeeID: employeeID, title: label, permission: "customer.experience.manage", steps: [.init(path: experiencePlansRoot + "/" + row.id, body: try showBytes(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try showBytes(["experiencePlan": proof]))])
  }
}
extension LiveCommand.Step {
  var experiencePlanProof: [String: Any]? { guard let recoveryBody else { return nil }; return (try? showObject(recoveryBody))?["experiencePlan"] as? [String: Any] }
}
func secureExperiencePlanCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, var proof = step.experiencePlanProof else { return command }
  guard command.steps.count == 1, proof["payloadKey"] == nil else { throw StaffAPIError.invalid }
  let data = try showBytes(["body": step.object, "proof": proof]), secret = SymmetricKey(size: .bits256), key = "live-experience-" + command.id
  try store(key, String(decoding: try showBytes(["payload": data.base64EncodedString(), "authenticationKey": secret.withUnsafeBytes { Data($0).base64EncodedString() }]), as: UTF8.self))
  proof.removeValue(forKey: "confirmation"); proof["payloadKey"] = key; proof["payloadAuthentication"] = HMAC<SHA256>.authenticationCode(for: data, using: secret).map { String(format: "%02x",$0) }.joined()
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对体验计划原请求", permission: command.permission, steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key, recoveryBody: try showBytes(["experiencePlan":proof]))], completedSteps:command.completedSteps,rejected:command.rejected)
}
func experiencePlanRequestBody(_ command: LiveCommand, step: LiveCommand.Step, read: (String) throws -> String) throws -> [String: Any] {
  guard command.steps.count == 1, command.steps.first == step, command.permission == "customer.experience.manage", UUID(uuidString: command.id) != nil, command.id == command.id.lowercased(), step.body == Data("{}".utf8), step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    let p = step.experiencePlanProof, p["employeeId"] as? String == command.employeeID, step.path == experiencePlansRoot + "/" + (try showUUID(p["planId"])), ["pause","resume","cancel","reschedule"].contains(p["action"] as? String ?? ""), let key = p["payloadKey"] as? String, key == "live-experience-" + command.id, p["confirmation"] == nil, let tag = p["payloadAuthentication"] as? String else { throw StaffAPIError.invalid }
  let envelope = try showObject(Data(try read(key).utf8))
  guard let encoded = envelope["payload"] as? String, let data = Data(base64Encoded: encoded), let encodedKey = envelope["authenticationKey"] as? String, let keyData = Data(base64Encoded: encodedKey), keyData.count == 32,
    HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data:keyData)).map({ String(format:"%02x",$0) }).joined() == tag,
    let body = try showObject(data)["body"] as? [String:Any], var original = try showObject(data)["proof"] as? [String:Any] else { throw CatalogError("原体验计划安全载荷不可核对，未发送") }
  original.removeValue(forKey:"confirmation"); var metadata = p; metadata.removeValue(forKey:"payloadKey");metadata.removeValue(forKey:"payloadAuthentication")
  guard NSDictionary(dictionary: original).isEqual(to:metadata), body["action"] as? String == p["action"] as? String else { throw StaffAPIError.invalid }; return body
}
struct ExperiencePlanReceipt: Equatable { let requestKey: String, action: String, planID: String, state: String }
func validateExperiencePlanReply(_ bytes: Data, step: LiveCommand.Step) throws -> ExperiencePlanReceipt {
  let root = try showObject(bytes)
  guard let meta = root["meta"] as? [String:Any], try showInteger(meta["protocol"]) == 1, let data = root["data"] as? [String:Any], let p = step.experiencePlanProof, data["requestKey"] as? String == step.key else { throw StaffAPIError.invalid }
  _ = try showFlag(meta["replayed"])
  for key in ["employeeId","planId","tableSessionId","action","state","planVersion","cueId","offsetMinutes"] {
    guard let actual = data[key], let expected = p[key], NSDictionary(dictionary:["value":actual]).isEqual(to:["value":expected]) else { throw CatalogError("原计划回执不一致，请保留原请求核对") }
  }
  return ExperiencePlanReceipt(requestKey:step.key,action:try showString(data,"action"),planID:try showUUID(data["planId"]),state:try showString(data,"state"))
}
