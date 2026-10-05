import Foundation
import ImageIO
import Security

let nativeMediaPurposes: Set<String> = ["support_contact", "menu", "community_activity", "home_content", "performer"]
func nativeMediaID(_ value: String) -> Bool { value.range(of: "^MA[0-9A-F]{32}$", options: .regularExpression) != nil }
struct NativeMediaUpload: Codable, Equatable {
  let employeeID: String
  let purpose: String
  let bytes: Data
  let mimeType: String
  let key: String
  let sha256: String
  init(actor: StaffIdentity, purpose: String, bytes: Data, mimeType: String) throws {
    guard nativeMediaPurposes.contains(purpose), UUID(uuidString: actor.employee.id) != nil else { throw StaffAPIError.invalid }
    try validateNativeMediaImage(bytes, mimeType: mimeType)
    employeeID = actor.employee.id; self.purpose = purpose; self.bytes = bytes; self.mimeType = mimeType
    key = "native-media-" + UUID().uuidString.lowercased(); sha256 = managementSHA256(bytes)
  }
  var body: [String: Any] {
    ["purpose": purpose, "fileName": "手机图片-" + sha256.prefix(12) + (mimeType == "image/png" ? ".png" : mimeType == "image/webp" ? ".webp" : ".jpg"),
      "mimeType": mimeType, "base64": bytes.base64EncodedString()]
  }
}
func validateNativeMediaImage(_ bytes: Data, mimeType: String) throws {
  guard (1...204800).contains(bytes.count),
      ["image/jpeg", "image/png", "image/webp"].contains(mimeType),
      let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) == 1,
      let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
      let width = info[kCGImagePropertyPixelWidth as String] as? NSNumber,
      let height = info[kCGImagePropertyPixelHeight as String] as? NSNumber,
      width.intValue > 0, height.intValue > 0, width.int64Value * height.int64Value <= 16_000_000 else {
      throw CatalogError("请选择不超过200KB、1600万像素的JPG、PNG或WebP图片")
    }
    let header = [UInt8](bytes.prefix(12))
    let matches = mimeType == "image/jpeg" ? header.starts(with: [0xff, 0xd8, 0xff])
      : mimeType == "image/png" ? header.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : header.count == 12 && String(bytes: header[0..<4], encoding: .ascii) == "RIFF" && String(bytes: header[8..<12], encoding: .ascii) == "WEBP"
    guard matches else { throw CatalogError("图片内容与格式不一致") }
}
struct NativeMediaAsset: Identifiable, Equatable {
  let id, purpose, originalFileName, mimeType, publicUrl, sha256, createdAt: String
  let byteLength: Int
  init(_ object: [String: Any]) throws {
    guard let id = object["publicId"] as? String, nativeMediaID(id),
      let purpose = object["purpose"] as? String, nativeMediaPurposes.contains(purpose),
      let url = object["publicUrl"] as? String, url == "/api/public/media-assets/" + id,
      let file = object["originalFileName"] as? String, !file.isEmpty,
      let mime = object["mimeType"] as? String, ["image/jpeg", "image/png", "image/webp"].contains(mime),
      let hash = object["sha256"] as? String, managementHash(hash),
      let created = object["createdAt"] as? String, !created.isEmpty else { throw StaffAPIError.invalid }
    let size = try managementInt(object["byteLength"]); guard (1...204800).contains(size) else { throw StaffAPIError.invalid }
    self.id = id; self.purpose = purpose; originalFileName = file; mimeType = mime; publicUrl = url
    sha256 = hash; createdAt = created; byteLength = size
  }
  static func validateUploadReply(_ bytes: Data, upload: NativeMediaUpload) throws -> NativeMediaAsset {
    guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let row = root["data"] as? [String: Any],
      let meta = root["meta"] as? [String: Any], (try? managementBool(meta["replayed"])) != nil else { throw StaffAPIError.invalid }
    let asset = try NativeMediaAsset(row)
    guard asset.purpose == upload.purpose, asset.sha256 == upload.sha256,
      asset.mimeType == upload.mimeType, asset.byteLength == upload.bytes.count else { throw StaffAPIError.invalid }
    return asset
  }
}
struct NativeMediaPage {
  let rows: [NativeMediaAsset]
  let next: String?
  init(_ bytes: Data, purpose: String) throws {
    guard nativeMediaPurposes.contains(purpose), let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let values = root["data"] as? [[String: Any]], let meta = root["meta"] as? [String: Any] else { throw StaffAPIError.invalid }
    rows = try values.map(NativeMediaAsset.init)
    guard rows.allSatisfy({ $0.purpose == purpose }), Set(rows.map(\.id)).count == rows.count else { throw StaffAPIError.invalid }
    if meta["nextCursor"] is NSNull { next = nil }
    else { guard let cursor = meta["nextCursor"] as? String, nativeMediaID(cursor) else { throw StaffAPIError.invalid }; next = cursor }
  }
}

// One immutable upload per original employee. No other employee's slot is read.
enum NativeMediaPendingStore {
  private static let service = "com.mbox.staff.media-upload.v1"
  private static func query(_ employeeID: String) throws -> [String: Any] {
    guard UUID(uuidString: employeeID) != nil else { throw StaffAPIError.invalid }
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: employeeID, kSecAttrSynchronizable as String: false]
  }
  static func read(employeeID: String) throws -> NativeMediaUpload? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(try query(employeeID).merging([kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne]) { _, new in new } as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data else { throw CatalogError("原图片上传暂不能安全读取，请解锁后重试") }
    return try decodeNativeMediaPending(bytes, employeeID: employeeID)
  }
  static func store(_ upload: NativeMediaUpload) throws {
    let data = try JSONEncoder().encode(upload)
    _ = try decodeNativeMediaPending(data, employeeID: upload.employeeID)
    let status = SecItemAdd(try query(upload.employeeID).merging([kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard try read(employeeID: upload.employeeID) == upload else { throw CatalogError("请先核对本员工原图片上传，不可覆盖未决原图") }
    } else if status != errSecSuccess { throw CatalogError("原图片上传未能安全保存，未发送") }
  }
  static func remove(_ upload: NativeMediaUpload) throws {
    guard try read(employeeID: upload.employeeID) == upload else { throw CatalogError("原图片上传记录已变化，请核对") }
    let status = SecItemDelete(try query(upload.employeeID) as CFDictionary)
    guard status == errSecSuccess else { throw CatalogError("上传已确认，但本机原记录尚未清除；请核对原上传") }
  }
}
func decodeNativeMediaPending(_ bytes: Data, employeeID: String) throws -> NativeMediaUpload {
  let value = try JSONDecoder().decode(NativeMediaUpload.self, from: bytes)
  guard value.employeeID == employeeID, UUID(uuidString: employeeID) != nil,
    value.key.hasPrefix("native-media-"), UUID(uuidString: String(value.key.dropFirst("native-media-".count))) != nil,
    nativeMediaPurposes.contains(value.purpose), (1...204800).contains(value.bytes.count),
    ["image/jpeg", "image/png", "image/webp"].contains(value.mimeType), managementSHA256(value.bytes) == value.sha256 else { throw StaffAPIError.invalid }
  try validateNativeMediaImage(value.bytes, mimeType: value.mimeType)
  return value
}
