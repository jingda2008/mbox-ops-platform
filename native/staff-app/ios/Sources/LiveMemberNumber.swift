import Foundation
let memberNumberRoot = "/api/staff/native-member-number-policy"
struct MemberNumberPolicy: Equatable {
  let width, startNumber, maximumPrefixLength: Int
  let alphabet: String
  let padZero: Bool
  init(_ object: [String: Any]) throws {
    guard Set(object.keys) == ["width", "startNumber", "maximumPrefixLength", "alphabet", "padZero"] else { throw StaffAPIError.invalid }
    width = try walletInteger(object["width"]); startNumber = try walletInteger(object["startNumber"]); maximumPrefixLength = try walletInteger(object["maximumPrefixLength"]); padZero = try walletBoolean(object["padZero"])
    guard let alphabet = object["alphabet"] as? String, alphabet.range(of: "^[A-Z]{1,26}$", options: .regularExpression) != nil, Set(alphabet).count == alphabet.count,
      (4...12).contains(width), (1...999_999_999_999).contains(startNumber), (0...4).contains(maximumPrefixLength), width - maximumPrefixLength >= 2,
      startNumber < (0..<width).reduce(1, { value, _ in value * 10 }) else { throw CatalogError("号段总位数须4—12，前缀至多4位且留至少2位数字；起始数不超位数；字母顺序须不重复大写A—Z") }
    self.alphabet = alphabet
  }
  var object: [String: Any] { ["width": width, "startNumber": startNumber, "maximumPrefixLength": maximumPrefixLength, "alphabet": alphabet, "padZero": padZero] }
}
struct MemberNumberBoard {
  let employeeID: String
  let policy: MemberNumberPolicy
  let version: Int
  let nextCandidate: String?
  let enabled: Bool
  init(data: Data, actor: StaffIdentity) throws {
    let d = try walletEnvelope(data)
    guard actor.allows("member.card.manage"), d["employeeId"] as? String == actor.employee.id,
      try walletInteger(d["protocol"]) == 1, let row = d["row"] as? [String: Any], let p = row["policy"] as? [String: Any] else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; policy = try MemberNumberPolicy(p); version = try walletInteger(row["version"]); enabled = try walletBoolean(d["durableCommands"])
    nextCandidate = try memberNumberCandidate(row["nextCandidate"])
  }
  func command(actor: StaffIdentity, fields: [String: String], padZero: Bool, reason: String, now: Date = Date()) throws -> LiveCommand {
    guard enabled, actor.employee.id == employeeID, actor.allows("member.card.manage"), StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > now }) == true else { throw CatalogError("原员工、权限或号段能力已变化，请刷新") }
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...300).contains(reason.utf16.count) else { throw CatalogError("请填写2—300字变更原因") }
    let policy = try MemberNumberPolicy(["width": try walletInteger(fields["width"]), "startNumber": try walletInteger(fields["startNumber"]), "maximumPrefixLength": try walletInteger(fields["maximumPrefixLength"]), "alphabet": (fields["alphabet"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines), "padZero": padZero])
    let body: [String: Any] = ["policy": policy.object, "version": version, "reason": reason]
    let text = "会员号总位数 \(policy.width) · 起始数字 \(policy.startNumber)\n字母顺序 \(policy.alphabet) · 最长前缀 \(policy.maximumPrefixLength)\n" + (policy.padZero ? "不足位数补零" : "不足位数不补零") + "\n只影响新发号，已发会员号保持不变；实际发号仍跳过已占用号码。\n原配置版本：\(version)\n原因：" + reason
    let id = UUID().uuidString.lowercased()
    return LiveCommand(id: id, employeeID: employeeID, title: "调整会员号规则", permission: "member.card.manage", steps: [.init(path: memberNumberRoot, body: try membershipData(body), keyHeader: "idempotency-key", key: "native-business-" + id, recoveryBody: try membershipData(["memberNumber": ["employeeId": employeeID, "confirmation": text]]))])
  }
}
func memberNumberCandidate(_ value: Any?) throws -> String? {
  if value is NSNull { return nil }
  guard let text = value as? String, text.range(of: "^[A-Z0-9]{1,12}$", options: .regularExpression) != nil else { throw StaffAPIError.invalid }; return text
}
extension LiveCommand.Step {
  var memberNumberProof: [String: Any]? { guard let recoveryBody else { return nil }; return ((try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any])?["memberNumber"] as? [String: Any] }
}
func validateMemberNumberReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard step.path == memberNumberRoot, let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let meta = root["meta"] as? [String: Any],
    try walletInteger(meta["protocol"]) == 1, let d = root["data"] as? [String: Any], let proof = step.memberNumberProof,
    d["employeeId"] as? String == proof["employeeId"] as? String, d["requestKey"] as? String == step.key,
    let accepted = d["accepted"] as? [String: Any], membershipEqual(accepted, step.object), let row = d["row"] as? [String: Any],
    let policy = row["policy"] as? [String: Any], let requested = step.object["policy"] as? [String: Any],
    try MemberNumberPolicy(policy) == MemberNumberPolicy(requested) else { throw StaffAPIError.invalid }
  _ = try walletBoolean(meta["replayed"]); _ = try memberNumberCandidate(row["nextCandidate"])
  let version = try walletInteger(step.object["version"])
  guard try walletInteger(row["version"]) == (version == 0 ? 2 : version + 1) else { throw StaffAPIError.invalid }
}
