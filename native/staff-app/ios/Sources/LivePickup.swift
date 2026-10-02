import Foundation

struct LivePickup: Decodable {
  struct Device: Decodable {
    let id: String
    let label: String
  }
  struct Setup: Decodable {
    let enabled: Bool
    let configured: Bool
    let canConfigure: Bool
  }
  struct Actor: Decodable {
    let actionSessionValid: Bool
    let canPickup: Bool
    let canUndo: Bool
    let canConfigure: Bool
  }
  struct Unit: Decodable, Identifiable {
    var id: String { kind + ":" + unitId }
    let kind: String
    let unitId: String
    let taskId: String
    let version: Int
    let productName: String
    let specification: String
    let itemNote: String
    let orderNote: String
    let station: String
    let pickupLocation: String
  }
  struct Table: Decodable, Identifiable {
    var id: String { tableSessionId }
    let tableId: String
    let tableCode: String
    let tableSessionId: String
    let locationVersion: Int
    let units: [Unit]
  }
  struct Receipt: Decodable, Identifiable {
    var id: String { receiptId }
    struct Undo: Decodable {
      let undoId: String
      let undoneAt: String
    }
    let receiptId: String
    let revision: Int
    let tableId: String
    let tableCode: String
    let tableSessionId: String
    let quantity: Int
    let takenAt: String
    let units: [Unit]
    let undo: Undo?
    let canUndo: Bool
    let undoBlockedReason: String?
  }
  struct Attention: Decodable {
    let taskId: String
    let message: String
  }
  let revision: Int
  let generatedAt: String
  let commandScope: String
  let recoveryAvailable: Bool
  let device: Device?
  let setup: Setup
  let actor: Actor
  let tables: [Table]
  let history: [Receipt]
  let attention: [Attention]
  func make(
    actor identity: StaffIdentity, action: String, target: String = "", units: Set<String> = [],
    label: String = "", enabled: Bool = true
  ) throws -> LiveCommand {
    guard actor.actionSessionValid, !commandScope.isEmpty else {
      throw CatalogError("设备会话已失效，请重新登录后读取取餐台")
    }
    var body: [String: Any] = [:]
    let title: String
    let path: String
    let permission: String
    if action == "device" {
      guard actor.canConfigure, identity.allows("staff.access.configure"),
        !enabled || setup.enabled,
        (1...40).contains(label.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      else { throw CatalogError("请核对设备管理权限、设备名称与当前准入状态") }
      body = ["enabled": enabled, "label": label.trimmingCharacters(in: .whitespacesAndNewlines)]
      title = enabled ? "将本设备设为共享取餐屏" : "停用本设备取餐功能"
      path = "/api/commerce/pickup-board/device"
      permission = "staff.access.configure"
    } else {
      guard device != nil, identity.allows("kds.deliver") else {
        throw CatalogError("请在已授权的共享取餐设备操作")
      }
      path = "/api/commerce/pickup-board/commands"
      permission = "kds.deliver"
      if action == "take" {
        guard actor.canPickup, let table = tables.first(where: { $0.id == target }) else {
          throw CatalogError("原桌次或取餐权限已变化")
        }
        let chosen = table.units.filter { units.contains($0.id) }
        guard !chosen.isEmpty, chosen.count == units.count, chosen.count <= 999,
          Set(chosen.map(\.taskId)).count <= 50
        else { throw CatalogError("请重新选择本桌实际取走的份数，每次最多999份、50项出品") }
        body = [
          "action": "take", "tableId": table.tableId, "tableSessionId": table.tableSessionId,
          "locationVersion": table.locationVersion,
          "units": chosen.map {
            ["kind": $0.kind, "unitId": $0.unitId, "version": $0.version] as [String: Any]
          },
        ]
        title = "\(table.tableCode) · 确认取走 \(chosen.count)份并登记取送完成"
      } else {
        guard action == "undo", actor.canUndo,
          let receipt = history.first(where: { $0.id == target }), receipt.canUndo,
          receipt.undo == nil
        else { throw CatalogError("原领取已有后续变化，不能撤回") }
        body = [
          "action": "undo", "receiptId": receipt.id, "expectedRevision": receipt.revision,
          "physicalStillAtPickupPoint": true,
        ]
        title = "\(receipt.tableCode) · 撤回 \(receipt.quantity)份领取（实物必须仍在取餐区）"
      }
    }
    let id = UUID().uuidString.lowercased()
    let proof = try JSONSerialization.data(withJSONObject: [
      "staffSessionId": identity.session.id, "commandScope": commandScope,
    ])
    return LiveCommand(
      id: id, employeeID: identity.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-pickup-" + id, recoveryBody: proof)
      ])
  }
}
@MainActor extension StaffAPI {
  func executePickup(_ step: LiveCommand.Step) async throws {
    guard let proofData = step.recoveryBody,
      let proof = try JSONSerialization.jsonObject(with: proofData) as? [String: String],
      let originalSession = proof["staffSessionId"], let scope = proof["commandScope"],
      !scope.isEmpty, let identity
    else { throw StaffAPIError.invalid }
    let configure = step.path.hasSuffix("/device")
    let recovery = originalSession != identity.session.id
    let body: [String: Any] =
      recovery
      ? [
        "staffSessionId": originalSession, "commandScope": scope, "idempotencyKey": step.key,
        "request": ["kind": configure ? "device" : "command", "command": step.object],
      ] : step.object
    let (bytes, _) = try await raw(
      recovery ? "/api/commerce/pickup-board/recovery" : step.path, body: body,
      headers: [step.keyHeader: step.key])
    guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      var data = root["data"] as? [String: Any]
    else { throw StaffAPIError.invalid }
    if recovery {
      guard data["kind"] as? String == (configure ? "device" : "command"),
        let nested = data["data"] as? [String: Any]
      else { throw StaffAPIError.invalid }
      data = nested
    }
    if configure {
      let board = try JSONDecoder().decode(
        LivePickup.self, from: JSONSerialization.data(withJSONObject: data))
      guard let enabled = step.object["enabled"] as? Bool, board.setup.configured == enabled,
        !enabled || board.device?.label == step.object["label"] as? String
      else { throw StaffAPIError.invalid }
    } else {
      struct Result: Decodable {
        let receipt: LivePickup.Receipt
        let revision: Int
        let replayed: Bool
      }
      let result = try JSONDecoder().decode(
        Result.self, from: JSONSerialization.data(withJSONObject: data))
      if step.object["action"] as? String == "take" {
        let selected = step.object["units"] as? [[String: Any]] ?? []
        let expected = Set(
          selected.compactMap { unit -> String? in
            guard let kind = unit["kind"] as? String, let id = unit["unitId"] as? String else {
              return nil
            }
            return kind + ":" + id
          })
        guard result.receipt.tableSessionId == step.object["tableSessionId"] as? String,
          result.receipt.tableId == step.object["tableId"] as? String,
          result.receipt.quantity == expected.count, Set(result.receipt.units.map(\.id)) == expected
        else { throw StaffAPIError.invalid }
      } else {
        guard result.receipt.id == step.object["receiptId"] as? String, result.receipt.undo != nil
        else { throw StaffAPIError.invalid }
      }
    }
  }
}
