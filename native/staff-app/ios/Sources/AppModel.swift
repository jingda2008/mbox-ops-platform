import AVFoundation
import Speech
import SwiftUI

@MainActor final class AppModel: ObservableObject {
  @Published var world = World.training()
  @Published var live = false
  @Published var busy = false
  @Published var message = ""
  @Published var pending: Command?
  @Published var simulateTimeout = false
  @Published var staffName = "本机演练"
  private let stateURL = URL.documentsDirectory.appending(path: "mbox-training-v1.json")
  private let pendingURL = URL.documentsDirectory.appending(path: "mbox-pending-v1.json")
  var priorityAccessKey: String {
    guard let identity else{return "signed-out"}
    return identity.employee.id + ":" + identity.permissions.sorted().joined(separator:",") + ":" + identity.deniedPermissions.sorted().joined(separator:",")
  }
  @Published var identity: StaffIdentity? {
    didSet {
      if let oldValue, let identity,
        Set(oldValue.permissions) != Set(identity.permissions)
          || Set(oldValue.deniedPermissions) != Set(identity.deniedPermissions)
          || oldValue.navigation != identity.navigation
      {
        resetDailyBusinessViews()
        workspaceVersion += 1
      }
    }
  }
  @Published var deviceReady = false
  @Published var connection = "本机演练"
  @Published var lastUpdated: Date?
  @Published var liveOperations: LiveOperations?
  @Published var workspaceVersion = 0
  let api: StaffAPI
  let trainingAllowed: Bool
  private let nativeCleanupPersistence: NativeCommandCleanupPersistence
  private let reservationReceptionPersistence: ReservationReceptionPersistence
  private let nativeManagementPersistence: NativeManagementPersistence
  @Published var rememberLogin = false
  @Published var savedLoginAvailable = false
  private var restoreAttempted = false
  @Published var livePending: LiveCommand?
  @Published var liveOrderPending: LiveOrderSubmission?
  @Published var lastOrderReceipt: LiveOrderReceipt?
  private let orderPendingURL = URL.documentsDirectory.appending(path: "mbox-live-order-v1.json")
  @Published var liveOrders: [LiveOrderDetail] = []
  @Published var orderDetailState = ""
  @Published var pickupBoard: LivePickup?
  @Published var pickupUpdated: Date?
  @Published var pickupState = ""
  @Published var overview: OperatingOverview?
  @Published var overviewState = "请读取经营概览"
  @Published var overviewPeriod = "day"
  @Published var overviewAnchor = ""
  func loadOverview(period: String = "day", anchor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    overview = nil
    overviewState = "正在读取经营概览"
    do {
      let path = try overviewPath(period: period, anchor: anchor)
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("commercial.profit.view") else {
        throw CatalogError("当前岗位没有经营利润查看权限")
      }
      let report: OperatingOverview = try await api.data(path)
      try report.validate(period: period)
      guard identity?.employee.id == actor.employee.id else { throw StaffAPIError.invalid }
      overview = report
      overviewPeriod = period
      overviewAnchor = anchor
      overviewState = "已读取服务器账本；仅代表系统已记录部分，未知成本不可视为0。"
    } catch {
      overviewState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private let nativeMediaReadPermissions = ["community.activity.view", "community.activity.manage", "community.activity.publish", "customer.experience.feature.manage", "media.asset.menu.manage"]
  func readNativeManagementMedia(purpose: String, cursor: String) async throws -> Data {
    guard nativeMediaPurposes.contains(purpose), cursor.isEmpty || nativeMediaID(cursor) else { throw StaffAPIError.invalid }
    return try await readNativeMedia("/api/staff/media-assets?limit=12&purpose=" + purpose + (cursor.isEmpty ? "" : "&before=" + cursor))
  }
  func readNativeManagementThumbnail(publicId: String) async throws -> Data {
    guard nativeMediaID(publicId) else { throw StaffAPIError.invalid }
    return try await readNativeMedia("/api/staff/media-assets/" + publicId + "?size=thumbnail")
  }
  private func readNativeMedia(_ path: String) async throws -> Data {
    guard live, !busy, !heartbeatBusy else { throw CatalogError("请等待当前图片读取完成") }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, nativeMediaReadPermissions.contains(where: actor.allows) else { throw CatalogError("当前岗位没有图片库查看权限") }
      let generation = workspaceVersion
      let (bytes, _) = try await api.raw(path)
      guard workspaceVersion == generation, identity?.employee.id == actor.employee.id,
        identity?.session.id == actor.session.id, identity?.permissions == actor.permissions,
        identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return bytes
    } catch { handleLiveError(error); throw error }
  }
  func uploadNativeManagementMedia(_ upload: NativeMediaUpload) async throws -> NativeMediaAsset {
    guard memberReady, let previous = identity, upload.employeeID == previous.employee.id else { throw CatalogError("请由选择原图片的员工恢复上传") }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      let permissions = upload.purpose == "support_contact" ? ["community.activity.manage", "customer.experience.feature.manage"] : upload.purpose == "menu" ? ["media.asset.menu.manage"] : ["community.activity.manage"]
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        actor.staffNavigationKey == previous.staffNavigationKey, permissions.contains(where: actor.allows) else { throw CatalogError("原员工、会话或图片上传权限已变化") }
      let generation = workspaceVersion
      let (bytes, _) = try await api.raw("/api/staff/media-assets", body: upload.body, headers: ["idempotency-key": upload.key])
      let result = try NativeMediaAsset.validateUploadReply(bytes, upload: upload)
      guard workspaceVersion == generation, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.staffNavigationKey == actor.staffNavigationKey else { throw StaffAPIError.invalid }
      return result
    } catch { handleLiveError(error); throw error }
  }
  @Published var showReceipt: ShowReceipt?
  func readShow(_ path: String, body: [String: Any]? = nil) async throws -> Data {
    guard live, !busy, !heartbeatBusy, let url = URLComponents(string: path), url.scheme == nil,
      url.host == nil, url.fragment == nil, !url.path.split(separator: "/").contains(".."),
      path.rangeOfCharacter(from: .controlCharacters) == nil else { throw CatalogError("请等待当前读取完成并核对演出查询") }
    let value = url.path
    let allowed: Bool
    if body != nil { allowed = value == showRoot + "/preview" && url.query == nil }
    else {
      allowed = value == showRoot || value == "/api/staff/native-song-capabilities" || value == "/api/staff/song-requests"
        || value.range(of: "^/api/staff/native-performances/performers/[A-Fa-f0-9-]{36}/songs$", options: .regularExpression) != nil
        || value.range(of: "^/api/staff/native-performances/revisions/[A-Za-z0-9_-]{1,128}/impacts$", options: .regularExpression) != nil
        || value.range(of: "^/api/staff/native-song-requests/[A-Fa-f0-9-]{36}/payment-evidence$", options: .regularExpression) != nil
    }
    guard allowed else { throw StaffAPIError.invalid }
    let permissions: [String]
    if body != nil { permissions = ["song.manage"] }
    else if value.hasSuffix("/payment-evidence") { permissions = ["song.payment.record"] }
    else if value.hasSuffix("/impacts") { permissions = ["reservation.view"] }
    else if value.hasSuffix("/songs") || value == "/api/staff/song-requests" { permissions = ["song.view", "song.manage"] }
    else if value == "/api/staff/native-song-capabilities" { permissions = ["song.view", "song.manage", "song.payment.record"] }
    else { permissions = showReadPermissions }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, permissions.contains(where: actor.allows) else { throw CatalogError("当前岗位没有对应演出或点歌范围权限") }
      let generation = workspaceVersion
      let (bytes, _) = try await api.raw(path, body: body)
      guard workspaceVersion == generation, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return bytes
    } catch { handleLiveError(error); throw error }
  }
  @Published var nativeManagementBoard: NativeManagementBoard?
  @Published var nativeManagementState = "请读取门店配置"
  private var nativeManagementUpdated: Date?
  private var nativeManagementModule: NativeManagementModule = .devices
  private var nativeManagementSearch = "", nativeManagementCursor = "", nativeManagementCode = "DEFAULT"
  @Published var bridgePairing: NativeBridgePairing?
  private var bridgePairingGeneration = 0
  var canUseNativeManagement: Bool {
    memberReady && nativeManagementBoard?.enabled == true
      && nativeManagementBoard?.employeeID == identity?.employee.id
      && nativeManagementBoard?.module == nativeManagementModule
      && identity.map { nativeManagementModule.available(to: $0) && nativeManagementModule.permissions.contains(where: $0.allows) } == true
      && nativeManagementUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadNativeManagement(_ module: NativeManagementModule, search: String = "", cursor: String = "", code: String = "DEFAULT") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    nativeManagementBoard = nil; nativeManagementUpdated = nil; clearBridgePairing()
    nativeManagementState = "正在读取" + module.title
    do {
      identity = try await api.heartbeat()
      _ = try nativeManagementReadPath(module: module, search: search, cursor: cursor, code: code)
      nativeManagementModule = module; nativeManagementSearch = search; nativeManagementCursor = cursor; nativeManagementCode = code
      try await fetchNativeManagement(module)
    } catch {
      nativeManagementState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchNativeManagement(_ module: NativeManagementModule) async throws {
    guard let actor = identity, module.available(to: actor), module.permissions.contains(where: actor.allows) else {
      throw CatalogError("当前岗位没有此门店配置权限")
    }
    let generation = workspaceVersion
    let (data, _) = try await api.raw(nativeManagementReadPath(module: module, search: nativeManagementSearch, cursor: nativeManagementCursor, code: nativeManagementCode))
    var bridges: Data?; var capabilities: Data?
    if module == .devices {
      bridges = try await api.raw("/api/hardware/print-bridges").0
      do { capabilities = try await api.raw("/api/hardware/native-print-bridges/capabilities").0 }
      catch let failure as StaffAPIError where failure.status == 404 { capabilities = nil }
    }
    let board = try NativeManagementBoard(module: module, data: data, bridges: bridges,
      capabilities: capabilities, actor: actor)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else {
      throw StaffAPIError.invalid
    }
    nativeManagementModule = module; nativeManagementBoard = board; nativeManagementUpdated = Date()
    nativeManagementState = "已读取" + module.title + "，提交前请核对原配置与影响。"
  }
  func readNativeManagementOptions(module: NativeManagementModule, search: String = "", cursor: String = "") async throws -> Data {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    let path = try nativeManagementOptionsPath(module: module, search: search, cursor: cursor)
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        module.available(to: actor), actor.allows("community.activity.manage") else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(path)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return data
    } catch { handleLiveError(error); throw error }
  }
  func prepareNativeManagement(operation: String, fields: [String: String], rowID: String? = nil)
    throws -> LiveCommand {
    guard canUseNativeManagement, let board = nativeManagementBoard, let actor = identity else {
      throw CatalogError("请刷新配置并核对当前员工权限")
    }
    return try board.command(actor: actor, operation: operation, fields: fields, rowID: rowID)
  }
  func clearBridgePairing() { bridgePairing = nil; bridgePairingGeneration += 1 }
  func createBridgePairing(reason: String) async {
    guard canUseNativeManagement, nativeManagementModule == .devices, let previous = identity else { return }
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (3...500).contains(note.utf16.count) else { message = "请填写3—500字配对说明"; return }
    clearBridgePairing()
    let generation = bridgePairingGeneration, access = previous.staffNavigationKey
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard identity?.staffNavigationKey == access,
        NativeManagementModule.devices.permissions.contains(where: { identity?.allows($0) == true }) else {
        throw StaffAPIError.invalid
      }
      let (data, _) = try await api.raw("/api/hardware/print-bridges/pairing-code",
        body: ["reason": note, "ttlSeconds": 600])
      let pairing = try NativeBridgePairing(data: data)
      if bridgePairingGeneration == generation, identity?.staffNavigationKey == access {
        bridgePairing = pairing
      }
    } catch {
      handleLiveError(error)
      message = "配对码未能显示，不会自动重试；之前可能已生成的码10分钟后失效。" + error.localizedDescription
    }
  }
  @Published var bottleStorageReceipt: BottleStorageReceipt?
  func readBottleStorage(_ suffix: String) async throws -> Data {
    guard live, !busy, !heartbeatBusy,
      suffix.isEmpty || suffix.hasPrefix("/") || suffix.hasPrefix("?"),
      !suffix.contains("#"), let decoded = suffix.removingPercentEncoding,
      !decoded.split(separator: "/").contains(".."),
      decoded.rangeOfCharacter(from: .controlCharacters) == nil else {
      throw CatalogError("请等待当前读取完成并核对存酒查询")
    }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("bottle.manage.all") else {
        throw CatalogError("当前岗位没有对应存酒范围权限")
      }
      bottleStorageReceipt = try BottleStorageSecrets.receipt(employeeID: actor.employee.id)
      let generation = workspaceVersion
      let (data, _) = try await api.raw(bottleStorageRoot + suffix)
      guard workspaceVersion == generation, identity?.employee.id == actor.employee.id,
        identity?.session.id == actor.session.id, identity?.permissions == actor.permissions,
        identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return data
    } catch {
      handleLiveError(error)
      throw error
    }
  }
  @Published var experiencePlanReceipt: ExperiencePlanReceipt?
  @Published var remakeHandoverReceipt: RemakeHandoverReceipt?
  private func readScopedNativeBusiness(_ path: String, permissions: [String]) async throws -> Data {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        permissions.allSatisfy(actor.allows) else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(path)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return data
    } catch { handleLiveError(error); throw error }
  }
  func readNativeTableScanTargets() async throws -> [StaffTable] {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        actor.canReadTables, actor.hasStaffRoute("/staff/live"), generation == workspaceVersion else { throw StaffAPIError.invalid }
      try await loadOperations()
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
        identity?.navigation == actor.navigation, let result = liveOperations, result.actor.id == actor.employee.id else { throw StaffAPIError.invalid }
      return result.displayTables()
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id { handleLiveError(error) }
      throw error
    }
  }
  func readFulfillmentHistory(query: FulfillmentHistoryQuery, page: Int) async throws -> FulfillmentHistoryBoard {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    let path = try query.path(page: page)
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        canReadFulfillmentHistory(actor) else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(path)
      let board = try FulfillmentHistoryBoard(data, query: query, page: page)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return board
    } catch { handleLiveError(error); throw error }
  }
  func readExperiencePlans(_ suffix: String) async throws -> Data {
    guard let parts = URLComponents(string: experiencePlansRoot + suffix), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
      parts.path == experiencePlansRoot, !suffix.contains("#"), suffix.isEmpty || suffix.hasPrefix("?"),
      (parts.queryItems ?? []).allSatisfy({ ["history", "from", "to", "beforeDate", "beforeId"].contains($0.name) }),
      Set((parts.queryItems ?? []).map(\.name)).count == (parts.queryItems ?? []).count else { throw StaffAPIError.invalid }
    return try await readScopedNativeBusiness(experiencePlansRoot + suffix, permissions: ["customer.experience.manage", "service.execute"])
  }
  func readRemakeHandover(_ path: String) async throws -> Data {
    guard let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
      parts.path == remakeHandoverRoot + "/native-remake-handover" else { throw StaffAPIError.invalid }
    let query = parts.queryItems ?? []
    if !query.isEmpty {
      guard query.count == 2, let id = query.first(where: { $0.name == "cursorId" })?.value,
        let at = query.first(where: { $0.name == "createdAt" })?.value,
        try RemakeHandoverBoard.path(cursor: ["id": id, "createdAt": at]) == path else { throw StaffAPIError.invalid }
    } else { guard try RemakeHandoverBoard.path() == path else { throw StaffAPIError.invalid } }
    return try await readScopedNativeBusiness(path, permissions: ["refund.request"])
  }
  func resolveServicePending(command: LiveCommand, login: String, pin: String, reason: String) async {
    guard live, !busy, !heartbeatBusy, !liveStorageDamaged, liveOrderPending == nil, livePending == command else { return }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    var supervisor: StaffAPI?
    do {
      let body = try serviceRecoveryRequest(command, reason: reason)
      let client = try api.supervisorClient(); supervisor = client
      let actor = try await client.login(code: login, pin: pin, switching: false)
      guard actor.employee.id != command.employeeID, actor.allows("service.manage"), actor.allows("service.execute"),
        StaffIdentity.date(actor.session.onlineLeaseUntil).map({ $0 > Date() }) == true,
        generation == workspaceVersion, livePending == command else { throw CatalogError("须由另一位有效主管核对原请求") }
      let (data, _) = try await client.raw("/api/native-service-recovery", body: body)
      let result = try validateServiceRecoveryReply(data, command: command, supervisorID: actor.employee.id)
      guard generation == workspaceVersion, livePending == command else { throw CatalogError("当前工作区已变化，已保留原请求供核对") }
      try FileManager.default.removeItem(at: livePendingURL)
      livePending = nil; resetDailyBusinessViews(); workspaceVersion += 1; message = result
    } catch { message = error.localizedDescription }
    if let supervisor {
      try? await supervisor.logout()
      supervisor.clearTemporarySession()
    }
  }
  func readBusinessReport(_ query: NativeBusinessReportQuery) async throws -> NativeBusinessReport {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    let path = try query.path()
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor
      guard query.available(to: actor) else { throw CatalogError("当前岗位已无权读取此报表，请重新选择工作台") }
      func current() -> Bool {
        generation == workspaceVersion && identity?.employee.id == actor.employee.id
          && identity?.session.id == actor.session.id && identity?.permissions == actor.permissions
          && identity?.deniedPermissions == actor.deniedPermissions && identity?.navigation == actor.navigation
      }
      let (data, _) = try await api.raw(path)
      guard current() else { throw StaffAPIError.invalid }
      var evidence: Data?
      if query.kind == .experience && actor.allows("observation.view.raw") {
        evidence = try await api.raw(query.path(evidence: true)).0
        guard current() else { throw StaffAPIError.invalid }
      }
      return try NativeBusinessReport(data: data, evidence: evidence, query: query, actor: actor)
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id { handleLiveError(error) }
      throw error
    }
  }
  @Published var contactGovernanceBoard: ContactGovernanceBoard?
  @Published var contactGovernanceState = "请读取联系方式保留治理"
  private var contactGovernanceUpdated: Date?
  private var contactGovernanceArea = "policies"
  private var contactGovernanceSearch = ""
  private var contactGovernanceCursor = ""
  var canUseContactGovernance: Bool {
    memberReady && contactGovernanceBoard?.enabled == true && contactGovernanceBoard?.employeeID == identity?.employee.id
      && identity?.canOpen(.contactGovernance) == true
      && (contactGovernanceBoard?.area != "resources" || identity?.allows("privacy.contact.legal_hold") == true)
      && contactGovernanceUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadContactGovernance(area: String = "policies", search: String = "", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy, let previous = identity else { return }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    contactGovernanceBoard = nil; contactGovernanceUpdated = nil; contactGovernanceState = "正在读取联系方式保留治理"
    do {
      _ = try ContactGovernanceBoard.query(area: area, search: search, cursor: cursor)
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor; contactGovernanceArea = area; contactGovernanceSearch = search; contactGovernanceCursor = cursor
      try await fetchContactGovernance()
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id {
        contactGovernanceState = error.localizedDescription; handleLiveError(error)
      }
    }
  }
  private func fetchContactGovernance() async throws {
    let area = contactGovernanceArea, search = contactGovernanceSearch, cursor = contactGovernanceCursor, generation = workspaceVersion
    guard let actor = identity, actor.canOpen(.contactGovernance),
      area != "resources" || actor.allows("privacy.contact.legal_hold") else { throw StaffAPIError.invalid }
    let (data, _) = try await api.raw(ContactGovernanceBoard.query(area: area, search: search, cursor: cursor))
    let board = try ContactGovernanceBoard(data: data, actor: actor, area: area, search: search, cursor: cursor)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
      identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
    contactGovernanceBoard = board; contactGovernanceUpdated = Date(); contactGovernanceState = "已读取原保留记录；草稿、独立审批、发布与法定保留分别执行。"
  }
  @Published var marketingBoard: MarketingBoard?
  @Published var marketingState = "请读取营销告知与本人许可"
  private var marketingUpdated: Date?
  private var marketingArea = "notices"
  private var marketingCode = ""
  private var marketingCursor = ""
  var canUseMarketing: Bool {
    memberReady && marketingBoard?.enabled == true && marketingBoard?.employeeID == identity?.employee.id
      && identity?.canOpen(.marketing) == true
      && identity.map { canReadMarketing($0, area: marketingArea) } == true
      && marketingUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadMarketing(area: String = "notices", code: String = "", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy, let previous = identity else { return }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    marketingBoard = nil; marketingUpdated = nil; marketingState = "正在读取营销告知与本人许可"
    do {
      _ = try MarketingBoard.query(area: area, code: code, cursor: cursor)
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor; marketingArea = area; marketingCode = code; marketingCursor = cursor
      try await fetchMarketing()
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id {
        marketingState = error.localizedDescription; handleLiveError(error)
      }
    }
  }
  private func fetchMarketing() async throws {
    let area = marketingArea, code = marketingCode, cursor = marketingCursor, generation = workspaceVersion
    guard let actor = identity, actor.canOpen(.marketing), canReadMarketing(actor, area: area) else { throw StaffAPIError.invalid }
    let (data, _) = try await api.raw(MarketingBoard.query(area: area, code: code, cursor: cursor))
    let board = try MarketingBoard(data: data, actor: actor, area: area, code: code, cursor: cursor)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
      identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
    marketingBoard = board; marketingUpdated = Date(); marketingState = "已读取原记录；排队、渠道受理与确认送达是不同状态。"
  }
  private func canReadMarketing(_ actor: StaffIdentity, area: String) -> Bool {
    if area == "workspace" { return marketingAreas.contains { actor.allows($0.2) } }
    return actor.allows(area == "notices" ? "marketing.notice.view" : area == "jobs" ? "marketing.send" : "invalid")
  }
  func readMarketingCustomers(purpose: String, search: String, cursor: String = "") async throws -> MarketingCustomerPage {
    let path = try MarketingCustomerPage.query(purpose: purpose, search: search, cursor: cursor)
    let (data, actor) = try await readMarketingData(path: path, permission: marketingCustomerPermission(purpose))
    return try MarketingCustomerPage(data: data, actor: actor, purpose: purpose, search: search)
  }
  func readMarketingHistory(customerId: String, reason: String, cursor: String = "") async throws -> MarketingHistoryPage {
    let body = try MarketingHistoryPage.body(customerId: customerId, reason: reason, cursor: cursor)
    let (data, actor) = try await readMarketingData(path: marketingRoot + "/history", permission: "marketing.consent.audit", body: body)
    return try MarketingHistoryPage(data: data, actor: actor, customerId: customerId)
  }
  private func readMarketingData(path: String, permission: String, body: [String: Any]? = nil) async throws -> (Data, StaffIdentity) {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor
      guard actor.canOpen(.marketing), actor.allows(permission) else { throw CatalogError("当前岗位没有此项本人许可查询权限") }
      let (data, _) = try await api.raw(path, body: body)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
        identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
      return (data, actor)
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id { handleLiveError(error) }
      throw error
    }
  }
  @Published var annualPolicyBoard: AnnualPolicyBoard?
  @Published var annualPolicyState = "请读取年度礼遇政策"
  private var annualPolicyUpdated: Date?
  private var annualPolicyCode = ""
  private var annualPolicyCursor = ""
  var canUseAnnualPolicies: Bool {
    memberReady && annualPolicyBoard?.enabled == true && annualPolicyBoard?.employeeID == identity?.employee.id
      && identity?.canOpen(.annualPolicies) == true
      && annualPolicyUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadAnnualPolicies(code: String = "", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy, let previous = identity else { return }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    annualPolicyBoard = nil; annualPolicyUpdated = nil; annualPolicyState = "正在读取年度礼遇政策"
    do {
      _ = try AnnualPolicyBoard.query(code: code, cursor: cursor)
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor; annualPolicyCode = code; annualPolicyCursor = cursor
      try await fetchAnnualPolicies()
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id {
        annualPolicyState = error.localizedDescription; handleLiveError(error)
      }
    }
  }
  private func fetchAnnualPolicies() async throws {
    let code = annualPolicyCode, cursor = annualPolicyCursor, generation = workspaceVersion
    guard let actor = identity, actor.canOpen(.annualPolicies) else { throw StaffAPIError.invalid }
    let (data, _) = try await api.raw(AnnualPolicyBoard.query(code: code, cursor: cursor))
    let board = try AnnualPolicyBoard(data: data, actor: actor, code: code, cursor: cursor)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
      identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
    annualPolicyBoard = board; annualPolicyUpdated = Date(); annualPolicyState = "已读取原政策；创建、复核、发布及日期确认分别执行。"
  }
  func readAnnualPolicyOptions(kind: String, search: String = "", cursor: String = "") async throws -> AnnualPolicyPage {
    try await readAnnualPolicyPage(path: AnnualPolicyPage.optionsQuery(kind: kind, search: search, cursor: cursor), kind: kind)
  }
  func readAnnualOccurrences(ruleId: String, cursor: String = "") async throws -> AnnualPolicyPage {
    try await readAnnualPolicyPage(path: AnnualPolicyPage.occurrencesQuery(ruleId: ruleId, cursor: cursor), kind: "occurrences", ruleId: ruleId)
  }
  private func readAnnualPolicyPage(path: String, kind: String, ruleId: String = "") async throws -> AnnualPolicyPage {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor
      guard actor.canOpen(.annualPolicies) else { throw CatalogError("当前岗位没有年度礼遇读取权限") }
      let (data, _) = try await api.raw(path)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
        identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
      return try AnnualPolicyPage(data: data, actor: actor, kind: kind, ruleId: ruleId)
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id { handleLiveError(error) }
      throw error
    }
  }
  @Published var loyaltyRefundBoard: LoyaltyRefundBoard?
  @Published var loyaltyRefundState = "请读取已成功退款的原商品归属记录"
  private var loyaltyRefundUpdated: Date?
  private var loyaltyRefundPage = 0
  var canUseLoyaltyRefunds: Bool {
    memberReady && loyaltyRefundBoard?.enabled == true && loyaltyRefundBoard?.employeeID == identity?.employee.id
      && identity.map(canReadLoyaltyRefunds) == true
      && loyaltyRefundUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadLoyaltyRefunds(page: Int = 0) async {
    guard live, !busy, !heartbeatBusy, let previous = identity else { return }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    loyaltyRefundBoard = nil; loyaltyRefundUpdated = nil; loyaltyRefundState = "正在读取原退款归属"
    do {
      _ = try LoyaltyRefundBoard.query(page: page)
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor; loyaltyRefundPage = page
      try await fetchLoyaltyRefunds()
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id {
        loyaltyRefundState = error.localizedDescription; handleLiveError(error)
      }
    }
  }
  private func fetchLoyaltyRefunds() async throws {
    let page = loyaltyRefundPage, generation = workspaceVersion
    guard let actor = identity, canReadLoyaltyRefunds(actor) else { throw StaffAPIError.invalid }
    let (data, _) = try await api.raw(LoyaltyRefundBoard.query(page: page))
    let board = try LoyaltyRefundBoard(data: data, actor: actor, page: page)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
      identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
    loyaltyRefundBoard = board; loyaltyRefundUpdated = Date(); loyaltyRefundState = "已读取原退款；本页核对商品归属和积分，不会再次退款。"
  }
  @Published var loyaltyOperationsBoard: LoyaltyOperationsBoard?
  @Published var loyaltyOperationsState = "请读取原礼遇异常或积分核对记录"
  private var loyaltyOperationsUpdated: Date?
  private var loyaltyOperationsKind: LoyaltyOperationKind = .benefit
  private var loyaltyOperationsSection = "reconciliation"
  private var loyaltyOperationsPage = 0
  var canUseLoyaltyOperations: Bool {
    memberReady && loyaltyOperationsBoard?.enabled == true && loyaltyOperationsBoard?.employeeID == identity?.employee.id
      && identity?.allows(loyaltyOperationsKind.readPermission) == true
      && loyaltyOperationsUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadLoyaltyOperations(kind: LoyaltyOperationKind, section: String = "reconciliation", page: Int = 0) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true; defer { busy = false }
    loyaltyOperationsBoard = nil; loyaltyOperationsUpdated = nil; loyaltyOperationsState = "正在读取原业务核对记录"
    do {
      _ = try LoyaltyOperationsBoard.query(kind: kind, section: section, page: page)
      identity = try await api.heartbeat(); loyaltyOperationsKind = kind; loyaltyOperationsSection = section; loyaltyOperationsPage = page
      try await fetchLoyaltyOperations()
    } catch { loyaltyOperationsState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchLoyaltyOperations() async throws {
    let kind = loyaltyOperationsKind, section = loyaltyOperationsSection, page = loyaltyOperationsPage, generation = workspaceVersion
    guard let actor = identity, actor.allows(kind.readPermission) else { throw StaffAPIError.invalid }
    let (data, _) = try await api.raw(LoyaltyOperationsBoard.query(kind: kind, section: section, page: page))
    let board = try LoyaltyOperationsBoard(kind: kind, data: data, actor: actor, section: section, page: page)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    loyaltyOperationsBoard = board; loyaltyOperationsUpdated = Date(); loyaltyOperationsState = "已读取原记录；积分核算、履约补偿和资金收退款分别核对。"
  }
  @Published var couponPolicyBoard: CouponPolicyBoard?
  @Published var couponPolicyState = "请读取券日历或优惠叠加规则"
  private var couponPolicyUpdated: Date?
  private var couponPolicyKind: CouponPolicyKind = .calendar
  private var couponPolicySearch = "", couponPolicyCursor = ""
  var canUseCouponPolicy: Bool {
    memberReady && couponPolicyBoard?.enabled == true && couponPolicyBoard?.employeeID == identity?.employee.id
      && identity?.allows("loyalty.configuration.view") == true
      && couponPolicyUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadCouponPolicies(kind: CouponPolicyKind, search: String = "", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true; defer { busy = false }
    couponPolicyBoard = nil; couponPolicyUpdated = nil; couponPolicyState = "正在读取原规则"
    do {
      _ = try CouponPolicyBoard.query(kind: kind, search: search, cursor: cursor)
      identity = try await api.heartbeat(); couponPolicyKind = kind; couponPolicySearch = search; couponPolicyCursor = cursor
      try await fetchCouponPolicies()
    } catch { couponPolicyState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchCouponPolicies() async throws {
    guard let actor = identity, actor.allows("loyalty.configuration.view") else { throw StaffAPIError.invalid }
    let generation = workspaceVersion, kind = couponPolicyKind, search = couponPolicySearch
    let (data, _) = try await api.raw(CouponPolicyBoard.query(kind: kind, search: search, cursor: couponPolicyCursor))
    let board = try CouponPolicyBoard(kind: kind, data: data, actor: actor, search: search)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    couponPolicyBoard = board; couponPolicyUpdated = Date(); couponPolicyState = "已读取原规则；审批、发布与价格试算分别核对。"
  }
  func readCouponPolicyPreview(kind: CouponPolicyKind, body: [String: Any]) async throws -> Data {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        actor.allows(kind.previewPermission) else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(kind.root + "/preview", body: body)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return data
    } catch { handleLiveError(error); throw error }
  }
  @Published var membershipRecoveryBoard: MembershipRecoveryBoard?
  @Published var membershipRecoveryState = "请读取历史会员找回申请"
  private var membershipRecoveryUpdated: Date?
  private var membershipRecoveryHistory = false
  private var membershipRecoveryCursor = ""
  var canUseMembershipRecovery: Bool {
    memberReady && membershipRecoveryBoard?.enabled == true && membershipRecoveryBoard?.employeeID == identity?.employee.id
      && identity.map { membershipRecoveryPermissions.contains(where: $0.allows) } == true
      && membershipRecoveryUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadMembershipRecovery(history: Bool = false, cursor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true; defer { busy = false }
    membershipRecoveryBoard = nil; membershipRecoveryUpdated = nil; membershipRecoveryState = "正在读取原会员找回申请"
    do {
      _ = try MembershipRecoveryBoard.query(history: history, cursor: cursor)
      identity = try await api.heartbeat(); membershipRecoveryHistory = history; membershipRecoveryCursor = cursor
      try await fetchMembershipRecovery()
    } catch { membershipRecoveryState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchMembershipRecovery() async throws {
    guard let actor = identity, membershipRecoveryPermissions.contains(where: actor.allows) else { throw StaffAPIError.invalid }
    let generation = workspaceVersion, history = membershipRecoveryHistory
    let (bytes, _) = try await api.raw(MembershipRecoveryBoard.query(history: history, cursor: membershipRecoveryCursor))
    let board = try MembershipRecoveryBoard(data: bytes, actor: actor, history: history)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    membershipRecoveryBoard = board; membershipRecoveryUpdated = Date(); membershipRecoveryState = "已读取原申请；核验与合并复核须由不同员工完成。"
  }
  func membershipRecoveryCandidates(row: RecoveryRecord, cursor: String = "") async throws -> MembershipRecoveryCandidates {
    guard live, !busy, !heartbeatBusy, let previous = identity, membershipRecoveryBoard?.rows.contains(row) == true else { throw StaffAPIError.invalid }
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == previous.employee.id, actor.session.id == previous.session.id,
        actor.allows(membershipRecoveryPermissions[0]), membershipRecoveryBoard?.rows.contains(row) == true else { throw StaffAPIError.invalid }
      let (bytes, _) = try await api.raw(MembershipRecoveryCandidates.query(row: row, cursor: cursor))
      let result = try MembershipRecoveryCandidates(data: bytes, actor: actor, row: row)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return result
    } catch { handleLiveError(error); throw error }
  }
  @Published var memberNumberBoard: MemberNumberBoard?
  @Published var memberNumberState = "请读取会员号规则"
  private var memberNumberUpdated: Date?
  var canUseMemberNumber: Bool {
    memberReady && memberNumberBoard?.enabled == true && memberNumberBoard?.employeeID == identity?.employee.id
      && identity?.allows("member.card.manage") == true
      && memberNumberUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadMemberNumber() async {
    guard live, !busy, !heartbeatBusy else { return }; busy = true
    defer { busy = false }
    memberNumberBoard = nil; memberNumberUpdated = nil; memberNumberState = "正在读取会员号规则"
    do { identity = try await api.heartbeat(); try await fetchMemberNumber() }
    catch { memberNumberState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchMemberNumber() async throws {
    guard let actor = identity, actor.allows("member.card.manage") else { throw CatalogError("当前岗位没有会员号管理权限") }
    let generation = workspaceVersion
    let (bytes, _) = try await api.raw(memberNumberRoot)
    let board = try MemberNumberBoard(data: bytes, actor: actor)
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    memberNumberBoard = board; memberNumberUpdated = Date(); memberNumberState = "已读取原会员号规则；只影响之后发号，已发会员号不变。"
  }
  func readMembershipOverview() async throws -> MembershipOverview {
    guard live, !busy, !heartbeatBusy else { throw CatalogError("请等待当前读取完成") }; busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("loyalty.policy.view") else { throw CatalogError("当前岗位没有会员规则查看权限") }
      let generation = workspaceVersion
      let points = try await api.raw("/api/staff/loyalty/policies").0
      let tiers = try await api.raw("/api/staff/loyalty/tier-policies").0
      let benefits = try await api.raw("/api/staff/loyalty/tier-benefits").0
      let catalog = try await api.raw("/api/staff/loyalty/redemption-configuration").0
      let result = try MembershipOverview(points: points, tiers: tiers, benefits: benefits, catalog: catalog, actor: actor)
      guard workspaceVersion == generation, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return result
    } catch { handleLiveError(error); throw error }
  }
  @Published var memberGiftsBoard: MemberGiftsBoard?
  @Published var memberGiftsState = "请读取赠礼活动与发放任务"
  private var memberGiftsUpdated: Date?
  private var memberGiftsSection = "campaigns"
  private var memberGiftsCursor = ""
  var canUseMemberGifts: Bool {
    memberReady && memberGiftsBoard?.enabled == true
      && memberGiftsBoard?.employeeID == identity?.employee.id
      && memberGiftsBoard?.section == memberGiftsSection
      && identity?.allows("loyalty.configuration.view") == true
      && memberGiftsUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadMemberGifts(section: String = "campaigns", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    memberGiftsBoard = nil; memberGiftsUpdated = nil; memberGiftsState = "正在读取原赠礼记录"
    do {
      _ = try MemberGiftsBoard.query(section: section, cursor: cursor)
      identity = try await api.heartbeat()
      memberGiftsSection = section; memberGiftsCursor = cursor
      try await fetchMemberGifts()
    } catch { memberGiftsState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchMemberGifts() async throws {
    guard let actor = identity, actor.allows("loyalty.configuration.view") else { throw CatalogError("当前岗位没有赠礼配置查看权限") }
    let section = memberGiftsSection
    let (bytes, _) = try await api.raw(MemberGiftsBoard.query(section: section, cursor: memberGiftsCursor))
    let board = try MemberGiftsBoard(data: bytes, actor: actor, section: section)
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    memberGiftsBoard = board; memberGiftsUpdated = Date(); memberGiftsState = "已读取原赠礼记录；发放结果以原任务与会员权益状态为准。"
  }
  func memberGiftOptions(kind: String, search: String, cursor: String = "") async throws -> MemberGiftOptions {
    try await readMemberGiftOptions(MemberGiftOptions.query(kind: kind, search: search, cursor: cursor), refund: false)
  }
  func memberGiftRefundOptions(refundID: String, reservationID: String, cursor: String = "") async throws -> MemberGiftOptions {
    try await readMemberGiftOptions(MemberGiftOptions.refundQuery(refundID: refundID, reservationID: reservationID, cursor: cursor), refund: true)
  }
  private func readMemberGiftOptions(_ path: String, refund: Bool) async throws -> MemberGiftOptions {
    guard live, !busy, !heartbeatBusy else { throw CatalogError("请等待当前读取完成") }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("loyalty.configuration.view"), !refund || actor.allows("loyalty.policy.publish") else { throw CatalogError("当前岗位没有对应赠礼或退款复核权限") }
      let (bytes, _) = try await api.raw(path)
      let result = try MemberGiftOptions(data: bytes, actor: actor, refund: refund)
      guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return result
    } catch { handleLiveError(error); throw error }
  }
  @Published var membershipConfigBoard: MembershipConfigBoard?
  @Published var membershipConfigDetail: MembershipConfigDetail?
  @Published var membershipConfigState = "请读取会员规则与运行控制"
  private var membershipConfigUpdated: Date?
  private var membershipConfigSection = "rules"
  private var membershipConfigTarget: String?
  var canUseMembershipConfig: Bool {
    memberReady && membershipConfigBoard?.enabled == true
      && membershipConfigBoard?.employeeID == identity?.employee.id
      && membershipConfigBoard?.section == membershipConfigSection
      && identity?.allows(membershipConfigSection == "rules" ? "loyalty.configuration.view" : "loyalty.operations.view") == true
      && membershipConfigUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func clearMembershipConfigDetail() { membershipConfigDetail = nil; membershipConfigTarget = nil }
  func loadMembershipConfig(section: String = "rules", target: String? = nil) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    membershipConfigBoard = nil; membershipConfigDetail = nil; membershipConfigUpdated = nil
    membershipConfigState = "正在读取会员规则与运行控制"
    do {
      guard ["rules", "controls"].contains(section), target == nil || section == "rules" else { throw StaffAPIError.invalid }
      if let target { _ = try MembershipConfigDetail.target(target) }
      identity = try await api.heartbeat()
      membershipConfigSection = section; membershipConfigTarget = target
      try await fetchMembershipConfig()
    } catch {
      membershipConfigState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchMembershipConfig() async throws {
    let section = membershipConfigSection, target = membershipConfigTarget
    guard let actor = identity,
      actor.allows(section == "rules" ? "loyalty.configuration.view" : "loyalty.operations.view") else {
      throw CatalogError("当前岗位没有此会员规则范围的权限")
    }
    let (data, _) = try await api.raw(membershipConfigRoot + "?section=" + section)
    let board = try MembershipConfigBoard(data: data, actor: actor, section: section)
    var detail: MembershipConfigDetail?
    if let target {
      let value = try MembershipConfigDetail.target(target)
      let (bytes, _) = try await api.raw(MembershipConfigDetail.path(target: target))
      detail = try MembershipConfigDetail(data: bytes, actor: actor, domain: value.domain, configurationID: value.id)
    }
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else {
      throw StaffAPIError.invalid
    }
    membershipConfigBoard = board; membershipConfigDetail = detail; membershipConfigUpdated = Date()
    membershipConfigState = "已读取服务器规则；草稿、审批、发布与运行开关分别核对。"
  }
  @Published var memberCardsBoard: MemberCardsBoard?
  @Published var memberCardsState = "请读取会员卡项目"
  private var memberCardsUpdated: Date?
  private var memberCardsSection = "projects"
  private var memberCardsCursor = ""
  var canUseMemberCards: Bool {
    memberReady && memberCardsBoard?.enabled == true
      && memberCardsBoard?.employeeID == identity?.employee.id
      && identity.map { memberCardSections($0).contains(memberCardsSection) } == true
      && memberCardsUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadMemberCards(section: String = "projects", cursor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    memberCardsBoard = nil; memberCardsUpdated = nil
    memberCardsState = "正在读取会员卡项目"
    do {
      _ = try MemberCardsBoard.query(section: section, cursor: cursor)
      identity = try await api.heartbeat()
      memberCardsSection = section; memberCardsCursor = cursor
      try await fetchMemberCards()
    } catch {
      memberCardsState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchMemberCards() async throws {
    guard let actor = identity, memberCardSections(actor).contains(memberCardsSection) else {
      throw CatalogError("当前岗位没有此会员卡范围的权限")
    }
    let section = memberCardsSection
    let path = memberCardsRoot + (try MemberCardsBoard.query(section: section, cursor: memberCardsCursor))
    let (data, _) = try await api.raw(path)
    let board = try MemberCardsBoard(data: data, actor: actor, section: section)
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else {
      throw StaffAPIError.invalid
    }
    memberCardsBoard = board; memberCardsUpdated = Date()
    memberCardsState = "已读取服务器会员卡记录；办理前核对原项目和会员状态。"
  }
  func readMemberCardConfig(projectID: String) async throws -> MemberCardConfig {
    guard live, !busy, !heartbeatBusy, UUID(uuidString: projectID) != nil else {
      throw CatalogError("请等待读取完成并选择原卡项目")
    }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("member.card.manage") else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(memberCardsRoot + "/projects/" + projectID + "/config")
      let config = try MemberCardConfig(data: data, actor: actor, projectID: projectID)
      guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.allows("member.card.manage") == true else { throw StaffAPIError.invalid }
      return config
    } catch {
      handleLiveError(error)
      throw error
    }
  }
  func memberCardProducts(search: String, offset: Int) async throws -> MemberCardProducts {
    guard live, !busy, !heartbeatBusy else { throw CatalogError("请等待当前读取完成") }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("member.card.manage") else { throw StaffAPIError.invalid }
      let path = memberCardsRoot + "/products" + (try MemberCardProducts.query(search: search, offset: offset))
      let (data, _) = try await api.raw(path)
      let products = try MemberCardProducts(data: data, actor: actor)
      guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.allows("member.card.manage") == true else { throw StaffAPIError.invalid }
      return products
    } catch {
      handleLiveError(error)
      throw error
    }
  }
  @Published var benefitWalletBoard: BenefitWalletBoard?
  @Published var benefitWalletState = "请查询会员权益"
  private var benefitWalletUpdated: Date?
  private var benefitWalletCode = ""
  private var benefitWalletCursor = ""
  var canUseBenefitWallet: Bool {
    memberReady && benefitWalletBoard?.enabled == true
      && benefitWalletBoard?.employeeID == identity?.employee.id
      && identity?.allows("loyalty.account.view") == true
      && benefitWalletUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadBenefitWallet(_ code: String, cursor: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    benefitWalletBoard = nil; benefitWalletUpdated = nil
    benefitWalletState = "正在查询会员权益"
    do {
      let member = try MemberCommands.code(code)
      guard cursor.isEmpty || (1...120).contains(cursor.utf16.count) else { throw StaffAPIError.invalid }
      identity = try await api.heartbeat()
      benefitWalletCode = member; benefitWalletCursor = cursor
      try await fetchBenefitWallet()
    } catch {
      benefitWalletState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchBenefitWallet() async throws {
    guard let actor = identity, actor.allows("loyalty.account.view") else {
      throw CatalogError("当前岗位没有会员权益查看权限")
    }
    guard !benefitWalletCode.isEmpty else {
      benefitWalletBoard = nil; benefitWalletUpdated = nil
      benefitWalletState = "原请求已核对，请重新查询会员权益"
      return
    }
    var body: [String: Any] = ["code": benefitWalletCode]
    if !benefitWalletCursor.isEmpty { body["cursor"] = benefitWalletCursor }
    let (data, _) = try await api.raw(benefitWalletRoot + "/lookup", body: body)
    let board = try BenefitWalletBoard(data: data, actor: actor)
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else {
      throw StaffAPIError.invalid
    }
    benefitWalletBoard = board; benefitWalletUpdated = Date()
    benefitWalletState = "已读取服务器权益；办理前请核对会员、桌次和实际份数。"
  }
  func walletProducts(search: String, offset: Int) async throws -> BenefitWalletProducts {
    guard live, !busy, !heartbeatBusy else { throw CatalogError("请等待当前读取完成") }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("benefit.issue"), actor.allows("loyalty.account.view") else {
        throw CatalogError("当前岗位没有权益发放权限")
      }
      let (data, _) = try await api.raw(benefitWalletRoot + "/products" + BenefitWalletProducts.query(search: search, offset: offset))
      let result = try BenefitWalletProducts(data: data, actor: actor)
      guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.allows("benefit.issue") == true else { throw StaffAPIError.invalid }
      return result
    } catch {
      handleLiveError(error)
      throw error
    }
  }
  @Published var ownerFinanceBoard: OwnerFinanceBoard?
  @Published var ownerFinanceState = "请读取费用与工资"
  private var ownerFinanceUpdated: Date?
  private var ownerFinanceQuery = ""
  var canUseOwnerFinance: Bool {
    memberReady && ownerFinanceBoard?.enabled == true
      && ownerFinanceBoard?.employeeID == identity?.employee.id
      && ownerFinanceUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadOwnerFinance(start: String = "", end: String = "") async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    ownerFinanceBoard = nil; ownerFinanceUpdated = nil
    ownerFinanceState = "正在读取费用与工资"
    do {
      ownerFinanceQuery = try OwnerFinanceBoard.query(start: start, end: end)
      identity = try await api.heartbeat()
      try await fetchOwnerFinance()
    } catch {
      ownerFinanceState = (error as? StaffAPIError)?.status == 404
        ? "配套后台尚未启用原生费用与工资" : error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchOwnerFinance() async throws {
    guard let actor = identity, ownerFinancePermissions.contains(where: actor.allows) else {
      throw CatalogError("当前岗位没有费用或工资权限")
    }
    let bytes = try await api.raw(ownerFinanceRoot + "/owner-finance" + ownerFinanceQuery).0
    let capability = try await api.raw(ownerFinanceRoot + "/native-capabilities").0
    let board = try OwnerFinanceBoard(data: bytes, capability: capability, actor: actor)
    guard actor.employee.id == identity?.employee.id, actor.session.id == api.identity?.session.id,
      actor.permissions == identity?.permissions, actor.deniedPermissions == identity?.deniedPermissions
    else { throw StaffAPIError.invalid }
    ownerFinanceBoard = board; ownerFinanceUpdated = Date()
    ownerFinanceState = "已读取服务器费用与工资；入账不表示银行已发薪"
  }
  func prepareOwnerFinance(operation: String, fields: [String: String],
    row: OwnerFinanceRow? = nil, line: OwnerFinanceRow? = nil,
    removeEmployeeID: String? = nil) throws -> LiveCommand {
    guard canUseOwnerFinance, let board = ownerFinanceBoard, let actor = identity else {
      throw CatalogError("资料、登录或权限已变化，请刷新费用与工资")
    }
    return try board.command(actor: actor, operation: operation, fields: fields,
      row: row, line: line, removeEmployeeID: removeEmployeeID)
  }
  @Published var productPhasesBoard: ProductPhasesBoard?
  @Published var productPhasesState = "请读取原商品演出阶段"
  private var productPhasesUpdated: Date?
  var canUseProductPhases: Bool {
    memberReady && productPhasesBoard?.enabled == true
      && productPhasesBoard?.employeeID == identity?.employee.id
      && identity?.allows("recommendation.phase.configure") == true
      && productPhasesUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadProductPhases(productID: String) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    productPhasesBoard = nil; productPhasesUpdated = nil
    productPhasesState = "正在读取原商品演出阶段"
    do { identity = try await api.heartbeat(); try await fetchProductPhases(productID: productID) }
    catch { productPhasesState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchProductPhases(productID: String) async throws {
    guard let actor = identity, actor.allows("recommendation.phase.configure"), UUID(uuidString: productID) != nil else {
      throw CatalogError("请核对商品和阶段配置权限")
    }
    let (data, _) = try await api.raw(productPhasesRoot + "/" + productID)
    let board = try ProductPhasesBoard(data: data, actor: actor, productID: productID)
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id else { throw StaffAPIError.invalid }
    productPhasesBoard = board; productPhasesUpdated = Date(); productPhasesState = "已读取服务器原版本"
  }
  @Published var productBoard: ProductManagementBoard?
  @Published var catalogConfigurationBoard: CatalogConfigurationBoard?
  @Published var productState = "请读取商品"
  private var productUpdated: Date?
  private var productQuery = ""
  private var productOffset = 0
  var canUseProducts: Bool {
    memberReady && productBoard?.durableProducts == true
      && productBoard?.currentEmployeeId == identity?.employee.id
      && identity?.allows("catalog.product.manage") == true
      && productUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadProducts(query: String = "", offset: Int = 0) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    productBoard = nil
    catalogConfigurationBoard = nil
    productUpdated = nil
    productQuery = query
    productOffset = offset
    productState = "正在读取商品"
    do {
      identity = try await api.heartbeat()
      try await fetchProducts()
    } catch {
      productState =
        (error as? StaffAPIError)?.status == 404
        ? "服务器尚未启用原生商品管理，请使用网页入口" : error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchProducts() async throws {
    guard let actor = identity, actor.allows("catalog.product.manage"),
      let encoded = productQuery.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
    else { throw StaffAPIError.invalid }
    guard productQuery.utf16.count <= 80, (0...10000).contains(productOffset) else { throw CatalogError("商品查询条件无效") }
    let (bytes, _) = try await api.raw(
      "/api/native/catalog/products?status=all&limit=40&offset=\(productOffset)&search=" + encoded)
    guard let envelope = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let data = envelope["data"] as? [String: Any] else { throw StaffAPIError.invalid }
    let board = try JSONDecoder().decode(ProductManagementBoard.self, from: catalogConfigData(data))
    let configuration = data["configurationProtocol"] == nil ? nil : try CatalogConfigurationBoard(data: bytes, actor: actor)
    guard board.durableProducts, board.currentEmployeeId == actor.employee.id,
      identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
      (1...100).contains(board.limit), (0...10000).contains(board.offset),
      Set(board.products.map(\.id)).count == board.products.count
    else { throw StaffAPIError.invalid }
    productBoard = board
    catalogConfigurationBoard = configuration
    productUpdated = Date()
    productState = "已同步商品；共显示\(board.products.count)项，按页查询全部状态。"
  }
  func queryCatalogConfigurationChoices(query: String, offset: Int) async throws -> CatalogConfigurationBoard {
    guard live, !busy, !heartbeatBusy, query.utf16.count <= 80, (0...10000).contains(offset),
      let encoded = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
      throw CatalogError("请等待当前操作完成并核对商品查询条件")
    }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.allows("catalog.product.manage") else { throw StaffAPIError.invalid }
      let (bytes, _) = try await api.raw("/api/native/catalog/products?status=all&limit=50&offset=\(offset)&search=" + encoded)
      let board = try CatalogConfigurationBoard(data: bytes, actor: actor)
      guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      return board
    } catch { handleLiveError(error); throw error }
  }
  @Published var inventoryPublishBoard: InventoryPublishBoard?
  @Published var inventoryPublishPreview: InventoryPublishPreview?
  @Published var inventoryPublishState = "请读取原采购单"
  private var inventoryPublishUpdated: Date?
  var canUseInventoryPublish: Bool {
    memberReady && inventoryPublishBoard?.employeeID == identity?.employee.id && inventoryPublishPreview?.employeeID == identity?.employee.id
      && inventoryPublishPreview?.ready == true && identity.map { inventoryPublishPermissions.allSatisfy($0.allows) } == true
      && inventoryPublishUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadInventoryPublish(receiptID: String) async {
    guard live, !busy, !heartbeatBusy, UUID(uuidString: receiptID) != nil else { return }
    busy = true; defer { busy = false }
    inventoryPublishBoard = nil; inventoryPublishPreview = nil; inventoryPublishUpdated = nil
    inventoryPublishState = "正在读取原采购单与关联商品"
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, inventoryPublishPermissions.allSatisfy(actor.allows) else { throw StaffAPIError.invalid }
      let generation = workspaceVersion
      let (data, _) = try await api.raw(inventorySetupRoot + "/receipts/" + receiptID + "/publish-options")
      let board = try InventoryPublishBoard(data: data, actor: actor, receiptID: receiptID)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      inventoryPublishBoard = board; inventoryPublishState = "请选择关联商品，读取包含全部采购行的发布预览。"
    } catch { inventoryPublishState = error.localizedDescription; handleLiveError(error) }
  }
  func loadInventoryPublishPreview(productID: String) async {
    guard live, !busy, !heartbeatBusy, let original = inventoryPublishBoard, original.products.contains(where: { $0.id == productID }) else { return }
    busy = true; defer { busy = false }
    inventoryPublishPreview = nil; inventoryPublishUpdated = nil; inventoryPublishState = "正在核对整单采购、配方、库存与售价"
    let generation = workspaceVersion
    do {
      identity = try await api.heartbeat()
      guard let actor = identity, actor.employee.id == original.employeeID, inventoryPublishPermissions.allSatisfy(actor.allows),
        inventoryPublishBoard?.receipt.data == original.receipt.data else { throw StaffAPIError.invalid }
      let (data, _) = try await api.raw(inventorySetupRoot + "/receipts/" + original.receipt.id + "/receive-and-publish-preview?productId=" + productID)
      let preview = try InventoryPublishPreview(data: data, actor: actor, board: original, productID: productID)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
      inventoryPublishPreview = preview; inventoryPublishUpdated = Date(); inventoryPublishState = "请按预览逐项验收整张采购单；只核实一个商品不足以确认整单收货。"
    } catch { inventoryPublishState = error.localizedDescription; handleLiveError(error) }
  }
  @Published var recipeConfigurationBoard: RecipeConfigurationBoard?
  @Published var recipeConfigurationState = "请读取原商品配方"
  @Published var recipeCostPreview: RecipeCostViewData?
  private var recipeConfigurationUpdated: Date?
  private var recipeConfigurationProductID = ""
  var canUseRecipeConfiguration: Bool {
    memberReady && recipeConfigurationBoard?.employeeID == identity?.employee.id && identity?.allows("inventory.manage") == true
      && recipeConfigurationBoard?.product.text("product_kind") == "single"
      && recipeConfigurationUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadRecipeConfiguration(productID: String) async {
    guard live, !busy, !heartbeatBusy, UUID(uuidString: productID) != nil else { return }
    busy = true; defer { busy = false }
    recipeConfigurationBoard = nil; recipeConfigurationUpdated = nil; recipeCostPreview = nil
    recipeConfigurationState = "正在读取原配方与成本"
    do { identity = try await api.heartbeat(); recipeConfigurationProductID = productID; try await fetchRecipeConfiguration() }
    catch { recipeConfigurationState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchRecipeConfiguration() async throws {
    guard let actor = identity, actor.allows("inventory.manage"), UUID(uuidString: recipeConfigurationProductID) != nil else { throw StaffAPIError.invalid }
    let generation = workspaceVersion, productID = recipeConfigurationProductID
    let (bytes, _) = try await api.raw(inventorySetupRoot + "/products/" + productID + "/recipe")
    let board = try RecipeConfigurationBoard(data: bytes, actor: actor, productID: productID)
    var cost: RecipeCostViewData?
    if actor.allows("inventory.cost.view"), board.recipe != nil {
      let (data, _) = try await api.raw(inventorySetupRoot + "/products/" + productID + "/recipe-cost")
      cost = try RecipeCostViewData(data: data, board: board)
    }
    guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    recipeConfigurationBoard = board; recipeCostPreview = cost; recipeConfigurationUpdated = Date()
    recipeConfigurationState = "已读取原配方；修改草稿后须核对保存。成本展示属于已保存配方。"
  }
  @Published var inventorySetupBoard: InventorySetupBoard?
  @Published var inventorySetupState = "请读取物料与包装条码"
  private var inventorySetupUpdated: Date?
  var canUseInventorySetup: Bool {
    memberReady && inventorySetupBoard?.enabled == true && inventorySetupBoard?.employeeID == identity?.employee.id
      && identity?.allows("inventory.manage") == true
      && inventorySetupUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadInventorySetup() async {
    guard live, !busy, !heartbeatBusy else { return }; busy = true
    defer { busy = false }
    inventorySetupBoard = nil; inventorySetupUpdated = nil; inventorySetupState = "正在读取物料资料"
    do { identity = try await api.heartbeat(); try await fetchInventorySetup() }
    catch { inventorySetupState = error.localizedDescription; handleLiveError(error) }
  }
  private func fetchInventorySetup() async throws {
    guard let actor = identity, actor.allows("inventory.manage") else { throw CatalogError("当前岗位没有物料管理权限") }
    let (bytes, _) = try await api.raw(inventorySetupRoot + "/setup")
    let board = try InventorySetupBoard(data: bytes, actor: actor)
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions else { throw StaffAPIError.invalid }
    inventorySetupBoard = board; inventorySetupUpdated = Date(); inventorySetupState = "已读取服务器有效物料；基础单位和扫码包装量须分别核对。"
  }
  @Published var stockCounts: StockCountPage?
  @Published var stockWaste: StockWastePage?
  @Published var stockAuditState = "请读取盘点与报损"
  @Published var stockCountDraft: [StockCountInput] = []
  private var stockAuditUpdated: Date?
  private var stockCountFilter = "submitted"
  private var stockCountPage = 0
  private var stockWastePage = 1
  private let countDraftURL = URL.documentsDirectory.appending(path: "mbox-count-drafts-v1.json")
  var canUseStockAudit: Bool {
    canUseStock && stockAuditUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  private func countBook() throws -> [String: [StockCountInput]] {
    guard FileManager.default.fileExists(atPath: countDraftURL.path) else { return [:] }
    return try JSONDecoder().decode(
      [String: [StockCountInput]].self, from: Data(contentsOf: countDraftURL))
  }
  func saveCountDraft(_ lines: [StockCountInput]) throws {
    guard canUseStock, let actor = identity, actor.allows("inventory.count") else {
      throw CatalogError("请刷新库存")
    }
    var book = try countBook()
    book[actor.employee.id] = lines
    try JSONEncoder().encode(book).write(to: countDraftURL, options: .atomic)
    stockCountDraft = lines
  }
  func loadStockAudit(filter: String = "submitted", page: Int = 0, wastePage: Int = 1) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    inventorySetupBoard = nil; inventorySetupUpdated = nil; inventorySetupState = "请读取物料与包装条码"
    stockCounts = nil
    stockWaste = nil
    stockAuditUpdated = nil
    stockCountFilter = filter
    stockCountPage = page
    stockWastePage = wastePage
    do {
      identity = try await api.heartbeat()
      try await fetchStock()
      try await fetchStockAudit()
    } catch {
      stockAuditState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchStockAudit() async throws {
    guard let actor = identity else { throw StaffAPIError.invalid }
    if actor.allows("inventory.count") || actor.allows("inventory.count.approve") {
      let page: StockCountPage = try await api.data(
        "/api/native/inventory/stock-counts?status=\(stockCountFilter)&page=\(stockCountPage)&pageSize=20"
      )
      guard page.nativeCommands, page.currentEmployeeId == actor.employee.id else {
        throw StaffAPIError.invalid
      }
      stockCounts = page
    }
    if actor.allows("inventory.waste") || actor.allows("inventory.count.approve") {
      let page: StockWastePage = try await api.data(
        "/api/native/inventory/waste-requests?page=\(stockWastePage)")
      guard page.nativeCommands, page.currentEmployeeId == actor.employee.id else {
        throw StaffAPIError.invalid
      }
      stockWaste = page
    }
    guard identity?.employee.id == actor.employee.id else { throw StaffAPIError.invalid }
    stockAuditUpdated = Date()
    stockAuditState = "已同步盘点和报损；待审申请不会提前扣库存。"
  }
  @Published var stockBoard: StockBoard?
  @Published var stockState = "请读取库存与采购单"
  @Published var stockReceiptQuery = StockReceiptQuery()
  @Published var stockDraft: [StockLine] = []
  @Published var stockSupplier = ""
  @Published var stockReceipt: StockSavedReceipt?
  private var stockEmployee: String?
  private var stockUpdated: Date?
  private let stockDraftURL = URL.documentsDirectory.appending(path: "mbox-stock-drafts-v1.json")
  private let stockReceiptURL = URL.documentsDirectory.appending(path: "mbox-stock-receipt-v1.json")
  var canUseStock: Bool {
    memberReady && stockBoard?.nativeCommands == true && stockEmployee == identity?.employee.id
      && stockUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadStock(query: StockReceiptQuery? = nil) async {
    guard live, !busy, !heartbeatBusy else { return }
    let requested = query ?? stockReceiptQuery
    busy = true
    defer { busy = false }
    stockBoard = nil
    stockUpdated = nil
    stockState = "正在读取库存与采购单"
    do {
      _ = try requested.path()
      identity = try await api.heartbeat()
      stockReceiptQuery = requested
      try await fetchStock()
    } catch {
      stockState =
        (error as? StaffAPIError)?.status == 404
        ? "当前服务器尚未启用原生库存，请继续使用网页库存入口。" : error.localizedDescription
      handleLiveError(error)
    }
  }
  private func stockBook() throws -> StockDraftBook {
    guard FileManager.default.fileExists(atPath: stockDraftURL.path) else { return StockDraftBook() }
    return try StockDraftBook.read(Data(contentsOf: stockDraftURL))
  }
  func saveStockDraft(_ lines: [StockLine], supplier: String? = nil) throws {
    guard canUseStock, let actor = identity, actor.allows("inventory.receive") else {
      throw CatalogError("请刷新库存并核对员工权限")
    }
    var book = try stockBook()
    book[actor.employee.id] = lines
    book.suppliersByEmployee[actor.employee.id] = try stockSupplierName(supplier ?? stockSupplier)
    try JSONEncoder().encode(book).write(to: stockDraftURL, options: .atomic)
    stockDraft = lines
    stockSupplier = book.suppliersByEmployee[actor.employee.id] ?? ""
  }
  private func fetchStock() async throws {
    guard let actor = identity, StockBoard.permissions.contains(where: actor.allows) else {
      throw CatalogError("当前岗位没有库存权限")
    }
    let requested = stockReceiptQuery
    let board: StockBoard = try await api.data(requested.path())
    guard identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
      board.currentEmployeeId == actor.employee.id, board.nativeCommands,
      board.receiptsPage == nil ? requested.page == 0 : board.receiptsPage?.page == requested.page,
      (!board.visibility.costs || actor.allows("inventory.cost.view")),
      Set(board.items.map(\.id)).count == board.items.count
    else { throw StaffAPIError.invalid }
    let book = try stockBook()
    let draft = book[actor.employee.id] ?? []
    stockBoard = board
    stockEmployee = actor.employee.id
    stockDraft = draft
    stockSupplier = book.suppliersByEmployee[actor.employee.id] ?? ""
    stockCountDraft = try countBook()[actor.employee.id] ?? []
    stockUpdated = Date()
    if let data = try? Data(contentsOf: stockReceiptURL),
      let receipt = try? JSONDecoder().decode(StockSavedReceipt.self, from: data),
      receipt.employeeID == actor.employee.id
    {
      stockReceipt = receipt
    }
    stockState = "库存已同步；低库存提示需结合实物核对。"
  }
  func lookupStockCode(_ code: String) async throws -> StockScan {
    guard canUseStock, let actor = identity, actor.allows("inventory.receive"),
      (1...128).contains(code.utf16.count),
      let encoded = code.addingPercentEncoding(
        withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+#?=%")))
    else { throw CatalogError("请刷新库存并输入有效条码") }
    let scan: StockScan = try await api.data("/api/native/inventory/scan?code=" + encoded)
    guard identity?.employee.id == actor.employee.id, scan.currentEmployeeId == actor.employee.id,
      scan.code == code,
      stockBoard?.items.contains(where: { $0.id == scan.inventoryItemId }) == true
    else { throw StaffAPIError.invalid }
    return scan
  }
  @Published var serviceAttention = ServiceAttention()
  @Published var serviceBoard: LiveServiceBoard?
  @Published var serviceState = ""
  var serviceUpdated: Date?
  var canUseService: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && serviceBoard?.durableTasks == true
      && serviceBoard?.currentEmployeeId == identity?.employee.id
      && identity?.allows("service.execute") == true
      && serviceUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var observationBoard: ObservationBoard?
  @Published var recommendationBoard: RecommendationBoard?
  @Published var observationState = ""
  var observationEmployee: String?
  var observationUpdated: Date?
  var canUseObservation: Bool {
    memberReady && observationEmployee == identity?.employee.id
      && observationUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  @Published var benefitBoard: BenefitFulfillmentBoard?
  @Published var benefitState = "请读取权益兑付队列"
  private var benefitUpdated: Date?
  private var benefitEmployee: String?
  var canUseBenefits: Bool {
    memberReady && benefitEmployee == identity?.employee.id
      && identity?.allows("loyalty.redemption.fulfill") == true
      && benefitBoard?.durable == true
      && Date().timeIntervalSince(benefitUpdated ?? .distantPast) < 60
  }
  @Published var memberAccount: MemberAccount?
  @Published var memberParticipation: MemberParticipation?
  @Published var memberVisit: MemberVisitStatus?
  @Published var memberRewards: MemberRewardBoard?
  @Published var memberState = ""
  @Published var memberRewardState = ""
  var memberEmployee: String?, memberRewardEmployee: String?
  var memberUpdated: Date?, memberRewardUpdated: Date?
  var memberRewardFilter = "pending"
  private var memberReady: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  var canUseMember: Bool {
    memberReady && memberEmployee == identity?.employee.id
      && memberVisit?.durableNativeVisits == true
      && identity?.allows("loyalty.account.view") == true
      && identity?.allows("customer.relationship.manage") == true
      && memberUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  var canUseMemberRewards: Bool {
    memberReady && memberRewardEmployee == identity?.employee.id
      && memberRewards?.durableNativeDecisions == true
      && identity?.allows("loyalty.configuration.approve") == true
      && memberRewardUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  private var reservationReceptionActor: StaffIdentity?
  private var reservationReceptionCapabilities: ReservationCapabilities?
  private var reservationAdmissionOptions: ReservationAdmissionOptions?
  private var reservationReceptionSelection: ReservationReceptionSelection?
  private func clearReservationReceptionReadiness() {
    reservationReceptionActor = nil
    reservationReceptionCapabilities = nil
    reservationAdmissionOptions = nil
    reservationReceptionSelection = nil
  }
  func readReservationAdmission(arrivalAt: String, expectedEndAt: String) async throws -> ReservationAdmissionOptions {
    let (data, actor, capabilities) = try await readReservationReception(path: ReservationAdmissionOptions.path(arrivalAt: arrivalAt, expectedEndAt: expectedEndAt), write: true)
    let options = try ReservationAdmissionOptions(data: data, actor: actor, arrivalAt: arrivalAt, expectedEndAt: expectedEndAt)
    reservationReceptionActor = actor
    reservationReceptionCapabilities = capabilities
    reservationAdmissionOptions = options
    return options
  }
  func readReservationReceptionSessions(id: String) async throws -> ReservationReceptionSelection {
    let (data, actor, capabilities) = try await readReservationReception(path: ReservationReceptionSelection.path(id: id), write: true, seat: true)
    let selection = try ReservationReceptionSelection(data: data, actor: actor, id: id)
    reservationReceptionActor = actor
    reservationReceptionCapabilities = capabilities
    reservationReceptionSelection = selection
    return selection
  }
  func readReservationReceptionDetail(id: String) async throws -> ReservationReceptionDetail {
    let (data, actor, _) = try await readReservationReception(path: ReservationReceptionDetail.path(id: id))
    return try ReservationReceptionDetail(data: data, actor: actor, id: id)
  }
  private func readReservationReception(path: String, write: Bool = false, seat: Bool = false) async throws -> (Data, StaffIdentity, ReservationCapabilities?) {
    guard live, !busy, !heartbeatBusy, let previous = identity else { throw StaffAPIError.invalid }
    clearReservationReceptionReadiness()
    busy = true; defer { busy = false }
    let generation = workspaceVersion
    do {
      let actor = try await api.heartbeat()
      guard generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id, actor.employee.id == previous.employee.id,
        actor.session.id == previous.session.id else { throw StaffAPIError.invalid }
      identity = actor
      guard actor.canOpen(.reservations), !write || actor.allows("reservation.manage"),
        !seat || actor.allows("table.open") else { throw CatalogError("当前岗位没有此项预约接待权限") }
      var capabilities: ReservationCapabilities?
      if write {
        capabilities = try await api.data("/api/staff/native-reservation-capabilities")
        guard seat ? capabilities?.receptionSeatV1 == true : capabilities?.admissionCreateV1 == true else {
          throw CatalogError("当前服务器尚未启用此项预约接待操作")
        }
      }
      let (data, _) = try await api.raw(path)
      guard generation == workspaceVersion, identity?.employee.id == actor.employee.id, identity?.session.id == actor.session.id,
        identity?.permissions == actor.permissions, identity?.deniedPermissions == actor.deniedPermissions,
        identity?.navigation == actor.navigation else { throw StaffAPIError.invalid }
      return (data, actor, capabilities)
    } catch {
      if generation == workspaceVersion, identity?.employee.id == previous.employee.id,
        identity?.session.id == previous.session.id { handleLiveError(error) }
      throw error
    }
  }
  private func canExecuteReservationReception(_ command: LiveCommand) -> Bool {
    guard memberReady, let actor = identity, actor.canOpen(.reservations), let readActor = reservationReceptionActor,
      actor.employee.id == readActor.employee.id, actor.session.id == readActor.session.id,
      actor.permissions == readActor.permissions, actor.deniedPermissions == readActor.deniedPermissions,
      actor.navigation == readActor.navigation,
      validReservationReceptionCommand(command: command, actor: actor, capabilities: reservationReceptionCapabilities),
      let step = command.steps.first, let proof = step.reservationReceptionProof,
      let body = try? JSONSerialization.jsonObject(with: step.body) as? [String: Any] else { return false }
    if proof["operation"] as? String == "create" {
      guard let options = reservationAdmissionOptions, (0...30).contains(Date().timeIntervalSince(options.loadedAt)),
        body["reservationPolicyVersion"] as? Int == options.policyVersion,
        let arrivalAt = body["arrivalAt"] as? String, let endAt = body["expectedEndAt"] as? String,
        receptionDate(arrivalAt) == receptionDate(options.arrivalAt), receptionDate(endAt) == receptionDate(options.expectedEndAt),
        let arrival = receptionDate(arrivalAt), arrival > Date(),
        let guests = body["guestCount"] as? Int, guests <= options.remainingGuests else { return false }
      return true
    }
    guard let selection = reservationReceptionSelection, (0...30).contains(Date().timeIntervalSince(selection.loadedAt)),
      selection.reservationStatus == "arrived", proof["target"] as? String == selection.reservationId,
      proof["reservationGuestCount"] as? Int == selection.reservationGuestCount,
      body["reservationVersion"] as? Int == selection.reservationVersion,
      let rows = body["sessions"] as? [[String: Any]] else { return false }
    return rows.allSatisfy { row in
      guard let selected = selection.sessions.first(where: { $0.id == row["tableSessionId"] as? String }) else { return false }
      return NSDictionary(dictionary: row).isEqual(to: selected.request)
    }
  }
  @Published var reservations: [LiveReservation] = []
  @Published var reservationIntake: [LiveReservationIntake] = []
  @Published var reservationState = ""
  @Published var reservationTables: [ReservationTable] = []
  @Published var reservationCapabilities: ReservationCapabilities?
  var reservationQuery = ReservationQuery(
    range: "current", from: ReservationQuery.day(Date()), to: ReservationQuery.day(Date()))
  var reservationUpdated: Date?
  var reservationEmployee: String?
  var canUseReservations: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && identity?.allows("reservation.manage") == true
      && reservationEmployee == identity?.employee.id
      && reservationCapabilities?.durableTransitions == true
      && reservationUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var participants: [LiveParticipant] = []
  @Published var participantState = ""
  @Published var participantInput: ParticipantInput?
  @Published var participantPreview: ParticipantPreview?
  var participantUpdated: Date?
  var participantPrepared: LiveCommand?
  var canUseParticipants: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil
      && identity?.allows(ParticipantInput.permission) == true
      && participantInput?.employeeID == identity?.employee.id
      && participantUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var assignmentsBoard: LiveAssignments?
  @Published private(set) var assignmentScheduleMode = "future"
  @Published private(set) var assignmentSchedulePage = 0
  @Published var assignmentsUpdated: Date?
  @Published var assignmentsState = ""
  @Published var assignmentReceipt = ""
  var assignmentsActorID: String?
  @Published var cashHandover: CashHandoverBoard?
  @Published var cashHandoverState = ""
  private var cashHandoverUpdated: Date?
  private var cashHandoverActor: String?
  var canUseCashHandover: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && cashHandoverActor == identity?.employee.id
      && cashHandoverUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && cashHandover?.canCount == true && identity?.allows("reconciliation.view") == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var voucherHistory: [VoucherHistoryRow] = []
  @Published var voucherHistoryState = ""
  @Published var voucherPlatforms: [VoucherPlatform] = []
  @Published var voucherOperations: [VoucherOperation] = []
  @Published var voucherPreview: VoucherPreview?
  @Published var voucherState = ""
  @Published var voucherUpdated: Date?
  @Published var voucherActor: String?
  private var voucherCode = ""
  var canReadVouchers: Bool { identity?.allows("commercial.voucher.view") == true }
  var canUseVouchers: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && voucherActor == identity?.employee.id
      && voucherUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity?.allows("commercial.voucher.redeem") == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var printJobs: [LivePrintJob] = []
  @Published var printSources: [LivePrintSource] = []
  @Published var ownPrintJobs: [LivePrintJob] = []
  @Published var printState = ""
  @Published var printUpdated: Date?
  @Published var printActor: String?
  @Published var printReceipt: NativePrintReceipt?
  private let printReceiptURL = URL.documentsDirectory.appending(path: "mbox-print-receipt-v1.json")
  var canReadPrinting: Bool {
    [
      "order.bill.print", "print.view", "print.view_all", "print.reprint", "hardware.manage",
      "printer.manage",
    ].contains { identity?.allows($0) == true }
  }
  var canUsePrinting: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && printActor == identity?.employee.id
      && printUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var fulfillmentBoard: LiveFulfillment?
  @Published var fulfillmentUpdated: Date?
  @Published var fulfillmentState = ""
  var canReadFulfillment: Bool {
    identity.map { actor in
      ["order.view", "kds.prepare", "kds.deliver", "kds.exception.manage", "fulfillment.view_all"]
        .contains(where: actor.allows)
    } ?? false
  }
  var canUseFulfillment: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil
      && fulfillmentBoard?.actor.employeeId == identity?.employee.id && identity != nil
      && fulfillmentBoard?.actor.actionSessionValid == true
      && fulfillmentBoard?.actor.supportsNativePhysicalRecovery == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
      && fulfillmentUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  @Published var afterSales: LiveAfterSales?
  @Published var afterSalesUpdated: Date?
  @Published var afterSalesActor: String?
  @Published var afterSalesState = ""
  @Published var afterSalesPendingRows: [AfterSalesPending.Row] = []
  @Published var afterSalesCursor: AfterSalesPending.Cursor?
  var canReadAfterSales: Bool {
    ["refund.request", "refund.approve", "refund.execute"].contains { identity?.allows($0) == true }
  }
  var canUseAfterSales: Bool {
    live && canReadAfterSales && !busy && !heartbeatBusy && !liveStorageDamaged
      && livePending == nil && liveOrderPending == nil && afterSales != nil
      && afterSalesActor == identity?.employee.id
      && afterSalesUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  @Published var financeSummary: LiveHistory?
  @Published var financeEntries: [FinanceEntry] = []
  @Published var financeReviews: [FinanceReview] = []
  @Published var financeNext: String?
  @Published var financeMoreReviews = false
  @Published var financeReviewPage = 0
  @Published var financeUpdated: Date?
  @Published var financeState = ""
  @Published var financeQuery = FinanceQuery()
  @Published var financeReceipt: FinanceReceipt?
  var financeActorID: String?
  private let financeReceiptURL = URL.documentsDirectory.appending(
    path: "mbox-finance-receipt-v1.json")
  @Published var cashier: LiveCashier?
  @Published var cashierUpdated: Date?
  @Published var cashierState = ""
  @Published var cashierQuery = ""
  @Published var history: LiveHistory?
  @Published var historyState = ""
  @Published var historyQuery = HistoryQuery()
  @Published var kitchenBoard: LiveKitchen?
  @Published var kitchenUpdated: Date?
  @Published var kitchenState = ""
  @Published var onlineAccess: OnlineAccess?
  @Published var onlineReceipts: [String: OnlineReceipt] = [:]
  @Published var onlineStatuses: [String: String] = [:]
  @Published var onlineState = ""
  private var onlinePolling = false
  private let onlineReceiptURL = URL.documentsDirectory.appending(
    path: "mbox-online-receipts-v1.json")
  @Published var paymentOrders: [LivePaymentOrder] = []
  @Published var paymentState = ""
  @Published var paymentSession: String?
  @Published var paymentUpdated: Date?
  @Published var liveProducts: [LiveProduct] = []
  @Published var catalogState = ""
  @Published var catalogUpdated: Date?
  @Published private var liveDraftBook = LiveDraftBook()
  @Published var draftStorageDamaged = false
  private let liveDraftURL = URL.documentsDirectory.appending(path: "mbox-live-drafts-v1.json")
  private let livePendingURL: URL
  @Published private(set) var heartbeatBusy = false
  private let deviceKey: String = {
    if let saved = UserDefaults.standard.string(forKey: "native-device-key") { return saved }
    let key = "ios-" + UUID().uuidString
    UserDefaults.standard.set(key, forKey: "native-device-key")
    return key
  }()
  init(api: StaffAPI? = nil, loadPersistedState: Bool = true,
    trainingAllowed: Bool = NativeBuildPolicy.allowsTraining, livePendingURL: URL? = nil,
    nativeManagementPersistence: NativeManagementPersistence = .device,
    reservationReceptionPersistence: ReservationReceptionPersistence = .device,
    nativeCleanupPersistence: NativeCommandCleanupPersistence = .device) {
    self.api = api ?? StaffAPI(store: KeychainStaffSessionStore())
    self.trainingAllowed = trainingAllowed
    self.nativeCleanupPersistence = nativeCleanupPersistence
    self.reservationReceptionPersistence = reservationReceptionPersistence
    self.nativeManagementPersistence = nativeManagementPersistence
    self.livePendingURL = livePendingURL ?? URL.documentsDirectory.appending(path: "mbox-live-pending-v1.json")
    if !trainingAllowed {
      world = World(tables: [], products: [])
      live = true
      connection = "请验证设备并登录"
      staffName = "未登录"
    }
    guard loadPersistedState else { return }
    printReceipt = try? JSONDecoder().decode(
      NativePrintReceipt.self, from: Data(contentsOf: printReceiptURL))
    financeReceipt = try? JSONDecoder().decode(
      FinanceReceipt.self, from: Data(contentsOf: financeReceiptURL))
    onlineReceipts =
      (try? JSONDecoder().decode(
        [String: OnlineReceipt].self, from: Data(contentsOf: onlineReceiptURL))) ?? [:]
    readLivePending()
    if FileManager.default.fileExists(atPath: orderPendingURL.path) {
      do {
        let saved = try JSONDecoder().decode(
          LiveOrderSubmission.self, from: Data(contentsOf: orderPendingURL))
        try saved.validate()
        liveOrderPending = saved
      } catch {
        liveStorageDamaged = true
        message = "待确认订单记录无法读取，真实操作已锁定"
      }
    }
    if FileManager.default.fileExists(atPath: liveDraftURL.path) {
      do {
        liveDraftBook = try JSONDecoder().decode(
          LiveDraftBook.self, from: Data(contentsOf: liveDraftURL))
      } catch { draftStorageDamaged = true }
    }
    guard trainingAllowed else { return }
    if let data = try? Data(contentsOf: stateURL),
      let saved = try? JSONDecoder().decode(World.self, from: data)
    {
      world = saved
    }
    if let data = try? Data(contentsOf: pendingURL) {
      pending = try? JSONDecoder().decode(Command.self, from: data)
    }
  }
  func readLivePending() {
    do {
      if FileManager.default.fileExists(atPath: livePendingURL.path) {
        livePending = try JSONDecoder().decode(LiveCommand.self, from: Data(contentsOf: livePendingURL))
        if let saved = livePending,
          saved.steps.isEmpty || !(0...saved.steps.count).contains(saved.completedSteps) { throw StaffAPIError.invalid }
      }
    } catch {
      message = "未决操作记录无法读取，真实写操作已锁定，请联系管理员"
      durableRecordDamaged = true
      return
    }
    retryLocalCommandCleanup()
  }
  func retryLocalCommandCleanup() {
    guard !busy, !heartbeatBusy, !durableRecordDamaged else { return }
    do {
      if let command = livePending { _ = try finishAcknowledgedReservationReception(command) }
      try removeOrphanedReservationReceptionCleanupTickets(pending: livePending, persistence: reservationReceptionPersistence)
      let cleaned = try resumeNativeCommandCleanups(pending: livePending, persistence: nativeCleanupPersistence,
        removePending: { _ in
          if FileManager.default.fileExists(atPath: self.livePendingURL.path) { try FileManager.default.removeItem(at: self.livePendingURL) }
        })
      if let pending = livePending, cleaned.contains(pending.id) { livePending = nil; resetDailyBusinessViews() }
      let wasBlocked = localCleanupBlocked
      localCleanupBlocked = false
      if wasBlocked { message = "本机安全记录已重新核对；原业务仍须以已保存回执及当前服务器状态为准。" }
    } catch {
      localCleanupBlocked = true
      message = "本机私密记录尚未完成清理，请解锁设备后继续本机清理；不会重发业务。"
    }
  }
  @Published var localCleanupBlocked = false
  @Published private var durableRecordDamaged = false
  var liveStorageDamaged: Bool {
    get { durableRecordDamaged || localCleanupBlocked }
    set { durableRecordDamaged = newValue }
  }
  func persist() throws { try JSONEncoder().encode(world).write(to: stateURL, options: .atomic) }
  func draft(_ session: String) -> [Line] { world.drafts[session] ?? [] }
  func change(_ product: Product, variant: String, session: String, delta: Int) {
    guard !live, !busy, pending == nil else {
      message = "请先确认原操作结果"
      return
    }
    var lines = draft(session)
    if let i = lines.firstIndex(where: { $0.productID == product.id && $0.variant == variant }) {
      lines[i].quantity = min(99, lines[i].quantity + delta)
      if lines[i].quantity <= 0 { lines.remove(at: i) }
    } else if delta > 0 {
      lines.append(
        Line(
          productID: product.id, name: product.name, price: product.price, quantity: 1,
          variant: variant))
    }
    let previous = world
    world.drafts[session] = lines
    do { try persist() } catch {
      world = previous
      message = "草稿保存失败，请检查设备空间"
    }
  }
  func execute(_ command: Command) {
    guard !live, !busy, pending == nil else {
      message = "请先确认原操作结果"
      return
    }
    busy = true
    Task {
      defer { busy = false }
      do {
        try JSONEncoder().encode(command).write(to: pendingURL, options: .atomic)
        pending = command
        try await Task.sleep(for: .milliseconds(350))
        let previous = world
        let receipt = try world.apply(command)
        do { try persist() } catch {
          world = previous
          throw error
        }
        if simulateTimeout {
          simulateTimeout = false
          message = "演练：回执中断。原请求已保留，请点击核对结果。"
          return
        }
        try finish(receipt)
      } catch {
        if error is RuleError {
          pending = nil
          try? FileManager.default.removeItem(at: pendingURL)
        }
        message = error.localizedDescription
      }
    }
  }
  func recover() {
    guard let command = pending, !busy, !live else { return }
    busy = true
    defer { busy = false }
    do {
      let previous = world
      let receipt = try world.apply(command)
      do { try persist() } catch {
        world = previous
        throw error
      }
      try finish(receipt)
    } catch { message = error.localizedDescription }
  }
  private func finish(_ receipt: Receipt) throws {
    try FileManager.default.removeItem(at: pendingURL)
    pending = nil
    message =
      receipt.kind == "cash"
      ? "演练收款已记录 \(money(receipt.applied)) · 找零 \(money(receipt.change))" : "操作已保存"
  }
  func reset() {
    guard !live, !busy, pending == nil else { return }
    let previous = world
    world = .training()
    do {
      try persist()
      message = "演练数据已重置"
    } catch {
      world = previous
      message = "保存失败"
    }
  }
  func train() {
    guard trainingAllowed, !busy, !heartbeatBusy, identity == nil, livePending == nil && liveOrderPending == nil,
      !liveStorageDamaged
    else {
      return
    }
    live = false
    api.clearIdentity()
    identity = nil
    cashHandover = nil
    cashHandoverUpdated = nil
    cashHandoverActor = nil
    voucherHistory = []
    voucherOperations = []
    voucherPreview = nil
    voucherCode = ""
    voucherActor = nil
    voucherUpdated = nil
    printJobs = []
    printSources = []
    ownPrintJobs = []
    printActor = nil
    printUpdated = nil
    afterSales = nil
    afterSalesUpdated = nil
    afterSalesActor = nil
    afterSalesPendingRows = []
    liveOperations = nil
    lastUpdated = nil
    connection = "本机演练"
    resetDailyBusinessViews()
    workspaceVersion += 1
    staffName = "本机演练"
    if let data = try? Data(contentsOf: stateURL),
      let saved = try? JSONDecoder().decode(World.self, from: data)
    {
      world = saved
    } else {
      world = .training()
    }
  }
  func requestCamera() {
    Task {
      let granted = await AVCaptureDevice.requestAccess(for: .video)
      message = granted ? "相机权限已开启；在桌台页扫码可定位已授权桌台，付款、库存和会员请使用各自入口。" : "相机未授权，可手动输入桌号；也可前往系统设置开启。"
    }
  }
  func requestVoice() {
    SFSpeechRecognizer.requestAuthorization { status in
      Task { @MainActor in
        guard status == .authorized else {
          self.message = "语音识别未授权，可使用键盘输入"
          return
        }
        let granted = await AVAudioApplication.requestRecordPermission()
        self.message = granted ? "麦克风与语音识别权限已开启；在本桌现场观察中点击语音输入，核对文字后再提交。" : "麦克风未授权，可使用键盘输入"
      }
    }
  }
  func grantDevice(_ credential: String) async {
    guard !busy, identity == nil else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try await api.grant(credential: credential, deviceKey: deviceKey)
      deviceReady = true
      message = "设备验证成功，请登录员工账号"
    } catch { message = error.localizedDescription }
  }
  func setRememberLogin(_ enabled: Bool) {
    guard !busy, !heartbeatBusy else { return }
    do {
      try api.configureRememberSession(enabled)
      rememberLogin = enabled
      savedLoginAvailable = api.savedSessionAvailable()
      if !api.persistenceNotice.isEmpty { message = api.persistenceNotice }
    } catch { message = error.localizedDescription }
  }
  func restoreRememberedSession(retry: Bool = false) async {
    guard !restoreAttempted || retry, identity == nil, !busy, !heartbeatBusy else {
      return
    }
    restoreAttempted = true
    busy = true
    defer { busy = false }
    do {
      guard let auth = try await api.restoreSession() else {
        savedLoginAvailable = false
        if retry { message = "本机没有保存的登录，请使用员工账号登录" }
        return
      }
      guard
        (livePending == nil || livePending?.employeeID == auth.employee.id)
          && (liveOrderPending == nil || liveOrderPending?.employeeID == auth.employee.id)
      else {
        api.clearIdentity()
        throw CatalogError("有原员工的未决请求，请由该员工重新登录后恢复")
      }
      identity = auth
      rememberLogin = true
      savedLoginAvailable = api.savedSessionAvailable()
      staffName = auth.employee.displayName
      deviceReady = true
      live = true
      resetDailyBusinessViews()
      workspaceVersion += 1
      world = World(tables: [], products: [])
      lastUpdated = nil
      connection = "正在恢复门店数据"
      try await loadOperations()
      if !api.persistenceNotice.isEmpty { message = api.persistenceNotice }
    } catch {
      savedLoginAvailable = api.savedSessionAvailable()
      message = error.localizedDescription
      if identity != nil { handleLiveError(error) }
    }
  }
  var willEndStaffSession: (() -> Void)?
  func login(code: String, pin: String) async {
    guard !busy, !heartbeatBusy,
      identity == nil || (livePending == nil && liveOrderPending == nil)
    else {
      return
    }
    busy = true
    defer { busy = false }
    do {
      if identity != nil { willEndStaffSession?() }
      api.rememberSession = rememberLogin
      let auth = try await api.login(code: code, pin: pin, switching: identity != nil)
      guard (livePending == nil || livePending?.employeeID == auth.employee.id),
        (liveOrderPending == nil || liveOrderPending?.employeeID == auth.employee.id) else {
        api.clearIdentity()
        throw CatalogError("有原员工的未决请求，请由该员工重新登录后恢复")
      }
      savedLoginAvailable = api.savedSessionAvailable()
      if !api.persistenceNotice.isEmpty { message = api.persistenceNotice }
      identity = auth
      staffName = auth.employee.displayName
      live = true
      resetDailyBusinessViews()
      workspaceVersion += 1
      world = World(tables: [], products: [])
      liveOperations = nil
      history = nil
      historyQuery = HistoryQuery()
      cashierQuery = ""
      financeSummary = nil
      financeEntries = []
      financeReviews = []
      financeUpdated = nil
      financeActorID = nil
      assignmentsBoard = nil
      assignmentsUpdated = nil
      assignmentsActorID = nil
      assignmentReceipt = ""
      cashier = nil
      cashierUpdated = nil
      pickupBoard = nil
      pickupUpdated = nil
      kitchenBoard = nil
      fulfillmentBoard = nil
      fulfillmentUpdated = nil
      kitchenUpdated = nil
      paymentOrders = []
      cashHandover = nil
      cashHandoverUpdated = nil
      cashHandoverActor = nil
      voucherHistory = []
      voucherOperations = []
      voucherPreview = nil
      voucherCode = ""
      voucherActor = nil
      voucherUpdated = nil
      printJobs = []
      printSources = []
      ownPrintJobs = []
      printActor = nil
      printUpdated = nil
      afterSales = nil
      afterSalesUpdated = nil
      afterSalesActor = nil
      afterSalesPendingRows = []
      onlineAccess = nil
      onlineStatuses = [:]
      onlineState = ""
      paymentSession = nil
      paymentUpdated = nil
      lastOrderReceipt = nil
      liveOrders = []
      liveProducts = []
      catalogUpdated = nil
      lastUpdated = nil
      connection = "正在读取"
      do { try await loadOperations() } catch { handleLiveError(error) }
    } catch {
      if api.identity == nil && live { lockLiveSession() }
      message = error.localizedDescription
    }
  }
  func logout() async {
    guard !busy, !heartbeatBusy, identity != nil, livePending == nil && liveOrderPending == nil
    else { return }
    busy = true
    defer { busy = false }
    willEndStaffSession?()
    do {
      try await api.logout()
      lockLiveSession()
      savedLoginAvailable = api.savedSessionAvailable()
      message = "已退出员工账号"
        + (api.persistenceNotice.isEmpty ? "" : "；" + api.persistenceNotice)
    } catch {
      lockLiveSession()
      savedLoginAvailable = api.savedSessionAvailable()
      if !api.persistenceNotice.isEmpty {
        message = "已锁定本机账号；" + api.persistenceNotice + "。服务器退出结果未确认。"
      } else if (error as? StaffAPIError)?.loginRequired == true {
        message = "登录已失效，已退出本机账号"
      } else {
        message = "已退出本机账号；服务器退出结果未确认，请勿将此提示当作服务端已注销。"
      }
    }
  }
  func lockLiveSession() {
    willEndStaffSession?()
    api.clearIdentity()
    identity = nil
    cashHandover = nil
    cashHandoverUpdated = nil
    cashHandoverActor = nil
    voucherHistory = []
    voucherOperations = []
    voucherPreview = nil
    voucherCode = ""
    voucherActor = nil
    voucherUpdated = nil
    printJobs = []
    printSources = []
    ownPrintJobs = []
    printActor = nil
    printUpdated = nil
    afterSales = nil
    afterSalesUpdated = nil
    afterSalesActor = nil
    afterSalesPendingRows = []
    liveOperations = nil
    history = nil
    historyQuery = HistoryQuery()
    cashierQuery = ""
    financeSummary = nil
    financeEntries = []
    financeReviews = []
    financeUpdated = nil
    financeActorID = nil
    assignmentsBoard = nil
    assignmentsUpdated = nil
    assignmentsActorID = nil
    assignmentReceipt = ""
    cashier = nil
    cashierUpdated = nil
    pickupBoard = nil
    pickupUpdated = nil
    kitchenBoard = nil
    fulfillmentBoard = nil
    fulfillmentUpdated = nil
    kitchenUpdated = nil
    paymentOrders = []
    onlineAccess = nil
    onlineStatuses = [:]
    onlineState = ""
    paymentSession = nil
    paymentUpdated = nil
    lastOrderReceipt = nil
    liveOrders = []
    liveProducts = []
    catalogUpdated = nil
    world = World(tables: [], products: [])
    lastUpdated = nil
    connection = "请重新登录"
    staffName = "未登录"
    resetDailyBusinessViews()
    workspaceVersion += 1
  }
  func revalidateNativePushSession() async throws -> StaffIdentity {
    guard !busy, !heartbeatBusy, live, let actor = identity else {
      throw CatalogError("请完成当前操作并登录，再打开服务提醒")
    }
    heartbeatBusy = true
    defer { heartbeatBusy = false }
    do {
      let refreshed = try await api.heartbeat()
      guard refreshed.employee.id == actor.employee.id,
        refreshed.session.id == actor.session.id,
        identity?.session.id == actor.session.id
      else { throw StaffAPIError.invalid }
      identity = refreshed
      return refreshed
    } catch {
      handleLiveError(error)
      throw error
    }
  }
  func handleLiveError(_ error: Error) {
    if let apiError = error as? StaffAPIError,
      apiError.loginRequired || (apiError.status == 403 && api.identity == nil)
    {
      lockLiveSession()
      deviceReady = false
    } else {
      connection = "更新失败 · 数据可能过期"
      if (error as? StaffAPIError)?.status == 403 {
        resetDailyBusinessViews()
        history = nil
        historyQuery = HistoryQuery()
        cashierQuery = ""
        financeSummary = nil
        financeEntries = []
        financeReviews = []
        financeUpdated = nil
        financeActorID = nil
        assignmentsBoard = nil
        assignmentsUpdated = nil
        assignmentsActorID = nil
        assignmentReceipt = ""
        cashier = nil
        cashierUpdated = nil
        pickupBoard = nil
        pickupUpdated = nil
        kitchenBoard = nil
        fulfillmentBoard = nil
        fulfillmentUpdated = nil
        kitchenUpdated = nil
        liveProducts = []
        catalogUpdated = nil
        liveOperations = nil
        world = World(tables: [], products: [])
        lastUpdated = nil
      }
    }
    message = error.localizedDescription
  }
  func loadOperations() async throws {
    guard let identity else { return }
    let generation = workspaceVersion
    if !identity.allows("order.create") {
      liveProducts = []
      catalogUpdated = nil
    }
    if !identity.canReadTables {
      serviceAttention = ServiceAttention()
      liveOperations = nil
      world = World(tables: [], products: [])
      connection = "岗位工作台已就绪"
      return
    }
    let result: LiveOperations = try await api.data("/api/operations")
    guard result.actor.id == identity.employee.id, generation == workspaceVersion,
      self.identity?.employee.id == identity.employee.id, self.identity?.session.id == identity.session.id,
      self.identity?.permissions == identity.permissions, self.identity?.deniedPermissions == identity.deniedPermissions,
      self.identity?.navigation == identity.navigation else {
      throw StaffAPIError(status: 409, code: "CLIENT_SESSION_CHANGED", message: "工作区已变化，请重新读取当前员工的数据")
    }
    serviceAttention.refresh(
      actor: identity.employee.id, permitted: identity.allows("service.execute"),
      entries: result.tasks.filter {
        ["pending", "acknowledged", "in_progress"].contains($0.status)
      }.map {
        .init(id: $0.id, session: $0.tableSessionId, table: $0.tableCode, priority: $0.priority)
      }, at: Date())
    liveOperations = result
    world = World(tables: result.displayTables(), products: [])
    lastUpdated = Date()
    connection = "已同步"
  }
  func refresh() async {
    guard live, identity != nil, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await loadOperations()
    } catch { handleLiveError(error) }
  }
  func heartbeat() async {
    guard live, identity != nil, !busy, !heartbeatBusy else { return }
    heartbeatBusy = true
    defer { heartbeatBusy = false }
    do {
      identity = try await api.heartbeat()
      try await loadOperations()
    } catch {
      if (error as? StaffAPIError)?.loginRequired == true
        || (error as? StaffAPIError)?.status == 403
      {
        handleLiveError(error)
      } else {
        connection = "连接中断 · 数据可能过期"
      }
    }
  }
  func canAct(_ permission: String) -> Bool {
    if ["reconciliation.manage", "business_day.close"].contains(permission) {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil,
        let identity, identity.allows(permission),
        let lease = StaffIdentity.date(identity.session.onlineLeaseUntil), lease > Date(),
        financeActorID == identity.employee.id, let updated = financeUpdated,
        (0..<60).contains(Date().timeIntervalSince(updated))
      else { return false }
      return permission == "business_day.close" || identity.allows("reconciliation.view")
    }
    if permission == "payment.initiate.staff" {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil,
        let identity, identity.allows(permission),
        let lease = StaffIdentity.date(identity.session.onlineLeaseUntil), lease > Date(),
        onlineAccess?.employeeId == identity.employee.id, let updated = paymentUpdated,
        (0..<60).contains(Date().timeIntervalSince(updated)), paymentSession != nil
      else { return false }
      return true
    }
    if permission == LiveAssignments.permission {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil, let identity, identity.allows(permission),
        let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
        let updated = assignmentsUpdated, (0..<60).contains(Date().timeIntervalSince(updated)),
        assignmentsActorID == identity.employee.id, assignmentsBoard != nil
      else { return false }
      return true
    }
    if [
      "payment.manual.cash.record", "payment.manual.pos.record", "payment.manual.external.record",
    ].contains(permission) {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil, let identity, identity.allows(permission),
        let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
        let updated = paymentUpdated, (0..<60).contains(Date().timeIntervalSince(updated)),
        paymentSession != nil
      else { return false }
      return true
    }
    if ["order.cancel_unpaid", "order.settle_exception"].contains(permission) {
      return live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
        && liveOrderPending == nil
        && identity?.allows(permission) == true && cashier != nil
        && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
          == true
        && cashierUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
    }
    if LiveCashier.actionFlags[permission] != nil {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil, let identity, identity.allows(permission),
        let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
        let updated = cashierUpdated, (0..<60).contains(Date().timeIntervalSince(updated)),
        let board = cashier,
        board.actions[LiveCashier.actionFlags[permission]!] == true
      else { return false }
      return true
    }

    if ["kds.deliver", "staff.access.configure"].contains(permission) {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil, let identity, identity.allows(permission),
        let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
        let updated = pickupUpdated, Date().timeIntervalSince(updated) < 60,
        let board = pickupBoard, board.actor.actionSessionValid
      else { return false }
      return permission == "staff.access.configure"
        ? board.actor.canConfigure : (board.actor.canPickup || board.actor.canUndo)
    }
    if permission == "kds.prepare" {
      guard live, !busy, !heartbeatBusy, !liveStorageDamaged, livePending == nil,
        liveOrderPending == nil, let identity, identity.allows(permission),
        let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
        let updated = kitchenUpdated, Date().timeIntervalSince(updated) < 60,
        kitchenBoard?.employeeId == identity.employee.id, kitchenBoard?.canPrepare == true,
        kitchenBoard?.actionSessionValid == true
      else { return false }
      return true
    }
    guard live, connection == "已同步", !busy, !heartbeatBusy, !liveStorageDamaged,
      livePending == nil && liveOrderPending == nil,
      let identity, identity.allows(permission),
      let until = StaffIdentity.date(identity.session.onlineLeaseUntil), until > Date(),
      let lastUpdated, Date().timeIntervalSince(lastUpdated) < 60,
      liveOperations?.actor.capabilities.contains(permission) == true
    else { return false }
    return true
  }
  func prepareLive(
    kind: String, tableID: String, people: Int = 0, targetID: String? = nil, taskID: String? = nil,
    frozen: Bool = false, reason: String = ""
  ) throws -> LiveCommand {
    guard let identity, let ops = liveOperations,
      let table = ops.tables.first(where: { $0.id == tableID })
    else { throw RuleError.rule("请刷新桌台后重试") }
    let command = try LiveCommand.make(
      kind: kind, table: table, actor: identity, people: people,
      target: ops.tables.first { $0.id == targetID }, task: ops.tasks.first { $0.id == taskID },
      frozen: frozen, reason: reason)
    guard canAct(command.permission) else { throw RuleError.rule("请刷新登录和桌台状态后重试") }
    return command
  }
  func canCollectHistorical(_ provider: String) -> Bool {
    guard let mode = LiveCashier.collectionMethods[provider], canAct("payment.recollect.authorize"),
      identity?.allows(mode.0) == true, identity?.allows("payment.collect.all_tables") == true,
      cashier?.actions[mode.1] == true,
      cashier?.actions["supportsGuardedClosedDebtCollection"] == true
    else { return false }
    return true
  }
  func prepareHistoricalCollection(
    order: LiveCashier.Order, provider: String, tender: Int?, reference: String, terminal: String,
    method: String, note: String
  ) throws -> LiveCommand {
    guard canCollectHistorical(provider), let cashier, let identity else {
      throw CatalogError("请刷新原收银工作台，核对历史补收权限")
    }
    return try cashier.historicalCollection(
      actor: identity, order: order, provider: provider, tender: tender, reference: reference,
      terminal: terminal, method: method, note: note)
  }
  func canExecuteLive(_ command: LiveCommand) -> Bool {
    guard command.employeeID == identity?.employee.id else { return false }
    if command.steps.first?.ownerFinanceProof != nil {
      return command.steps.count == 1 && canUseOwnerFinance
        && identity?.allows(command.permission) == true
    }
    if let step = command.steps.first, let proof = step.cashierProof,
      proof["action"] as? String == "historical-collection"
    {
      guard command.steps.count == 1, let provider = step.object["provider"] as? String,
        canCollectHistorical(provider), let cashier, let identity,
        let orderID = proof["orderId"] as? String, let amount = proof["amountMinor"] as? Int,
        let session = proof["tableSessionId"] as? String,
        let authorizationID = proof["authorizationId"] as? String
      else { return false }
      return
        (try? cashier.validateHistoricalSelection(
          actor: identity, orderID: orderID, amount: amount, session: session,
          authorizationID: authorizationID, provider: provider)) != nil
    }
    if let p = command.steps.first?.observationProof {
      return command.steps.count == 1 && canUseObservation
        && identity?.allows(command.permission) == true
        && (p["kind"] as? String == "recommendation"
          ? recommendationBoard?.durable == true
            && recommendationBoard?.tableSessionId == p["tableSessionId"] as? String
          : observationBoard?.durable == true
            && observationBoard?.tableSessionId == p["tableSessionId"] as? String)
    }
    if let p = command.steps.first?.memberProof {
      if p["kind"] as? String == "benefit" {
        return command.steps.count == 1 && canUseBenefits
          && benefitBoard?.rows.contains(where: {
            $0.reservationId == p["reservationId"] as? String && $0.status == "reserved"
          }) == true
      }
      return command.steps.count == 1
        && (p["kind"] as? String == "visit"
          ? canUseMember && memberVisit?.memberNo == p["memberNo"] as? String : canUseMemberRewards)
    }
    if let proof = command.steps.first?.serviceProof {
      return command.steps.count == 1 && canUseService
        && identity?.allows(command.permission) == true
        && serviceBoard?.tasks.contains { $0.id == proof["taskId"] as? String } == true
    }
    if command.steps.first?.reservationReceptionProof != nil {
      return canExecuteReservationReception(command)
    }
    if let proof = command.steps.first?.reservationProof {
      return command.steps.count == 1 && canUseReservations
        && (proof["kind"] as? String == "create"
          ? reservationCapabilities?.durableCreate == true && reservationCapabilities?.tableBoundCreate != false
          : proof["kind"] as? String == "transition"
            ? reservations.contains { $0.id == proof["id"] as? String }
            : proof["kind"] as? String == "waitlist"
              ? reservationCapabilities?.durableWaitlist == true
                && reservationIntake.contains {
                  $0.kind == "waitlist" && $0.publicId == proof["publicId"] as? String
                    && $0.status == proof["previousStatus"] as? String
                }
              : reservationCapabilities?.durablePriority == true
              && reservationIntake.contains {
                $0.publicId == proof["publicId"] as? String
                  && $0.kind == proof["targetKind"] as? String
              })
    }
    if command.steps.first?.participantProof != nil {
      return command.steps.count == 1 && canUseParticipants && participantPrepared?.id == command.id
    }
    if command.steps.first?.cashHandoverProof != nil {
      return command.steps.count == 1 && canUseCashHandover
        && identity?.allows(command.permission) == true
    }
    if command.steps.first?.voucherProof != nil {
      return command.steps.count == 1 && canUseVouchers
        && identity?.allows(command.permission) == true
    }
    if let proof = command.steps.first?.productPhasesProof {
      return command.steps.count == 1 && canUseProductPhases
        && command.permission == "recommendation.phase.configure"
        && proof["productId"] as? String == productPhasesBoard?.productID
    }
    if let proof = command.steps.first?.catalogConfigurationProof {
      guard command.steps.count == 1, canUseProducts, let board = catalogConfigurationBoard,
        board.enabled, board.employeeID == identity?.employee.id, proof["employeeId"] as? String == identity?.employee.id else { return false }
      if proof["creating"] as? Bool == true { return true }
      if proof["kind"] as? String == "category" {
        return board.categories.contains { $0.text("code") == proof["code"] as? String && $0.text("updatedAt") == command.steps[0].object["expectedUpdatedAt"] as? String }
      }
      return board.products.contains { $0.id == proof["id"] as? String && $0.text("nativeVersion") == command.steps[0].object["expectedVersion"] as? String }
    }
    if command.steps.first?.productManagementProof != nil {
      return command.steps.count == 1 && canUseProducts
    }
    if command.steps.first?.nativeManagementProof != nil {
      guard canUseNativeManagement, let board = nativeManagementBoard, let actor = identity else { return false }
      return validNativeManagementSelection(command: command, board: board, actor: actor)
    }
    if let proof = command.steps.first?.showProof {
      return command.steps.count == 1 && memberReady && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
    }
    if let proof = command.steps.first?.bottleStorageProof {
      return command.steps.count == 1 && memberReady
        && identity?.allows("bottle.manage.all") == true
        && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
    }
    if let proof = command.steps.first?.experiencePlanProof {
      return command.steps.count == 1 && memberReady && proof["employeeId"] as? String == identity?.employee.id
        && experiencePlanPermissions.allSatisfy { identity?.allows($0) == true }
    }
    if let proof = command.steps.first?.remakeHandoverProof {
      return command.steps.count == 1 && memberReady && proof["employeeId"] as? String == identity?.employee.id
        && identity?.allows("refund.request") == true && identity?.allows(command.permission) == true
    }
    if command.steps.first?.contactGovernanceProof != nil {
      guard canUseContactGovernance, let board = contactGovernanceBoard, let actor = identity else { return false }
      return validContactGovernanceSelection(command: command, board: board, actor: actor)
    }
    if command.steps.first?.marketingProof != nil {
      guard canUseMarketing, let board = marketingBoard, let actor = identity else { return false }
      return validMarketingSelection(command: command, board: board, actor: actor)
    }
    if command.steps.first?.annualPolicyProof != nil {
      guard canUseAnnualPolicies, let board = annualPolicyBoard, let actor = identity else { return false }
      return validAnnualPolicySelection(command: command, board: board, actor: actor)
    }
    if command.steps.first?.loyaltyRefundProof != nil {
      guard canUseLoyaltyRefunds, let board = loyaltyRefundBoard, let actor = identity else { return false }
      return validLoyaltyRefundSelection(command: command, board: board, actor: actor)
    }
    if command.steps.first?.loyaltyOperationProof != nil {
      guard canUseLoyaltyOperations, let board = loyaltyOperationsBoard, let actor = identity else { return false }
      return validLoyaltyOperationSelection(command: command, board: board, actor: actor)
    }
    if command.steps.first?.couponPolicyProof != nil {
      guard canUseCouponPolicy, let board = couponPolicyBoard, let actor = identity else { return false }
      return validCouponPolicySelection(command: command, board: board, actor: actor)
    }
    if let proof = command.steps.first?.membershipRecoveryProof {
      guard command.steps.count == 1, canUseMembershipRecovery, identity?.allows(command.permission) == true,
        proof["employeeId"] as? String == identity?.employee.id else { return false }
      if proof["action"] as? String == "contact" { return true }
      guard let before = proof["before"] as? [String: Any], let board = membershipRecoveryBoard else { return false }
      return board.rows.contains { $0.id == before["casePublicId"] as? String && $0.text("nativeVersion") == before["nativeVersion"] as? String }
    }
    if let proof = command.steps.first?.memberNumberProof {
      return command.steps.count == 1 && canUseMemberNumber && command.permission == "member.card.manage"
        && proof["employeeId"] as? String == identity?.employee.id
        && command.steps[0].object["version"] as? Int == memberNumberBoard?.version
    }
    if let proof = command.steps.first?.memberGiftProof {
      return command.steps.count == 1 && canUseMemberGifts
        && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
        && proof["section"] as? String == memberGiftsSection
    }
    if let proof = command.steps.first?.membershipConfigProof {
      return command.steps.count == 1 && canUseMembershipConfig
        && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
        && (proof["action"] as? String == "control" ? membershipConfigSection == "controls" : membershipConfigSection == "rules")
    }
    if let step = command.steps.first, let proof = step.memberCardProof {
      return command.steps.count == 1 && canUseMemberCards
        && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
    }
    if let step = command.steps.first, step.benefitWalletProof != nil {
      return command.steps.count == 1 && canUseBenefitWallet
        && identity?.allows(command.permission) == true
        && step.object["customerId"] as? String == benefitWalletBoard?.customerID
    }
    if command.steps.first?.inventoryPublishProof != nil {
      guard canUseInventoryPublish, let board = inventoryPublishBoard, let preview = inventoryPublishPreview else { return false }
      return validInventoryPublishSelection(command, board: board, preview: preview)
    }
    if let proof = command.steps.first?.recipeConfigurationProof {
      guard command.steps.count == 1, canUseRecipeConfiguration, let board = recipeConfigurationBoard else { return false }
      return command.permission == "inventory.manage" && command.employeeID == board.employeeID
        && proof["productId"] as? String == board.product.id && command.steps[0].object["expectedVersion"] as? String == board.version
        && command.steps[0].path == inventorySetupRoot + "/products/" + board.product.id + "/recipe"
    }
    if command.steps.first?.inventorySetupProof != nil {
      guard canUseInventorySetup, let board = inventorySetupBoard else { return false }
      return validInventorySetupSelection(command, board: board)
    }
    if command.steps.first?.stockAuditProof != nil {
      return command.steps.count == 1 && canUseStockAudit
        && identity?.allows(command.permission) == true
    }
    if let proof = command.steps.first?.stockCostProof {
      return command.steps.count == 1 && canUseStock && stockBoard?.nativeCostCorrections == true
        && stockBoard?.visibility.costs == true && identity?.allows("inventory.cost.view") == true
        && command.permission == "inventory.cost.correct" && identity?.allows(command.permission) == true
        && proof["employeeId"] as? String == identity?.employee.id
        && stockBoard?.items.contains { $0.id == proof["inventoryItemId"] as? String } == true
    }
    if command.steps.first?.stockProof != nil {
      return command.steps.count == 1 && canUseStock && identity?.allows(command.permission) == true
    }
    if command.steps.first?.printProof != nil {
      return command.steps.count == 1 && canUsePrinting
        && identity?.allows(command.permission) == true
    }
    if let proof = command.steps.first?.activityProof {
      return command.steps.count == 1 && canUseActivity
        && identity?.allows(command.permission) == true
        && cashier?.activityRegistrations.contains { $0.id == proof["registrationId"] as? String }
          == true
    }
    if let proof = command.steps.first?.fulfillmentProof {
      return command.steps.count == 1 && canUseFulfillment
        && identity?.allows(command.permission) == true
        && fulfillmentBoard?.workItems.contains { $0.id == proof["taskId"] as? String } == true
    }
    if command.steps.first?.afterSalesProof != nil {
      return canUseAfterSales
        && identity?.allows(command.permission) == true
        && afterSales.map { validAfterSalesCommandSelection(command: command, board: $0) } == true
    }
    return canAct(command.permission)
  }
  func executeLive(_ command: LiveCommand) async {
    guard canExecuteLive(command) else {
      message = "操作条件已变化，请刷新后重试"
      return
    }
    var initializationCommand = command
    var initializationPrepared = false
    var enteredRecovery = false
    do {
      if command.steps.first?.reservationReceptionProof != nil {
        try recordReservationReceptionInitialization(command, persistence: reservationReceptionPersistence)
        initializationPrepared = true
      } else {
        initializationPrepared = try recordNativeCommandCleanup(command, disposition: .neverSent,
          verifyTerminal: {}, persistence: nativeCleanupPersistence) != nil
      }
      if command.steps.contains(where: {
        ["/api/payments/manual", "/api/payments/manual/closed-debt"].contains($0.path)
      }) {
        paymentUpdated = nil
        paymentState = "请核对原收款结果后刷新账单"
      }
      let online = try secureOnlineCommand(command, store: PaymentSecrets.store)
      let voucher = try secureVoucherCommand(online, store: PaymentSecrets.store)
      let finance = try secureOwnerFinanceCommand(voucher, store: OwnerFinanceSecrets.store)
      let bottle = try secureBottleStorageCommand(finance, store: BottleStorageSecrets.store)
      let show = try secureShowCommand(bottle, store: ShowSecrets.store)
      let experience = try secureExperiencePlanCommand(show, store: ExperiencePlanSecrets.store)
      let handover = try secureRemakeHandoverCommand(experience, store: RemakeHandoverSecrets.store)
      let recovery = try secureMembershipRecoveryCommand(handover, store: MembershipRecoverySecrets.store)
      let reception = try secureReservationReceptionCommand(recovery, store: reservationReceptionPersistence.storePayload)
      let secured = try secureNativeManagementCommand(reception, store: nativeManagementPersistence.storePayload)
      initializationCommand = secured
      try JSONEncoder().encode(secured).write(to: livePendingURL, options: .atomic)
      livePending = secured
      if secured.steps.first?.reservationReceptionProof != nil {
        try discardReservationReceptionInitialization(secured, persistence: reservationReceptionPersistence)
      } else if initializationPrepared {
        guard try discardNativeCommandInitialization(secured, persistence: nativeCleanupPersistence) else { throw NativeCommandCleanupError() }
      }
      enteredRecovery = true
      await recoverLive()
    } catch {
      guard initializationPrepared, !enteredRecovery else {
        message = "原请求未能安全初始化，未发送操作；请核对本机原记录。"
        return
      }
      livePending = initializationCommand
      do {
        let cleaned: Bool
        if initializationCommand.steps.first?.reservationReceptionProof != nil {
          cleaned = try finishAcknowledgedReservationReception(initializationCommand)
        } else { cleaned = try finishSensitiveCommandCleanup(initializationCommand) }
        guard cleaned else { throw NativeCommandCleanupError() }
      } catch {
        localCleanupBlocked = true
        message = "本次操作尚未发送，本机核对尚未完成，原请求仍保留；请解锁设备后继续本机清理。"
      }
    }
  }
  func recoverLive() async {
    guard let command = livePending, !busy, !heartbeatBusy, !durableRecordDamaged else { return }
    // A signed-in role may revoke its own session or permissions. A separately
    // secured, fully bound server receipt permits only local completion, without
    // sending a request or trusting the ordinary completedSteps checkpoint.
    do {
      if try finishAcknowledgedReservationReception(command) { return }
      if try finishSensitiveCommandCleanup(command) { return }
      if try finishAcknowledgedManagement(command) { return }
    } catch {
      message = error.localizedDescription
      return
    }
    guard !localCleanupBlocked else { return }
    guard command.employeeID == identity?.employee.id else {
      message = "请由发起操作的员工登录后核对"
      return
    }
    guard !command.rejected else {
      message = "服务器已拒绝此操作，请确认提示后清除失败请求，再刷新处理"
      return
    }
    busy = true
    defer { busy = false }
    var current = command
    do {
      // A legacy ordinary checkpoint cannot certify a protected response.
      // Re-read/replay only its same original key and payload to validate it.
      if current.completedSteps > 0, !(try nativeCommandCleanupSlots(current)).isEmpty {
        current.completedSteps = 0
        try JSONEncoder().encode(current).write(to: livePendingURL, options: .atomic)
        livePending = current
      }
      identity = try await api.heartbeat()
      guard
        current.completedSteps == current.steps.count
          || identity?.allows(current.permission) == true
          || isNativeStaffPermissionReceiptRecovery(current)
      else {
        throw StaffAPIError(status: 403, code: "ACCESS_REVOKED", message: "操作权限已撤销，请联系管理员核对原请求")
      }
      if current.steps.count == 1, current.completedSteps == 0,
        let proof = current.steps.first?.afterSalesProof,
        proof["afterSales"] as? String == "cash-paid",
        let itemID = proof["itemId"] as? String, let actor = identity
      {
        let board: LiveAfterSales = try await api.data(
          "/api/commerce/item-after-sales/items/" + LiveCommand.pathPart(itemID))
        try board.validate(itemID: itemID)
        let recovered = try recoverLegacyAfterSalesCashCommand(
          command: current, board: board, actor: actor)
        if recovered != current {
          // Persist the added begin step before sending anything. The original
          // manual-result payload/key and its employee ownership remain intact.
          try JSONEncoder().encode(recovered).write(to: livePendingURL, options: .atomic)
          livePending = recovered
          current = recovered
        }
      }
      current = try await LiveCommandRunner.advance(
        current,
        send: { step in
          if let proof = step.onlineProof, let session = proof["tableSessionId"] as? String {
            if let saved = self.onlineReceipts[session], saved.commandID == command.id {
              try validateOnlineReply(saved.response, step: step)
            } else {
              let body = try onlineRequestBody(step, secret: PaymentSecrets.read)
              let (bytes, _) = try await self.api.raw(
                step.path, body: body, headers: [step.keyHeader: step.key])
              try validateOnlineReply(bytes, step: step)
              let receipt = OnlineReceipt(
                commandID: command.id, employeeID: command.employeeID, tableSessionID: session,
                kind: proof["online"] as! String, response: bytes)
              var all = self.onlineReceipts
              all[session] = receipt
              try JSONEncoder().encode(all).write(to: self.onlineReceiptURL, options: .atomic)
              self.onlineReceipts = all
              self.onlineStatuses[receipt.paymentID] = "pending"
            }

          } else if step.catalogConfigurationProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateCatalogConfigurationReply(reply, step: step)
          } else if step.productPhasesProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object,
              headers: [step.keyHeader: step.key])
            try validateProductPhasesReply(reply, step: step)
          } else if step.reservationReceptionProof != nil {
            guard let actor = self.identity else { throw StaffAPIError.invalid }
            let body = try reservationReceptionRequestBody(current, step: step, actor: actor,
              read: reservationReceptionPersistence.readPayload)
            let (reply, _) = try await self.api.raw(step.path, body: body,
              headers: [step.keyHeader: step.key])
            try recordReservationReceptionAcknowledgement(reply, command: current, step: step, actor: actor,
              readPayload: reservationReceptionPersistence.readPayload, readReceipt: reservationReceptionPersistence.readReceipt,
              storeReceipt: reservationReceptionPersistence.storeReceipt)
          } else if step.nativeManagementProof != nil {
            guard let actor = self.identity else { throw StaffAPIError.invalid }
            let body = try nativeManagementRequestBody(current, step: step, actor: actor,
              read: nativeManagementPersistence.readPayload)
            let (reply, _) = try await self.api.raw(step.path, body: body,
              headers: [step.keyHeader: step.key])
            try recordNativeManagementAcknowledgement(reply, command: current, step: step, actor: actor,
              readPayload: nativeManagementPersistence.readPayload, readReceipt: nativeManagementPersistence.readReceipt,
              storeReceipt: nativeManagementPersistence.storeReceipt)
          } else if step.showProof != nil {
            let payload = try showRequestPayload(current, step: step, read: ShowSecrets.read)
            let (reply, _) = try await self.api.raw(step.path, body: payload.body, headers: [step.keyHeader: step.key])
            self.showReceipt = try validateShowReceipt(reply, step: step, body: payload.body, expectation: payload.expectation)
          } else if step.bottleStorageProof != nil {
            let body = try bottleStorageRequestBody(current, step: step, read: BottleStorageSecrets.read)
            let (reply, _) = try await self.api.raw(step.path, body: body,
              headers: bottleStorageHeaders(step))
            let receipt = try validateBottleStorageReceipt(reply, step: step, body: body)
            try BottleStorageSecrets.saveReceipt(receipt)
            self.bottleStorageReceipt = receipt
          } else if step.experiencePlanProof != nil {
            guard experiencePlanPermissions.allSatisfy({ identity?.allows($0) == true }) else { throw StaffAPIError.invalid }
            let body = try experiencePlanRequestBody(current, step: step, read: ExperiencePlanSecrets.read)
            let (reply, _) = try await api.raw(step.path, body: body, headers: [step.keyHeader: step.key])
            experiencePlanReceipt = try validateExperiencePlanReply(reply, step: step)
          } else if step.remakeHandoverProof != nil {
            guard identity?.allows("refund.request") == true, identity?.allows(current.permission) == true else { throw StaffAPIError.invalid }
            let body = try remakeHandoverRequestBody(current, step: step, read: RemakeHandoverSecrets.read)
            let (reply, _) = try await api.raw(step.path, body: body, headers: [step.keyHeader: step.key])
            remakeHandoverReceipt = try validateRemakeHandoverReply(reply, step: step)
          } else if step.contactGovernanceProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateContactGovernanceReply(reply, step: step)
          } else if step.marketingProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateMarketingReply(reply, step: step)
          } else if step.annualPolicyProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateAnnualPolicyReply(reply, step: step)
          } else if let proof = step.loyaltyRefundProof {
            guard let actor = identity, let action = proof["action"] as? String,
              canWriteLoyaltyRefunds(actor, action: action) else { throw CatalogError("当前员工缺少财务及积分复核权限") }
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateLoyaltyRefundReply(reply, step: step)
          } else if step.loyaltyOperationProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateLoyaltyOperationReply(reply, step: step)
          } else if step.couponPolicyProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateCouponPolicyReply(reply, step: step)
          } else if step.membershipRecoveryProof != nil {
            let body = try membershipRecoveryRequestBody(current, step: step, read: MembershipRecoverySecrets.read)
            let (reply, _) = try await api.raw(step.path, body: body, headers: [step.keyHeader: step.key])
            try validateMembershipRecoveryReply(reply, step: step, body: body)
          } else if step.memberNumberProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateMemberNumberReply(reply, step: step)
          } else if step.memberGiftProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateMemberGiftReply(reply, step: step)
          } else if step.membershipConfigProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object,
              headers: [step.keyHeader: step.key])
            try validateMembershipConfigReply(reply, step: step)
          } else if step.memberCardProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object,
              headers: [step.keyHeader: step.key])
            try validateMemberCardReply(reply, step: step)
          } else if step.benefitWalletProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object,
              headers: [step.keyHeader: step.key])
            try validateBenefitWalletReply(reply, step: step)
          } else if step.ownerFinanceProof != nil {
            let body = try ownerFinanceRequestBody(current, step: step, read: OwnerFinanceSecrets.read)
            let (reply, _) = try await self.api.raw(step.path, body: body,
              headers: ownerFinanceHeaders(step))
            try validateOwnerFinanceReply(reply, step: step, body: body)
          } else if step.voucherProof != nil {
            try await performVoucherStep(
              step, read: { path in try await self.api.raw(path).0 },
              send: { body in
                try await self.api.raw(step.path, body: body, headers: [step.keyHeader: step.key]).0
              }, secret: PaymentSecrets.read)
          } else if step.inventoryPublishProof != nil {
            guard inventoryPublishPermissions.allSatisfy({ identity?.allows($0) == true }) else { throw StaffAPIError.invalid }
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateInventoryPublishReply(reply, step: step)
          } else if step.recipeConfigurationProof != nil {
            let (reply, _) = try await api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateRecipeConfigurationReply(reply, step: step)
          } else if step.inventorySetupProof != nil {
            let (reply, _) = try await self.api.raw(step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateInventorySetupReply(reply, step: step)
          } else if step.stockCostProof != nil {
            guard self.identity?.allows("inventory.cost.view") == true else {
              throw CatalogError("当前岗位没有成本查看权限，请由原员工恢复")
            }
            let (bytes, _) = try await self.api.raw(step.path, body: step.object,
              headers: [step.keyHeader: step.key])
            try validateStockCostReply(bytes, step: step)
          } else if step.stockProof != nil || step.stockAuditProof != nil {
            let (bytes, _) = try await self.api.raw(
              step.path, body: step.object, headers: [step.keyHeader: step.key])
            if step.stockAuditProof != nil {
              try validateStockAuditReply(bytes, step: step)
            } else {
              try validateStockReply(bytes, step: step)
            }
            let receipt = StockSavedReceipt(
              commandID: command.id, employeeID: command.employeeID, bytes: bytes)
            try JSONEncoder().encode(receipt).write(to: self.stockReceiptURL, options: .atomic)
            self.stockReceipt = receipt
          } else if step.printProof != nil {
            let (bytes, _) = try await self.api.raw(
              step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validatePrintReply(bytes, step: step)
            let receipt = NativePrintReceipt(
              commandID: command.id, employeeID: command.employeeID, bytes: bytes)
            try JSONEncoder().encode(receipt).write(to: self.printReceiptURL, options: .atomic)
            self.printReceipt = receipt
          } else if let proof = step.financeProof {
            let (bytes, _) = try await self.api.raw(
              step.path, body: step.object, headers: [step.keyHeader: step.key])
            try validateFinanceReply(bytes, step: step)
            let receipt = FinanceReceipt(
              commandID: command.id, employeeID: command.employeeID,
              kind: proof["finance"] as! String, bytes: bytes)
            try JSONEncoder().encode(receipt).write(to: self.financeReceiptURL, options: .atomic)
            self.financeReceipt = receipt
          } else {
            try await self.api.execute(step)
          }
          // Every protected branch above has validated the actual original
          // response (or independently saved online receipt) before this point.
          try recordNativeCommandCleanup(current, disposition: .acknowledged,
            verifyTerminal: {}, persistence: self.nativeCleanupPersistence)
        },
        checkpoint: { next in
          try JSONEncoder().encode(next).write(to: self.livePendingURL, options: .atomic)
          self.livePending = next
        })
      if try finishAcknowledgedReservationReception(current) { return }
      if try finishSensitiveCommandCleanup(current) { return }
      if try finishAcknowledgedManagement(current) { return }
      // Refresh is part of closure. A failed refresh keeps completed steps for read-only recovery.
      if let step = current.steps.first, step.path == "/api/commerce/kitchen-board/commands",
        let station = step.object["stationCode"] as? String
      {
        try await fetchKitchen(station)
      } else if let session = current.steps.first?.collectionSession {
        try await fetchPaymentOrders(session)
      } else if let proof = current.steps.first?.onlineProof,
        let session = proof["tableSessionId"] as? String
      {
        try await fetchPaymentOrders(session)
      } else if current.steps.first?.fulfillmentProof != nil {
        try await fetchFulfillment()
      } else if let itemID = current.steps.first?.afterSalesProof?["itemId"] as? String {
        try await fetchAfterSales(itemID)
      } else if let p = current.steps.first?.observationProof {
        try await fetchObservation(p["tableSessionId"] as! String)
      } else if let p = current.steps.first?.memberProof {
        if p["kind"] as? String == "benefit" {
          try await fetchBenefits()
        } else if p["kind"] as? String == "visit" {
          try await fetchMember(p["memberNo"] as! String)
        } else {
          try await fetchMemberRewards(status: memberRewardFilter)
        }
      } else if let p = current.steps.first?.stockAuditProof {
        if p["kind"] as? String == "count", let fingerprint = p["draftFingerprint"] as? String,
          let data = Data(base64Encoded: fingerprint),
          let original = try? JSONDecoder().decode([StockCountInput].self, from: data),
          try countBook()[current.employeeID] == original
        {
          // Command remains checkpointed until both draft cleanup and refresh succeed.
          var book = try JSONDecoder().decode(
            [String: [StockCountInput]].self, from: Data(contentsOf: countDraftURL))
          book[current.employeeID] = []
          try JSONEncoder().encode(book).write(to: countDraftURL, options: .atomic)
          stockCountDraft = []
        }
        try await fetchStock()
        try await fetchStockAudit()
      } else if let proof = current.steps.first?.productPhasesProof,
        let id = proof["productId"] as? String {
        try await fetchProductPhases(productID: id)
      } else if current.steps.first?.inventoryPublishProof != nil {
        inventoryPublishBoard = nil; inventoryPublishPreview = nil; inventoryPublishUpdated = nil
        inventoryPublishState = "原整单收货与发布已确认，请重新读取采购和商品状态。"
        try await fetchStock()
      } else if let proof = current.steps.first?.recipeConfigurationProof {
        recipeConfigurationProductID = proof["productId"] as? String ?? ""
        try await fetchRecipeConfiguration()
      } else if current.steps.first?.inventorySetupProof != nil {
        try await fetchInventorySetup()
      } else if current.steps.first?.stockCostProof != nil {
        try await fetchStock()
      } else if current.steps.first?.productManagementProof != nil || current.steps.first?.catalogConfigurationProof != nil {
        try await fetchProducts()
      } else if let proof = current.steps.first?.stockProof {
        if proof["kind"] as? String == "create" {
          var book = try stockBook()
          if try book.matches(employee: current.employeeID, proof: proof) {
            book[current.employeeID] = []
            book.suppliersByEmployee[current.employeeID] = nil
            try JSONEncoder().encode(book).write(to: stockDraftURL, options: .atomic)
          }
        }
        try await fetchStock()
      } else if current.steps.first?.serviceProof != nil {
        try await fetchService()
      } else if current.steps.first?.reservationProof != nil {
        try await fetchReservations(reservationQuery)
      } else if current.steps.first?.cashHandoverProof != nil {
        try await fetchCashHandover()
      } else if current.steps.first?.voucherProof != nil {
        try await fetchVouchers()
      } else if current.steps.first?.printProof != nil {
        try await fetchPrinting()
      } else if let proof = current.steps.first?.nativeManagementProof,
        let name = proof["module"] as? String, let module = NativeManagementModule(rawValue: name) {
        try await fetchNativeManagement(module)
      } else if current.steps.first?.showProof != nil {
        // Exact reply validated above. The active show view reloads when busy ends.
      } else if current.steps.first?.bottleStorageProof != nil {
        // The validated receipt is the authoritative original result. The view
        // refreshes its selected list/detail without sending the completed step.
      } else if current.steps.first?.experiencePlanProof != nil || current.steps.first?.remakeHandoverProof != nil {
        // The view reloads after the original mutation has a validated receipt.
      } else if let proof = current.steps.first?.contactGovernanceProof {
        guard let area = proof["area"] as? String, let search = proof["search"] as? String else { throw StaffAPIError.invalid }
        contactGovernanceArea = area; contactGovernanceSearch = search; contactGovernanceCursor = ""
        try await fetchContactGovernance()
      } else if let proof = current.steps.first?.marketingProof {
        guard let area = proof["area"] as? String, let code = proof["code"] as? String else { throw StaffAPIError.invalid }
        marketingArea = area; marketingCode = code; marketingCursor = ""
        try await fetchMarketing()
      } else if let proof = current.steps.first?.annualPolicyProof {
        guard let code = proof["code"] as? String else { throw StaffAPIError.invalid }
        annualPolicyCode = code; annualPolicyCursor = ""
        try await fetchAnnualPolicies()
      } else if let proof = current.steps.first?.loyaltyRefundProof {
        loyaltyRefundPage = try walletInteger(proof["page"])
        try await fetchLoyaltyRefunds()
      } else if let proof = current.steps.first?.loyaltyOperationProof {
        guard let rawKind = proof["kind"] as? String, let kind = LoyaltyOperationKind(rawValue: rawKind),
          let section = proof["section"] as? String else { throw StaffAPIError.invalid }
        loyaltyOperationsKind = kind; loyaltyOperationsSection = section; loyaltyOperationsPage = try walletInteger(proof["page"])
        try await fetchLoyaltyOperations()
      } else if let proof = current.steps.first?.couponPolicyProof {
        guard let rawKind = proof["kind"] as? String, let kind = CouponPolicyKind(rawValue: rawKind) else { throw StaffAPIError.invalid }
        couponPolicyKind = kind; couponPolicySearch = proof["search"] as? String ?? ""; couponPolicyCursor = ""
        try await fetchCouponPolicies()
      } else if let proof = current.steps.first?.membershipRecoveryProof {
        membershipRecoveryHistory = try walletBoolean(proof["history"])
        membershipRecoveryCursor = ""
        try await fetchMembershipRecovery()
      } else if current.steps.first?.memberNumberProof != nil {
        try await fetchMemberNumber()
      } else if let proof = current.steps.first?.memberGiftProof, let section = proof["section"] as? String {
        if memberGiftsSection != section { memberGiftsCursor = "" }
        memberGiftsSection = section
        try await fetchMemberGifts()
      } else if let step = current.steps.first, let proof = step.membershipConfigProof {
        membershipConfigSection = proof["action"] as? String == "control" ? "controls" : "rules"
        if let domain = step.object["domain"] as? String, let id = step.object["configurationId"] as? String {
          membershipConfigTarget = domain + "/" + id
        } else { membershipConfigTarget = nil }
        try await fetchMembershipConfig()
      } else if current.steps.first?.memberCardProof != nil {
        if let actor = identity, !memberCardSections(actor).contains(memberCardsSection),
          let section = memberCardSections(actor).first { memberCardsSection = section; memberCardsCursor = "" }
        try await fetchMemberCards()
      } else if current.steps.first?.benefitWalletProof != nil {
        try await fetchBenefitWallet()
      } else if current.steps.first?.ownerFinanceProof != nil {
        try await fetchOwnerFinance()
      } else if current.steps.first?.financeProof != nil {
        try await fetchFinance(query: financeQuery)
      } else if current.steps.first?.assignmentProof != nil {
        try await fetchAssignments()
      } else if current.steps.first?.cashierProof != nil
        || current.steps.first?.activityProof != nil
      {
        try await fetchCashier(cashierQuery)
      } else if current.steps.first?.path.hasPrefix("/api/commerce/pickup-board/") == true {
        try await fetchPickup()
      } else {
        try await loadOperations()
      }
      try FileManager.default.removeItem(at: livePendingURL)
      livePending = nil
      if current.steps.first?.participantProof != nil {
        resetParticipantPreview()
        participants = []
        participantState = "人员调整已确认，请让顾客扫描目标桌二维码；如需继续，请刷新名单。"
      }
      if current.steps.first?.assignmentProof != nil {
        assignmentReceipt = current.title + " · 已确认"
      }
      message =
        current.steps.first?.voucherProof == nil
        ? "操作已确认，服务器状态已更新" : "原核销事项已保存；以事项状态为准，待核对不表示核销或结算成功"
    } catch {
      current = livePending ?? current
      if let failure = error as? StaffAPIError, failure.definitivelyRejected,
        current.completedSteps < current.steps.count
      {
        do {
          if current.steps.first?.reservationReceptionProof != nil {
            guard let actor = identity else { throw StaffAPIError.invalid }
            try recordReservationReceptionRejection(failure, command: current, actor: actor, persistence: reservationReceptionPersistence)
          } else {
            try recordNativeCommandCleanup(current, disposition: .rejected, verifyTerminal: {
              guard failure.definitivelyRejected else { throw StaffAPIError.invalid }
            }, persistence: nativeCleanupPersistence)
          }
          current.rejected = true
          try JSONEncoder().encode(current).write(to: livePendingURL, options: .atomic)
          livePending = current
        } catch { message = "原请求及安全记录尚未完成核对，请保留原请求恢复" }
      }
      handleLiveError(error)
    }
  }
  private func finishAcknowledgedReservationReception(_ command: LiveCommand) throws -> Bool {
    guard command.steps.first?.reservationReceptionProof != nil else { return false }
    let existing = try reservationReceptionCleanupDisposition(command, persistence: reservationReceptionPersistence)
    if existing != "rejected" {
      guard try prepareReservationReceptionCleanup(command, persistence: reservationReceptionPersistence) else { return false }
    }
    guard let disposition = try reservationReceptionCleanupDisposition(command, persistence: reservationReceptionPersistence) else { throw StaffAPIError.invalid }
    try removeReservationReceptionPrivateSlots(command, disposition: disposition, persistence: reservationReceptionPersistence)
    if FileManager.default.fileExists(atPath: livePendingURL.path) {
      try FileManager.default.removeItem(at: livePendingURL)
    }
    try removeReservationReceptionCleanupTicket(command, disposition: disposition, persistence: reservationReceptionPersistence)
    livePending = nil
    localCleanupBlocked = false
    clearReservationReceptionReadiness()
    reservations = []; reservationIntake = []; reservationTables = []; reservationCapabilities = nil
    reservationUpdated = nil; reservationEmployee = nil
    reservationState = "请重新读取预约接待状态"
    message = disposition == "never-sent" ? "操作尚未发送，本机私密草稿已清理。"
      : disposition == "rejected" ? "原预约接待已核验被拒绝，本机私密记录已清理。"
      : "原预约接待操作已确认，本机私密记录已清理；请重新读取，不会重复登记或关联。"
    return true
  }
  private func finishSensitiveCommandCleanup(_ command: LiveCommand) throws -> Bool {
    guard !(try nativeCommandCleanupSlots(command, allowUnsecured: true)).isEmpty,
      let data = try nativeCleanupPersistence.readTicket(command.id) else { return false }
    let ticket = try decodeNativeCommandCleanupTicket(data, key: command.id)
    guard try finishNativeCommandCleanup(command, persistence: nativeCleanupPersistence, removePending: { _ in
      if FileManager.default.fileExists(atPath: self.livePendingURL.path) { try FileManager.default.removeItem(at: self.livePendingURL) }
    }) else { return false }
    livePending = nil
    localCleanupBlocked = false
    resetDailyBusinessViews()
    nativeManagementBoard = nil; nativeManagementUpdated = nil; clearBridgePairing()
    message = ticket.disposition == .acknowledged
      ? "原操作已有服务器确认，本机私密记录已清理；请重新读取当前业务状态。"
      : ticket.disposition == .neverSent ? "操作尚未发送，本机私密草稿已清理。" : "已核验原操作被拒绝，本机私密记录已清理；请重新读取后处理。"
    return true
  }
  private func finishAcknowledgedManagement(_ command: LiveCommand) throws -> Bool {
    guard command.steps.first?.nativeManagementProof != nil else { return false }
    guard try hasNativeManagementAcknowledgement(command, readPayload: nativeManagementPersistence.readPayload,
      readReceipt: nativeManagementPersistence.readReceipt) else { return false }
    try recordNativeCommandCleanup(command, disposition: .acknowledged, verifyTerminal: {
      guard try hasNativeManagementAcknowledgement(command, readPayload: nativeManagementPersistence.readPayload,
        readReceipt: nativeManagementPersistence.readReceipt) else { throw StaffAPIError.invalid }
    }, persistence: nativeCleanupPersistence)
    return try finishSensitiveCommandCleanup(command)
  }
  func dismissRejectedLive() {
    guard let command = livePending, command.rejected, command.employeeID == identity?.employee.id,
      !busy
    else { return }
    resetParticipantPreview()
    do {
      if command.steps.first?.reservationReceptionProof != nil {
        guard try hasRejectedReservationReceptionCleanup(command, persistence: reservationReceptionPersistence) else {
          throw CatalogError("缺少已核验拒绝记录，不能按普通失败标记清除原预约")
        }
        try removeReservationReceptionPrivateSlots(command, disposition: "rejected", persistence: reservationReceptionPersistence)
        if FileManager.default.fileExists(atPath: livePendingURL.path) { try FileManager.default.removeItem(at: livePendingURL) }
        try removeReservationReceptionCleanupTicket(command, disposition: "rejected", persistence: reservationReceptionPersistence)
      } else if !(try nativeCommandCleanupSlots(command)).isEmpty {
        guard try finishSensitiveCommandCleanup(command) else {
          throw NativeCommandCleanupError("缺少已核验终态回执，不能按普通失败标记清除原请求")
        }
      } else { try FileManager.default.removeItem(at: livePendingURL) }
      livePending = nil
      ownerFinanceUpdated = nil
      ownerFinanceBoard = nil
      if let key = command.steps.first?.voucherProof?["voucherSecretKey"] as? String {
        PaymentSecrets.remove(key)
      }
      if let key = command.steps.first?.onlineProof?["authCodeKey"] as? String {
        PaymentSecrets.remove(key)
      }
      assignmentsUpdated = nil
      assignmentsBoard = nil
      assignmentsActorID = nil
      assignmentReceipt = ""
      voucherUpdated = nil
      cashHandoverUpdated = nil
      afterSalesUpdated = nil
      financeUpdated = nil
      printUpdated = nil
      connection = "请刷新桌台后继续"
      lastUpdated = nil
      fulfillmentUpdated = nil
      fulfillmentBoard = nil
      kitchenUpdated = nil
      cashierUpdated = nil
      pickupUpdated = nil
      paymentUpdated = nil
    } catch { message = "请求记录无法清除，请检查设备空间" }
  }
  func resetParticipantPreview() {
    participantInput = nil
    participantPreview = nil
    participantUpdated = nil
    participantPrepared = nil
  }
  private func resetDailyBusinessViews() {
    marketingBoard = nil; marketingUpdated = nil; marketingArea = "notices"; marketingCode = ""; marketingCursor = ""
    marketingState = "请读取营销告知与本人许可"
    contactGovernanceBoard = nil; contactGovernanceUpdated = nil; contactGovernanceArea = "policies"; contactGovernanceSearch = ""; contactGovernanceCursor = ""
    contactGovernanceState = "请读取联系方式保留治理"
    annualPolicyBoard = nil; annualPolicyUpdated = nil; annualPolicyCode = ""; annualPolicyCursor = ""
    loyaltyRefundBoard = nil; loyaltyRefundUpdated = nil; loyaltyRefundPage = 0
    loyaltyOperationsBoard = nil; loyaltyOperationsUpdated = nil; loyaltyOperationsKind = .benefit; loyaltyOperationsSection = "reconciliation"; loyaltyOperationsPage = 0
    loyaltyOperationsState = "请读取原礼遇异常或积分核对记录"
    nativeManagementSearch = ""; nativeManagementCursor = ""; nativeManagementCode = "DEFAULT"
    experiencePlanReceipt = nil; remakeHandoverReceipt = nil
    couponPolicyBoard = nil; couponPolicyUpdated = nil; couponPolicyKind = .calendar; couponPolicySearch = ""; couponPolicyCursor = ""
    couponPolicyState = "请读取券日历或优惠叠加规则"
    inventoryPublishBoard = nil; inventoryPublishPreview = nil; inventoryPublishUpdated = nil; inventoryPublishState = "请读取原采购单"
    recipeConfigurationBoard = nil; recipeConfigurationUpdated = nil; recipeCostPreview = nil; recipeConfigurationProductID = ""
    recipeConfigurationState = "请读取原商品配方"
    ownerFinanceBoard = nil
    ownerFinanceUpdated = nil
    ownerFinanceQuery = ""
    ownerFinanceState = "请读取费用与工资"
    assignmentScheduleMode = "future"
    assignmentSchedulePage = 0
    overview = nil
    overviewState = "请读取经营概览"
    inventorySetupBoard = nil; inventorySetupUpdated = nil; inventorySetupState = "请读取物料与包装条码"
    stockCounts = nil
    stockWaste = nil
    stockAuditUpdated = nil
    stockCountDraft = []
    stockAuditState = "请读取盘点与报损"
    productPhasesBoard = nil; productPhasesUpdated = nil
    productPhasesState = "请读取原商品演出阶段"
    productBoard = nil
    catalogConfigurationBoard = nil
    productUpdated = nil
    productState = "请读取商品"
    nativeManagementBoard = nil; nativeManagementUpdated = nil
    nativeManagementState = "请读取门店配置"
    clearBridgePairing()
    bottleStorageReceipt = nil
    showReceipt = nil
    membershipRecoveryBoard = nil; membershipRecoveryUpdated = nil; membershipRecoveryHistory = false; membershipRecoveryCursor = ""
    membershipRecoveryState = "请读取历史会员找回申请"
    memberNumberBoard = nil; memberNumberUpdated = nil; memberNumberState = "请读取会员号规则"
    memberGiftsBoard = nil; memberGiftsUpdated = nil; memberGiftsSection = "campaigns"; memberGiftsCursor = ""
    memberGiftsState = "请读取赠礼活动与发放任务"
    membershipConfigBoard = nil; membershipConfigDetail = nil; membershipConfigUpdated = nil
    membershipConfigSection = "rules"; membershipConfigTarget = nil
    membershipConfigState = "请读取会员规则与运行控制"
    memberCardsBoard = nil; memberCardsUpdated = nil
    memberCardsSection = "projects"; memberCardsCursor = ""
    memberCardsState = "请读取会员卡项目"
    benefitWalletBoard = nil; benefitWalletUpdated = nil
    benefitWalletCode = ""; benefitWalletCursor = ""
    benefitWalletState = "请查询会员权益"
    stockBoard = nil
    stockReceiptQuery = StockReceiptQuery()
    stockUpdated = nil
    stockEmployee = nil
    stockDraft = []
    stockSupplier = ""
    stockReceipt = nil
    stockState = "请读取库存与采购单"
    serviceAttention = ServiceAttention()
    benefitBoard = nil
    benefitUpdated = nil
    benefitEmployee = nil
    benefitState = "请读取权益兑付队列"
    observationBoard = nil
    recommendationBoard = nil
    observationEmployee = nil
    observationUpdated = nil
    observationState = ""

    memberAccount = nil
    memberParticipation = nil
    memberVisit = nil
    memberRewards = nil
    memberEmployee = nil
    memberRewardEmployee = nil
    memberUpdated = nil
    memberRewardUpdated = nil
    memberState = ""
    memberRewardState = ""

    resetParticipantPreview()
    participants = []
    participantState = ""
    reservations = []
    reservationIntake = []
    reservationCapabilities = nil
    reservationTables = []
    reservationUpdated = nil
    reservationEmployee = nil
    reservationState = ""
    clearReservationReceptionReadiness()
    serviceBoard = nil
    serviceUpdated = nil
    serviceState = ""
  }
  func loadService() async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    serviceBoard = nil
    serviceUpdated = nil
    serviceState = "正在读取服务任务"
    do {
      identity = try await api.heartbeat()
      try await fetchService()
    } catch {
      serviceState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchService() async throws {
    guard let actor = identity, actor.canReadService else {
      throw CatalogError("当前岗位没有服务任务权限")
    }
    let board: LiveServiceBoard = try await api.data("/api/native-service-center")
    guard board.currentEmployeeId == actor.employee.id,
      Set(board.tasks.map(\.id)).count == board.tasks.count,
      Set(board.employees.map(\.id)).count == board.employees.count
    else { throw StaffAPIError.invalid }
    serviceBoard = board
    serviceUpdated = Date()
    serviceState = "读取\(board.tasks.count)项未完成任务；紧急事项优先。"
  }
  func prepareService(id: String, action: String, note: String, employee: String, priority: String)
    throws -> LiveCommand
  {
    guard canUseService, let board = serviceBoard, let actor = identity else {
      throw CatalogError("请刷新任务并核对当前员工权限")
    }
    return try board.command(
      id: id, action: action, note: note, employee: employee, priority: priority, actor: actor)
  }

  func loadObservation(_ session: String) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    observationBoard = nil
    recommendationBoard = nil
    observationUpdated = nil
    observationState = "正在读取本次开台的观察与推荐"
    do {
      identity = try await api.heartbeat()
      try await fetchObservation(session)
    } catch {
      observationState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchObservation(_ session: String) async throws {
    observationBoard = nil
    recommendationBoard = nil
    observationUpdated = nil
    guard let actor = identity else { throw StaffAPIError.invalid }
    var failures: [String] = []
    if actor.allows("observation.record") {
      do {
        let board: ObservationBoard = try await api.data(
          "/api/staff/native-table-sessions/" + LiveCommand.pathPart(session) + "/observations")
        guard board.tableSessionId == session else { throw StaffAPIError.invalid }
        observationBoard = board
      } catch { failures.append("观察：" + error.localizedDescription) }
    }
    if actor.allows("recommendation.staff.modify") {
      do {
        let board: RecommendationBoard = try await api.data(
          "/api/staff/native-customer-experience/recommendations?tableSessionId="
            + LiveCommand.pathPart(session))
        guard board.tableSessionId == session else { throw StaffAPIError.invalid }
        recommendationBoard = board
      } catch { failures.append("推荐：" + error.localizedDescription) }
    }
    observationEmployee = actor.employee.id
    observationUpdated = Date()
    observationState =
      failures.isEmpty ? "已读取本次开台记录 · 操作前超过一分钟请刷新" : failures.joined(separator: "\n")
    if observationBoard == nil && recommendationBoard == nil {
      throw CatalogError(observationState.isEmpty ? "当前员工没有查看权限" : observationState)
    }
  }

  func loadBenefits() async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    benefitBoard = nil
    benefitUpdated = nil
    benefitState = "正在读取权益兑付"
    do {
      identity = try await api.heartbeat()
      try await fetchBenefits()
    } catch {
      benefitState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchBenefits() async throws {
    guard let actor = identity, actor.allows("loyalty.redemption.fulfill") else {
      throw CatalogError("当前员工没有权益兑付权限")
    }
    let board: BenefitFulfillmentBoard = try await api.data("/api/staff/native-benefit-fulfillment")
    guard Set(board.rows.map(\.id)).count == board.rows.count else { throw StaffAPIError.invalid }
    benefitBoard = board
    benefitEmployee = actor.employee.id
    benefitUpdated = Date()
    benefitState = "\(board.businessDate)营业日 · 已读取\(board.rows.count)条 · 超过一分钟请刷新"
  }

  func loadMember(_ value: String) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    memberAccount = nil
    memberParticipation = nil
    memberVisit = nil
    memberUpdated = nil
    memberState = "正在读取会员"
    do {
      let code = try MemberCommands.code(value)
      identity = try await api.heartbeat()
      try await fetchMember(code)
    } catch {
      memberState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchMember(_ code: String) async throws {
    guard let actor = identity, actor.allows("loyalty.account.view") else {
      throw CatalogError("当前员工没有会员查询权限")
    }
    let part: MemberParticipation = try await api.data(
      "/api/staff/member-participation/lookup", body: ["code": code])
    let account: MemberAccount = try await api.data(
      "/api/staff/loyalty/accounts?memberNo=" + LiveCommand.pathPart(code))
    let visit: MemberVisitStatus = try await api.data(
      "/api/staff/member-visits/lookup", body: ["code": code])
    guard part.memberNo == code, account.memberNo == code, visit.memberNo == code else {
      throw StaffAPIError.invalid
    }
    memberParticipation = part
    memberAccount = account
    memberVisit = visit
    memberEmployee = actor.employee.id
    memberUpdated = Date()
    memberState = "会员已读取 · " + visit.businessDate + "营业日"
  }
  func loadMemberRewards(status: String = "pending", more: Bool = false) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    memberRewardUpdated = nil
    if !more { memberRewards = nil }
    memberRewardState = "正在读取签到奖励"
    do {
      identity = try await api.heartbeat()
      try await fetchMemberRewards(status: status, more: more)
    } catch {
      memberRewardState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchMemberRewards(status: String, more: Bool = false) async throws {
    guard let actor = identity, actor.allows("loyalty.configuration.view"),
      ["pending", "issued", "rejected", "invalid", "all"].contains(status),
      !more || status == memberRewardFilter && memberRewardEmployee == actor.employee.id
    else { throw CatalogError("请重新选择奖励查询范围并核对权限") }
    let cursor = more ? memberRewards?.nextCursor : nil
    if more && cursor == nil { throw CatalogError("当前没有下一页") }
    var board: MemberRewardBoard = try await api.data(
      "/api/staff/member-visit-rewards?status=" + status
        + (cursor.map { "&cursor=" + LiveCommand.pathPart($0) } ?? ""))
    guard Set(board.items.map(\.id)).count == board.items.count else { throw StaffAPIError.invalid }
    if more, let previous = memberRewards {
      let ids = Set(board.items.map(\.id))
      board.items = previous.items.filter { !ids.contains($0.id) } + board.items
    }
    memberRewards = board
    memberRewardFilter = status
    memberRewardEmployee = actor.employee.id
    memberRewardUpdated = Date()
    memberRewardState = "已读取\(board.items.count)条奖励记录；发券和实物领取分别确认。"
  }

  func loadReservations(_ query: ReservationQuery) async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    reservationUpdated = nil
    reservationCapabilities = nil
    reservationTables = []
    reservations = []
    reservationIntake = []
    clearReservationReceptionReadiness()
    reservationState = "正在读取预约与候位"
    do {
      identity = try await api.heartbeat()
      try await fetchReservations(query)
    } catch {
      reservationState = error.localizedDescription
      handleLiveError(error)
    }
  }
  private func fetchReservations(_ query: ReservationQuery) async throws {
    guard let actor = identity, actor.allows("reservation.view") else {
      throw CatalogError("当前员工没有预约查看权限")
    }
    let path = try query.path
    let queuePath = try query.intakePath
    let rows: [LiveReservation] = try await api.data(path)
    let queue: [LiveReservationIntake] = try await api.data(queuePath)
    guard Set(rows.map(\.id)).count == rows.count, Set(queue.map(\.id)).count == queue.count else {
      throw StaffAPIError.invalid
    }
    var capability: ReservationCapabilities? = try? await api.data(
      "/api/staff/native-reservation-capabilities")
    if capability != nil {
      do {
        let waitlist: WaitlistCapabilities = try await api.data("/api/staff/native-waitlist-capabilities")
        capability?.durableWaitlist = waitlist.durableTransitions
      } catch let failure as StaffAPIError where failure.status == 404 {
        capability?.durableWaitlist = false
      }
    }
    guard actor.employee.id == identity?.employee.id, actor.employee.id == api.identity?.employee.id
    else { throw StaffAPIError.invalid }
    let tables: [ReservationTable] =
      capability?.durableCreate == true && capability?.tableBoundCreate != false && actor.allows("reservation.manage")
      ? try await api.data("/api/staff/native-reservation-tables") : []
    guard Set(tables.map(\.id)).count == tables.count else { throw StaffAPIError.invalid }
    reservationTables = tables
    reservations = rows
    reservationIntake = queue
    reservationCapabilities = capability
    reservationQuery = query
    reservationEmployee = actor.employee.id
    reservationUpdated = Date()
    reservationState =
      "读取\(rows.count)条预约、\(queue.count)条安排；优先队列按所选自然日查询。"
      + (rows.count >= 500 || queue.count >= 1000 ? "已达到读取上限，请缩小日期范围。" : "")
      + (capability == nil ? "当前服务器尚未启用 App 安全操作，可查看记录。" : "")
  }
  func prepareReservation(id: String, action: String, reason: String, override: Bool) throws
    -> LiveCommand
  {
    guard canUseReservations, let row = reservations.first(where: { $0.id == id }),
      let actor = identity
    else { throw CatalogError("预约已过期或权限已变化，请刷新") }
    return try ReservationCommands.transition(
      row, action: action, reason: reason, override: override, actor: actor)
  }
  func prepareWaitlist(id: String, to: String, reason: String) throws -> LiveCommand {
    guard canUseReservations, reservationCapabilities?.durableWaitlist == true,
      let row = reservationIntake.first(where: { $0.id == id }), let actor = identity
    else { throw CatalogError("候位操作尚未启用或数据已过期，请刷新后核对") }
    return try ReservationCommands.waitlist(row, to: to, reason: reason, actor: actor)
  }
  func prepareReservationPriority(id: String, mode: String, reason: String) throws -> LiveCommand {
    guard canUseReservations, reservationCapabilities?.durablePriority == true,
      let row = reservationIntake.first(where: { $0.id == id }), let actor = identity
    else { throw CatalogError("队列已过期或权限已变化，请刷新") }
    return try ReservationCommands.priority(row, mode: mode, reason: reason, actor: actor)
  }

  func loadParticipants(tableID: String) async {
    guard live, !busy, !heartbeatBusy, identity?.allows(ParticipantInput.permission) == true else {
      return
    }
    busy = true
    defer { busy = false }
    resetParticipantPreview()
    participants = []
    participantState = "正在读取顾客名单"
    do {
      identity = try await api.heartbeat()
      try await loadOperations()
      guard let actor = identity, actor.allows(ParticipantInput.permission),
        let table = liveOperations?.tables.first(where: { $0.id == tableID }),
        let session = table.activeSession, session.status == "open"
      else { throw CatalogError("原桌次已结束或权限已变化") }
      let members: [LiveParticipant] = try await api.data(
        "/api/table-management/sessions/" + LiveCommand.pathPart(session.id) + "/participants")
      guard Set(members.map(\.id)).count == members.count else { throw StaffAPIError.invalid }
      participants = members
      participantState = members.isEmpty ? "暂无已识别顾客；仅在全部业务结清后按整桌人数并桌。" : "请当面确认所选顾客，历史账单不会迁移。"
    } catch {
      participantState = error.localizedDescription
      handleLiveError(error)
    }
  }
  func previewParticipants(_ input: ParticipantInput) async {
    guard !busy, !heartbeatBusy, livePending == nil, liveOrderPending == nil,
      identity?.employee.id == input.employeeID
    else { return }
    busy = true
    defer { busy = false }
    resetParticipantPreview()
    participantState = "正在核对未结业务、人数和容量"
    do {
      identity = try await api.heartbeat()
      guard identity?.employee.id == input.employeeID,
        identity?.allows(ParticipantInput.permission) == true
      else { throw CatalogError("原员工或权限已变化") }
      let preview: ParticipantPreview = try await api.data(
        input.path + "/participant-movements/preview", body: input.body)
      participantInput = input
      participantPreview = preview
      participantUpdated = Date()
      participantState =
        preview.supportsNativeParticipantRecovery == true
        ? "预检完成，提交时仍会重新检查" : "当前服务器尚未启用 App 安全拆并桌，请使用网页处理。"
    } catch {
      participantState = error.localizedDescription
      handleLiveError(error)
    }
  }
  func prepareParticipants(confirmed: Bool) throws -> LiveCommand {
    guard canUseParticipants, let input = participantInput, let preview = participantPreview,
      let actor = identity
    else { throw CatalogError("请重新预检并确认现场") }
    let command = try preview.command(input: input, actor: actor, confirmed: confirmed)
    participantPrepared = command
    return command
  }

  func loadLiveOrders(session: String) async {
    liveOrders = []
    guard live, let identity, identity.allows("service.execute") || identity.allows("order.view")
    else {
      orderDetailState = "当前岗位无订单查看权限"
      return
    }
    guard !busy, !heartbeatBusy else {
      orderDetailState = "正在同步，请稍后点击刷新"
      return
    }
    busy = true
    orderDetailState = "正在读取订单"
    defer { busy = false }
    do {
      liveOrders = try await api.data(
        "/api/commerce/table-sessions/\(LiveCommand.pathPart(session))/order-details")
      orderDetailState = liveOrders.isEmpty ? "此桌次暂无订单" : ""
    } catch {
      orderDetailState = "读取失败，请重试"
      handleLiveError(error)
    }
  }

  func liveDraft(_ session: String, replacement: LiveReplacement? = nil) -> [LiveDraftLine] {
    guard live, let employee = identity?.employee.id else { return [] }
    return liveDraftBook.entries[
      LiveDraftBook.key(employee: employee, session: replacement?.draftSession ?? session)] ?? []
  }
  func saveDraftBook(_ book: LiveDraftBook) throws {
    guard !draftStorageDamaged else { throw CatalogError("点单草稿无法读取，请联系管理员检查设备存储") }
    try JSONEncoder().encode(book).write(to: liveDraftURL, options: .atomic)
    liveDraftBook = book
  }
  func addLiveProduct(
    _ product: LiveProduct, choices: [String: [String]], note: String, session: String,
    replacement: LiveReplacement? = nil
  ) throws {
    guard live, let identity, identity.allows("order.create"), !busy,
      livePending == nil && liveOrderPending == nil,
      let updated = catalogUpdated, Date().timeIntervalSince(updated) < 300,
      liveOperations?.tables.contains(where: {
        $0.activeSession?.id == session && $0.activeSession?.status == "open"
      }) == true,
      let latest = liveProducts.first(where: { $0.id == product.id })
    else { throw CatalogError("请刷新商品和桌台后再点单") }
    let line = try LiveDraftLine(product: latest, choices: choices, note: note)
    var book = liveDraftBook
    try book.add(
      line, employee: identity.employee.id, session: replacement?.draftSession ?? session)
    try saveDraftBook(book)
  }
  func removeLiveLine(_ id: String, session: String, replacement: LiveReplacement? = nil) {
    guard let employee = identity?.employee.id, !busy, livePending == nil && liveOrderPending == nil
    else { return }
    var book = liveDraftBook
    let key = LiveDraftBook.key(employee: employee, session: replacement?.draftSession ?? session)
    book.entries[key] = book.entries[key]?.filter { $0.id != id }
    do { try saveDraftBook(book) } catch { message = error.localizedDescription }
  }
  func loadLiveCatalog(replacement: LiveReplacement? = nil) async {
    guard live, identity?.allows("order.create") == true else {
      catalogState = "当前岗位无点单权限"
      return
    }
    guard !busy, !heartbeatBusy else {
      catalogState = "正在同步，请稍后点击刷新"
      return
    }
    busy = true
    liveProducts = []
    catalogUpdated = nil
    catalogState = "正在读取商品"
    defer { busy = false }
    do {
      if replacement != nil { try await loadOperations() }
      let products: [LiveProduct] = try await api.data("/api/catalog/assisted-order-products")
      guard Set(products.map(\.id)).count == products.count else { throw StaffAPIError.invalid }
      liveProducts = products.sorted {
        $0.menuSortOrder == $1.menuSortOrder
          ? $0.code < $1.code : $0.menuSortOrder < $1.menuSortOrder
      }
      catalogUpdated = Date()
      catalogState = products.isEmpty ? "当前无商品" : ""
    } catch {
      catalogState = "读取失败，请重新读取"
      handleLiveError(error)
    }
  }

  func saveOrderPending(_ command: LiveOrderSubmission) throws {
    try command.validate()
    try JSONEncoder().encode(command).write(
      to: orderPendingURL, options: [.atomic, .completeFileProtection])
    var url = orderPendingURL
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    liveOrderPending = command
  }
  func finishLiveOrder(_ command: LiveOrderSubmission) throws {
    guard let receipt = command.receipt, command.canFinish else { throw StaffAPIError.invalid }
    // Remove only the captured units; a repeated local finish cannot delete later additions.
    let key = LiveDraftBook.key(employee: command.employeeID, session: command.draftSession)
    var book = liveDraftBook
    book.entries[key] = book.entries[key]?.filter { !command.draftIDs.contains($0.id) }
    try saveDraftBook(book)
    try FileManager.default.removeItem(at: orderPendingURL)
    liveOrderPending = nil
    lastOrderReceipt = receipt
    message =
      "订单已确认：" + receipt.publicId + " · " + money(receipt.totalAmountMinor) + "。收款状态请在原订单核对。"
  }
  func verifyReplacementReceipt(_ command: LiveOrderSubmission) async throws -> LiveOrderSubmission
  {
    guard let replacement = command.replacement else { return command }
    let board: LiveAfterSales = try await api.data(
      "/api/commerce/item-after-sales/items/\(LiveCommand.pathPart(replacement.itemID))")
    guard command.receipt != nil,
      try replacement.recoveredReceipt(
        board: board, publicID: command.publicId, orderID: command.receipt?.id) != nil
    else {
      throw CatalogError("新单关联尚未核对，已保留原请求，请查询原单，不要重复换品")
    }
    var verified = command
    verified.replacementVerified = true
    return verified
  }
  func sendLiveOrder(_ command: LiveOrderSubmission) async throws {
    var acknowledged = command
    acknowledged.receipt = try await api.submitOrder(command)
    // Persist the creation acknowledgement before secondary reads: a read error
    // can never be mistaken for rejection of an already-created order.
    try saveOrderPending(acknowledged)
    acknowledged = try await verifyReplacementReceipt(acknowledged)
    try saveOrderPending(acknowledged)
    try finishLiveOrder(acknowledged)
  }
  func submitLiveOrder(
    session: String, tableCode: String, expectedDraftIDs: [String], gift: Bool, reason: String,
    note: String, settlement: String, replacement: LiveReplacement? = nil
  ) async {
    guard live, identity?.allows("order.create") == true, !busy, !heartbeatBusy, livePending == nil,
      liveOrderPending == nil, !liveStorageDamaged, !draftStorageDamaged
    else { return }
    let lines = liveDraft(session, replacement: replacement)
    guard lines.map(\.id) == expectedDraftIDs, !lines.isEmpty else {
      message = "清单已变化，请重新核对后提交"
      return
    }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await loadOperations()
      guard let identity,
        liveOperations?.tables.contains(where: {
          $0.activeSession?.id == session && $0.activeSession?.status == "open"
            && $0.code == tableCode
        }) == true
      else { throw CatalogError("桌台已变化，请返回桌台重新核对") }
      var source: LiveAfterSales?
      if let replacement {
        source = try await api.data(
          "/api/commerce/item-after-sales/items/\(LiveCommand.pathPart(replacement.itemID))")
      }
      let access: LiveOrderAccess = try await api.data("/api/commerce/assisted-order-access")
      let products: [LiveProduct] = try await api.data("/api/catalog/assisted-order-products")
      let context: LiveOrderContext = try await api.data(
        "/api/commerce/assisted-order-contexts", body: ["tableSessionId": session])
      let command = try LiveOrderSubmission.make(
        lines: lines, products: products, identity: identity, access: access, context: context,
        session: session, tableCode: tableCode, gift: gift, reason: reason, note: note,
        settlement: settlement, replacement: replacement, source: source)
      try saveOrderPending(command)
      try await sendLiveOrder(command)
      try await loadOperations()
    } catch {
      if var command = liveOrderPending, command.receipt == nil,
        let code = LiveOrderSubmission.initialRejection(error)
      {
        command.rejectedCode = code
        do { try saveOrderPending(command) } catch { liveStorageDamaged = true }
      }
      handleLiveError(error)
    }
  }
  func recoverLiveOrder() async {
    guard let command = liveOrderPending, command.rejectedCode == nil,
      command.employeeID == identity?.employee.id, !busy,
      !heartbeatBusy
    else { return }
    busy = true
    defer { busy = false }
    do {
      if command.receipt != nil {
        var verified = command
        if command.replacement != nil && command.replacementVerified != true {
          identity = try await api.heartbeat()
          guard identity?.employee.id == command.employeeID else { throw StaffAPIError.invalid }
          verified = try await verifyReplacementReceipt(command)
          try saveOrderPending(verified)
        }
        try finishLiveOrder(verified)
        return
      }
      identity = try await api.heartbeat()
      guard let identity, identity.employee.id == command.employeeID else {
        throw StaffAPIError.invalid
      }
      if let replacement = command.replacement {
        let board: LiveAfterSales = try await api.data(
          "/api/commerce/item-after-sales/items/\(LiveCommand.pathPart(replacement.itemID))")
        if let receipt = try replacement.recoveredReceipt(board: board, publicID: command.publicId)
        {
          var confirmed = command
          confirmed.receipt = receipt
          confirmed.replacementVerified = true
          try saveOrderPending(confirmed)
          try finishLiveOrder(confirmed)
          try await loadOperations()
          return
        }
      }
      if command.replacement == nil
        && (identity.allows("service.execute") || identity.allows("order.view"))
      {
        let orders: [LiveOrderDetail] = try await api.data(
          "/api/commerce/table-sessions/\(LiveCommand.pathPart(command.tableSessionID))/order-details"
        )
        if let found = orders.first(where: { $0.publicId == command.publicId }) {
          var confirmed = command
          confirmed.receipt = LiveOrderReceipt(
            publicId: found.publicId, id: nil, totalAmountMinor: found.totalAmountMinor,
            recovered: true)
          try saveOrderPending(confirmed)
          try finishLiveOrder(confirmed)
          try await loadOperations()
          return
        }
      }
      guard command.canReplay(identity) else {
        throw CatalogError("暂未查到原订单。登录会话或营业日已变化，已保留原请求，请由主管按订单号核对；不要重新下单。")
      }
      try await sendLiveOrder(command)
      try await loadOperations()
    } catch { handleLiveError(error) }
  }

  func dismissRejectedOrder() {
    guard let command = liveOrderPending, command.rejectedCode != nil,
      command.employeeID == identity?.employee.id, !busy
    else { return }
    do {
      try FileManager.default.removeItem(at: orderPendingURL)
      liveOrderPending = nil
      catalogUpdated = nil
      lastUpdated = nil
      connection = "请刷新后修改清单"
      message = "订单未创建，原清单已保留。请刷新后修改。"
    } catch { message = "请求记录无法清除，请检查设备空间" }
  }

  private func fetchPaymentOrders(_ session: String) async throws {
    let orders: [LivePaymentOrder] = try await api.data(
      "/api/commerce/table-sessions/\(LiveCommand.pathPart(session))/payment-orders")
    guard orders.allSatisfy({ $0.outstandingAmountMinor >= 0 }),
      Set(orders.map(\.id)).count == orders.count
    else { throw StaffAPIError.invalid }
    paymentOrders = orders
    paymentSession = session
    paymentUpdated = Date()
    paymentState = orders.isEmpty ? "本桌暂无可收款订单" : ""
  }
  func loadPaymentOrders(_ session: String) async {
    guard live, let identity, LivePaymentOrder.permissions.contains(where: identity.allows) else {
      paymentState = "当前岗位无收款查看权限"
      return
    }
    guard !busy, !heartbeatBusy else {
      paymentState = "正在同步，请稍后点击刷新"
      return
    }
    busy = true
    defer { busy = false }
    paymentOrders = []
    onlineAccess = nil
    onlineStatuses = [:]
    onlineState = ""
    paymentSession = nil
    paymentUpdated = nil
    paymentState = "正在读取应收"
    do {
      self.identity = try await api.heartbeat()
      try await loadOperations()
      try await fetchPaymentOrders(session)
    } catch {
      paymentState = "读取失败，金额待核对"
      handleLiveError(error)
    }
  }
  func prepareCollection(
    session: String, ids: Set<String>, amount: Int, provider: String, reference: String,
    terminal: String, method: String, note: String
  ) throws -> LiveCommand {
    guard let identity, paymentSession == session, let updated = paymentUpdated,
      Date().timeIntervalSince(updated) < 60
    else { throw CatalogError("请刷新本桌收款状态后再操作") }
    let orders = paymentOrders.filter { ids.contains($0.id) }
    guard orders.count == ids.count else { throw CatalogError("订单已变化，请重新选择") }
    let command = try LiveCommand.manualCollection(
      orders: orders, actor: identity, amount: amount, provider: provider, reference: reference,
      terminal: terminal, method: method, note: note, session: session)
    guard canAct(command.permission) else { throw CatalogError("请刷新登录和桌台状态后重试") }
    return command
  }

  func fetchFulfillment() async throws {
    guard let actor = identity, canReadFulfillment else { throw CatalogError("当前岗位无出品查看权限") }
    let board: LiveFulfillment = try await api.data("/api/commerce/fulfillment")
    try board.validate(employeeID: actor.employee.id)
    guard identity?.employee.id == actor.employee.id else { throw StaffAPIError.invalid }
    fulfillmentBoard = board
    fulfillmentUpdated = Date()
    fulfillmentState =
      board.actor.supportsNativePhysicalRecovery != true
      ? "服务器尚未启用安全恢复，此处仅查看；请使用原网页操作" : board.actor.actionSessionValid == true ? "" : "请恢复设备登录后继续原任务"
  }
  func loadFulfillment() async {
    guard live, canReadFulfillment, !busy, !heartbeatBusy else { return }
    busy = true
    fulfillmentBoard = nil
    fulfillmentUpdated = nil
    fulfillmentState = "正在读取原出品任务"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchFulfillment()
    } catch {
      fulfillmentState = "读取失败，请刷新后核对原任务"
      handleLiveError(error)
    }
  }
  func prepareFulfillment(
    taskID: String, action: String, quantity: Int, reason: String, confirmed: Bool
  ) throws -> LiveCommand {
    guard canUseFulfillment, let board = fulfillmentBoard, let identity else {
      throw CatalogError("请刷新出品任务及岗位权限")
    }
    return try board.command(
      identity: identity, taskID: taskID, action: action, quantity: quantity, reason: reason,
      confirmed: confirmed)
  }
  func fetchKitchen(_ station: String) async throws {
    guard ["bar", "kitchen"].contains(station), let identity else { throw StaffAPIError.invalid }
    let board: LiveKitchen = try await api.data("/api/commerce/kitchen-board?station=" + station)
    guard board.employeeId == identity.employee.id, board.stationCode == station else {
      throw StaffAPIError.invalid
    }
    kitchenBoard = board
    kitchenUpdated = Date()
    kitchenState = board.actionSessionValid ? "" : "出品会话已失效，请重新登录"
  }
  func loadKitchen(_ station: String) async {
    guard live, identity?.allows("kds.prepare") == true, !busy, !heartbeatBusy else {
      kitchenState = "请先登录出品岗位，或等待当前同步结束后刷新"
      return
    }
    busy = true
    kitchenBoard = nil
    fulfillmentBoard = nil
    fulfillmentUpdated = nil
    kitchenUpdated = nil
    kitchenState = "正在读取制作队列"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchKitchen(station)
    } catch {
      kitchenState = "读取失败，请重新读取"
      handleLiveError(error)
    }
  }
  func prepareKitchen(
    action: String, sourceID: String, quantity: Int = 1, equipment: String = "",
    seconds: Int? = nil, unitIDs: Set<String> = [], selections: [String: Int] = [:]
  ) throws -> LiveCommand {
    guard canAct("kds.prepare"), let board = kitchenBoard, let identity else {
      throw CatalogError("请刷新制作队列后再操作")
    }
    return try board.command(
      actor: identity, action: action, sourceID: sourceID, quantity: quantity, equipment: equipment,
      seconds: seconds, unitIDs: unitIDs, selections: selections)
  }

  func loadKitchenHandoff(_ batchID: String) async -> LiveKitchenHandoff? {
    guard canAct("kds.prepare"), let board = kitchenBoard, board.canHandoff,
      identity?.allows("kds.exception.manage") == true
    else {
      message = "请刷新制作队列并确认接班权限"
      return nil
    }
    busy = true
    defer { busy = false }
    do {
      let preview: LiveKitchenHandoff = try await api.data(
        "/api/commerce/kitchen-board/handoff-preview?station=\(board.stationCode)&batchId=\(LiveCommand.pathPart(batchID))"
      )
      guard preview.anchorBatchId == batchID, preview.stationCode == board.stationCode else {
        throw StaffAPIError.invalid
      }
      return preview
    } catch {
      handleLiveError(error)
      return nil
    }
  }

  func fetchPickup() async throws {
    let board: LivePickup = try await api.data("/api/commerce/pickup-board")
    guard !board.commandScope.isEmpty else { throw StaffAPIError.invalid }
    pickupBoard = board
    pickupUpdated = Date()
    pickupState = board.actor.actionSessionValid ? "" : "设备会话失效，请重新登录"
  }
  func loadPickup() async {
    guard live, let identity,
      identity.allows("kds.deliver") || identity.allows("staff.access.configure"), !busy,
      !heartbeatBusy
    else {
      pickupState = "请先登录取餐岗位，或等待同步结束后刷新"
      return
    }
    busy = true
    history = nil
    historyQuery = HistoryQuery()
    financeSummary = nil
    financeEntries = []
    financeReviews = []
    financeUpdated = nil
    financeActorID = nil
    assignmentsBoard = nil
    assignmentsUpdated = nil
    assignmentsActorID = nil
    assignmentReceipt = ""
    cashier = nil
    cashierUpdated = nil
    pickupBoard = nil
    pickupUpdated = nil
    pickupState = "正在读取取餐台"
    defer { busy = false }
    do {
      self.identity = try await api.heartbeat()
      try await fetchPickup()
    } catch {
      pickupState = "读取失败，请重新读取"
      handleLiveError(error)
    }
  }

  var canReadCashier: Bool {
    identity.map { actor in LiveCashier.permissions.contains(where: actor.allows) } ?? false
  }
  func fetchCashHandover() async throws {
    guard let actor = identity, actor.allows("reconciliation.view") else {
      throw CatalogError("没有现金交接查询权限")
    }
    let (bytes, _) = try await api.raw("/api/commercial-ops/cash-handovers")
    guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let meta = root["meta"] as? [String: Any], meta["protocol"] as? Int == 1,
      let data = root["data"], identity?.employee.id == actor.employee.id
    else { throw StaffAPIError.invalid }
    cashHandover = try JSONDecoder().decode(
      CashHandoverBoard.self, from: JSONSerialization.data(withJSONObject: data))
    cashHandoverActor = actor.employee.id
    cashHandoverUpdated = Date()
    cashHandoverState = "门店全部现金合计；差异与非营业取存独立留痕。最近30次交接。"
  }
  func loadCashHandover() async {
    guard live, !busy, !heartbeatBusy, identity?.allows("reconciliation.view") == true else {
      return
    }
    busy = true
    cashHandoverUpdated = nil
    cashHandoverActor = nil
    cashHandover = nil
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchCashHandover()
    } catch {
      cashHandoverState = "交接读取失败，请核对原记录"
      handleLiveError(error)
    }
  }
  func prepareCashHandover(
    action: String, amount: Int? = nil, direction: String = "in", reference: String = "",
    reason: String, denominations: [String: Int] = [:]
  ) throws -> LiveCommand {
    guard canUseCashHandover, let identity, let board = cashHandover else {
      throw CatalogError("请刷新门店交接与权限")
    }
    return try cashHandoverCommand(
      actor: identity, board: board, action: action, amount: amount, direction: direction,
      reference: reference, reason: reason, denominations: denominations)
  }
  func loadVoucherHistory(_ day: String) async {
    guard live, canReadVouchers, !busy, !heartbeatBusy,
      day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
    else {
      message = "请填写有效营业日 YYYY-MM-DD"
      return
    }
    busy = true
    voucherHistory = []
    voucherHistoryState = "正在查询原核销记录"
    defer { busy = false }
    do {
      let actor = identity?.employee.id
      identity = try await api.heartbeat()
      let rows: [VoucherHistoryRow] = try await api.data(
        "/api/commercial-ops/vouchers?startDate=\(day)&endDate=\(day)")
      guard identity?.employee.id == actor else { throw StaffAPIError.invalid }
      voucherHistory = rows
      voucherHistoryState = "原营业日 \(day)，已加载\(rows.count)条；未关联结算流水不能当作到账。"
    } catch {
      voucherHistoryState = "原记录读取失败，不能视为没有核销"
      handleLiveError(error)
    }
  }
  func fetchVouchers() async throws {
    guard let actor = identity, canReadVouchers else { throw CatalogError("没有核销查询权限") }
    let platforms: [VoucherPlatform] = try await api.data("/api/commercial-ops/vouchers/platforms")
    let (bytes, _) = try await api.raw("/api/commercial-ops/vouchers/operations")
    let page = try JSONDecoder().decode(VoucherOperationsPage.self, from: bytes)
    guard page.meta.protocolVersion == 1, identity?.employee.id == actor.employee.id,
      Set(page.data.map(\.id)).count == page.data.count
    else { throw StaffAPIError.invalid }
    voucherPlatforms = platforms
    voucherOperations = page.data
    voucherActor = actor.employee.id
    voucherUpdated = Date()
    voucherState = "原核销事项已更新，最多100项，未完成优先；核销登记不抵减桌单，不表示平台已结算。"
  }
  func loadVouchers() async {
    guard live, canReadVouchers, !busy, !heartbeatBusy else { return }
    busy = true
    voucherUpdated = nil
    voucherActor = nil
    voucherPreview = nil
    voucherCode = ""
    voucherOperations = []
    voucherPlatforms = []
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchVouchers()
    } catch {
      voucherState = "核销事项读取失败或后台未升级，请核对原券，不重复核销"
      handleLiveError(error)
    }
  }
  func prepareVoucherPreview(platform: String, code: String) async {
    guard canUseVouchers, voucherPlatforms.contains(where: { $0.code == platform && $0.usable }),
      (4...256).contains(code.utf16.count)
    else {
      message = "请选择已开通的正式平台并输入原券码"
      return
    }
    busy = true
    voucherPreview = nil
    voucherCode = ""
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard identity?.allows("commercial.voucher.redeem") == true else {
        throw CatalogError("核销权限已撤销")
      }
      let (bytes, _) = try await api.raw(
        "/api/commercial-ops/vouchers/prepare", body: ["platform": platform, "voucherCode": code])
      guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        let data = root["data"] as? [String: Any]
      else { throw StaffAPIError.invalid }
      let preview = try JSONDecoder().decode(
        VoucherPreview.self, from: JSONSerialization.data(withJSONObject: data))
      guard preview.platform == platform, preview.currency == "CNY" else {
        throw StaffAPIError.invalid
      }
      voucherPreview = preview
      voucherCode = code
      voucherUpdated = Date()
      voucherActor = identity?.employee.id
    } catch { handleLiveError(error) }
  }
  func prepareVoucher(code: String, orderID: String? = nil, sessionID: String? = nil) throws
    -> LiveCommand
  {
    guard canUseVouchers, let identity, let preview = voucherPreview, code == voucherCode,
      let platform = voucherPlatforms.first(where: { $0.code == preview.platform })
    else { throw CatalogError("原券查询已过期或输入已改变，请重新查询") }
    return try voucherRedeem(
      actor: identity, preview: preview, platform: platform, code: code, orderID: orderID,
      sessionID: sessionID, confirmed: true)
  }
  func prepareVoucherAction(
    id: String, action: String, outcome: String = "consumed", certificate: String = "",
    verify: String = "", evidence: String = "", reason: String = "", confirmed: Bool = false
  ) throws -> LiveCommand {
    guard canUseVouchers, let identity, let row = voucherOperations.first(where: { $0.id == id })
    else { throw CatalogError("请刷新原核销事项与权限") }
    return try voucherFollowup(
      actor: identity, row: row, action: action, outcome: outcome, certificate: certificate,
      verify: verify, evidence: evidence, reason: reason, confirmed: confirmed)
  }
  func fetchPrinting() async throws {
    guard let actor = identity, canReadPrinting else { throw CatalogError("没有票据查询权限") }
    var jobs: [LivePrintJob] = []
    var sources: [LivePrintSource] = []
    var own: [LivePrintJob] = []
    if ["print.view", "print.view_all", "print.reprint", "hardware.manage", "printer.manage"]
      .contains(where: { actor.allows($0) })
    {
      jobs = try await api.data("/api/hardware/print-jobs?limit=200")
    }
    if actor.allows("hardware.manage") || actor.allows("printer.manage") {
      sources = try await api.data("/api/hardware/print-sources")
    }
    if actor.allows("order.bill.print"), let receipt = printReceipt,
      receipt.employeeID == actor.employee.id,
      let root = try JSONSerialization.jsonObject(with: receipt.bytes) as? [String: Any],
      let d = root["data"] as? [String: Any], let request = d["requestId"] as? String
    {
      own = try await api.data("/api/hardware/print-requests/" + LiveCommand.pathPart(request))
    }
    guard identity?.employee.id == actor.employee.id, Set(jobs.map(\.id)).count == jobs.count,
      Set(sources.map(\.id)).count == sources.count,
      (jobs + own).allSatisfy({
        ["pending", "printing", "printed", "failed", "dead", "cancelled"].contains($0.status)
      })
    else { throw StaffAPIError.invalid }
    printJobs = jobs
    printSources = sources
    ownPrintJobs = own
    printActor = actor.employee.id
    printUpdated = Date()
    printState = "已读取服务器票据状态；最多200个任务，入队不代表出纸。"
  }
  func loadPrinting() async {
    guard live, !busy, !heartbeatBusy, canReadPrinting else { return }
    busy = true
    printUpdated = nil
    printActor = nil
    printJobs = []
    printSources = []
    ownPrintJobs = []
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchPrinting()
    } catch {
      printState = "票据状态读取失败，请刷新核对"
      handleLiveError(error)
    }
  }
  func preparePrint(kind: String, target: String, reason: String = "", confirmed: Bool = false)
    throws -> LiveCommand
  {
    guard canUsePrinting, let identity else { throw CatalogError("请刷新票据、会话与权限") }
    return try printingCommand(
      actor: identity, kind: kind, target: target, reason: reason,
      job: printJobs.first { $0.id == target }, source: printSources.first { $0.id == target },
      confirmed: confirmed)
  }
  func fetchAfterSales(_ itemID: String) async throws {
    guard let actor = identity, canReadAfterSales else { throw CatalogError("当前岗位无商品售后权限") }
    struct Access: Decodable {
      let employeeId: String
      let enabled, recoveryAvailable: Bool
    }
    let access: Access = try await api.data("/api/commerce/item-after-sales/access")
    guard access.employeeId == actor.employee.id, access.enabled || access.recoveryAvailable else {
      throw CatalogError("当前未开放商品售后，也没有可恢复的原申请")
    }
    let board: LiveAfterSales = try await api.data(
      "/api/commerce/item-after-sales/items/" + LiveCommand.pathPart(itemID))
    try board.validate(itemID: itemID)
    guard identity?.employee.id == actor.employee.id else { throw StaffAPIError.invalid }
    afterSales = board
    afterSalesActor = actor.employee.id
    afterSalesUpdated = Date()
    afterSalesState = ""
  }
  func loadAfterSales(_ itemID: String) async {
    guard live, canReadAfterSales, !busy, !heartbeatBusy else { return }
    busy = true
    afterSalesUpdated = nil
    afterSales = nil
    afterSalesState = "正在读取原商品与资金事实"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchAfterSales(itemID)
    } catch {
      afterSalesState = "读取未完成，不能按旧状态处理"
      handleLiveError(error)
    }
  }
  func loadAfterSalesPending(more: Bool = false) async {
    guard live, canReadAfterSales, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      let cursor = more ? afterSalesCursor : nil
      let page: AfterSalesPending = try await api.data(AfterSalesPending.path(cursor))
      let rows = cursor == nil ? page.items : afterSalesPendingRows + page.items
      guard Set(rows.map(\.id)).count == rows.count,
        page.nextCursor == nil || page.nextCursor != cursor
      else { throw StaffAPIError.invalid }
      afterSalesPendingRows = rows
      afterSalesCursor = page.nextCursor
      afterSalesState = ""
    } catch {
      afterSalesState = "售后待办未能读取，请刷新"
      handleLiveError(error)
    }
  }
  func prepareRemediation(
    action: String, target: String = "", quantity: Int = 0,
    reason: String, confirmed: Bool
  ) throws -> LiveCommand {
    guard canUseAfterSales, let afterSales, let identity else { throw CatalogError("请刷新原商品、会话与权限") }
    return try afterSales.remediationCommand(
      actor: identity, action: action, target: target,
      quantity: quantity, reason: reason, confirmed: confirmed)
  }
  func prepareAfterSales(
    action: String, caseID: String = "", quantity: Int = 0, reason: String,
    funding: [String: Int] = [:], unitIDs: Set<String> = [], refundID: String = "",
    confirmed: Bool = false, receiptReference: String = ""
  ) throws -> LiveCommand {
    guard canUseAfterSales, let afterSales, let identity else {
      throw CatalogError("请刷新原商品、权限与资金状态")
    }
    return try afterSales.command(
      actor: identity, action: action, caseID: caseID, quantity: quantity, reason: reason,
      funding: funding, unitIDs: unitIDs, refundID: refundID, confirmed: confirmed,
      receiptReference: receiptReference)
  }
  func loadOnline(_ session: String) async {
    guard live, identity?.allows("payment.initiate.staff") == true, !busy, !heartbeatBusy else {
      return
    }
    busy = true
    onlineAccess = nil
    paymentUpdated = nil
    onlineState = "正在核对线上收款权限与原单"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      let access: OnlineAccess = try await api.data("/api/commerce/assisted-order-access")
      guard access.employeeId == identity?.employee.id else { throw StaffAPIError.invalid }
      try await fetchPaymentOrders(session)
      onlineAccess = access
      onlineState = ""
    } catch {
      onlineState = "线上收款未就绪，请刷新核对"
      handleLiveError(error)
    }
  }
  func prepareOnline(session: String, ids: Set<String>, amount: Int, method: String, code: String)
    throws -> LiveCommand
  {
    guard canAct("payment.initiate.staff"), paymentSession == session, let actor = identity,
      let access = onlineAccess,
      Set(paymentOrders.filter { ids.contains($0.id) }.map(\.id)) == ids
    else { throw CatalogError("请刷新原桌应收与权限") }
    return try onlinePayment(
      actor: actor, access: access, orders: paymentOrders.filter { ids.contains($0.id) },
      session: session, amount: amount, method: method, code: code)
  }
  func prepareOnlineRelease(session: String, paymentID: String, reason: String) throws
    -> LiveCommand
  {
    guard canAct("payment.initiate.staff"), paymentSession == session, let actor = identity else {
      throw CatalogError("请刷新原桌应收与权限")
    }
    return try onlineRelease(
      actor: actor, orders: paymentOrders, paymentID: paymentID, session: session, reason: reason)
  }
  func pollOnline(_ paymentID: String, session: String) async {
    guard live, identity != nil, !busy, !heartbeatBusy, !onlinePolling, paymentSession == session,
      paymentOrders.contains(where: { $0.unresolvedOnlinePaymentId == paymentID })
        || (onlineReceipts[session]?.paymentID == paymentID
          && onlineReceipts[session]?.employeeID == identity?.employee.id)
    else { return }
    onlinePolling = true
    busy = true
    defer {
      onlinePolling = false
      busy = false
    }
    let actor = identity?.employee.id
    do {
      struct Status: Decodable {
        let id: String
        let status: String
      }
      let result: Status = try await api.data(
        "/api/payments/\(LiveCommand.pathPart(paymentID))/status")
      guard result.id == paymentID,
        ["pending", "succeeded", "failed", "closed"].contains(result.status),
        actor == identity?.employee.id, paymentSession == session
      else { throw StaffAPIError.invalid }
      onlineStatuses[paymentID] = result.status
      onlineState = result.status == "succeeded" ? "服务器已确认原付款；是否结清以当前应收为准" : ""
      if result.status != "pending" { try await fetchPaymentOrders(session) }
    } catch {
      onlineState = "状态未能确认；保留原付款，不把网络错误当作失败"
      handleLiveError(error)
    }
  }
  var canReadFinance: Bool {
    identity?.allows("reconciliation.view") == true
      || identity?.allows("business_day.close") == true
  }
  func fetchFinance(query: FinanceQuery, reviewPage: Int = 0, moreEntries: Bool = false)
    async throws
  {
    guard let actor = identity, canReadFinance, (0...100000).contains(reviewPage) else {
      throw CatalogError("当前岗位没有日结与对账权限")
    }
    _ = try query.path()
    if actor.allows("reconciliation.view") {
      let suffix = query.date.isEmpty ? "" : "?businessDate=" + query.date
      let summary: LiveHistory = try await api.data("/api/operations/history" + suffix)
      let resolved = FinanceQuery(date: summary.businessDate, type: query.type)
      let cursor = moreEntries && resolved == financeQuery ? financeNext : nil
      let (bytes, _) = try await api.raw(try resolved.path(cursor: cursor))
      let page = try JSONDecoder().decode(FinancePage.self, from: bytes)
      try validateFinancePage(page, query: resolved, cursor: cursor)
      let (reviews, _) = try await api.raw("/api/payments/finance-review?page=\(reviewPage)")
      let review = try JSONDecoder().decode(FinanceReviewPage.self, from: reviews)
      guard actor.employee.id == identity?.employee.id,
        Set(review.data.map(\.id)).count == review.data.count
      else { throw StaffAPIError.invalid }
      let merged = cursor == nil ? page.data : financeEntries + page.data
      guard Set(merged.map(\.id)).count == merged.count else {
        throw CatalogError("对账分页发生变化，请重新刷新")
      }
      financeSummary = summary
      financeEntries = merged
      financeNext = page.meta.nextCursor
      financeReviews = review.data
      financeMoreReviews = review.hasMore
      financeReviewPage = reviewPage
      financeQuery = resolved
    } else {
      financeSummary = nil
      financeEntries = []
      financeReviews = []
      financeNext = nil
      financeMoreReviews = false
    }
    financeActorID = actor.employee.id
    financeUpdated = Date()
    financeState = ""
  }
  func loadFinance(query: FinanceQuery? = nil, reviewPage: Int = 0, moreEntries: Bool = false) async
  {
    guard live, canReadFinance, !busy, !heartbeatBusy else { return }
    busy = true
    financeUpdated = nil
    financeState = "正在读取服务器账本"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchFinance(
        query: query ?? financeQuery, reviewPage: reviewPage, moreEntries: moreEntries)
    } catch {
      financeSummary = nil
      financeEntries = []
      financeReviews = []
      financeActorID = nil
      financeState = "读取失败，不能将缺失数据当作零收款"
      handleLiveError(error)
    }
  }
  func prepareFinance(
    rowID: String? = nil, note: String = "", resolve: Bool = false, closeDay: Bool = false
  ) throws -> LiveCommand {
    let permission = closeDay ? "business_day.close" : "reconciliation.manage"
    guard canAct(permission), let actor = identity else { throw CatalogError("权限、会话或账本已过期，请刷新") }
    return try financeCommand(
      actor: actor, row: financeReviews.first { $0.id == rowID }, note: note, resolve: resolve,
      closeDay: closeDay)
  }
  func fetchAssignments() async throws {
    guard let actor = identity else { throw CatalogError("请先登录") }
    let options: LiveAssignments.Options
    if actor.allows(LiveAssignments.permission) {
      options = try await api.data("/api/table-management/assignment-options")
    } else {
      options = .init(employees: [], roles: [])
    }
    let tables: [LiveAssignments.Table] = try await api.data("/api/table-management/tables")
    let assignments: [LiveAssignments.Assignment] = try await api.data(
      "/api/table-management/assignments")
    let mode = assignmentScheduleMode
    let page = assignmentSchedulePage
    let schedule: AssignmentSchedule?
    if options.supportsNativeAssignmentSchedule == true && actor.allows(LiveAssignments.permission) {
      schedule = try await api.data(AssignmentSchedule.path(mode: mode, page: page))
      try schedule?.validate(actorID: actor.employee.id, mode: mode, page: page)
    } else { schedule = nil }
    let result = LiveAssignments(options: options, tables: tables, assignments: assignments,
      schedule: schedule)
    try result.validate()
    guard actor.employee.id == identity?.employee.id else { throw StaffAPIError.invalid }
    assignmentsBoard = result
    assignmentsActorID = actor.employee.id
    assignmentsUpdated = Date()
    assignmentsState = ""
    // The dashboard's responsibility badges must be refreshed before further table actions.
    lastUpdated = nil
  }
  func loadAssignments() async {
    guard live, identity != nil, !busy, !heartbeatBusy else { return }
    busy = true
    if assignmentsActorID != identity?.employee.id {
      financeSummary = nil
      financeEntries = []
      financeReviews = []
      financeUpdated = nil
      financeActorID = nil
      assignmentsBoard = nil
    }
    assignmentsUpdated = nil
    assignmentsActorID = nil
    assignmentReceipt = ""
    assignmentsState = "正在读取责任桌"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchAssignments()
    } catch {
      financeSummary = nil
      financeEntries = []
      financeReviews = []
      financeUpdated = nil
      financeActorID = nil
      assignmentsBoard = nil
      assignmentsState = "未能读取责任桌，请刷新重试"
      handleLiveError(error)
    }
  }
  func loadAssignmentSchedule(mode: String, page: Int = 0) async {
    guard !busy, !heartbeatBusy, AssignmentSchedule.modes.contains(mode), (0...10000).contains(page)
    else { return }
    assignmentScheduleMode = mode
    assignmentSchedulePage = page
    await loadAssignments()
  }
  func prepareAssignmentSchedule(
    id: String, reason: String, change: AssignmentSchedule.Change?
  ) throws -> LiveCommand {
    guard canAct(LiveAssignments.permission), let board = assignmentsBoard, let actor = identity
    else { throw CatalogError("权限、会话或排班数据已过期，请刷新后核对") }
    return try board.changeSchedule(actor: actor, id: id, reason: reason, change: change)
  }
  func prepareAssignment(
    tableIDs: Set<String>, employeeID: String, roleID: String, kind: String, start: Date,
    end: Date?, reason: String
  ) throws -> LiveCommand {
    guard canAct(LiveAssignments.permission), let board = assignmentsBoard, let actor = identity
    else { throw CatalogError("权限、会话或数据已过期，请刷新后核对") }
    return try board.assign(
      actor: actor, tableIDs: tableIDs, employeeID: employeeID, roleID: roleID, kind: kind,
      start: start, end: end, reason: reason)
  }
  func prepareAssignmentEnd(id: String, reason: String) throws -> LiveCommand {
    guard canAct(LiveAssignments.permission), let board = assignmentsBoard, let actor = identity
    else { throw CatalogError("权限、会话或数据已过期，请刷新后核对") }
    return try board.end(actor: actor, id: id, reason: reason)
  }
  func fetchCashier(_ query: String) async throws {
    guard canReadCashier else {
      throw StaffAPIError(status: 403, code: "ACCESS_REVOKED", message: "当前岗位无收银工作台权限")
    }
    let result: LiveCashier = try await api.data(LiveCashier.path(query: query))
    guard Set(result.orders.map(\.id)).count == result.orders.count else {
      throw StaffAPIError.invalid
    }
    cashier = result
    cashierUpdated = Date()
    cashierQuery = query
    cashierState = ""
  }
  func loadCashier(_ query: String = "") async {
    guard live, canReadCashier, !busy, !heartbeatBusy else { return }
    guard query.utf16.count <= 64 else {
      cashierState = "查询内容最多64字"
      return
    }
    busy = true
    financeSummary = nil
    financeEntries = []
    financeReviews = []
    financeUpdated = nil
    financeActorID = nil
    assignmentsBoard = nil
    assignmentsUpdated = nil
    assignmentsActorID = nil
    assignmentReceipt = ""
    cashier = nil
    cashierUpdated = nil
    cashierState = "正在读取收银待办"
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      try await fetchCashier(query.trimmingCharacters(in: .whitespacesAndNewlines))
    } catch {
      cashierState = "未能读取收银数据，请重新查询"
      handleLiveError(error)
    }
  }
  func prepareUnpaid(orderID: String, settle: Bool, reasonCode: String, note: String) throws
    -> LiveCommand
  {
    guard let board = cashier, let actor = identity,
      canAct(settle ? "order.settle_exception" : "order.cancel_unpaid")
    else { throw CatalogError("请刷新原订单与权限") }
    return try board.unpaidCommand(
      actor: actor, orderID: orderID, settle: settle, reasonCode: reasonCode, note: note)
  }
  var canUseActivity: Bool {
    live && !busy && !heartbeatBusy && !liveStorageDamaged && livePending == nil
      && liveOrderPending == nil && identity?.allows("community.activity.cashier") == true
      && cashier?.actions["canUseActivityCashier"] == true
      && cashierUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
      && identity.flatMap { StaffIdentity.date($0.session.onlineLeaseUntil) }.map { $0 > Date() }
        == true
  }
  func prepareActivity(
    registrationID: String, action: String, provider: String = "cash", reference: String = "",
    terminal: String = "", externalMethod: String = "bank_transfer", reason: String = "",
    paymentPublicID: String = "", confirmed: Bool = false
  ) throws -> LiveCommand {
    guard canUseActivity, let cashier, let identity else { throw CatalogError("请刷新活动工作台、会话与权限") }
    return try cashier.activityCommand(
      actor: identity, registrationID: registrationID, action: action, provider: provider,
      reference: reference, terminal: terminal, externalMethod: externalMethod, reason: reason,
      paymentPublicID: paymentPublicID, confirmed: confirmed)
  }
  func prepareCashier(
    orderID: String, paymentID: String, action: String, refundID: String = "",
    amounts: [String: Int] = [:], reason: String = "", purpose: String = "", reference: String = "",
    succeeded: Bool = true
  ) throws -> LiveCommand {
    guard let board = cashier, let actor = identity else { throw CatalogError("请刷新收银工作台") }
    let command = try board.command(
      actor: actor, orderID: orderID, paymentID: paymentID, action: action, refundID: refundID,
      amounts: amounts, reason: reason, purpose: purpose, reference: reference, succeeded: succeeded
    )
    guard canAct(command.permission) else { throw CatalogError("权限、会话或数据已过期，请刷新后核对") }
    return command
  }
  func exportHistory(all: Bool) async -> Data? {
    guard live, canReadHistory, !busy, !heartbeatBusy, let snapshot = history else { return nil }
    let originalQuery = historyQuery
    let page = all ? 0 : snapshot.page
    busy = true
    defer { busy = false }
    do {
      identity = try await api.heartbeat()
      guard canReadHistory else {
        throw StaffAPIError(status: 403, code: "ACCESS_REVOKED", message: "订单查询权限已撤销")
      }
      let result: LiveHistory = try await api.data(
        try originalQuery.exportPath(page: page, all: all))
      try result.validate(page: page)
      return try result.exportCSV()
    } catch {
      handleLiveError(error)
      return nil
    }
  }
  var canReadHistory: Bool {
    identity.map { actor in
      ["reconciliation.view", "order.history.view", "order.history.all"].contains(
        where: actor.allows)
    } ?? false
  }
  func loadHistory(_ query: HistoryQuery = HistoryQuery(), page: Int = 0) async {
    guard live, canReadHistory, !busy, !heartbeatBusy else { return }
    busy = true
    history = nil
    historyState = "正在读取订单"
    defer { busy = false }
    do {
      let path = try query.path(page: page)
      identity = try await api.heartbeat()
      guard canReadHistory else {
        throw StaffAPIError(status: 403, code: "ACCESS_REVOKED", message: "订单查询权限已撤销")
      }
      let result: LiveHistory = try await api.data(path)
      try result.validate(page: page)
      history = result
      historyQuery = query
      historyQuery.date = result.businessDate
      historyQuery.endDate = result.endDate ?? result.businessDate
      historyState = ""
    } catch {
      historyState = "订单未读取成功，请重新查询"
      handleLiveError(error)
    }
  }
  func preparePickup(
    action: String, target: String = "", units: Set<String> = [], label: String = "",
    enabled: Bool = true
  ) throws -> LiveCommand {
    guard canAct(action == "device" ? "staff.access.configure" : "kds.deliver"),
      let board = pickupBoard, let identity
    else { throw CatalogError("请刷新取餐台后再操作") }
    return try board.make(
      actor: identity, action: action, target: target, units: units, label: label, enabled: enabled)
  }

}
