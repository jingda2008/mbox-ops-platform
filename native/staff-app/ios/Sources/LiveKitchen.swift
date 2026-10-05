import Foundation

struct LiveKitchen: Decodable {
  struct Pending: Decodable, Identifiable {
    var id: String { taskId }
    let taskId: String
    let itemId: String
    let productId: String
    let productName: String
    let specification: String
    let itemNote: String
    let orderNote: String
    let tableId: String
    let tableSessionId: String
    let tableCode: String
    let orderPublicId: String
    let locationVersion: Int
    let unmade: Int
    let canPrepare: Bool
    var compatibility: String {
      String(
        data: try! JSONSerialization.data(
          withJSONObject: [productId, specification, itemNote, orderNote],
          options: .withoutEscapingSlashes), encoding: .utf8)!
    }
  }
  struct Unit: Decodable, Identifiable {
    var id: String { unitId }
    let unitId: String
    let taskId: String
    let tableId: String
    let tableSessionId: String
    let tableCode: String
    let locationVersion: Int
    let state: String
    let held: Bool
    let stopped: Bool
    var canReady: Bool { state == "started" && !held && !stopped }
  }
  struct Batch: Decodable, Identifiable {
    let id: String
    let productName: String
    let specification: String
    let itemNote: String
    let orderNote: String
    let employeeId: String
    let employeeName: String
    let ownershipVersion: Int
    let equipment: String?
    let releasedAt: String?
    let startedAt: String?
    let expectedSeconds: Int?
    let units: [Unit]
  }
  let employeeId: String
  let stationCode: String
  let canStart: Bool
  let canPrepare: Bool
  let canHandoff: Bool
  let actionSessionValid: Bool
  let generatedAt: String
  let pending: [Pending]
  let batches: [Batch]
  let equipmentLabels: [String]
  let legacyTaskIds: [String]
  func command(
    actor: StaffIdentity, action: String, sourceID: String, quantity: Int = 1,
    equipment: String = "", seconds: Int? = nil, unitIDs: Set<String> = [],
    selections: [String: Int] = [:]
  ) throws -> LiveCommand {
    guard actor.employee.id == employeeId, actor.allows("kds.prepare"), canPrepare,
      actionSessionValid, ["bar", "kitchen"].contains(stationCode)
    else { throw CatalogError("出品岗位或会话已变化，请刷新") }
    var command: [String: Any] = ["action": action]
    let title: String
    if ["start", "quick-ready"].contains(action) {
      guard canStart, let row = pending.first(where: { $0.id == sourceID }), row.canPrepare,
        quantity > 0, quantity <= min(999, row.unmade),
        seconds == nil || (1...36000).contains(seconds!), equipment.utf16.count <= 40
      else { throw CatalogError("待制作数量或准入状态已变化，请重新核对") }
      let quantities = selections.isEmpty ? [sourceID: quantity] : selections
      let chosen = pending.filter { quantities[$0.id] != nil }.sorted { $0.id < $1.id }
      guard !chosen.isEmpty, chosen.count <= 50, chosen.count == quantities.count,
        chosen.allSatisfy({
          $0.canPrepare && $0.compatibility == row.compatibility && (quantities[$0.id] ?? 0) > 0
            && (quantities[$0.id] ?? 0) <= min(999, $0.unmade)
        }),
        quantities.values.reduce(0, +) <= 999
      else { throw CatalogError("合批仅支持商品、规格及两种备注完全相同的品项；请重新核对各桌份数") }
      command["compatibilityKey"] = row.compatibility
      command["items"] = chosen.map { selected -> [String: Any] in
        [
          "taskId": selected.taskId, "quantity": quantities[selected.id]!,
          "expectedUnmade": selected.unmade,
          "tableId": selected.tableId, "tableSessionId": selected.tableSessionId,
          "locationVersion": selected.locationVersion,
        ]
      }
      command["equipment"] =
        action == "quick-ready" || equipment.isEmpty ? NSNull() : equipment as Any
      command["expectedSeconds"] = action == "quick-ready" ? NSNull() : seconds as Any? ?? NSNull()
      title =
        chosen.map { "\($0.tableCode) ×\(quantities[$0.id]!)" }.joined(separator: "、") + " · "
        + row.productName + " · " + (action == "start" ? "开始制作" : "确认实际备齐")
    } else {
      guard let batch = batches.first(where: { $0.id == sourceID }), batch.employeeId == employeeId,
        ["ready", "release"].contains(action)
      else { throw CatalogError("批次负责人已改变，请重新核对") }
      command["batchId"] = batch.id
      command["expectedOwnershipVersion"] = batch.ownershipVersion
      if action == "ready" {
        let chosen = batch.units.filter { unitIDs.contains($0.id) }
        guard !chosen.isEmpty, chosen.count == unitIDs.count, chosen.count <= 999,
          chosen.allSatisfy(\.canReady)
        else { throw CatalogError("部分份数已暂停、停止或完成，请刷新后选择实际备齐的份数") }
        command["items"] = Dictionary(grouping: chosen, by: \.taskId).keys.sorted().map {
          taskID -> [String: Any] in
          let units = chosen.filter { $0.taskId == taskID }
          let first = units[0]
          return [
            "taskId": taskID, "tableId": first.tableId, "tableSessionId": first.tableSessionId,
            "locationVersion": first.locationVersion, "unitIds": units.map(\.id).sorted(),
          ]
        }
        title = batch.productName + " · 确认实际备齐 \(chosen.count)份"
      } else {
        guard batch.releasedAt == nil else { throw CatalogError("此设备已释放") }
        title = batch.productName + " · 确认实物已移出设备"
      }
    }
    let id = UUID().uuidString.lowercased()
    let body: [String: Any] = [
      "employeeId": employeeId, "stationCode": stationCode, "command": command,
    ]
    return LiveCommand(
      id: id, employeeID: employeeId, title: title, permission: "kds.prepare",
      steps: [
        .init(
          path: "/api/commerce/kitchen-board/commands",
          body: try JSONSerialization.data(
            withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]),
          keyHeader: "idempotency-key", key: "native-kitchen-" + id)
      ])
  }
}

