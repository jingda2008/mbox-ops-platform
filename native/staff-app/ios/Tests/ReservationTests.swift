import Foundation

@main struct ReservationTests {
  static func main() throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let f =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: dir.appending(path: "live-reservations.json"))) as! [String: Any]
    func data(_ x: Any) throws -> Data { try JSONSerialization.data(withJSONObject: x) }
    func decode<T: Decodable>(_ t: T.Type, _ x: Any) throws -> T {
      try JSONDecoder().decode(t, from: data(x))
    }
    let actor = try decode(StaffIdentity.self, f["auth"]!)
    let row = try decode(LiveReservation.self, f["row"]!)
    let queue = try decode(LiveReservationIntake.self, f["queue"]!)
    var count = 0
    func check(_ x: Bool, _ label: String) {
      precondition(x, label)
      count += 1
      print("PASS " + label)
    }
    func rejects(_ work: () throws -> Void) -> Bool {
      do {
        try work()
        return false
      } catch { return true }
    }
    let command = try ReservationCommands.transition(
      row, action: "confirm", reason: "已核对", override: false, actor: actor)
    let step = command.steps[0]
    check(
      step.path == "/api/staff/native-reservations/reservation-1/confirm"
        && step.key.hasPrefix("native-business-"), "isolated native endpoint with original key")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "complete", reason: "", override: false, actor: actor)
      }, "pending cannot complete")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "cancel", reason: "", override: false, actor: actor)
      }, "cancel reason required")
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "confirm", reason: "", override: true, actor: actor)
      }, "override only applies to cancellation")
    var auth = f["auth"] as! [String: Any]
    auth["deniedPermissions"] = ["reservation.cancel.override"]
    let denied = try decode(StaffIdentity.self, auth)
    check(
      rejects {
        _ = try ReservationCommands.transition(
          row, action: "cancel", reason: "客户取消", override: true, actor: denied)
      }, "live denial overrides grant")
    var receipt = f["row"] as! [String: Any]
    receipt["status"] = "confirmed"
    try validateReservationReply(data(["data": receipt, "meta": ["replayed": true]]), step: step)
    count += 1
    for (k, v) in [("id", "other"), ("publicId", "other"), ("status", "arrived")] {
      var copy = receipt
      copy[k] = v
      check(
        rejects {
          try validateReservationReply(
            data(["data": copy, "meta": ["replayed": false]]), step: step)
        }, "receipt mismatch retained: " + k)
    }
    let priority = try ReservationCommands.priority(
      queue, mode: "promote", reason: "客户现场说明", actor: actor)
    let proof = priority.steps[0].reservationProof!
    check(
      proof["targetKind"] as? String == "reservation" && proof["mode"] as? String == "promote",
      "queue action binds target kind")
    check(
      rejects {
        _ = try ReservationCommands.priority(queue, mode: "anything", reason: "说明", actor: actor)
      }, "arbitrary queue action blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-02-30", to: "2026-03-01") },
      "invalid calendar date blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-09-30", to: "2026-09-01") },
      "reversed dates blocked")
    check(
      rejects { _ = try ReservationQuery.window(from: "2026-09-01", to: "2026-10-02") },
      "query has bounded window")
    let window = try ReservationQuery.window(from: "2026-09-28", to: "2026-09-28")
    check(
      window.0 == "2026-09-27T16:00:00Z" && window.1 == "2026-09-28T16:00:00Z",
      "inclusive Shanghai date becomes half-open UTC interval")
    let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(priority))
    check(restored == priority, "relaunch preserves priority request")
    let choices=[ReservationTable(id:"table-1",code:"A5",areaName:"大厅",capacity:4)]
    var draft=ReservationDraft();draft.name="顾客";draft.contact="测试联系方式";draft.tables=["table-1"]
    let creation=try draft.command(actor:actor,choices:choices)
    check(creation.steps[0].path=="/api/staff/native-reservations" && creation.steps[0].object["publicId"] as? String==creation.steps[0].reservationProof?["publicId"] as? String,"creation keeps stable original public id and request key")
    let restoredCreate=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(creation));check(restoredCreate==creation,"new reservation survives relaunch as original command")
    draft.people=5;check(rejects{_=try draft.command(actor:actor,choices:choices)},"insufficient table capacity blocked")
    draft.people=2;draft.arrival=Date(timeIntervalSince1970:0);check(rejects{_=try draft.command(actor:actor,choices:choices)},"past arrival blocked before creating command")
    var created=creation.steps[0].object;created["id"]="new-reservation";created["status"]="confirmed";created["tableLocks"]=[["tableId":"table-1"]]
    try validateReservationReply(data(["data":created,"meta":["replayed":true]]),step:creation.steps[0]);count+=1
    created["guestCount"]=99;check(rejects{try validateReservationReply(data(["data":created,"meta":["replayed":false]]),step:creation.steps[0])},"wrong creation receipt count remains unknown")
    print("Reservation tests: \(count) passed")
  }
}
