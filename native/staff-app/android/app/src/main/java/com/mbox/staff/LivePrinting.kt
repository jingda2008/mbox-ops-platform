package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

fun canRetryPrint(job: JSONObject) =
    job.getString("status") == "failed" &&
        job.optInt("attempts", 0) < job.optInt("maxAttempts", 0) &&
        job.textOrNull("failureCode")?.startsWith("ambiguous_") != true &&
        job.textOrNull("failureCode") != "print_result_unknown"

fun printingCommand(
    actor: StaffIdentity,
    kind: String,
    target: String,
    reason: String = "",
    job: JSONObject? = null,
    source: JSONObject? = null,
    confirmed: Boolean = false,
): LiveCommand {
    val note = reason.trim()
    val permission: String
    val path: String
    val title: String
    val body = JSONObject()
    val prefix = "/api/hardware/"
    when (kind) {
        "order",
        "table" -> {
            require(
                target.isNotEmpty() &&
                    listOf("order.history.view", "order.history.all", "reconciliation.view").any {
                        actor.allows(it)
                    }
            ) {
                "请核对原订单或桌次及历史权限"
            }
            permission = "order.bill.print"
            path =
                prefix +
                    (if (kind == "order") "orders/" else "table-sessions/") +
                    LiveCommand.part(target) +
                    "/bill"
            title = if (kind == "order") "打印原订单账单" else "打印整个原桌次账单"
        }
        "report" -> {
            FinanceQuery(target).path()
            require(target.isNotEmpty() && actor.allows("reconciliation.view")) { "请选择有权查看的营业日" }
            permission = "order.bill.print"
            path = prefix + "business-days/$target/report"
            body.put("mode", "both").put("grouping", "none")
            title = "打印营业日汇总及明细"
        }
        "retry",
        "reprint" -> {
            require(
                job != null &&
                    job.getString("id") == target &&
                    note.length in 3..1000 &&
                    confirmed &&
                    if (kind == "retry") canRetryPrint(job)
                    else job.getString("status") in listOf("printed", "failed", "dead")
            ) {
                "请现场核对原任务及是否已出纸，填写至少3字原因；在途任务不能重发"
            }
            permission =
                if (actor.allows("printer.manage")) "printer.manage"
                else if (kind == "retry") "print.retry" else "print.reprint"
            path = prefix + "print-jobs/${LiveCommand.part(target)}/$kind"
            body.put("reason", note)
            title = if (kind == "retry") "重试已确认失败的原任务" else "按原小票快照补打（标记补打）"
        }
        "source-retry" -> {
            require(
                source != null &&
                    source.getString("id") == target &&
                    source.getString("status") in listOf("retry", "dead") &&
                    note.length in 3..1000
            ) {
                "仅恢复失败的票据生成任务，请先排查路由并填写原因"
            }
            permission =
                if (actor.allows("hardware.manage")) "hardware.manage" else "printer.manage"
            path = prefix + "print-sources/${LiveCommand.part(target)}/retry"
            body.put("reason", note)
            title = "恢复原票据生成任务"
        }
        else -> error("不支持的打印操作")
    }
    require(actor.allows(permission)) { "当前岗位没有此打印权限" }
    val id = UUID.randomUUID().toString()
    val proof =
        JSONObject()
            .put("printing", kind)
            .put("target", target)
            .put(
                "confirmation",
                "$title\n原记录：$target\n原因：$note\n入队不代表已出纸。打印故障不改变原收退款结果。结果未知时先现场核对，不连续点击补打。",
            )
    return LiveCommand(
        id,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(path, body.toString(), "idempotency-key", "native-print-$id", proof.toString())
        ),
    )
}

val LiveStep.printProof: JSONObject?
    get() = recoveryBody?.let(::JSONObject)?.takeIf { it.opt("printing") is String }

fun validatePrintReply(text: String, step: LiveStep) {
    val p = step.printProof ?: invalidResponse()
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    val kind = p.getString("printing")
    val target = p.getString("target")
    if (root.get("replayed") !is Boolean) invalidResponse()
    if (kind in listOf("order", "table", "report")) {
        UUID.fromString(d.getString("requestId"))
        val jobs =
            d.getJSONArray("jobIds").let { a -> (0 until a.length()).map { a.getString(it) } }
        if (
            d.getString("status") != "queued" || jobs.isEmpty() || jobs.distinct().size != jobs.size
        )
            invalidResponse()
        jobs.forEach { UUID.fromString(it) }
        if (
            kind == "order" && d.getString("orderId") != target ||
                kind == "report" && d.getString("businessDate") != target
        )
            invalidResponse()
    } else {
        val id = d.getString("id")
        UUID.fromString(id)
        if (d.getString("status") != "pending") invalidResponse()
        if (kind == "reprint") {
            if (
                id == target ||
                    d.getString("reprintOfJobId") != target ||
                    d.getString("reprintReason") != JSONObject(step.body).getString("reason")
            )
                invalidResponse()
        } else if (id != target) invalidResponse()
    }
}