struct LiveKitchenHandoff: Decodable, Identifiable {
  var id: String { anchorBatchId }
  struct Batch: Codable {
    let batchId: String
    let expectedCurrentOwnerId: String
    let expectedOwnershipVersion: Int
  }
  struct Task: Encodable, Decodable {
    let taskId: String
    let expectedEmployeeId: String?
    enum CodingKeys: String, CodingKey { case taskId, expectedEmployeeId }
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(taskId, forKey: .taskId)
      if let expectedEmployeeId {
        try c.encode(expectedEmployeeId, forKey: .expectedEmployeeId)
      } else {
        try c.encodeNil(forKey: .expectedEmployeeId)
      }
    }
  }
  struct Line: Decodable, Identifiable {
    var id: String { batchId }
    let batchId: String
    let productName: String
    let specification: String
    let itemNote: String
    let orderNote: String
    let tableCodes: [String]
    let remaining: Int
    let equipment: String?
    let released: Bool
  }
  let stationCode: String
  let anchorBatchId: String
  let batches: [Batch]
  let tasks: [Task]
  let displayLines: [Line]
  func command(actor: StaffIdentity, board: LiveKitchen, reason: String, physicalChecked: Bool)
    throws -> LiveCommand
  {
    guard physicalChecked, actor.employee.id == board.employeeId, actor.allows("kds.prepare"),
      actor.allows("kds.exception.manage"), board.canHandoff, board.actionSessionValid,
      stationCode == board.stationCode, board.batches.contains(where: { $0.id == anchorBatchId }),
      (1...500).contains(batches.count), (1...500).contains(tasks.count),
      Set(batches.map(\.batchId)).count == batches.count,
      Set(tasks.map(\.taskId)).count == tasks.count,
      batches.contains(where: { $0.batchId == anchorBatchId }),
      let owner = batches.first?.expectedCurrentOwnerId, owner != actor.employee.id,
      batches.allSatisfy({ $0.expectedCurrentOwnerId == owner }),
      tasks.allSatisfy({ $0.expectedEmployeeId == nil || $0.expectedEmployeeId == owner }),
      (2...1000).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
    else { throw CatalogError("请核对完整交接范围、实物和接班权限，填写接班原因") }
    let operation: [String: Any] = [
      "action": "handoff", "batchId": anchorBatchId,
      "expectedBatches": try JSONSerialization.jsonObject(with: JSONEncoder().encode(batches)),
      "expectedTasks": try JSONSerialization.jsonObject(with: JSONEncoder().encode(tasks)),
      "physicalChecked": true, "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines),
    ]
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: "确认接班 \(batches.count)批制作 · \(tasks.count)项任务",
      permission: "kds.prepare",
      steps: [
        .init(
          path: "/api/commerce/kitchen-board/commands",
          body: try JSONSerialization.data(
            withJSONObject: [
              "employeeId": actor.employee.id, "stationCode": stationCode, "command": operation,
            ], options: .sortedKeys), keyHeader: "idempotency-key", key: "native-handoff-" + id)
      ])
  }
}

