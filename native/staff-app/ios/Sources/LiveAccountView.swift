import SwiftUI
#if canImport(UIKit)
  import UIKit
#endif

struct LiveAccountView: View {
  @EnvironmentObject var model: AppModel
  @State private var credential = ""
  @State private var code = ""
  @State private var pin = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let identity = model.identity {
        Label(
          identity.employee.displayName + " · " + identity.employee.code,
          systemImage: "person.crop.circle.badge.checkmark")
        Text("岗位权限由门店系统提供，切换员工后重新加载。").font(.caption).foregroundStyle(.secondary)
      } else {
        SecureField("门店口令", text: $credential).textFieldStyle(.roundedBorder)
        Button(model.deviceReady ? "重新验证设备" : "验证门店设备") {
          let value = credential
          credential = ""
          Task { await model.grantDevice(value) }
        }.buttonStyle(Primary(tone: .secondary, symbol: "checkmark.shield"))
          .disabled(
            credential.trimmingCharacters(in: .whitespacesAndNewlines).count < 6 || model.busy
          )
        if model.deviceReady {
          Label("设备已验证", systemImage: "checkmark.circle").font(.caption).foregroundStyle(ink)
        }
      }
      Toggle(
        "记住本机登录", isOn: Binding(get: { model.rememberLogin }, set: { model.setRememberLogin($0) })
      ).disabled(model.busy)
      if model.identity == nil && model.savedLoginAvailable {
        Button("恢复已记住的登录") { Task { await model.restoreRememberedSession(retry: true) } }
          .buttonStyle(Primary(tone: .secondary, symbol: "lock")).disabled(model.busy)
      }
      TextField("员工账号", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled()
        .textFieldStyle(.roundedBorder)
      SecureField("4位数字 PIN", text: $pin).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
      Button(model.identity == nil ? "登录门店" : "切换员工") {
        let value = pin
        pin = ""
        Task { await model.login(code: code, pin: value) }
      }.buttonStyle(Primary(symbol: "lock.open"))
        .disabled(
          code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pin.count != 4
            || model.busy
            || (model.identity != nil
              && (model.livePending != nil || model.liveOrderPending != nil))
            || (!model.deviceReady && model.identity == nil))
      if model.identity != nil {
        Button("退出员工账号") { Task { await model.logout() } }
          .buttonStyle(Primary(tone: .secondary, symbol: "rectangle.portrait.and.arrow.right"))
          .disabled(model.busy || (model.livePending != nil || model.liveOrderPending != nil))
      } else if model.live && model.trainingAllowed {
        Button("返回本机演练") { model.train() }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.uturn.backward")
        ).disabled(model.busy || (model.livePending != nil || model.liveOrderPending != nil))
      }
      Text("口令与 PIN 不保存。勾选后使用本机安全存储记住登录；重启仍须联网核验身份和权限。共用设备请在交班时退出账号。").font(.caption)
        .foregroundStyle(.secondary)
    }.toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("完成输入") {
          #if canImport(UIKit)
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
          #endif
        }
      }
    }
  }
}
