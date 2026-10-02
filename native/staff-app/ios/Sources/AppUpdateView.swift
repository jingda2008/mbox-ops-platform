import SwiftUI

struct AppUpdateView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.openURL) private var openURL
  @ObservedObject var updater: AppUpdater
  @State private var confirm = false
  private var blocked: Bool {
    model.busy || model.pending != nil || model.livePending != nil || model.liveOrderPending != nil
      || model.liveStorageDamaged
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("当前版本 \(updater.currentVersion)（\(updater.currentBuild)）").font(.subheadline)
      Text(updater.checking ? "正在检查更新…" : updater.status).font(.caption)
      Button("检查更新") { Task { await updater.check(manual: true) } }
        .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(
          updater.checking)
      if let release = updater.release {
        Text("\(release.priority == "urgent" ? "建议尽快更新" : "新版本") · \(release.version)").font(
          .headline)
        Text(release.notes).font(.subheadline)
        if release.supports(UIDevice.current.systemVersion) {
          if blocked { Text("请先完成当前操作并核对未决结果，再安装更新。").font(.caption) }
          Button(release.delivery == "testflight" ? "前往 TestFlight 更新" : "前往 App Store 更新") {
            confirm = true
          }
          .buttonStyle(Primary(symbol: "arrow.down.circle")).disabled(blocked)
        } else {
          Text("此版本需要 iOS \(release.minimumOS) 或以上，请先升级系统。").font(.caption)
        }
      }
      Text("更新由苹果分发渠道安装。更新失败可继续使用当前版本，不会清空业务记录。").font(.caption).foregroundStyle(.secondary)
    }.confirmationDialog("前往更新？请先完成当前操作。", isPresented: $confirm, titleVisibility: .visible) {
      Button("前往更新") {
        guard !blocked, let url = updater.release?.destination else { return }
        openURL(url) { success in if !success { model.message = "无法打开更新入口，请稍后重试" } }
      }
    }
  }
}
