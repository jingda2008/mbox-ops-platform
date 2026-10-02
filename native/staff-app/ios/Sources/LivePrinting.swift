import Foundation

struct LivePrintJob: Decodable, Identifiable {
  let id, status, stationCode: String
  let sourceReference, printerName, connectivityStatus, reprintOfJobId, failureCode,
    printedAt: String?
  let attempts, maxAttempts, copies: Int?
  var canRetry: Bool {
    status == "failed" && (attempts ?? 0) < (maxAttempts ?? 0)
      && !(failureCode?.hasPrefix("ambiguous_") ?? false) && failureCode != "print_result_unknown"
  }
}
struct LivePrintSource: Decodable, Identifiable {
  let id, ticketKind, status, createdAt: String
  let lastErrorCode: String?
  let attempts, jobCount: Int
}
struct NativePrintReceipt: Codable {
  let commandID, employeeID: String
  let bytes: Data
}
func printingCommand(
  actor: StaffIdentity, kind: String, target: String, reason: String = "", job: LivePrintJob? = nil,
  source: LivePrintSource? = nil, confirmed: Bool = false
) throws -> LiveCommand {
  let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  let permission: String
  let path: String
  let title: String
  var body: [String: Any] = [:]
  let prefix = "/api/hardware/"
  switch kind {
  case "order", "table":
    guard !target.isEmpty,
      ["order.history.view", "order.history.all", "reconciliation.view"].contains(where: {
        actor.allows($0)
      })
    else { throw CatalogError("请核对原订单或桌次及历史权限") }
    permission = "order.bill.print"
    path =
      prefix + (kind == "order" ? "orders/" : "table-sessions/") + LiveCommand.pathPart(target)
      + "/bill"
    title = kind == "order" ? "打印原订单账单" : "打印整个原桌次账单"
  case "report":
    _ = try FinanceQuery(date: target).path()
    guard !target.isEmpty, actor.allows("reconciliation.view") else {
      throw CatalogError("请选择有权查看的营业日")
    }
    permission = "order.bill.print"
    path = prefix + "business-days/" + target + "/report"
    body = ["mode": "both", "grouping": "none"]
    title = "打印营业日汇总及明细"
  case "retry", "reprint":
    guard let job, job.id == target, (3...1000).contains(note.utf16.count), confirmed,
      kind == "retry" ? job.canRetry : ["printed", "failed", "dead"].contains(job.status)
    else { throw CatalogError("请现场核对原任务及是否已出纸，填写至少3字原因；在途任务不能重发") }
    permission =
      actor.allows("printer.manage")
      ? "printer.manage" : kind == "retry" ? "print.retry" : "print.reprint"
    path = prefix + "print-jobs/" + LiveCommand.pathPart(target) + "/" + kind
    body = ["reason": note]
    title = kind == "retry" ? "重试已确认失败的原任务" : "按原小票快照补打（标记补打）"
  case "source-retry":
    guard let source, source.id == target, ["retry", "dead"].contains(source.status),
      (3...1000).contains(note.utf16.count)
    else { throw CatalogError("仅恢复失败的票据生成任务，请先排查路由并填写原因") }
    permission = actor.allows("hardware.manage") ? "hardware.manage" : "printer.manage"
    path = prefix + "print-sources/" + LiveCommand.pathPart(target) + "/retry"
    body = ["reason": note]
    title = "恢复原票据生成任务"
  default: throw CatalogError("不支持的打印操作")
  }
  guard actor.allows(permission) else { throw CatalogError("当前岗位没有此打印权限") }
  let id = UUID().uuidString.lowercased()
  let proof: [String: Any] = [
    "printing": kind, "target": target,
    "confirmation":
      "\(title)\n原记录：\(target)\n原因：\(note)\n入队不代表已出纸。打印故障不改变原收退款结果。结果未知时先现场核对，不连续点击补打。",
  ]
  return LiveCommand(
    id: id, employeeID: actor.employee.id, title: title, permission: permission,
    steps: [
      .init(
        path: path, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys),
        keyHeader: "idempotency-key", key: "native-print-" + id,
        recoveryBody: try JSONSerialization.data(withJSONObject: proof, options: .sortedKeys))
    ])
}
extension LiveCommand.Step {
  var printProof: [String: Any]? {
    guard let recoveryBody,
      let p = (try? JSONSerialization.jsonObject(with: recoveryBody)) as? [String: Any],
      p["printing"] is String
    else { return nil }
    return p
  }
}
func validatePrintReply(_ bytes: Data, step: LiveCommand.Step) throws {
  guard let p = step.printProof,
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    root["replayed"] is Bool, let d = root["data"] as? [String: Any],
    let kind = p["printing"] as? String, let target = p["target"] as? String
  else { throw StaffAPIError.invalid }
  if ["order", "table", "report"].contains(kind) {
    guard let request = d["requestId"] as? String, UUID(uuidString: request) != nil,
      d["status"] as? String == "queued", let jobs = d["jobIds"] as? [String], !jobs.isEmpty,
      Set(jobs).count == jobs.count, jobs.allSatisfy({ UUID(uuidString: $0) != nil })
    else { throw StaffAPIError.invalid }
    if kind == "order" {
      guard d["orderId"] as? String == target else { throw StaffAPIError.invalid }
    }
    if kind == "report" {
      guard d["businessDate"] as? String == target else { throw StaffAPIError.invalid }
    }
  } else {
    guard let id = d["id"] as? String, UUID(uuidString: id) != nil,
      d["status"] as? String == "pending"
    else { throw StaffAPIError.invalid }
    if kind == "reprint" {
      guard id != target, d["reprintOfJobId"] as? String == target,
        d["reprintReason"] as? String == step.object["reason"] as? String
      else { throw StaffAPIError.invalid }
    } else {
      guard id == target else { throw StaffAPIError.invalid }
    }
  }
}
