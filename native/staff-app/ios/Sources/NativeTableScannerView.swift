import AVFoundation
import SwiftUI
import VisionKit

struct NativeTableScannerView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  let selected: (String) -> Void
  @State private var tables: [StaffTable] = []
  @State private var scope = ""
  @State private var workspace = -1
  @State private var scanning = false
  @State private var loading = false
  @State private var candidate: NativeTableScanSelection?
  @State private var error = ""
  @State private var generation = 0

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("扫码只定位当前岗位可见桌台。核对桌号后打开，开台、点单和收款仍需分别确认。").font(.subheadline)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if loading { ProgressView("核对当前员工与桌台名单") }
          if scanning {
            NativePaymentScanner(tableMode: true) { code in
              scanning = false
              do {
                guard let actor = model.identity, actor.staffNavigationKey == scope,
                  model.workspaceVersion == workspace, phase == .active else { throw CatalogError("当前员工或工作区已变化，请重新扫码") }
                let table = try resolveNativeScannedTable(code, tables: tables)
                candidate = NativeTableScanSelection(table: table, actor: actor, workspace: workspace)
              } catch { self.error = error.localizedDescription }
            } failed: { message in scanning = false; error = message }
              .frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 14))
          }
          if let candidate {
            Text("已识别：\(candidate.tableCode)").font(.title2.bold())
            Text("打开前会再次读取当前岗位的桌台名单。桌台营业状态可能已经变化，请进入后核对。").font(.caption)
            Button("核对并打开 \(candidate.tableCode)") { Task { await confirm(candidate) } }
              .buttonStyle(Primary(symbol: "arrow.right.circle")).disabled(loading || model.busy)
          }
          if !scanning {
            Button(candidate == nil ? "重新扫码" : "重新识别桌码") { Task { await start() } }
              .buttonStyle(Primary(tone: .secondary, symbol: "qrcode.viewfinder")).disabled(loading || model.busy)
          }
          Button("返回手动搜索桌号") { dismiss() }.buttonStyle(Primary(tone: .secondary, symbol: "magnifyingglass"))
        }.padding()
      }.background(paper).navigationTitle("扫描桌码").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .task { await start() }
        .onChange(of: model.identity?.staffNavigationKey) { _, _ in invalidate() }
        .onChange(of: model.workspaceVersion) { _, _ in invalidate() }
        .onChange(of: phase) { _, value in if value != .active { invalidate() } }
        .onDisappear { invalidate() }
    }
  }
  private func invalidate() {
    generation += 1; scanning = false; candidate = nil; tables = []; scope = ""; workspace = -1
  }
  @MainActor private func start() async {
    guard !loading else { return }
    invalidate(); error = ""; loading = true
    let request = generation
    defer { loading = false }
    do {
      let rows = try await model.readNativeTableScanTargets()
      guard request == generation, let actor = model.identity, phase == .active else { return }
      scope = actor.staffNavigationKey; workspace = model.workspaceVersion; tables = rows
      guard DataScannerViewController.isSupported else { throw CatalogError("本机不支持相机识别，请返回手动搜索桌号") }
      let granted = await AVCaptureDevice.requestAccess(for: .video)
      guard request == generation, actor.staffNavigationKey == model.identity?.staffNavigationKey,
        workspace == model.workspaceVersion, phase == .active else { return }
      guard granted, DataScannerViewController.isAvailable else { throw CatalogError("相机未授权或当前不可用，可返回手动搜索桌号") }
      scanning = true
    } catch { if request == generation { self.error = error.localizedDescription } }
  }
  @MainActor private func confirm(_ value: NativeTableScanSelection) async {
    guard !loading else { return }
    loading = true; error = ""; let request = generation
    defer { loading = false }
    do {
      let current = try await model.readNativeTableScanTargets()
      guard request == generation, phase == .active else { return }
      let id = try value.validate(actor: model.identity, workspace: model.workspaceVersion, tables: current)
      selected(id); dismiss()
    } catch { if request == generation { self.error = error.localizedDescription; candidate = nil } }
  }
}
