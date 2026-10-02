import SwiftUI

struct ReservationCreateView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State var draft = ReservationDraft()
  @State var query = ""
  @State var error = ""
  @State var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("员工代订，负责人为当前员工。提交后核对占位结果；已有开台情况不代表未来可订。").font(.caption).foregroundStyle(.secondary)
          Card {
            TextField("顾客姓名", text: $draft.name).textFieldStyle(.roundedBorder)
            TextField("联系方式", text: $draft.contact).textFieldStyle(.roundedBorder).textContentType(
              .telephoneNumber)
            Stepper("到店人数 \(draft.people)", value: $draft.people, in: 1...200)
            DatePicker("到店时间", selection: $draft.arrival, in: Date()...).environment(
              \.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            DatePicker("预计结束", selection: $draft.end, in: draft.arrival...).environment(
              \.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            Text("时间按上海时区填写").font(.caption)
            Picker("来源", selection: $draft.source) {
              Text("电话预约").tag("phone")
              Text("员工代订").tag("employee")
            }
            Picker("状态", selection: $draft.initial) {
              Text("确认预约").tag("confirmed")
              Text("暂留待确认").tag("pending")
            }
            Picker("位置偏好", selection: $draft.seat) {
              Text("无偏好").tag("no_preference")
              Text("舞台氛围").tag("stage_atmosphere")
              Text("安静聊天").tag("quiet_chat")
              Text("舒适卡座").tag("comfortable_booth")
              Text("户外景观").tag("outdoor_view")
            }
            TextField("备注", text: $draft.note, axis: .vertical).textFieldStyle(.roundedBorder)
          }
          HStack {
            Text("选择桌台").font(.headline)
            Spacer()
            Text("已选 \(draft.tables.count) 张").font(.caption)
          }
          TextField("模糊搜索桌号 / 区域", text: $query).textFieldStyle(.roundedBorder)
          Text("提交时会检查同一时段预约冲突。若人数超出桌台总容量，请重新选桌。").font(.caption)
          ForEach(
            model.reservationTables.filter {
              query.isEmpty || ($0.code + " " + $0.areaName).localizedCaseInsensitiveContains(query)
            }
          ) { table in
            Toggle(
              isOn: Binding(
                get: { draft.tables.contains(table.id) },
                set: {
                  if $0 { draft.tables.insert(table.id) } else { draft.tables.remove(table.id) }
                })
            ) { Text("\(table.code) · \(table.areaName) · \(table.capacity)人") }.padding(10)
              .background(.white, in: RoundedRectangle(cornerRadius: 12))
          }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          Button("下一步 · 核对预约") {
            do {
              guard let actor = model.identity else { throw CatalogError("请重新登录") }
              proposed = try draft.command(actor: actor, choices: model.reservationTables)
            } catch { self.error = error.localizedDescription }
          }
          .buttonStyle(Primary(symbol: "calendar.badge.plus")).disabled(
            !model.canUseReservations || model.reservationCapabilities?.durableCreate != true)
        }.padding(16)
      }.background(paper).navigationTitle("新建预约").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
      }
    }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          VStack(alignment: .leading, spacing: 18) {
            Text(command.steps[0].reservationProof?["confirmation"] as? String ?? "请核对预约")
            Button("确认创建预约") {
              proposed = nil
              dismiss()
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
            Spacer()
          }.padding(20).navigationTitle("核对预约").toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
          }
        }
      }
  }
}
