import Foundation

private final class ManagementSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws { bytes = nil }
}
@main struct NativeManagementSessionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ title: String) { precondition(value, title); count += 1; print("PASS " + title) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    let employee = "00000000-0000-4000-8000-000000000001", role = "00000000-0000-4000-8000-000000000002"
    let hash = String(repeating: "a", count: 64)
    let auth: [String: Any] = ["employee": ["id": employee, "code": "admin", "displayName": "管理员", "roleCodes": ["ADMIN"]],
      "session": ["id": "management-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["staff.access.configure"], "deniedPermissions": [], "navigation": [["route": "/staff/settings"]]]
    let board: [String: Any] = ["employeeId": employee, "protocol": 1, "durableCommands": true, "credentialVersion": hash, "credentials": [],
      "overview": ["configurationVersion": hash,
        "employees": [["id": employee, "code": "admin", "displayName": "管理员", "status": "active", "roleCodes": ["ADMIN"], "overrides": []]],
        "roles": [["id": role, "code": "ADMIN", "name": "管理员", "status": "active", "permissionCodes": ["staff.access.configure"], "dataScopes": [], "approvalLimits": [], "navigation": []]],
        "areas": [], "permissions": [["code": "staff.access.configure", "name": "员工配置"]], "configurationDefinitions": []]]
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: folder) }
    for operation in ["pin", "deploy"] {
      var payloads: [String: String] = [:], receipts: [String: String] = [:]
      var requests: [URLRequest] = [], invalidAfterWrite = false, crashAfterACK = true
      let persistence = NativeManagementPersistence(readPayload: { guard let value = payloads[$0] else { throw StaffAPIError.invalid }; return value },
        storePayload: { payloads[$0] = $1 }, removePayload: { payloads.removeValue(forKey: $0) },
        readReceipt: { receipts[$0] }, storeReceipt: { receipts[$0] = $1; if crashAfterACK { throw URLError(.cannotWriteToFile) } },
        removeReceipt: { receipts.removeValue(forKey: $0) })
      let api = StaffAPI(transport: { request in
        requests.append(request)
        let path = request.url!.path
        if path == "/api/auth/heartbeat" && invalidAfterWrite {
          return (try data(["error": ["code": "SESSION_REVOKED", "message": "已撤回原会话"]]), HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
        }
        let reply: [String: Any]
        if ["/api/auth/login", "/api/auth/heartbeat"].contains(path) { reply = ["data": auth] }
        else if path == "/api/staff/native-administration" { reply = ["data": board] }
        else {
          guard path == "/api/staff/native-administration/" + operation, let bodyData = request.httpBody,
            let body = try JSONSerialization.jsonObject(with: bodyData) as? [String: Any], body["expectedVersion"] as? String == hash,
            let key = request.value(forHTTPHeaderField: "idempotency-key") else { throw StaffAPIError.invalid }
          let result: [String: Any]
          if operation == "pin" {
            guard body["employeeId"] as? String == employee, body["pin"] as? String == "2345" else { throw StaffAPIError.invalid }
            result = ["employeeId": employee, "pinConfigured": true, "revokedSessionCount": 1]
          } else {
            result = ["status": "verified", "changes": [["kind": "role_permission", "targetId": role, "configurationCode": "staff.access.configure", "applied": true, "effectiveEmployeeCount": 0, "affectedEmployeeCount": 1]]]
          }
          invalidAfterWrite = true
          reply = ["data": ["employeeId": employee, "requestKey": key, "action": operation, "result": result], "meta": ["protocol": 1, "replayed": false]]
        }
        return (try data(reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      }, store: ManagementSessionStore())
      let url = folder.appendingPathComponent(operation + ".json")
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false,
        livePendingURL: url, nativeManagementPersistence: persistence)
      model.identity = try await api.login(code: "admin", pin: "1234", switching: false)
      await model.loadNativeManagement(.staff)
      check(model.canUseNativeManagement, "\(operation) real model fresh staff board permits original operation")
      var fields = ["reason": "实际核对本人配置", "pin": "2345", "repeatSecret": "2345"]
      if operation == "deploy" {
        fields["changes"] = String(data: try data([["kind": "role_permission", "roleId": role, "permissionCode": "staff.access.configure", "enabled": false]]), encoding: .utf8)!
        fields["changeSummary"] = "撤销本人岗位的员工配置权限"
      }
      let command = try model.prepareNativeManagement(operation: operation, fields: fields, rowID: operation == "pin" ? employee : nil)
      await model.executeLive(command)
      check(invalidAfterWrite && receipts[command.id] != nil && payloads[command.id] != nil, "\(operation) server accepted response saved to secure ACK before simulated checkpoint crash")
      let saved = try JSONDecoder().decode(LiveCommand.self, from: Data(contentsOf: url))
      check(model.livePending?.id == command.id && saved.completedSteps == 0, "\(operation) checkpoint failure retains ordinary original uncompleted pending")
      let before = requests.count
      let reopened = AppModel(api: api, loadPersistedState: false, trainingAllowed: false,
        livePendingURL: url, nativeManagementPersistence: persistence)
      reopened.livePending = saved
      await reopened.recoverLive()
      check(reopened.livePending == nil && !FileManager.default.fileExists(atPath: url.path), "\(operation) cold-start signed-out model safely finishes exact acknowledged request")
      check(requests.count == before && receipts.isEmpty && payloads.isEmpty, "\(operation) acknowledgement cleanup performs zero heartbeat or repeat writes and removes original secure slots")
      check(reopened.message.contains("已确认") && reopened.identity == nil, "\(operation) completion does not resurrect removed identity")
      crashAfterACK = false
      let secured = try secureNativeManagementCommand(command, store: persistence.storePayload)
      var forged = secured; forged.completedSteps = 1
      try JSONEncoder().encode(forged).write(to: url)
      reopened.livePending = forged
      await reopened.recoverLive()
      check(reopened.livePending == forged && FileManager.default.fileExists(atPath: url.path) && !payloads.isEmpty && requests.count == before,
        "\(operation) forged ordinary completed checkpoint without secure receipt cannot delete or resend")
      try? FileManager.default.removeItem(at: url)
    }
    print("Native management AppModel recovery: \(count) checks passed")
  }
}
