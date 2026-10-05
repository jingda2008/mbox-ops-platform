import Foundation

struct LiveReservation: Decodable, Identifiable {
  struct ReceptionSnapshot: Decodable { let receptionProtocol: Int? }
  var reservationSnapshot: ReceptionSnapshot? = nil
  var aggregateVersion: Int? = nil
  var requiresReception: Bool { reservationSnapshot?.receptionProtocol == 1 }
  struct Lock: Decodable { let tableCode, status: String }
  let id, publicId, customerName, arrivalAt, expectedEndAt, status, seatPreference: String
  let guestCount: Int
  let contactAvailable: Bool
  let contactToken, note: String?
  let tableLocks: [Lock]
  var tables: String {
    let codes = tableLocks.filter { ["held", "confirmed"].contains($0.status) }.map(\.tableCode)
    if codes.isEmpty && requiresReception && ["seated", "completed"].contains(status) { return "实际桌次见接待记录" }
    return codes.isEmpty ? "待安排桌位" : codes.joined(separator: "、")
  }
  var actions: [String] {
    switch status {
    case "pending": return ["confirm", "arrive", "cancel"]
    case "confirmed": return ["arrive", "cancel"]
    case "arrived": return requiresReception ? ["cancel"] : ["complete", "cancel"]
    case "seated": return ["complete"]
    default: return []
    }
  }
  var statusLabel: String { Self.labels[status] ?? "状态待核对" }
  static let labels = [
    "pending": "待确认", "confirmed": "已确认", "arrived": "已到店", "seated": "已入座", "completed": "已完成",
    "cancelled": "已取消", "no_show": "未到店",
  ]
}
struct LiveReservationIntake: Decodable, Identifiable {
  struct Priority: Decodable { let requestHoldMinutes: Int }
  struct Override: Decodable { let mode, reason, createdAt: String }
  let kind, publicId, customerName, maskedContact, arrivalAt, status: String
  let guestCount: Int
  let tableCodes: [String]
  let priorityBooking: Priority?
  let queueOverride: Override?
  var id: String { kind + ":" + publicId }
  var active: Bool {
    if kind == "waitlist" { return ["waiting", "notified", "arrived"].contains(status) }
    return !["completed", "cancelled", "no_show", "expired", "converted"].contains(status)
  }
  var statusLabel: String {
    kind == "waitlist" ? ReservationCommands.waitlistStatuses[status] ?? "状态待核对"
      : LiveReservation.labels[status] ?? "状态待核对"
  }
}
struct ReservationCapabilities: Decodable {
  let durableTransitions, durablePriority: Bool
  var admissionCreateV1: Bool? = nil
  var receptionSeatV1: Bool? = nil
  var tableBoundCreate: Bool? = nil
  let durableCreate: Bool?
  var durableWaitlist: Bool? = nil
}
struct WaitlistCapabilities: Decodable { let durableTransitions: Bool }
struct ReservationQuery: Equatable {
  let range, from, to: String
  static func day(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "Asia/Shanghai")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
  }
  static func window(from: String, to: String) throws -> (String, String) {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "Asia/Shanghai")
    f.dateFormat = "yyyy-MM-dd"
    f.isLenient = false
    guard let a = f.date(from: from), let b = f.date(from: to), f.string(from: a) == from,
      f.string(from: b) == to, b >= a, b.timeIntervalSince(a) <= 30 * 86400
    else { throw CatalogError("请选择有效日期，最多连续查询31天") }
    let iso = ISO8601DateFormatter()
    return (iso.string(from: a), iso.string(from: b.addingTimeInterval(86400)))
  }
  var path: String {
    get throws {
      guard ["current", "carryover", "history"].contains(range) else {
        throw CatalogError("预约范围无效")
      }
      if range == "current" { return "/api/staff/reservations" }
      if range == "carryover" { return "/api/staff/reservations?range=carryover" }
      let w = try Self.window(from: from, to: to)
      return "/api/staff/reservations?range=history&from=" + LiveCommand.pathPart(w.0) + "&to="
        + LiveCommand.pathPart(w.1)
    }
  }
  var intakePath: String {
    get throws {
      let w = try Self.window(from: from, to: to)
      return "/api/staff/reservation-intake?from=" + LiveCommand.pathPart(w.0) + "&to="
        + LiveCommand.pathPart(w.1)
    }
  }
}
enum ReservationCommands {
  static let waitlistStatuses = ["waiting": "等待中", "notified": "已联系", "arrived": "已到店",
    "seated": "已入座", "cancelled": "已取消", "expired": "已过期"]
  static let waitlistLabels = ["notified": "已联系客人", "arrived": "确认已到店",
    "seated": "已安排入座", "cancelled": "取消候位", "expired": "结束过期候位"]
  static func waitlistActions(_ status: String) -> [String] {
    switch status {
    case "waiting": return ["notified", "arrived", "cancelled", "expired"]
    case "notified": return ["arrived", "cancelled", "expired"]
    case "arrived": return ["seated", "cancelled"]
    default: return []
    }
  }
  static func waitlist(
    _ row: LiveReservationIntake, to: String, reason: String, actor: StaffIdentity
  ) throws -> LiveCommand {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard row.kind == "waitlist", waitlistActions(row.status).contains(to),
      actor.allows("reservation.manage"), (2...500).contains(note.utf16.count),
      (8...128).contains(row.publicId.utf16.count),
      row.publicId.trimmingCharacters(in: .whitespacesAndNewlines) == row.publicId
    else { throw CatalogError("请刷新核对原候位状态，填写2—500字实际处理说明") }
    return try make(actor: actor, title: "\(waitlistLabels[to]!) · \(row.customerName)",
      path: "/api/staff/native-waitlist/" + LiveCommand.pathPart(row.publicId) + "/transition",
      body: ["expectedStatus": row.status, "to": to, "reason": note],
      proof: ["kind": "waitlist", "publicId": row.publicId, "status": to,
        "previousStatus": row.status, "reason": note,
        "confirmation": "\(row.customerName) · \(row.guestCount)人 · \(row.publicId)\n候位状态：\(row.statusLabel) → \(waitlistStatuses[to]!)\n\(waitlistLabels[to]!)\n说明：\(note)\n仅记录已完成的现场处理，不会自动联系客人、开台或退款。取消候位不代替已有收款的退款处理。"])
  }
  static let labels = [
    "confirm": "确认预约", "arrive": "确认已到店", "complete": "完成预约", "cancel": "取消预约", "promote": "上调优先级",
    "demote": "下调优先级", "clear": "恢复默认排序",
  ]
  static func transition(
    _ row: LiveReservation, action: String, reason: String, override: Bool, actor: StaffIdentity
  ) throws -> LiveCommand {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows("reservation.manage"), row.actions.contains(action), note.utf16.count <= 500,
      action != "cancel" || note.utf16.count >= 2,
      !override || action == "cancel" && actor.allows("reservation.cancel.override")
    else { throw CatalogError("请刷新预约并核对权限；取消须填写原因") }
    var body: [String: Any] = [:]
    if !note.isEmpty { body["reason"] = note }
    if action == "cancel" { body["overridePolicy"] = override }
    return try make(
      actor: actor, title: (labels[action] ?? "预约处理") + " · " + row.customerName,
      path: "/api/staff/native-reservations/" + LiveCommand.pathPart(row.id) + "/" + action,
      body: body,
      proof: [
        "kind": "transition", "id": row.id, "publicId": row.publicId,
        "status": [
          "confirm": "confirmed", "arrive": "arrived", "complete": "completed",
          "cancel": "cancelled",
        ][action]!,
        "confirmation":
          "\(row.customerName) · \(row.guestCount)人 · \(row.tables)\n\(row.arrivalAt)\n"
          + (labels[action] ?? "") + "\n" + note + (override ? "\n主管例外取消；此操作不会退款。" : ""),
      ])
  }
  static func priority(
    _ row: LiveReservationIntake, mode: String, reason: String, actor: StaffIdentity
  ) throws -> LiveCommand {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows("reservation.manage"), row.active,
      ["reservation", "waitlist"].contains(row.kind),
      ["promote", "demote", "clear"].contains(mode), (2...500).contains(note.utf16.count)
    else { throw CatalogError("请核对队列并填写2—500字调整原因") }
    return try make(
      actor: actor, title: (labels[mode] ?? "调整排序") + " · " + row.customerName,
      path: "/api/staff/native-reservation-intake/" + row.kind + "/"
        + LiveCommand.pathPart(row.publicId) + "/priority-override",
      body: ["mode": mode, "reason": note],
      proof: [
        "kind": "priority", "targetKind": row.kind, "publicId": row.publicId, "mode": mode,
        "reason": note,
        "confirmation": row.customerName + " · " + (labels[mode] ?? "调整排序") + "\n" + note
          + "\n仅调整同一到店时段内的排序，不承诺新增座位。",
      ])
  }
  static func make(
    actor: StaffIdentity, title: String, path: String, body: [String: Any], proof: [String: Any]
  ) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: "reservation.manage",
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-business-" + id,
          recoveryBody: try JSONSerialization.data(
            withJSONObject: ["reservation": proof], options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var reservationProof: [String: Any]? {
    guard let recoveryBody,
      let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return root["reservation"] as? [String: Any]
  }
}
func validateReservationReply(_ bytes: Data, step: LiveCommand.Step) throws {
  struct Envelope: Decodable {
    struct Meta: Decodable { let replayed: Bool }
    let meta: Meta
  }
  _ = try JSONDecoder().decode(Envelope.self, from: bytes)
  guard let p = step.reservationProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool, let id = data["id"] as? String, !id.isEmpty,
    data["publicId"] as? String == p["publicId"] as? String
  else { throw StaffAPIError.invalid }
  if p["kind"] as? String == "create" {
    let body = step.object
    guard data["status"] as? String == body["initialStatus"] as? String,
      data["customerName"] as? String == body["customerName"] as? String,
      data["guestCount"] as? Int == body["guestCount"] as? Int,
      let at = data["arrivalAt"] as? String, let end = data["expectedEndAt"] as? String,
      assignmentDate(at) == assignmentDate(body["arrivalAt"] as? String ?? ""),
      assignmentDate(end) == assignmentDate(body["expectedEndAt"] as? String ?? ""),
      let locks = data["tableLocks"] as? [[String: Any]], let ids = body["tableIds"] as? [String],
      locks.count == ids.count, Set(locks.compactMap { $0["tableId"] as? String }) == Set(ids)
    else { throw StaffAPIError.invalid }
  } else if p["kind"] as? String == "transition" {
    guard id == p["id"] as? String, data["status"] as? String == p["status"] as? String else {
      throw StaffAPIError.invalid
    }
  } else if p["kind"] as? String == "waitlist" {
    guard let publicID = p["publicId"] as? String,
      step.path == "/api/staff/native-waitlist/" + LiveCommand.pathPart(publicID) + "/transition",
      let previous = p["previousStatus"] as? String, let target = p["status"] as? String,
      ReservationCommands.waitlistActions(previous).contains(target),
      data["status"] as? String == target, data["previousStatus"] as? String == previous,
      data["reason"] as? String == p["reason"] as? String,
      step.object["expectedStatus"] as? String == previous,
      step.object["to"] as? String == target,
      step.object["reason"] as? String == p["reason"] as? String
    else { throw StaffAPIError.invalid }
  } else {
    guard p["kind"] as? String == "priority",
      data["targetKind"] as? String == p["targetKind"] as? String,
      data["mode"] as? String == p["mode"] as? String,
      data["reason"] as? String == p["reason"] as? String, let at = data["createdAt"] as? String,
      assignmentDate(at) != nil
    else { throw StaffAPIError.invalid }
  }
}

struct ReservationTable: Decodable, Identifiable {
  let id, code, areaName: String
  let capacity: Int
}
struct ReservationDraft {
  var name = "", contact = "", note = "", source = "phone", seat = "no_preference",
    initial = "confirmed"
  var people = 2
  var arrival = Date().addingTimeInterval(3600)
  var end = Date().addingTimeInterval(10800)
  var tables: Set<String> = []
  func command(actor: StaffIdentity, choices: [ReservationTable], now: Date = Date()) throws
    -> LiveCommand
  {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let contact = contact.trimmingCharacters(in: .whitespacesAndNewlines)
    let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let selected = choices.filter { tables.contains($0.id) }
    guard actor.allows("reservation.manage"), !name.isEmpty, name.utf16.count <= 120,
      !contact.isEmpty, contact.utf16.count <= 256, note.utf16.count <= 2000,
      (1...200).contains(people), arrival > now, end > arrival, (1...20).contains(tables.count),
      selected.count == tables.count,
      selected.reduce(0, { $0 + $1.capacity }) >= people, ["phone", "employee"].contains(source),
      ["confirmed", "pending"].contains(initial),
      ["no_preference", "stage_atmosphere", "quiet_chat", "comfortable_booth", "outdoor_view"]
        .contains(seat)
    else { throw CatalogError("请核对姓名、联系方式、未来到店时间及结束时间，选择足够容量的1—20张桌台") }
    let id = "NRES-" + UUID().uuidString.lowercased()
    let f = ISO8601DateFormatter()
    return try ReservationCommands.make(
      actor: actor, title: "新建预约 · " + name, path: "/api/staff/native-reservations",
      body: [
        "publicId": id, "customerName": name, "contactToken": contact, "guestCount": people,
        "arrivalAt": f.string(from: arrival), "expectedEndAt": f.string(from: end),
        "source": source, "seatPreference": seat, "initialStatus": initial, "note": note,
        "tableIds": tables.sorted(),
      ],
      proof: [
        "kind": "create", "publicId": id,
        "confirmation":
          "\(name) · \(people)人 · \(selected.map(\.code).joined(separator:"、"))\n\(reservationDraftTime(arrival)) — \(reservationDraftTime(end))\n\(initial=="pending" ? "暂留待确认，逾时会释放座位" : "确认预约")\n未收取定金；到店后还需开台。",
      ])
  }
}
func reservationDraftTime(_ date: Date) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: "zh_CN")
  f.timeZone = TimeZone(identifier: "Asia/Shanghai")
  f.dateFormat = "MM-dd HH:mm"
  return f.string(from: date)
}
