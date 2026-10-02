import Combine
import Foundation

struct AppRelease: Decodable, Equatable {
  let platform: String
  let appId: String
  let version: String
  let build: Int
  let minimumOS: String
  let priority: String
  let notes: String
  let delivery: String
  let url: String
  var destination: URL? {
    guard let u = URLComponents(string: url), u.scheme == "https", u.user == nil,
      u.password == nil, u.port == nil, u.fragment == nil, u.query == nil
    else { return nil }
    if delivery == "appstore", u.host == "apps.apple.com",
      u.path.range(of: #"^/(?:[a-z]{2}/)?app/(?:[^/]+/)?id[0-9]+$"#, options: .regularExpression)
        != nil
    {
      return u.url
    }
    if delivery == "testflight", u.host == "testflight.apple.com",
      u.path.range(of: #"^/join/[A-Za-z0-9]+$"#, options: .regularExpression) != nil
    {
      return u.url
    }
    return nil
  }
  func supports(_ os: String) -> Bool {
    os.compare(minimumOS, options: .numeric) != .orderedAscending
  }
}
struct UpdateManifest: Decodable {
  let schemaVersion: Int
  let channel: String
  let releases: [AppRelease]
  func iosRelease(appId: String, expectedChannel: String = "preview") throws -> AppRelease? {
    guard schemaVersion == 1, ["preview", "stable"].contains(expectedChannel),
      channel == expectedChannel
    else { throw UpdateError.invalid }
    let matches = releases.filter { $0.platform == "ios" }
    guard matches.count <= 1 else { throw UpdateError.invalid }
    guard let item = matches.first else { return nil }
    guard item.appId == appId, item.build > 0, !item.version.isEmpty, item.version.count <= 40,
      item.minimumOS.range(of: #"^[0-9]{1,2}(\.[0-9]{1,2}){0,2}$"#, options: .regularExpression)
        != nil,
      ["normal", "urgent"].contains(item.priority), item.notes.count <= 6000,
      item.destination != nil, channel != "stable" || item.delivery == "appstore"
    else { throw UpdateError.invalid }
    return item
  }
}
enum UpdateError: Error, LocalizedError {
  case invalid, unavailable, oversized
  var errorDescription: String? {
    switch self {
    case .invalid: "更新信息无法验证，请稍后重试"
    case .unavailable: "暂未连接到更新服务，请稍后重试"
    case .oversized: "更新信息超出允许大小"
    }
  }
}
// Public version metadata uses an isolated connection, never employee cookies.
private final class UpdateRedirectGuard: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
@MainActor final class AppUpdater: ObservableObject {
  let channel: String
  private var endpoint: URL {
    URL(string: "https://mbox.shmbox.com/native-updates/staff/\(channel).json")!
  }
  let currentVersion: String
  let currentBuild: Int
  private let appId: String
  @Published var release: AppRelease?
  @Published var checking = false
  @Published var status = "尚未检查更新"
  @Published var checkedAt: Date?
  private var lastAttempt: Date?
  init(bundle: Bundle = .main) {
    let configured = bundle.object(forInfoDictionaryKey: "MBOXUpdateChannel") as? String
    channel = ["preview", "stable"].contains(configured ?? "") ? configured! : "preview"
    currentVersion =
      bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知"
    currentBuild = Int(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    appId = bundle.bundleIdentifier ?? ""
  }
  func check(manual: Bool = false) async {
    guard !checking else { return }
    if !manual, let lastAttempt, Date().timeIntervalSince(lastAttempt) < 6 * 3600 { return }
    checking = true
    lastAttempt = Date()
    defer { checking = false }
    do {
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieStorage = nil
      config.urlCache = nil
      config.timeoutIntervalForRequest = 15
      config.timeoutIntervalForResource = 45
      let session = URLSession(
        configuration: config, delegate: UpdateRedirectGuard(), delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      var request = URLRequest(url: endpoint)
      request.cachePolicy = .reloadIgnoringLocalCacheData
      let (stream, response) = try await session.bytes(for: request)
      guard let response = response as? HTTPURLResponse else { throw UpdateError.invalid }
      if response.statusCode == 404 {
        release = nil
        status = "更新服务尚未发布版本"
        return
      }
      guard response.statusCode == 200 else { throw UpdateError.unavailable }
      var bytes = Data()
      for try await byte in stream {
        guard bytes.count < 64 * 1024 else { throw UpdateError.oversized }
        bytes.append(byte)
      }
      let item = try JSONDecoder().decode(UpdateManifest.self, from: bytes).iosRelease(
        appId: appId, expectedChannel: channel)
      release = item.flatMap { $0.build > currentBuild ? $0 : nil }
      checkedAt = Date()
      status = item == nil ? "当前渠道尚未发布版本" : release == nil ? "当前没有可用的新版本" : "发现新版本"
    } catch is CancellationError {
      release = nil
      status = "检查已取消"
    } catch {
      release = nil
      status = "检查未完成，请重试；不会影响当前业务"
    }
  }
}
