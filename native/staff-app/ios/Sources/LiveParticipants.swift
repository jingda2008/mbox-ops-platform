import Foundation

struct LiveParticipant: Decodable, Identifiable {
  var id: String { publicId }
  let publicId, customerPublicId, role, confirmationState, identityLevel, locationStartedAt: String
  let seatLabel: String?
  var label: String {
    (seatLabel?.isEmpty == false ? seatLabel! : identityLevel == "member" ? "会员" : "顾客")
  }
  var detail: String {
    (["organizer": "主联系人", "payer": "付款人", "reservation_owner": "预约人", "companion": "同行顾客"][role]
      ?? "角色待确认")
      + " · " + (["confirmed": "身份已确认", "corrected": "身份已更正"][confirmationState] ?? "请当面确认身份")
  }
}
struct ParticipantInput {
  static let permission = "table.participation.manage"
  let employeeID, sourceID, sourceCode, session, targetID, targetCode, kind: String
  let sourceGuests, sourceVersion, quantity: Int
  let targetSession: String?
  let participants: [String]
  let reason, capacityReason: String
  var path: String { "/api/table-management/sessions/" + LiveCommand.pathPart(session) }
  var body: [String: Any] {
    var body: [String: Any] = [
      "sourceTableSessionId": session, "movementKind": kind, "targetTableId": targetID,
      "targetTableSessionId": targetSession as Any? ?? NSNull(), "movedGuestCount": quantity,
      "participantPublicIds": participants, "reason": reason,
    ]
    if !capacityReason.isEmpty { body["capacityOverrideReason"] = capacityReason }
    return body
  }
  static func make(
    actor: StaffIdentity, source: LiveOperations.Table, target: LiveOperations.Table,
    members: [LiveParticipant], selected: Set<String>, quantity: Int, kind: String, reason: String,
    capacityReason: String
  ) throws -> Self {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    let capacity = capacityReason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard actor.allows(permission), source.id != target.id,
      let session = source.activeSession, session.status == "open",
      let version = session.locationVersion,
      (1...200).contains(quantity), quantity <= session.guestCount,
      Set(members.map(\.id)).count == members.count, selected.isSubset(of: Set(members.map(\.id))),
      quantity >= selected.count, (2...1000).contains(note.utf16.count),
      capacity.utf16.count <= 1000,
      capacity.isEmpty || capacity.utf16.count >= 2,
      ["participant_split", "participant_merge"].contains(kind)
    else { throw CatalogError("请核对原桌次、实际人数、顾客名单、目标桌和原因") }
    if kind == "participant_split" {
      guard !selected.isEmpty, quantity < session.guestCount, target.status == "available",
        target.activeSession == nil
      else {
        throw CatalogError("拆桌须选择顾客和空闲桌，原桌至少保留一人")
      }
    } else {
      guard target.activeSession?.status == "open",
        members.isEmpty ? quantity == session.guestCount : !selected.isEmpty,
        quantity != session.guestCount || selected.count == members.count
      else {
        throw CatalogError("并桌须选择营业中的目标桌；全员并桌应选齐全部顾客并确认整桌人数")
      }
    }
    return Self(
      employeeID: actor.employee.id, sourceID: source.id, sourceCode: source.code,
      session: session.id,
      targetID: target.id, targetCode: target.code, kind: kind, sourceGuests: session.guestCount,
      sourceVersion: version,
      quantity: quantity, targetSession: target.activeSession?.id, participants: selected.sorted(),
      reason: note, capacityReason: capacity)
  }
}
struct ParticipantPreview: Decodable {
  struct Blocker: Decodable {
    let code, label, resolution: String
    let count: Int
  }
  struct Adjustment: Decodable { let participantPublicId, fromRole, toRole, reason: String }
  let supportsNativeParticipantRecovery: Bool?
  let movementKind, targetTableId, accountingBoundary: String
  let targetTableSessionId: String?
  let movedGuestCount, selectedParticipantCount, targetCapacity, projectedGuestCount: Int
  let requiresCapacityOverride, finalRevalidationRequired: Bool
  let roleAdjustments: [Adjustment]
  let blockers: [Blocker]
  func command(input: ParticipantInput, actor: StaffIdentity, confirmed: Bool) throws -> LiveCommand
  {
    guard supportsNativeParticipantRecovery == true, actor.employee.id == input.employeeID,
      actor.allows(ParticipantInput.permission), confirmed, finalRevalidationRequired,
      movementKind == input.kind, targetTableId == input.targetID,
      targetTableSessionId == input.targetSession,
      movedGuestCount == input.quantity, selectedParticipantCount == input.participants.count,
      (1...200).contains(targetCapacity), (1...200).contains(projectedGuestCount),
      projectedGuestCount >= movedGuestCount, blockers.isEmpty,
      roleAdjustments.allSatisfy({
        input.participants.contains($0.participantPublicId) && $0.fromRole == "organizer"
          && $0.toRole == "companion"
      }),
      requiresCapacityOverride == (projectedGuestCount > targetCapacity),
      requiresCapacityOverride == !input.capacityReason.isEmpty,
      input.kind != "participant_split" || projectedGuestCount == movedGuestCount
    else { throw CatalogError("预检不一致、存在未结业务或尚未确认现场，请重新预检") }
    let id = UUID().uuidString.lowercased()
    var body = input.body
    body["employeeId"] = actor.employee.id
    body["nativeGuard"] = [
      "sourceTableId": input.sourceID, "sourceLocationVersion": input.sourceVersion,
      "sourceGuestCount": input.sourceGuests,
      "targetGuestCount": projectedGuestCount - movedGuestCount, "targetCapacity": targetCapacity,
    ]
    let text =
      "\(input.sourceCode) → \(input.targetCode) · \(input.quantity)人\n历史订单、支付、任务和观察留在原桌次；顾客移动后须扫描目标桌二维码。\n目标桌\(projectedGuestCount)/\(targetCapacity)人。\n原因：\(input.reason)"
      + (input.capacityReason.isEmpty ? "" : "\n加座：" + input.capacityReason)
    let proof: [String: Any] = [
      "sourceTableId": input.sourceID, "sourceSession": input.session, "confirmation": text,
      "targetTableId": input.targetID, "selectedCount": input.participants.count,
      "projectedCount": projectedGuestCount, "capacity": targetCapacity,
    ]
    return LiveCommand(
      id: id, employeeID: actor.employee.id,
      title: "确认人员" + (input.kind == "participant_split" ? "拆桌" : "并桌"),
      permission: ParticipantInput.permission,
      steps: [
        .init(
          path: input.path + "/native-participant-movements",
          body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "x-idempotency-key", key: "native-participants-" + id,
          recoveryBody: try JSONSerialization.data(
            withJSONObject: ["participants": proof], options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var participantProof: [String: Any]? {
    guard let recoveryBody,
      let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return root["participants"] as? [String: Any]
  }
}
func validateParticipantReply(_ data: Data, step: LiveCommand.Step) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let row = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    let proof = step.participantProof, let event = row["eventId"] as? String, !event.isEmpty,
    let targetSession = row["targetTableSessionId"] as? String, !targetSession.isEmpty,
    let at = row["occurredAt"] as? String, assignmentDate(at) != nil,
    row["movedParticipantCount"] as? Int == proof["selectedCount"] as? Int,
    row["targetGuestCountAfter"] as? Int == proof["projectedCount"] as? Int,
    row["targetCapacityAtMovement"] as? Int == proof["capacity"] as? Int,
    let before = row["targetGuestCountBefore"] as? Int, before >= 0,
    before + (step.object["movedGuestCount"] as? Int ?? -1) == row["targetGuestCountAfter"] as? Int,
    let revoked = row["revokedGuestSessionCount"] as? Int, revoked >= 0,
    (row["capacityOverrideReason"] as? String)
      == (step.object["capacityOverrideReason"] as? String),
    (step.object["targetTableSessionId"] as? String) == nil
      || step.object["targetTableSessionId"] as? String == targetSession
  else { throw StaffAPIError.invalid }
}
