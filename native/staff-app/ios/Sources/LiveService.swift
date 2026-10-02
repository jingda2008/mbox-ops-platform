import Foundation

struct LiveServiceBoard: Decodable {
  struct Employee: Decodable, Identifiable {
    let id, name: String
    let canManage: Bool
  }
  struct Task: Decodable, Identifiable {
    let id, tableId, tableCode, tableSessionId, taskType, title, priority, status, interactionMode,
      createdAt: String
    let detail, assignedEmployeeId, backupEmployeeId, originalOrderItemId, dueAt: String?
    let assignedToActor: Bool
    var specialized: Bool { taskType == "goods.redelivery" }
    var experience: Bool { taskType.hasPrefix("experience.") }
    var actions: [String] {
      switch status {
      case "pending": return ["acknowledge", "start", "complete"] + (experience ? [] : ["cancel"])
      case "acknowledged": return ["start", "complete"] + (experience ? [] : ["cancel"])
      case "in_progress": return ["complete"] + (experience ? [] : ["cancel"])
      default: return []
      }
    }
  }
  let currentEmployeeId, generatedAt: String
  let durableTasks: Bool
  let durableExperience: Bool?
  let tasks: [Task]
  let employees: [Employee]
  static let labels = [
    "acknowledge": "接收任务", "start": "开始处理", "complete": "确认已完成", "cancel": "主管取消任务",
    "assign": "转交员工", "priority": "调整优先级",
  ]
  static let priorities = ["urgent": "紧急", "high": "优先", "normal": "普通", "low": "稍后"]
  func command(
    id: String, action: String, note: String, employee: String, priority: String,
    actor: StaffIdentity
  ) throws -> LiveCommand {
    guard durableTasks, currentEmployeeId == actor.employee.id, actor.allows("service.execute"),
      let row = tasks.first(where: { $0.id == id }), !row.specialized,
      row.actions.contains(action)
        || ["assign", "priority"].contains(action) && !row.actions.isEmpty
    else { throw CatalogError("任务已变化；补送和体验计划需从原事项处理") }
    if row.experience
      && (durableExperience != true
        || note.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count < 2)
    {
      throw CatalogError("请刷新体验服务能力并记录实际处理结果")
    }
    let manager =
      ["assign", "priority", "cancel"].contains(action) || row.taskType == "guest.complaint"
    let reason = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard reason.utf16.count <= 1000,
      !manager
        || actor.allows("service.manage")
          && reason.utf16.count >= (row.taskType == "guest.complaint" ? 4 : 2)
    else { throw CatalogError("请核对主管权限并记录处理结果；投诉至少4个字") }
    var body: [String: Any] = [
      "employeeId": actor.employee.id, "tableSessionId": row.tableSessionId,
      "taskType": row.taskType, "expectedStatus": row.status, "expectedPriority": row.priority,
      "expectedAssignedEmployeeId": row.assignedEmployeeId as Any? ?? NSNull(), "note": reason,
    ]
    var proof: [String: Any] = [
      "taskId": id, "tableSessionId": row.tableSessionId, "taskType": row.taskType,
      "action": action,
      "status": [
        "acknowledge": "acknowledged", "start": "in_progress", "complete": "completed",
        "cancel": "cancelled",
      ][action] ?? row.status,
    ]
    if row.experience { proof["experience"] = true }
    var extra = ""
    if action == "assign" {
      guard let selected = employees.first(where: { $0.id == employee }),
        row.taskType != "guest.complaint" || selected.canManage, employee != row.assignedEmployeeId
      else { throw CatalogError("请选择可接手此事项的另一名在岗员工") }
      body["assignedEmployeeId"] = employee
      proof["assignedEmployeeId"] = employee
      extra = "交给：" + selected.name
    }
    if action == "priority" {
      guard Self.priorities[priority] != nil, priority != row.priority else {
        throw CatalogError("请选择新的任务优先级")
      }
      body["priority"] = priority
      proof["priority"] = priority
      extra = "优先级：" + Self.priorities[priority]!
    }
    let title = row.tableCode + " · " + (Self.labels[action] ?? "处理任务")
    proof["confirmation"] =
      row.title + "\n" + title + "\n" + extra + "\n处理说明：" + reason
      + (row.experience ? "\n确认完成将同步原体验节点；请核对原计划要求。单独取消节点不可用。" : "\n只处理原服务任务，不变更顾客账单。")
    let key = UUID().uuidString.lowercased()
    return LiveCommand(
      id: key, employeeID: actor.employee.id, title: title,
      permission: manager ? "service.manage" : "service.execute",
      steps: [
        .init(
          path: "/api/native-service-tasks/" + LiveCommand.pathPart(id) + "/" + action,
          body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-business-" + key,
          recoveryBody: try JSONSerialization.data(
            withJSONObject: ["service": proof], options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var serviceProof: [String: Any]? {
    guard let recoveryBody,
      let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return root["service"] as? [String: Any]
  }
}
func validateServiceReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.serviceProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool,
    data["id"] as? String == proof["taskId"] as? String,
    data["tableSessionId"] as? String == proof["tableSessionId"] as? String,
    data["taskType"] as? String == proof["taskType"] as? String,
    data["status"] as? String == proof["status"] as? String
  else { throw StaffAPIError.invalid }
  if proof["experience"] as? Bool == true {
    guard let cue = data["nativeExperienceCue"] as? [String: Any],
      !(cue["cueId"] as? String ?? "").isEmpty, !(cue["planId"] as? String ?? "").isEmpty,
      cue["tableSessionId"] as? String == proof["tableSessionId"] as? String,
      cue["serviceTaskId"] as? String == proof["taskId"] as? String,
      proof["action"] as? String != "complete" || cue["status"] as? String == "completed"
    else { throw StaffAPIError.invalid }
  }
  for key in ["assignedEmployeeId", "priority"] {
    if let expected = proof[key] as? String, data[key] as? String != expected {
      throw StaffAPIError.invalid
    }
  }
}
