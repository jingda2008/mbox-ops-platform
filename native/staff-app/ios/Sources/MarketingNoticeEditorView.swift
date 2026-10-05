import SwiftUI
struct MarketingNoticeEditorView: View {
  @EnvironmentObject var model: AppModel
  let code: String, source: MarketingRecord?
  let close: () -> Void, save: ([String: Any]) -> Void
  @State private var fields: [String: String]
  @State private var channels: Set<String>
  @State private var purposes: Set<String>
  @State private var weekdays: Set<Int>
  @State private var reason = ""
  @State private var error = ""
  init(code: String, source: MarketingRecord?, close: @escaping () -> Void, save: @escaping ([String: Any]) -> Void) {
    self.code = code; self.source = source; self.close = close; self.save = save
    let r = source?.object["rule"] as? [String: Any] ?? [:]
    var f: [String: String] = [:]
    for k in ["operatorName", "operatorContact", "summary", "withdrawalInstructions", "consentDays", "maximumPerDay", "maximumPerMonth"] { f[k] = membershipText(r[k]) }
    for k in ["validFrom", "validUntil"] { f[k] = (try? membershipLocal(membershipText(r[k]))) ?? "" }
    for k in ["contactStartMinute", "contactEndMinute"] { f[k] = (try? walletInteger(r[k])).map(couponCalendarClock) ?? "" }
    f["dataCategories"] = (r["dataCategories"] as? [String] ?? []).joined(separator: "\n")
    _fields = State(initialValue: f); _channels = State(initialValue: Set(r["channels"] as? [String] ?? [])); _purposes = State(initialValue: Set(r["purposes"] as? [String] ?? [])); _weekdays = State(initialValue: Set(r["weekdays"] as? [Int] ?? []))
  }
  private func text(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func selected(_ value: String, channel: Bool) -> Binding<Bool> {
    Binding(get: { (channel ? channels : purposes).contains(value) }, set: { checked in if channel { if checked { channels.insert(value) } else { channels.remove(value) } } else { if checked { purposes.insert(value) } else { purposes.remove(value) } } })
  }
  private func day(_ n: Int) -> Binding<Bool> { Binding(get: { weekdays.contains(n) }, set: { if $0 { weekdays.insert(n) } else { weekdays.remove(n) } }) }
  private func prepare() {
    do {
      var r: [String: Any] = [:]
      for k in ["operatorName", "operatorContact", "summary", "withdrawalInstructions"] { r[k] = fields[k] ?? "" }
      for k in ["validFrom", "validUntil"] { r[k] = try membershipDate(fields[k] ?? "") }
      for k in ["consentDays", "maximumPerDay", "maximumPerMonth"] { r[k] = try walletInteger(fields[k]) }
      r["contactStartMinute"] = try couponCalendarMinute(fields["contactStartMinute"] ?? "", end: false)
      r["contactEndMinute"] = try couponCalendarMinute(fields["contactEndMinute"] ?? "", end: true)
      r["channels"] = channels.sorted(); r["purposes"] = purposes.sorted(); r["weekdays"] = weekdays.sorted(); r["sharingMode"] = "no_partner_list"
      r["dataCategories"] = (fields["dataCategories"] ?? "").components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
      save(["code": code, "rule": try marketingRule(r), "reason": reason]); error = ""
    } catch { self.error = error.localizedDescription }
  }
  private var noticeFields: some View {
    VStack(alignment: .leading, spacing: 12) {
      annualInput("实际经营主体（2至200字）", text("operatorName"))
      annualInput("经营主体联系方式（2至300字）", text("operatorContact"))
      annualInput("营销用途与范围（2至3000字）", text("summary"))
      annualInput("顾客停止联系的方法（2至1000字）", text("withdrawalInstructions"))
      Text("允许联系渠道").font(.headline)
      ForEach(marketingChannels, id: \.0) { value, label in Toggle(label, isOn: selected(value, channel: true)) }
      Text("允许联系用途").font(.headline)
      ForEach(marketingPurposes, id: \.0) { value, label in Toggle(label, isOn: selected(value, channel: false)) }
      annualInput("必要资料类型（每行一项，1至20项）", text("dataCategories"))
    }
  }
  private var contactWindow: some View {
    VStack(alignment: .leading, spacing: 12) {
      annualInput("告知开始（北京时间 YYYY-MM-DD HH:mm:ss）", text("validFrom"))
      annualInput("告知结束（北京时间 YYYY-MM-DD HH:mm:ss）", text("validUntil"))
      annualInput("本人许可有效天数（1至3660）", text("consentDays"))
      annualInput("允许联系开始（HH:mm）", text("contactStartMinute"))
      annualInput("允许联系结束（HH:mm，可填24:00）", text("contactEndMinute"))
      Text("联系时段不可跨午夜；按北京时间和以下星期核验。").font(.caption)
      ForEach(1...7, id: \.self) { n in Toggle(["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][n - 1], isOn: day(n)) }
      annualInput("每日最多联系次数（1至100）", text("maximumPerDay"))
      annualInput("每月最多联系次数（1至1000）", text("maximumPerMonth"))
    }
  }
  var body: some View {
    Card {
      Text("告知 " + code + " · 下一版完整草稿").font(.title3.bold())
      noticeFields
      contactWindow
      Text("不向独立合作方提供名单。新告知需独立审核与第三人发布；发布不会替顾客选择同意，也不会直接发送营销内容。").font(.subheadline)
      annualInput("建立新版本的实际依据（2至500字）", $reason)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("继续核对完整告知", action: prepare).buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseMarketing || model.marketingBoard?.code != code)
      Button("返回并放弃未提交草稿", action: close)
    }
  }
}
