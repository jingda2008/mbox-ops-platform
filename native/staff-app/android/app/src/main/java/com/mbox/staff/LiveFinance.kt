package com.mbox.staff

import java.net.URLEncoder
import java.time.LocalDate
import java.util.UUID
import org.json.JSONObject

fun financeRows(root: JSONObject, key: String) =
    root.getJSONArray(key).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

data class FinanceQuery(val date: String = "", val type: String = "") {
    fun path(cursor: String? = null): String {
        require(
            type in listOf("", "payment", "refund", "fee", "adjustment") &&
                (cursor?.length ?: 0) <= 512
        ) {
            "对账查询条件无效"
        }
        if (date.isNotEmpty()) require(LocalDate.parse(date).toString() == date) { "营业日格式无效" }
        val params = linkedMapOf("limit" to "100")
        if (date.isNotEmpty()) params["businessDate"] = date
        if (type.isNotEmpty()) params["entryType"] = type
        if (cursor != null) params["cursor"] = cursor
        return "/api/reconciliation?" +
            params.entries.joinToString("&") {
                it.key + "=" + URLEncoder.encode(it.value, "UTF-8").replace("+", "%20")
            }
    }
}

fun financeCanResolve(row: JSONObject) =
    row.getString("status") !in listOf("created", "pending") &&
        !row.optJSONArray("financialSignals").let { a ->
            a != null &&
                (0 until a.length()).any { a.getString(it) == "confirmed_payment_not_applied" }
        }

val LiveStep.financeProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.opt("finance") is String }

fun financeCommand(
    actor: StaffIdentity,
    row: JSONObject? = null,
    note: String = "",
    resolve: Boolean = false,
    closeDay: Boolean = false,
): LiveCommand {
    val permission = if (closeDay) "business_day.close" else "reconciliation.manage"
    require(actor.allows(permission) && (closeDay || actor.allows("reconciliation.view"))) {
        "当前岗位无此操作权限"
    }
    val id = UUID.randomUUID().toString()
    val text = note.trim()
    val proof =
        JSONObject()
            .put("finance", if (closeDay) "close-day" else "review")
            .put("employeeId", actor.employeeId)
    val body = JSONObject()
    val path: String
    val title: String
    if (closeDay) {
        path = "/api/business-days/close-pending"
        title = "检查并结束上一营业日"
        proof.put("confirmation", "由服务器检查上一营业日。只关闭已结清且出品、服务均完成的桌台；未完成事项保留并逐项显示。不会强制清账、不会把未知支付算作收款。")
    } else {
        require(row != null && text.length in 3..1000 && (!resolve || financeCanResolve(row))) {
            "请填写3—1000字核对进展；未知或未入账款项不能结案"
        }
        path = "/api/payments/${LiveCommand.part(row.getString("id"))}/finance-review"
        title = if (resolve) "确认财务核对完成" else "本人接手并保存核对进展"
        body.put("note", text).put("resolve", resolve)
        proof.put("paymentId", row.getString("id"))
        proof.put(
            "confirmation",
            "原付款：${row.getString("publicId")}\n桌号：${row.textOrNull("tableCode") ?: "待核对"}\n$title\n记录：$text\n只登记财务跟进，不修改原款金额、支付状态或实际资金。",
        )
    }
    return LiveCommand(
        id,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(
                path,
                body.toString(),
                "idempotency-key",
                "native-finance-$id",
                proof.toString(),
            )
        ),
    )
}

fun validateFinanceReply(text: String, step: LiveStep) {
    val proof = step.financeProof ?: invalidResponse()
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    val body = JSONObject(step.body)
    if (proof.getString("finance") == "close-day") {
        if (
            step.path != "/api/business-days/close-pending" ||
                body.length() != 0 ||
                root.getJSONObject("meta").get("replayed") !is Boolean
        )
            invalidResponse()
        val days = financeRows(data, "businessDays")
        if (
            days.map { it.getString("businessDayId") }.distinct().size != days.size ||
                data.getInt("closedBusinessDayCount") !=
                    days.count { it.getString("status") == "closed" } ||
                data.getInt("closedTableSessionCount") !=
                    days.sumOf { it.getJSONArray("closedTableSessions").length() } ||
                data.getInt("blockedTableSessionCount") !=
                    days
                        .flatMap { financeRows(it, "blockers") }
                        .map { it.getString("tableSessionId") }
                        .distinct()
                        .size
        )
            invalidResponse()
        days.forEach { day ->
            if (
                day.getString("status") !in listOf("closed", "awaiting_close") ||
                    (day.getString("status") == "closed" &&
                        day.getJSONArray("blockers").length() > 0)
            )
                invalidResponse()
            financeRows(day, "blockers").forEach { if (it.getInt("count") <= 0) invalidResponse() }
        }
    } else {
        if (
            proof.getString("finance") != "review" ||
                root.get("replayed") !is Boolean ||
                data.getString("paymentId") != proof.getString("paymentId") ||
                step.path !=
                    "/api/payments/${LiveCommand.part(data.getString("paymentId"))}/finance-review" ||
                data.getString("ownerEmployeeId") != proof.getString("employeeId") ||
                data.getString("note") != body.getString("note") ||
                data.getString("status") !=
                    if (body.getBoolean("resolve")) "resolved" else "reviewing"
        )
            invalidResponse()
    }
}

fun validateFinancePage(page: JSONObject, query: FinanceQuery, cursor: String?) {
    val rows = financeRows(page, "data")
    val next = page.getJSONObject("meta").textOrNull("nextCursor")
    if (
        rows.map { it.getString("id") }.distinct().size != rows.size ||
            rows.any {
                it.getString("id").isBlank() ||
                    it.getString("currency").isBlank() ||
                    it.getString("businessDate") != query.date ||
                    it.getString("entryType") !in
                        listOf("payment", "refund", "fee", "adjustment") ||
                    (it.get("amountMinor") !is Int && it.get("amountMinor") !is Long) ||
                    it.getLong("amountMinor") == 0L ||
                    (it.getString("entryType") == "payment" && it.getLong("amountMinor") < 0) ||
                    (it.getString("entryType") == "refund" && it.getLong("amountMinor") > 0) ||
                    (query.type.isNotEmpty() && it.getString("entryType") != query.type) ||
                    assignmentDate(it.getString("occurredAt")) == null
            } ||
            next != null && (next.isEmpty() || next == cursor)
    )
        invalidResponse()
}
