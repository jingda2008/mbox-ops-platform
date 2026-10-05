import Foundation

func serviceRecoveryStep(_ command: LiveCommand) throws -> LiveCommand.Step {
  guard command.steps.count == 1, let step = command.steps.first, let p = step.serviceProof,
    UUID(uuidString: command.id) != nil, command.id == command.id.lowercased(), step.key == "native-business-" + command.id, step.keyHeader == "idempotency-key",
    let action = p["action"] as? String, LiveServiceBoard.labels[action] != nil,
    step.path == "/api/native-service-tasks/" + (try showUUID(p["taskId"])) + "/" + action,
    step.object["employeeId"] as? String == command.employeeID, step.object["tableSessionId"] as? String == p["tableSessionId"] as? String,
    step.object["taskType"] as? String == p["taskType"] as? String else { throw CatalogError("该操作须按原业务流程核对，请保留原请求") }
  _ = try showUUID(p["tableSessionId"]); _ = try showUUID(command.employeeID)
  return step
}
func serviceRecoveryRequest(_ command: LiveCommand, reason: String) throws -> [String: Any] {
  let step = try serviceRecoveryStep(command), reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  guard (4...1000).contains(reason.utf16.count), let p = step.serviceProof else { throw CatalogError("请填写4至1000字主管核对依据") }
  return ["taskId": p["taskId"]!, "action": p["action"]!, "originalKey": step.key, "original": step.object, "reason": reason, "confirmed": true]
}
func validateServiceRecoveryReply(_ bytes: Data, command: LiveCommand, supervisorID: String) throws -> String {
  let step = try serviceRecoveryStep(command), p = step.serviceProof!, body = step.object, root = try showObject(bytes)
  guard supervisorID != command.employeeID, UUID(uuidString: supervisorID) != nil, let meta = root["meta"] as? [String: Any], let data = root["data"] as? [String: Any], let original = data["original"] as? [String: Any], data["originalKey"] as? String == step.key,
    data["employeeId"] as? String == command.employeeID, data["taskId"] as? String == p["taskId"] as? String, data["action"] as? String == p["action"] as? String else { throw StaffAPIError.invalid }
  _ = try showFlag(meta["replayed"])
  let action = p["action"] as? String ?? ""
  let expected: [String: Any] = ["taskId": p["taskId"]!, "action": action, "employeeId": command.employeeID,
    "session": body["tableSessionId"] as Any, "taskType": body["taskType"] as Any, "expectedStatus": body["expectedStatus"] as Any, "expectedPriority": body["expectedPriority"] as Any,
    "expectedAssigned": body["expectedAssignedEmployeeId"] as Any, "note": (body["note"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
    "assigned": action == "assign" ? body["assignedEmployeeId"] as Any : NSNull(), "priority": action == "priority" ? body["priority"] as Any : NSNull()]
  guard NSDictionary(dictionary: original).isEqual(to: expected) else { throw CatalogError("回执与原请求内容不一致，已保留原记录") }
  if data["disposition"] as? String == "committed" {
    guard let receipt = data["receipt"] as? [String: Any], data["resolution"] is NSNull else { throw StaffAPIError.invalid }
    try validateServiceReply(try showBytes(["data":receipt,"meta":["replayed":true]]), step:step)
    return "原服务操作已完成，已核对服务器回执；未重复执行。"
  }
  if data["disposition"] as? String == "withdrawn" {
    guard let resolution = data["resolution"] as? [String: Any], resolution["disposition"] as? String == "withdrawn", data["receipt"] is NSNull,
      let resolvedBy = resolution["supervisorId"] as? String, UUID(uuidString: resolvedBy) != nil, resolvedBy != command.employeeID,
      let at = resolution["resolvedAt"] as? String, showServerDate(at) != nil else { throw StaffAPIError.invalid }
    // A prior authorised supervisor may have committed the withdrawal before this replay.
    for key in ["originalKey","taskId","action","employeeId"] { guard resolution[key] as? String == data[key] as? String else { throw StaffAPIError.invalid } }
    return "原请求已永久封存，未执行该请求；任务本身未取消，请刷新后处理。"
  }
  throw CatalogError("服务器未确认原请求，已保留本机记录")
}
