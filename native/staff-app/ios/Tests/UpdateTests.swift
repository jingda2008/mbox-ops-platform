import Foundation

@main struct UpdateTests {
  static func main() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    func decode(_ raw: [String: Any]) throws -> AppRelease? {
      try JSONDecoder().decode(
        UpdateManifest.self, from: JSONSerialization.data(withJSONObject: raw)
      ).iosRelease(appId: "com.mbox.staff.native")
    }
    var count = 0
    func check(_ condition: Bool, _ name: String) {
      precondition(condition, name)
      count += 1
      print("PASS \(name)")
    }
    func rejected(_ change: (inout [String: Any]) -> Void) -> Bool {
      var raw = root
      var rows = raw["releases"] as! [[String: Any]]
      change(&rows[0])
      raw["releases"] = rows
      do {
        _ = try decode(raw)
        return false
      } catch { return true }
    }
    let release = try decode(root)!
    check(
      release.build == 3 && release.destination?.host == "testflight.apple.com",
      "iOS manifest chooses its platform and validated distribution link")
    check(
      release.supports("17.0") && release.supports("18.2") && !release.supports("16.9"),
      "minimum OS is compared numerically")
    check(rejected { $0["appId"] = "foreign" }, "foreign app rejected")
    for url in [
      "http://testflight.apple.com/join/TESTONLY",
      "https://testflight.apple.com.evil.example/join/TESTONLY",
      "https://user@testflight.apple.com/join/TESTONLY",
      "https://testflight.apple.com/join/TESTONLY?redirect=bad", "https://mbox.shmbox.com/app.ipa",
    ] {
      check(rejected { $0["url"] = url }, "untrusted installation destination rejected: \(url)")
    }
    check(rejected { $0["build"] = 0 }, "invalid build rejected")
    check(rejected { $0["minimumOS"] = "unknown" }, "invalid operating system requirement rejected")
    check(
      rejected { $0["priority"] = "force-exit" }, "server cannot request forced app termination")
    var empty = root
    empty["releases"] = []
    check(try decode(empty) == nil, "unpublished channel is not reported as current version")
    var duplicate = root
    duplicate["releases"] = [
      (root["releases"] as! [[String: Any]])[0], (root["releases"] as! [[String: Any]])[0],
    ]
    do {
      _ = try decode(duplicate)
      preconditionFailure("duplicate accepted")
    } catch { check(true, "duplicate platform entries rejected") }
    var store = root
    var rows = store["releases"] as! [[String: Any]]
    rows[0]["delivery"] = "appstore"
    rows[0]["url"] = "https://apps.apple.com/cn/app/mbox/id123456789"
    store["releases"] = rows
    check(
      try decode(store)?.destination?.host == "apps.apple.com",
      "App Store updates supported without executable hot patching")
    store["channel"] = "stable"
    let stable = try JSONDecoder().decode(
      UpdateManifest.self, from: JSONSerialization.data(withJSONObject: store))
    do {
      _ = try stable.iosRelease(appId: "com.mbox.staff.native")
      preconditionFailure("cross channel accepted")
    } catch { check(true, "preview install rejects stable manifest") }
    check(
      try stable.iosRelease(appId: "com.mbox.staff.native", expectedChannel: "stable")?.build == 3,
      "stable install accepts its App Store release")
    var beta = root
    beta["channel"] = "stable"
    do {
      _ = try JSONDecoder().decode(
        UpdateManifest.self, from: JSONSerialization.data(withJSONObject: beta)
      ).iosRelease(appId: "com.mbox.staff.native", expectedChannel: "stable")
      preconditionFailure("stable moved to beta")
    } catch { check(true, "stable channel cannot silently switch users to TestFlight") }
    print("\(count) update checks passed")
  }
}
