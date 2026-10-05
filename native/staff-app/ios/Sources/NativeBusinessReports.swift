import Foundation
import CoreFoundation

enum NativeBusinessReportKind: String, CaseIterable {
  case sales, experience
  var title: String { self == .sales ? "员工销售" : "客户体验分析" }
  func available(to actor: StaffIdentity) -> Bool {
    switch self {
    case .sales: return actor.hasStaffRoute("/staff/operations") && ["commercial.sales.view", "commercial.sales.view_all"].contains(where: actor.allows)
    case .experience: return actor.hasStaffRoute("/staff/customer-experience") && actor.allows("recommendation.analytics.view") && actor.allows("product.observation.analytics.view")
    }
  }
}

struct NativeBusinessReportQuery: Equatable {
  var kind: NativeBusinessReportKind
  var startDate = "", endDate = ""
  var days = 7
  var productID = "", employeeID = "", packageProductID = "", partySize = "", tableCode = ""
  var occasion = "", performancePhase = "", recommendationOutcome = "all"
  // One captured instant is shared by aggregates and raw evidence. Never build
  // the second request with a newly computed rolling interval.
  var until: Date
  init(kind: NativeBusinessReportKind, now: Date = Date()) { self.kind = kind; self.until = now }
  static let occasions = [("", "全部场景"), ("business", "商务"), ("friends", "朋友"), ("date", "约会"), ("birthday", "生日"), ("music", "音乐"), ("relax", "放松"), ("other", "其他")]
  static let phases = [("", "全部阶段"), ("before_show", "演出前"), ("acoustic", "弹唱"), ("band_live", "乐队"), ("intermission", "中场"), ("after_show", "演出后")]
  static let outcomes = [("all", "全部结果"), ("paid", "已付款"), ("refunded", "已退款"), ("complaint", "关联投诉"), ("follow_on_order", "同桌后续付款"), ("repeat_purchase", "同品复购"), ("margin_unavailable", "缺成交成本")]
  func available(to actor: StaffIdentity) -> Bool { kind.available(to: actor) }
  func parameters() throws -> [URLQueryItem] {
    var values: [URLQueryItem] = []
    func add(_ name: String, _ value: String) { if !value.isEmpty { values.append(URLQueryItem(name: name, value: value)) } }
    func id(_ value: String, _ name: String) throws {
      guard value.isEmpty || value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil else { throw CatalogError("商品、套餐或员工编号格式不正确") }
      add(name, value)
    }
    try id(productID, "productId"); try id(employeeID, "employeeId")
    if kind == .sales {
      if !startDate.isEmpty || !endDate.isEmpty {
        let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.timeZone = TimeZone(secondsFromGMT: 0); parser.dateFormat = "yyyy-MM-dd"; parser.isLenient = false
        guard startDate.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil,
          endDate.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil,
          let from = parser.date(from: startDate), let to = parser.date(from: endDate),
          parser.string(from: from) == startDate, parser.string(from: to) == endDate,
          to >= from, to.timeIntervalSince(from) <= 365 * 86400 else { throw CatalogError("请完整填写营业日期，范围最多366天") }
        add("startDate", startDate); add("endDate", endDate)
      }
    } else {
      guard [7,28,84].contains(days), until.timeIntervalSince1970.isFinite else { throw CatalogError("请选择7、28或84天") }
      let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      add("from", formatter.string(from: until.addingTimeInterval(-Double(days) * 86400))); add("until", formatter.string(from: until))
      try id(packageProductID, "packageProductId")
      if !partySize.isEmpty {
        guard partySize.range(of: "^[0-9]{1,3}$", options: .regularExpression) != nil, let n = Int(partySize), (1...100).contains(n) else { throw CatalogError("人数须为1至100的整数") }; add("partySize", partySize)
      }
      guard tableCode.isEmpty || tableCode.range(of: "^[A-Za-z0-9_-]{1,32}$", options: .regularExpression) != nil else { throw CatalogError("请输入有效桌号") }
      add("tableCode", tableCode)
      guard Self.occasions.contains(where: { $0.0 == occasion }), Self.phases.contains(where: { $0.0 == performancePhase }), Self.outcomes.contains(where: { $0.0 == recommendationOutcome }) else { throw CatalogError("筛选条件不正确") }
      add("occasion", occasion); add("performancePhase", performancePhase); add("recommendationOutcome", recommendationOutcome)
    }
    return values
  }
  func path(evidence: Bool = false) throws -> String {
    guard !evidence || kind == .experience else { throw CatalogError("员工销售没有顾客原文接口") }
    let root = kind == .sales ? "/api/commercial-ops/employee-sales" : "/api/staff/customer-experience/analytics" + (evidence ? "/observations" : "")
    var parameters = try parameters(); if evidence { parameters.append(.init(name: "limit", value: "50")) }
    var url = URLComponents(); url.path = root; if !parameters.isEmpty { url.queryItems = parameters }
    guard let value = url.string else { throw StaffAPIError.invalid }; return value
  }
  func validateEcho(_ echo: [String: Any]) throws {
    let items = try parameters(), expected = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
    for key in ["from", "until", "productId", "employeeId", "packageProductId", "partySize", "occasion", "performancePhase", "tableCode", "recommendationOutcome"] {
      if key == "partySize", let value = expected[key] {
        guard let n = echo[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.intValue == Int(value), n.doubleValue == Double(value) else { throw CatalogError("报表人数筛选与原查询不一致") }
      } else if let value = expected[key] {
        guard echo[key] as? String == value else { throw CatalogError("报表筛选与原查询不一致，请重新读取") }
      } else { guard echo[key] is NSNull else { throw CatalogError("报表包含非原查询筛选，请重新读取") } }
    }
  }
}

struct NativeBusinessMetricRow: Identifiable {
  let id: String
  let values: [String: Any]
  func text(_ key: String) -> String { values[key] as? String ?? "" }
  func number(_ key: String) -> Double? { (values[key] as? NSNumber)?.doubleValue }
  func count(_ key: String) -> Int { (values[key] as? NSNumber)?.intValue ?? 0 }
  func amount(_ key: String) -> String {
    guard let value = values[key] as? NSNumber else { return "数据不足" }
    let currency = text("currency").isEmpty ? "CNY" : text("currency")
    return (currency == "CNY" ? "¥" : currency + " ") + NSDecimalNumber(decimal: value.decimalValue / 100).stringValue
  }
  func ratio(_ numerator: String, _ denominator: String) -> String {
    guard let n = number(numerator), let d = number(denominator), d > 0 else { return "无有效分母" }
    return String(format: "%.1f%%", n / d * 100)
  }
}

struct NativeBusinessReport {
  let query: NativeBusinessReportQuery
  let staffNavigationKey: String
  var sales: [NativeBusinessMetricRow] = []
  var recommendations: [NativeBusinessMetricRow] = []
  var products: [NativeBusinessMetricRow] = []
  var staff: [NativeBusinessMetricRow] = []
  var suggestions: [NativeBusinessMetricRow] = []
  var evidence: [NativeBusinessMetricRow] = []
  var packageOptions: [NativeBusinessMetricRow] = []
  var quality: NativeBusinessMetricRow?
  var missingFacts: NativeBusinessMetricRow?
  var generatedAt = "", decisionBoundary = "", occasionBasis = "", packageBasis = "", segmentBoundary = ""
  let rawEvidencePermitted: Bool

