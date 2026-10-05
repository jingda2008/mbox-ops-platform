import Foundation
import Darwin

private final class ScanSessionStore: StaffSessionStore {
  func read() throws -> Data? { nil }
  func write(_ data: Data) throws {}
  func remove() throws {}
}
@main struct NativeScannedCodeTests {
  @MainActor static func main() async throws {
    setbuf(stdout, nil)
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func rejects(_ value: String, _ mode: NativeScanMode) -> Bool { do { _ = try nativeScannedCode(value, mode: mode); return false } catch { return true } }
    for barcode in ["6901234567892", "12345678", "04210005", "SKU-beer-12", "MBOX:stock/001", "123456789012345678"] {
      check(try nativeScannedCode(barcode, mode: .inventory) == barcode, "inventory recognizes its own EAN/UPC/Code128/QR payload: \(barcode)")
    }
    for invalid in ["", String(repeating: "a", count: 129), "SKU\u{0}12", "SKU\n12"] { check(rejects(invalid, .inventory), "inventory rejects invalid size/control payload") }
    check(try nativeScannedCode("  SKU-a  ", mode: .inventory) == "SKU-a", "inventory preserves case and normalizes server-compatible outer whitespace")
    for value in [String(repeating: "1", count: 16), String(repeating: "2", count: 32)] { check(try nativeScannedCode(value, mode: .payment) == value, "payment retains provider length boundary") }
    for value in ["6901234567892", "123456789012345", String(repeating: "1", count: 33), "1234567890123456\n", " 1234567890123456", "１２３４５６７８９０１２３４５６", "https://mbox.shmbox.com/guest?table=A5"] { check(rejects(value, .payment), "payment never accepts inventory, URLs or padded payloads") }
    check(try nativeScannedCode("MBOX_MEMBER_V1:member-1", mode: .member) == "member-1", "member scan retains original explicit prefix and validator")
    for value in ["member-1", "MBOX_MEMBER_V1:", "MBOX_MEMBER_V1:a/b", "MBOX_MEMBER_V1:a b", "1234567890123456"] { check(rejects(value, .member), "member contract is not widened by inventory support") }
    check(try nativeScannedCode(" a5 ", mode: .table) == "A5", "plain table code normalizes only for authorized matching")
    check(try nativeScannedCode("中1", mode: .table) == "中1", "existing Chinese table code is supported")
    check(try nativeScannedCode("https://mbox.shmbox.com/guest?table=a5#token=do-not-use-or-store", mode: .table) == "A5", "printed token fragment never leaves pure table decoder")
    check(try nativeScannedCode("https://MBOX.SH MBOX.com/guest?table=a5".replacingOccurrences(of: " ", with: ""), mode: .table) == "A5", "official hostname is case insensitive")
    for value in ["http://mbox.shmbox.com/guest?table=A5", "https://mbox.shmbox.com.evil/guest?table=A5", "https://evil@mbox.shmbox.com/guest?table=A5", "https://mbox.shmbox.com:444/guest?table=A5", "https://mbox.shmbox.com/redirect?table=A5", "https://mbox.shmbox.com/%67uest?table=A5", "https://mbox.shmbox.com/guest/?table=A5", "https://mbox.shmbox.com/guest?table=A5&table=B6", "https://mbox.shmbox.com/guest?table=A5&url=https://evil", "https://mbox.shmbox.com/guest?table=A%205", "https://mbox.shmbox.com/guest?table=A%0A5", String(repeating: "A", count: 33), "MBOX_MEMBER_V1:A5"] { check(rejects(value, .table), "table accepts exact trusted path and one valid table hint only") }
    let tables = [StaffTable(id: "table-a", code: "A5", capacity: 4)]
    check(try resolveNativeScannedTable("A5", tables: tables).id == "table-a", "scan resolves only supplied authorized table")
    do { _ = try resolveNativeScannedTable("B6", tables: tables); preconditionFailure("outside scope") } catch { check(true, "unlisted table cannot navigate") }
    do { _ = try resolveNativeScannedTable("a5", tables: tables + [StaffTable(id: "table-b", code: "a5", capacity: 4)]); preconditionFailure("duplicate") } catch { check(true, "ambiguous current table code cannot navigate") }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    let employee = "00000000-0000-4000-8000-000000000001"
    var auth: [String: Any] = ["employee": ["id": employee, "code": "scan", "displayName": "桌台员工", "roleCodes": []],
      "session": ["id": "scan-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["dashboard.view"], "deniedPermissions": [], "navigation": [["route": "/staff/live"]]]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: data(auth))
    let selection = NativeTableScanSelection(table: tables[0], actor: actor, workspace: 4)
    check(try selection.validate(actor: actor, workspace: 4, tables: tables) == "table-a", "second confirmation binds original employee/session/workspace/table")
    for scope in [3, 5] { do { _ = try selection.validate(actor: actor, workspace: scope, tables: tables); preconditionFailure("scope") } catch { check(true, "workspace changes invalidate original scan") } }
    do { _ = try selection.validate(actor: actor, workspace: 4, tables: [StaffTable(id: "new-table", code: "A5", capacity: 4)]); preconditionFailure("replacement") } catch { check(true, "reused table code with different row cannot open old selection") }
    var operations: [String: Any] = ["actor": ["id": employee, "capabilities": ["dashboard.view"]], "tables": [["id": "table-a", "code": "A5", "capacity": 4, "status": "active", "areaName": "大厅", "assignedToActor": true, "activeSession": NSNull()]], "tasks": []]
    var responseStatus = 200
    var requests: [String] = [], cookies: [String] = [], intercept: (() async throws -> Void)?
    let api = StaffAPI(transport: { request in
      requests.append(request.url!.path); cookies.append(request.value(forHTTPHeaderField: "Cookie") ?? "")
      if ["/api/auth/login", "/api/auth/heartbeat"].contains(request.url!.path) { return (try data(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-mbox_staff_session=scan-current-" + ((auth["employee"] as! [String: Any])["code"] as! String) + "; Path=/; Secure; HttpOnly"])!) }
      guard request.url!.path == "/api/operations", request.httpMethod == "GET" else { throw StaffAPIError.invalid }
      try await intercept?()
      return (try data(["data": operations]), HTTPURLResponse(url: request.url!, statusCode: responseStatus, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-mbox_staff_session=old-late; Path=/; Secure; HttpOnly"])!)
    }, store: ScanSessionStore())
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    model.identity = try await api.login(code: "scan", pin: "1234", switching: false)
    check(try await model.readNativeTableScanTargets() == tables, "actual AppModel performs heartbeat and authorized operations read")
    check(requests.suffix(2) == ["/api/auth/heartbeat", "/api/operations"], "camera entry refreshes authorization before requesting current table list")
    operations["tables"] = []
    check(try await model.readNativeTableScanTargets().isEmpty, "second read immediately observes removed table authorization")
    auth["navigation"] = []
    let before = requests.filter { $0 == "/api/operations" }.count
    do { _ = try await model.readNativeTableScanTargets(); preconditionFailure("route") } catch { check(requests.filter { $0 == "/api/operations" }.count == before, "fresh explicit empty navigation blocks table read") }
    auth["navigation"] = [["route": "/staff/live"]]
    model.identity = try await api.login(code: "scan", pin: "1234", switching: false)
    var other = auth; other["employee"] = ["id": "00000000-0000-4000-8000-000000000002", "code": "new", "displayName": "新员工", "roleCodes": []]
    other["session"] = ["id": "new-session", "employeeId": "00000000-0000-4000-8000-000000000002", "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"]
    let next = try JSONDecoder().decode(StaffIdentity.self, from: data(other))
    intercept = {
      model.lockLiveSession(); auth = other
      model.identity = try await api.login(code: "new", pin: "1234", switching: false)
    }
    do { _ = try await model.readNativeTableScanTargets(); preconditionFailure("late response") } catch {
      check(model.identity?.employee.id == next.employee.id, "late old success cannot lock or replace a new employee")
      check(model.world.tables.isEmpty && model.liveOperations == nil, "late old response cannot populate a new workspace")
    }
    check(api.identity?.employee.id == next.employee.id, "real API new login survives prior table response")
    _ = try await api.heartbeat()
    check(cookies.last?.contains("scan-current-new") == true && cookies.last?.contains("old-late") == false, "late old Set-Cookie cannot replace new login cookie")
    intercept = nil
    auth["employee"] = ["id": employee, "code": "scan", "displayName": "桌台员工", "roleCodes": []]
    auth["session"] = ["id": "scan-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"]
    model.identity = try await api.login(code: "scan", pin: "1234", switching: false)
    responseStatus = 401
    intercept = {
      model.lockLiveSession(); auth = other
      model.identity = try await api.login(code: "new", pin: "1234", switching: false)
    }
    do { _ = try await model.readNativeTableScanTargets(); preconditionFailure("late 401") } catch {
      check(model.identity?.employee.id == next.employee.id, "late old 401 cannot lock a new employee")
      check(model.world.tables.isEmpty && model.liveOperations == nil, "late old 401 cannot restore cached table visibility")
    }
    check(api.identity?.employee.id == next.employee.id, "late old HTTP401 cannot clear real new API identity")
    _ = try await api.heartbeat()
    check(cookies.last?.contains("scan-current-new") == true, "late old 401 cookie cannot replace new login cookie")
    print("Native scanned code: \(count) checks passed")
  }
}
