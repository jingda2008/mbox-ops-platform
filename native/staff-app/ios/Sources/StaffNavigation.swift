import Foundation

/// Training is a development tool, not the default experience of a release app.
/// AppModel receives this default explicitly so tests can cover both modes.
enum NativeBuildPolicy {
  static var allowsTraining: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }
}

enum StaffDestination: Int, CaseIterable, Identifiable {
  case tables = 0, orders = 1, cashier = 2, more = 3, kitchen = 4, pickup = 5, service = 6
  var id: Int { rawValue }
  var title: String {
    switch self {
    case .tables: return "桌台"
    case .orders: return "订单"
    case .cashier: return "收银"
    case .more: return "更多"
    case .kitchen: return "制作"
    case .pickup: return "取餐"
    case .service: return "服务"
    }
  }
  var icon: String {
    switch self {
    case .tables: return "square.grid.2x2"
    case .orders: return "list.bullet.rectangle"
    case .cashier: return "creditcard"
    case .more: return "line.3.horizontal"
    case .kitchen: return "flame"
    case .pickup: return "tray.and.arrow.up"
    case .service: return "checklist"
    }
  }
  func available(to actor: StaffIdentity) -> Bool {
    switch self {
    case .tables: return actor.canReadTables && actor.hasStaffRoute("/staff/live")
    case .orders:
      return ["order.history.view", "order.history.all", "reconciliation.view"].contains(where: actor.allows)
        && actor.hasStaffRoute("/staff/orders")
    case .cashier:
      return LiveCashier.permissions.contains(where: actor.allows) && actor.hasStaffRoute("/staff/payments")
    case .kitchen: return actor.allows("kds.prepare") && actor.hasStaffRoute("/staff/fulfillment")
    case .pickup: return actor.allows("kds.deliver") && actor.hasStaffRoute("/staff/fulfillment")
    case .service: return actor.canReadService && actor.hasStaffRoute("/staff/tasks")
    case .more: return true
    }
  }
}

enum StaffTool: String, CaseIterable {
  case marketing, contactGovernance, annualPolicies, stockAudit, overview, ownerFinance, products, stock, service, members, benefits, businessReports, couponCalendars, stackingPolicies, benefitExceptions, loyaltySupplements, loyaltyRefunds
  case reservations, assignments, fulfillment, kitchen, pickup, printing, vouchers, benefitWallet, memberCards, deviceManagement, bottleStorage, membershipConfig, memberGifts, membershipOverview, memberNumber, membershipRecovery, show, showRequests, staffSettings, tableSettings, commerceSettings, publicationSettings, remakeHandover, fulfillmentHistory
  func available(to actor: StaffIdentity) -> Bool {
    func grant(_ route: String, _ permissions: [String]) -> Bool {
      actor.hasStaffRoute(route) && permissions.contains(where: actor.allows)
    }
    switch self {
    case .marketing: return grant("/staff/member-management", marketingAreas.map { $0.2 })
    case .contactGovernance: return grant("/staff/customer-experience", ["privacy.contact.retention.view"])
    case .annualPolicies: return grant("/staff/member-management", ["loyalty.annual-benefit.view"])
    case .stockAudit:
      return grant("/staff/inventory", ["inventory.count", "inventory.waste", "inventory.count.approve"])
    case .businessReports: return NativeBusinessReportKind.allCases.contains { $0.available(to: actor) }
    case .couponCalendars, .stackingPolicies: return grant("/staff/member-management", ["loyalty.configuration.view"])
    case .benefitExceptions: return grant("/staff/member-exceptions", ["loyalty.redemption.exception"])
    case .loyaltyRefunds: return actor.hasStaffRoute("/staff/member-exceptions") && actor.allows("reconciliation.view") && actor.allows("loyalty.accrual.exception.view")
    case .loyaltySupplements: return grant("/staff/member-exceptions", ["loyalty.accrual.exception.view"])
    case .overview: return grant("/staff/operations", ["commercial.profit.view"])
    case .ownerFinance: return grant("/staff/operations", ownerFinancePermissions)
    case .products: return grant("/staff/inventory", ["catalog.product.manage"])
    case .stock: return grant("/staff/inventory", StockBoard.permissions)
    case .service: return actor.canReadService && actor.hasStaffRoute("/staff/tasks")
    case .members:
      return grant("/staff/member-accounts", ["loyalty.account.view"])
        || grant("/staff/member-management", ["loyalty.configuration.view"])
    case .benefits: return grant("/staff/member-fulfillment", ["loyalty.redemption.fulfill"])
    case .benefitWallet: return grant("/staff/member-accounts", ["loyalty.account.view"])
    case .memberCards: return grant("/staff/member-management", ["member.card.manage", "member.card.review"])
        || grant("/staff/member-rule-publish", ["loyalty.policy.publish"])
    case .deviceManagement: return grant("/staff/devices", ["hardware.manage", "printer.manage"])
    case .bottleStorage: return grant("/staff/inventory", ["bottle.manage.all"])
    case .membershipConfig:
      return grant("/staff/member-management", ["loyalty.configuration.view", "loyalty.operations.view"])
        || (actor.allows("loyalty.configuration.view") && (
          grant("/staff/member-rule-drafts", ["loyalty.policy.manage"])
          || grant("/staff/member-rule-approvals", ["loyalty.policy.approve"])
          || grant("/staff/member-rule-publish", ["loyalty.policy.publish"])))
    case .memberGifts:
      return actor.allows("loyalty.configuration.view") && (actor.hasStaffRoute("/staff/member-management")
        || grant("/staff/member-rule-publish", ["loyalty.policy.publish"]))
    case .membershipOverview: return grant("/staff/member-overview", ["loyalty.policy.view"])
    case .membershipRecovery: return grant("/staff/member-management", ["customer.membership.recovery.verify", "customer.membership.merge.approve"])
    case .memberNumber: return grant("/staff/member-management", ["member.card.manage"])
    case .show: return grant("/staff/performance", ["song.view", "song.manage", "performance.phase.manage", "performance.schedule.revise"])
    case .showRequests: return grant("/staff/performance", ["song.view", "song.manage"])
    case .staffSettings: return grant("/staff/settings", ["staff.access.configure"])
    case .tableSettings: return grant("/staff/settings", ["table.manage"])
    case .commerceSettings: return grant("/staff/settings", ["payment.policy.manage"])
    case .publicationSettings:
      return grant("/staff/settings", ["customer.public-profile.manage", "customer.public-profile.publish", "privacy.policy.view", "privacy.policy.manage", "privacy.policy.publish"])
        || grant("/staff/customer-experience", ["customer.experience.feature.manage"])
    case .remakeHandover:
      return actor.allows("refund.request") && ["inventory.receive", "inventory.waste"].contains(where: actor.allows)
        && ["/staff/fulfillment", "/staff/payments"].contains(where: actor.hasStaffRoute)
    case .fulfillmentHistory: return canReadFulfillmentHistory(actor) && ["/staff/fulfillment", "/staff/orders", "/staff/payments"].contains(where: actor.hasStaffRoute)
    case .reservations: return grant("/staff/reservations", ["reservation.view"])
    case .assignments:
      // All signed-in staff can query their own responsibilities; management
      // actions remain independently protected by table.assignment.manage.
      return ["/staff/live", "/staff/tasks", "/staff/fulfillment"].contains(where: actor.hasStaffRoute)
    case .fulfillment:
      return grant("/staff/fulfillment", ["order.view", "kds.prepare", "kds.deliver", "kds.exception.manage", "fulfillment.view_all"])
    case .kitchen: return grant("/staff/fulfillment", ["kds.prepare"])
    case .pickup:
      return grant("/staff/fulfillment", ["kds.deliver"])
        || grant("/staff/settings", ["staff.access.configure"])
    case .printing:
      return ["order.bill.print", "print.view", "print.view_all", "print.reprint", "hardware.manage", "printer.manage"].contains(where: actor.allows)
        && ["/staff/devices", "/staff/payments"].contains(where: actor.hasStaffRoute)
    case .vouchers: return grant("/staff/payments", ["commercial.voucher.view"])
    }
  }
}

