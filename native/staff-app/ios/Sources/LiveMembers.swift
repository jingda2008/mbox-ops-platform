import Foundation

struct MemberAccount: Decodable {
  struct Entry: Decodable {
    let entryType: String
    let delta, balanceAfter: Int
    let reason, occurredAt: String
  }
  let memberNo, membershipStatus, tier, updatedAt: String
  let availablePoints, pendingRecoveryPoints, lifetimeGrowth, qualificationGrowth: Int
  let tierQualificationGrowth: Int?
  let tierPeriodEndsAt: String?
  let pointEntries, growthEntries: [Entry]
}
struct MemberParticipation: Decodable {
  struct Activity: Decodable { let publicId, title, startsAt, guidance: String }
  struct Registration: Decodable {
    let publicId, activityPublicId, title, startsAt, guidance: String
    let partySize: Int
    let readyForCheckIn: Bool
  }
  struct Benefit: Decodable {
    let id, title, guidance: String
    let quantity: Int
    let validUntil: String?
  }
  let memberNo, checkedAt: String
  let displayName: String?
  let activitiesVisible: Bool
  let activities: [Activity]
  let registrations: [Registration]
  let benefits: [Benefit]
}
struct MemberVisitStatus: Decodable {
  struct Visit: Decodable { let id, businessDate, checkedInAt, employeeName, status: String }
  struct Progress: Decodable {
    let name: String
    let requiredVisits, remainingVisits, pending, issued: Int
  }
  let memberNo, businessDate: String
  let canCheckIn: Bool
  let durableNativeVisits: Bool?
  let visit: Visit?
  let rewards: [Progress]?
  func command(cancel: Bool, reason: String, actor: StaffIdentity) throws -> LiveCommand {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard durableNativeVisits == true, canCheckIn, actor.allows("loyalty.account.view"),
      actor.allows("customer.relationship.manage"),
      cancel
        ? visit?.status == "checked_in" && (2...300).contains(reason.utf16.count)
        : visit?.status != "checked_in"
    else { throw CatalogError("请重新读取会员签到状态并核对权限；撤销须填写原因") }
    var body: [String: Any] = ["code": memberNo, "businessDate": businessDate]
    if cancel {
      body["visitId"] = visit!.id
      body["reason"] = reason
    }
    return try MemberCommands.make(
      actor: actor, title: cancel ? "撤销到店签到" : "确认到店签到", permission: "customer.relationship.manage",
      path: "/api/staff/native-member-visits/" + (cancel ? "cancel" : "check-in"), body: body,
      proof: [
        "kind": "visit", "memberNo": memberNo, "businessDate": businessDate,
        "status": cancel ? "cancelled" : "checked_in", "visitId": cancel ? visit!.id : "",
        "confirmation": "会员 \(memberNo) · 营业日 \(businessDate)\n"
          + (cancel ? "撤销原签到，不自动撤销已经领取的奖励。\n" + reason : "已当面核对会员本人到店。签到奖励须单独审批，实物领取另行核销。"),
      ])
  }
}
struct MemberRewardBoard: Decodable {
  struct Rule: Decodable, Identifiable {
    let id, name, status, created_at, campaign_status, available_until: String
    let required_visits, quantity: Int
    let products: String?
  }
  struct Row: Decodable, Identifiable {
    let id, name, member_no, earned_business_date, status: String
    let required_visits, quantity, cancelled_sources, quantity_redeemed: Int
    let products, decision_reason, benefit_status: String?
    let visit_dates: [String]
  }
  let businessDate: String
  let durableNativeDecisions: Bool?
  let rules: [Rule]
  var items: [Row]
  let nextCursor: String?
  func command(ids: Set<String>, approve: Bool, reason: String, actor: StaffIdentity) throws
    -> LiveCommand
  {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    let selected = items.filter { ids.contains($0.id) }
    guard durableNativeDecisions == true, actor.allows("loyalty.configuration.approve"),
      (1...50).contains(ids.count), selected.count == ids.count,
      (2...300).contains(reason.utf16.count),
      selected.allSatisfy({ $0.status == "pending" && (!approve || $0.cancelled_sources == 0) })
    else { throw CatalogError("请选择1—50条有效待审批记录并填写原因；签到撤销记录需先核对") }
    return try MemberCommands.make(
      actor: actor, title: approve ? "审批签到奖励" : "驳回签到奖励",
      permission: "loyalty.configuration.approve", path: "/api/staff/native-member-visit-rewards",
      body: ["action": approve ? "approve" : "reject", "ids": ids.sorted(), "reason": reason],
      proof: [
        "kind": "reward", "ids": ids.sorted(), "status": approve ? "issued" : "rejected",
        "confirmation": selected.map { "\($0.member_no) · \($0.name) · \($0.quantity)份" }.joined(
          separator: "\n") + "\n" + reason + "\n"
          + (approve ? "发放的是权益券；实物领取仍需单独核销。" : "本轮签到将按原规则记为已处理；不能重复用本轮次数领取。"),
      ])
  }
}
enum MemberCommands {
  static func code(_ value: String) throws -> String {
    var value = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.uppercased().hasPrefix("MBOX_MEMBER_V1:") {
      value = String(value.dropFirst(15)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard !value.isEmpty, value.utf16.count <= 128,
      !value.contains(where: { $0.isWhitespace || ":/?#".contains($0) })
    else { throw CatalogError("请扫描会员码或输入完整会员号；不能使用付款码或点心核销链接") }
    return value
  }
  static func make(
    actor: StaffIdentity, title: String, permission: String, path: String, body: [String: Any],
    proof: [String: Any]
  ) throws -> LiveCommand {
    let id = UUID().uuidString.lowercased()
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-business-" + id,
          recoveryBody: try JSONSerialization.data(
            withJSONObject: ["member": proof], options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var memberProof: [String: Any]? {
    guard let recoveryBody,
      let root = try? JSONSerialization.jsonObject(with: recoveryBody) as? [String: Any]
    else { return nil }
    return root["member"] as? [String: Any]
  }
}
func validateMemberReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.memberProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let meta = root["meta"] as? [String: Any],
    meta["replayed"] is Bool
  else { throw StaffAPIError.invalid }
  if p["kind"] as? String == "visit" {
    guard let id = data["id"] as? String, !id.isEmpty,
      data["memberNo"] as? String == p["memberNo"] as? String,
      data["businessDate"] as? String == p["businessDate"] as? String,
      data["status"] as? String == p["status"] as? String,
      let date = data["checkedInAt"] as? String, assignmentDate(date) != nil,
      p["visitId"] as? String == "" || p["visitId"] as? String == id
    else { throw StaffAPIError.invalid }
  } else if p["kind"] as? String == "benefit" {
    guard let id = data["id"] as? String, !id.isEmpty,
      data["benefitId"] as? String == p["benefitId"] as? String,
      data["customerId"] as? String == p["customerId"] as? String,
      data["tableSessionId"] as? String == p["tableSessionId"] as? String,
      data["quantity"] as? Int == p["quantity"] as? Int
    else { throw StaffAPIError.invalid }
    if p["action"] as? String == "cancel" {
      guard id == p["reservationId"] as? String, data["status"] as? String == "cancelled",
        data["cancelReason"] as? String == step.object["reason"] as? String
      else { throw StaffAPIError.invalid }
    } else {
      guard p["action"] as? String == "redeem",
        data["benefitReservationId"] as? String == p["reservationId"] as? String,
        let reference = data["giftOrderReference"] as? String, !reference.isEmpty,
        let source = data["authorizationSource"] as? [String: Any],
        source["employeeId"] as? String == p["employeeId"] as? String,
        let date = data["redeemedAt"] as? String, assignmentDate(date) != nil
      else { throw StaffAPIError.invalid }
    }
  } else {
    guard p["kind"] as? String == "reward", let ids = p["ids"] as? [String],
      let items = data["items"] as? [[String: Any]], items.count == ids.count,
      Set(items.compactMap { $0["id"] as? String }) == Set(ids),
      items.allSatisfy({ $0["status"] as? String == p["status"] as? String })
    else { throw StaffAPIError.invalid }
  }
}

struct BenefitFulfillmentBoard: Decodable {
  struct Product: Decodable, Identifiable {
    let productId, name: String
    let isOriginal: Bool
    var id: String { productId }
  }
  struct Gift: Decodable, Identifiable {
    let reservationId, benefitId, customerId, tableSessionId, tableCode, title, expiresAt,
      originalProductId: String
    let quantity: Int
    let memberNo, customerName: String?
    let allowedProducts: [Product]
    var id: String { reservationId }
  }
  struct Snack: Decodable, Identifiable {
    let id, claimCode, title, status: String
    let benefitId, benefitReservationId, customerId, tableSessionId, tableCode, memberNo,
      customerName, expiresAt, currentFulfillmentStatus, giftOrderId: String?
    let quantity: Int
  }
  let durable, snacksEnabled: Bool
  let businessDate: String
  let gifts: [Gift]
  let snacks: [Snack]
  struct Row: Identifiable {
    let id, kind, reservationId, benefitId, customerId, tableSessionId, tableCode, memberNo, title,
      status, expiresAt: String
    let quantity: Int
    let claimCode, originalProductId: String?
    let products: [Product]
    let fulfillment: String?
    var available: Bool {
      status == "reserved" && (assignmentDate(expiresAt)?.timeIntervalSinceNow ?? -1) > 0
    }
  }
  var rows: [Row] {
    gifts.map {
      Row(
        id: $0.id, kind: "annual", reservationId: $0.reservationId, benefitId: $0.benefitId,
        customerId: $0.customerId,
        tableSessionId: $0.tableSessionId, tableCode: $0.tableCode,
        memberNo: $0.memberNo ?? "会员号未提供", title: $0.title, status: "reserved",
        expiresAt: $0.expiresAt, quantity: $0.quantity, claimCode: nil,
        originalProductId: $0.originalProductId, products: $0.allowedProducts, fulfillment: nil)
    }
      + snacks.map {
        Row(
          id: $0.id, kind: "snack", reservationId: $0.benefitReservationId ?? "",
          benefitId: $0.benefitId ?? "", customerId: $0.customerId ?? "",
          tableSessionId: $0.tableSessionId ?? "", tableCode: $0.tableCode ?? "桌号待核对",
          memberNo: $0.memberNo ?? "会员号未提供", title: $0.title, status: $0.status,
          expiresAt: $0.expiresAt ?? "", quantity: $0.quantity, claimCode: $0.claimCode,
          originalProductId: nil, products: [], fulfillment: $0.currentFulfillmentStatus)
      }
  }
  func command(rowID: String, cancel: Bool, product: String, reason: String, actor: StaffIdentity)
    throws -> LiveCommand
  {
    let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard durable, actor.allows("loyalty.redemption.fulfill"),
      let row = rows.first(where: { $0.id == rowID }),
      row.status == "reserved", cancel && row.kind == "snack" || row.available,
      [row.reservationId, row.benefitId, row.customerId, row.tableSessionId].allSatisfy({
        UUID(uuidString: $0) != nil
      }),
      (1...100).contains(row.quantity), !cancel || (2...256).contains(reason.utf16.count)
    else { throw CatalogError("原暂留已变化，请刷新并核对权限、会员和取消原因") }
    var body: [String: Any] = [
      "kind": row.kind, "benefitId": row.benefitId, "customerId": row.customerId,
      "tableSessionId": row.tableSessionId, "quantity": row.quantity,
    ]
    var productName = "原点心商品"
    if let claimCode = row.claimCode { body["claimCode"] = claimCode }
    if cancel {
      body["reason"] = reason
    } else if row.kind == "annual" {
      guard let chosen = row.products.first(where: { $0.id == product }),
        product == row.originalProductId || (2...240).contains(reason.utf16.count)
      else { throw CatalogError("请选择允许的商品；替换原商品需填写2—240字原因") }
      body["selectedProductId"] = product
      productName = chosen.name
      if product != row.originalProductId { body["substitutionReason"] = reason }
    }
    let action = cancel ? "cancel" : "redeem"
    return try MemberCommands.make(
      actor: actor, title: cancel ? "取消权益暂留" : "确认权益兑付", permission: "loyalty.redemption.fulfill",
      path: "/api/staff/native-benefit-reservations/" + row.reservationId + "/" + action,
      body: body,
      proof: [
        "kind": "benefit", "action": action, "employeeId": actor.employee.id,
        "reservationId": row.reservationId, "benefitId": row.benefitId,
        "customerId": row.customerId, "tableSessionId": row.tableSessionId,
        "quantity": row.quantity,
        "confirmation": "\(row.tableCode) · \(row.memberNo)\n\(row.title) · \(row.quantity)份\n"
          + (cancel
            ? reason + "\n只取消未核销暂留；不撤销已经核销的赠品，不退款。"
            : productName + (reason.isEmpty ? "" : "\n" + reason)
              + "\n核销后进入出品流程。制作与送达须在出品、取送工作台分别完成。"),
      ])
  }
}
func benefitStatusLabel(_ status: String) -> String {
  [
    "reserved": "待核销", "redeemed": "已核销 · 待履约", "fulfilled": "历史已履约", "cancelled": "已取消暂留",
    "expired": "暂留已过期",
    "pending": "待制作", "ready": "待取送", "delivered": "当前已送达", "cancelled_after_redemption": "核销后已取消",
    "compensated": "已补偿",
  ][status] ?? "状态待核对"
}
