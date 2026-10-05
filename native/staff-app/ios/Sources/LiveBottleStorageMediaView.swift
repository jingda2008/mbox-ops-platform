import SwiftUI
import UIKit
import AVFoundation
import UniformTypeIdentifiers

struct BottleStorageEvidenceView: View {
  @EnvironmentObject var model: AppModel
  let member: String, unit: String, quantity: String, fraction: String, usable: Bool
  @Binding var evidence: [String: Any]?
  @State private var photo: Data?
  @State private var camera = false
  @State private var phone = ""
  @State private var masked = ""
  @State private var checkedMember = ""
  @State private var notice = ""
  @State private var checking = false
  private var signature: String { member + ":" + unit + ":" + quantity + ":" + fraction + ":" + phone }
  private func confirm() {
    do {
      guard !member.isEmpty, checkedMember == member, let photo else { throw CatalogError("请先核对联系人并拍摄本次实物") }
      let rawPhone: Any = masked.isEmpty ? try bottlePhone(phone) : NSNull()
      let value: [String: Any] = ["photoBase64": photo.base64EncodedString(), "phone": rawPhone, "fraction": fraction.isEmpty ? NSNull() : fraction]
      try validateBottleStorageEvidence(value, unit: unit, quantity: quantity); evidence = value; notice = "本次实物与联系人已核对；提交后由服务端添加水印。"
    } catch { evidence = nil; notice = error.localizedDescription }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Divider(); Text("本次寄存留证").font(.headline)
      Button(checking ? "正在查询联系人…" : "查询该会员已核实联系人") {
        let number = member; checkedMember = ""; masked = ""; phone = ""; evidence = nil; checking = true
        Task {
          defer { checking = false }
          do {
            let result = try bottleData(await model.readBottleStorage("/member-contact?memberNo=" + LiveCommand.pathPart(number)))
            guard member == number, result["memberNo"] as? String == number else { return }
            if let maskedPhone = result["maskedPhone"] as? String {
              guard result["source"] as? String == "membership", !maskedPhone.isEmpty else { throw StaffAPIError.invalid }; masked = maskedPhone
            } else { guard result["maskedPhone"] is NSNull, result["source"] is NSNull else { throw StaffAPIError.invalid } }
            checkedMember = number; notice = masked.isEmpty ? "未有已核实手机号，请当面填写联系人号码。" : "使用会员已核实联系人，不可另填号码。"
          } catch { if member == number { notice = error.localizedDescription } }
        }
      }.disabled(!usable || checking || member.isEmpty)
      if checkedMember == member && !member.isEmpty {
        if !masked.isEmpty { Text("已核实联系人：" + masked) }
        else { TextField("本次留存手机号（含区号或中国手机号）", text: $phone).textFieldStyle(.roundedBorder).keyboardType(.phonePad).textContentType(.telephoneNumber) }
      }
      Button("拍摄本次存酒实物") {
        Task {
          guard UIImagePickerController.isSourceTypeAvailable(.camera) else { notice = "此设备无可用相机，请使用有相机的授权设备办理留证。"; return }
          guard await AVCaptureDevice.requestAccess(for: .video) else { notice = "相机权限未授予，请在系统设置允许后再拍照。"; return }
          if usable { camera = true }
        }
      }.disabled(!usable)
      if let photo, let image = UIImage(data: photo) {
        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 240)
        Text("照片仅在本次表单和安全原请求槽内使用，不写入相册。").font(.caption)
      }
      Button("确认照片、数量与联系人") { confirm() }.disabled(!usable || checking || photo == nil || checkedMember != member)
      if !notice.isEmpty { Text(notice).font(.subheadline).foregroundStyle(evidence == nil ? .secondary : .primary) }
    }.onChange(of: signature) { _, _ in evidence = nil }
      .onChange(of: member) { _, _ in photo = nil; phone = ""; masked = ""; checkedMember = ""; evidence = nil }
      .sheet(isPresented: $camera) {
        BottleStorageCamera(received: { value in photo = value; evidence = nil; camera = false }, failed: { notice = $0; camera = false })
      }
  }
}
struct BottleStorageCamera: UIViewControllerRepresentable {
  let received: (Data) -> Void, failed: (String) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController(); picker.sourceType = .camera; picker.mediaTypes = [UTType.image.identifier]
    picker.allowsEditing = false; picker.delegate = context.coordinator; return picker
  }
  func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: BottleStorageCamera
    init(_ parent: BottleStorageCamera) { self.parent = parent }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.failed("拍摄已取消") }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      guard let image = info[.originalImage] as? UIImage, image.size.width >= 160, image.size.height >= 120 else { parent.failed("照片分辨率不足，请重新拍摄"); return }
      let scale = min(1, 1280 / max(image.size.width, image.size.height))
      let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
      let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
      let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
      for quality in [0.85, 0.7, 0.55, 0.4, 0.3] {
        if let bytes = resized.jpegData(compressionQuality: quality), bytes.count <= 1_000_000 { parent.received(bytes); return }
      }
      parent.failed("照片压缩后仍过大，请调整拍摄距离后重拍")
    }
  }
}
struct BottleStorageWorkbook: FileDocument {
  static var readableContentTypes: [UTType] { [UTType(importedAs: "org.openxmlformats.spreadsheetml.sheet")] }
  let data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws { guard let bytes = configuration.file.regularFileContents else { throw StaffAPIError.invalid }; data = bytes }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct BottleStorageReceiptView: View {
  let receipt: BottleStorageReceipt
  @State private var export = false
  @State private var notice = ""
  var body: some View {
    Card {
      Text(receipt.message).font(.subheadline)
      if ["export", "report_export"].contains(receipt.operation), let encoded = receipt.object["base64"] as? String, let bytes = Data(base64Encoded: encoded) {
        Button("选择位置保存报表") { export = true }
          .fileExporter(isPresented: $export, document: BottleStorageWorkbook(data: bytes), contentType: BottleStorageWorkbook.readableContentTypes[0], defaultFilename: bottleText(receipt.object, "filename")) { result in
            switch result { case .success: notice = "报表已保存到所选位置，请按门店要求保管会员资料。"; case .failure(let error): notice = "未能保存：" + error.localizedDescription }
          }
      }
      if receipt.operation == "print_prepared" {
        Button("打开系统打印") {
          do {
            let formatter = UISimpleTextPrintFormatter(text: try bottleStoragePrintText(receipt))
            formatter.font = .systemFont(ofSize: 12); formatter.color = .black
            let controller = UIPrintInteractionController.shared; controller.printFormatter = formatter
            let info = UIPrintInfo(dictionary: nil); info.jobName = "M-BOX 存酒凭证"; info.outputType = .general; controller.printInfo = info
            let completion: UIPrintInteractionController.CompletionHandler = { _, completed, error in
              notice = error.map { "打印未完成：" + $0.localizedDescription } ?? (completed ? "系统打印任务已提交，请现场核对是否出纸。" : "打印已取消，可再次打开原凭证。")
            }
            if UIDevice.current.userInterfaceIdiom == .pad,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) {
              controller.present(from: CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 1, height: 1), in: window, animated: true, completionHandler: completion)
            } else { controller.present(animated: true, completionHandler: completion) }
          } catch { notice = error.localizedDescription }
        }
      }
      if !notice.isEmpty { Text(notice).font(.caption) }
    }
  }
}
func bottleStoragePrintText(_ receipt: BottleStorageReceipt) throws -> String {
  guard receipt.operation == "print_prepared", let doc = receipt.object["document"] as? [String: Any], let raw = doc["order"] as? [String: Any], let values = doc["policy"] as? [String: Any] else { throw StaffAPIError.invalid }
  let policy = try JSONDecoder().decode(BottleStoragePolicy.self, from: bottleBytes(values)), order = try BottleStorageRow(raw)
  var lines = [policy.printTitle, "存酒单：" + order.text("public_id"), "会员：" + order.text("member_no")]
  let fields = ["category": "品类：" + order.text("category_name"), "item": "物品：" + order.text("item_name"),
    "quantity": "原存：" + order.text("original_quantity") + order.text("unit"), "remaining": "剩余：" + order.text("remaining_quantity") + order.text("unit"),
    "expiry": "到期：" + bottleDisplayTime(order.text("expires_at")), "location": "位置：" + order.text("location"),
    "status": "状态：" + (bottleStorageStates[order.text("status")] ?? "待核对"), "source": "来源：" + order.text("source_reference")]
  lines += policy.printFields.compactMap { fields[$0] }; lines.append(policy.printFooter); return lines.joined(separator: "\n\n")
}