extension StaffIdentity {
  var canReadService: Bool {
    ["service.view", "service.execute", "service.manage", "complaint.handle"].contains(where: allows)
  }
  func hasStaffRoute(_ route: String) -> Bool {
    // Missing navigation is only the older contract fallback. A present empty
    // list is an explicit empty set; labels/codes never create route authority.
    guard StaffNavigation.knownRoutes.contains(route) else { return false }
    guard let navigation else { return true }
    return navigation.contains { $0.route == route }
  }
  func canOpen(_ tool: StaffTool) -> Bool { tool.available(to: self) }
  var staffNavigationKey: String {
    let routes = navigation.map { $0.map(\.route).sorted().joined(separator: ",") } ?? "legacy-missing"
    return ([employee.id, session.id] + permissions.sorted() + ["denied"]
      + deniedPermissions.sorted() + ["routes", routes]).joined(separator: "|")
  }
}

struct StaffNavigation {
  static let knownRoutes: Set<String> = [
    "/staff/orders", "/staff/live", "/staff/tasks", "/staff/fulfillment", "/staff/reservations",
    "/staff/payments", "/staff/inventory", "/staff/performance", "/staff/operations",
    "/staff/customer-experience", "/staff/member-fulfillment", "/staff/member-exceptions",
    "/staff/member-overview", "/staff/member-rule-drafts", "/staff/member-rule-approvals",
    "/staff/member-rule-publish", "/staff/member-accounts", "/staff/member-management",
    "/staff/devices", "/staff/settings",
  ]
  static func tabs(actor: StaffIdentity?, training: Bool) -> [StaffDestination] {
    if training { return [.tables, .orders, .cashier, .more] }
    guard let actor else { return [.more] }
    let choices = [StaffDestination.tables, .orders, .cashier, .kitchen, .pickup, .service]
      .filter { $0.available(to: actor) }
    // Keep four touch targets on small screens. Every remaining permitted
    // workplace remains available in More, with the same route/permission gate.
    return Array(choices.prefix(3)) + [.more]
  }
  static func selected(_ value: StaffDestination, actor: StaffIdentity?, training: Bool) -> StaffDestination {
    let choices = tabs(actor: actor, training: training)
    return choices.contains(value) ? value : choices.first ?? .more
  }
}
