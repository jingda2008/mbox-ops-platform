package com.mbox.staff

import java.time.Instant
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class BusinessReportsTest {
    @Test fun queryKeepsCalendarDateAndBoundedAnalyticsPeriod() {
        assertEquals("/api/commercial-ops/employee-sales",BusinessReports.path("sales",emptyMap()))
        assertEquals("/api/commercial-ops/employee-sales?startDate=2026-09-01&endDate=2026-09-30",BusinessReports.path("sales",mapOf("startDate" to "2026-09-01","endDate" to "2026-09-30")))
        assertThrows(IllegalArgumentException::class.java) { BusinessReports.path("sales",mapOf("startDate" to "2026-09-30","endDate" to "2026-09-01")) }
        val path = BusinessReports.path("experience",mapOf("days" to "7","tableCode" to "A1","occasion" to "music"),Instant.parse("2026-09-30T12:00:00Z"))
        assertTrue(path.contains("from=2026-09-23T12%3A00%3A00Z")); assertTrue(path.contains("tableCode=A1")); assertFalse(path.contains("customerSegment"))
        assertThrows(IllegalArgumentException::class.java) { BusinessReports.path("experience",mapOf("tableCode" to "A1&employeeId=other")) }
    }
    @Test fun missingCostsRemainUnknownAndLargeMoneyRetainsExactCents() {
        assertEquals("数据不足",BusinessReports.amount(JSONObject().put("cost",JSONObject.NULL),"cost"))
        assertEquals("¥90071992547409.93",BusinessReports.amount(JSONObject().put("cost",9007199254740993L),"cost"))
        assertEquals("无有效分母",BusinessReports.ratio(2,0))
        val row = JSONObject().put("employeeDisplayName","员工").put("employeeCode","A").put("productName","饮品").put("productCode","P").put("currency","CNY").put("quantity",1)
            .put("salesAmountMinor",100).put("refundReversalAmountMinor",0).put("costAmountMinor",JSONObject.NULL).put("contributionProfitMinor",JSONObject.NULL).put("costCoverageComplete",false)
        val data = JSONObject().put("rows",JSONArray().put(row))
        BusinessReports.validate("sales",data)
        row.put("salesAmountMinor",1.5)
        assertThrows(ArithmeticException::class.java) { BusinessReports.validate("sales",data) }
    }
}
