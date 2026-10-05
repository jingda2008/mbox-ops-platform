import Foundation
import CryptoKit
import Security

struct NativePushOwner: Codable, Equatable {
  let employeeId: String
  let staffSessionId: String
  init(_ identity: StaffIdentity) {
    employeeId = identity.employee.id
    staffSessionId = identity.session.id
  }
}
struct NativePushRegistration: Codable, Equatable {
  let owner: NativePushOwner
  let requestKey: String
  let expectedRevision: Int
  let token, permission, appVersion, revocationSecret: String
  var body: [String: Any] {
    ["expectedRevision": expectedRevision, "platform": "ios", "provider": "apns",
     "token": token, "permission": permission, "appVersion": appVersion,
     "revocationSecret": revocationSecret]
  }
}
struct NativePushBinding: Codable, Equatable {
  let owner: NativePushOwner
  let revision: Int
  let expiresAt, tokenHash, revocationSecret: String
}
struct NativePushRevocation: Codable, Equatable {
  let revision: Int
  let revocationSecret: String
  let owner: NativePushOwner
  let requestKey: String
}
struct NativePushObservation: Codable, Equatable {
  let deliveryId, kind, requestKey: String
  let owner: NativePushOwner
  let revision: Int
}
/// This entire document is one atomic, non-synchronizing Keychain item, separate
/// from staff credentials and financial/business command recovery.
struct NativePushState: Codable {
  let version: Int
  let installationId: String
  var enabled = false
  var pending: NativePushRegistration?
  var binding: NativePushBinding?
  var revocations: [NativePushRevocation] = []
  var observations: [NativePushObservation] = []
  var openDeliveryId: String?
  init() { version = 1; installationId = UUID().uuidString.lowercased() }
  func validate() throws {
    guard version == 1, UUID(uuidString: installationId) != nil,
      revocations.count <= 128, observations.count <= 64,
      openDeliveryId.map({ UUID(uuidString: $0) != nil }) ?? true
    else { throw NativePushError.invalid }
    if let pending {
      guard Self.validToken(pending.token), Self.validSecret(pending.revocationSecret),
        (0..<9_007_199_254_740_991).contains(pending.expectedRevision),
        ["authorized", "provisional"].contains(pending.permission),
        Self.validKey(pending.requestKey), !pending.appVersion.isEmpty,
        pending.appVersion.count <= 64 else { throw NativePushError.invalid }
    }
    if let binding {
      guard binding.revision > 0, Self.validSecret(binding.revocationSecret),
        StaffIdentity.date(binding.expiresAt) != nil else { throw NativePushError.invalid }
    }
    guard revocations.allSatisfy({ $0.revision > 0 && Self.validSecret($0.revocationSecret)
      && Self.validKey($0.requestKey) }), observations.allSatisfy({
        UUID(uuidString: $0.deliveryId) != nil && ["received", "opened"].contains($0.kind)
          && Self.validKey($0.requestKey) && $0.revision > 0
      }) else { throw NativePushError.invalid }
  }
  static func key() -> String { "native-push-" + UUID().uuidString.lowercased() }
  static func validKey(_ value: String) -> Bool {
    value.hasPrefix("native-push-") && UUID(uuidString: String(value.dropFirst(12))) != nil
  }
  static func validToken(_ value: String) -> Bool {
    (32...512).contains(value.count) && value.count % 2 == 0
      && value.allSatisfy { "0123456789abcdef".contains($0) }
  }
  static func validSecret(_ value: String) -> Bool {
    guard value.count == 43,
      value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
      let decoded = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/") + "=")
    else { return false }
    return decoded.count == 32 && secretEncoding(decoded) == value
  }
  static func secretEncoding(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  static func secret() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw NativePushError.storage
    }
    return secretEncoding(Data(bytes))
  }
  static func tokenHash(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
struct NativePushInstallation: Decodable {
  let installationId: String
  let revision: Int
  let status: String
  let boundToCurrentSession: Bool
  let expiresAt: String
  let lastRequestKey: String?
}
struct NativePushInstallationReply: Decodable {
  let `protocol`: Int
  let employeeId, staffSessionId: String
  let requestKey: String?
  let installation: NativePushInstallation
}
struct NativePushCapabilities: Decodable {
  struct Platforms: Decodable {
    struct IOS: Decodable { let provider: String; let configured: Bool; let environment: String? }
    let ios: IOS
  }
  let `protocol`: Int
  let employeeId, staffSessionId: String
  let enabled: Bool
  let reasonCode: String?
  let platforms: Platforms
}
struct NativePushTarget: Decodable, Identifiable, Equatable {
  let `protocol`: Int
  let employeeId, staffSessionId, deliveryId, installationId: String
  let revision: Int
  let kind, taskId, tableSessionId: String
  var id: String { deliveryId }
}
struct NativePushObservationReply: Decodable {
  let `protocol`: Int
  let employeeId, staffSessionId, requestKey, deliveryId, kind: String
  let clientReportedReceivedAt, clientReportedOpenedAt: String?
}
enum NativePushError: Error, LocalizedError {
  case invalid, storage, changed, disabled
  var errorDescription: String? {
    switch self {
    case .invalid: return "提醒回执无法核对，已保留原请求，请稍后重试"
    case .storage: return "无法安全保存提醒设置，请解锁设备后重试"
    case .changed: return "登录或提醒设置已变化，请在当前账号重新核对"
    case .disabled: return "门店尚未启用推送，当前待办仍可在工作台查看"
    }
  }
}
enum NativePushPermission: String { case notDetermined, denied, authorized, provisional
  var allowed: Bool { self == .authorized || self == .provisional }
}
@MainActor protocol NativePushSystem: AnyObject {
  func permission() async -> NativePushPermission
  func requestPermission() async throws -> NativePushPermission
  func register()
  func stopAndClear()
}
