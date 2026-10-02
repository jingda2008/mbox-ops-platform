import Foundation

@main struct ServiceTests {
  static func main() throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-service.json"))) as! [String: Any]
    func data(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ t: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(t, from: data(x))
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let raw = f["board"] as! [String: Any]
    let board = try decode(LiveServiceBoard.self, raw)
    var count = 0
    func check(_ x: Bool, _ title: String) {
      precondition(x, title)
      count += 1
      print("PASS " + title)
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    func command(
      _ action: String = "complete", note: String = "已与客人沟通处理", employee: String = "manager-2",
      priority: String = "normal", b: LiveServiceBoard? = nil
    ) throws -> LiveCommand {
      try (b ?? board).command(
        id: "task-1", action: action, note: note, employee: employee, priority: priority,
        actor: actor)
    }
    let completed = try command()
    let step = completed.steps[0]
    check(
      step.object["tableSessionId"] as? String == "session-old",
      "task binds original session after table reuse")
    check(completed.permission == "service.manage", "complaint needs manager permission")
    check(rejects { _ = try command(note: "完成") }, "complaint needs recorded result")
    check(
      rejects { _ = try command("assign", employee: "worker-2") },
      "complaint cannot transfer to ordinary employee")
    let assigned = try command("assign")
    check(
      assigned.steps[0].serviceProof?["assignedEmployeeId"] as? String == "manager-2",
      "handoff receipt binds intended staff")
    check(
      rejects { _ = try command("priority", priority: "urgent") }, "unchanged priority is blocked")
    check(rejects { _ = try command("arbitrary") }, "unknown action blocked")
    var row = (raw["tasks"] as! [[String: Any]])[0]
    row["status"] = "completed"
    var receipt: [String: Any] = ["data": row, "meta": ["replayed": true]]
    try validateServiceReply(data(receipt), step: step)
    count += 1
    row["tableSessionId"] = "new-session"
    receipt["data"] = row
    check(
      rejects { try validateServiceReply(data(receipt), step: step) },
      "wrong-session receipt stays unknown")
    for kind in ["goods.redelivery", "experience.followup"] {
      var changed = raw
      var item = (raw["tasks"] as! [[String: Any]])[0]
      item["taskType"] = kind
      changed["tasks"] = [item]
      let b = try decode(LiveServiceBoard.self, changed)
      check(
        rejects { _ = try command(b: b) }, "specialized task preserves original workflow " + kind)
    }
    var experienceRaw = raw
    var experienceRow = (raw["tasks"] as! [[String: Any]])[0]
    experienceRow["taskType"] = "experience.followup"
    experienceRaw["tasks"] = [experienceRow]; experienceRaw["durableExperience"] = true
    let experience = try decode(LiveServiceBoard.self, experienceRaw)
    let done = try command(b: experience)
    check(done.steps[0].serviceProof?["experience"] as? Bool == true, "experience completion requests linked cue proof")
    check(rejects { _ = try command("cancel", b: experience) }, "individual cancellation cannot strand the experience plan")
    check(rejects { _ = try command(note: "", b: experience) }, "experience requires actual handling result")
    experienceRow["status"] = "completed"
    check(rejects { try validateServiceReply(data(["data": experienceRow, "meta": ["replayed": true]]), step: done.steps[0]) }, "ordinary task receipt cannot stand in for experience completion")
    experienceRow["nativeExperienceCue"] = ["cueId": "cue-1", "planId": "plan-1", "serviceTaskId": "task-1", "tableSessionId": "session-old", "status": "completed"]
    try validateServiceReply(data(["data": experienceRow, "meta": ["replayed": true]]), step: done.steps[0]); count += 1
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(assigned))
    check(restored == assigned, "original body, actor and receipt survive relaunch")
    let kitchenRaw =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-kitchen.json"))) as! [String: Any]
    var kitchenCopy = kitchenRaw
    var rows = kitchenRaw["pending"] as! [[String: Any]]
    var other = rows[0]
    other["taskId"] = "task-other"
    other["tableCode"] = "B2"
    other["tableId"] = "table-other"
    other["tableSessionId"] = "session-other"
    rows.append(other)
    kitchenCopy["pending"] = rows
    let kitchen = try decode(LiveKitchen.self, kitchenCopy)
    let multi = try kitchen.command(
      actor: actor, action: "start", sourceID: "task1", selections: ["task1": 2, "task-other": 1])
    let payload = multi.steps[0].object["command"] as! [String: Any]
    let items = payload["items"] as! [[String: Any]]
    check(
      items.count == 2 && items.contains { $0["tableSessionId"] as? String == "session-other" },
      "cross-table batch retains each original session")
    check(
      rejects {
        _ = try kitchen.command(
          actor: actor, action: "start", sourceID: "task1", selections: ["task1": 99])
      }, "per-item overflow blocked")
    check(
      rejects {
        _ = try kitchen.command(
          actor: actor, action: "start", sourceID: "task1", selections: ["missing": 1])
      }, "missing selected row blocked")
    other["itemNote"] = "不同备注"
    kitchenCopy["pending"] = [rows[0], other]
    let incompatible = try decode(LiveKitchen.self, kitchenCopy)
    check(
      rejects {
        _ = try incompatible.command(
          actor: actor, action: "start", sourceID: "task1",
          selections: ["task1": 1, "task-other": 1])
      }, "incompatible note cannot batch")
    check(
      try HistoryQuery(workKind: "prepared").path().contains("workKind=prepared"),
      "dedicated work history keeps actor scope")
    check(
      rejects { _ = try HistoryQuery(workKind: "arbitrary").path() },
      "invalid work history rejected")
    print("Service and work tests: \(count) passed")
  }
}