struct LiveFulfillment: Decodable {
  struct Actor: Decodable {
    let employeeId: String
    let supportsNativePhysicalRecovery: Bool?
    let actionSessionValid: Bool?
    let sharedPickupActive, threeScreenWorkflowEnabled, pickupDeviceConfigured: Bool?
  }
  struct Quantities: Decodable { let total, unmade, started, ready, delivered, held, stopped: Int }
  struct Row: Decodable, Identifiable {
    struct Order: Decodable {
      let id, publicId: String
      let note: String?
    }
    struct Item: Decodable {
      let id, productName: String
      let quantity: Int
      let note: String?
    }
    struct Table: Decodable { let id, code: String }
    var id: String { taskId }
    let taskId, businessDate, stationCode, kdsStatus: String
    let carryover, canPrepare, canDeliver, canRemake: Bool
    let canManagerCancel: Bool?
    var allowsManagerCancel: Bool { canManagerCancel ?? (canRemake && kdsStatus == "failed") }
    let productionScreen, failureReason: String?
    let quantities: Quantities?
    let order: Order
    let item: Item
    let table: Table
    let attentionMessages: [String]
    func maximum(_ action: String) -> Int {
      guard let q = quantities else { return item.quantity }
      return action == "start" ? q.unmade : action == "complete" ? q.unmade + q.started : q.ready
    }
  }
  let actor: Actor
  let generatedAt: String
  let workItems: [Row]
  var usesPickup: Bool {
    actor.sharedPickupActive == true || actor.threeScreenWorkflowEnabled == true
      || actor.pickupDeviceConfigured == true
  }
  func validate(employeeID: String) throws {
    guard actor.employeeId == employeeID, Set(workItems.map(\.id)).count == workItems.count,
      workItems.allSatisfy({ row in
        guard !row.id.isEmpty, row.item.quantity > 0 else { return false }
        guard let q = row.quantities else { return true }
        return q.total > 0
          && [q.unmade, q.started, q.ready, q.delivered, q.held, q.stopped].allSatisfy {
            (0...q.total).contains($0)
          }
      })
    else { throw StaffAPIError.invalid }
  }
  func command(
    identity: StaffIdentity, taskID: String, action: String, quantity: Int, reason: String,
    confirmed: Bool
  ) throws -> LiveCommand {
    guard actor.supportsNativePhysicalRecovery == true, actor.employeeId == identity.employee.id,
      actor.actionSessionValid == true, confirmed,
      let row = workItems.first(where: { $0.id == taskID })
    else { throw CatalogError("请刷新出品队列并核对实物") }
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    var body: [String: Any] = ["actorId": identity.employee.id]
    let permission: String
    let title: String
    let suffix: String
    switch action {
    case "start", "complete":
      guard row.canPrepare, row.productionScreen == nil, row.maximum(action) > 0,
        row.quantities != nil || action != "start"
          || ["pending", "accepted"].contains(row.kdsStatus)
      else { throw CatalogError("请从对应制作批次处理，或刷新原任务状态") }
      permission = "kds.prepare"
      suffix = "actions"
      body["action"] = action
      title = action == "start" ? "开始实际制作" : "确认实际备齐"
    case "deliver":
      guard row.canDeliver, !usesPickup, row.maximum(action) > 0 else {
        throw CatalogError("请到取餐工作台按实际份数取走，勿重复登记送达")
      }
      permission = "kds.deliver"
      suffix = "actions"
      body["action"] = "deliver"
      title = "确认实际送达"
    case "fail":
      guard row.canPrepare, row.quantities == nil, row.productionScreen == nil else {
        throw CatalogError("按份商品请从售后处理，不能整行作废")
      }
      permission = "kds.prepare"
      suffix = "actions"
      body["action"] = "fail"
      title = "登记制作异常"
    case "remake":
      guard row.canRemake, row.kdsStatus == "failed", row.quantities == nil else {
        throw CatalogError("原异常或管理权限已变化")
      }
      permission = "kds.exception.manage"
      suffix = action
      title = "按原异常重新制作"
    case "manager-cancel":
      guard row.allowsManagerCancel, row.quantities == nil,
        ["pending", "accepted", "preparing", "ready", "failed"].contains(row.kdsStatus)
      else { throw CatalogError("原任务或主管结束权限已变化；按份商品须处理原份数") }
      permission = "kds.exception.manage"
      suffix = action
      title = "主管结束原制作任务"
    default: throw CatalogError("不支持的出品操作")
    }
    guard identity.allows(permission) else { throw CatalogError("当前岗位权限已变化") }
    if ["fail", "remake", "manager-cancel"].contains(action) {
      guard (2...500).contains(note.utf16.count) else { throw CatalogError("请填写2—500字实际处理原因") }
      body["reasonCode"] = action == "remake" ? "production_remake" : "production_exception"
      body["reason"] = note
    } else if row.quantities != nil {
      guard quantity > 0, quantity <= min(999, row.maximum(action)) else {
        throw CatalogError("所选份数超过当前可操作数量；暂停份数不得处理")
      }
      body["quantity"] = quantity
    }
    let count = row.quantities == nil ? row.item.quantity : quantity
    let key = UUID().uuidString.lowercased()
    let proof: [String: Any] = [
      "fulfillment": action, "taskId": row.id, "itemId": row.item.id,
      "orderId": row.order.id, "station": row.stationCode, "quantity": count,
      "byQuantity": row.quantities != nil,
      "confirmation":
        "\(row.table.code) · \(row.order.publicId)\n\(row.item.productName) · \(count)份\n\(title)\n\(note)\n制作异常和主管结束任务不会自动退款、免收或回库，须分别核对资金与实物。",
    ]
    return LiveCommand(
      id: key, employeeID: identity.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: "/api/commerce/native-kds/" + LiveCommand.pathPart(row.id) + "/" + suffix,
          body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-fulfillment-" + key,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var fulfillmentProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["fulfillment"] is String
    else { return nil }
    return p
  }
}
func validateFulfillmentReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.fulfillmentProof,
    let d = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = d["meta"] as? [String: Any], meta["replayed"] is Bool,
    d["orderId"] as? String == p["orderId"] as? String,
    d["orderItemId"] as? String == p["itemId"] as? String,
    d["stationCode"] as? String == p["station"] as? String,
    let id = d["id"] as? String, !id.isEmpty, let action = p["fulfillment"] as? String
  else { throw StaffAPIError.invalid }
  if action == "remake" {
    guard id != p["taskId"] as? String, d["remakeOf"] as? String == p["taskId"] as? String,
      d["normalizedStatus"] as? String == "pending"
    else { throw StaffAPIError.invalid }
  } else {
    guard id == p["taskId"] as? String else { throw StaffAPIError.invalid }
    if p["byQuantity"] as? Bool == true {
      guard let units = d["affectedUnitIds"] as? [String], Set(units).count == units.count,
        units.count == p["quantity"] as? Int, d["affectedQuantity"] as? Int == p["quantity"] as? Int
      else { throw StaffAPIError.invalid }
    } else {
      let expected = [
        "start": "preparing", "complete": "ready", "deliver": "ready", "fail": "failed",
        "manager-cancel": "cancelled",
      ][action]
      guard let expected, d["normalizedStatus"] as? String == expected else {
        throw StaffAPIError.invalid
      }
      if action == "deliver" && d["fulfillmentStatus"] as? String != "delivered" {
        throw StaffAPIError.invalid
      }
    }
  }
}
