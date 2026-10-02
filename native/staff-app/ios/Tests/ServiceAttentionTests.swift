import Foundation

@main struct Tests {
  static func main() {
    let now = Date(timeIntervalSince1970: 1000)
    let normal = ServiceAttention.Entry(id: "a", session: "s1", table: "A1", priority: "normal")
    let urgent = ServiceAttention.Entry(id: "b", session: "s2", table: "B2", priority: "urgent")
    var inbox = ServiceAttention()
    inbox.refresh(actor: "e1", permitted: true, entries: [normal, urgent, normal], at: now)
    precondition(inbox.entries.count == 2 && inbox.firstUnread == urgent)
    inbox.viewed(urgent)
    inbox.refresh(actor: "e1", permitted: true, entries: [normal, urgent], at: now)
    precondition(inbox.entries.count == 2 && inbox.unread == [normal.key])
    inbox.refresh(actor: "e1", permitted: true, entries: [urgent], at: now)
    precondition(inbox.unread.isEmpty)
    let escalation = ServiceAttention.Entry(id: "b", session: "s2", table: "B2", priority: "high")
    inbox.refresh(actor: "e1", permitted: true, entries: [escalation], at: now)
    precondition(inbox.firstUnread == escalation)
    precondition(
      inbox.isFresh(at: now) && !inbox.isFresh(at: now.addingTimeInterval(-1))
        && !inbox.isFresh(at: now.addingTimeInterval(90)))
    inbox.refresh(actor: "e2", permitted: true, entries: [normal], at: now)
    precondition(
      inbox.actor == "e2" && inbox.firstUnread == normal && !inbox.entries.contains(urgent))
    inbox.refresh(actor: "e2", permitted: false, entries: [normal], at: now)
    precondition(inbox.entries.isEmpty && inbox.actor == nil)
    print("7 service attention checks passed")
  }
}
