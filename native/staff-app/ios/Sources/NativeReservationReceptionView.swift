import SwiftUI

@MainActor private func receptionAccessKey(_ model: AppModel) -> String {
  guard let actor = model.identity else { return "" }
  return actor.staffNavigationKey + ":" + String(model.workspaceVersion)
}
private func receptionField(_ label: String, _ text: Binding<String>) -> some View {
  VStack(alignment: .leading, spacing: 4) {
    Text(label).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    TextField(label, text: text, axis: .vertical).accessibilityLabel(label)
  }
}
struct ReservationAdmissionCreateView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var draft = ReservationAdmissionDraft()
  @State private var people = "2"
  @State private var access = ""
  @State private var error = ""
  @State private var options: ReservationAdmissionOptions?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var reading = false
  private var current: Bool { !access.isEmpty && access == receptionAccessKey(model) && phase == .active }
  private func clearSensitive() { draft.name = ""; draft.contact = ""; draft.note = ""; proposed = nil; confirmed = false; options = nil; error = "" }
  private func refresh() {
    let key = access, start = draft.arrivalAt, end = draft.expectedEndAt
    options = nil; error = ""; reading = true
    Task {
      defer { reading = false }
      do {
        let value = try await model.readReservationAdmission(arrivalAt: start, expectedEndAt: end)
        guard current, access == key, draft.arrivalAt == start, draft.expectedEndAt == end else { return }
        options = value
      } catch { if current && access == key { self.error = error.localizedDescription } }
    }
  }
  private func prepare() {
    do {
      guard current, let actor = model.identity, let options, let count = Int(people) else { throw CatalogError("请填写人数并读取当前预约名额") }
      draft.guestCount = count
      proposed = try draft.command(actor: actor, options: options); confirmed = false; error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      Form {
        if current {
          Section { Text("预约仅登记人数、时间与位置偏好。到店后安排具体桌台并核对实际入座，不提前占用某张桌，也不自动收款。") }
          Section("预约信息") {
            receptionField("预约姓名", $draft.name)
            receptionField("联系方式（仅安全保存原请求）", $draft.contact)
            receptionField("人数（1至200人）", $people).keyboardType(.numberPad)
            DatePicker("到店时间（北京时间）", selection: $draft.arrival).environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            DatePicker("预计结束（北京时间）", selection: $draft.end).environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            Picker("来源", selection: $draft.source) { Text("电话代订").tag("phone"); Text("员工代订").tag("employee") }
            Picker("初始状态", selection: $draft.initialStatus) { Text("确认名额").tag("confirmed"); Text("待确认名额").tag("pending") }
            Picker("位置偏好", selection: $draft.preference) {
              Text("无偏好").tag("no_preference"); Text("舞台氛围").tag("stage_atmosphere"); Text("安静聊天").tag("quiet_chat"); Text("舒适卡座").tag("comfortable_booth"); Text("户外景观").tag("outdoor_view")
            }
            receptionField("备注（可选，最多1000字）", $draft.note)
          }
          Section("核对名额") {
            Button(reading ? "正在读取" : "读取当前政策与名额", action: refresh).disabled(reading || model.busy || model.heartbeatBusy)
            if let options {
              Text("接待容量\(options.totalGuests)人 · 已约\(options.committedGuests)人 · 可登记\(options.remainingGuests)人")
              Text("最多提前\(options.maxAdvanceDays)天；到店宽限\(options.arrivalGraceMinutes)分钟。最终名额以服务器提交时校验为准。").font(.caption)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("继续核对", action: prepare).disabled(options == nil || reading || model.busy || model.livePending != nil)
          }
        }
      }.navigationTitle("登记预约名额").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { clearSensitive(); dismiss() } } }
    }.tint(ink)
      .task { access = receptionAccessKey(model) }
      .onChange(of: draft.arrival) { _, _ in options = nil; proposed = nil }
      .onChange(of: draft.end) { _, _ in options = nil; proposed = nil }
      .onChange(of: receptionAccessKey(model)) { _, _ in clearSensitive(); dismiss() }
      .onChange(of: phase) { _, new in if new != .active { clearSensitive() } }
      .onDisappear { clearSensitive() }
      .sheet(item: $proposed) { command in
        ReceptionConfirmationView(command: command, current: current, confirmed: $confirmed) {
          clearSensitive(); dismiss(); Task { await model.executeLive(command) }
        }
      }
  }
}
struct ReservationReceptionView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  let reservationId: String
  @State private var access = ""
  @State private var error = ""
  @State private var reason = ""
  @State private var detail: ReservationReceptionDetail?
  @State private var selection: ReservationReceptionSelection?
  @State private var selected: Set<String> = []
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  @State private var reading = false
  private var current: Bool { !access.isEmpty && access == receptionAccessKey(model) && phase == .active }
  private var total: Int { selection?.sessions.filter { selected.contains($0.id) }.reduce(0) { $0 + $1.guestCount } ?? 0 }
  private func clear() { detail = nil; selection = nil; selected = []; proposed = nil; confirmed = false; reason = ""; error = "" }
  private func load() {
    clear(); reading = true; let key = access
    Task {
      defer { reading = false }
      do {
        let value = try await model.readReservationReceptionDetail(id: reservationId)
        guard current, key == access else { return }; detail = value
        if value.reservation.status == "arrived", model.identity?.allows("reservation.manage") == true, model.identity?.allows("table.open") == true {
          let available = try await model.readReservationReceptionSessions(id: reservationId)
          guard current, key == access else { return }; selection = available
        }
      } catch { if current && key == access { self.error = error.localizedDescription } }
    }
  }
  private func propose() {
    do {
      guard current, let actor = model.identity, let selection else { throw CatalogError("请重新读取本次可用桌次") }
      proposed = try selection.command(selected: selected, reason: reason, actor: actor); confirmed = false
    } catch { self.error = error.localizedDescription }
  }
  @ViewBuilder private var content: some View {
    if let detail {
      Card {
        Text(detail.reservation.customerName).font(.headline)
        Text("预约\(detail.reservation.guestCount)人 · " + detail.reservation.statusLabel)
        Text(receptionDisplayTime(detail.reservation.arrivalAt) + " — " + receptionDisplayTime(detail.reservation.expectedEndAt)).font(.caption)
        Text(detail.reservation.publicId).font(.caption).textSelection(.enabled)
      }
      if detail.batchId != nil {
        Card {
          Text("已确认实际入座").font(.headline)
          Text("实际\(detail.seatedGuestCount ?? 0)人 · " + receptionDisplayTime(detail.seatedAt ?? ""))
          ForEach(detail.sessions) { row in
            VStack(alignment: .leading, spacing: 4) {
              Text("入座时：\(row.originalTable) · \(row.originalGuests)人")
              Text("当前桌位：\(row.currentTable) · " + (["open": "营业中", "closing": "正在关台", "closed": "已结束", "cancelled": "已取消"][row.currentStatus] ?? "待核对")).font(.caption)
            }
          }
          Text(detail.reason ?? "").font(.subheadline)
          Text("这条关联不会因转桌丢失，也不会改写原顾客账单。").font(.caption)
        }
      } else if let selection, selection.reservationStatus == "arrived" {
        Card {
          Text("核对本组全部实际桌位").font(.headline)
          Text("先沿原开台流程安排桌位，再从下面选择已开桌次。可一次确认1—20桌；不支持部分入座后追加或改绑。").font(.subheadline)
          if selection.sessions.isEmpty { Text("当前没有你有权关联的已开桌次。请核对开台、当前桌台责任与营业日后重新读取。").foregroundStyle(.secondary) }
          ForEach(selection.sessions) { row in
            Toggle(isOn: Binding(get: { selected.contains(row.id) }, set: { if $0 { selected.insert(row.id) } else { selected.remove(row.id) } })) {
              VStack(alignment: .leading) { Text("\(row.tableCode) · \(row.guestCount)人"); Text("营业日 " + row.businessDate).font(.caption) }
            }
          }
          Text("已选\(selected.count)桌，实际\(total)人；预约\(selection.reservationGuestCount)人").font(.headline)
          if total != selection.reservationGuestCount { Text("实际人数与预约不同，请核对这是否为本组全部桌位，并在说明中填写实际原因。").foregroundStyle(.orange) }
          receptionField("实际接待核对说明（4至1000字）", $reason)
          Button("核对并确认本组入座", action: propose).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(selected.isEmpty || selected.count > 20 || model.busy || model.livePending != nil)
        }
      } else {
        Text(detail.reservation.status == "arrived" ? "需要预约处理及开台权限，才能核对并关联实际桌次。" : "该预约尚无实际接待关联。旧已结束历史不补造入座记录。").font(.subheadline)
      }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current { content; if !error.isEmpty { Text(error).foregroundStyle(.red) }; Button(reading ? "正在读取" : "重新读取接待记录", action: load).buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(reading || model.busy || model.heartbeatBusy) }
        }.padding(16)
      }.background(paper).navigationTitle("实际接待与桌次").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { clear(); dismiss() } } }
    }.tint(ink).task { access = receptionAccessKey(model); load() }
      .onChange(of: receptionAccessKey(model)) { _, _ in clear(); dismiss() }
      .onChange(of: phase) { _, new in if new != .active { clear() } }
      .onDisappear { clear() }
      .sheet(item: $proposed) { command in ReceptionConfirmationView(command: command, current: current, confirmed: $confirmed) { clear(); dismiss(); Task { await model.executeLive(command) } } }
  }
}
private struct ReceptionConfirmationView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let command: LiveCommand
  let current: Bool
  @Binding var confirmed: Bool
  let submit: () -> Void
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: 18) {
        if current {
          Text(command.steps.first?.reservationReceptionProof?["confirmation"] as? String ?? "请返回重新核对")
          Toggle("已核对原预约与本次全部信息", isOn: $confirmed)
          Text("发送后若未收到结果，将保留原请求和原编号，请从待核对记录恢复，不要另建一单。").font(.caption)
          Button("确认提交", action: submit).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canExecuteLive(command))
        }
      }.padding(20) }.background(paper).navigationTitle("确认预约接待").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { dismiss() } } }
    }.tint(ink)
  }
}
