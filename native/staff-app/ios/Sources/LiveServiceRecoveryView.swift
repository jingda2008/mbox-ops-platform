import SwiftUI

struct LiveServiceRecoveryView: View {
  @EnvironmentObject var model:AppModel
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var scenePhase
  let command:LiveCommand
  @State private var code=""
  @State private var pin=""
  @State private var reason=""
  @State private var confirmed=false
  private func clear(){code="";pin="";reason="";confirmed=false}
  var body:some View {
    NavigationStack {
      ScrollView {
        VStack(alignment:.leading,spacing:16) {
          Card {
            Text(command.title).font(.headline)
            Text("原员工编号："+command.employeeID).font(.caption)
            Text("原请求："+(command.steps.first?.key ?? "待核对")).font(.caption).textSelection(.enabled)
          }
          Text("服务器已有回执时只核对结果；原请求尚未提交时永久封存该请求，防止旧设备继续执行。任务本身仍须刷新后处理。")
          Text("主管使用自己的账号和 PIN，只处理此项原请求，不接管原员工登录。").font(.subheadline)
          TextField("主管员工账号",text:$code).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
          SecureField("主管4位数字 PIN",text:$pin).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
          TextField("实际核对依据（4—1000字）",text:$reason,axis:.vertical).textFieldStyle(.roundedBorder)
          Toggle("已核对现场，同意核对回执或封存尚未执行的原请求",isOn:$confirmed)
          Button(model.busy ? "正在核对原请求…":"登录主管并核对") {
            let entered=pin;pin=""
            Task { await model.resolveServicePending(command:command,login:code,pin:entered,reason:reason) }
          }.buttonStyle(Primary(symbol:"person.badge.shield.checkmark")).disabled(!ready)
          if !model.message.isEmpty {Text(model.message).font(.subheadline)}
        }.padding(16).disabled(model.busy)
      }.background(paper).navigationTitle("主管核对原服务请求").navigationBarTitleDisplayMode(.inline)
        .toolbar {ToolbarItem(placement:.cancellationAction){Button("关闭"){clear();dismiss()}.disabled(model.busy)}}
    }.interactiveDismissDisabled(model.busy)
      .onChange(of:scenePhase){_,phase in if phase != .active {clear();dismiss()}}
      .onChange(of:model.livePending){_,pending in if pending != command {clear();dismiss()}}
      .onDisappear {clear()}
  }
  private var ready:Bool {
    !model.busy && !model.heartbeatBusy && !model.liveStorageDamaged && model.liveOrderPending == nil && model.livePending == command && confirmed
      && (1...64).contains(code.trimmingCharacters(in:.whitespacesAndNewlines).utf16.count)
      && pin.range(of:"^[0-9]{4}$",options:.regularExpression) != nil
      && (4...1000).contains(reason.trimmingCharacters(in:.whitespacesAndNewlines).utf16.count)
  }
}
