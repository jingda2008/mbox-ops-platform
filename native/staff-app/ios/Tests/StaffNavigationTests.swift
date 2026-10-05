import Foundation

private final class NavigationStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ data: Data) throws { bytes = data }
  func remove() throws { bytes = nil }
}

@main struct StaffNavigationTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ label: String) {
      precondition(condition, label); count += 1; print("PASS \(label)")
    }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf:
      URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let baseAuth = fixture["auth"] as! [String: Any]
    func actor(_ permissions: [String], routes: [String]? = nil, denied: [String] = []) throws -> StaffIdentity {
      var value = baseAuth; value["permissions"] = permissions; value["deniedPermissions"] = denied
      if let routes { value["navigation"] = routes.map { ["route": $0, "label": "不可用标签授予权限", "code": "live"] } }
      else { value.removeValue(forKey: "navigation") }
      let result = try JSONDecoder().decode(StaffIdentity.self, from: JSONSerialization.data(withJSONObject: value))
      try result.validate(); return result
    }
    func tabs(_ identity: StaffIdentity?) -> [StaffDestination] { StaffNavigation.tabs(actor: identity, training: false) }
    check(tabs(nil) == [.more], "signed-out production navigation exposes only account/tools")
    check(StaffNavigation.tabs(actor: nil, training: true) == [.tables, .orders, .cashier, .more],
      "explicit development training retains its isolated tabs")
    let kitchen = try actor(["kds.prepare"], routes: ["/staff/fulfillment"])
    let pickup = try actor(["kds.deliver"], routes: ["/staff/fulfillment"])
    let reader = try actor(["service.view"], routes: ["/staff/tasks"])
    check(tabs(kitchen) == [.kitchen, .more], "kitchen-only employee lands on actual preparation work without dashboard")
    check(tabs(pickup) == [.pickup, .more], "delivery-only employee lands on pickup without dashboard")
    check(tabs(reader) == [.service, .more] && reader.canReadService, "read-only service employee reaches service board")
    let legacy = try actor(["dashboard.view", "reconciliation.view", "kds.prepare"])
    check(legacy.navigation == nil && tabs(legacy) == [.tables, .orders, .cashier, .more],
      "missing old navigation falls back to permissions while retaining four touch targets")
    let narrowed = try actor(legacy.permissions, routes: ["/staff/fulfillment"])
    check(tabs(narrowed) == [.kitchen, .more], "explicit routes narrow otherwise granted table and cashier permissions")
    let empty = try actor(legacy.permissions, routes: [])
    check(empty.navigation != nil && tabs(empty) == [.more] && StaffTool.allCases.allSatisfy { !empty.canOpen($0) },
      "present empty navigation never falls back to broad permissions or More entries")
    check(tabs(try actor(["kds.prepare"], routes: ["/staff/fulfillment"], denied: ["kds.prepare"])) == [.more],
      "explicit permission deny takes precedence over server route")
    check(tabs(try actor([], routes: ["/staff/live", "/staff/payments", "/staff/tasks"])) == [.more],
      "route labels and codes cannot manufacture missing business permissions")
    check(!reader.hasStaffRoute("https://example.invalid/staff/tasks") && !reader.hasStaffRoute("/staff/future"),
      "navigation accepts only locally recognized server route enum")
    check(tabs(try actor(["service.view"], routes: ["/staff/tasks?fake=1", "/staff/tasks/", "https://example.invalid/staff/tasks"])) == [.more],
      "noncanonical route suffixes and external addresses do not grant entry")
    check(StaffNavigation.selected(.tables, actor: kitchen, training: false) == .kitchen,
      "stale selected destination immediately falls back to current authorized workplace")
    check(StaffNavigation.selected(.more, actor: kitchen, training: false) == .more,
      "More remains reachable for login switch and recovery")
    check(kitchen.staffNavigationKey != narrowed.staffNavigationKey && legacy.staffNavigationKey != empty.staffNavigationKey,
      "navigation refresh key includes route presence and current permissions")
    let rich = try actor(["dashboard.view", "order.history.view", "reconciliation.view", "kds.prepare", "kds.deliver", "service.view"])
    check(tabs(rich).count == 4 && rich.canOpen(.kitchen) && rich.canOpen(.pickup) && rich.canOpen(.service),
      "workplaces beyond first three business tabs remain available under More")
    let operation = try actor(["commercial.cost.view"], routes: ["/staff/operations"])
    check(operation.canOpen(.ownerFinance) && !operation.canOpen(.overview), "expense viewer route does not grant profit overview")
    let inventory = try actor(["inventory.count", "catalog.product.manage"], routes: ["/staff/inventory"])
    check(inventory.canOpen(.stockAudit) && inventory.canOpen(.products) && !inventory.canOpen(.ownerFinance),
      "inventory tools use their own route and permissions")
    let mismatchedMember = try actor(["loyalty.account.view"], routes: ["/staff/member-management"])
    check(!mismatchedMember.canOpen(.members), "member account permission cannot borrow unrelated management route")
    check(try actor(["loyalty.configuration.view"], routes: ["/staff/member-management"]).canOpen(.members),
      "member management reader retains its existing member-service entry")
    let settings = try actor(["staff.access.configure"], routes: ["/staff/settings"])
    check(settings.canOpen(.pickup) && tabs(settings) == [.more], "authorized device configuration remains in More without delivery authority")
    check(reader.canOpen(.assignments), "service worker can still query personal responsibilities through own workplace route")
    let printer = try actor(["print.view"], routes: ["/staff/devices"])
    let voucherReader = try actor(["commercial.voucher.view"], routes: ["/staff/payments"])
    check(tabs(printer) == [.more] && printer.canOpen(.printing),
      "print-only role keeps existing print records through More when cashier is hidden")
    check(tabs(voucherReader) == [.more] && voucherReader.canOpen(.vouchers),
      "voucher-only role keeps existing redemption records without cashier permission")
    check(!printer.canOpen(.vouchers) && !voucherReader.canOpen(.printing),
      "read-only tool routes cannot borrow another tool permission")
    check(try actor(["loyalty.account.view"], routes: ["/staff/member-accounts"]).canOpen(.benefitWallet)
      && !mismatchedMember.canOpen(.benefitWallet),
      "member wallet retains account-view permission and its own account route")
    check(try actor(["member.card.manage"], routes: ["/staff/member-management"]).canOpen(.memberCards)
      && actor(["loyalty.policy.publish"], routes: ["/staff/member-rule-publish"]).canOpen(.memberCards),
      "card management and card-rule publisher follow their respective canonical routes")
    check(try !actor(["member.card.manage"], routes: ["/staff/member-rule-publish"]).canOpen(.memberCards)
      && !actor(["loyalty.policy.publish"], routes: ["/staff/member-management"]).canOpen(.memberCards),
      "card routes cannot borrow an unrelated permission")
    check(try actor(["printer.manage"], routes: ["/staff/devices"]).canOpen(.deviceManagement)
      && !printer.canOpen(.deviceManagement), "print record read permission cannot edit printer configuration")
    check(try actor(["bottle.manage.all"], routes: ["/staff/inventory"]).canOpen(.bottleStorage)
      && !actor(["bottle.manage.all"], routes: ["/staff/member-management"]).canOpen(.bottleStorage), "bottle custody uses actual inventory route")
    check(try actor(["loyalty.configuration.view", "loyalty.policy.publish"], routes: ["/staff/member-rule-publish"]).canOpen(.membershipConfig)
      && !actor(["loyalty.policy.publish"], routes: ["/staff/member-rule-publish"]).canOpen(.membershipConfig), "rule publishing route still requires configuration read authority")
    check(try actor(["loyalty.configuration.view"], routes: ["/staff/member-management"]).canOpen(.memberGifts)
      && !actor(["loyalty.policy.publish"], routes: ["/staff/member-rule-publish"]).canOpen(.memberGifts), "gift viewing retains its separate read grant")
    check(try actor(["loyalty.policy.view"], routes: ["/staff/member-overview"]).canOpen(.membershipOverview)
      && actor(["member.card.manage"], routes: ["/staff/member-management"]).canOpen(.memberNumber), "published overview and member number use distinct server routes")
    check(try actor(["customer.membership.merge.approve"], routes: ["/staff/member-management"]).canOpen(.membershipRecovery)
      && !actor(["member.card.manage"], routes: ["/staff/member-management"]).canOpen(.membershipRecovery), "history recovery cannot borrow ordinary card administration")
    check(try actor(["performance.phase.manage"], routes: ["/staff/performance"]).canOpen(.show)
      && !actor(["performance.phase.manage"], routes: ["/staff/performance"]).canOpen(.showRequests), "performance phase authority does not grant song queue reading")
    check(try actor(["song.view"], routes: ["/staff/performance"]).canOpen(.showRequests), "song read employee reaches the real song queue")
    check(settings.canOpen(.staffSettings) && !settings.canOpen(.commerceSettings) && !settings.canOpen(.tableSettings), "staff administrator cannot borrow payment or table configuration capabilities")
    check(try actor(["customer.experience.feature.manage"], routes: ["/staff/customer-experience"]).canOpen(.publicationSettings)
      && !actor(["customer.experience.feature.manage"], routes: ["/staff/settings"]).canOpen(.publicationSettings), "customer contact configuration uses its actual experience route")
    check(try NativeManagementModule.recommendations.available(to: actor(["recommendation.rule.view"], routes: ["/staff/customer-experience"]))
      && !NativeManagementModule.recommendations.available(to: actor(["recommendation.rule.publish"], routes: ["/staff/customer-experience"])), "recommendation management requires its server read grant even for publishers")
    check(try NativeManagementModule.homeContent.available(to: actor(["community.activity.view"], routes: ["/staff/customer-experience"]))
      && !NativeManagementModule.launchPopup.available(to: actor(["community.activity.view"], routes: ["/staff/customer-experience"])), "home content reading does not grant popup editing")
    check(try actor(["refund.request", "inventory.receive"], routes: ["/staff/payments"]).canOpen(.remakeHandover)
      && !actor(["refund.request"], routes: ["/staff/payments"]).canOpen(.remakeHandover), "inventory handover has a direct entry without KDS authority and retains both grants")
    check(try actor(["order.history.view"], routes: ["/staff/orders"]).canOpen(.fulfillmentHistory)
      && !actor(["kds.deliver"], routes: ["/staff/fulfillment"]).canOpen(.fulfillmentHistory), "fulfillment history keeps original history read permission and route")
    check(try actor(["commercial.sales.view"], routes: ["/staff/operations"]).canOpen(.businessReports)
      && !actor(["commercial.sales.view"], routes: ["/staff/customer-experience"]).canOpen(.businessReports), "employee sales belongs to operations route and its own read permission")
    check(try actor(["recommendation.analytics.view", "product.observation.analytics.view"], routes: ["/staff/customer-experience"]).canOpen(.businessReports)
      && !actor(["recommendation.analytics.view"], routes: ["/staff/customer-experience"]).canOpen(.businessReports), "experience route requires both analytics permissions")
    check(try actor(["loyalty.configuration.view"], routes: ["/staff/member-management"]).canOpen(.couponCalendars)
      && actor(["loyalty.configuration.view"], routes: ["/staff/member-management"]).canOpen(.stackingPolicies)
      && !actor(["loyalty.policy.publish"], routes: ["/staff/member-management"]).canOpen(.couponCalendars), "calendar and stacking entry requires actual configuration read without inferring from publish")
    check(try actor(["loyalty.redemption.exception"], routes: ["/staff/member-exceptions"]).canOpen(.benefitExceptions)
      && !actor(["loyalty.redemption.exception"], routes: ["/staff/member-fulfillment"]).canOpen(.benefitExceptions), "benefit exception belongs to original exception route")
    check(try actor(["loyalty.accrual.exception.view"], routes: ["/staff/member-exceptions"]).canOpen(.loyaltySupplements)
      && !actor(["loyalty.accrual.exception.view"], routes: ["/staff/member-exceptions"]).canOpen(.loyaltyRefunds), "supplement reading alone does not grant refund reconciliation")
    check(try actor(["loyalty.accrual.exception.view", "reconciliation.view"], routes: ["/staff/member-exceptions"]).canOpen(.loyaltyRefunds), "refund reconciliation requires both original read grants")
    check(try actor(["order.history.view"], routes: ["/staff/fulfillment"]).canOpen(.fulfillmentHistory)
      && actor(["reconciliation.view"], routes: ["/staff/payments"]).canOpen(.fulfillmentHistory), "permitted fulfillment/payment岗位 can directly reach original read-only history")
    check(try actor(["privacy.contact.retention.view"], routes: ["/staff/customer-experience"]).canOpen(.contactGovernance),
      "contact governance reader retains authorized customer experience entry")
    check(try !actor(["privacy.contact.retention.view"], routes: ["/staff/settings"]).canOpen(.contactGovernance)
      && !actor(["privacy.contact.legal_hold"], routes: ["/staff/customer-experience"]).canOpen(.contactGovernance),
      "contact legal hold alone and unrelated route cannot grant governance reader entry")
    check(try actor(["loyalty.annual-benefit.view"], routes: ["/staff/member-management"]).canOpen(.annualPolicies),
      "annual policy reader has the existing member-management route")
    check(try !actor(["loyalty.annual-benefit.view"], routes: ["/staff/member-accounts"]).canOpen(.annualPolicies)
      && !actor(["loyalty.annual-benefit.manage"], routes: ["/staff/member-management"]).canOpen(.annualPolicies),
      "annual write permission or another member route cannot substitute for current read access")
    let source = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
    let regex = try NSRegularExpression(pattern: "route:\\s*['\"](/staff/[^'\"]+)['\"]")
    let serverRoutes = Set(regex.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match -> String? in
      Range(match.range(at: 1), in: source).map { String(source[$0]) }
    })
    check(!serverRoutes.isEmpty && serverRoutes == StaffNavigation.knownRoutes,
      "native canonical route enum exactly matches current server module contract")

    // Exercise real AppModel/StaffAPI auth and board loading. No test reaches
    // network or reads the user's business files.
    var currentAuth = try JSONSerialization.jsonObject(with: JSONEncoder().encode(reader)) as! [String: Any]
    var requests: [URLRequest] = []
    let store = NavigationStore()
    let api = StaffAPI(transport: { request in
      requests.append(request)
      let path = request.url!.path
      let data: Any
      if path == "/api/auth/device-access" {
        data = ["businessDate": "2026-10-05", "expiresAt": "2099-01-01T00:00:00Z"]
      } else if path == "/api/native-service-center" {
        data = fixture["board"]!
      } else {
        guard ["/api/auth/login", "/api/auth/switch", "/api/auth/heartbeat"].contains(path) else {
          preconditionFailure("unexpected read: \(path)")
        }
        data = currentAuth
      }
      return (try JSONSerialization.data(withJSONObject: ["data": data]),
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
          headerFields: ["Set-Cookie": "__Host-mbox_staff_session=nav-test; Path=/; Secure; HttpOnly"])!)
    }, store: store)
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    check(model.live && model.identity == nil && model.world.tables.isEmpty && model.world.products.isEmpty,
      "production model starts at empty signed-out live workspace instead of training data")
    model.train()
    check(model.live && model.world.tables.isEmpty, "production cannot enter training through model method")
    model.pending = Command(kind: "open", tableID: "training-table", expectedSession: nil, people: 2)
    await model.grantDevice("local-test-device-credential")
    check(model.deviceReady && requests.last?.url?.path == "/api/auth/device-access",
      "legacy training pending cannot block real device grant")
    await model.login(code: "staff", pin: "1234")
    check(model.identity?.employee.id == reader.employee.id && model.pending != nil,
      "legacy training pending cannot block real login or overwrite the preserved training request")
    check(!requests.contains(where: { $0.url?.path == "/api/operations" }) && model.liveOperations == nil,
      "least-privilege service login does not call dashboard endpoint")
    await model.loadService()
    check(model.serviceBoard?.currentEmployeeId == reader.employee.id && !model.serviceBoard!.tasks.isEmpty,
      "actual AppModel loads native service board for service.view-only identity")
    check(!model.canUseService, "read-only board never becomes a service command permission")
    var rejectedWrite = false
    do { _ = try model.prepareService(id: model.serviceBoard!.tasks[0].id,
      action: "complete", note: "test", employee: "", priority: "normal") }
    catch { rejectedWrite = true }
    check(rejectedWrite && !requests.contains(where: { $0.url?.path.hasPrefix("/api/native-service-tasks") == true }),
      "read-only service cannot prepare or send task completion")
    let workspace = model.workspaceVersion
    currentAuth["navigation"] = []
    await model.heartbeat()
    check(model.workspaceVersion > workspace && model.serviceBoard == nil && tabs(model.identity) == [.more],
      "fresh route withdrawal clears stale service page even when permission set stays equal")

    let foreign = LiveCommand(id: "original-live-request", employeeID: "original-other-employee",
      title: "original", permission: "table.open", steps: [.init(path: "/api/table-management/sessions/open",
        body: Data("{}".utf8), keyHeader: "x-idempotency-key", key: "original-live-key")])
    model.livePending = foreign
    let prior = requests.count
    await model.login(code: "staff", pin: "1234")
    check(requests.count == prior && model.livePending == foreign,
      "actual live pending still blocks switching an authenticated employee")
    model.lockLiveSession()
    await model.login(code: "staff", pin: "1234")
    check(model.identity == nil && api.identity == nil && model.livePending == foreign,
      "signed-out wrong employee cannot take over original live pending during login")
    model.livePending = nil
    let order = LiveOrderSubmission(key: "original-order-key", publicId: "original-public-order",
      employeeID: foreign.employeeID, authSessionID: "original-auth-session", tableSessionID: "original-table-session",
      tableCode: "T1", createdAt: Date(), draftIDs: ["original-draft"], body: Data("{}".utf8), token: "original-context")
    model.liveOrderPending = order
    await model.login(code: "staff", pin: "1234")
    check(model.identity == nil && api.identity == nil && model.liveOrderPending?.key == order.key,
      "original order pending retains employee/key protection during production login")
    model.liveOrderPending = nil

    // Old saved credentials may omit navigation, but the running model is not
    // allowed to use those routes until the fresh heartbeat returns.
    let saved = SavedStaffSession(version: 1, identity: legacy, device: nil,
      cookies: [.init(name: "__Host-mbox_staff_session", value: "saved-test", expiresAt: Date().addingTimeInterval(3600))])
    let restoreStore = NavigationStore(); restoreStore.bytes = try JSONEncoder().encode(saved)
    var held: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    var heldRequest: URLRequest?
    let restoreAPI = StaffAPI(transport: { request in
      heldRequest = request
      return try await withCheckedThrowingContinuation { held = $0 }
    }, store: restoreStore)
    let restoring = AppModel(api: restoreAPI, loadPersistedState: false, trainingAllowed: false)
    restoring.pending = model.pending
    let restoration = Task { await restoring.restoreRememberedSession() }
    while held == nil { await Task.yield() }
    check(restoring.identity == nil && tabs(restoring.identity) == [.more],
      "old saved navigation cannot unlock workplace while heartbeat is pending")
    held!.resume(returning: (try JSONSerialization.data(withJSONObject: ["data": currentAuth]),
      HTTPURLResponse(url: heldRequest!.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!))
    await restoration.value
    check(restoring.identity?.navigation?.isEmpty == true && tabs(restoring.identity) == [.more],
      "fresh explicit empty routes replace missing saved-navigation fallback")
    check(restoring.identity != nil && restoring.pending != nil,
      "training pending does not block fresh remembered-session restore")
    #if DEBUG
      check(NativeBuildPolicy.allowsTraining, "DEBUG build alone permits training by default")
    #else
      check(!NativeBuildPolicy.allowsTraining, "release compilation disables training by default")
    #endif
    print("\(count) staff navigation checks passed")
  }
}
