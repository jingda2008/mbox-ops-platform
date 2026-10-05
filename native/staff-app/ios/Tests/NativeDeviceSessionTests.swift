import Foundation

private final class DeviceSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws { bytes = nil }
}

@main struct NativeDeviceSessionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ name: String) { precondition(value, name); count += 1; print("PASS " + name) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    let employee = "00000000-0000-4000-8000-000000000001"
    var auth: [String: Any] = ["employee": ["id": employee, "code": "printer", "displayName": "打印管理员", "roleCodes": []],
      "session": ["id": "device-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["printer.manage"], "deniedPermissions": [], "navigation": [["route": "/staff/devices"]]]
    let board: [String: Any] = ["employeeId": employee, "nativeCommands": true, "devices": [], "routes": [], "policies": [], "commands": []]
    var requests: [URLRequest] = [], mode = "normal"
    var releaseReply: CheckedContinuation<Void, Never>?
    let api = StaffAPI(transport: { request in
      requests.append(request)
      let path = request.url!.path
      let data: Any
      switch path {
      case "/api/auth/login", "/api/auth/heartbeat": data = auth
      case "/api/hardware/native-management": data = board
      case "/api/hardware/print-bridges": data = []
      case "/api/hardware/native-print-bridges/capabilities": data = ["durableRevocation": true]
      case "/api/hardware/print-bridges/pairing-code":
        guard request.httpMethod == "POST", let input = request.httpBody,
          let body = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          body["ttlSeconds"] as? Int == 600, body["reason"] as? String == "核对门店打印电脑",
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == employee else { throw StaffAPIError.invalid }
        if mode == "lost" { throw URLError(.timedOut) }
        if mode == "delayed" { await withCheckedContinuation { releaseReply = $0 } }
        data = ["id": "00000000-0000-4000-8000-000000000066", "pairingCode": "ABCDE-12345-ABCDE-67890", "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))]
      default: throw StaffAPIError.invalid
      }
      return (try bytes(["data": data]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }, store: DeviceSessionStore())
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    model.identity = try await api.login(code: "printer", pin: "1234", switching: false)
    await model.loadNativeManagement(.devices)
    check(model.canUseNativeManagement && model.nativeManagementBoard?.employeeID == employee, "real AppModel loads fresh board and bridge capability for current employee")
    check(requests.filter { $0.url!.path == "/api/auth/heartbeat" }.count == 1, "management read requires fresh heartbeat")
    await model.createBridgePairing(reason: "核对门店打印电脑")
    check(model.bridgePairing?.pairingCode == "ABCDE-12345-ABCDE-67890", "manual pairing uses authenticated server response")
    model.clearBridgePairing()
    check(model.bridgePairing == nil, "closing or backgrounding explicitly hides pairing secret")
    mode = "lost"
    let before = requests.filter { $0.url!.path.hasSuffix("/pairing-code") }.count
    await model.createBridgePairing(reason: "核对门店打印电脑")
    check(model.bridgePairing == nil && requests.filter { $0.url!.path.hasSuffix("/pairing-code") }.count == before + 1,
      "lost pairing response performs one request and never silently retries")
    check(model.message.contains("不会自动重试"), "unknown pairing result tells operator original code may exist until expiry")
    mode = "delayed"
    let pending = Task { await model.createBridgePairing(reason: "核对门店打印电脑") }
    for _ in 0..<1000 { if releaseReply != nil { break }; await Task.yield() }
    check(releaseReply != nil, "pairing transport reaches controlled late-response boundary")
    model.clearBridgePairing()
    releaseReply?.resume(); releaseReply = nil
    await pending.value
    check(model.bridgePairing == nil, "late successful pairing cannot redisplay code after local hide")
    let hidden = requests.filter { $0.url!.path.hasSuffix("/pairing-code") }.count
    auth["permissions"] = []
    await model.createBridgePairing(reason: "核对门店打印电脑")
    check(model.bridgePairing == nil && requests.filter { $0.url!.path.hasSuffix("/pairing-code") }.count == hidden,
      "fresh heartbeat permission revocation prevents pairing POST")
    check(model.nativeManagementBoard == nil && !model.canUseNativeManagement, "permission withdrawal clears stale device board")
    print("Native device session: \(count) checks passed")
  }
}
