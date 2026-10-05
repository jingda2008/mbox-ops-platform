import Foundation
import Combine

@MainActor final class NativePushCoordinator: ObservableObject {
  typealias Request = (String, String, [String: Any]?, String?) async throws -> Data
  @Published private(set) var status = "服务提醒尚未开启"
  @Published private(set) var active = false
  @Published private(set) var busy = false
  @Published var target: NativePushTarget?
  @Published var navigationNotice = ""
  private(set) var state = NativePushState()
  private let store: StaffSessionStore
  private let system: NativePushSystem
  private let anonymous: Request
  private let appVersion: String
  private var request: Request?
  private var identity: (() -> StaffIdentity?)?
  private var revalidate: (() async throws -> StaffIdentity)?
  private var owner: NativePushOwner?
  private var generation = 0
  private var freshToken: String?
  private var permission: NativePushPermission = .notDetermined
  private var configured = false
  private var loaded = false
  private var syncing = false
  private var resync = false
  private var revoking = false
  private var opening = false
  private var observing = false
  private var awaitingToken = false
  private var localStopPending = false
  var hasOpenIntent: Bool { state.openDeliveryId != nil }
  var enabled: Bool { state.enabled && !localStopPending }
  var pendingRevocations: Int { state.revocations.count }

  init(store: StaffSessionStore = KeychainStaffSessionStore(service: "com.mbox.staff.push.v1"),
    system: NativePushSystem, anonymous: Request? = nil,
    appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown") {
    self.store = store; self.system = system; self.appVersion = appVersion
    self.anonymous = anonymous ?? NativePushAnonymousClient().request
    do {
      if let bytes = try store.read() {
        state = try JSONDecoder().decode(NativePushState.self, from: bytes)
        try state.validate()
      } else { try store.write(JSONEncoder().encode(state)) }
      loaded = true
    } catch { status = NativePushError.storage.localizedDescription }
  }
  func connect(api: StaffAPI, revalidate: @escaping () async throws -> StaffIdentity) {
    connect(identity: { api.identity }, revalidate: revalidate) { path, method, body, key in
      let (bytes, _) = try await api.raw(path, body: body,
        headers: key.map { ["Idempotency-Key": $0] } ?? [:], method: method)
      return bytes
    }
  }
  /// The same state machine is exercised by deterministic transport/timing tests.
  func connect(identity: @escaping () -> StaffIdentity?,
    revalidate: @escaping () async throws -> StaffIdentity, request: @escaping Request) {
    self.identity = identity; self.revalidate = revalidate; self.request = request
  }
  private func save(_ next: NativePushState) throws {
    guard loaded else { throw NativePushError.storage }
    try next.validate()
    do { try store.write(JSONEncoder().encode(next)) }
    catch { throw NativePushError.storage }
    state = next
  }
  private func current(_ actor: NativePushOwner, _ epoch: Int) -> Bool {
    generation == epoch && owner == actor && identity?().map(NativePushOwner.init) == actor
  }
  private func requireCurrent(_ actor: NativePushOwner, _ epoch: Int) throws {
    guard current(actor, epoch) else { throw NativePushError.changed }
  }
  private func validateOwner(_ employee: String, _ session: String, actor: NativePushOwner,
    protocolVersion: Int) throws {
    guard protocolVersion == 1, employee == actor.employeeId, session == actor.staffSessionId else {
      throw NativePushError.invalid
    }
  }
  private func installation(_ bytes: Data, actor: NativePushOwner) throws -> NativePushInstallationReply {
    let result = try JSONDecoder().decode(APIEnvelope<NativePushInstallationReply>.self, from: bytes).data
    try validateOwner(result.employeeId, result.staffSessionId, actor: actor, protocolVersion: result.protocol)
    let item = result.installation
    guard item.installationId == state.installationId, item.revision > 0,
      item.revision < 9_007_199_254_740_991,
      ["active", "revoked", "invalid_token", "expired"].contains(item.status),
      StaffIdentity.date(item.expiresAt) != nil else { throw NativePushError.invalid }
    return result
  }
  private var installationPath: String { "/api/native/push/installations/" + state.installationId }
  private func queueRevocation(_ next: inout NativePushState, revision: Int, secret: String,
    actor: NativePushOwner) {
    guard !next.revocations.contains(where: { $0.revision == revision && $0.revocationSecret == secret }) else { return }
    next.revocations.append(.init(revision: revision, revocationSecret: secret, owner: actor,
      requestKey: NativePushState.key()))
  }
  /// Synchronous local lock runs before logout/switch sends anything. Old in-flight
  /// callbacks cannot re-enable this generation. The original secure record is kept
  /// if Keychain writing fails, so its capability is recoverable on the next launch.
  func endSession() {
    generation += 1; owner = nil; active = false; configured = false; awaitingToken = false
    freshToken = nil; target = nil
    system.stopAndClear()
    localStopPending = true
    do {
      try persistStoppedState()
      status = state.revocations.isEmpty ? "本机服务提醒已关闭" : "本机已关闭；远端撤销待核对"
    } catch { status = "本机已关闭；安全记录未能更新，解锁后需重试撤销" }
    Task { await flushRevocations() }
  }
  private func persistStoppedState() throws {
    var next = state
    if let item = next.binding {
      queueRevocation(&next, revision: item.revision, secret: item.revocationSecret, actor: item.owner)
    }
    if let item = next.pending {
      queueRevocation(&next, revision: item.expectedRevision + 1, secret: item.revocationSecret, actor: item.owner)
    }
    next.enabled = false; next.binding = nil; next.pending = nil
    next.observations = []; next.openDeliveryId = nil
    try save(next)
    localStopPending = false
  }
  private func hasServicePermission(_ identity: StaffIdentity) -> Bool {
    ["service.view", "service.execute", "service.manage", "complaint.handle"].contains(where: identity.allows)
  }
  func sessionChanged(_ identity: StaffIdentity?) async {
    if localStopPending {
      await flushRevocations()
      guard !localStopPending else { return }
    }
    if let identity, !hasServicePermission(identity) {
      if owner != nil || state.binding != nil || state.pending != nil || state.enabled { endSession() }
      status = "当前员工没有服务提醒权限"
      await flushRevocations()
      return
    }
    let nextOwner = identity.map(NativePushOwner.init)
    if owner != nextOwner {
      let persistedOwner = state.pending?.owner ?? state.binding?.owner
      if owner != nil || (nextOwner != nil && persistedOwner != nil && persistedOwner != nextOwner) {
        // Preserve a cold-launch tap, but never use it as an identity or task proof.
        let intent = state.openDeliveryId
        endSession()
        if let intent { var next = state; next.openDeliveryId = intent; try? save(next) }
      }
      generation += 1; owner = nextOwner; active = false; freshToken = nil
    }
    await refresh()
  }
  func enable() async {
    if localStopPending { await flushRevocations(); return }
    guard !busy, loaded, let revalidate else { return }
    busy = true; defer { busy = false }
    do {
      let verified = try await revalidate()
      let actor = NativePushOwner(verified)
      guard identity?().map(NativePushOwner.init) == actor else { throw NativePushError.changed }
      if owner != actor { await sessionChanged(verified) }
      let epoch = generation
      try await readCapabilities(actor: actor, epoch: epoch)
      guard configured else { throw NativePushError.disabled }
      let result = try await system.requestPermission()
      try requireCurrent(actor, epoch)
      permission = result
      guard result.allowed else { endSession(); status = "通知未获授权，可在系统设置中开启"; return }
      var next = state; next.enabled = true; try save(next)
      awaitingToken = true; system.register()
      status = "正在向 Apple 获取本次设备令牌"
    } catch { status = safeMessage(error) }
  }
  func refresh() async {
    await flushRevocations()
    guard !localStopPending else { return }
    guard loaded, let actor = owner, let session = identity?(),
      NativePushOwner(session) == actor else {
      active = false
      if hasOpenIntent { status = "请先登录，再核对这条服务提醒" }
      return
    }
    let epoch = generation
    do {
      permission = await system.permission()
      try requireCurrent(actor, epoch)
      if !permission.allowed && (state.enabled || state.pending != nil || state.binding != nil) {
        endSession(); status = "系统通知权限已关闭，本机已停用提醒"; return
      }
      try await readCapabilities(actor: actor, epoch: epoch)
      if state.enabled && configured && permission.allowed {
        // Always request a current system token. A persisted pending token is
        // only an exact request recovery payload, never startup token authority.
        awaitingToken = true; system.register()
        status = active ? "提醒绑定已核对；通知送达仍由设备与系统决定" : "正在核对当前设备提醒绑定"
      }
      if hasOpenIntent { await openPending() }
    } catch {
      if current(actor, epoch) { active = false; status = safeMessage(error) }
    }
  }
  private func readCapabilities(actor: NativePushOwner, epoch: Int) async throws {
    guard let request else { throw NativePushError.changed }
    let bytes = try await request("/api/native/push/capabilities", "GET", nil, nil)
    try requireCurrent(actor, epoch)
    let result = try JSONDecoder().decode(APIEnvelope<NativePushCapabilities>.self, from: bytes).data
    try validateOwner(result.employeeId, result.staffSessionId, actor: actor, protocolVersion: result.protocol)
    guard result.platforms.ios.provider == "apns" else { throw NativePushError.invalid }
    configured = result.enabled && result.platforms.ios.configured
      && ["sandbox", "production"].contains(result.platforms.ios.environment ?? "")
    if !configured { active = false; status = NativePushError.disabled.localizedDescription }
  }
  func registered(token: Data) async {
    guard !localStopPending, awaitingToken, state.enabled, configured, permission.allowed, owner != nil else { return }
    let text = token.map { String(format: "%02x", $0) }.joined()
    guard NativePushState.validToken(text) else { registrationFailed(); return }
    awaitingToken = false; freshToken = text
    await synchronize()
  }
  func registrationFailed() {
    awaitingToken = false; active = false
    status = "Apple 设备注册未确认，请检查网络与已签名版本后重试"
  }
  private func synchronize() async {
    if syncing { resync = true; return }
    guard !localStopPending, let actor = owner, let token = freshToken, state.enabled, configured,
      permission.allowed, let request else { return }
    syncing = true
    defer {
      syncing = false
      if resync { resync = false; Task { await synchronize() } }
    }
    let epoch = generation
    do {
      try requireCurrent(actor, epoch)
      if let pending = state.pending, pending.owner != actor || pending.token != token {
        var next = state
        queueRevocation(&next, revision: pending.expectedRevision + 1, secret: pending.revocationSecret,
          actor: pending.owner)
        next.pending = nil; try save(next)
        await flushRevocations()
        try requireCurrent(actor, epoch)
      }
      if state.pending == nil {
        var currentInstallation: NativePushInstallation?
        do { currentInstallation = try installation(try await request(installationPath, "GET", nil, nil), actor: actor).installation }
        catch let error as StaffAPIError where error.status == 404 && error.code == "PUSH_NOT_FOUND" {}
        try requireCurrent(actor, epoch)
        let hash = NativePushState.tokenHash(token)
        if let binding = state.binding, let item = currentInstallation,
          binding.owner == actor, binding.tokenHash == hash, binding.revision == item.revision,
          item.boundToCurrentSession, item.status == "active",
          let until = StaffIdentity.date(item.expiresAt), until > Date() {
          active = true; status = "提醒绑定已核对；不代表通知已送达"
          await flushObservations(); await openPending(); return
        }
        var next = state
        // A replaced binding remains independently revocable if a later PUT loses its reply.
        if let old = next.binding {
          queueRevocation(&next, revision: old.revision, secret: old.revocationSecret, actor: old.owner)
          next.binding = nil
        }
        next.pending = NativePushRegistration(owner: actor, requestKey: NativePushState.key(),
          expectedRevision: currentInstallation?.revision ?? 0, token: token,
          permission: permission.rawValue, appVersion: appVersion, revocationSecret: try NativePushState.secret())
        try save(next)
      }
      guard let pending = state.pending, pending.owner == actor, pending.token == token else {
        throw NativePushError.changed
      }
      try requireCurrent(actor, epoch)
      let bytes = try await request(installationPath, "PUT", pending.body, pending.requestKey)
      try requireCurrent(actor, epoch)
      guard state.pending == pending, state.enabled else { throw NativePushError.changed }
      let reply = try installation(bytes, actor: actor)
      guard reply.requestKey == pending.requestKey,
        reply.installation.lastRequestKey == pending.requestKey,
        reply.installation.revision == pending.expectedRevision + 1,
        reply.installation.boundToCurrentSession, reply.installation.status == "active",
        let until = StaffIdentity.date(reply.installation.expiresAt), until > Date()
      else { throw NativePushError.invalid }
      // A replay may describe an older command. Read actual state before local activation.
      let actual = try installation(try await request(installationPath, "GET", nil, nil), actor: actor).installation
      try requireCurrent(actor, epoch)
      guard actual.revision == reply.installation.revision, actual.status == "active",
        actual.boundToCurrentSession, actual.lastRequestKey == pending.requestKey,
        let actualUntil = StaffIdentity.date(actual.expiresAt), actualUntil > Date()
      else { throw NativePushError.invalid }
      var next = state
      next.binding = .init(owner: actor, revision: actual.revision, expiresAt: actual.expiresAt,
        tokenHash: NativePushState.tokenHash(token), revocationSecret: pending.revocationSecret)
      next.pending = nil; try save(next)
      active = true; status = "提醒绑定已核对；不代表通知已送达"
      await flushRevocations(); await flushObservations(); await openPending()
    } catch {
      guard current(actor, epoch) else { return }
      active = false
      if (error as? StaffAPIError)?.code == "PUSH_REGISTRATION_REVOKED" {
        // Revocation does not prove the original PUT never committed. Retire
        // its capability and stop; a later explicit opt-in starts a new binding.
        endSession()
        status = "原提醒绑定已撤销；需要提醒时请重新开启"
        return
      }
      if let error = error as? StaffAPIError, error.commitDisposition == "not_committed",
        ["PUSH_REVISION_CONFLICT", "PUSH_TOKEN_CONFLICT", "PUSH_NOT_CONFIGURED"].contains(error.code) {
        // Do not loop with new keys. A subsequent explicit refresh re-reads the revision.
        var next = state; next.pending = nil
        do { try save(next) } catch { status = NativePushError.storage.localizedDescription; return }
      }
      status = safeMessage(error)
    }
  }
  func flushRevocations() async {
    if localStopPending {
      do { try persistStoppedState() }
      catch { status = "本机已关闭；安全记录未能更新，解锁后需重试撤销"; return }
    }
    guard loaded, !revoking else { return }
    revoking = true; defer { revoking = false }
    while let item = state.revocations.first {
      do {
        if identity?().map(NativePushOwner.init) == item.owner, let request {
          // Best effort authenticated revoke; capability always follows to persist
          // the tombstone even when registration and logout crossed in flight.
          _ = try? await request(installationPath + "/revoke", "POST",
            ["expectedRevision": item.revision], item.requestKey)
        }
        let bytes = try await anonymous(installationPath + "/revoke-capability", "POST",
          ["revision": item.revision, "revocationSecret": item.revocationSecret], nil)
        struct Receipt: Decodable { let `protocol`: Int; let accepted: Bool }
        let receipt = try JSONDecoder().decode(APIEnvelope<Receipt>.self, from: bytes).data
        guard receipt.protocol == 1 && receipt.accepted else { throw NativePushError.invalid }
        var next = state; next.revocations.removeAll { $0 == item }; try save(next)
        if !state.enabled { status = "本机提醒已关闭；撤销能力请求已受理" }
      } catch {
        if !state.enabled { status = "本机已关闭；远端撤销待核对，联网后可重试" }
        return
      }
    }
  }
  var canPresent: Bool {
    guard !localStopPending, active, state.enabled, permission.allowed, let actor = owner,
      let identity = identity?(), hasServicePermission(identity),
      NativePushOwner(identity) == actor, let binding = state.binding,
      binding.owner == actor, let until = StaffIdentity.date(binding.expiresAt), until > Date()
    else { return false }
    return true
  }
  static func deliveryId(_ userInfo: [AnyHashable: Any]) -> String? {
    guard let payload = userInfo["mbox"] as? [String: Any],
      (payload["protocol"] as? Int) == 1, payload["kind"] as? String == "service_task",
      let id = payload["deliveryId"] as? String, UUID(uuidString: id) != nil else { return nil }
    return id.lowercased()
  }
  func received(_ deliveryId: String) async {
    guard UUID(uuidString: deliveryId) != nil, canPresent, let actor = owner,
      let binding = state.binding else { return }
    do {
      try addObservation(deliveryId, kind: "received", actor: actor, revision: binding.revision)
      await flushObservations()
    } catch { status = NativePushError.storage.localizedDescription }
  }
  func clicked(_ deliveryId: String) async {
    guard UUID(uuidString: deliveryId) != nil else { return }
    do {
      var next = state; next.openDeliveryId = deliveryId; try save(next)
      await openPending()
    } catch { status = NativePushError.storage.localizedDescription }
  }
  func openPending() async {
    guard !opening, let id = state.openDeliveryId else { return }
    guard let actor = owner, identity?().map(NativePushOwner.init) == actor,
      let request, let revalidate else { status = "请先登录，再核对这条服务提醒"; return }
    opening = true; defer { opening = false }
    let epoch = generation
    do {
      let refreshed = try await revalidate()
      try requireCurrent(actor, epoch)
      guard NativePushOwner(refreshed) == actor else { throw NativePushError.changed }
      guard refreshed.canReadService && refreshed.hasStaffRoute("/staff/tasks") else {
        var next = state; if next.openDeliveryId == id { next.openDeliveryId = nil }; try save(next)
        status = "当前岗位未开放服务任务入口，请联系主管"
        navigationNotice = status
        return
      }
      let bytes = try await request("/api/native/push/deliveries/\(id)/target", "GET", nil, nil)
      try requireCurrent(actor, epoch)
      let result = try JSONDecoder().decode(APIEnvelope<NativePushTarget>.self, from: bytes).data
      try validateOwner(result.employeeId, result.staffSessionId, actor: actor, protocolVersion: result.protocol)
      guard result.deliveryId == id, result.installationId == state.installationId,
        result.revision > 0, result.kind == "service_task", UUID(uuidString: result.taskId) != nil,
        UUID(uuidString: result.tableSessionId) != nil, state.openDeliveryId == id
      else { throw NativePushError.invalid }
      if let binding = state.binding, binding.owner == actor, binding.revision != result.revision {
        throw NativePushError.invalid
      }
      // Opening without a local binding is a normal authorized task read, not
      // an opt-in: it never sets enabled/active or registers a device token.
      // Server has rechecked this exact installation/session/revision/task. No
      // business command is sent; the service board performs its own fresh read.
      try addObservation(id, kind: "opened", actor: actor, revision: result.revision)
      var next = state; next.openDeliveryId = nil; try save(next)
      target = result
      status = "已核对原服务任务，请查看最新状态后处理"
      await flushObservations()
    } catch {
      guard current(actor, epoch) else { return }
      if let error = error as? StaffAPIError, [404, 410].contains(error.status) {
        var next = state; if next.openDeliveryId == id { next.openDeliveryId = nil }
        do { try save(next) } catch { status = NativePushError.storage.localizedDescription; return }
        status = "这条提醒已失效或不属于当前员工，请查看当前工作台"
      } else { status = "暂不能核对原提醒，请完成当前操作后重试" }
    }
  }
  private func addObservation(_ id: String, kind: String, actor: NativePushOwner, revision: Int) throws {
    guard !state.observations.contains(where: { $0.deliveryId == id && $0.kind == kind && $0.owner == actor }) else { return }
    var next = state
    next.observations.append(.init(deliveryId: id, kind: kind, requestKey: NativePushState.key(),
      owner: actor, revision: revision))
    try save(next)
  }
  private func flushObservations() async {
    guard !observing, let actor = owner, let request else { return }
    observing = true; defer { observing = false }
    let epoch = generation
    for item in state.observations where item.owner == actor {
      do {
        try requireCurrent(actor, epoch)
        let bytes = try await request("/api/native/push/deliveries/\(item.deliveryId)/observations", "POST",
          ["kind": item.kind], item.requestKey)
        try requireCurrent(actor, epoch)
        let reply = try JSONDecoder().decode(APIEnvelope<NativePushObservationReply>.self, from: bytes).data
        try validateOwner(reply.employeeId, reply.staffSessionId, actor: actor, protocolVersion: reply.protocol)
        let date = item.kind == "opened" ? reply.clientReportedOpenedAt : reply.clientReportedReceivedAt
        guard reply.requestKey == item.requestKey, reply.deliveryId == item.deliveryId,
          reply.kind == item.kind, date.flatMap(StaffIdentity.date) != nil else { throw NativePushError.invalid }
        var next = state; next.observations.removeAll { $0 == item }; try save(next)
      } catch {
        guard current(actor, epoch) else { return }
        if let error = error as? StaffAPIError, [404, 410].contains(error.status) {
          var next = state; next.observations.removeAll { $0 == item }; try? save(next)
        } else { return }
      }
    }
  }
  private func safeMessage(_ error: Error) -> String {
    if let error = error as? NativePushError { return error.localizedDescription }
    if let error = error as? StaffAPIError {
      if error.code == "PUSH_NOT_CONFIGURED" { return NativePushError.disabled.localizedDescription }
      if error.code == "CLIENT_SESSION_CHANGED" { return NativePushError.changed.localizedDescription }
      if error.status == 401 { return "登录已失效，请重新登录后核对提醒" }
      if error.status == 403 { return "当前员工没有服务提醒权限" }
    }
    return "提醒结果未确认，已保留原请求，请联网后重试"
  }
}
