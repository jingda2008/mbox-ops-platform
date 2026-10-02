import Foundation

// Foreground inbox only. A viewed reminder never completes the underlying service task.
struct ServiceAttention {
  struct Entry: Identifiable, Equatable {
    let id, session, table, priority: String
    var key: String { id + ":" + session + ":" + priority }
  }
  private(set) var actor: String?
  private(set) var entries: [Entry] = []
  private(set) var unread = Set<String>()
  private var observed = Set<String>()
  private(set) var updated: Date?
  var firstUnread: Entry? { entries.first { unread.contains($0.key) } }
  mutating func refresh(actor: String?, permitted: Bool, entries: [Entry], at: Date) {
    guard let actor, permitted else {
      self = Self()
      return
    }
    if self.actor != actor {
      self = Self()
      self.actor = actor
    }
    let rank = ["urgent": 0, "high": 1, "normal": 2, "low": 3]
    var ids = Set<String>()
    self.entries = entries.filter {
      !$0.id.isEmpty && !$0.session.isEmpty && ids.insert($0.id).inserted
    }
    .sorted {
      (rank[$0.priority] ?? 4, $0.table, $0.id) < (rank[$1.priority] ?? 4, $1.table, $1.id)
    }
    let active = Set(self.entries.map(\.key))
    unread = unread.intersection(active).union(active.subtracting(observed))
    // Keep only active keys: a removed task that later returns needs attention again.
    observed = active
    updated = at
  }
  mutating func viewed(_ entry: Entry) { unread.remove(entry.key) }
  func isFresh(at: Date) -> Bool {
    updated.map { (0..<90).contains(at.timeIntervalSince($0)) } == true
  }
}
