import Foundation
import CoreFoundation
import CryptoKit

let reservationReceptionRoot = "/api/staff/reservation-receptions"
private let receptionPreferences = ["no_preference", "stage_atmosphere", "quiet_chat", "comfortable_booth", "outdoor_view"]
func receptionDisplayTime(_ text: String) -> String {
  guard let date = receptionDate(text) else { return "时间待核对" }
  let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd HH:mm"
  return formatter.string(from: date) + "（北京）"
}
func receptionDate(_ text: String) -> Date? {
  if let date = StaffIdentity.date(text) { return date }
  for format in ["yyyy-MM-dd HH:mm:ss.SSSSSSXXXXX", "yyyy-MM-dd HH:mm:ssXXXXX", "yyyy-MM-dd HH:mm:ss.SSSSSSX", "yyyy-MM-dd HH:mm:ssX"] {
    let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.timeZone = TimeZone(secondsFromGMT: 0); parser.dateFormat = format
    if let date = parser.date(from: text) { return date }
  }
  return nil
}
private func receptionObject(_ value: Any?) throws -> [String: Any] { guard let result = value as? [String: Any] else { throw StaffAPIError.invalid }; return result }
private func receptionInteger(_ value: Any?, _ range: ClosedRange<Int> = 0...9_007_199_254_740_991) throws -> Int {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
    number.doubleValue.rounded() == number.doubleValue, range.contains(number.intValue) else { throw StaffAPIError.invalid }
  return number.intValue
}
private func receptionText(_ value: Any?, _ range: ClosedRange<Int> = 1...1000) throws -> String {
  guard let text = value as? String, range.contains(text.utf16.count), text == text.trimmingCharacters(in: .whitespacesAndNewlines) else { throw StaffAPIError.invalid }; return text
}
private func receptionUUID(_ value: Any?) throws -> String { let text = try receptionText(value, 36...36); guard UUID(uuidString: text) != nil else { throw StaffAPIError.invalid }; return text }
private func receptionJSON(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
private func receptionEqual(_ a: Any, _ b: Any) -> Bool { (try? receptionJSON(a)) == (try? receptionJSON(b)) }
private func receptionData(_ bytes: Data) throws -> [String: Any] {
  let root = try receptionObject(JSONSerialization.jsonObject(with: bytes)), data = try receptionObject(root["data"])
  guard try receptionInteger(data["protocol"]) == 1 else { throw StaffAPIError.invalid }; return data
}
private func receptionCheckActor(_ actor: StaffIdentity, write: Bool, seat: Bool = false) throws {
  try actor.validate()
  guard actor.allows(write ? "reservation.manage" : "reservation.view"), !seat || actor.allows("table.open") else { throw CatalogError("当前员工没有此预约或桌次的操作权限") }
}
struct ReservationAdmissionOptions {
  let arrivalAt, expectedEndAt: String
  let policyVersion, maxAdvanceDays, defaultDurationMinutes, arrivalGraceMinutes, totalGuests, committedGuests: Int
  let loadedAt: Date
  var remainingGuests: Int { max(0, totalGuests - committedGuests) }
  init(data bytes: Data, actor: StaffIdentity, arrivalAt: String, expectedEndAt: String, now: Date = Date()) throws {
    try receptionCheckActor(actor, write: true)
    let data = try receptionData(bytes), policy = try receptionObject(data["policy"]), capacity = try receptionObject(data["capacity"])
    guard data["physicalTablesPreassigned"] as? Bool == false, let start = data["arrivalAt"] as? String, let end = data["expectedEndAt"] as? String,
      let startDate = receptionDate(start), let endDate = receptionDate(end), startDate == receptionDate(arrivalAt), endDate == receptionDate(expectedEndAt), endDate > startDate else { throw StaffAPIError.invalid }
    self.arrivalAt = start; self.expectedEndAt = end; loadedAt = now
    policyVersion = try receptionInteger(policy["version"], 1...2_147_483_647)
    maxAdvanceDays = try receptionInteger(policy["maxAdvanceDays"], 1...3650)
    defaultDurationMinutes = try receptionInteger(policy["defaultDurationMinutes"], 1...10080)
    arrivalGraceMinutes = try receptionInteger(policy["arrivalGraceMinutes"], 0...1440)
    totalGuests = try receptionInteger(capacity["totalGuests"]); committedGuests = try receptionInteger(capacity["committedGuests"])
  }
  static func path(arrivalAt: String, expectedEndAt: String) throws -> String {
    guard let a = receptionDate(arrivalAt), let b = receptionDate(expectedEndAt), b > a else { throw CatalogError("请核对到店和结束时间") }
    return reservationReceptionRoot + "/options?arrivalAt=" + LiveCommand.pathPart(arrivalAt) + "&expectedEndAt=" + LiveCommand.pathPart(expectedEndAt)
  }
}
struct ReservationReceptionSession: Identifiable {
  let id, tableId, tableCode, businessDate, openedAt: String
  let locationVersion, guestCount: Int
  init(_ row: [String: Any]) throws {
    id = try receptionUUID(row["tableSessionId"]); tableId = try receptionUUID(row["tableId"]); tableCode = try receptionText(row["tableCode"], 1...64)
    locationVersion = try receptionInteger(row["locationVersion"]); guestCount = try receptionInteger(row["guestCount"], 1...200)
    businessDate = try receptionText(row["businessDate"], 10...10); openedAt = try receptionText(row["openedAt"], 10...100)
    guard businessDate.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil, receptionDate(openedAt) != nil else { throw StaffAPIError.invalid }
  }
  var request: [String: Any] { ["tableSessionId": id, "expectedTableId": tableId, "expectedLocationVersion": locationVersion, "expectedGuestCount": guestCount] }
}
struct ReservationReceptionSelection {
  let reservationId, reservationStatus: String
  let reservationVersion, reservationGuestCount: Int
  let sessions: [ReservationReceptionSession]
  let loadedAt: Date
  init(data bytes: Data, actor: StaffIdentity, id: String, now: Date = Date()) throws {
    try receptionCheckActor(actor, write: true, seat: true)
    let data = try receptionData(bytes)
    reservationId = try receptionUUID(data["reservationId"]); reservationVersion = try receptionInteger(data["reservationVersion"], 1...9_007_199_254_740_991)
    reservationGuestCount = try receptionInteger(data["reservationGuestCount"], 1...200); reservationStatus = try receptionText(data["reservationStatus"], 1...30)
    guard reservationId == id, LiveReservation.labels[reservationStatus] != nil, data["partialSeatingSupported"] as? Bool == false, let rows = data["sessions"] as? [[String: Any]], rows.count <= 1000 else { throw StaffAPIError.invalid }
    sessions = try rows.map(ReservationReceptionSession.init)
    guard Set(sessions.map(\.id)).count == sessions.count, Set(sessions.map(\.tableId)).count == sessions.count,
      reservationStatus == "arrived" || sessions.isEmpty else { throw StaffAPIError.invalid }
    loadedAt = now
  }
  static func path(id: String) throws -> String { _ = try receptionUUID(id); return reservationReceptionRoot + "/" + id + "/table-sessions" }
  func command(selected: Set<String>, reason: String, actor: StaffIdentity, now: Date = Date()) throws -> LiveCommand {
    try receptionCheckActor(actor, write: true, seat: true)
    let chosen = sessions.filter { selected.contains($0.id) }.sorted { $0.id < $1.id }, note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard reservationStatus == "arrived", (0...30).contains(now.timeIntervalSince(loadedAt)), (1...20).contains(selected.count), chosen.count == selected.count, (4...1000).contains(note.utf16.count) else { throw CatalogError("请重新读取实际已开桌次，选择本组全部1—20桌并填写4—1000字核对说明") }
    let actual = chosen.reduce(0) { $0 + $1.guestCount }
    return try receptionCommand(actor: actor, operation: "seat", target: reservationId,
      body: ["protocol": 1, "reservationVersion": reservationVersion, "sessions": chosen.map(\.request), "reason": note],
      confirmation: "预约\(reservationGuestCount)人，实际\(actual)人\n" + chosen.map { "\($0.tableCode) · \($0.guestCount)人" }.joined(separator: "\n") + "\n\(note)\n这是本次全部实际桌位；确认后不支持追加或改绑，不自动开台或退款。", extra: ["reservationGuestCount": reservationGuestCount])
  }
}
struct ReservationReceptionDetail {
  struct Session: Identifiable {
    let id, originalTable, currentTable, currentStatus: String
    let originalGuests: Int
  }
  let reservation: LiveReservation
  let batchId, seatedAt, reason: String?
  let seatedGuestCount: Int?
  let sessions: [Session]
  init(data bytes: Data, actor: StaffIdentity, id: String) throws {
    try receptionCheckActor(actor, write: false)
    let data = try receptionData(bytes), row = try receptionObject(data["reservation"])
    reservation = try JSONDecoder().decode(LiveReservation.self, from: receptionJSON(row))
    guard reservation.id == id, UUID(uuidString: id) != nil else { throw StaffAPIError.invalid }
    if data["seating"] is NSNull { batchId = nil; seatedAt = nil; reason = nil; seatedGuestCount = nil; sessions = []; return }
    let seating = try receptionObject(data["seating"]); batchId = try receptionUUID(seating["batchId"])
    _ = try receptionUUID(seating["customerId"]); _ = try receptionUUID(seating["seatedByEmployeeId"])
    seatedAt = try receptionText(seating["seatedAt"], 10...100); reason = try receptionText(seating["reason"], 4...1000)
    seatedGuestCount = try receptionInteger(seating["seatedGuestCount"], 1...4000)
    guard receptionDate(seatedAt!) != nil, let rows = seating["sessions"] as? [[String: Any]], (1...20).contains(rows.count) else { throw StaffAPIError.invalid }
    sessions = try rows.map { row in
      _ = try receptionUUID(row["tableIdAtSeating"]); _ = try receptionUUID(row["currentTableId"])
      _ = try receptionInteger(row["locationVersionAtSeating"]); _ = try receptionInteger(row["currentLocationVersion"])
      let status = try receptionText(row["currentStatus"], 1...20)
      guard ["open", "closing", "closed", "cancelled"].contains(status) else { throw StaffAPIError.invalid }
      return Session(id: try receptionUUID(row["tableSessionId"]), originalTable: try receptionText(row["tableCodeAtSeating"], 1...64), currentTable: try receptionText(row["currentTableCode"], 1...64), currentStatus: status, originalGuests: try receptionInteger(row["guestCountAtSeating"], 1...200))
    }
    guard Set(sessions.map(\.id)).count == sessions.count, sessions.reduce(0, { $0 + $1.originalGuests }) == seatedGuestCount else { throw StaffAPIError.invalid }
  }
  static func path(id: String) throws -> String { _ = try receptionUUID(id); return reservationReceptionRoot + "/" + id }
}
struct ReservationAdmissionDraft {
  var name = "", contact = "", note = "", source = "phone", preference = "no_preference", initialStatus = "confirmed"
  var guestCount = 2
  var arrival = Date().addingTimeInterval(3600), end = Date().addingTimeInterval(10800)
  var arrivalAt: String { ISO8601DateFormatter().string(from: arrival) }
  var expectedEndAt: String { ISO8601DateFormatter().string(from: end) }
  func command(actor: StaffIdentity, options: ReservationAdmissionOptions, now: Date = Date()) throws -> LiveCommand {
    try receptionCheckActor(actor, write: true)
    guard (0...30).contains(now.timeIntervalSince(options.loadedAt)), receptionDate(arrivalAt) == receptionDate(options.arrivalAt), receptionDate(expectedEndAt) == receptionDate(options.expectedEndAt), arrival > now, end > arrival, guestCount <= options.remainingGuests else { throw CatalogError("预约时间或可用名额已变化，请重新读取政策与名额") }
    let publicId = "reception-" + UUID().uuidString.lowercased()
    let body: [String: Any] = ["protocol": 1, "publicId": publicId, "customerName": name.trimmingCharacters(in: .whitespacesAndNewlines), "contact": contact.trimmingCharacters(in: .whitespacesAndNewlines), "guestCount": guestCount, "arrivalAt": arrivalAt, "expectedEndAt": expectedEndAt, "source": source, "initialStatus": initialStatus, "note": note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : note.trimmingCharacters(in: .whitespacesAndNewlines) as Any, "seatPreference": preference, "reservationPolicyVersion": options.policyVersion, "preferredScheduleId": NSNull()]
    return try receptionCommand(actor: actor, operation: "create", target: publicId, body: body,
      confirmation: "\(name) · \(guestCount)人\n\(receptionDisplayTime(arrivalAt)) — \(receptionDisplayTime(expectedEndAt))\n联系方式：\(contact)\n来源：\(source == "phone" ? "电话代订" : "员工代订")\n位置偏好：\(["no_preference": "无偏好", "stage_atmosphere": "舞台氛围", "quiet_chat": "安静聊天", "comfortable_booth": "舒适卡座", "outdoor_view": "户外景观"][preference] ?? "待核对")\n备注：\(note.isEmpty ? "无" : note)\n\(initialStatus == "confirmed" ? "确认接待名额" : "登记待确认名额")\n只登记人数和位置偏好，具体桌台到店后安排；不自动收款。", extra: [:])
  }
}
extension LiveCommand.Step {
  var reservationReceptionProof: [String: Any]? { guard let recoveryBody, let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any] else { return nil }; return root["reservationReception"] as? [String: Any] }
}
private func receptionCommand(actor: StaffIdentity, operation: String, target: String, body: [String: Any], confirmation: String, extra: [String: Any]) throws -> LiveCommand {
  let id = UUID().uuidString.lowercased(), proof = extra.merging(["protocol": 1, "operation": operation, "employeeId": actor.employee.id, "target": target, "confirmation": confirmation]) { _, new in new }
  let command = LiveCommand(id: id, employeeID: actor.employee.id, title: operation == "create" ? "登记预约接待名额" : "确认本组实际入座", permission: "reservation.manage", steps: [.init(path: operation == "create" ? reservationReceptionRoot : reservationReceptionRoot + "/" + target + "/seat", body: try receptionJSON(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try receptionJSON(["reservationReception": proof]))])
  try validateReceptionOriginal(command); return command
}
private func validateReceptionOriginal(_ command: LiveCommand) throws {
  guard UUID(uuidString: command.id) != nil, UUID(uuidString: command.employeeID) != nil, command.permission == "reservation.manage", command.steps.count == 1, command.completedSteps == 0, !command.rejected,
    let step = command.steps.first, let proof = step.reservationReceptionProof, try receptionInteger(proof["protocol"]) == 1, proof["employeeId"] as? String == command.employeeID,
    let operation = proof["operation"] as? String, ["create", "seat"].contains(operation), let target = proof["target"] as? String,
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    step.path == (operation == "create" ? reservationReceptionRoot : reservationReceptionRoot + "/" + target + "/seat"),
    proof["payloadKey"] == nil, proof["payloadAuthentication"] == nil, let confirmation = proof["confirmation"] as? String, !confirmation.isEmpty else { throw StaffAPIError.invalid }
  let body = try receptionObject(JSONSerialization.jsonObject(with: step.body)); guard try receptionInteger(body["protocol"]) == 1 else { throw StaffAPIError.invalid }
  if operation == "create" {
    guard Set(proof.keys) == Set(["protocol", "operation", "employeeId", "target", "confirmation"]), Set(body.keys) == Set(["protocol", "publicId", "customerName", "contact", "guestCount", "arrivalAt", "expectedEndAt", "source", "initialStatus", "note", "seatPreference", "reservationPolicyVersion", "preferredScheduleId"]), body["publicId"] as? String == target,
      target.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$"#, options: .regularExpression) != nil else { throw StaffAPIError.invalid }
    _ = try receptionText(body["customerName"], 1...120); _ = try receptionText(body["contact"], 3...256); _ = try receptionInteger(body["guestCount"], 1...200); _ = try receptionInteger(body["reservationPolicyVersion"], 1...2_147_483_647)
    if !(body["note"] is NSNull) { _ = try receptionText(body["note"], 1...1000) }
    if !(body["preferredScheduleId"] is NSNull) { _ = try receptionUUID(body["preferredScheduleId"]) }
    guard ["phone", "employee"].contains(body["source"] as? String ?? ""), ["pending", "confirmed"].contains(body["initialStatus"] as? String ?? ""), receptionPreferences.contains(body["seatPreference"] as? String ?? ""), let a = body["arrivalAt"] as? String, let b = body["expectedEndAt"] as? String, let start = receptionDate(a), let end = receptionDate(b), end > start else { throw StaffAPIError.invalid }
  } else {
    _ = try receptionUUID(target); _ = try receptionInteger(proof["reservationGuestCount"], 1...200)
    guard Set(proof.keys) == Set(["protocol", "operation", "employeeId", "target", "confirmation", "reservationGuestCount"]), Set(body.keys) == Set(["protocol", "reservationVersion", "sessions", "reason"]), let sessions = body["sessions"] as? [[String: Any]], (1...20).contains(sessions.count) else { throw StaffAPIError.invalid }
    _ = try receptionInteger(body["reservationVersion"], 1...9_007_199_254_740_991); _ = try receptionText(body["reason"], 4...1000)
    for row in sessions { guard Set(row.keys) == Set(["tableSessionId", "expectedTableId", "expectedLocationVersion", "expectedGuestCount"]) else { throw StaffAPIError.invalid }; _ = try receptionUUID(row["tableSessionId"]); _ = try receptionUUID(row["expectedTableId"]); _ = try receptionInteger(row["expectedLocationVersion"]); _ = try receptionInteger(row["expectedGuestCount"], 1...200) }
    guard Set(sessions.compactMap { $0["tableSessionId"] as? String }).count == sessions.count, Set(sessions.compactMap { $0["expectedTableId"] as? String }).count == sessions.count else { throw StaffAPIError.invalid }
  }
}
func validReservationReceptionCommand(command: LiveCommand, actor: StaffIdentity, capabilities: ReservationCapabilities?) -> Bool {
  guard (try? validateReceptionOriginal(command)) != nil, command.employeeID == actor.employee.id, actor.allows("reservation.manage"), let operation = command.steps.first?.reservationReceptionProof?["operation"] as? String else { return false }
  return operation == "create" ? capabilities?.admissionCreateV1 == true : capabilities?.receptionSeatV1 == true && actor.allows("table.open")
}

private struct ReceptionPayload: Codable { let command: Data; let authenticationKey: Data }
private func receptionAuthentication(_ bytes: Data, _ key: Data) -> String { HMAC<SHA256>.authenticationCode(for: bytes, using: SymmetricKey(data: key)).map { String(format: "%02x", $0) }.joined() }
private func receptionSecureCopy(_ original: LiveCommand, authentication: String) throws -> LiveCommand {
  let step = original.steps[0]; var proof = step.reservationReceptionProof!
  proof.removeValue(forKey: "confirmation"); proof["payloadKey"] = original.id; proof["payloadAuthentication"] = authentication
  return LiveCommand(id: original.id, employeeID: original.employeeID, title: "待核对原预约接待请求", permission: original.permission, steps: [.init(path: step.path, body: Data("{}".utf8), keyHeader: step.keyHeader, key: step.key, recoveryBody: try receptionJSON(["reservationReception": proof]))])
}
func secureReservationReceptionCommand(_ command: LiveCommand, store: (String, String) throws -> Void) throws -> LiveCommand {
  guard command.steps.first?.reservationReceptionProof != nil else { return command }
  try validateReceptionOriginal(command)
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  let bytes = try encoder.encode(command), key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
  let envelope = try encoder.encode(ReceptionPayload(command: bytes, authenticationKey: key))
  guard let string = String(data: envelope, encoding: .utf8) else { throw StaffAPIError.invalid }
  try store(command.id, string)
  return try receptionSecureCopy(command, authentication: receptionAuthentication(bytes, key))
}
private func readReceptionOriginal(_ command: LiveCommand, step: LiveCommand.Step, read: (String) throws -> String) throws -> LiveCommand {
  guard command.steps.count == 1, command.steps[0] == step, let proof = step.reservationReceptionProof, proof["payloadKey"] as? String == command.id, (0...1).contains(command.completedSteps) else { throw StaffAPIError.invalid }
  let payload = try JSONDecoder().decode(ReceptionPayload.self, from: Data(read(command.id).utf8))
  guard payload.authenticationKey.count == 32 else { throw StaffAPIError.invalid }
  let original = try JSONDecoder().decode(LiveCommand.self, from: payload.command); try validateReceptionOriginal(original)
  var normalized = command; normalized.completedSteps = 0; normalized.rejected = false
  guard normalized == (try receptionSecureCopy(original, authentication: receptionAuthentication(payload.command, payload.authenticationKey))) else { throw CatalogError("原预约接待请求的员工、载荷或步骤已变化，未发送") }
  return original
}
func reservationReceptionRequestBody(_ command: LiveCommand, step: LiveCommand.Step, actor: StaffIdentity, read: (String) throws -> String) throws -> [String: Any] {
  guard command.employeeID == actor.employee.id else { throw CatalogError("请由发起操作的员工恢复原请求") }
  try receptionCheckActor(actor, write: true, seat: step.reservationReceptionProof?["operation"] as? String == "seat")
  return try readReceptionOriginal(command, step: step, read: read).steps[0].object
}
func validateReservationReceptionReply(_ bytes: Data, step: LiveCommand.Step, body: [String: Any]) throws {
  let root = try receptionObject(JSONSerialization.jsonObject(with: bytes)), data = try receptionData(bytes), meta = try receptionObject(root["meta"])
  guard let replayed = meta["replayed"] as? NSNumber, CFGetTypeID(replayed) == CFBooleanGetTypeID(), let proof = step.reservationReceptionProof,
    data["operation"] as? String == proof["operation"] as? String, data["employeeId"] as? String == proof["employeeId"] as? String, data["requestKey"] as? String == step.key else { throw StaffAPIError.invalid }
  let row = try receptionObject(data["reservation"]); _ = try receptionUUID(row["id"]); _ = try receptionUUID(row["customerId"])
  guard row["contactToken"] == nil, data["contact"] == nil else { throw StaffAPIError.invalid }
  if proof["operation"] as? String == "create" {
    guard row["publicId"] as? String == body["publicId"] as? String, row["publicId"] as? String == proof["target"] as? String,
      ["customerName", "guestCount", "source", "seatPreference", "note"].allSatisfy({ receptionEqual(row[$0] ?? NSNull(), body[$0] ?? NSNull()) }), row["status"] as? String == body["initialStatus"] as? String,
      row["ownerEmployeeId"] as? String == proof["employeeId"] as? String, let a = row["arrivalAt"] as? String, let b = row["expectedEndAt"] as? String,
      receptionDate(a) == receptionDate(body["arrivalAt"] as? String ?? ""), receptionDate(b) == receptionDate(body["expectedEndAt"] as? String ?? ""),
      let locks = row["tableLocks"] as? [Any], locks.isEmpty, try receptionInteger((row["reservationSnapshot"] as? [String: Any])?["receptionProtocol"]) == 1,
      let masked = data["maskedContact"] as? String, !masked.isEmpty, masked != body["contact"] as? String else { throw StaffAPIError.invalid }
  } else {
    let seating = try receptionObject(data["seating"]); _ = try receptionUUID(seating["batchId"])
    guard row["id"] as? String == proof["target"] as? String, row["status"] as? String == "seated", try receptionInteger(row["aggregateVersion"]) == receptionInteger(body["reservationVersion"]) + 1,
      seating["customerId"] as? String == row["customerId"] as? String, seating["seatedByEmployeeId"] as? String == proof["employeeId"] as? String,
      seating["reason"] as? String == body["reason"] as? String, try receptionInteger(seating["reservationGuestCount"]) == receptionInteger(proof["reservationGuestCount"]), let time = seating["seatedAt"] as? String, receptionDate(time) != nil,
      let expected = body["sessions"] as? [[String: Any]], let actual = seating["sessions"] as? [[String: Any]], actual.count == expected.count,
      Set(actual.compactMap { $0["tableSessionId"] as? String }).count == actual.count else { throw StaffAPIError.invalid }
    for selected in expected {
      guard let linked = actual.first(where: { $0["tableSessionId"] as? String == selected["tableSessionId"] as? String }), linked["tableIdAtSeating"] as? String == selected["expectedTableId"] as? String,
        try receptionInteger(linked["locationVersionAtSeating"]) == receptionInteger(selected["expectedLocationVersion"]), try receptionInteger(linked["guestCountAtSeating"]) == receptionInteger(selected["expectedGuestCount"]) else { throw StaffAPIError.invalid }
    }
    guard try receptionInteger(seating["seatedGuestCount"]) == expected.reduce(0, { $0 + ((try? receptionInteger($1["expectedGuestCount"])) ?? -1) }) else { throw StaffAPIError.invalid }
  }
}
private func receptionAcknowledgementBinding(_ command: LiveCommand) throws -> String {
  var stable = command; stable.completedSteps = 0; stable.rejected = false
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  return SHA256.hash(data: try encoder.encode(stable)).map { String(format: "%02x", $0) }.joined()
}
func hasReservationReceptionAcknowledgement(_ command: LiveCommand, readPayload: (String) throws -> String, readReceipt: (String) throws -> String?) throws -> Bool {
  guard let step = command.steps.first, step.reservationReceptionProof != nil else { return false }
  let original = try readReceptionOriginal(command, step: step, read: readPayload)
  guard let stored = try readReceipt(command.id) else { return false }
  let object = try receptionObject(JSONSerialization.jsonObject(with: Data(stored.utf8)))
  guard Set(object.keys) == Set(["protocol", "binding", "reply"]), try receptionInteger(object["protocol"]) == 1,
    object["binding"] as? String == (try receptionAcknowledgementBinding(command)), let encoded = object["reply"] as? String, let reply = Data(base64Encoded: encoded) else { throw StaffAPIError.invalid }
  try validateReservationReceptionReply(reply, step: step, body: original.steps[0].object); return true
}
func recordReservationReceptionAcknowledgement(_ reply: Data, command: LiveCommand, step: LiveCommand.Step, actor: StaffIdentity, readPayload: (String) throws -> String, readReceipt: (String) throws -> String?, storeReceipt: (String, String) throws -> Void) throws {
  let body = try reservationReceptionRequestBody(command, step: step, actor: actor, read: readPayload)
  try validateReservationReceptionReply(reply, step: step, body: body)
  if try hasReservationReceptionAcknowledgement(command, readPayload: readPayload, readReceipt: readReceipt) { return }
  let bytes = try receptionJSON(["protocol": 1, "binding": receptionAcknowledgementBinding(command), "reply": reply.base64EncodedString()])
  guard let text = String(data: bytes, encoding: .utf8) else { throw StaffAPIError.invalid }; try storeReceipt(command.id, text)
}

// A separately secured ticket is issued only after validating the original
// accepted receipt or an explicit server rollback. It authorizes local deletion
// of this one UUID, never a request, identity, or an ordinary completion flag.
private func receptionCleanupTicket(_ command: LiveCommand, disposition: String) throws -> String {
  String(decoding: try receptionJSON(["protocol": 1, "commandId": command.id,
    "binding": disposition == "never-sent" ? receptionInitializationBinding(command) : receptionAcknowledgementBinding(command), "disposition": disposition]), as: UTF8.self)
}
private func validateReceptionCleanupTicket(_ text: String, key: String, command: LiveCommand? = nil) throws -> String {
  let ticket = try receptionObject(JSONSerialization.jsonObject(with: Data(text.utf8)))
  guard Set(ticket.keys) == Set(["protocol", "commandId", "binding", "disposition"]), try receptionInteger(ticket["protocol"]) == 1,
    try receptionUUID(ticket["commandId"]) == key, let binding = ticket["binding"] as? String,
    binding.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
    let disposition = ticket["disposition"] as? String, ["acknowledged", "rejected", "never-sent"].contains(disposition) else { throw StaffAPIError.invalid }
  if let command { guard command.id == key, binding == (try disposition == "never-sent" ? receptionInitializationBinding(command) : receptionAcknowledgementBinding(command)) else { throw CatalogError("原预约安全清理凭据与本机请求不符，未清理或发送") } }
  return disposition
}
func prepareReservationReceptionCleanup(_ command: LiveCommand, persistence: ReservationReceptionPersistence) throws -> Bool {
  guard command.steps.first?.reservationReceptionProof != nil else { return false }
  if let ticket = try persistence.readCleanupTicket(command.id) {
    return try validateReceptionCleanupTicket(ticket, key: command.id, command: command) != "rejected"
  }
  guard try hasReservationReceptionAcknowledgement(command, readPayload: persistence.readPayload, readReceipt: persistence.readReceipt) else {
    if command.completedSteps > 0 { throw CatalogError("原预约请求缺少安全回执，不能根据本机完成标记清除；请保留原请求核对") }
    return false
  }
  try persistence.storeCleanupTicket(command.id, receptionCleanupTicket(command, disposition: "acknowledged"))
  return true
}
func recordReservationReceptionRejection(_ failure: StaffAPIError, command: LiveCommand, actor: StaffIdentity, persistence: ReservationReceptionPersistence) throws {
  guard command.steps.first?.reservationReceptionProof != nil, failure.status == 409, failure.commitDisposition == "not_committed",
    ["RESERVATION_RECEPTION_REQUIRED", "RESERVATION_RECEPTION_CHANGED", "RESERVATION_POLICY_CHANGED", "RESERVATION_CAPACITY_UNAVAILABLE"].contains(failure.code),
    let step = command.steps.first else { throw StaffAPIError.invalid }
  _ = try reservationReceptionRequestBody(command, step: step, actor: actor, read: persistence.readPayload)
  guard try persistence.readReceipt(command.id) == nil else { throw CatalogError("原请求已有安全回执，不能按拒绝结果清除") }
  try persistence.storeCleanupTicket(command.id, receptionCleanupTicket(command, disposition: "rejected"))
}
func hasRejectedReservationReceptionCleanup(_ command: LiveCommand, persistence: ReservationReceptionPersistence) throws -> Bool {
  guard let ticket = try persistence.readCleanupTicket(command.id) else { return false }
  return try validateReceptionCleanupTicket(ticket, key: command.id, command: command) == "rejected"
}
func removeReservationReceptionPrivateSlots(_ command: LiveCommand, disposition: String, persistence: ReservationReceptionPersistence) throws {
  guard let ticket = try persistence.readCleanupTicket(command.id),
    try validateReceptionCleanupTicket(ticket, key: command.id, command: command) == disposition else { throw StaffAPIError.invalid }
  try persistence.removePayload(command.id)
  try persistence.removeReceipt(command.id)
}
func removeReservationReceptionCleanupTicket(_ command: LiveCommand, disposition: String, persistence: ReservationReceptionPersistence) throws {
  guard let ticket = try persistence.readCleanupTicket(command.id),
    try validateReceptionCleanupTicket(ticket, key: command.id, command: command) == disposition else { throw StaffAPIError.invalid }
  try persistence.removeCleanupTicket(command.id)
}
@discardableResult
func removeOrphanedReservationReceptionCleanupTickets(pending: LiveCommand?, persistence: ReservationReceptionPersistence) throws -> Int {
  var cleaned = 0
  for key in try persistence.listCleanupTicketKeys() where key != pending?.id {
    guard let ticket = try persistence.readCleanupTicket(key) else { continue }
    _ = try validateReceptionCleanupTicket(ticket, key: key)
    // The secured ticket itself proves a prior validated result. No ordinary
    // file, employee login, or completedSteps can manufacture this authority.
    try persistence.removePayload(key)
    try persistence.removeReceipt(key)
    try persistence.removeCleanupTicket(key)
    cleaned += 1
  }
  return cleaned
}

func reservationReceptionCleanupDisposition(_ command: LiveCommand, persistence: ReservationReceptionPersistence) throws -> String? {
  guard let ticket = try persistence.readCleanupTicket(command.id) else { return nil }
  return try validateReceptionCleanupTicket(ticket, key: command.id, command: command)
}

private func receptionInitializationBinding(_ command: LiveCommand) throws -> String {
  guard UUID(uuidString: command.id) != nil, UUID(uuidString: command.employeeID) != nil,
    command.permission == "reservation.manage", command.steps.count == 1,
    let step = command.steps.first, let proof = step.reservationReceptionProof,
    try receptionInteger(proof["protocol"]) == 1, proof["employeeId"] as? String == command.employeeID,
    let operation = proof["operation"] as? String, ["create", "seat"].contains(operation), let target = proof["target"] as? String,
    step.keyHeader == "idempotency-key", step.key == "native-business-" + command.id,
    step.path == (operation == "create" ? reservationReceptionRoot : reservationReceptionRoot + "/" + target + "/seat") else { throw StaffAPIError.invalid }
  let stable: [String: Any] = ["protocol": 1, "module": "reservationReception", "commandId": command.id, "employeeId": command.employeeID,
    "permission": command.permission, "operation": operation, "target": target, "path": step.path, "keyHeader": step.keyHeader, "key": step.key]
  return SHA256.hash(data: try receptionJSON(stable)).map { String(format: "%02x", $0) }.joined()
}
func recordReservationReceptionInitialization(_ command: LiveCommand, persistence: ReservationReceptionPersistence) throws {
  guard command.steps.first?.reservationReceptionProof != nil else { return }
  try validateReceptionOriginal(command)
  guard try !persistence.payloadExists(command.id), try persistence.readReceipt(command.id) == nil,
    try persistence.readCleanupTicket(command.id) == nil else { throw CatalogError("此原预约已有安全记录，不能重新初始化或覆盖") }
  try persistence.storeCleanupTicket(command.id, receptionCleanupTicket(command, disposition: "never-sent"))
}
func discardReservationReceptionInitialization(_ command: LiveCommand, persistence: ReservationReceptionPersistence) throws {
  guard let step = command.steps.first, step.reservationReceptionProof != nil else { return }
  _ = try readReceptionOriginal(command, step: step, read: persistence.readPayload)
  guard let ticket = try persistence.readCleanupTicket(command.id),
    try validateReceptionCleanupTicket(ticket, key: command.id, command: command) == "never-sent" else { throw StaffAPIError.invalid }
  try persistence.removeCleanupTicket(command.id)
  guard try persistence.readCleanupTicket(command.id) == nil else { throw CatalogError("预约初始化清理凭据尚未移除，未发送操作") }
}
