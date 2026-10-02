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
  @Published var identity: StaffIdentity?
  @Published var deviceReady = false
  @Published var connection = "本机演练"
  @Published var lastUpdated: Date?
  @Published var liveOperations: LiveOperations?
  @Published var workspaceVersion = 0
  let api = StaffAPI(store: KeychainStaffSessionStore())
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
  @Published var productBoard: ProductManagementBoard?
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
    let board: ProductManagementBoard = try await api.data(
      "/api/native/catalog/products?status=all&limit=40&offset=\(productOffset)&search=" + encoded)
    guard board.durableProducts, board.currentEmployeeId == actor.employee.id,
      identity?.employee.id == actor.employee.id,
      Set(board.products.map(\.id)).count == board.products.count
    else { throw StaffAPIError.invalid }
    productBoard = board
    productUpdated = Date()
    productState = "已同步商品；共显示\(board.products.count)项，按页查询全部状态。"
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
  @Published var stockDraft: [StockLine] = []
  @Published var stockReceipt: StockSavedReceipt?
  private var stockEmployee: String?
  private var stockUpdated: Date?
  private let stockDraftURL = URL.documentsDirectory.appending(path: "mbox-stock-drafts-v1.json")
  private let stockReceiptURL = URL.documentsDirectory.appending(path: "mbox-stock-receipt-v1.json")
  var canUseStock: Bool {
    memberReady && stockBoard?.nativeCommands == true && stockEmployee == identity?.employee.id
      && stockUpdated.map { (0..<60).contains(Date().timeIntervalSince($0)) } == true
  }
  func loadStock() async {
    guard live, !busy, !heartbeatBusy else { return }
    busy = true
    defer { busy = false }
    stockBoard = nil
    stockUpdated = nil
    stockState = "正在读取库存与采购单"
    do {
      identity = try await api.heartbeat()
      try await fetchStock()
    } catch {
      stockState =
        (error as? StaffAPIError)?.status == 404
        ? "当前服务器尚未启用原生库存，请继续使用网页库存入口。" : error.localizedDescription
      handleLiveError(error)
    }
  }
  private func stockBook() throws -> [String: [StockLine]] {
    guard FileManager.default.fileExists(atPath: stockDraftURL.path) else { return [:] }
    return try JSONDecoder().decode(
      [String: [StockLine]].self, from: Data(contentsOf: stockDraftURL))
  }
  func saveStockDraft(_ lines: [StockLine]) throws {
    guard canUseStock, let actor = identity, actor.allows("inventory.receive") else {
      throw CatalogError("请刷新库存并核对员工权限")
    }
    var book = try stockBook()
    book[actor.employee.id] = lines
    try JSONEncoder().encode(book).write(to: stockDraftURL, options: .atomic)
    stockDraft = lines
  }
  private func fetchStock() async throws {
    guard let actor = identity, StockBoard.permissions.contains(where: actor.allows) else {
      throw CatalogError("当前岗位没有库存权限")
    }
    let board: StockBoard = try await api.data("/api/native/inventory")
    guard board.currentEmployeeId == actor.employee.id, board.nativeCommands,
      Set(board.items.map(\.id)).count == board.items.count
    else { throw StaffAPIError.invalid }
    let draft = try stockBook()[actor.employee.id] ?? []
    stockBoard = board
    stockEmployee = actor.employee.id
    stockDraft = draft
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
  private let livePendingURL = URL.documentsDirectory.appending(path: "mbox-live-pending-v1.json")
  @Published private var heartbeatBusy = false
  private let deviceKey: String = {
    if let saved = UserDefaults.standard.string(forKey: "native-device-key") { return saved }
    let key = "ios-" + UUID().uuidString
    UserDefaults.standard.set(key, forKey: "native-device-key")
    return key
  }()
  init() {
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
    guard FileManager.default.fileExists(atPath: livePendingURL.path) else { return }
    do {
      livePending = try JSONDecoder().decode(
        LiveCommand.self, from: Data(contentsOf: livePendingURL))
      if let saved = livePending,
        saved.steps.isEmpty || !(0...saved.steps.count).contains(saved.completedSteps)
      {
        throw StaffAPIError.invalid
      }
    } catch {
      message = "未决操作记录无法读取，真实写操作已锁定，请联系管理员"
      liveStorageDamaged = true
    }
  }
  @Published var liveStorageDamaged = false
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
    guard !busy, !heartbeatBusy, identity == nil, livePending == nil && liveOrderPending == nil,
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
      message = granted ? "相机权限已开启；扫码识别尚未接入，请手动输入桌号。" : "相机未授权，可手动输入桌号；也可前往系统设置开启。"
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
        self.message = granted ? "麦克风与语音识别权限已开启；录音识别尚未接入，请使用键盘。" : "麦克风未授权，可使用键盘输入"
      }
    }
  }
  func grantDevice(_ credential: String) async {
    guard !busy, identity == nil, pending == nil else { return }
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
    guard !restoreAttempted || retry, identity == nil, !busy, !heartbeatBusy, pending == nil else {
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
  func login(code: String, pin: String) async {
    guard !busy, !heartbeatBusy, pending == nil,
      identity == nil || (livePending == nil && liveOrderPending == nil)
    else {
      return
    }
    busy = true
    defer { busy = false }
    do {
      api.rememberSession = rememberLogin
      let auth = try await api.login(code: code, pin: pin, switching: identity != nil)
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
    do {
      try await api.logout()
      lockLiveSession()
      message = "已退出员工账号"
    } catch { handleLiveError(error) }
  }
  func lockLiveSession() {
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
  func handleLiveError(_ error: Error) {
    if let apiError = error as? StaffAPIError, apiError.loginRequired {
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
    if !identity.allows("order.create") {
      liveProducts = []
      catalogUpdated = nil
    }
    if !identity.canReadTables {
      serviceAttention = ServiceAttention()
      liveOperations = nil
      world = World(tables: [], products: [])
      connection = "当前岗位无桌台权限"
      return
    }
    let result: LiveOperations = try await api.data("/api/operations")
    guard result.actor.id == identity.employee.id else {
      throw StaffAPIError(status: 401, code: "IDENTITY_CHANGED", message: "员工身份已变化，请重新登录")
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
    if let proof = command.steps.first?.reservationProof {
      return command.steps.count == 1 && canUseReservations
        && (proof["kind"] as? String == "create"
          ? reservationCapabilities?.durableCreate == true
          : proof["kind"] as? String == "transition"
            ? reservations.contains { $0.id == proof["id"] as? String }
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
    if command.steps.first?.productManagementProof != nil {
      return command.steps.count == 1 && canUseProducts
    }
    if command.steps.first?.stockAuditProof != nil {
      return command.steps.count == 1 && canUseStockAudit
        && identity?.allows(command.permission) == true
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
    if let proof = command.steps.first?.afterSalesProof {
      return command.steps.count == 1 && canUseAfterSales
        && identity?.allows(command.permission) == true
        && proof["itemId"] as? String == afterSales?.item.id
    }
    return canAct(command.permission)
  }
  func executeLive(_ command: LiveCommand) async {
    guard canExecuteLive(command) else {
      message = "操作条件已变化，请刷新后重试"
      return
    }
    do {
      if command.steps.contains(where: {
        ["/api/payments/manual", "/api/payments/manual/closed-debt"].contains($0.path)
      }) {
        paymentUpdated = nil
        paymentState = "请核对原收款结果后刷新账单"
      }
      let secured = try secureVoucherCommand(
        secureOnlineCommand(command, store: PaymentSecrets.store), store: PaymentSecrets.store)
      try JSONEncoder().encode(secured).write(to: livePendingURL, options: .atomic)
      livePending = secured
      await recoverLive()
    } catch { message = "原请求未能保存，未发送操作，请检查设备空间" }
  }
  func recoverLive() async {
    guard let command = livePending, !busy, !heartbeatBusy, !liveStorageDamaged else { return }
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
      identity = try await api.heartbeat()
      guard
        current.completedSteps == current.steps.count
          || identity?.allows(current.permission) == true
      else {
        throw StaffAPIError(status: 403, code: "ACCESS_REVOKED", message: "操作权限已撤销，请联系管理员核对原请求")
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

          } else if step.voucherProof != nil {
            try await performVoucherStep(
              step, read: { path in try await self.api.raw(path).0 },
              send: { body in
                try await self.api.raw(step.path, body: body, headers: [step.keyHeader: step.key]).0
              }, secret: PaymentSecrets.read)
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
        },
        checkpoint: { next in
          try JSONEncoder().encode(next).write(to: self.livePendingURL, options: .atomic)
          self.livePending = next
        })
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
      } else if current.steps.first?.productManagementProof != nil {
        try await fetchProducts()
      } else if let proof = current.steps.first?.stockProof {
        if proof["kind"] as? String == "create", let original = proof["draftFingerprint"] as? String
        {
          var book = try stockBook()
          if let data = Data(base64Encoded: original),
            let lines = try? JSONDecoder().decode([StockLine].self, from: data),
            book[current.employeeID] == lines
          {
            book[current.employeeID] = []
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
      if let key = current.steps.first?.voucherProof?["voucherSecretKey"] as? String {
        PaymentSecrets.remove(key)
      }
      if let key = current.steps.first?.onlineProof?["authCodeKey"] as? String {
        PaymentSecrets.remove(key)
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
        current.rejected = true
        do {
          try JSONEncoder().encode(current).write(to: livePendingURL, options: .atomic)
          livePending = current
        } catch { liveStorageDamaged = true }
      }
      handleLiveError(error)
    }
  }
  func dismissRejectedLive() {
    guard let command = livePending, command.rejected, command.employeeID == identity?.employee.id,
      !busy
    else { return }
    resetParticipantPreview()
    do {
      try FileManager.default.removeItem(at: livePendingURL)
      livePending = nil
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
    overview = nil
    overviewState = "请读取经营概览"
    stockCounts = nil
    stockWaste = nil
    stockAuditUpdated = nil
    stockCountDraft = []
    stockAuditState = "请读取盘点与报损"
    productBoard = nil
    productUpdated = nil
    productState = "请读取商品"
    stockBoard = nil
    stockUpdated = nil
    stockEmployee = nil
    stockDraft = []
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
    guard let actor = identity, actor.allows("service.execute") else {
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
    let capability: ReservationCapabilities? = try? await api.data(
      "/api/staff/native-reservation-capabilities")
    let tables: [ReservationTable] =
      capability?.durableCreate == true && actor.allows("reservation.manage")
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
    confirmed: Bool = false
  ) throws -> LiveCommand {
    guard canUseAfterSales, let afterSales, let identity else {
      throw CatalogError("请刷新原商品、权限与资金状态")
    }
    return try afterSales.command(
      actor: identity, action: action, caseID: caseID, quantity: quantity, reason: reason,
      funding: funding, unitIDs: unitIDs, refundID: refundID, confirmed: confirmed)
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
    let result = LiveAssignments(options: options, tables: tables, assignments: assignments)
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
