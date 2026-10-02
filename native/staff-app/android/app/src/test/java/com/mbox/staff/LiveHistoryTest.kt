package com.mbox.staff

import java.net.URI
import java.net.URLDecoder
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveHistoryTest {
    @Test
    fun dateRangesAndLiteralFilters() {
        assertFalse(HistoryQuery().path().contains("businessDate"))
        val query =
            HistoryQuery(
                date = "2024-02-29",
                endDate = "2024-03-01",
                table = "A&employee=other+5",
                search = "少冰/桌",
            )
        val args =
            URI(query.path(3)).rawQuery.split("&").associate {
                val p = it.split("=", limit = 2)
                p[0] to URLDecoder.decode(p[1], "UTF-8")
            }
        assertEquals(query.table, args["table"])
        assertEquals("3", args["page"])
        assertEquals("", args["employee"])
        listOf(
                HistoryQuery(date = "2025-02-29", endDate = "2025-03-01"),
                HistoryQuery(date = "2026-09-27", endDate = "2026-09-26"),
                HistoryQuery(date = "2024-01-01", endDate = "2026-01-01"),
                HistoryQuery(paymentStatus = "invented"),
            )
            .forEach { assertThrows(IllegalArgumentException::class.java) { it.path() } }
    }

    @Test
    fun financialHistoryDoesNotImplyReceiptsOrBundleCharges() {
        val source =
            JSONObject(
                javaClass.classLoader!!
                    .getResourceAsStream("live-history.json")!!
                    .bufferedReader()
                    .readText()
            )
        val data = LiveHistory(source)
        data.validate(0)
        assertFalse(data.source.getBoolean("financialSummaryVisible"))
        assertEquals(8000, data.orders[0].getInt("effectiveAmountMinor"))
        assertTrue(
            data.orders[0].getJSONArray("items").getJSONObject(0).getBoolean("includedInBundle")
        )
        assertThrows(StaffAPIError::class.java) { data.validate(1) }
        source.getJSONArray("orders").put(source.getJSONArray("orders").getJSONObject(0))
        assertThrows(StaffAPIError::class.java) { LiveHistory(source).validate(0) }
    }

    @Test
    fun csvRoundTripAndLimits() {
        val source =
            JSONObject(
                javaClass.classLoader!!
                    .getResourceAsStream("live-history.json")!!
                    .bufferedReader()
                    .readText()
            )
        val csv = LiveHistory(source).exportCSV().toString(Charsets.UTF_8)
        assertTrue(csv.startsWith("\uFEFF"))
        assertTrue(csv.contains("\r\n"))
        assertTrue(csv.contains("\"2026-09-26 23:00:00\""))
        assertTrue(csv.contains("\"套餐内商品，不另收费\",\"\",\"\""))
        assertTrue(csv.endsWith("\"\",\"\",\"\",\"\""))
        assertEquals("\"'=SUM(1,2)\"", csvCell("=SUM(1,2)"))
        assertEquals("\"酒,\"\"杯\"\"\n备注\"", csvCell("酒,\"杯\"\n备注"))
        assertTrue(csvCell("\r\n=1").startsWith("\"'"))
        assertEquals("10.01", historyExportAmount(1001))
        assertEquals("-0.01", historyExportAmount(-1))
        val row = source.getJSONArray("orders").getJSONObject(0)
        source.put("orders", org.json.JSONArray(List(5001) { row }))
        assertThrows(IllegalArgumentException::class.java) { LiveHistory(source).exportCSV() }
    }

    @Test
    fun exportsKeepAppliedFilters() {
        val query = HistoryQuery(table = "A&employee=other+5", employee = "本员工")
        val path = query.exportPath(3, true)
        val args =
            URI(path).rawQuery.split("&").associate {
                val p = it.split("=", limit = 2)
                p[0] to URLDecoder.decode(p[1], "UTF-8")
            }
        assertEquals(query.table, args["table"])
        assertEquals(query.employee, args["employee"])
        assertEquals("0", args["page"])
        assertEquals("true", args["exportAll"])
        assertTrue(query.exportPath(3, false).contains("page=3"))
        assertFalse(query.exportPath(3, false).contains("exportAll"))
    }
}
