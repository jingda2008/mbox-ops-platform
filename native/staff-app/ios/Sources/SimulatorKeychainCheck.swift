#if DEBUG && targetEnvironment(simulator)
  import Foundation

  /// Isolated simulator probe: fixed noncredential bytes, separate keychain service,
  /// never reads or replaces the employee's login record. Absent from device builds.
  enum SimulatorKeychainCheck {
    static func run() -> String? {
      let args = ProcessInfo.processInfo.arguments
      guard
        args.contains("--mbox-keychain-write-check") || args.contains("--mbox-keychain-read-check")
      else { return nil }
      let store = KeychainStaffSessionStore(service: "com.mbox.staff.simulator-keychain-check.v1")
      let first = Data("local-simulator-probe-1".utf8)
      let second = Data("local-simulator-probe-2".utf8)
      let result: String
      do {
        if args.contains("--mbox-keychain-write-check") {
          try store.remove()
          guard try store.read() == nil else { throw CatalogError("probe not cleared") }
          try store.write(first)
          guard try store.read() == first else { throw CatalogError("probe read differs") }
          try store.write(second)
          guard try store.read() == second else { throw CatalogError("probe update differs") }
          result = "PASS simulator keychain create/read/update; restart check pending"
        } else {
          guard try store.read() == second else {
            throw CatalogError("probe did not survive relaunch")
          }
          try store.remove()
          guard try store.read() == nil else { throw CatalogError("probe removal failed") }
          result = "PASS simulator keychain relaunch/read/delete; no employee credentials used"
        }
      } catch { result = "FAIL simulator keychain: " + error.localizedDescription }
      if let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        try? Data(result.utf8).write(
          to: cache.appending(path: "keychain-selftest-result.txt"), options: .atomic)
      }
      return result
    }
  }
#endif
