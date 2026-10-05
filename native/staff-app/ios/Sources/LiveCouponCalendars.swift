import Foundation
let couponCalendarLimitLabels = [("perCustomerDay", "每人每日次数"), ("perCustomerWeek", "每人每周次数"), ("perCustomerCampaign", "每人活动总次数")]
let couponRelativeBases = [("elapsed", "连续满24小时"), ("natural_end", "最后一个自然日结束"), ("business_end", "最后一个营业日结束")]
let couponWeekdayNames = ["一", "二", "三", "四", "五", "六", "日"]
func couponCalendarDay(_ text: String) throws -> Date {
  guard text.range(of: "^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { throw CatalogError("日期须为有效 YYYY-MM-DD，年份不早于2000") }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
  guard let d = f.date(from: text), f.string(from: d) == text else { throw CatalogError("日期不存在") }; return d
}
func couponCalendarMinute(_ text: String, end: Bool = false) throws -> Int {
  if end && text == "24:00" { return 1440 }
  guard text.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil else { throw CatalogError("时刻须为HH:mm，结束可以为24:00") }
  let values = text.split(separator: ":").compactMap { Int($0) }; return values[0] * 60 + values[1]
}
func couponCalendarClock(_ minute: Int) -> String { String(format: "%02d:%02d", minute / 60, minute % 60) }
func couponCalendarRule(_ input: [String: Any]) throws -> [String: Any] {
  guard input["timezone"] as? String == "Asia/Shanghai", let basis = input["dateBasis"] as? String, ["natural", "business"].contains(basis),
    let first = input["dateFrom"] as? String, let last = input["dateThrough"] as? String,
    let fromText = input["validFrom"] as? String, let untilText = input["validUntil"] as? String,
    let from = assignmentDate(fromText), let until = assignmentDate(untilText), until > from,
    let days = input["weekdays"] as? [Any], (1...7).contains(days.count), let rawWindows = input["windows"] as? [[String: Any]], (1...12).contains(rawWindows.count),
    let rawExcluded = input["excludedDates"] as? [String], rawExcluded.count <= 3661 else { throw CatalogError("请核对券日历的日期、星期、时段和绝对有效期") }
  let start = try couponCalendarDay(first), end = try couponCalendarDay(last)
  guard (0...Double(3660 * 86400)).contains(end.timeIntervalSince(start)) else { throw CatalogError("日期范围须正序且不超过3661天") }
  let cutoff = try couponPolicyInteger(input["businessDayStartMinute"], 0...1439), week = try couponPolicyInteger(input["weekStartsOn"], 1...7)
  guard basis != "natural" || cutoff == 0 else { throw CatalogError("自然日必须从零点开始") }
  let weekdays = try days.map { try couponPolicyInteger($0, 1...7) }.sorted(); guard Set(weekdays).count == weekdays.count else { throw CatalogError("星期不能重复") }
  let windows = try rawWindows.map { w -> [String: Int] in
    let a = try couponPolicyInteger(w["startMinute"], 0...1439), b = try couponPolicyInteger(w["endMinute"], 0...1440)
    guard a != b else { throw CatalogError("时段起止不能相同；全天请填00:00至24:00") }; return ["startMinute": a, "endMinute": b]
  }
  let excluded = Array(Set(rawExcluded)).sorted()
  for day in excluded { let d = try couponCalendarDay(day); guard d >= start && d <= end else { throw CatalogError("排除日期须位于活动日期范围内") } }
  let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  var result: [String: Any] = ["timezone": "Asia/Shanghai", "dateBasis": basis, "businessDayStartMinute": cutoff,
    "dateFrom": first, "dateThrough": last, "validFrom": iso.string(from: from), "validUntil": iso.string(from: until),
    "weekdays": weekdays, "weekStartsOn": week, "windows": windows, "excludedDates": excluded]
  if let r = input["relativeValidity"], !(r is NSNull) {
    guard let relative = r as? [String: Any], let mode = relative["basis"] as? String, couponRelativeBases.contains(where: { $0.0 == mode }), mode != "business_end" || basis == "business" else { throw CatalogError("发放后期限的结束口径无效；营业日结束须选择营业日") }
    result["relativeValidity"] = ["days": try couponPolicyInteger(relative["days"], 1...3660), "basis": mode]
  }
  return result
}
func couponCalendarLimits(_ input: [String: Any]) throws -> [String: Any] {
  guard Set(input.keys) == Set(couponCalendarLimitLabels.map(\.0)) else { throw StaffAPIError.invalid }
  var result: [String: Any] = [:]
  for (key, _) in couponCalendarLimitLabels { result[key] = input[key] is NSNull ? NSNull() : try couponPolicyInteger(input[key], 1...1_000_000) as Any }
  return result
}
struct CouponCalendarWindow: Identifiable, Equatable { let id = UUID(); var from = "00:00"; var to = "24:00" }
struct CouponCalendarDraft: Equatable {
  var fields: [String: String]
  var weekdays: Set<Int>
  var windows: [CouponCalendarWindow]
  init(row: CouponPolicyRecord? = nil, now: Date = Date()) {
    let rule = row?.object["rule"] as? [String: Any] ?? [:], limits = row?.object["limits"] as? [String: Any] ?? [:]
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd"
    let today = f.string(from: now), end = f.string(from: now.addingTimeInterval(30 * 86400)), until = f.string(from: now.addingTimeInterval(31 * 86400))
    fields = ["code": row?.text("code") ?? "", "expectedVersion": row?.text("version") ?? "0", "dateFrom": membershipText(rule["dateFrom"]).isEmpty ? today : membershipText(rule["dateFrom"]), "dateThrough": membershipText(rule["dateThrough"]).isEmpty ? end : membershipText(rule["dateThrough"]), "validFrom": (try? membershipLocal(membershipText(rule["validFrom"]))) ?? today + " 00:00:00", "validUntil": (try? membershipLocal(membershipText(rule["validUntil"]))) ?? until + " 00:00:00", "dateBasis": rule["dateBasis"] as? String ?? "natural", "cutoff": couponCalendarClock((try? walletInteger(rule["businessDayStartMinute"])) ?? 0), "weekStartsOn": membershipText(rule["weekStartsOn"]).isEmpty ? "1" : membershipText(rule["weekStartsOn"]), "excludedDates": (rule["excludedDates"] as? [String] ?? []).joined(separator: "\n"), "reason": ""]
    let relative = rule["relativeValidity"] as? [String: Any] ?? [:]; fields["relativeDays"] = membershipText(relative["days"]); fields["relativeBasis"] = relative["basis"] as? String ?? "elapsed"
    for (key, _) in couponCalendarLimitLabels { fields[key] = membershipText(limits[key]) }
    weekdays = Set(rule["weekdays"] as? [Int] ?? Array(1...7))
    windows = (rule["windows"] as? [[String: Any]])?.map { CouponCalendarWindow(from: couponCalendarClock((try? walletInteger($0["startMinute"])) ?? 0), to: couponCalendarClock((try? walletInteger($0["endMinute"])) ?? 1440)) } ?? [CouponCalendarWindow()]
  }
  func rule() throws -> [String: Any] {
    let basis = fields["dateBasis"] ?? "", excluded = (fields["excludedDates"] ?? "").components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",，"))).filter { !$0.isEmpty }
    var rule: [String: Any] = ["timezone": "Asia/Shanghai", "dateBasis": basis, "businessDayStartMinute": basis == "natural" ? 0 : try couponCalendarMinute(fields["cutoff"] ?? ""), "dateFrom": fields["dateFrom"] ?? "", "dateThrough": fields["dateThrough"] ?? "", "validFrom": try membershipDate(fields["validFrom"] ?? ""), "validUntil": try membershipDate(fields["validUntil"] ?? ""), "weekdays": weekdays.sorted(), "weekStartsOn": try walletInteger(fields["weekStartsOn"]), "windows": try windows.map { ["startMinute": try couponCalendarMinute($0.from), "endMinute": try couponCalendarMinute($0.to, end: true)] }, "excludedDates": excluded]
    if !(fields["relativeDays"] ?? "").isEmpty { rule["relativeValidity"] = ["days": try walletInteger(fields["relativeDays"]), "basis": fields["relativeBasis"] ?? ""] }
    return try couponCalendarRule(rule)
  }
  func save(row: CouponPolicyRecord?) throws -> [String: Any] {
    let code = try couponPolicyCode(fields["code"] ?? ""); var limits: [String: Any] = [:]
    for (key, _) in couponCalendarLimitLabels { let value = (fields[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines); limits[key] = value.isEmpty ? NSNull() : try couponPolicyInteger(value, 1...1_000_000) as Any }
    return ["code": code, "expectedVersion": row?.text("code") == code ? try row!.integer("version") : 0, "rule": try rule(), "limits": limits, "reason": try couponPolicyReason(fields["reason"] ?? "")]
  }
  func preview(at: String, issuedAt: String, from: String? = nil) throws -> [String: Any] {
    var body: [String: Any] = ["rule": try rule(), "at": try membershipDate(at)]
    if !issuedAt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["issuedAt"] = try membershipDate(issuedAt) }
    if let from { _ = try couponCalendarDay(from); body["from"] = from }; return body
  }
}
func couponCalendarSummary(_ source: [String: Any]) throws -> String {
  guard let raw = source["rule"] as? [String: Any], let l = source["limits"] as? [String: Any] else { throw StaffAPIError.invalid }
  let r = try couponCalendarRule(raw), limits = try couponCalendarLimits(l), days = r["weekdays"] as! [Int]
  var lines = ["北京时间 · " + (r["dateBasis"] as? String == "natural" ? "自然日" : "营业日") + "，换日 " + couponCalendarClock(try walletInteger(r["businessDayStartMinute"])),
    membershipText(r["dateFrom"]) + " 至 " + membershipText(r["dateThrough"]),
    "绝对有效期：" + (try membershipLocal(membershipText(r["validFrom"]))) + " 至 " + (try membershipLocal(membershipText(r["validUntil"]))) + "（含开始、不含结束）",
    "可用：" + days.map { "周" + couponWeekdayNames[$0 - 1] }.joined(separator: "、"), "每周次数从周" + couponWeekdayNames[(try walletInteger(r["weekStartsOn"])) - 1] + "起算"]
  lines += (r["windows"] as! [[String: Int]]).map { "时段 " + couponCalendarClock($0["startMinute"]!) + " 至 " + couponCalendarClock($0["endMinute"]!) + ($0["endMinute"]! < $0["startMinute"]! ? "（跨午夜）" : "") }
  let excluded = r["excludedDates"] as! [String]; lines.append("排除日期：" + (excluded.isEmpty ? "无" : excluded.joined(separator: "、")))
  if let relative = r["relativeValidity"] as? [String: Any] { lines.append("发放后 " + membershipText(relative["days"]) + " 天 · " + (couponRelativeBases.first { $0.0 == relative["basis"] as? String }?.1 ?? "")) } else { lines.append("发放后期限：不另设，相对期限始终与绝对有效期取交集") }
  for (k, label) in couponCalendarLimitLabels { lines.append(label + "：" + (limits[k] is NSNull ? "不额外限制" : membershipText(limits[k]))) }; return lines.joined(separator: "\n")
}
struct CouponCalendarPreview {
  let data: Data
  var object: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
  var next: String? { object["nextCalendarDate"] as? String }
  init(data: Data, actor: StaffIdentity, body: [String: Any]) throws {
    let d = try walletEnvelope(data)
    guard actor.allows(CouponPolicyKind.calendar.previewPermission), d["employeeId"] as? String == actor.employee.id, try walletInteger(d["protocol"]) == 1, try walletBoolean(d["previewOnly"]), d["boundary"] as? String == "start_inclusive_end_exclusive", let returned = d["rule"] as? [String: Any], let input = body["rule"] as? [String: Any], let days = d["calendar"] as? [[String: Any]], days.count <= 31 else { throw StaffAPIError.invalid }
    var expected = try couponCalendarRule(input)
    if body["issuedAt"] != nil { guard let validity = d["issuanceValidity"] as? [String: Any], let from = assignmentDate(membershipText(validity["validFrom"])), let until = assignmentDate(membershipText(validity["validUntil"])), let originalFrom = assignmentDate(membershipText(expected["validFrom"])), let originalUntil = assignmentDate(membershipText(expected["validUntil"])), from >= originalFrom, until <= originalUntil, until > from else { throw StaffAPIError.invalid }; expected["validFrom"] = validity["validFrom"]; expected["validUntil"] = validity["validUntil"] }
    guard membershipEqual(try couponCalendarRule(returned), try couponCalendarRule(expected)) else { throw CatalogError("日历预览与本次输入规则不一致") }
    _ = try walletBoolean(d["available"]); _ = try walletBoolean(d["hasUsableWindow"])
    for key in ["nextAvailableAt", "lastAvailableUntil"] { guard d[key] is NSNull || assignmentDate(membershipText(d[key])) != nil else { throw StaffAPIError.invalid } }
    for day in days { _ = try couponCalendarDay(membershipText(day["date"])); guard let windows = day["windows"] as? [[String: Any]] else { throw StaffAPIError.invalid }; for w in windows { guard let from = assignmentDate(membershipText(w["from"])), let until = assignmentDate(membershipText(w["until"])), until > from else { throw StaffAPIError.invalid } } }
    if let next = d["nextCalendarDate"] as? String { _ = try couponCalendarDay(next) } else if !(d["nextCalendarDate"] is NSNull) { throw StaffAPIError.invalid }
    self.data = try membershipData(d)
  }
}
