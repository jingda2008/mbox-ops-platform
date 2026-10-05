import Foundation
import ImageIO
import CoreGraphics

private final class MediaSessionStore: StaffSessionStore {
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws { bytes = value }
  func remove() throws { bytes = nil }
}
@main struct NativeMediaTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ title: String) { precondition(value, title); count += 1; print("PASS " + title) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func reject(_ work: () throws -> Void) -> Bool { do { try work(); return false } catch { return true } }
    func image(_ width: Int, _ height: Int, alpha: Bool, type: String, metadata: Bool = false) throws -> Data {
      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
      context.setFillColor(CGColor(red: 0.25, green: 0.55, blue: 0.8, alpha: alpha ? 0.5 : 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.setFillColor(CGColor(red: 1, green: 0.3, blue: 0.1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width / 3, height: height / 2))
      let output = NSMutableData(), cg = context.makeImage()!
      guard let destination = CGImageDestinationCreateWithData(output, type as CFString, 1, nil) else { throw StaffAPIError.invalid }
      var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.94]
      if metadata {
        properties[kCGImagePropertyOrientation] = 6
        properties[kCGImagePropertyGPSDictionary] = [kCGImagePropertyGPSLatitude: 31.0, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 121.0, kCGImagePropertyGPSLongitudeRef: "E"]
        properties[kCGImagePropertyExifDictionary] = [kCGImagePropertyExifUserComment: "private-photo-comment"]
      }
      CGImageDestinationAddImage(destination, cg, properties as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw StaffAPIError.invalid }; return output as Data
    }
    let jpeg = try image(2400, 1200, alpha: false, type: "public.jpeg", metadata: true)
    let source = CGImageSourceCreateWithData(jpeg as CFData, nil)!
    let originalProperties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [String: Any]
    check(originalProperties[kCGImagePropertyGPSDictionary as String] != nil, "fixture contains actual original GPS metadata")
    let photo = try prepareNativeMediaPhoto(bytes: jpeg)
    check(photo.mimeType == "image/jpeg" && photo.bytes.count <= 204800 && max(photo.width, photo.height) <= 1600, "camera JPEG is downsampled before decode and compressed within server limit")
    check(photo.height > photo.width, "EXIF orientation is applied to pixels before metadata removal")
    let properties = CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(photo.bytes as CFData, nil)!, 0, nil) as! [String: Any]
    check(properties[kCGImagePropertyGPSDictionary as String] == nil && !(String(describing: properties).contains("private-photo-comment")), "GPS and private EXIF fields are absent from actual output")
    check(jpeg == (jpeg as Data) && originalProperties[kCGImagePropertyOrientation as String] as? Int == 6, "preparation leaves original input and orientation unchanged")
    let heic = try image(1200, 800, alpha: false, type: "public.heic")
    let converted = try prepareNativeMediaPhoto(bytes: heic)
    check(converted.mimeType == "image/jpeg" && converted.bytes.starts(with: [0xff, 0xd8, 0xff]), "actual HEIC input converts to uploadable JPEG bytes")
    let png = try prepareNativeMediaPhoto(bytes: image(700, 500, alpha: true, type: "public.png"))
    check(png.mimeType == "image/png" && png.bytes.count <= 204800, "transparent image remains bounded PNG")
    let transparent = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(png.bytes as CFData, nil)!, 0, nil)!
    check([CGImageAlphaInfo.first, .last, .premultipliedFirst, .premultipliedLast].contains(transparent.alphaInfo), "actual PNG output retains its alpha channel")
    check(reject { _ = try prepareNativeMediaPhoto(bytes: Data(repeating: 0, count: 32_000_001)) }, "oversize source bytes are rejected before image decode")
    check(reject { _ = try prepareNativeMediaPhoto(bytes: Data("not-an-image".utf8)) }, "invalid image cannot become a JPEG by filename guessing")
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".heic")
    try heic.write(to: file); defer { try? FileManager.default.removeItem(at: file) }
    check(try prepareNativeMediaPhoto(fileURL: file).bytes == converted.bytes, "file-transfer photo path yields the same bounded upload without full raw-memory copy")
    let employee = "00000000-0000-4000-8000-000000000001"
    var auth: [String: Any] = ["employee": ["id": employee, "code": "media", "displayName": "图片管理员", "roleCodes": []],
      "session": ["id": "media-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["media.asset.menu.manage"], "deniedPermissions": [], "navigation": [["route": "/staff/inventory"]]]
    let actor = try JSONDecoder().decode(StaffIdentity.self, from: data(auth))
    let upload = try NativeMediaUpload(actor: actor, purpose: "menu", bytes: converted.bytes, mimeType: converted.mimeType)
    let stored = try JSONEncoder().encode(upload)
    check(try decodeNativeMediaPending(stored, employeeID: employee) == upload, "original key, purpose and final byte image survive secure payload round trip")
    check(reject { _ = try decodeNativeMediaPending(stored, employeeID: "00000000-0000-4000-8000-000000000002") }, "another employee cannot load original image request")
    check(reject { _ = try NativeMediaUpload(actor: actor, purpose: "menu", bytes: converted.bytes, mimeType: "image/png") }, "MIME must match actual final bytes")
    var damaged = try JSONSerialization.jsonObject(with: stored) as! [String: Any]; damaged["bytes"] = png.bytes.base64EncodedString()
    check(reject { _ = try decodeNativeMediaPending(data(damaged), employeeID: employee) }, "changed final bytes fail original fingerprint validation")
    let id = "MA" + String(repeating: "A", count: 32)
    var asset: [String: Any] = ["publicId": id, "purpose": "menu", "originalFileName": "original.jpg", "mimeType": upload.mimeType,
      "publicUrl": "/api/public/media-assets/" + id, "sha256": upload.sha256, "byteLength": upload.bytes.count, "createdAt": "2026-10-05 10:00:00+00"]
    func reply() throws -> Data { try data(["data": asset, "meta": ["replayed": true]]) }
    check(try NativeMediaAsset.validateUploadReply(reply(), upload: upload).id == id, "server asset accepted only with original purpose, SHA, MIME and byte length")
    asset["purpose"] = "support_contact"
    check(reject { _ = try NativeMediaAsset.validateUploadReply(reply(), upload: upload) }, "cross-purpose receipt rejected")
    asset["purpose"] = "menu"; asset["publicUrl"] = "https://external.invalid/image"
    check(reject { _ = try NativeMediaAsset.validateUploadReply(reply(), upload: upload) }, "remote URL cannot replace controlled original asset")
    asset["publicUrl"] = "/api/public/media-assets/" + id
    var requests: [URLRequest] = [], attempts = 0
    let api = StaffAPI(transport: { request in
      requests.append(request)
      if ["/api/auth/login", "/api/auth/heartbeat"].contains(request.url!.path) {
        return (try data(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      }
      attempts += 1
      guard request.url!.path == "/api/staff/media-assets", request.httpMethod == "POST",
        request.value(forHTTPHeaderField: "idempotency-key") == upload.key,
        let body = request.httpBody, managementJSONEqual(try JSONSerialization.jsonObject(with: body), upload.body) else { throw StaffAPIError.invalid }
      if attempts == 1 { throw URLError(.timedOut) }
      return (try reply(), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }, store: MediaSessionStore())
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    model.identity = try await api.login(code: "media", pin: "1234", switching: false)
    var failed = false
    do { _ = try await model.uploadNativeManagementMedia(upload) } catch { failed = true }
    check(failed && attempts == 1, "real AppModel unknown upload performs exactly one request")
    let original = try decodeNativeMediaPending(stored, employeeID: employee)
    let result = try await model.uploadNativeManagementMedia(original)
    check(result.id == id && attempts == 2, "real AppModel recovers original upload with identical key and final byte body")
    check(requests.filter { $0.url!.path == "/api/auth/heartbeat" }.count == 2, "each original upload attempt revalidates live staff session")
    auth["permissions"] = []
    failed = false
    do { _ = try await model.uploadNativeManagementMedia(original) } catch { failed = true }
    check(failed && attempts == 2, "fresh permission withdrawal prevents another media POST")
    check(try decodeNativeMediaPending(stored, employeeID: employee) == upload, "permission failure leaves original secure media payload unchanged")
    print("Native media: \(count) checks passed")
  }
}
