import Foundation

struct FinanceEntry: Decodable, Identifiable {
  let id: String
  let paymentId: String?
  let refundId: String?
  let entryType: String
  let provider: String
  let providerReference: String
  let amountMinor: Int
  let currency: String
  let businessDate: String
  let occurredAt: String
}
struct FinancePage: Decodable {
  struct Meta: Decodable { let nextCursor: String? }
  let data: [FinanceEntry]
  let meta: Meta
}
func validateFinancePage(_ page: FinancePage, query: FinanceQuery, cursor: String?) throws {
  guard Set(page.data.map(\.id)).count == page.data.count,
    page.data.allSatisfy({
      !$0.id.isEmpty && $0.businessDate == query.date && !$0.currency.isEmpty
        && ["payment", "refund", "fee", "adjustment"].contains($0.entryType) && $0.amountMinor != 0
        && ($0.entryType != "payment" || $0.amountMinor > 0)
        && ($0.entryType != "refund" || $0.amountMinor < 0)
        && (query.type.isEmpty || $0.entryType == query.type)
        && assignmentDate($0.occurredAt) != nil
    }),
    page.meta.nextCursor == nil
      || (!(page.meta.nextCursor?.isEmpty ?? true) && page.meta.nextCursor != cursor)
  else { throw StaffAPIError.invalid }
}
struct FinanceReview: Decodable, Identifiable {
  let id: String
  let publicId: String
  let amountMinor: String
  let status: String
  let tableCode: String?
  let orderPublicId: String?
  let ownerName: String?
  let note: String?
  let financialSignals: [String]?
  let stopReason: String?
  var canResolve: Bool {
    !["created", "pending"].contains(status)
      && !(financialSignals ?? []).contains("confirmed_payment_not_applied")
  }
}
struct FinanceReviewPage: Decodable {
  let data: [FinanceReview]
  let hasMore: Bool
  let urgentCount: Int
}
struct DayClosure: Decodable {
  struct Day: Decodable, Identifiable {
    struct Closed: Decodable {
      let tableSessionId: String
      let tableCode: String
    }
    struct Blocker: Decodable, Identifiable {
      struct Fact: Decodable, Identifiable {
        let id: String
        let title: String
        let reference: String
        let statusLabel: String
        let amountMinor: Int?
        let quantityText: String?
        let orderPublicId: String?
      }
      let tableSessionId: String
      let tableCode: String
      let code: String
      let label: String
      let count: Int
      let resolution: String
      let facts: [Fact]
      var id: String { tableSessionId + ":" + code }
    }
    let businessDayId: String
    let businessDate: String
    let status: String
    let closedTableSessions: [Closed]
    let blockers: [Blocker]
    var id: String { businessDayId }
  }
  let businessDays: [Day]
  let closedBusinessDayCount: Int
  let closedTableSessionCount: Int
  let blockedTableSessionCount: Int
  func validate() throws {
    guard closedBusinessDayCount == businessDays.filter({ $0.status == "closed" }).count,
      closedTableSessionCount == businessDays.reduce(0, { $0 + $1.closedTableSessions.count }),
      blockedTableSessionCount
        == Set(businessDays.flatMap { $0.blockers.map(\.tableSessionId) }).count,
      Set(businessDays.map(\.id)).count == businessDays.count,
      businessDays.allSatisfy({
        ["closed", "awaiting_close"].contains($0.status)
          && ($0.status != "closed" || $0.blockers.isEmpty)
          && $0.blockers.allSatisfy { $0.count > 0 }
      })
    else { throw StaffAPIError.invalid }
  }
}
struct FinanceReceipt: Codable {
  let commandID: String
  let employeeID: String
  let kind: String
  let bytes: Data
  var closure: DayClosure? {
    kind == "close-day"
      ? try? JSONDecoder().decode(APIEnvelope<DayClosure>.self, from: bytes).data : nil
  }
}
struct FinanceQuery: Equatable {
  var date = ""
  var type = ""
  func path(cursor: String? = nil) throws -> String {
    guard ["", "payment", "refund", "fee", "adjustment"].contains(type),
      (cursor?.utf16.count ?? 0) <= 512
    else { throw CatalogError("对账查询条件无效") }
    var query = ["limit": "100"]
    if !date.isEmpty {
      var h = HistoryQuery()
      h.date = date
      h.endDate = date
      _ = try h.path()
      query["businessDate"] = date
    }
    if !type.isEmpty { query["entryType"] = type }
    if let cursor { query["cursor"] = cursor }
    var url = URLComponents()
    url.path = "/api/reconciliation"
    url.queryItems = query.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) }
    return url.string!.replacingOccurrences(of: "+", with: "%2B")
  }
}
extension LiveCommand.Step {
  var financeProof: [String: Any]? {
    guard let recoveryBody,
      let value = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      value["finance"] is String
    else { return nil }
    return value
  }
}
func financeCommand(
  actor: StaffIdentity, row: FinanceReview? = nil, note: String = "", resolve: Bool = false,
  closeDay: Bool = false
) throws -> LiveCommand {
  let permission = closeDay ? "business_day.close" : "reconciliation.manage"
  guard actor.allows(permission), closeDay || actor.allows("reconciliation.view") else {
    throw CatalogError("当前岗位无此操作权限")
  }
  let kind = closeDay ? "close-day" : "review"
  let id = UUID().uuidString.lowercased()
  let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
  var body: [String: Any] = [:]
  var proof: [String: Any] = ["finance": kind, "employeeId": actor.employee.id]
  let path: String
  let title: String
  if closeDay {
    path = "/api/business-days/close-pending"
    title = "检查并结束上一营业日"
    proof["confirmation"] = "由服务器检查上一营业日。只关闭已结清且出品、服务均完成的桌台；未完成事项保留并逐项显示。不会强制清账、不会把未知支付算作收款。"
  } else {
    guard let row, (3...1000).contains(text.utf16.count), !resolve || row.canResolve else {
      throw CatalogError("请填写3—1000字核对进展；未知或未入账款项不能结案")
    }
    path = "/api/payments/\(LiveCommand.pathPart(row.id))/finance-review"
    title = resolve ? "确认财务核对完成" : "本人接手并保存核对进展"
    body = ["note": text, "resolve": resolve]
    proof["paymentId"] = row.id
    proof["confirmation"] =
      "原付款：\(row.publicId)\n桌号：\(row.tableCode ?? "待核对")\n\(title)\n记录：\(text)\n只登记财务跟进，不修改原款金额、支付状态或实际资金。"
  }
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: permission,
    steps: [
      .init(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-finance-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
func validateFinanceReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.financeProof else { throw StaffAPIError.invalid }
  if proof["finance"] as? String == "close-day" {
    struct Reply: Decodable {
      struct Meta: Decodable { let replayed: Bool }
      let data: DayClosure
      let meta: Meta
    }
    guard step.path == "/api/business-days/close-pending", step.object.isEmpty else {
      throw StaffAPIError.invalid
    }
    try JSONDecoder().decode(Reply.self, from: bytes).data.validate()
  } else {
    struct Reply: Decodable {
      struct Row: Decodable {
        let paymentId: String
        let ownerEmployeeId: String
        let note: String
        let status: String
      }
      let data: Row
      let replayed: Bool
    }
    let data = try JSONDecoder().decode(Reply.self, from: bytes).data
    guard proof["finance"] as? String == "review", data.paymentId == proof["paymentId"] as? String,
      step.path == "/api/payments/\(LiveCommand.pathPart(data.paymentId))/finance-review",
      data.ownerEmployeeId == proof["employeeId"] as? String,
      data.note == step.object["note"] as? String,
      data.status == ((step.object["resolve"] as? Bool) == true ? "resolved" : "reviewing")
    else { throw StaffAPIError.invalid }
  }
}
