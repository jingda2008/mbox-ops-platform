import SwiftUI
struct CouponCalendarEditorView: View {
  @EnvironmentObject var model: AppModel
  let row: CouponPolicyRecord?
  let close: () -> Void
  let save: ([String: Any]) -> Void
  @State private var draft: CouponCalendarDraft
  @State private var at: String
  @State private var issuedAt = ""
  @State private var preview: CouponCalendarPreview?
  @State private var error = ""
  @State private var loading = false
  @State private var generation = 0
  init(row: CouponPolicyRecord?, close: @escaping () -> Void, save: @escaping ([String: Any]) -> Void) {
    self.row = row; self.close = close; self.save = save
    _draft = State(initialValue: CouponCalendarDraft(row: row))
    _at = State(initialValue: (try? membershipLocal(ISO8601DateFormatter().string(from: Date()))) ?? "")
  }
  private func field(_ key: String) -> Binding<String> { Binding(get: { draft.fields[key] ?? "" }, set: { draft.fields[key] = $0 }) }
  private func input(_ key: String, _ title: String) -> some View { VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption); TextField(title, text: field(key)).textFieldStyle(.roundedBorder) } }
  private func invalidate() { generation += 1; preview = nil }
  private func calculate(from: String? = nil) {
    guard !loading else { return }
    do {
      let body = try draft.preview(at: at, issuedAt: issuedAt, from: from), ticket = generation
      loading = true
      Task {
        defer { loading = false }
        do {
          let data = try await model.readCouponPolicyPreview(kind: .calendar, body: body)
          guard ticket == generation, let actor = model.identity else { return }
          preview = try CouponCalendarPreview(data: data, actor: actor, body: body); error = ""
        } catch { if ticket == generation { preview = nil; self.error = error.localizedDescription } }
      }
    } catch { preview = nil; self.error = error.localizedDescription }
  }
  private var dates: some View {
    VStack(alignment: .leading, spacing: 12) {
      input("code", "规则编号（2—40位大写字母、数字、下划线）")
      Text("同编号换日口径和周起点不能改写，以免重置既有使用计数；修订会另建新版本。").font(.caption)
      input("dateFrom", "起始日期 YYYY-MM-DD"); input("dateThrough", "最后日期 YYYY-MM-DD")
      input("validFrom", "绝对开始（北京时间 YYYY-MM-DD HH:mm:ss）")
      input("validUntil", "绝对截止（北京时间 YYYY-MM-DD HH:mm:ss）")
      Picker("日期归属", selection: field("dateBasis")) { Text("自然日").tag("natural"); Text("营业日").tag("business") }.pickerStyle(.menu)
      if draft.fields["dateBasis"] == "business" { input("cutoff", "营业日换日时刻 HH:mm") }
      Picker("每周次数起算日", selection: field("weekStartsOn")) { ForEach(1...7, id: \.self) { n in Text("周" + couponWeekdayNames[n - 1]).tag(String(n)) } }.pickerStyle(.menu)
    }
  }
  private var windows: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("可用星期").font(.headline)
      ForEach(1...7, id: \.self) { day in
        Toggle("周" + couponWeekdayNames[day - 1], isOn: Binding(get: { draft.weekdays.contains(day) }, set: { if $0 { draft.weekdays.insert(day) } else { draft.weekdays.remove(day) } }))
      }
      Text("每日时段：结束早于开始表示跨午夜；全天为00:00至24:00。").font(.caption)
      ForEach($draft.windows) { $window in
        VStack(alignment: .leading, spacing: 8) {
          VStack(alignment: .leading, spacing: 4) {
            Text("开始时刻 HH:mm").font(.caption)
            TextField("例如 18:00", text: $window.from).textFieldStyle(.roundedBorder)
              .accessibilityLabel("每日时段开始时刻，小时与分钟")
          }
          VStack(alignment: .leading, spacing: 4) {
            Text("结束时刻 HH:mm（可填24:00）").font(.caption)
            TextField("例如 24:00", text: $window.to).textFieldStyle(.roundedBorder)
              .accessibilityLabel("每日时段结束时刻，小时与分钟")
          }
          if draft.windows.count > 1 { Button("移除此时段", role: .destructive) { draft.windows.removeAll { $0.id == window.id } } }
        }
      }
      Button("添加时段（最多12段）") { draft.windows.append(CouponCalendarWindow(from: "18:00", to: "20:00")) }.disabled(draft.windows.count >= 12)
      TextField("排除日期，逗号或换行分隔", text: field("excludedDates"), axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
    }
  }
  private var limits: some View {
    VStack(alignment: .leading, spacing: 12) {
      input("relativeDays", "发放后有效天数（1—3660，可留空）")
      if !(draft.fields["relativeDays"] ?? "").isEmpty {
        Picker("发放后截止口径", selection: field("relativeBasis")) { ForEach(couponRelativeBases, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.menu)
      }
      Text("相对期限与绝对有效期取交集；实际发券使用后台时间，预览不会发券或改变使用次数。").font(.caption)
      ForEach(couponCalendarLimitLabels, id: \.0) { input($0.0, $0.1 + "（空白不额外限制，1—1000000）") }
      input("reason", "保存原因（2至500字）")
    }
  }
  private var previewControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      DisclosureGroup("模拟时间与发放后期限") {
        TextField("预览当前时间（北京时间）", text: $at).textFieldStyle(.roundedBorder)
        TextField("模拟发放时间（可留空）", text: $issuedAt).textFieldStyle(.roundedBorder)
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button(loading ? "正在计算" : "预览可用日历") { calculate() }.buttonStyle(Primary(tone: .secondary, symbol: "calendar")).disabled(loading || model.busy || model.heartbeatBusy)
      if model.identity?.allows("loyalty.configuration.edit") == true {
        Button("核对并保存新草稿") { do { save(try draft.save(row: row)); error = "" } catch { self.error = error.localizedDescription } }
          .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseCouponPolicy || loading)
      }
    }
  }
  @ViewBuilder private var previewResult: some View {
    if let preview {
      let p = preview.object
      Card {
        Text("仅日历预览，不发券").font(.headline)
        Text("下一可用：" + ((p["nextAvailableAt"] as? String).map(reservationTime) ?? "没有后续可用时段"))
        Text("最后截止：" + ((p["lastAvailableUntil"] as? String).map(reservationTime) ?? "没有可用时段"))
        Text("此刻归属使用日 " + membershipText(p["usageDate"]) + "，使用周从 " + membershipText(p["usageWeekStart"]) + " 起算").font(.caption)
        ForEach(Array((p["calendar"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, day in
          Text(membershipText(day["date"])).font(.headline)
          if let windows = day["windows"] as? [[String: Any]], !windows.isEmpty {
            ForEach(Array(windows.enumerated()), id: \.offset) { _, w in Text(membershipRecordTime(membershipText(w["from"])) + " 至 " + membershipRecordTime(membershipText(w["until"]))) }
          } else { Text((day["reasons"] as? [String] ?? ["无可用时段"]).joined(separator: "；")).font(.caption) }
        }
        if let next = preview.next { Button("预览后续日期") { calculate(from: next) }.disabled(loading || model.busy) }
      }
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Card {
        Text(row == nil ? "新规则草稿" : "读取第" + row!.text("version") + "版，修订另建新版本").font(.headline)
        Button("返回规则列表", action: close)
        dates; windows; limits; previewControls
      }
      previewResult
    }.onChange(of: draft) { _, _ in invalidate() }
      .onChange(of: at) { _, _ in invalidate() }.onChange(of: issuedAt) { _, _ in invalidate() }
  }
}
