import Foundation

struct LiveCommand: Codable, Equatable, Identifiable {
  struct Step: Codable, Equatable {
    let path: String
    let body: Data
    let keyHeader: String
    let key: String
    var recoveryBody: Data? = nil
    var object: [String: Any] {
      (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }
  }
  let id: String
  let employeeID: String
  let title: String
  let permission: String
  let steps: [Step]
  var completedSteps = 0
  var rejected = false
  static func make(
    kind: String, table: LiveOperations.Table, actor: StaffIdentity, people: Int = 0,
    target: LiveOperations.Table? = nil, task: LiveOperations.ServiceTask? = nil,
    frozen: Bool = false, reason: String = ""
  ) throws -> LiveCommand {
    let id = UUID().uuidString
    func step(
      _ path: String, _ body: [String: Any], _ header: String = "idempotency-key",
      key: String? = nil
    ) throws -> Step {
      Step(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: header, key: key ?? "native-\(id)")
    }
    let permission: String
    let title: String
    let steps: [Step]
    let session = table.activeSession
    switch kind {
    case "open":
      guard table.status == "available", session == nil, people >= 1,
        people <= 200
      else { throw RuleError.rule("桌台或人数已变化，请刷新") }
      permission = "table.open"
      let over = people > table.capacity
      let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !over || (2...1000).contains(explanation.utf16.count) else {
        throw RuleError.rule("人数超过容量，请填写2—1000字现场加座说明")
      }
      var body: [String: Any] = ["tableId": table.id, "guestCount": people]
      if over { body["capacityOverrideReason"] = explanation }
      title = "\(table.code) 开台 · \(people)人 / 容量\(table.capacity)人"
      steps = [
        try step(
          "/api/table-management/sessions/open", body,
          "x-idempotency-key")
      ]
    case "transfer":
      guard let session, let version = session.locationVersion, let target,
        target.status == "available", target.activeSession == nil, target.id != table.id
      else { throw RuleError.rule("目标桌不可用或桌次版本缺失，请刷新") }
      permission = "table.transfer"
      let over = session.guestCount > target.capacity
      let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !over || (2...1000).contains(explanation.utf16.count) else {
        throw RuleError.rule("人数超过目标桌容量，请填写2—1000字现场加座说明")
      }
      var body: [String: Any] = [
        "targetTableId": target.id, "expectedSourceTableId": table.id,
        "expectedLocationVersion": version,
      ]
      if over { body["capacityOverrideReason"] = explanation }
      title = "\(table.code) 转至 \(target.code) · \(session.guestCount)人 / 容量\(target.capacity)人"
      steps = [
        try step(
          "/api/table-management/sessions/\(pathPart(session.id))/transfer",
          body, "x-idempotency-key")
      ]
    case "close":
      guard let session else { throw RuleError.rule("此桌次已结束") }
      permission = "table.close"
      title = "结束 \(table.code) 用餐"
      let prefix = "/api/table-sessions/\(pathPart(session.id))"
      var requests: [Step] = []
      if session.status == "open" {
        requests.append(
          try step(prefix + "/begin-closing", [:], key: "staff-close-\(session.id)-begin"))
      } else if session.status != "closing" {
        throw RuleError.rule("桌次状态不支持结束用餐")
      }
      requests.append(try step(prefix + "/close", [:], key: "staff-close-\(session.id)-complete"))
      steps = requests
    case "turnover":
      guard let session, ["open", "closing"].contains(session.status), actor.allows("table.close"),
        (2...500).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw RuleError.rule("请确认顾客已离店并填写翻台原因，需同时具有关台和未结清翻台权限") }
      permission = "table.turnover_unsettled"
      title = "确认 \(table.code) 顾客已离店 · 保留原账释放桌台"
      steps = [
        try step(
          "/api/table-sessions/\(pathPart(session.id))/close-after-customer-left",
          ["reasonNote": reason.trimmingCharacters(in: .whitespacesAndNewlines)])
      ]
    case "freeze":
      guard let session, session.status == "open",
        !frozen || (2...500).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).count)
      else { throw RuleError.rule("请填写暂停原因并确认桌次仍在营业") }
      permission = "guest.cart.freeze"
      title = frozen ? "暂停 \(table.code) 客人加购" : "恢复 \(table.code) 客人加购"
      var body: [String: Any] = ["frozen": frozen]
      if frozen { body["reason"] = reason.trimmingCharacters(in: .whitespacesAndNewlines) }
      steps = [try step("/api/table-sessions/\(pathPart(session.id))/guest-cart-freeze", body)]
    case "service":
      guard let session, let task, task.tableSessionId == session.id, task.tableId == table.id,
        task.interactionMode == "quick_complete"
      else { throw RuleError.rule("该任务需主管处理或桌次已变化") }
      permission = "service.execute"
      title = "完成：\(task.title)"
      steps = [try step("/api/service-tasks/\(pathPart(task.id))/complete", [:])]
    default: throw RuleError.rule("操作尚未接入")
    }
    guard actor.allows(permission) else { throw RuleError.rule("当前员工没有此操作权限") }
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission, steps: steps)
  }
  static func pathPart(_ value: String) -> String {
    value.addingPercentEncoding(
      withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_")))!
  }
}

struct LiveOrderDetail: Decodable, Identifiable {
  var id: String { publicId }
  let publicId: String
  let paymentStatus: String?
  let totalAmountMinor: Int?
  let items: [Item]
  struct Item: Decodable, Identifiable {
    let id: String
    let productName: String
    let quantity: Int
    let totalAmountMinor: Int?
    let fulfillmentStatus: String
    var stateLabel: String {
      [
        "delivered": "已送达", "ready_for_delivery": "待送达", "preparing": "制作中", "pending": "待制作",
        "awaiting_payment": "待支付", "not_required": "无需出品", "cancelled": "已取消", "attention": "待处理",
      ][fulfillmentStatus] ?? "状态待核对"
    }
  }
}

/// Resume at the last durably acknowledged step. A lost acknowledgement reuses its original key.
struct LiveCommandRunner {
  static func advance(
    _ command: LiveCommand, send: (LiveCommand.Step) async throws -> Void,
    checkpoint: (LiveCommand) throws -> Void
  ) async throws -> LiveCommand {
    guard !command.rejected, !command.steps.isEmpty,
      (0...command.steps.count).contains(command.completedSteps)
    else { throw RuleError.rule("原请求记录无效，操作已锁定") }
    var current = command
    while current.completedSteps < current.steps.count {
      try await send(current.steps[current.completedSteps])
      current.completedSteps += 1
      try checkpoint(current)
    }
    return current
  }
}
