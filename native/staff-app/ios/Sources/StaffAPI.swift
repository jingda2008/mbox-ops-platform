import Foundation

struct APIEnvelope<Value: Decodable>: Decodable { let data: Value }
struct StaffIdentity: Codable, Equatable {
  struct Session: Codable, Equatable {
    let id: String
    let employeeId: String
    let expiresAt: String
    let onlineLeaseUntil: String
  }
  struct Employee: Codable, Equatable {
    let id: String
    let code: String
    let displayName: String
    let roleCodes: [String]
  }
  let session: Session
  let employee: Employee
  let permissions: [String]
  let deniedPermissions: [String]
  func allows(_ permission: String) -> Bool {
    permissions.contains(permission) && !deniedPermissions.contains(permission)
  }
  var canReadTables: Bool { allows("dashboard.view") }
  func validate() throws {
    guard !session.id.isEmpty, !employee.id.isEmpty, session.employeeId == employee.id else {
      throw StaffAPIError.invalid
    }
    guard Self.date(session.expiresAt) != nil, Self.date(session.onlineLeaseUntil) != nil else {
      throw StaffAPIError.invalid
    }
  }
  static func date(_ value: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}
struct DeviceGrant: Codable {
  let businessDate: String
  let expiresAt: String
}
struct StaffAPIError: Error, LocalizedError {
  let status: Int
  let code: String
  let message: String
  var commitDisposition: String? = nil
  var errorDescription: String? { message }
  var loginRequired: Bool { status == 401 }
  var definitivelyRejected: Bool {
    if ["FINANCE_REVIEW_FAILED", "CASH_HANDOVER_CHANGED", "VOUCHER_OPERATION_REVIEW"].contains(code)
    {
      return (400..<500).contains(status) && commitDisposition == "not_committed"
    }
    if [
      "HISTORICAL_COLLECTION_CHANGED", "TABLE_ASSIGNMENT_NOT_COMMITTED",
      "NATIVE_PHYSICAL_NOT_COMMITTED", "TABLE_PARTICIPANT_NOT_COMMITTED",
      "NATIVE_BUSINESS_NOT_COMMITTED",
    ].contains(code) {
      return status == 409 && commitDisposition == "not_committed"
    }
    if code.hasPrefix("PICKUP_") {
      return (400..<500).contains(status) && commitDisposition == "not_committed"
        && [
          "PICKUP_INVALID", "PICKUP_STALE", "PICKUP_TABLE_MOVED", "PICKUP_UNDO_UNAVAILABLE",
          "PICKUP_ADMISSION_PAUSED", "PICKUP_RECEIPT_NOT_FOUND",
        ].contains(code)
    }
    return
      (400..<500).contains(status)
      && [
        "KITCHEN_CHANGED", "KITCHEN_OWNER_CHANGED", "KITCHEN_ADMISSION_PAUSED",
        "KITCHEN_BATCH_NOT_FOUND",
        "TABLE_REQUEST_INVALID", "REQUEST_INVALID", "CAPACITY_OVERRIDE_REASON_REQUIRED",
        "TABLE_SESSION_UNSETTLED", "SERVICE_TASK_SESSION_MISMATCH", "TABLE_UNAVAILABLE",
        "TABLE_ALREADY_OPEN", "TABLE_SESSION_TRANSITION_CONFLICT",
        "SERVICE_TASK_TRANSITION_CONFLICT",
      ].contains(code)
  }
  static let invalid = StaffAPIError(
    status: 0, code: "INVALID_RESPONSE", message: "服务器数据格式不兼容，请刷新重试")
}

/// Only this client owns live cookies; training data never enters these requests.
@MainActor final class StaffAPI {
  typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
  private let session: URLSession
  private let transport: Transport?
  private let credentialStore: StaffSessionStore?
  var rememberSession = false
  private(set) var persistenceNotice = ""
  private(set) var identity: StaffIdentity?
  private(set) var deviceGrant: DeviceGrant?
  let origin = URL(string: "https://mbox.shmbox.com")!
  init(transport: Transport? = nil, store: StaffSessionStore? = nil) {
    credentialStore = store
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.urlCache = nil
    session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    self.transport = transport
  }
  func clearIdentity() {
    do { try credentialStore?.remove() } catch { persistenceNotice = error.localizedDescription }
    identity = nil
    for cookie in session.configuration.httpCookieStorage?.cookies ?? []
    where cookie.name == "__Host-mbox_staff_session" {
      session.configuration.httpCookieStorage?.deleteCookie(cookie)
    }
  }
  func grant(credential: String, deviceKey: String) async throws -> DeviceGrant {
    let credential = credential.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (6...128).contains(credential.count), deviceKey.count >= 8 else {
      throw StaffAPIError(status: 0, code: "INPUT_INVALID", message: "请填写有效的门店口令")
    }
    let result: DeviceGrant = try await data(
      "/api/auth/device-access", body: ["credential": credential, "deviceKey": deviceKey])
    guard let until = StaffIdentity.date(result.expiresAt), until > Date() else {
      throw StaffAPIError.invalid
    }
    deviceGrant = result
    return result
  }
  func login(code: String, pin: String, switching: Bool) async throws -> StaffIdentity {
    let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !code.isEmpty, code.count <= 64, pin.count == 4,
      pin.allSatisfy({ $0.isASCII && $0.isNumber })
    else { throw StaffAPIError(status: 0, code: "INPUT_INVALID", message: "请输入员工账号和4位数字PIN") }
    do {
      let result: StaffIdentity = try await data(
        switching ? "/api/auth/switch" : "/api/auth/login",
        body: ["employeeCode": code, "pin": pin])
      try result.validate()
      identity = result
      persistSession()
      return result
    } catch {
      // A switched response may be lost after the server revoked the old employee.
      if switching { clearIdentity() }
      throw error
    }
  }
  func heartbeat() async throws -> StaffIdentity {
    guard let previous = identity else {
      throw StaffAPIError(status: 401, code: "AUTH_REQUIRED", message: "请先登录员工账号")
    }
    let next: StaffIdentity = try await data("/api/auth/heartbeat", body: [:])
    try next.validate()
    guard previous.session.id == next.session.id, previous.employee.id == next.employee.id else {
      clearIdentity()
      throw StaffAPIError(status: 401, code: "IDENTITY_CHANGED", message: "员工身份已变化，请重新登录")
    }
    identity = next
    persistSession()
    return next
  }
  func configureRememberSession(_ enabled: Bool) throws {
    if enabled {
      rememberSession = true
      persistSession()
    } else {
      try forgetSavedSession()
    }
  }
  func savedSessionAvailable() -> Bool {
    guard let credentialStore else { return false }
    return (try? credentialStore.read()) != nil
  }
  func forgetSavedSession() throws {
    try credentialStore?.remove()
    rememberSession = false
    persistenceNotice = ""
  }
  func restoreSession() async throws -> StaffIdentity? {
    guard let data = try credentialStore?.read() else { return nil }
    let saved: SavedStaffSession
    do {
      saved = try JSONDecoder().decode(SavedStaffSession.self, from: data)
      try saved.validate()
    } catch {
      try? credentialStore?.remove()
      throw CatalogError("原登录已过期或记录无效，请重新登录")
    }
    for cookie in saved.cookies where cookie.expiresAt > Date() {
      guard
        let value = HTTPCookie(properties: [
          .name: cookie.name, .value: cookie.value, .domain: origin.host!, .path: "/",
          .secure: "TRUE", .expires: cookie.expiresAt,
          HTTPCookiePropertyKey(rawValue: "HttpOnly"): "TRUE",
        ])
      else { throw StaffAPIError.invalid }
      session.configuration.httpCookieStorage?.setCookie(value)
    }
    // The cached profile is only for binding the heartbeat. It is never a UI authorization.
    identity = saved.identity
    deviceGrant = saved.device
    rememberSession = true
    return try await heartbeat()
  }
  private func persistSession() {
    guard let credentialStore else { return }
    guard rememberSession, let identity else {
      try? credentialStore.remove()
      return
    }
    do {
      let cookies = (session.configuration.httpCookieStorage?.cookies ?? []).compactMap {
        cookie -> SavedStaffSession.Cookie? in
        guard cookie.domain == origin.host, cookie.path == "/", cookie.isSecure,
          ["__Host-mbox_staff_session", "__Host-mbox_device_lease"].contains(cookie.name)
        else { return nil }
        let boundary = StaffIdentity.date(
          cookie.name == "__Host-mbox_staff_session"
            ? identity.session.expiresAt : deviceGrant?.expiresAt ?? "")
        guard let boundary, boundary > Date() else { return nil }
        let expires = min(cookie.expiresDate ?? boundary, boundary)
        guard expires > Date() else { return nil }
        return SavedStaffSession.Cookie(name: cookie.name, value: cookie.value, expiresAt: expires)
      }
      let saved = SavedStaffSession(
        version: 1, identity: identity, device: deviceGrant, cookies: cookies)
      try saved.validate()
      try credentialStore.write(JSONEncoder().encode(saved))
      persistenceNotice = ""
    } catch {
      try? credentialStore.remove()
      persistenceNotice = "未能安全保存登录；本次关闭 App 后需重新登录。"
    }
  }
  func logout() async throws {
    let (_, status) = try await raw("/api/auth/logout", body: [:])
    guard status == 204 else { throw StaffAPIError.invalid }
    clearIdentity()
  }
  func submitOrder(_ command: LiveOrderSubmission) async throws -> LiveOrderReceipt {
    let (bytes, _) = try await raw(
      "/api/commerce/orders", body: command.object,
      headers: ["idempotency-key": command.key, "x-assisted-order-context": command.token])
    return try command.parseReceipt(bytes)
  }
  func execute(_ step: LiveCommand.Step) async throws {
    if step.path == "/api/commerce/pickup-board/commands"
      || step.path == "/api/commerce/pickup-board/device"
    {
      try await executePickup(step)
      return
    }
    let (bytes, _) = try await raw(
      step.path, body: step.object, headers: [step.keyHeader: step.key])
    if step.observationProof != nil {
      try validateObservationReply(bytes, step: step)
      return
    }
    if step.memberProof != nil {
      try validateMemberReply(bytes, step: step)
      return
    }
    if step.onlineProof != nil {
      try validateOnlineReply(bytes, step: step)
      return
    }
    if step.cashHandoverProof != nil {
      try validateCashHandoverReply(bytes, step: step)
      return
    }
    if step.voucherProof != nil {
      try validateVoucherReply(bytes, step: step)
      return
    }
    if step.printProof != nil {
      try validatePrintReply(bytes, step: step)
      return
    }
    if step.activityProof != nil {
      try validateActivityReply(bytes, step: step)
      return
    }
    if step.fulfillmentProof != nil {
      try validateFulfillmentReply(bytes, step: step)
      return
    }
    if step.afterSalesProof != nil {
      try validateAfterSalesReply(bytes, step: step)
      return
    }
    if step.financeProof != nil {
      try validateFinanceReply(bytes, step: step)
      return
    }
    if step.productManagementProof != nil {
      try validateProductManagementReply(bytes, step: step)
      return
    }
    if step.stockAuditProof != nil {
      try validateStockAuditReply(bytes, step: step)
      return
    }
    if step.stockProof != nil {
      try validateStockReply(bytes, step: step)
      return
    }
    if step.serviceProof != nil {
      try validateServiceReply(bytes, step: step)
      return
    }
    if step.reservationProof != nil {
      try validateReservationReply(bytes, step: step)
      return
    }
    if step.participantProof != nil {
      try validateParticipantReply(bytes, step: step)
      return
    }
    if step.assignmentProof != nil {
      try validateAssignmentReply(bytes, step: step)
      return
    }
    if step.cashierProof != nil {
      try validateCashierReply(bytes, step: step)
      return
    }
    if step.path == "/api/commerce/kitchen-board/commands" {
      struct Reply: Decodable {
        struct Result: Decodable {
          let batchId: String
          let action: String
          let quantity: Int
          let released: Bool
          let affectedBatchIds: [String]?
          let ownershipVersions: [String: Int]?
        }
        let data: Result
        let replayed: Bool
      }
      let reply = try JSONDecoder().decode(Reply.self, from: bytes)
      guard let command = step.object["command"] as? [String: Any], !reply.data.batchId.isEmpty,
        reply.data.action == command["action"] as? String, reply.data.quantity >= 0,
        command["batchId"] == nil || command["batchId"] as? String == reply.data.batchId
      else { throw StaffAPIError.invalid }
      let action = command["action"] as? String
      let items = command["items"] as? [[String: Any]] ?? []
      let expectedQuantity =
        action == "ready"
        ? items.reduce(0) { $0 + (($1["unitIds"] as? [String])?.count ?? 0) }
        : ["start", "quick-ready"].contains(action ?? "")
          ? items.reduce(0) { $0 + ($1["quantity"] as? Int ?? 0) } : 0
      guard reply.data.quantity == expectedQuantity, action != "release" || reply.data.released
      else { throw StaffAPIError.invalid }
      if action == "handoff" {
        let batches = command["expectedBatches"] as? [[String: Any]] ?? []
        let ids = Set(batches.compactMap { $0["batchId"] as? String })
        guard let affected = reply.data.affectedBatchIds, Set(affected) == ids,
          affected.count == ids.count, let versions = reply.data.ownershipVersions,
          versions.count == ids.count,
          batches.allSatisfy({ row in
            guard let id = row["batchId"] as? String,
              let version = row["expectedOwnershipVersion"] as? Int
            else { return false }
            return versions[id] == version + 1
          })
        else { throw StaffAPIError.invalid }
      }
      return
    }
    guard let root = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
      root["data"] is [String: Any], let meta = root["meta"] as? [String: Any],
      meta["replayed"] is Bool
    else { throw StaffAPIError.invalid }
    if step.path == "/api/payments/manual" {
      let result = root["data"] as! [String: Any]
      guard result["status"] as? String == "succeeded", result["currency"] as? String == "CNY",
        let expectedID = step.object["publicId"] as? String,
        result["publicId"] as? String == expectedID,
        let expectedAmount = step.object["amountMinor"] as? Int,
        result["amountMinor"] as? Int == expectedAmount
      else { throw StaffAPIError.invalid }
    }
  }
  func data<T: Decodable>(
    _ path: String, body: [String: Any]? = nil, headers: [String: String] = [:]
  ) async throws -> T {
    let (bytes, _) = try await raw(path, body: body, headers: headers)
    do { return try JSONDecoder().decode(APIEnvelope<T>.self, from: bytes).data } catch {
      throw StaffAPIError.invalid
    }
  }
  func raw(_ path: String, body: [String: Any]? = nil, headers: [String: String] = [:]) async throws
    -> (Data, Int)
  {
    guard path.hasPrefix("/api/"), !path.contains(".."), !path.contains("#"),
      let url = URL(string: path, relativeTo: origin)?.absoluteURL, url.host == origin.host
    else { throw StaffAPIError.invalid }
    var request = URLRequest(url: url)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let identity {
      request.setValue(identity.session.id, forHTTPHeaderField: "x-mbox-staff-session-id")
      request.setValue(identity.employee.id, forHTTPHeaderField: "x-mbox-staff-employee-id")
    }
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let bytes: Data
    let response: HTTPURLResponse
    if let transport {
      if let cookies = session.configuration.httpCookieStorage?.cookies(for: url) {
        for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) {
          request.setValue(v, forHTTPHeaderField: k)
        }
      }
      (bytes, response) = try await transport(request)
      let headers = Dictionary(
        uniqueKeysWithValues: response.allHeaderFields.compactMap {
          key, value -> (String, String)? in
          guard let key = key as? String, let value = value as? String else { return nil }
          return (key, value)
        })
      HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).forEach {
        session.configuration.httpCookieStorage?.setCookie($0)
      }
    } else {
      let result = try await session.data(for: request)
      guard let http = result.1 as? HTTPURLResponse else { throw StaffAPIError.invalid }
      (bytes, response) = (result.0, http)
    }
    guard (200..<300).contains(response.statusCode) else {
      let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
      let error = object?["error"] as? [String: Any]
      let fallback =
        response.statusCode == 401
        ? "登录或设备准入已过期，请重新验证"
        : response.statusCode == 403
          ? "当前员工没有此操作权限" : response.statusCode == 429 ? "尝试过于频繁，请稍后重试" : "连接失败，请稍后重试"
      if response.statusCode == 401 { clearIdentity() }
      throw StaffAPIError(
        status: response.statusCode, code: error?["code"] as? String ?? "HTTP_ERROR",
        message: error?["message"] as? String ?? fallback,
        commitDisposition: error?["commitDisposition"] as? String)
    }
    return (bytes, response.statusCode)
  }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
