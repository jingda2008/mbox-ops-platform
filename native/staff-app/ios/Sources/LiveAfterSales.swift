import Foundation

struct LiveAfterSales: Decodable {
  struct Item: Decodable {
    let id, orderId, name, status, orderPublicId, tableCode: String
    let quantity, originalAmountMinor: Int
    let tableSessionId: String?
    let bundle: Bool
    let includedInBundle: Bool?
  }
  struct Funding: Decodable, Identifiable {
    let paymentId, provider: String
    let availableMinor: Int
    var id: String { paymentId }
  }
  struct Unit: Decodable, Identifiable {
    struct Eligibility: Decodable {
      let canReturn: Bool
      let reason: String?
      let releaseOnly: Bool?
    }
    let id, productionState, inventoryEvidence: String
    let index: Int
    let heldByCaseId, stoppedByCaseId: String?
    let operationallyStopped: Bool?
    let returnEligibility: Eligibility?
  }
  struct Case: Decodable, Identifiable {
    struct ReplacementOrder: Decodable {
      let orderId, publicId, status, sourceCaseId: String
    }
    let canReplace: Bool?
    let replacementOrder: ReplacementOrder?
    struct Pricing: Decodable {
      let policy: String
      let refundAmountMinor, receivableDeltaMinor, effectiveAmountMinor, availablePaidMinor: Int
    }
    struct Refund: Decodable, Identifiable {
      let id, status, provider: String
      let amountMinor: Int
      let canRetry: Bool?
    }
    struct Notice: Decodable, Identifiable {
      let id, stationCode, instruction, createdAt, printState: String
      let phase: String?
    }
    let caseId, orderId, kind, status, businessDate, reason: String
    let amountMinor: Int?
    let selectedQuantity, heldQuantity, stoppedQuantity, madeQuantity, inventoryReviewQuantity,
      succeededMinor, unconfirmedNoticeCount: Int
    let physicalComplete, moneyComplete, refundFailed, refundNeedsReview, awaitingCashPayout,
      canApprove, canReject, canWithdraw, canResume, canResolveUnpaid: Bool
    let canRevise, canDisposeMade, canDisposeHeldUnmade, requiresFundingChoice,
      paymentAllocationReview, unpaidPaymentChanged: Bool?
    let revisedByCaseId, revisesCaseId, resumeUnavailableReason: String?
    let pricing: Pricing?
    let refunds: [Refund]
    let notices: [Notice]
    var id: String { caseId }
  }
  struct Redelivery: Decodable, Identifiable {
    let id, taskId, status, reason: String
    let pendingQuantity, pausedQuantity, deliveredQuantity, cancelledQuantity, selectedQuantity: Int
    var active: Bool { ["pending", "acknowledged", "in_progress"].contains(status) }
    var available: Int { max(0, pendingQuantity - pausedQuantity) }
  }
  struct Remake: Decodable, Identifiable {
    let id, taskId, reason, createdAt: String
    let total, unmade, started, ready, delivered, cancelled, held, successorAvailableQuantity: Int
  }
  let supportsNativeReplacementRecovery: Bool?
  let replacementOrders: [Case.ReplacementOrder]?
  let supportsNativePhysicalRecovery: Bool?
  let redeliveries: [Redelivery]?
  let remakes: [Remake]?
  let redeliveryAvailableQuantity, firstRemakeAvailableQuantity: Int?
  let originalKdsTaskId: String?
  let canRequestRedelivery, canConfirmRedelivery, canCancelRedelivery, canManageRemake: Bool?
  let item: Item
  let fundingSources: [Funding]
  let units: [Unit]
  let cases: [Case]
  let canRequest, canExecuteRefund, canReceive, canRecordUsed, canAcknowledgeNotices: Bool
  let quantityEntryUnavailableReason: String?
  var available: Int {
    units.isEmpty
      ? item.quantity
      : units.filter {
        $0.heldByCaseId == nil && $0.stoppedByCaseId == nil && $0.operationallyStopped != true
      }.count
  }
  func held(_ row: Case) -> [Unit] {
    units.filter {
      $0.heldByCaseId == row.id
        && ($0.productionState != "unmade" || row.canDisposeHeldUnmade == true)
    }.sorted { $0.index < $1.index }
  }
  func validate(itemID: String) throws {
    guard item.id == itemID, item.quantity > 0, Set(units.map(\.id)).count == units.count,
      Set(cases.map(\.id)).count == cases.count, cases.allSatisfy({ $0.orderId == item.orderId }),
      Set(fundingSources.map(\.id)).count == fundingSources.count,
      fundingSources.allSatisfy({ $0.availableMinor >= 0 }),
      Set((redeliveries ?? []).map(\.id)).count == (redeliveries ?? []).count,
      (redeliveries ?? []).allSatisfy({ row in
        (1...999).contains(row.selectedQuantity)
          && [
            row.pendingQuantity, row.deliveredQuantity, row.cancelledQuantity, row.pausedQuantity,
          ].allSatisfy { (0...row.selectedQuantity).contains($0) }
          && row.pendingQuantity + row.deliveredQuantity + row.cancelledQuantity
            == row.selectedQuantity
          && row.pausedQuantity <= row.pendingQuantity
      }),
      Set((remakes ?? []).map(\.taskId)).count == (remakes ?? []).count,
      (remakes ?? []).allSatisfy({ row in
        (1...999).contains(row.total)
          && [
            row.unmade, row.started, row.ready, row.delivered, row.cancelled, row.held,
            row.successorAvailableQuantity,
          ].allSatisfy { (0...row.total).contains($0) }
          && row.unmade + row.started + row.ready + row.delivered + row.cancelled == row.total
      })
    else { throw StaffAPIError.invalid }
  }
  func command(
    actor: StaffIdentity, action: String, caseID: String = "", quantity: Int = 0, reason: String,
    funding: [String: Int] = [:], unitIDs: Set<String> = [], refundID: String = "",
    confirmed: Bool = false
  ) throws -> LiveCommand {
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (2...1000).contains(note.utf16.count) else { throw CatalogError("请填写2—1000字实际原因") }
    let row = cases.first { $0.id == caseID }
    var body: [String: Any] = ["reason": note]
    let prefix = "/api/commerce/item-after-sales"
    var path = prefix + "/" + LiveCommand.pathPart(caseID) + "/" + action
    var permission = "refund.request"
    var title = ""
    switch action {
    case "request":
      guard canRequest, (1...min(999, max(1, available))).contains(quantity), quantity <= available
      else { throw CatalogError("当前原商品不能新增此份数售后，请刷新") }
      path = prefix + "/requests"
      body["orderItemId"] = item.id
      body["quantity"] = quantity
      title = "申请暂停并处理\(quantity)份原商品"
    case "approved", "rejected", "withdrawn":
      guard let row,
        action == "approved"
          ? row.canApprove : action == "rejected" ? row.canReject : row.canWithdraw
      else { throw CatalogError("当前岗位或原申请状态不允许此决定") }
      permission =
        action == "withdrawn"
        ? "refund.request"
        : row.kind == "unpaid_stop"
          ? (actor.allows("order.settle_exception")
            ? "order.settle_exception" : "order.cancel_unpaid") : "refund.approve"
      if action == "approved", row.requiresFundingChoice == true {
        let shares = funding.filter { $0.value != 0 }
        guard !shares.isEmpty, shares.count <= 50,
          shares.values.allSatisfy({ $0 > 0 && $0 <= Int.max / 50 }),
          shares.values.reduce(0, +) == row.amountMinor,
          shares.allSatisfy({ id, value in
            fundingSources.contains { $0.id == id && value <= $0.availableMinor }
          })
        else { throw CatalogError("请按原付款填写退回金额，合计须等于服务端核定金额，且不超过各原款可退余额") }
        body["funding"] = shares.sorted { $0.key < $1.key }.map {
          ["paymentId": $0.key, "amountMinor": $0.value] as [String: Any]
        }
      } else if funding.values.contains(where: { $0 != 0 }) {
        throw CatalogError("此操作不接受额外退款分摊")
      }
      body["decision"] = action
      path = prefix + "/" + LiveCommand.pathPart(caseID) + "/decision"
      title = ["approved": "批准原申请", "rejected": "拒绝原申请", "withdrawn": "撤回本人申请"][action]!
    case "revision":
      guard let row, row.canRevise == true, quantity > 0,
        quantity <= min(999, available + row.heldQuantity)
      else { throw CatalogError("只能修改本人尚未执行的原申请及可处理份数") }
      body["quantity"] = quantity
      title = "修改为\(quantity)份，重新审核"
    case "resume":
      guard row?.canResume == true else { throw CatalogError("当前不能继续原商品") }
      title = "确认继续原商品"
    case "resolve-unpaid":
      guard row?.canResolveUnpaid == true else { throw CatalogError("原款未确认，不按未付款减账") }
      title = "原款确认未收，继续停止减账"
    case "notice-ack":
      guard let row, canAcknowledgeNotices, !row.notices.isEmpty, row.notices.count <= 100,
        confirmed
      else { throw CatalogError("请先实际联系所示岗位确认知悉") }
      body["noticeIds"] = row.notices.map(\.id).sorted()
      title = "确认所示岗位已知悉"
    case "used_loss", "returned_unopened":
      guard let row, row.canDisposeMade ?? (row.status == "approved"), !unitIDs.isEmpty,
        unitIDs.count <= 999, unitIDs.isSubset(of: Set(held(row).map(\.id))), confirmed
      else { throw CatalogError("请选原申请的实际份数并确认实物去向") }
      if action == "returned_unopened" {
        guard canReceive,
          units.filter({ unitIDs.contains($0.id) }).allSatisfy({
            $0.returnEligibility?.canReturn == true
          })
        else { throw CatalogError("所选份数未获确认可退库，请核对原库存，不要以报损清待办") }
        permission = "inventory.receive"
        title = "确认实物收回或未制作预留释放"
      } else {
        guard canRecordUsed else { throw CatalogError("当前无报损权限") }
        permission = "inventory.waste"
        title = "实物已消耗，不退库存"
      }
      guard actor.allows("refund.request") else { throw CatalogError("缺少商品售后权限") }
      body["unitIds"] = unitIDs.sorted()
      body["disposition"] = action
      body["unopenedReceived"] = action == "returned_unopened"
      path = prefix + "/" + LiveCommand.pathPart(caseID) + "/physical"
    case "refund-retry", "cash-paid":
      guard let row, let refund = row.refunds.first(where: { $0.id == refundID }), canExecuteRefund
      else { throw CatalogError("请刷新原退款及执行权限") }
      permission = "refund.execute"
      if action == "refund-retry" {
        guard refund.canRetry == true else { throw CatalogError("仅重试已核实失败的原退款") }
        body["refundId"] = refund.id
        title = "重试原退款 " + money(refund.amountMinor)
      } else {
        guard refund.provider == "cash", ["approved", "processing"].contains(refund.status),
          confirmed
        else { throw CatalogError("须确认现金已实际退给客人") }
        path = "/api/refunds/\(LiveCommand.pathPart(refund.id))/manual-result"
        body = ["succeeded": true]
        title = "登记现金已退 " + money(refund.amountMinor)
      }
    default: throw CatalogError("不支持的售后操作")
    }
    guard actor.allows(permission) else { throw CatalogError("当前岗位权限已变化") }
    let id = UUID().uuidString.lowercased()
    var proof: [String: Any] = [
      "afterSales": action, "itemId": item.id, "orderId": item.orderId, "caseId": caseID,
      "refundId": refundID, "quantity": quantity,
      "confirmation":
        "\(item.tableCode) · \(item.orderPublicId)\n\(item.name)\n\(title)\n原申请金额：\(row?.amountMinor.map(money) ?? "由服务器按原成交事实计算")\n原因：\(note)\n资金处理与商品/库存处理分别记录；退款未确认成功不能当作已退。撤回或拒绝不会自动恢复商品。",
    ]
    var details: [String] = []
    if !unitIDs.isEmpty {
      details.append(
        "实际处理份号："
          + units.filter { unitIDs.contains($0.id) }.sorted { $0.index < $1.index }.map {
            String($0.index)
          }.joined(separator: "、"))
    }
    if !funding.isEmpty {
      details.append(
        "原款分摊：\n"
          + funding.filter { $0.value > 0 }.sorted { $0.key < $1.key }.map {
            "\($0.key)：\(money($0.value))"
          }.joined(separator: "\n"))
    }
    if action == "notice-ack", let row {
      details.append(
        row.notices.map { "\($0.stationCode)：\($0.instruction)" }.joined(separator: "\n"))
    }
    proof["confirmation"] =
      (proof["confirmation"] as! String) + "\n" + details.joined(separator: "\n")
    if let refund = row?.refunds.first(where: { $0.id == refundID }) {
      proof["amountMinor"] = refund.amountMinor
    }
    return LiveCommand(
      id: id, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-aftersales-" + id,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
extension LiveCommand.Step {
  var afterSalesProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["afterSales"] is String
    else { return nil }
    return p
  }
}
func validateAfterSalesReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let proof = step.afterSalesProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let data = root["data"] as? [String: Any], let action = proof["afterSales"] as? String
  else { throw StaffAPIError.invalid }
  if action.hasPrefix("remedy-") {
    try validateRemediationReply(root, proof: proof)
    return
  }
  if action == "cash-paid" {
    guard let meta = root["meta"] as? [String: Any], meta["replayed"] is Bool,
      data["id"] as? String == proof["refundId"] as? String,
      data["status"] as? String == "succeeded",
      data["amountMinor"] as? Int == proof["amountMinor"] as? Int,
      data["currency"] as? String == "CNY"
    else { throw StaffAPIError.invalid }
    return
  }
  guard root["replayed"] is Bool, let id = data["caseId"] as? String, !id.isEmpty,
    data["orderId"] as? String == proof["orderId"] as? String,
    let selected = data["selectedQuantity"] as? Int, selected > 0, data["physicalComplete"] is Bool,
    data["moneyComplete"] is Bool, let succeeded = data["succeededMinor"] as? Int, succeeded >= 0
  else { throw StaffAPIError.invalid }
  if ["request", "revision"].contains(action) {
    guard selected == proof["quantity"] as? Int,
      action != "revision" || data["revisesCaseId"] as? String == proof["caseId"] as? String
    else { throw StaffAPIError.invalid }
  } else {
    guard id == proof["caseId"] as? String else { throw StaffAPIError.invalid }
  }
}
struct AfterSalesPending: Decodable {
  struct Row: Decodable, Identifiable {
    let caseId, orderItemId, productName, tableCode, status, businessDate: String
    let amountMinor: Int?
    let moneyComplete, physicalComplete: Bool
    var id: String { caseId }
  }
  struct Cursor: Decodable, Equatable { let id, createdAt: String }
  let items: [Row]
  let nextCursor: Cursor?
  static func path(_ cursor: Cursor?) -> String {
    var c = URLComponents()
    c.path = "/api/commerce/item-after-sales/pending"
    if let cursor {
      c.queryItems = [
        .init(name: "cursorId", value: cursor.id),
        .init(name: "createdAt", value: cursor.createdAt),
      ]
    }
    return c.string!.replacingOccurrences(of: "+", with: "%2B")
  }
}

// Physical remedies retain the same persisted command and original item on recovery.
extension LiveAfterSales {
  func remediationCommand(
    actor: StaffIdentity, action: String, target: String = "",
    quantity: Int = 0, reason: String, confirmed: Bool
  ) throws -> LiveCommand {
    guard supportsNativePhysicalRecovery == true else {
      throw CatalogError("服务器尚未启用安全补送与重做，请使用原网页流程")
    }
    let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard confirmed, (2...(action == "remake" ? 500 : 1000)).contains(note.utf16.count) else {
      throw CatalogError("请填写实际原因并核对实物；重做原因最多500字")
    }
    var body: [String: Any] = ["reason": note]
    let prefix = "/api/commerce/item-after-sales/native-redeliveries"
    let path: String
    let title: String
    let permission: String
    switch action {
    case "request":
      guard canRequestRedelivery == true, quantity > 0,
        quantity <= min(999, redeliveryAvailableQuantity ?? 0)
      else { throw CatalogError("可补送份数已变化，请刷新") }
      path = prefix
      permission = "refund.request"
      body["orderItemId"] = item.id
      body["quantity"] = quantity
      body["originalGoodsAvailable"] = true
      title = "原实物补送 \(quantity)份"
    case "complete", "cancel":
      guard let row = redeliveries?.first(where: { $0.id == target }), row.active else {
        throw CatalogError("原补送任务已变化，请刷新")
      }
      path = prefix + "/" + LiveCommand.pathPart(row.id) + "/" + action
      if action == "complete" {
        guard canConfirmRedelivery == true, quantity > 0, quantity <= min(999, row.available) else {
          throw CatalogError("不能确认已暂停或超出剩余的份数")
        }
        permission = "kds.deliver"
        body["quantity"] = quantity
        title = "确认实际补送 \(quantity)份"
      } else {
        guard canCancelRedelivery == true else { throw CatalogError("当前无取消补送权限") }
        permission = "service.execute"
        title = "取消本次剩余补送"
      }
    case "remake":
      let maximum =
        target == originalKdsTaskId
        ? firstRemakeAvailableQuantity ?? 0
        : remakes?.first(where: { $0.taskId == target })?.successorAvailableQuantity ?? 0
      guard canManageRemake == true, !target.isEmpty, quantity > 0, quantity <= min(999, maximum)
      else { throw CatalogError("当前批次、制作岗位或可重做份数已变化") }
      path = "/api/commerce/native-kds/" + LiveCommand.pathPart(target) + "/remake"
      permission = "kds.exception.manage"
      body["actorId"] = actor.employee.id
      body["quantity"] = quantity
      body["originalGoodsLost"] = true
      body["reasonCode"] = "production_remake"
      title = "重新制作 \(quantity)份"
    default: throw CatalogError("不支持的实物处理")
    }
    guard actor.allows(permission) else { throw CatalogError("当前岗位权限已变化") }
    let key = UUID().uuidString.lowercased()
    let row = redeliveries?.first { $0.id == target }
    let explanation =
      action == "remake"
      ? "已确认本批原实物无法直接补送。新增制作批次和耗料，原单不重复收费。"
      : action == "cancel"
        ? "只取消本次未完成补送，已送份数和原商品、账款保持原记录。"
        : action == "complete" ? "已确认以上份数实际送给客人；暂停部分不计入。" : "已确认原实物仍在且可交付，不重新制作、不重复扣库存。"
    let proof: [String: Any] = [
      "afterSales": "remedy-" + action, "itemId": item.id,
      "orderId": item.orderId, "target": target, "quantity": quantity,
      "selectedQuantity": row?.selectedQuantity ?? quantity, "taskId": row?.taskId ?? "",
      "deliveredBefore": row?.deliveredQuantity ?? 0,
      "confirmation":
        "\(item.tableCode) · \(item.orderPublicId)\n\(item.name)\n\(title)\n\(explanation)\n原因：\(note)",
    ]
    return LiveCommand(
      id: key, employeeID: actor.employee.id, title: title, permission: permission,
      steps: [
        .init(
          path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
          keyHeader: "idempotency-key", key: "native-remedy-" + key,
          recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
      ])
  }
}
private func validateRemediationReply(_ root: [String: Any], proof: [String: Any]) throws {
  guard root["replayed"] is Bool, let data = root["data"] as? [String: Any],
    data["itemId"] as? String == proof["itemId"] as? String,
    let task = data["taskId"] as? String, !task.isEmpty
  else { throw StaffAPIError.invalid }
  if proof["afterSales"] as? String == "remedy-remake" {
    guard let batch = data["batchId"] as? String, !batch.isEmpty,
      task != proof["target"] as? String, data["quantity"] as? Int == proof["quantity"] as? Int
    else { throw StaffAPIError.invalid }
    return
  }
  guard let id = data["id"] as? String, !id.isEmpty,
    proof["afterSales"] as? String == "remedy-request"
      || (id == proof["target"] as? String && task == proof["taskId"] as? String),
    let selected = data["selectedQuantity"] as? Int, selected > 0, selected <= 999,
    selected == proof["selectedQuantity"] as? Int,
    let pending = data["pendingQuantity"] as? Int,
    let delivered = data["deliveredQuantity"] as? Int,
    let cancelled = data["cancelledQuantity"] as? Int, let paused = data["pausedQuantity"] as? Int,
    [pending, delivered, cancelled, paused].allSatisfy({ (0...selected).contains($0) }),
    pending + delivered + cancelled == selected, paused <= pending,
    let units = data["units"] as? [[String: Any]], units.count == selected,
    units.allSatisfy({ ($0["id"] as? String)?.isEmpty == false }),
    Set(units.compactMap { $0["id"] as? String }).count == selected,
    units.filter({ $0["outcome"] is NSNull }).count == pending,
    units.filter({ $0["outcome"] as? String == "delivered" }).count == delivered,
    units.filter({ $0["outcome"] as? String == "cancelled" }).count == cancelled,
    let status = data["status"] as? String,
    ["pending", "acknowledged", "in_progress", "completed", "cancelled"].contains(status),
    proof["afterSales"] as? String != "remedy-cancel" || (pending == 0 && status == "cancelled"),
    proof["afterSales"] as? String != "remedy-complete"
      || delivered >= (proof["deliveredBefore"] as? Int ?? selected)
        + (proof["quantity"] as? Int ?? selected)
  else { throw StaffAPIError.invalid }
}
