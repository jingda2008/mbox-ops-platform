import SwiftUI
struct LiveMemberNumberView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: String] = [:]
  @State private var padZero = true
  @State private var reason = ""
  @State private var error = ""
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var access: String?
  private var accessKey: String { guard let actor = model.identity else { return "" }; return actor.employee.id + ":" + actor.session.id + ":" + String(actor.allows("member.card.manage")) }
  private func clear() { fields = [:]; reason = ""; proposed = nil; confirmed = false; error = "" }
  private func populate() {
    clear(); guard let p = model.memberNumberBoard?.policy else { return }
    fields = ["width": String(p.width), "startNumber": String(p.startNumber), "maximumPrefixLength": String(p.maximumPrefixLength), "alphabet": p.alphabet]; padZero = p.padZero
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if access == accessKey && !accessKey.isEmpty {
            Text("数字号段用尽后按字母前缀继续发号。原会员号保持不变，实际发号会跳过已占用号码。").font(.subheadline)
            Text(model.memberNumberState).font(.caption)
            Button("刷新配置，放弃未保存修改") { clear(); Task { await model.loadMemberNumber(); populate() } }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            if let board = model.memberNumberBoard, board.employeeID == model.identity?.employee.id, !fields.isEmpty {
              Card {
                ForEach(["width", "startNumber", "maximumPrefixLength", "alphabet"], id: \.self) { key in
                  Text(["width": "总位数（4—12）", "startNumber": "起始数字", "maximumPrefixLength": "最长字母前缀（0—4）", "alphabet": "字母顺序（不重复大写A—Z）"][key]!).font(.caption)
                  TextField("填写规则", text: Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 })).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Toggle("不足位数补零", isOn: $padZero)
                Text("已保存规则的下一个候选号：" + (board.nextCandidate ?? "号段已用尽，请调整配置")).font(.caption)
                Text("候选号是服务器当前读回结果；编辑中的内容尚未生效，也不保证该号码最终可用。").font(.caption)
                TextField("变更原因（2—300字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
                Button("核对会员号规则") { do { guard let actor = model.identity else { throw StaffAPIError.invalid }; proposed = try board.command(actor: actor, fields: fields, padZero: padZero, reason: reason); confirmed = false } catch { self.error = error.localizedDescription } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseMemberNumber)
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("会员号规则").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey; await model.loadMemberNumber(); populate() }
      .onChange(of: model.memberNumberBoard?.version) { _, _ in populate() }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if access == accessKey, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.memberNumberProof?["confirmation"] as? String ?? "请重新读取原配置")
                Toggle("已核对号段、字母顺序与影响范围", isOn: $confirmed)
                Button("确认保存") { proposed = nil; Task { await model.executeLive(command); populate() } }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseMemberNumber || !model.canExecuteLive(command))
              }
            }.padding(20)
          }.background(paper).navigationTitle("确认会员号规则").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } } }
        }.tint(ink)
      }
  }
}
