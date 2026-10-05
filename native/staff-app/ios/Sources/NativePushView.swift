import SwiftUI

struct NativePushView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var push: NativePushCoordinator
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("服务提醒").font(.headline)
      Text(push.status).font(.subheadline).accessibilityIdentifier("native-push-status")
      Text("提醒用于引导查看原服务任务。Apple 受理、设备显示和员工打开分别核对，不会自动接单或完成任务。")
        .font(.caption).foregroundStyle(.secondary)
      if model.live && model.identity != nil {
        Button(push.enabled ? "重新核对提醒" : "开启服务提醒") {
          Task { if push.enabled { await push.refresh() } else { await push.enable() } }
        }.buttonStyle(Primary(tone: .secondary, symbol: "bell.badge"))
          .disabled(push.busy)
      } else {
        Text("请先登录员工账号，提醒将绑定当前员工及本次登录。")
          .font(.caption).foregroundStyle(.secondary)
      }
      if push.enabled {
        Button("关闭本机服务提醒", role: .destructive) { push.endSession() }
          .buttonStyle(Primary(tone: .secondary, symbol: "bell.slash"))
      }
      if push.pendingRevocations > 0 {
        Button("重试核对远端撤销") { Task { await push.flushRevocations() } }
          .buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise"))
      }
      if push.hasOpenIntent {
        Button("重新核对原提醒") { Task { await push.openPending() } }
          .buttonStyle(Primary(tone: .secondary, symbol: "checklist"))
      }
      #if canImport(UIKit)
        Button("打开系统通知设置") {
          if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            UIApplication.shared.open(url)
          }
        }.buttonStyle(Primary(tone: .secondary, symbol: "gear"))
      #endif
      Text("后台显示取决于门店 APNs 配置、安装包签名、通知授权与系统状态；退出或换员工会先停用本机提醒。已在途的通用提醒可能仍出现，打开时会重新核对权限。")
        .font(.caption).foregroundStyle(.secondary)
    }
  }
}
