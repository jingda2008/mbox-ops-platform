import AVFoundation
import CoreImage.CIFilterBuiltins
import SwiftUI
import VisionKit

struct LiveOnlinePaymentView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let session: String
  let tableCode: String
  @State private var selected = Set<String>()
  @State private var amount = ""
  @State private var code = ""
  @State private var reason = ""
  @State private var error = ""
  @State private var scan = false
  @State private var proposed: LiveCommand?
  private var orders: [LivePaymentOrder] {
    model.paymentSession == session ? model.paymentOrders : []
  }
  private var receipt: OnlineReceipt? {
    model.onlineReceipts[session].flatMap {
      $0.employeeID == model.identity?.employee.id ? $0 : nil
    }
  }
  private var pendingIDs: [String] {
    Array(Set(orders.compactMap(\.unresolvedOnlinePaymentId))).sorted()
  }
  func propose(method: String) {
    do {
      guard let minor = parseMoney(amount) else { throw CatalogError("请输入正确金额") }
      proposed = try model.prepareOnline(
        session: session, ids: selected, amount: minor, method: method, code: code)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if !model.onlineState.isEmpty { Text(model.onlineState).font(.caption) }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if model.onlineAccess?.canInitiatePayment != true
            || model.onlineAccess?.onlinePaymentProvider != "postar"
          {
            Text("线上收款未开放或尚未读取，可返回登记已收到的现金/POS款。").font(.caption)
          }
          if let receipt {
            let status = model.onlineStatuses[receipt.paymentID] ?? "unknown"
            Card {
              Text("原付款 " + (receipt.amount.map(money) ?? "待核对")).font(.headline)
              Text(receipt.publicID).font(.caption).textSelection(.enabled)
              Text(status == "unknown" ? "付款状态待查询" : cashierStatus(status)).foregroundStyle(
                status == "succeeded" ? ink : .secondary)
              if let value = receipt.qr(status: status) {
                TimelineView(.periodic(from: .now, by: 1)) { timeline in
                  if let current = receipt.qr(now: timeline.date, status: status), current == value,
                    let image = qrImage(current)
                  {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(
                      maxWidth: 264
                    ).padding(20).background(.white).accessibilityLabel("本次付款二维码，请顾客扫码")
                  } else {
                    Text("二维码已到期，请先刷新原付款状态").font(.caption)
                  }
                }
              } else if status == "pending" {
                Text("原付款待确认；二维码过期、不可用或扫码已受理时，不应重复收款。").font(.caption)
              }
              Button("刷新原付款到账状态") {
                Task { await model.pollOnline(receipt.paymentID, session: session) }
              }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(
                model.busy)
              if receipt.kind == "release" {
                Text("已允许另行收款，旧款仍需核对后到结果。").font(.caption).foregroundStyle(.orange)
              }
            }
          }
          Foldout(title: "本次线上收款 · 已选\(selected.count)单") {
            ForEach(orders) { row in
              Button {
                if selected.contains(row.id) {
                  selected.remove(row.id)
                } else {
                  selected.insert(row.id)
                }
                amount = String(
                  format: "%.2f",
                  Double(
                    orders.filter { selected.contains($0.id) }.reduce(0) {
                      $0 + $1.outstandingAmountMinor
                    }) / 100)
              } label: {
                HStack {
                  Image(systemName: selected.contains(row.id) ? "checkmark.circle.fill" : "circle")
                  VStack(alignment: .leading) {
                    Text(row.publicId).font(.caption)
                    Text("应收 " + money(row.outstandingAmountMinor))
                    if !row.selectable { Text("原款未明或无可收余额").font(.caption) }
                  }
                }.frame(minHeight: 48)
              }.disabled(!row.selectable || model.busy || model.livePending != nil)
            }
            TextField("本次收款金额，可部分收款", text: $amount).keyboardType(.decimalPad).textFieldStyle(
              .roundedBorder)
            Button("核对并展示付款二维码") { propose(method: "native_qr") }.buttonStyle(
              Primary(symbol: "qrcode")
            ).disabled(!model.canAct("payment.initiate.staff") || selected.isEmpty)
            Button("扫描顾客付款码") {
              Task {
                guard DataScannerViewController.isSupported else {
                  error = "本设备不支持原生扫码，可手动输入付款码"
                  return
                }
                guard await AVCaptureDevice.requestAccess(for: .video),
                  DataScannerViewController.isAvailable
                else {
                  error = "相机不可用或权限未允许，可手动输入付款码"
                  return
                }
                scan = true
              }
            }.buttonStyle(Primary(tone: .secondary, symbol: "barcode.viewfinder")).disabled(
              model.busy)
            SecureField("付款码（16—32位数字，可手动输入）", text: $code).keyboardType(.numberPad)
              .textContentType(.none).textFieldStyle(.roundedBorder)
            Text("识别后仍需核对金额并确认扣款；不要输入银行卡号或密码。").font(.caption)
            Button("核对付款码并请求扣款") { propose(method: "auth_code") }.buttonStyle(
              Primary(symbol: "creditcard")
            ).disabled(!model.canAct("payment.initiate.staff") || code.isEmpty || selected.isEmpty)
          }
          if !pendingIDs.isEmpty {
            Foldout(title: "原付款待核对 · \(pendingIDs.count)笔") {
              Text("不要因二维码过期或网络错误直接重收。先查询状态；确需更换付款方式，须确认旧款后到可能导致重复付款。").font(.caption)
              TextField("重收原因（4—500字）", text: $reason, axis: .vertical).textFieldStyle(
                .roundedBorder)
              ForEach(pendingIDs, id: \.self) { id in
                Text(id).font(.caption).textSelection(.enabled)
                Text(cashierStatus(model.onlineStatuses[id] ?? "unknown")).font(.caption)
                Button("刷新此原付款状态") { Task { await model.pollOnline(id, session: session) } }
                  .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(
                    model.busy)
                Button("保留旧款待核对，允许重收") {
                  do {
                    proposed = try model.prepareOnlineRelease(
                      session: session, paymentID: id, reason: reason)
                  } catch { self.error = error.localizedDescription }
                }.buttonStyle(Primary(tone: .danger, symbol: "exclamationmark.triangle")).disabled(
                  !model.canAct("payment.initiate.staff"))
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle(tableCode + " · 线上收款").navigationBarTitleDisplayMode(
        .inline
      ).toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("关闭") {
            code = ""
            dismiss()
          }
        }
        ToolbarItem(placement: .primaryAction) {
          Button("刷新") { Task { await model.loadOnline(session) } }.disabled(model.busy)
        }
      }
    }.tint(ink).task {
      await model.loadOnline(session)
      while !Task.isCancelled {
        if let receipt { await model.pollOnline(receipt.paymentID, session: session) }
        do { try await Task.sleep(for: .seconds(10)) } catch { break }
      }
    }.onChange(of: model.workspaceVersion) { _, _ in
      code = ""
      dismiss()
    }
    .onChange(of: receipt?.commandID) { _, value in
      if value != nil {
        selected = []
        code = ""
        amount = ""
      }
    }
    .sheet(isPresented: $scan) {
      NativePaymentScanner { value in
        code = value
        scan = false
      } failed: { text in
        error = text
        scan = false
      }
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps.first?.onlineProof?["confirmation"] as? String ?? "请核对原请求")
            Button("确认提交") {
              proposed = nil
              code = ""
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark")).disabled(!model.canAct(command.permission))
            Button("返回修改") { proposed = nil }
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
      }
    }
  }
  func qrImage(_ value: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(value.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage,
      let image = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: image)
  }
}
struct NativePaymentScanner: UIViewControllerRepresentable {
  var inventory = false
  var memberMode = false
  let received: (String) -> Void
  let failed: (String) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIViewController(context: Context) -> DataScannerViewController {
    let view = DataScannerViewController(
      recognizedDataTypes: [
        .barcode(symbologies: inventory ? [.ean13, .ean8, .upce, .code128, .qr] : [.qr, .code128])
      ], qualityLevel: .balanced,
      recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
    view.delegate = context.coordinator
    do { try view.startScanning() } catch { DispatchQueue.main.async { failed("扫码未能启动，请手动输入") } }
    return view
  }
  func updateUIViewController(_ view: DataScannerViewController, context: Context) {}
  static func dismantleUIViewController(_ view: DataScannerViewController, coordinator: Coordinator)
  { view.stopScanning() }
  class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let parent: NativePaymentScanner
    var received = false
    init(_ parent: NativePaymentScanner) { self.parent = parent }
    func dataScanner(
      _ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      guard !received else { return }
      for item in addedItems {
        if case .barcode(let code) = item, let text = code.payloadStringValue {
          received = true
          scanner.stopScanning()
          if parent.memberMode {
            if text.uppercased().hasPrefix("MBOX_MEMBER_V1:"),
              let value = try? MemberCommands.code(text)
            {
              parent.received(value)
            } else {
              parent.failed("请扫描顾客小程序中的会员码")
            }
          } else if text.range(of: "^[0-9]{16,32}$", options: .regularExpression) != nil {
            parent.received(text)
          } else {
            parent.failed("识别的不是有效付款码，请顾客打开付款码后重试")
          }
          return
        }
      }
    }
  }
}
