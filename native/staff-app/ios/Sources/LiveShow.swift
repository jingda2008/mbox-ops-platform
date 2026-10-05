import Foundation
import CoreFoundation
import CryptoKit

let showRoot = "/api/staff/native-performances"
let showPermissions = ["song.view", "song.manage", "song.payment.record", "performance.phase.manage", "performance.schedule.revise", "reservation.view"]
let showReadPermissions = ["song.view", "song.manage", "performance.phase.manage", "performance.schedule.revise"]
let showStatuses = ["scheduled": "待演出", "performing": "演出中", "completed": "已结束", "cancelled": "已取消"]
let showPhases = ["before_show": "开场前", "acoustic": "不插电", "band_live": "乐队现场", "intermission": "中场休息", "after_show": "演出后"]
let showActions = ["publish": "发布演出清单", "schedule-status": "变更演出状态", "schedule-sort": "调整演出排序", "revision": "修订原演出", "phase-start": "启动现场阶段", "phase-end": "结束现场阶段", "phase-cancel": "取消误启动阶段", "performer-create": "新增演员", "performer-update": "编辑演员", "songs-import": "维护完整曲库", "song-update": "编辑曲目"]
func showBytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
func showObject(_ bytes: Data) throws -> [String: Any] { guard let row = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw StaffAPIError.invalid }; return row }
func showData(_ bytes: Data) throws -> [String: Any] { guard let row = try showObject(bytes)["data"] as? [String: Any] else { throw StaffAPIError.invalid }; return row }
func showFlag(_ value: Any?) throws -> Bool { guard let v = value as? NSNumber, CFGetTypeID(v) == CFBooleanGetTypeID() else { throw StaffAPIError.invalid }; return v.boolValue }
func showText(_ row: [String: Any], _ key: String) -> String {
  if let v = row[key] as? String { return v }; if let v = row[key] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID() { return v.stringValue }; return ""
}
func showInteger(_ value: Any?, min: Int = 0, max: Int = 9_007_199_254_740_991) throws -> Int {
  guard let v = value as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), let n = Int(v.stringValue), (min...max).contains(n) else { throw StaffAPIError.invalid }; return n
}
func showString(_ row: [String: Any], _ key: String, min: Int = 1, max: Int = 240) throws -> String {
  guard let value = row[key] as? String, value == value.trimmingCharacters(in: .whitespacesAndNewlines), (min...max).contains(value.utf16.count) else { throw CatalogError("请核对必填文字及长度") }; return value
}
func showUUID(_ value: Any?) throws -> String { guard let value = value as? String, UUID(uuidString: value) != nil else { throw StaffAPIError.invalid }; return value }
func showFingerprint(_ value: Any?) throws -> String { guard let value = value as? String, value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CatalogError("原配置版本缺失，请重新读取") }; return value }
func showMonth(_ value: String) throws -> String { guard value.range(of: "^20[0-9]{2}-(0[1-9]|1[0-2])$", options: .regularExpression) != nil else { throw CatalogError("月份请填写 YYYY-MM") }; return value }
func showNowMonth() -> String { let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM"; return f.string(from: Date()) }
func showServerDate(_ text: String) -> Date? {
  if let date = StaffIdentity.date(text) { return date }
  guard text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?[+-][0-9]{2}(:?[0-9]{2})?$", options: .regularExpression) != nil else { return nil }
  var value = text.replacingOccurrences(of: " ", with: "T")
  if value.range(of: "[+-][0-9]{2}$", options: .regularExpression) != nil { value += ":00" }
  else if value.range(of: "[+-][0-9]{4}$", options: .regularExpression) != nil { value.insert(":", at: value.index(value.endIndex, offsetBy: -2)) }
  return StaffIdentity.date(value)
}
func showTime(_ value: String) -> String {
  guard let date = showServerDate(value) else { return "时间待核对" }
  let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd HH:mm"; return f.string(from: date)
}
func showInputTime(_ text: String) throws -> String {
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd HH:mm"; f.isLenient = false
  guard text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$", options: .regularExpression) != nil,
    let date = f.date(from: text), f.string(from: date) == text else { throw CatalogError("请填写北京时间 YYYY-MM-DD HH:mm") }
  return ISO8601DateFormatter().string(from: date)
}
struct ShowRow: Identifiable, Equatable {
  let bytes: Data
  var object: [String: Any] { (try? showObject(bytes)) ?? [:] }
  var id: String { text("id").isEmpty ? text("publicId") : text("id") }
  func text(_ key: String) -> String { showText(object, key) }
  init(_ value: [String: Any]) throws {
    let id = showText(value, "id"), publicID = showText(value, "publicId")
    guard UUID(uuidString: id) != nil || (id.isEmpty && publicID.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil) else { throw StaffAPIError.invalid }
    bytes = try showBytes(value)
  }
}
struct ShowBoard {
  let employeeID: String, sessionID: String, month: String
  let enabled: Bool
  let schedules, performers, phases, revisions: [ShowRow]
  init(_ bytes: Data, actor: StaffIdentity, month: String) throws {
    let raw = try showData(bytes)
    guard raw["employeeId"] as? String == actor.employee.id, raw["month"] as? String == month,
      showReadPermissions.contains(where: actor.allows), try showInteger(raw["protocol"]) == 1,
      let schedules = raw["schedules"] as? [[String: Any]], let performers = raw["performers"] as? [[String: Any]],
      let phases = raw["phases"] as? [[String: Any]], let revisions = raw["revisions"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; self.month = try showMonth(month); enabled = try showFlag(raw["durableCommands"])
    self.schedules = try schedules.map(ShowRow.init); self.performers = try performers.map(ShowRow.init); self.phases = try phases.map(ShowRow.init); self.revisions = try revisions.map(ShowRow.init)
    for rows in [self.schedules, self.performers, self.phases, self.revisions] { guard Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid } }
    for row in self.schedules + self.performers { _ = try showFingerprint(row.object["configurationFingerprint"]) }
  }
  func command(actor: StaffIdentity, action: String, body: [String: Any], confirmation: String,
    preview: ShowPublishPreview? = nil, catalog: ShowCatalog? = nil, replacementBoard: ShowBoard? = nil) throws -> LiveCommand {
    let permission = try showPermission(kind: "performance", action: action)
    guard enabled, actor.employee.id == employeeID, actor.session.id == sessionID, actor.allows(permission),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else { throw CatalogError("登录、权限或原演出资料已变化，请重新读取") }
    func keys(_ values: [String]) throws { guard Set(body.keys).isSubset(of: Set(values)) else { throw StaffAPIError.invalid } }
    func reason() throws { _ = try showString(body, "reason", min: 2) }
    func schedule() throws -> ShowRow {
      guard let row = schedules.first(where: { $0.id == body["scheduleId"] as? String }), row.text("configurationFingerprint") == body["expected"] as? String else { throw CatalogError("原场次版本已变化，请刷新") }; return row
    }
    switch action {
    case "publish":
      try keys(["month", "slots"]); try validateShowSlots(body, board: self)
      guard let preview, preview.original == (try showBytes(body)), preview.valid else { throw CatalogError("请先按本次完整清单预检演员与时间冲突") }
    case "schedule-status":
      try keys(["scheduleId", "expected", "targetStatus"]); let row = try schedule()
      let target = body["targetStatus"] as? String
      guard row.text("status") == "scheduled" && target == "performing" || row.text("status") == "performing" && target == "completed" else { throw CatalogError("演出状态已变化") }
      guard target != "completed" || !phases.contains(where: { $0.text("scheduleId") == row.id }) else { throw CatalogError("请先结束现场阶段，再结束演出") }
    case "schedule-sort":
      try keys(["scheduleId", "expected", "sortOrder"]); guard try schedule().text("status") == "scheduled" else { throw CatalogError("只可调整未开始场次的排序") }; _ = try showInteger(body["sortOrder"], max: 100000)
    case "revision":
      try keys(["scheduleId", "expected", "kind", "startsAt", "endsAt", "replacementScheduleId", "replacementExpected", "reason"]); try reason()
      let row = try schedule(); guard row.text("status") == "scheduled" else { throw CatalogError("请修订尚未开始的原场次") }
      switch body["kind"] as? String {
      case "rescheduled":
        guard let start = body["startsAt"] as? String, let end = body["endsAt"] as? String, let from = StaffIdentity.date(start), let until = StaffIdentity.date(end), until > from,
          body["replacementScheduleId"] is NSNull, body["replacementExpected"] is NSNull,
          from != showServerDate(row.text("startsAt")) || until != showServerDate(row.text("endsAt")) else { throw CatalogError("新时间无效、未变化或同时选择了替代场次") }
      case "cancelled": guard body["startsAt"] is NSNull, body["endsAt"] is NSNull, body["replacementScheduleId"] is NSNull, body["replacementExpected"] is NSNull else { throw StaffAPIError.invalid }
      case "replaced":
        let other = replacementBoard ?? self
        guard other.employeeID == employeeID, other.sessionID == sessionID, body["startsAt"] is NSNull, body["endsAt"] is NSNull,
          let next = other.schedules.first(where: { $0.id == body["replacementScheduleId"] as? String }), next.id != row.id,
          next.text("status") == "scheduled", next.text("configurationFingerprint") == body["replacementExpected"] as? String else { throw CatalogError("替代月份、场次或原版本已变化，请重新选择") }
      default: throw StaffAPIError.invalid
      }
    case "phase-start":
      try keys(["scheduleId", "expected", "phaseCode", "reason"]); try reason()
      guard try schedule().text("status") == "performing", phases.isEmpty, showPhases[body["phaseCode"] as? String ?? ""] != nil else { throw CatalogError("请核对演出进行中，且当前没有其他现场阶段") }
    case "phase-end", "phase-cancel":
      try keys(["publicId", "reason"]); try reason(); guard phases.contains(where: { $0.id == body["publicId"] as? String && $0.text("status") == "active" }) else { throw CatalogError("原现场阶段已结束或变化") }
    case "performer-create", "performer-update":
      try keys(action == "performer-create" ? ["code", "stageName", "profileSnapshot", "status"] : ["performerId", "expected", "stageName", "profileSnapshot", "status"])
      _ = try showString(body, "stageName", max: 120); guard let profile = body["profileSnapshot"] as? [String: Any], ["active", "inactive"].contains(body["status"] as? String ?? "") else { throw StaffAPIError.invalid }
      _ = try showBytes(profile)
      if action == "performer-create" { guard try showString(body, "code", min: 2, max: 64).range(of: "^[A-Z][A-Z0-9_]{1,63}$", options: .regularExpression) != nil else { throw CatalogError("演员编码须大写字母开头，至少两位，仅字母数字下划线") } }
      else { guard let original = performers.first(where: { $0.id == body["performerId"] as? String }), original.text("configurationFingerprint") == body["expected"] as? String else { throw CatalogError("原演员资料已变化") } }
    case "songs-import", "song-update":
      guard let catalog, catalog.employeeID == employeeID, catalog.sessionID == sessionID,
        performers.contains(where: { $0.id == catalog.performerID }) else { throw CatalogError("请读取所选演员完整曲库后办理") }
      if action == "songs-import" {
        try keys(["performerId", "expected", "sourceName", "mode", "songs"])
        guard body["performerId"] as? String == catalog.performerID, body["expected"] as? String == catalog.fingerprint,
          let songs = body["songs"] as? [[String: Any]], songs.count <= 5000, let mode = body["mode"] as? String,
          ["upsert", "replace"].contains(mode), mode == "replace" || !songs.isEmpty else { throw CatalogError("请核对原完整曲库版本、导入方式和清单") }
        _ = try showString(body, "sourceName"); for song in songs { try validateShowSong(song) }
        let keys = songs.map { (showText($0, "code").isEmpty ? showText($0, "title") : showText($0, "code")).lowercased() }
        guard Set(keys).count == keys.count else { throw CatalogError("导入清单存在重复编号或歌名") }
      } else {
        try keys(["songId", "expected", "changes"])
        guard let original = catalog.songs.first(where: { $0.id == body["songId"] as? String }), original.text("configurationFingerprint") == body["expected"] as? String, let changes = body["changes"] as? [String: Any] else { throw CatalogError("原曲目已变化，请重新查询") }
        try validateShowSong(changes)
      }
    default: throw StaffAPIError.invalid
    }
    return try makeShowCommand(actor: actor, kind: "performance", action: action, body: body, target: nil, confirmation: confirmation)
  }
}
struct ShowPublishPreview {
  let original: Data
  let rows: [[String: Any]]
  var valid: Bool { rows.allSatisfy { ($0["reasons"] as? [String])?.isEmpty == true } }
  init(body: [String: Any], response: Data, board: ShowBoard) throws {
    try validateShowSlots(body, board: board)
    guard let rows = try showData(response)["slots"] as? [[String: Any]], let input = body["slots"] as? [[String: Any]], rows.count == input.count else { throw StaffAPIError.invalid }
    func slotKey(_ value: [String: Any]) throws -> String {
      guard let start = StaffIdentity.date(showText(value, "startsAt")), let end = StaffIdentity.date(showText(value, "endsAt")) else { throw StaffAPIError.invalid }
      return try showUUID(value["performerId"]) + "|" + String(start.timeIntervalSince1970) + "|" + String(end.timeIntervalSince1970)
    }
    guard try rows.map(slotKey).sorted() == input.map(slotKey).sorted() else { throw StaffAPIError.invalid }
    for row in rows {
      guard row["reasons"] is [String], row["performerName"] is String else { throw StaffAPIError.invalid }
      if let id = row["existingId"], !(id is NSNull) { _ = try showUUID(id) }
    }
    original = try showBytes(body); self.rows = rows
  }
}
func validateShowSlots(_ body: [String: Any], board: ShowBoard) throws {
  guard body["month"] as? String == board.month, let slots = body["slots"] as? [[String: Any]], (1...155).contains(slots.count) else { throw CatalogError("本次清单须为已读取月份的1至155场") }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM"
  for slot in slots {
    guard Set(slot.keys).isSubset(of: ["performerId", "startsAt", "endsAt", "sortOrder"]),
      board.performers.contains(where: { $0.id == slot["performerId"] as? String && $0.text("status") == "active" }),
      let start = StaffIdentity.date(showText(slot, "startsAt")), let end = StaffIdentity.date(showText(slot, "endsAt")), end > start, end.timeIntervalSince(start) <= 86400,
      f.string(from: start) == board.month else { throw CatalogError("请核对启用演员、发布月份及24小时内有效时段") }
    if slot["sortOrder"] != nil { _ = try showInteger(slot["sortOrder"], max: 100000) }
  }
}
struct ShowCatalog {
  let employeeID: String, sessionID: String, performerID: String, fingerprint: String
  let songs: [ShowRow], total: Int, totalSongs: Int, nextOffset: Int?
  init(_ bytes: Data, actor: StaffIdentity, performerID: String) throws {
    let raw = try showData(bytes)
    guard actor.allows("song.view") || actor.allows("song.manage"), let rows = raw["songs"] as? [[String: Any]] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; sessionID = actor.session.id; self.performerID = try showUUID(performerID); fingerprint = try showFingerprint(raw["catalogFingerprint"])
    songs = try rows.map(ShowRow.init); total = try showInteger(raw["total"]); totalSongs = try showInteger(raw["totalSongs"])
    nextOffset = raw["nextOffset"] is NSNull ? nil : try showInteger(raw["nextOffset"], max: 1_000_000)
    for row in songs { _ = try showFingerprint(row.object["configurationFingerprint"]); guard row.text("performerId") == performerID else { throw StaffAPIError.invalid } }
  }
}
func validateShowSong(_ row: [String: Any]) throws {
  guard Set(row.keys).isSubset(of: ["code", "title", "aliases", "status"]), let aliases = row["aliases"] as? [String], aliases.count <= 100,
    aliases.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 240 }), ["active", "inactive"].contains(row["status"] as? String ?? "") else { throw CatalogError("请核对曲目别名、状态及字段") }
  _ = try showString(row, "title")
  if row["code"] is String { _ = try showString(row, "code", min: 0, max: 64) }
  else if !(row["code"] is NSNull || row["code"] == nil) { throw StaffAPIError.invalid }
}
func parseShowSongs(_ text: String) throws -> [[String: Any]] {
  let lines = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  guard lines.count <= 5000 else { throw CatalogError("每次最多5000首曲目") }
  var result: [[String: Any]] = [], seen: Set<String> = []
  for line in lines {
    let columns = line.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard (1...3).contains(columns.count) else { throw CatalogError("曲目每行格式为 编号 | 歌名 | 别名1,别名2") }
    let code = columns.count == 1 ? "" : columns[0], title = columns.count == 1 ? columns[0] : columns[1]
    let key = (code.isEmpty ? title : code).lowercased(); guard seen.insert(key).inserted else { throw CatalogError("曲目编号或歌名重复，请核对清单") }
    let aliases = columns.count < 3 ? [] : columns[2].components(separatedBy: CharacterSet(charactersIn: ",，")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    let row: [String: Any] = ["code": code.isEmpty ? NSNull() : code, "title": title, "aliases": aliases, "status": "active"]
    try validateShowSong(row); result.append(row)
  }
  return result
}
func showPermission(kind: String, action: String) throws -> String {
  if kind == "song" { guard showSongActions[action] != nil else { throw StaffAPIError.invalid }; return action == "paid" ? "song.payment.record" : "song.manage" }
  guard kind == "performance", showActions[action] != nil else { throw StaffAPIError.invalid }
  return action == "revision" ? "performance.schedule.revise" : action.hasPrefix("phase-") ? "performance.phase.manage" : "song.manage"
}
func showPath(kind: String, action: String, target: String?) throws -> String {
  _ = try showPermission(kind: kind, action: action)
  if kind == "performance" { guard target == nil else { throw StaffAPIError.invalid }; return showRoot + "/commands/" + action }
  return "/api/staff/native-song-requests/" + (try showUUID(target)) + "/" + action
}
func makeShowCommand(actor: StaffIdentity, kind: String, action: String, body: [String: Any], target: String?, confirmation: String) throws -> LiveCommand {
  let permission = try showPermission(kind: kind, action: action)
  guard actor.allows(permission), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true else { throw CatalogError("登录或演出权限已失效") }
  let id = UUID().uuidString.lowercased()
  var proof: [String: Any] = ["kind": kind, "action": action, "employeeId": actor.employee.id, "confirmation": confirmation]
  if let target { proof["target"] = target }
  return LiveCommand(id: id, employeeID: actor.employee.id, title: kind == "performance" ? showActions[action]! : showSongActions[action]!, permission: permission,
    steps: [.init(path: try showPath(kind: kind, action: action, target: target), body: try showBytes(body), keyHeader: "idempotency-key", key: "native-business-" + id,
      recoveryBody: try showBytes(["show": proof]))])
}
extension LiveCommand.Step {
  var showProof: [String: Any]? { guard let recoveryBody else { return nil }; return (try? showObject(recoveryBody))?["show"] as? [String: Any] }
}
func secureShowCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard let step = command.steps.first, var proof = step.showProof else { return command }
  guard command.steps.count == 1, proof["payloadKey"] == nil else { throw CatalogError("请从原待决演出请求恢复") }
  let payload = try showBytes(["body": step.object, "proof": proof]), secret = SymmetricKey(size: .bits256), key = "live-show-" + command.id
  let wrapped = try showBytes(["payload": payload.base64EncodedString(), "authenticationKey": secret.withUnsafeBytes { Data($0).base64EncodedString() }])
  try store(key, String(decoding: wrapped, as: UTF8.self)); proof.removeValue(forKey: "confirmation"); proof.removeValue(forKey: "expectation")
  proof["payloadKey"] = key; proof["payloadAuthentication"] = HMAC<SHA256>.authenticationCode(for: payload, using: secret).map { String(format: "%02x", $0) }.joined()
  guard Set(proof.keys).isSubset(of: ["kind", "action", "employeeId", "target", "payloadKey", "payloadAuthentication"]) else { throw StaffAPIError.invalid }
  return LiveCommand(id: command.id, employeeID: command.employeeID, title: "待核对演出或点歌原请求", permission: command.permission,
    steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key, recoveryBody: try showBytes(["show": proof]))], completedSteps: command.completedSteps, rejected: command.rejected)
}
struct ShowRequestPayload { let body: [String: Any]; let expectation: [String: Any] }
func showRequestPayload(_ command: LiveCommand, step: LiveCommand.Step, read: (String) throws -> String) throws -> ShowRequestPayload {
  guard command.steps.count == 1, command.steps.first == step, UUID(uuidString: command.id) != nil, command.id == command.id.lowercased(), step.body == Data("{}".utf8),
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id, let proof = step.showProof,
    proof["employeeId"] as? String == command.employeeID, let kind = proof["kind"] as? String, let action = proof["action"] as? String,
    command.permission == (try showPermission(kind: kind, action: action)), step.path == (try showPath(kind: kind, action: action, target: proof["target"] as? String)),
    let key = proof["payloadKey"] as? String, key == "live-show-" + command.id, proof["confirmation"] == nil,
    let tag = proof["payloadAuthentication"] as? String, tag.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }
  let envelope = try showObject(Data(try read(key).utf8))
  guard let encoded = envelope["payload"] as? String, let data = Data(base64Encoded: encoded),
    let secret = envelope["authenticationKey"] as? String, let secretBytes = Data(base64Encoded: secret), secretBytes.count == 32,
    HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: secretBytes)).map({ String(format: "%02x", $0) }).joined() == tag,
    let body = try showObject(data)["body"] as? [String: Any], var original = try showObject(data)["proof"] as? [String: Any] else { throw CatalogError("原演出安全载荷不可核对，未发送") }
  let expectation = original["expectation"] as? [String: Any] ?? [:]
  original.removeValue(forKey: "confirmation"); original.removeValue(forKey: "expectation"); var metadata = proof; metadata.removeValue(forKey: "payloadKey"); metadata.removeValue(forKey: "payloadAuthentication")
  guard NSDictionary(dictionary: original).isEqual(to: metadata) else { throw StaffAPIError.invalid }; return ShowRequestPayload(body: body, expectation: expectation)
}
struct ShowReceipt: Codable, Equatable {
  let employeeID: String, requestKey: String, kind: String, action: String
  let result: Data
  var object: [String: Any] { (try? showObject(result)) ?? [:] }
  var message: String {
    if kind == "song" { return action == "paid" ? "原付款已关联；本次没有再次扣款。" : action == "confirm" ? "点歌报价已登记；尚未收款或确认演唱。" : "点歌原操作已登记，请读取最新队列。" }
    if action == "revision" { return "演出修订已登记，受影响预约 " + showText(object, "affectedReservations") + " 笔；不代表顾客已接受变更或通知已送达。" }
    return "演出操作已登记，请重新读取当前排班、阶段或曲库。"
  }
}
func validateShowReceipt(_ bytes: Data, step: LiveCommand.Step, body: [String: Any], expectation: [String: Any]) throws -> ShowReceipt {
  let root = try showObject(bytes)
  guard let meta = root["meta"] as? [String: Any], let proof = step.showProof,
    let kind = proof["kind"] as? String, let action = proof["action"] as? String, let employee = proof["employeeId"] as? String else { throw StaffAPIError.invalid }
  _ = try showFlag(meta["replayed"]); _ = try showPermission(kind: kind, action: action)
  if kind == "song" { return try validateShowSongReceipt(bytes, step: step, body: body, expectation: expectation) }
  guard try showInteger(meta["protocol"]) == 1, let data = root["data"] as? [String: Any],
    data["employeeId"] as? String == employee, data["action"] as? String == action, data["requestKey"] as? String == step.key,
    let result = data["result"] as? [String: Any] else { throw StaffAPIError.invalid }
  switch action {
  case "publish":
    guard result["month"] as? String == body["month"] as? String, let ids = result["scheduleIds"] as? [String], let slots = body["slots"] as? [[String: Any]], ids.count == slots.count,
      try showInteger(result["createdCount"]) + showInteger(result["existingCount"]) == ids.count else { throw StaffAPIError.invalid }; for id in ids { _ = try showUUID(id) }
  case "schedule-status": guard result["id"] as? String == body["scheduleId"] as? String, result["status"] as? String == body["targetStatus"] as? String else { throw StaffAPIError.invalid }
  case "schedule-sort": guard result["id"] as? String == body["scheduleId"] as? String, try showInteger(result["sortOrder"]) == showInteger(body["sortOrder"]) else { throw StaffAPIError.invalid }
  case "revision":
    guard result["scheduleId"] as? String == body["scheduleId"] as? String, result["kind"] as? String == body["kind"] as? String,
      result["createdByEmployeeId"] as? String == employee else { throw StaffAPIError.invalid }
    _ = try showInteger(result["revisionNumber"], min: 1); _ = try showInteger(result["affectedReservations"])
  case "phase-start": guard result["scheduleId"] as? String == body["scheduleId"] as? String, result["phaseCode"] as? String == body["phaseCode"] as? String, result["status"] as? String == "active" else { throw StaffAPIError.invalid }
  case "phase-end", "phase-cancel": guard result["publicId"] as? String == body["publicId"] as? String, result["status"] as? String == (action == "phase-end" ? "ended" : "cancelled") else { throw StaffAPIError.invalid }
  case "performer-create", "performer-update":
    _ = try showUUID(result["id"]); if action == "performer-update", result["id"] as? String != body["performerId"] as? String { throw StaffAPIError.invalid }
    guard result["stageName"] as? String == body["stageName"] as? String, result["status"] as? String == body["status"] as? String else { throw StaffAPIError.invalid }
  case "songs-import": guard result["performerId"] as? String == body["performerId"] as? String, result["mode"] as? String == body["mode"] as? String,
    try showInteger(result["importedCount"]) == (body["songs"] as? [[String: Any]])?.count, try showInteger(result["rejectedCount"]) == 0 else { throw StaffAPIError.invalid }
  case "song-update":
    guard let changes = body["changes"] as? [String: Any], result["id"] as? String == body["songId"] as? String,
      result["title"] as? String == changes["title"] as? String, result["status"] as? String == changes["status"] as? String else { throw StaffAPIError.invalid }
  default: throw StaffAPIError.invalid
  }
  return ShowReceipt(employeeID: employee, requestKey: step.key, kind: kind, action: action, result: try showBytes(result))
}
