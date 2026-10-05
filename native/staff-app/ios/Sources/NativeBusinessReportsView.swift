import SwiftUI

private struct NativeBusinessReportOptions {
  let products: [NativeBusinessMetricRow]
  let staff: [NativeBusinessMetricRow]
  let packageOptions: [NativeBusinessMetricRow]
}
struct NativeBusinessReportsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var draft = NativeBusinessReportQuery(kind: .sales)
  @State private var report: NativeBusinessReport?
  @State private var options: NativeBusinessReportOptions?
  @State private var search = ""
  @State private var error = ""
  @State private var reading = false
  @State private var generation = 0
  private var allowed: [NativeBusinessReportKind] {
    guard let actor = model.identity else { return [] }
    return NativeBusinessReportKind.allCases.filter { $0.available(to: actor) }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          if allowed.isEmpty { Text("当前岗位没有读取经营分析的权限。") }
          else {
            Picker("报表", selection: $draft.kind) {
              ForEach(allowed, id: \.self) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented)
            filters
            Button(reading ? "正在读取原范围…" : "读取报表") { Task { await load() } }
              .buttonStyle(Primary(symbol: "arrow.clockwise")).disabled(reading || model.busy)
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if let report, report.staffNavigationKey == model.identity?.staffNavigationKey {
              if report.query.kind == .sales { sales(report) }
              else { experience(report) }
            } else if !reading { Text("选择条件后读取。调整条件会清除上一范围的结果，避免混用。").font(.caption).foregroundStyle(.secondary) }
          }
        }.padding()
      }.background(paper).navigationTitle("销售与客户体验").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .task { if !allowed.contains(draft.kind), let first = allowed.first { draft.kind = first } }
        .onChange(of: draft) { _, _ in generation += 1; report = nil; error = "" }
        .onChange(of: model.identity?.staffNavigationKey) { _, _ in reset() }
        .onChange(of: model.workspaceVersion) { _, _ in reset() }
        .onChange(of: phase) { _, value in if value != .active { reset() } }
        .onDisappear { reset() }
    }
  }
  @ViewBuilder private var filters: some View {
    Card {
      VStack(alignment: .leading, spacing: 12) {
        if draft.kind == .sales {
          Text("按门店营业日归属查询；留空读取服务器当前营业日。结果范围由当前员工权限及授权名单决定。").font(.caption)
          TextField("开始营业日 YYYY-MM-DD", text: $draft.startDate).textInputAutocapitalization(.never).autocorrectionDisabled()
          TextField("结束营业日 YYYY-MM-DD", text: $draft.endDate).textInputAutocapitalization(.never).autocorrectionDisabled()
        } else {
          Picker("时间范围", selection: $draft.days) { ForEach([7,28,84], id: \.self) { Text("最近\($0)天").tag($0) } }
          Picker("商品", selection: $draft.productID) {
            Text("全部商品").tag("")
            ForEach(options?.products ?? []) { Text($0.text("productName")).tag($0.text("productId")) }
            if !draft.productID.isEmpty && !(options?.products.contains { $0.text("productId") == draft.productID } ?? false) { Text("指定商品").tag(draft.productID) }
          }
          Picker("员工", selection: $draft.employeeID) {
            Text("全部授权员工").tag("")
            ForEach(options?.staff ?? []) { Text($0.text("employeeName")).tag($0.text("employeeId")) }
            if !draft.employeeID.isEmpty && !(options?.staff.contains { $0.text("employeeId") == draft.employeeID } ?? false) { Text("指定员工").tag(draft.employeeID) }
          }
          Picker("套餐", selection: $draft.packageProductID) {
            Text("全部套餐").tag("")
            ForEach(options?.packageOptions ?? []) { Text($0.text("productName")).tag($0.text("productId")) }
            if !draft.packageProductID.isEmpty && !(options?.packageOptions.contains { $0.text("productId") == draft.packageProductID } ?? false) { Text("指定套餐").tag(draft.packageProductID) }
          }
          TextField("人数（1–100，可留空）", text: $draft.partySize).keyboardType(.numberPad)
          TextField("桌号（可留空）", text: $draft.tableCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
          optionPicker("场景", values: NativeBusinessReportQuery.occasions, selection: $draft.occasion)
          optionPicker("演出阶段", values: NativeBusinessReportQuery.phases, selection: $draft.performancePhase)
          optionPicker("推荐结果", values: NativeBusinessReportQuery.outcomes, selection: $draft.recommendationOutcome)
          Text("商品、员工及套餐选项来自最近一次已授权读取。客群历史分组缺少事件时点事实，当前不提供该筛选。").font(.caption).foregroundStyle(.secondary)
        }
        DisclosureGroup("指定已有商品或员工编号") {
          VStack(spacing: 12) {
            Text("仅按已有编号缩小范围，不会扩大员工授权。可先读取，再从名称列表选择。").font(.caption)
            TextField("商品编号（可留空）", text: $draft.productID).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("员工编号（可留空）", text: $draft.employeeID).textInputAutocapitalization(.never).autocorrectionDisabled()
            if draft.kind == .experience { TextField("套餐编号（可留空）", text: $draft.packageProductID).textInputAutocapitalization(.never).autocorrectionDisabled() }
          }.padding(.top, 8)
        }
      }.textFieldStyle(.roundedBorder)
    }
  }
  private func optionPicker(_ label: String, values: [(String, String)], selection: Binding<String>) -> some View {
    Picker(label, selection: selection) { ForEach(values, id: \.0) { Text($0.1).tag($0.0) } }
  }
  @ViewBuilder private func sales(_ report: NativeBusinessReport) -> some View {
    Text(report.query.startDate.isEmpty ? "服务器当前营业日" : "营业日 \(report.query.startDate) 至 \(report.query.endDate)").font(.headline)
    Text("员工销售归属与退款冲回，不等于净收款、工资或提成。成本缺失时不把贡献当作零。").font(.caption)
    TextField("在本次结果中搜索员工或商品", text: $search).textFieldStyle(.roundedBorder)
    let rows = report.sales.filter { search.isEmpty || [$0.text("employeeCode"), $0.text("employeeDisplayName"), $0.text("productCode"), $0.text("productName")].contains { $0.localizedCaseInsensitiveContains(search) } }
    if rows.isEmpty { Text("本次授权范围内没有匹配的销售记录。") }
    ForEach(rows) { row in
      Card {
        VStack(alignment: .leading, spacing: 9) {
          Text(row.text("employeeDisplayName") + " · " + row.text("productName")).font(.headline)
          Text("数量 \(row.text("quantity")) · \(row.text("employeeCode")) / \(row.text("productCode"))").font(.caption)
          metric("销售归属", row.amount("salesAmountMinor")); metric("退款冲回", row.amount("refundReversalAmountMinor"))
          metric("成本", row.amount("costAmountMinor")); metric("贡献", row.amount("contributionProfitMinor"))
          if row.values["costCoverageComplete"] as? Bool != true { Text("成本覆盖不完整，相关金额仅作已知部分参考。").font(.caption).foregroundStyle(.orange) }
        }
      }
    }
  }
  @ViewBuilder private func experience(_ report: NativeBusinessReport) -> some View {
    Text("生成于 \(report.generatedAt)").font(.caption).foregroundStyle(.secondary)
    Text(report.decisionBoundary).font(.subheadline)
    DisclosureGroup("口径与可用事实") {
      VStack(alignment: .leading, spacing: 8) {
        Text("时间为最近\(report.query.days)天，订单与现场观察按各自事实发生时间归属。同桌后续付款、同品复购只说明关联，不能据此认定推荐造成成交。")
        Text("场景：" + report.occasionBasis); Text("套餐：" + report.packageBasis); Text("客群：" + report.segmentBoundary)
      }.font(.caption).padding(.top, 8)
    }
    if let quality = report.quality {
      Card {
        VStack(alignment: .leading, spacing: 9) {
          Text("数据质量").font(.headline)
          metric("输入 / 已确认", "\(quality.count("totalInputs")) / \(quality.count("confirmedInputs"))")
          metric("未匹配 / 更正事件", "\(quality.count("unmatchedInputs")) / \(quality.count("correctedEvents"))")
          metric("未匹配率", quality.ratio("unmatchedInputs", "totalInputs")); metric("更正率", quality.ratio("correctedEvents", "confirmedInputs"))
          if let missing = report.missingFacts {
            metric("推荐缺曝光事实", "\(missing.count("recommendationWithoutExposureCount"))")
            metric("已付推荐缺成本", "\(missing.count("paidRecommendationCostUnavailableCount"))")
            metric("投诉缺订单关联", "\(missing.count("complaintWithoutOrderLinkCount"))")
          }
        }
      }
    }
    DisclosureGroup("推荐结果（\(report.recommendations.count)）") {
      ForEach(report.recommendations) { row in
        metricCard(row, title: row.text("productName"), counts: [("生成", "generated"), ("曝光", "exposed"), ("选择", "selected"), ("忽略", "ignored"), ("拒绝", "rejected"), ("员工调整", "staffModified"), ("下单", "ordered"), ("付款", "paid"), ("退款", "refunded"), ("关联投诉", "complaintOrderCount"), ("同桌后续付款", "followOnPaidOrderCount"), ("同品复购", "repeatPurchaseOrderCount")], amounts: [("已付", "paidAmountMinor"), ("已退", "refundedAmountMinor"), ("成交时成本", "frozenCostMinor"), ("贡献", "contributionAmountMinor")])
      }
    }
    DisclosureGroup("商品体验（\(report.products.count)）") {
      ForEach(report.products) { row in
        metricCard(row, title: row.text("productName"), counts: [("付款订单", "paidOrderCount"), ("观察", "observationCount"), ("好评", "praiseCount"), ("投诉", "complaintCount"), ("剩余", "remainingCount"), ("上菜晚", "servedLateCount"), ("更正", "correctedCount")], amounts: [("实付销售", "paidRevenueMinor"), ("退款", "refundedAmountMinor"), ("成交时成本", "frozenCostMinor"), ("贡献", "contributionAmountMinor")])
        metric("销售数量", row.number("soldQuantity").map { String($0) } ?? "数据不足")
        metric("平均观察置信度", row.number("averageObservationConfidence").map { String(format: "%.0f%%", $0 * 100) } ?? "数据不足")
      }
    }
    DisclosureGroup("员工记录质量（\(report.staff.count)）") {
      Text("用于核对记录质量；记录量、正负反馈不直接作为员工考核结论。").font(.caption)
      ForEach(report.staff) { row in
        metricCard(row, title: row.text("employeeName"), counts: [("输入", "inputCount"), ("已确认", "confirmedCount"), ("未匹配", "unmatchedInputCount"), ("更正", "correctedEventCount"), ("正向", "positiveEventCount"), ("中性", "neutralEventCount"), ("负向", "negativeEventCount")], amounts: [])
      }
    }
    DisclosureGroup("人工复核建议（\(report.suggestions.count)）") {
      ForEach(report.suggestions) { row in
        Card {
          VStack(alignment: .leading, spacing: 8) {
            Text(row.text("productName")).font(.headline); Text(row.text("recommendation"))
            metric("样本 / 支持 / 反向", "\(row.count("sampleSize")) / \(row.count("supportingEvidence")) / \(row.count("opposingEvidence"))")
            metric("置信度", String(format: "%.0f%%", (row.number("confidence") ?? 0) * 100))
            Text(["insufficient": "样本不足", "directional": "方向性线索", "moderate": "中等证据", "strong": "较强证据"][row.text("confidenceBasis")] ?? "待核对").font(.caption)
          }
        }
      }
    }
    DisclosureGroup("现场观察证据（\(report.evidence.count)）") {
      if !report.rawEvidencePermitted { Text("当前岗位没有查看观察原文的权限；聚合分析仍可读取。").font(.caption) }
      else {
        Text("最多读取当前条件下最近50条；时间范围与聚合请求一致，分别读取期间仍可能有新记录。").font(.caption)
        ForEach(report.evidence) { row in
          Card {
            VStack(alignment: .leading, spacing: 8) {
              Text(row.text("tableCode") + " · " + row.text("employeeName")).font(.headline)
              Text(row.text("productName").isEmpty ? "未关联商品" : row.text("productName"))
              Text(row.text("rawExcerpt")).textSelection(.enabled)
              Text(row.text("occurredAt") + " · 版本\(row.count("revisionNo"))" + ((row.values["corrected"] as? Bool == true) ? " · 已更正" : "")).font(.caption)
              metric("置信度", String(format: "%.0f%%", (row.number("confidence") ?? 0) * 100))
            }
          }
        }
      }
    }
  }
  private func metric(_ title: String, _ value: String) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline) { Text(title).foregroundStyle(.secondary); Spacer(minLength: 12); Text(value) }
      VStack(alignment: .leading, spacing: 4) { Text(title).foregroundStyle(.secondary); Text(value) }
    }.font(.subheadline)
  }
  private func metricCard(_ row: NativeBusinessMetricRow, title: String, counts: [(String,String)], amounts: [(String,String)]) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 9) {
        Text(title).font(.headline)
        ForEach(counts, id: \.1) { field in metric(field.0, "\(row.count(field.1))") }
        ForEach(amounts, id: \.1) { field in metric(field.0, row.amount(field.1)) }
      }
    }.padding(.vertical, 4)
  }
  private func reset() { generation += 1; report = nil; options = nil; error = ""; search = "" }
  @MainActor private func load() async {
    guard !reading, let actor = model.identity else { return }
    reading = true; report = nil; error = ""; let request = generation, workspace = model.workspaceVersion
    var query = draft; query.until = Date()
    defer { reading = false }
    do {
      let result = try await model.readBusinessReport(query)
      guard request == generation, workspace == model.workspaceVersion,
        model.identity?.staffNavigationKey == actor.staffNavigationKey, phase == .active else { return }
      report = result; if query.kind == .experience { options = NativeBusinessReportOptions(products: result.products, staff: result.staff, packageOptions: result.packageOptions) }
    } catch {
      if request == generation, model.identity?.staffNavigationKey == actor.staffNavigationKey { self.error = error.localizedDescription }
    }
  }
}
