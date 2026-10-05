import Foundation
import CoreFoundation

let productPhasesRoot = "/api/staff/native-product-phases"
let productPhaseNames = ["before_show": "演出前", "acoustic": "不插电", "band_live": "乐队现场", "intermission": "中场", "after_show": "演出后"]
let productPhaseOrder = ["before_show", "acoustic", "band_live", "intermission", "after_show"]
struct ProductPhasesBoard {
  let employeeID, productID, expectedVersion: String
  let enabled: Bool
  let phases: [String]
  init(data: Data, actor: StaffIdentity, productID: String) throws {
    guard actor.allows("recommendation.phase.configure"), UUID(uuidString: productID) != nil,
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let value = root["data"] as? [String: Any],
      let protocolVersion = value["protocol"] as? NSNumber,
      CFGetTypeID(protocolVersion) != CFBooleanGetTypeID(), protocolVersion.intValue == 1,
      protocolVersion.doubleValue == 1,
      value["employeeId"] as? String == actor.employee.id, value["productId"] as? String == productID,
      let durable = value["durableCommands"] as? NSNumber, CFGetTypeID(durable) == CFBooleanGetTypeID(),
      let version = value["expectedVersion"] as? String,
      version.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let phases = value["phaseCodes"] as? [String], Set(phases).count == phases.count,
      phases.allSatisfy({ productPhaseNames[$0] != nil }) else { throw StaffAPIError.invalid }
    employeeID = actor.employee.id; self.productID = productID; expectedVersion = version
    enabled = durable.boolValue; self.phases = phases
  }
  func command(actor: StaffIdentity, phases: [String], reason: String, productName: String) throws -> LiveCommand {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard enabled, actor.employee.id == employeeID, actor.allows("recommendation.phase.configure"),
      StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
      phases.count <= 5, Set(phases).count == phases.count,
      phases.allSatisfy({ productPhaseNames[$0] != nil }), Set(phases) != Set(self.phases),
      (2...240).contains(note.utf16.count) else { throw CatalogError("请刷新阶段配置，选择有效变更并填写2—240字原因") }
    let selected = productPhaseOrder.filter(phases.contains)
    let body: [String: Any] = ["phaseCodes": selected, "expectedVersion": expectedVersion, "reason": note]
    let confirmation = productName + "\n"
      + (selected.isEmpty ? "取消演出阶段限制" : "仅在以下阶段供应：" + selected.compactMap { productPhaseNames[$0] }.joined(separator: "、"))
      + "\n原因：" + note + "\n保存影响后续商品可售判断，已有订单保留原记录。"
    let id = UUID().uuidString.lowercased()
    return LiveCommand(id: id, employeeID: employeeID, title: "核对商品演出阶段", permission: "recommendation.phase.configure",
      steps: [.init(path: productPhasesRoot + "/" + productID,
        body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-business-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: ["productPhases": [
          "employeeId": employeeID, "productId": productID, "phaseCodes": selected,
          "confirmation": confirmation]], options: .sortedKeys))])
  }
}
extension LiveCommand.Step {
  var productPhasesProof: [String: Any]? {
    guard let recoveryBody, let value = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any] else { return nil }
    return value["productPhases"] as? [String: Any]
  }
}
func validateProductPhasesReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.productPhasesProof, let id = proof["productId"] as? String, UUID(uuidString: id) != nil,
    step.path == productPhasesRoot + "/" + id,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let meta = root["meta"] as? [String: Any], let version = meta["protocol"] as? NSNumber,
    CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
    let replay = meta["replayed"] as? NSNumber, CFGetTypeID(replay) == CFBooleanGetTypeID(),
    let data = root["data"] as? [String: Any], data["productId"] as? String == id,
    data["employeeId"] as? String == proof["employeeId"] as? String,
    data["requestKey"] as? String == step.key, let phases = data["phaseCodes"] as? [String],
    let expected = step.object["phaseCodes"] as? [String],
    Set(phases).count == phases.count, phases.allSatisfy({ productPhaseNames[$0] != nil }),
    Set(phases) == Set(expected), Set(expected) == Set(proof["phaseCodes"] as? [String] ?? []) else {
    throw StaffAPIError.invalid
  }
}
