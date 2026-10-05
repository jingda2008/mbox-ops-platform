import Foundation
import ImageIO
import CoreGraphics

struct NativeMediaPreparedPhoto: Equatable, Sendable {
  let bytes: Data
  let mimeType: String
  let width: Int
  let height: Int
  var description: String {
    "\(width) × \(height) · \((bytes.count + 1023) / 1024)KB · " + (mimeType == "image/png" ? "PNG（保留透明）" : "JPEG")
  }
}
func prepareNativeMediaPhoto(fileURL: URL) throws -> NativeMediaPreparedPhoto {
  let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
  guard (1...32_000_000).contains(size), let source = CGImageSourceCreateWithURL(fileURL as CFURL,
    [kCGImageSourceShouldCache: false] as CFDictionary) else { throw CatalogError("请选择32MB以内的手机照片") }
  return try prepareNativeMediaPhoto(source: source)
}
func prepareNativeMediaPhoto(bytes: Data) throws -> NativeMediaPreparedPhoto {
  guard (1...32_000_000).contains(bytes.count), let source = CGImageSourceCreateWithData(bytes as CFData,
    [kCGImageSourceShouldCache: false] as CFDictionary) else { throw CatalogError("请选择32MB以内的手机照片") }
  return try prepareNativeMediaPhoto(source: source)
}
private func prepareNativeMediaPhoto(source: CGImageSource) throws -> NativeMediaPreparedPhoto {
  guard let type = CGImageSourceGetType(source) as String?,
    ["public.jpeg", "public.png", "public.heic", "public.heif", "org.webmproject.webp"].contains(type),
    CGImageSourceGetCount(source) == 1,
    let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
    let width = info[kCGImagePropertyPixelWidth as String] as? NSNumber,
    let height = info[kCGImagePropertyPixelHeight as String] as? NSNumber,
    (1...12000).contains(width.intValue), (1...12000).contains(height.intValue),
    width.int64Value * height.int64Value <= 60_000_000 else {
    throw CatalogError("请选择6000万像素以内的单张照片；动图请先选择静态图片")
  }
  // Downsample before decoding a full-resolution image. Rendered pixels are
  // re-encoded alone: original EXIF, GPS, names and XMP never enter the upload.
  for edge in [1600, 1200, 960, 720, 512, 320] {
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: min(edge, max(width.intValue, height.intValue))]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw CatalogError("照片无法读取，请重新选择") }
    let alpha = (info[kCGImagePropertyHasAlpha as String] as? Bool) == true
    let mime = alpha ? "image/png" : "image/jpeg", outputType = alpha ? "public.png" : "public.jpeg"
    for quality in alpha ? [1.0] : [0.84, 0.70, 0.55] {
      let data = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(data, outputType as CFString, 1, nil) else { throw StaffAPIError.invalid }
      CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality,
        kCGImagePropertyOrientation: 1] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw StaffAPIError.invalid }
      if (1...204800).contains(data.length) {
        return NativeMediaPreparedPhoto(bytes: data as Data, mimeType: mime, width: image.width, height: image.height)
      }
    }
  }
  throw CatalogError("照片仍超过上传限制，请选择更简单或更小的图片")
}
