import Foundation

private final class GovernanceSessionStore: StaffSessionStore {
  func read() throws -> Data? { nil }
  func write(_ data: Data) throws {}
  func remove() throws {}
}

@main struct GovernanceSessionTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ title: String) { precondition(value, title); count += 1; print("PASS " + title) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    let employee = "00000000-0000-4000-8000-000000000001"
    let nextEmployee = "00000000-0000-4000-8000-000000000002"
    for kind in ["annual", "contact"] {
      let path = kind == "annual" ? annualPolicyRoot : contactGovernanceRoot
      let permission = kind == "annual" ? "loyalty.annual-benefit.view" : "privacy.contact.retention.view"
      let route = kind == "annual" ? "/staff/member-management" : "/staff/customer-experience"
      var auth: [String: Any] = ["employee": ["id": employee, "code": "original", "displayName": "治理员工", "roleCodes": []],
        "session": ["id": "original-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
        "permissions": [permission], "deniedPermissions": [], "navigation": [["route": route]]]
      let original = auth
      var requests: [URLRequest] = [], intercept: (() async throws -> Void)?, responseStatus = 200
      let api = StaffAPI(transport: { request in
        requests.append(request)
        if ["/api/auth/login", "/api/auth/heartbeat"].contains(request.url!.path) {
          let code = (auth["employee"] as! [String: Any])["code"] as! String
          return (try data(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Set-Cookie": "__Host-mbox_staff_session=" + code + "; Path=/; Secure; HttpOnly"])!)
        }
        guard request.url!.path == path, request.httpMethod == "GET" else { throw StaffAPIError.invalid }
        try await intercept?()
        let area = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "area" }?.value ?? "policies"
        let board: [String: Any] = ["employeeId": employee, "protocol": 1, "durableCommands": true, "rows": [], "next": NSNull(), "code": NSNull(), "area": area]
        return (try data(["data": board]), HTTPURLResponse(url: request.url!, statusCode: responseStatus, httpVersion: nil,
          headerFields: ["Set-Cookie": "__Host-mbox_staff_session=stale; Path=/; Secure; HttpOnly"])!)
      }, store: GovernanceSessionStore())
      let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
      func load() async {
        if kind == "annual" { await model.loadAnnualPolicies() }
        else { await model.loadContactGovernance() }
      }
      func ready() -> Bool { kind == "annual" ? model.canUseAnnualPolicies : model.canUseContactGovernance }
      func empty() -> Bool { kind == "annual" ? model.annualPolicyBoard == nil : model.contactGovernanceBoard == nil }
      model.identity = try await api.login(code: "original", pin: "1234", switching: false)
      await load()
      check(ready(), kind + " real AppModel accepts current employee's empty authorized board")
      check(requests.suffix(2).map { $0.url!.path } == ["/api/auth/heartbeat", path], kind + " read refreshes authorization first")
      let before = requests.filter { $0.url!.path == path }.count
      auth["permissions"] = []
      await load()
      check(empty() && !ready() && requests.filter { $0.url!.path == path }.count == before,
        kind + " withdrawn read grant clears old board without querying protected resource")
      auth = original; auth["navigation"] = []
      await load()
      check(empty() && !ready() && requests.filter { $0.url!.path == path }.count == before,
        kind + " explicit route withdrawal prevents hidden management read")
      auth = original
      if kind == "contact" {
        await model.loadContactGovernance(area: "resources")
        check(empty() && requests.filter { $0.url!.path == path }.count == before,
          "contact resource selection requires legal hold permission in addition to governance view")
        auth["permissions"] = [permission, "privacy.contact.legal_hold"]
        await model.loadContactGovernance(area: "resources")
        check(model.contactGovernanceBoard?.area == "resources" && ready(), "contact resource selection reads only after both current grants")
      }
      for status in [200, 401] {
        intercept = nil; auth = original; responseStatus = status
        model.identity = try await api.login(code: "original", pin: "1234", switching: false)
        intercept = {
          model.lockLiveSession()
          auth["employee"] = ["id": nextEmployee, "code": "next", "displayName": "新员工", "roleCodes": []]
          auth["session"] = ["id": "next-session", "employeeId": nextEmployee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"]
          model.identity = try await api.login(code: "next", pin: "1234", switching: false)
        }
        await load()
        check(model.identity?.employee.id == nextEmployee && api.identity?.employee.id == nextEmployee && empty(),
          kind + " late HTTP\(status) cannot populate or lock the replacement employee workspace")
        _ = try await api.heartbeat()
        check(requests.last?.value(forHTTPHeaderField: "Cookie")?.contains("=next") == true,
          kind + " late HTTP\(status) Set-Cookie cannot overwrite new session")
      }
    }
    print("Governance real AppModel: \(count) checks passed")
  }
}
