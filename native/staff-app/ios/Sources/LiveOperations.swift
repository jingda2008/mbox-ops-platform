import Foundation

struct LiveOperations: Decodable {
  struct Actor: Decodable {
    let id: String
    let capabilities: [String]
  }
  struct Table: Decodable, Identifiable {
    let id: String
    let code: String
    let capacity: Int
    let status: String
    let areaName: String
    let assignedToActor: Bool
    let activeSession: Session?
  }
  struct Session: Decodable {
    let id: String
    let guestCount: Int
    let status: String
    let locationVersion: Int?
    let openedAt: String
    let guestCartWritesFrozen: Bool
    let financialState: String
    let orderAmountMinor: Int?
    let netCollectedAmountMinor: Int?
    let refundedAmountMinor: Int?
  }
  struct ServiceTask: Decodable, Identifiable {
    let id: String
    let tableId: String
    let tableCode: String
    let tableSessionId: String
    let title: String
    let detail: String?
    let priority: String
    let status: String
    let assignedToActor: Bool
    let interactionMode: String
  }
  let actor: Actor
  let tables: [Table]
  let tasks: [ServiceTask]
  func displayTables() -> [StaffTable] {
    tables.filter { $0.status != "retired" }.map { row in
      let s = row.activeSession
      // Until per-order outstanding totals are loaded, refunds cannot be inferred from gross minus net receipts.
      let uncertain = ["refund_pending", "refunded", "partially_refunded", "cancelled"].contains(
        s?.financialState ?? "")
      return StaffTable(
        id: row.id, code: row.code, capacity: row.capacity, people: s?.guestCount ?? 0,
        session: s?.id, total: s == nil ? 0 : uncertain ? nil : s?.orderAmountMinor,
        paid: s == nil ? 0 : uncertain ? nil : s?.netCollectedAmountMinor,
        unknown: ["payment_pending", "payment_exception"].contains(s?.financialState ?? ""),
        service: tasks.contains { $0.tableId == row.id },
        openedAt: s.flatMap { StaffIdentity.date($0.openedAt) })
    }
  }
}
