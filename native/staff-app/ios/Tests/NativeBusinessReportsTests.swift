import Foundation
import Darwin

private final class ReportSessionStore: StaffSessionStore {
  func read() throws -> Data? { nil }
  func write(_ data: Data) throws {}
  func remove() throws {}
}
@main struct NativeBusinessReportsTests {
  @MainActor static func main() async throws {
    setbuf(stdout, nil)
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1; print("PASS " + label) }
    func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func rejected(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
    let employee = "00000000-0000-4000-8000-000000000001", product = "00000000-0000-4000-8000-000000000010"
    var auth: [String: Any] = ["employee": ["id": employee, "code": "sales", "displayName": "经营员工", "roleCodes": []],
      "session": ["id": "sales-session", "employeeId": employee, "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "permissions": ["commercial.sales.view", "recommendation.analytics.view", "product.observation.analytics.view", "observation.view.raw"], "deniedPermissions": [], "navigation": [["route": "/staff/operations"], ["route": "/staff/customer-experience"]]]
    func actor(_ value: [String: Any]) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: data(value)) }
    let staff = try actor(auth)
    let now = Date(timeIntervalSince1970: 1_791_180_000)
    var salesQuery = NativeBusinessReportQuery(kind: .sales, now: now)
    check(try salesQuery.path() == "/api/commercial-ops/employee-sales", "default sales uses actual server business date without client timezone guessing")
    salesQuery.startDate = "2026-01-01"; salesQuery.endDate = "2026-12-31"
    check(try salesQuery.path().contains("startDate=2026-01-01"), "complete allowed business-date interval reaches real sales endpoint")
    for pair in [("2026-02-30", "2026-03-01"), ("2026-01-01", "2027-01-02"), ("2026-01-02", "2026-01-01"), ("2026-01-01", ""), ("26-01-01", "2026-01-01")] {
      var q = salesQuery; q.startDate = pair.0; q.endDate = pair.1
      check(rejected { _ = try q.path() }, "reject invalid, partial or oversized business date interval")
    }
    var query = NativeBusinessReportQuery(kind: .experience, now: now)
    query.days = 28; query.productID = product; query.employeeID = employee; query.packageProductID = "00000000-0000-4000-8000-000000000011"
    query.partySize = "4"; query.tableCode = "A5"; query.occasion = "friends"; query.performancePhase = "band_live"; query.recommendationOutcome = "complaint"
    let aggregate = URLComponents(string: try query.path())!, raw = URLComponents(string: try query.path(evidence: true))!
    check(aggregate.queryItems == raw.queryItems!.filter { $0.name != "limit" }, "raw observations and aggregate use identical frozen interval plus all nine filters")
    check(raw.queryItems!.last == URLQueryItem(name: "limit", value: "50"), "raw evidence uses bounded original endpoint")
    for invalid in ["", "not-uuid", product + "/"] {
      if invalid.isEmpty { continue }
      var q = query; q.productID = invalid
      check(rejected { _ = try q.path() }, "product filter rejects malformed server ID")
    }
    for invalid in ["0", "101", "1.5", "true"] { var q = query; q.partySize = invalid; check(rejected { _ = try q.path() }, "party filter enforces server integer limits") }
    for invalid in ["A 5", "A5&employeeId=other", "A5\n"] { var q = query; q.tableCode = invalid; check(rejected { _ = try q.path() }, "table filter cannot inject another query") }
    var badQuery = query; badQuery.occasion = "vip"; check(rejected { _ = try badQuery.path() }, "unversioned member segment cannot masquerade as occasion")
    badQuery = query; badQuery.days = 365; check(rejected { _ = try badQuery.path() }, "rolling experience intervals limited to supported options")
    var sales: [String: Any] = ["employeeCode": "sales", "employeeDisplayName": "当前授权员工", "productCode": "DRINK", "productName": "测试饮品", "categoryCode": "bar", "quantity": "1.500000", "salesAmountMinor": 7500, "costAmountMinor": NSNull(), "contributionProfitMinor": NSNull(), "refundReversalAmountMinor": -500, "costCoverageComplete": false, "currency": "CNY"]
    func salesData(_ row: [String: Any]) throws -> Data { try data(["data": [row]]) }
    let saleReport = try NativeBusinessReport(data: salesData(sales), evidence: nil, query: salesQuery, actor: staff)
    check(saleReport.sales[0].text("quantity") == "1.500000", "real PG numeric::text quantity is accepted without integer truncation")
    check(saleReport.sales[0].amount("costAmountMinor") == "数据不足", "unknown historical cost remains unknown, not zero")
    check(saleReport.sales[0].amount("refundReversalAmountMinor") == "¥-5", "signed reversal amount retains its sign")
    sales["quantity"] = "-0.500000"; check(try NativeBusinessReport(data: salesData(sales), evidence: nil, query: salesQuery, actor: staff).sales[0].text("quantity") == "-0.500000", "sales reversal signed fractional quantity preserved")
    for value: Any in [1.5, true, "nan", "1e3", "1.0000001"] { var row = sales; row["quantity"] = value; check(rejected { _ = try NativeBusinessReport(data: salesData(row), evidence: nil, query: salesQuery, actor: staff) }, "quantity rejects noncontract types and unbounded precision") }
    for value: Any in [true, 1.5, "7500"] { var row = sales; row["salesAmountMinor"] = value; check(rejected { _ = try NativeBusinessReport(data: salesData(row), evidence: nil, query: salesQuery, actor: staff) }, "money rejects Boolean/string/fractional minor units") }
    var mismatch = sales; mismatch["costCoverageComplete"] = true
    check(rejected { _ = try NativeBusinessReport(data: salesData(mismatch), evidence: nil, query: salesQuery, actor: staff) }, "complete flag cannot hide missing costs")
    func echo(_ query: NativeBusinessReportQuery) throws -> [String: Any] {
      var value: [String: Any] = Dictionary(uniqueKeysWithValues: ["productId", "employeeId", "packageProductId", "partySize", "tableCode", "occasion", "performancePhase"].map { ($0, NSNull()) })
      for item in try query.parameters() { value[item.name] = item.name == "partySize" ? Int(item.value!)! : item.value! as Any }; return value
    }
    func metrics(_ names: [String], base: [String: Any] = [:]) -> [String: Any] { var result = base; for key in names { result[key] = 1 }; return result }
    let recommendation = metrics(["generated", "exposed", "selected", "ignored", "rejected", "staffModified", "ordered", "paid", "refunded", "paidAmountMinor", "refundedAmountMinor", "complaintOrderCount", "followOnPaidOrderCount", "repeatPurchaseOrderCount"], base: ["productId": product, "productName": "饮品", "currency": "CNY", "frozenCostMinor": NSNull(), "contributionAmountMinor": NSNull()])
    let productRow = metrics(["paidOrderCount", "paidRevenueMinor", "refundedAmountMinor", "observationCount", "praiseCount", "complaintCount", "remainingCount", "servedLateCount", "correctedCount"], base: ["productId": product, "productName": "饮品", "soldQuantity": 1.5, "averageObservationConfidence": NSNull(), "frozenCostMinor": NSNull(), "contributionAmountMinor": NSNull()])
    let staffRow = metrics(["inputCount", "confirmedCount", "unmatchedInputCount", "correctedEventCount", "positiveEventCount", "neutralEventCount", "negativeEventCount"], base: ["employeeId": employee, "employeeName": "员工"])
    let missing = metrics(["recommendationWithoutExposureCount", "paidRecommendationCostUnavailableCount", "complaintWithoutOrderLinkCount"])
    let quality = metrics(["totalInputs", "confirmedInputs", "unmatchedInputs", "correctedEvents"], base: ["unmatchedRate": 1.0, "correctionRate": 1.0, "missingFacts": missing, "staff": [staffRow]])
    let suggestion: [String: Any] = ["productId": product, "productName": "饮品", "kind": "frequent_remaining", "recommendation": "人工核对份量", "sampleSize": 4, "supportingEvidence": 3, "opposingEvidence": 1, "confidence": 0.75, "confidenceBasis": "directional"]
    var dashboard: [String: Any] = ["filter": try echo(query), "recommendation": [recommendation], "products": [productRow], "dataQuality": quality, "weeklySuggestions": [suggestion], "packageOptions": [["productId": query.packageProductID, "productName": "饮品组合"]], "generatedAt": "2026-10-05T10:00:00.000Z", "decisionBoundary": "只供人工复核，不自动调整考核、菜单、权益或价格。", "filterCapabilities": ["occasion": ["available": true, "basis": "事件前推荐会话事实"], "package": ["available": true, "basis": "BOM与订单行关联"], "customerSegment": ["available": false, "reason": "历史客群未知", "requiredFact": "事件时点不可变分群"]]]
    let evidenceRow: [String: Any] = ["eventId": "e1", "tableCode": "A5", "productName": "饮品", "employeeName": "员工", "performancePhase": "band_live", "expressionKind": "observation", "eventType": "remaining", "degree": NSNull(), "rawExcerpt": "顾客还未喝完", "confidence": 0.8, "revisionNo": 1, "corrected": false, "occurredAt": "2026-10-05T09:00:00.000Z"]
    let evidence = try data(["data": [evidenceRow]])
    func dashboardData() throws -> Data { try data(["data": dashboard]) }
    let result = try NativeBusinessReport(data: dashboardData(), evidence: evidence, query: query, actor: staff)
    check(result.recommendations.count == 1 && result.products[0].number("soldQuantity") == 1.5 && result.staff.count == 1 && result.evidence.count == 1, "complete real endpoint shape preserves recommendations/product/staff/evidence")
    check(result.suggestions[0].count("opposingEvidence") == 1 && result.suggestions[0].text("confidenceBasis") == "directional", "recommendation quality keeps counter-evidence and confidence basis")
    check(result.products[0].amount("frozenCostMinor") == "数据不足" && result.products[0].number("averageObservationConfidence") == nil, "nullable product cost and observation confidence are not fabricated")
    let zero = NativeBusinessMetricRow(id: "0", values: ["n": 0, "d": 0])
    check(zero.ratio("n", "d") == "无有效分母", "zero denominator does not present a misleading success rate")
    var filter = try echo(query); filter["tableCode"] = "B6"; dashboard["filter"] = filter
    check(rejected { _ = try NativeBusinessReport(data: dashboardData(), evidence: evidence, query: query, actor: staff) }, "mismatched original filter response is rejected")
    dashboard["filter"] = try echo(query)
    for key in ["recommendation", "products", "dataQuality", "weeklySuggestions", "filterCapabilities"] { let old = dashboard.removeValue(forKey: key); check(rejected { _ = try NativeBusinessReport(data: dashboardData(), evidence: evidence, query: query, actor: staff) }, "missing analysis section fails closed"); dashboard[key] = old }
    var noRawAuth = auth; noRawAuth["permissions"] = ["commercial.sales.view", "recommendation.analytics.view", "product.observation.analytics.view"]
    let noRaw = try actor(noRawAuth)
    check(rejected { _ = try NativeBusinessReport(data: dashboardData(), evidence: evidence, query: query, actor: noRaw) }, "raw evidence forbidden even when aggregate reader has both analytics permissions")
    check(try NativeBusinessReport(data: dashboardData(), evidence: nil, query: query, actor: noRaw).evidence.isEmpty, "aggregate-only reader has a valid report without raw evidence")
    var noRouteAuth = auth; noRouteAuth["navigation"] = []
    check(rejected { _ = try NativeBusinessReport(data: dashboardData(), evidence: nil, query: query, actor: actor(noRouteAuth)) }, "explicit empty routes cannot read with permission alone")
    var halfAuth = auth; halfAuth["permissions"] = ["recommendation.analytics.view"]
    check(!query.available(to: try actor(halfAuth)), "experience requires both read permissions")
    var requests: [URLRequest] = [], intercept: (() -> Void)?
    let api = StaffAPI(transport: { request in
      requests.append(request)
      if ["/api/auth/login", "/api/auth/heartbeat"].contains(request.url!.path) { return (try data(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
      guard request.httpMethod == "GET", request.httpBody == nil else { throw StaffAPIError.invalid }
      intercept?()
      let bytes = request.url!.path.hasSuffix("observations") ? evidence : request.url!.path.hasSuffix("employee-sales") ? try salesData(sales) : try dashboardData()
      return (bytes, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }, store: ReportSessionStore())
    let model = AppModel(api: api, loadPersistedState: false, trainingAllowed: false)
    model.identity = try await api.login(code: "sales", pin: "1234", switching: false)
    check(try await model.readBusinessReport(query).evidence.count == 1, "actual AppModel sequentially reads aggregate then permitted evidence")
    let queries = requests.filter { $0.url!.path.contains("customer-experience") }.map { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)!.queryItems! }
    check(queries.count == 2 && queries[0] == queries[1].filter { $0.name != "limit" }, "actual transport sends the original frozen filters to both endpoints")
    auth = noRawAuth
    let originalRawCalls = requests.filter { $0.url!.path.hasSuffix("observations") }.count
    do { _ = try await model.readBusinessReport(query); preconditionFailure("changed scope needs new read") }
    catch { check(model.identity?.allows("observation.view.raw") == false, "fresh raw permission withdrawal updates identity and invalidates original read") }
    check(try await model.readBusinessReport(query).evidence.isEmpty, "next current-scope read permits aggregate without raw evidence")
    check(requests.filter { $0.url!.path.hasSuffix("observations") }.count == originalRawCalls, "permission loss never sends another raw evidence request")
    auth["navigation"] = []
    let before = requests.count
    do { _ = try await model.readBusinessReport(query); preconditionFailure("route revoked") } catch { check(requests.count == before + 1 && requests.last!.url!.path == "/api/auth/heartbeat", "fresh route withdrawal stops before report endpoint") }
    auth = noRawAuth; model.identity = try await api.login(code: "sales", pin: "1234", switching: false)
    var other = auth; other["employee"] = ["id": "00000000-0000-4000-8000-000000000002", "code": "new", "displayName": "其他员工", "roleCodes": []]; other["session"] = ["id": "other-session", "employeeId": "00000000-0000-4000-8000-000000000002", "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"]
    let next = try actor(other); intercept = { model.identity = next }
    do { _ = try await model.readBusinessReport(query); preconditionFailure("late report") } catch { check(model.identity?.employee.id == next.employee.id, "late original report rejected without locking new employee") }
    print("Native business reports: \(count) checks passed")
  }
}