  init(data: Data, evidence: Data?, query: NativeBusinessReportQuery, actor: StaffIdentity) throws {
    guard query.available(to: actor) else { throw CatalogError("当前岗位没有读取此报表的权限") }
    _ = try query.parameters()
    self.query = query; self.staffNavigationKey = actor.staffNavigationKey
    self.rawEvidencePermitted = query.kind == .experience && actor.allows("observation.view.raw")
    let root = try Self.object(try JSONSerialization.jsonObject(with: data))
    guard root["data"] != nil else { throw StaffAPIError.invalid }
    if query.kind == .sales {
      guard evidence == nil else { throw StaffAPIError.invalid }
      let rows = try Self.rows(root["data"])
      for (index, row) in rows.enumerated() {
        try Self.strings(row, ["employeeCode", "employeeDisplayName", "productCode", "productName", "categoryCode", "currency"])
        guard let quantity = row["quantity"] as? String,
          quantity.range(of: "^-?[0-9]{1,18}(\\.[0-9]{1,6})?$", options: .regularExpression) != nil,
          Decimal(string: quantity, locale: Locale(identifier: "en_US_POSIX")) != nil else { throw CatalogError("员工销售数量格式不正确") }
        try Self.numbers(row, ["salesAmountMinor", "refundReversalAmountMinor"], signed: true)
        try Self.numbers(row, ["costAmountMinor", "contributionProfitMinor"], nullable: true, signed: true)
        try Self.boolean(row, "costCoverageComplete")
        guard row["costCoverageComplete"] as? Bool != true || (!(row["costAmountMinor"] is NSNull) && !(row["contributionProfitMinor"] is NSNull)) else { throw CatalogError("成本完整标记与金额不一致") }
        sales.append(.init(id: String(index), values: row))
      }
      return
    }
    let body = try Self.object(root["data"])
    try query.validateEcho(Self.object(body["filter"]))
    try Self.strings(body, ["generatedAt", "decisionBoundary"])
    generatedAt = body["generatedAt"] as! String; guard StaffIdentity.date(generatedAt) != nil else { throw StaffAPIError.invalid }
    decisionBoundary = body["decisionBoundary"] as! String
    recommendations = try Self.metricRows(body["recommendation"], strings: ["productId", "productName", "currency"], counts: ["generated", "exposed", "selected", "ignored", "rejected", "staffModified", "ordered", "paid", "refunded", "complaintOrderCount", "followOnPaidOrderCount", "repeatPurchaseOrderCount"], amounts: ["paidAmountMinor", "refundedAmountMinor"], nullable: ["frozenCostMinor", "contributionAmountMinor"])
    products = try Self.metricRows(body["products"], strings: ["productId", "productName"], counts: ["paidOrderCount", "observationCount", "praiseCount", "complaintCount", "remainingCount", "servedLateCount", "correctedCount"], amounts: ["paidRevenueMinor", "refundedAmountMinor"], nullable: ["frozenCostMinor", "contributionAmountMinor"], fractions: ["soldQuantity"], ratios: ["averageObservationConfidence"])
    let quality = try Self.object(body["dataQuality"])
    try Self.numbers(quality, ["totalInputs", "confirmedInputs", "unmatchedInputs", "correctedEvents"])
    try Self.numbers(quality, ["unmatchedRate", "correctionRate"], integer: false)
    self.quality = .init(id: "quality", values: quality)
    let missing = try Self.object(quality["missingFacts"])
    try Self.numbers(missing, ["recommendationWithoutExposureCount", "paidRecommendationCostUnavailableCount", "complaintWithoutOrderLinkCount"])
    missingFacts = .init(id: "missing", values: missing)
    staff = try Self.metricRows(quality["staff"], strings: ["employeeId", "employeeName"], counts: ["inputCount", "confirmedCount", "unmatchedInputCount", "correctedEventCount", "positiveEventCount", "neutralEventCount", "negativeEventCount"])
    suggestions = try Self.metricRows(body["weeklySuggestions"], strings: ["productId", "productName", "kind", "recommendation", "confidenceBasis"], counts: ["sampleSize", "supportingEvidence", "opposingEvidence"], ratios: ["confidence"])
    for row in suggestions {
      guard ["high_sales_low_experience", "low_sales_high_praise", "frequent_remaining", "likely_service_delay"].contains(row.text("kind")), ["insufficient", "directional", "moderate", "strong"].contains(row.text("confidenceBasis")), row.number("confidence") != nil else { throw StaffAPIError.invalid }
    }
    packageOptions = try Self.metricRows(body["packageOptions"], strings: ["productId", "productName"], counts: [])
    let capabilities = try Self.object(body["filterCapabilities"]), occasion = try Self.object(capabilities["occasion"]), package = try Self.object(capabilities["package"]), segment = try Self.object(capabilities["customerSegment"])
    try Self.strings(occasion, ["basis"]); try Self.strings(package, ["basis"]); try Self.strings(segment, ["reason", "requiredFact"])
    try Self.boolean(occasion, "available"); try Self.boolean(package, "available"); try Self.boolean(segment, "available")
    guard occasion["available"] as? Bool == true, package["available"] as? Bool == true, segment["available"] as? Bool == false else { throw CatalogError("分析筛选合同已变化，请更新应用") }
    occasionBasis = occasion["basis"] as! String; packageBasis = package["basis"] as! String
    segmentBoundary = (segment["reason"] as! String) + "；" + (segment["requiredFact"] as! String)
    if let evidence {
      guard rawEvidencePermitted else { throw CatalogError("当前岗位不可读取观察原文") }
      let evidenceRoot = try Self.object(try JSONSerialization.jsonObject(with: evidence))
      let rows = try Self.rows(evidenceRoot["data"]); guard rows.count <= 50 else { throw CatalogError("观察原文返回超出本次请求范围") }
      for (index, row) in rows.enumerated() {
        try Self.strings(row, ["eventId", "tableCode", "employeeName", "expressionKind", "eventType", "rawExcerpt", "occurredAt"])
        for key in ["productName", "performancePhase", "degree"] { guard row[key] is String || row[key] is NSNull else { throw StaffAPIError.invalid } }
        try Self.numbers(row, ["revisionNo"]); try Self.numbers(row, ["confidence"], integer: false, ratio: true); try Self.boolean(row, "corrected")
        guard (row["revisionNo"] as! NSNumber).intValue >= 1, StaffIdentity.date(row["occurredAt"] as! String) != nil else { throw StaffAPIError.invalid }
        self.evidence.append(.init(id: String(index), values: row))
      }
    }
  }
  private static func object(_ value: Any?) throws -> [String: Any] { guard let value = value as? [String: Any] else { throw CatalogError("报表数据结构不正确，请重新读取") }; return value }
  private static func rows(_ value: Any?) throws -> [[String: Any]] { guard let value = value as? [[String: Any]], value.count <= 50000 else { throw CatalogError("报表列表格式不正确") }; return value }
  private static func strings(_ row: [String: Any], _ names: [String]) throws {
    for name in names { guard let value = row[name] as? String, value.utf16.count <= 10000 else { throw CatalogError("报表文字字段不完整") } }
  }
  private static func boolean(_ row: [String: Any], _ name: String) throws { guard let n = row[name] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw CatalogError("报表状态字段不正确") } }
  private static func numbers(_ row: [String: Any], _ names: [String], nullable: Bool = false, signed: Bool = false, integer: Bool = true, ratio: Bool = false) throws {
    for name in names {
      if nullable && row[name] is NSNull { continue }
      guard let n = row[name] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
        abs(n.doubleValue) <= 9_007_199_254_740_991, signed || n.doubleValue >= 0,
        !integer || n.doubleValue.rounded() == n.doubleValue,
        !ratio || (0...1).contains(n.doubleValue) else { throw CatalogError("报表数值缺失或超出有效范围") }
    }
  }
  private static func metricRows(_ value: Any?, strings: [String], counts: [String], amounts: [String] = [], nullable: [String] = [], fractions: [String] = [], ratios: [String] = []) throws -> [NativeBusinessMetricRow] {
    try rows(value).enumerated().map { index, row in
      try self.strings(row, strings); try numbers(row, counts); try numbers(row, amounts, signed: true)
      try numbers(row, nullable, nullable: true, signed: true); try numbers(row, fractions, integer: false)
      try numbers(row, ratios, nullable: true, integer: false, ratio: true)
      return .init(id: String(index), values: row)
    }
  }
}
