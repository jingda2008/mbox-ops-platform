package com.mbox.staff

import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.util.UUID
import org.json.JSONObject

object BusinessReports {
    private val signedDecimal = Regex("[+-]?[0-9]+(?:\\.[0-9]+)?")
    val occasions = linkedMapOf("" to "全部场景", "business" to "商务", "friends" to "朋友", "date" to "约会", "birthday" to "生日", "music" to "音乐", "relax" to "放松", "other" to "其他")
    val phases = linkedMapOf("" to "全部阶段", "before_show" to "演出前", "acoustic" to "弹唱", "band_live" to "乐队", "intermission" to "中场", "after_show" to "演出后")
    val outcomes = linkedMapOf("all" to "全部结果", "paid" to "已付款", "refunded" to "已退款", "complaint" to "关联投诉", "follow_on_order" to "同桌后续付款", "repeat_purchase" to "同品复购", "margin_unavailable" to "缺成交成本")
    fun allowed(actor: StaffIdentity?, kind: String) = actor != null && if(kind == "sales") actor.allows("commercial.sales.view") || actor.allows("commercial.sales.view_all") else actor.allows("recommendation.analytics.view") && actor.allows("product.observation.analytics.view")
    fun path(kind: String, filter: Map<String,String>, now: Instant = Instant.now()): String {
        require(kind in listOf("sales", "experience"))
        val q = linkedMapOf<String,String>()
        if(kind == "sales") {
            val start = filter["startDate"].orEmpty(); val end = filter["endDate"].orEmpty()
            if(start.isNotBlank() || end.isNotBlank()) {
                val a = LocalDate.parse(start); val b = LocalDate.parse(end)
                require(!b.isBefore(a) && ChronoUnit.DAYS.between(a,b) <= 365) { "日期须完整，范围最多366天" }
                q["startDate"] = a.toString(); q["endDate"] = b.toString()
            }
        } else {
            val days = filter["days"]?.toIntOrNull() ?: 7; require(days in listOf(7,28,84))
            q["from"] = now.minusSeconds(days * 86400L).toString(); q["until"] = now.toString()
            for(key in listOf("productId", "packageProductId", "employeeId")) filter[key]?.takeIf { it.isNotBlank() }?.let { UUID.fromString(it); q[key] = it }
            filter["partySize"]?.takeIf { it.isNotBlank() }?.let { require(it.toInt() in 1..100); q["partySize"] = it }
            filter["tableCode"]?.trim()?.takeIf { it.isNotBlank() }?.let { require(Regex("^[A-Za-z0-9_-]{1,32}$").matches(it)) { "请填写有效桌号" }; q["tableCode"] = it }
            for((key, allowed) in listOf("occasion" to occasions.keys, "performancePhase" to phases.keys, "recommendationOutcome" to outcomes.keys)) filter[key]?.takeIf { it.isNotBlank() }?.let { require(it in allowed); q[key] = it }
        }
        val root = if(kind == "sales") "/api/commercial-ops/employee-sales" else "/api/staff/customer-experience/analytics"
        return root + if(q.isEmpty()) "" else "?" + q.entries.joinToString("&") { URLEncoder.encode(it.key,"UTF-8") + "=" + URLEncoder.encode(it.value,"UTF-8") }
    }
    fun validate(kind: String, result: JSONObject) {
        fun strings(row: JSONObject, vararg keys: String) { for(key in keys) require(row.get(key) is String) { "报表字段缺失，请重试" } }
        fun numbers(row: JSONObject, keys: List<String>, nullable: Boolean = false) {
            for(key in keys) {
                require(row.has(key)) { "报表字段缺失，请重试" }
                if(nullable && row.isNull(key)) continue
                val value = row.get(key)
                require(value is Number && value.toDouble().isFinite()) { "报表数值无效，请重试" }
                if(key.endsWith("Minor")) java.math.BigDecimal(value.toString()).longValueExact()
            }
        }
        if(kind == "sales") for(row in result.getJSONArray("rows").objects()) {
            strings(row,"employeeDisplayName","employeeCode","productName","productCode","currency")
            // EmployeeSalesRow keeps SUM(quantity_delta)::text, including fractional refunds.
            // Validate the decimal without rounding through Double or changing the displayed value.
            val quantity = row.get("quantity")
            require(when(quantity) {
                is String -> signedDecimal.matches(quantity) && quantity.toBigDecimalOrNull() != null
                is Number -> quantity.toDouble().isFinite()
                else -> false
            }) { "报表数量无效，请重试" }
            numbers(row,listOf("salesAmountMinor","refundReversalAmountMinor"))
            numbers(row,listOf("costAmountMinor","contributionProfitMinor"),true)
            require(row.get("costCoverageComplete") is Boolean)
        } else {
            strings(result,"decisionBoundary","generatedAt"); serverInstant(result.getString("generatedAt"))
            val caps = result.getJSONObject("filterCapabilities")
            strings(caps.getJSONObject("occasion"),"basis"); strings(caps.getJSONObject("package"),"basis"); strings(caps.getJSONObject("customerSegment"),"reason")
            for(row in result.getJSONArray("packageOptions").objects()) strings(row,"productId","productName")
            val q = result.getJSONObject("dataQuality")
            numbers(q,listOf("totalInputs","confirmedInputs","unmatchedInputs","correctedEvents"))
            numbers(q.getJSONObject("missingFacts"),listOf("recommendationWithoutExposureCount","paidRecommendationCostUnavailableCount","complaintWithoutOrderLinkCount"))
            for(row in q.getJSONArray("staff").objects()) {
                strings(row,"employeeId","employeeName")
                numbers(row,listOf("inputCount","confirmedCount","unmatchedInputCount","correctedEventCount","positiveEventCount","neutralEventCount","negativeEventCount"))
            }
            for(row in result.getJSONArray("weeklySuggestions").objects()) {
                strings(row,"productName","recommendation","confidenceBasis")
                numbers(row,listOf("sampleSize","supportingEvidence","opposingEvidence","confidence"))
            }
            for(row in result.getJSONArray("recommendation").objects()) {
                strings(row,"productId","productName","currency")
                numbers(row,listOf("exposed","selected","ordered","ignored","rejected","staffModified","paidAmountMinor","refundedAmountMinor","complaintOrderCount","followOnPaidOrderCount","repeatPurchaseOrderCount"))
                numbers(row,listOf("contributionAmountMinor"),true)
            }
            for(row in result.getJSONArray("products").objects()) {
                strings(row,"productId","productName")
                numbers(row,listOf("soldQuantity","paidRevenueMinor","refundedAmountMinor","observationCount","praiseCount","complaintCount","remainingCount","servedLateCount"))
                numbers(row,listOf("frozenCostMinor","contributionAmountMinor"),true)
            }
            for(row in result.getJSONArray("evidence").objects()) {
                strings(row,"tableCode","employeeName","occurredAt","rawExcerpt"); serverInstant(row.getString("occurredAt"))
                numbers(row,listOf("revisionNo","confidence")); require(row.get("corrected") is Boolean)
            }
        }
    }
    fun amount(row: JSONObject, key: String, currency: String = "CNY"): String = if(!row.has(key) || row.isNull(key)) "数据不足" else (if(currency == "CNY") "¥" else "$currency ") + java.math.BigDecimal(row.get(key).toString()).movePointLeft(2).setScale(2).toPlainString()
    fun ratio(numerator: Int, denominator: Int): String = if(denominator <= 0) "无有效分母" else String.format(java.util.Locale.CHINA,"%.1f%%",numerator.toDouble() / denominator * 100)
}
