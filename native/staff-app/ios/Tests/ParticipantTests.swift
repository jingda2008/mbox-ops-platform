import Foundation

@main struct ParticipantTests {
  static func main() throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-participants.json"))) as! [String: Any]
    func data(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ t: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(t, from: data(x))
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let board = try decode(LiveOperations.self, f["operations"]!)
    let members = try decode([LiveParticipant].self, f["members"]!)
    var count = 0
    func check(_ yes: Bool, _ label: String) {
      precondition(yes, label)
      count += 1
      print("PASS " + label)
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    func input(_ quantity: Int = 1, _ selected: Set<String> = ["person-1"], _ target: Int = 1)
      throws -> ParticipantInput
    {
      try .make(
        actor: actor, source: board.tables[0], target: board.tables[target], members: members,
        selected: selected, quantity: quantity, kind: "participant_split", reason: "顾客分坐",
        capacityReason: "")
    }
    let item = try input()
    let raw = f["preview"] as! [String: Any]
    let preview = try decode(ParticipantPreview.self, raw)
    let cmd = try preview.command(input: item, actor: actor, confirmed: true)
    let step = cmd.steps[0]
    check(
      step.path.hasSuffix("native-participant-movements") && step.keyHeader == "x-idempotency-key",
      "native path uses isolated durable receipt")
    let guardBody = step.object["nativeGuard"] as! [String: Any]
    check(
      guardBody["sourceLocationVersion"] as? Int == 7 && guardBody["sourceGuestCount"] as? Int == 2,
      "source version and count are captured")
    check(rejects { _ = try input(2) }, "split must leave a person")
    check(rejects { _ = try input(1, []) }, "split must identify customer")
    check(rejects { _ = try input(1, ["unknown"]) }, "unknown participant rejected")
    check(rejects { _ = try input(1, ["person-1"], 2) }, "paused destination rejected")
    check(
      rejects { _ = try preview.command(input: item, actor: actor, confirmed: false) },
      "physical confirmation required")
    for (key, value) in [
      ("supportsNativeParticipantRecovery", false as Any), ("selectedParticipantCount", 2),
      ("targetTableId", "wrong"), ("projectedGuestCount", 2), ("finalRevalidationRequired", false),
      ("requiresCapacityOverride", true),
      ("blockers", [["code": "orders", "label": "未结单", "resolution": "先处理原单", "count": 1]]),
    ] {
      var changed = raw
      changed[key] = value
      let p = try decode(ParticipantPreview.self, changed)
      check(
        rejects { _ = try p.command(input: item, actor: actor, confirmed: true) },
        "preflight rejects " + key)
    }
    let receipt = f["receipt"] as! [String: Any]
    try validateParticipantReply(data(receipt), step: step)
    count += 1
    for (key, value) in [
      ("movedParticipantCount", 2 as Any), ("targetGuestCountAfter", 2),
      ("targetCapacityAtMovement", 8), ("occurredAt", "bad"), ("targetTableSessionId", ""),
    ] {
      var changed = receipt
      var row = receipt["data"] as! [String: Any]
      row[key] = value
      changed["data"] = row
      check(
        rejects { try validateParticipantReply(data(changed), step: step) },
        "invalid receipt preserves unknown: " + key)
    }
    let recovered = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(cmd))
    check(
      recovered == cmd && recovered.steps[0].participantProof != nil,
      "kill and relogin preserve proof, original key and body")
    print("Participant tests: \(count) passed")
  }
}
