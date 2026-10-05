import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

private struct NativeMediaPhotoFile: Transferable {
  let prepared: NativeMediaPreparedPhoto
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { file in
      NativeMediaPhotoFile(prepared: try prepareNativeMediaPhoto(fileURL: file.file))
    }
  }
}
struct NativeMediaPickerView: View {
  let purpose: String
  let selected: (String) -> Void
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var rows: [NativeMediaAsset] = []
  @State private var thumbnails: [String: UIImage] = [:]
  @State private var next: String?
  @State private var item: PhotosPickerItem?
  @State private var prepared: NativeMediaPreparedPhoto?
  @State private var upload: NativeMediaUpload?
  @State private var working = false
  @State private var error = ""
  @State private var storageError = ""
  @State private var vaultReady = false
  @State private var owner = ""
  @State private var selectionGeneration = 0
  private var current: Bool { !owner.isEmpty && owner == model.identity?.staffNavigationKey }
  private func thumbnail(_ id: String) async {
    guard current else { return }
    do {
      let data = try await model.readNativeManagementThumbnail(publicId: id)
      guard current, data.count <= 204800, let decoded = UIImage(data: data) else { return }
      thumbnails[id] = decoded
    } catch { /* A failed preview remains explicitly retryable. */ }
  }
  private func load(_ cursor: String = "") async {
    guard current, !working else { return }; working = true; defer { working = false }
    do {
      let page = try NativeMediaPage(await model.readNativeManagementMedia(purpose: purpose, cursor: cursor), purpose: purpose)
      guard current else { return }
      rows = cursor.isEmpty ? page.rows : rows + page.rows.filter { candidate in !rows.contains { $0.id == candidate.id } }
      if cursor.isEmpty { thumbnails = [:] }
      next = page.next; error = ""
      // The shared adapter serializes authenticated work. Never launch a task
      // per row: each preview is bounded and belongs to this exact owner.
      for asset in page.rows { guard current else { return }; await thumbnail(asset.id) }
    } catch { if current { self.error = error.localizedDescription } }
  }
  private func send() async {
    guard let upload, current, !working, vaultReady else { return }; working = true; defer { working = false }
    do {
      let asset = try await model.uploadNativeManagementMedia(upload)
      guard current else { return }
      try NativeMediaPendingStore.remove(upload)
      self.upload = nil
      if upload.purpose == purpose { selected(asset.publicUrl) }
      else { self.error = "原图片上传已确认，请重新选择当前用途的图片。" }
    } catch { if current { self.error = error.localizedDescription + "；保留原图片与编号，请核对原上传。" } }
  }
  private func confirmUpload() {
    guard let prepared, let actor = model.identity, current, vaultReady, upload == nil, !working else { return }
    do {
      let original = try NativeMediaUpload(actor: actor, purpose: purpose, bytes: prepared.bytes, mimeType: prepared.mimeType)
      try NativeMediaPendingStore.store(original)
      upload = original; self.prepared = nil
      Task { await send() }
    } catch { self.error = error.localizedDescription }
  }
  private func clearSelection() { selectionGeneration += 1; item = nil; prepared = nil }
  @ViewBuilder private var uploadControls: some View {
    if let upload {
      if let image = UIImage(data: upload.bytes) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 240).accessibilityLabel("原上传图片") }
      Text("原上传结果待核对。核对沿用原图片与编号；关闭或重新登录后仍保留原请求。")
      Button("核对原上传") { Task { await send() } }.disabled(working || !current || !vaultReady)
    } else if let prepared {
      if let image = UIImage(data: prepared.bytes) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 280).accessibilityLabel("将上传的图片预览") }
      Text(prepared.description).font(.caption)
      Text("已在本机调整图片尺寸并移除照片位置等附加资料。请核对画面清晰度；原相册图片不会改变。").font(.caption)
      Button("确认上传此图片") { confirmUpload() }.buttonStyle(Primary(symbol: "arrow.up.doc")).disabled(working || !current || !vaultReady)
      Button("重新选择") { clearSelection() }.disabled(working)
    } else {
      PhotosPicker("从手机选择图片", selection: $item, matching: .images).disabled(working || !current || model.busy || !vaultReady)
      Text("支持手机HEIC、JPG、PNG、WebP静态图片，自动调整至200KB以内；透明图片保留PNG。先预览核对，再确认上传。").font(.caption)
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          Text("选择或上传后，回到内容表单核对并保存才生效。上传不会发布任何内容。").font(.caption)
          if !storageError.isEmpty { Text(storageError).foregroundStyle(.red) }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if working { ProgressView("正在处理图片") }
          Button("刷新图片库") { Task { await load() } }.disabled(working || !current)
          uploadControls
          ForEach(rows) { asset in
            Card {
              if let image = thumbnails[asset.id] { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180).accessibilityLabel("门店图片预览") }
              else { Button("重新读取此图片预览") { Task { guard !working else { return }; working = true; await thumbnail(asset.id); working = false } }.disabled(working || !current) }
              Text(asset.originalFileName); Text("\((asset.byteLength + 1023) / 1024)KB · " + reservationTime(asset.createdAt)).font(.caption)
              Button("选择此图片") { if current { selected(asset.publicUrl) } }.disabled(working || !current || upload != nil || prepared != nil)
            }
          }
          if let next { Button("加载更多") { Task { await load(next) } }.disabled(working || !current) }
          if rows.isEmpty && !working { Text("当前没有此用途的图片").foregroundStyle(.secondary) }
        }.padding(16)
      }.navigationTitle("门店图片库").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clearSelection(); dismiss() } } }
    }.task {
      owner = model.identity?.staffNavigationKey ?? ""
      do {
        guard let employeeID = model.identity?.employee.id else { return }
        upload = try NativeMediaPendingStore.read(employeeID: employeeID); vaultReady = true
      } catch { storageError = error.localizedDescription; vaultReady = false }
      await load()
    }
      .onChange(of: model.identity?.staffNavigationKey) { _, _ in clearSelection(); rows = []; thumbnails = [:]; upload = nil; dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clearSelection(); rows = []; thumbnails = [:]; upload = nil; dismiss() }
      .onChange(of: phase) { _, phase in if phase != .active { clearSelection() } }
      .onDisappear { clearSelection(); thumbnails = [:] }
      .onChange(of: item) { _, item in
        guard let item, upload == nil, current, vaultReady, !working else { return }
        selectionGeneration += 1; let generation = selectionGeneration; working = true
        Task {
          defer { working = false }
          do {
            let photo = try await item.loadTransferable(type: NativeMediaPhotoFile.self)
            guard generation == selectionGeneration, current else { return }
            guard let photo else { throw CatalogError("照片无法读取，请重新选择") }
            prepared = photo.prepared; self.item = nil; error = ""
          } catch { if current && generation == selectionGeneration { self.error = error.localizedDescription; self.item = nil } }
        }
      }
  }
}
// Existing SET call site alias; all feature modules share one picker and vault.
typealias NativeManagementMediaPickerView = NativeMediaPickerView
