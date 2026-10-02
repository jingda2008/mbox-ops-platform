package com.mbox.staff

import java.net.URLEncoder
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import org.json.JSONObject

data class HistoryQuery(
    val date: String = "",
    val endDate: String = "",
    val table: String = "",
    val employee: String = "",
    val search: String = "",
    val area: String = "",
    val paymentStatus: String = "",
    val workKind: String = "",
) {
    fun path(page: Int = 0): String {
        require(
            page in 0..2000 &&
                listOf(table, employee, search, area).all { it.length <= 80 } &&
                paymentStatus in statuses &&
                workKind in listOf("", "prepared", "delivered")
        ) {
            "查询条件过长或页码无效"
        }
        val pairs =
            linkedMapOf(
                "table" to table,
                "employee" to employee,
                "search" to search,
                "area" to area,
                "paymentStatus" to paymentStatus,
                "page" to page.toString(),
            )
        if (workKind.isNotEmpty()) pairs["workKind"] = workKind
        if (date.isNotEmpty() || endDate.isNotEmpty()) {
            val start = runCatching { LocalDate.parse(date) }.getOrNull()
            val end = runCatching { LocalDate.parse(endDate) }.getOrNull()
            require(
                start != null &&
                    end != null &&
                    start.toString() == date &&
                    end.toString() == endDate &&
                    ChronoUnit.DAYS.between(start, end) in 0..366
            ) {
                "请填写有效营业日，起止范围最多366天"
            }
            pairs["businessDate"] = date
            pairs["endDate"] = endDate
        }
        return "/api/operations/history?" +
            pairs.entries.joinToString("&") { it.key + "=" + URLEncoder.encode(it.value, "UTF-8") }
    }

    companion object {
        val statuses =
            listOf(
                "",
                "unpaid",
                "pending",
                "partially_paid",
                "paid",
                "partially_refunded",
                "refunded",
            )
    }
}

fun historyStatus(raw: String) =
    mapOf(
        "draft" to "草稿",
        "submitted" to "已下单",
        "confirmed" to "已确认",
        "fulfilling" to "履约中",
        "completed" to "已完成",
        "cancelled" to "已取消",
        "accepted" to "已接单",
        "preparing" to "制作中",
        "ready" to "待送达",
        "delivered" to "已送达",
        "unpaid" to "待支付",
        "pending" to "处理中",
        "partially_paid" to "部分付款",
        "paid" to "已支付",
        "partially_refunded" to "部分退款",
        "refunded" to "已退款",
        "stopped" to "已停止",
        "held" to "已暂停",
    )[raw] ?: "状态待核对（$raw）"

fun historyMoney(value: Long?) =
    value?.let { java.math.BigDecimal.valueOf(it, 2).toPlainString().let { amount -> "¥$amount" } }
        ?: "待核对"

fun JSONObject.longOrNull(key: String): Long? = if (isNull(key)) null else getLong(key)

fun JSONObject.textOrNull(key: String): String? = if (isNull(key)) null else getString(key)

data class LiveHistory(val source: JSONObject) {
    val date = source.getString("businessDate")
    val endDate = source.optString("endDate", date)
    val page = source.getInt("page")
    val hasMore = source.getBoolean("hasMore")
    val orders = source.getJSONArray("orders").objects()
    val receipts = source.getJSONArray("receipts").objects()

    fun validate(expected: Int) {
        if (page != expected || orders.map { it.getString("id") }.distinct().size != orders.size)
            invalidResponse()
        source.getString("generatedAt")
        if (source.has("financialSummaryVisible")) source.getBoolean("financialSummaryVisible")
        source.optJSONObject("summary")?.let { summary ->
            listOf("orderCount", "unsettledCount", "pendingPaymentCount", "pendingRefundCount")
                .forEach { summary.getInt(it) }
            listOf("orderAmountMinor", "outstandingMinor").forEach { summary.getString(it) }
        }
        receipts.forEach { row ->
            row.getString("provider")
            listOf("receivedMinor", "refundedMinor", "netMinor").forEach { row.getLong(it) }
        }
        orders.forEach { order ->
            listOf("publicId", "tableCode", "submittedAt", "status", "paymentStatus").forEach {
                order.getString(it)
            }
            order.getLong("totalMinor")
            order.getJSONArray("items").objects().forEach { item ->
                listOf("id", "name", "status").forEach { item.getString(it) }
                item.getInt("quantity")
                item.getLong("unitPriceMinor")
                item.getLong("totalMinor")
                item.optJSONObject("quantities")?.let { q ->
                    listOf("total", "held", "stopped", "ready", "delivered", "usedLoss").forEach {
                        q.getInt(it)
                    }
                }
            }
        }
    }
}
