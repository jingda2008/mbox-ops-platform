package com.mbox.staff

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** Exercises the real report coroutine, auth refresh, HTTP envelope, and report validator offline. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class EmployeeSalesReportContractTest {
    private lateinit var model: AppModel
    private lateinit var actor: StaffIdentity
    private lateinit var auth: JSONObject
    private val requests = CopyOnWriteArrayList<APIRequest>()
    @Volatile private var reportResponse = APIResponse(200, "{\"data\":[]}")

    @Before fun setUp() {
        val app: Application = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        auth = JSONObject(javaClass.classLoader!!.getResourceAsStream("live-service.json")!!
            .bufferedReader().use { it.readText() }).getJSONObject("auth")
            .put("permissions", JSONArray(listOf("commercial.sales.view")))
            .put("deniedPermissions", JSONArray())
        val api = StaffAPI { request ->
            requests.add(request)
            when {
                request.path == "/api/auth/login" || request.path == "/api/auth/heartbeat" ->
                    APIResponse(200, JSONObject().put("data", auth).toString())
                request.path.substringBefore('?') == salesPath -> reportResponse
                else -> error("Unexpected offline test path: ${request.path}")
            }
        }
        actor = api.login("staff", "1234", false)
        model = AppModel(app, apiOverride = api)
        AppModel::class.java.declaredMethods.single { it.name == "setIdentity" && it.parameterCount == 1 }
            .also { it.isAccessible = true }.invoke(model, actor)
        model.foreground = true
        requests.clear()
    }

    @After fun tearDown() {
        model.viewModelScope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    // Mirrors commercial-ops-api.toEmployeeSalesDto: internal employee/product IDs are omitted,
    // SUM(quantity_delta)::text remains a string, and amounts are integer minor-unit numbers.
    private fun salesRow(quantity: Any) = JSONObject()
        .put("employeeCode", "staff").put("employeeDisplayName", "测试员工")
        .put("productCode", "DRINK-01").put("productName", "特调")
        .put("categoryCode", "cocktails").put("quantity", quantity)
        .put("salesAmountMinor", 7500).put("costAmountMinor", 3000)
        .put("contributionProfitMinor", 4500).put("refundReversalAmountMinor", 2500)
        .put("costCoverageComplete", true).put("currency", "CNY")

    private fun respondWith(vararg rows: JSONObject) {
        reportResponse = APIResponse(200, JSONObject().put("data", JSONArray(rows.toList())).toString())
    }

    private fun read(filters: Map<String, String> = emptyMap()): JSONObject = runBlocking {
        model.readBusinessReport("sales", filters)
    }

    private fun reportRequests() = requests.filter { it.path.substringBefore('?') == salesPath }

    @Test fun realDtoEnvelopeRetainsFractionalTextAndRowMetadata() {
        val source = salesRow("1.500000")
        respondWith(source)
        val result = read().getJSONArray("rows")
        assertEquals(1, result.length())
        val row = result.getJSONObject(0)
        assertTrue(row.get("quantity") is String)
        assertEquals("1.500000", row.get("quantity"))
        for (key in source.keys()) assertEquals("field $key", source.get(key), row.get(key))
        assertFalse(row.has("employeeId"))
        assertFalse(row.has("productId"))
        assertEquals(listOf("/api/auth/heartbeat", salesPath), requests.map { it.path })
        assertFalse(model.businessRequestInFlight)
    }

    @Test fun refundOnlyRowsKeepNegativeTotalsAndUnknownCosts() {
        val unknown = salesRow("-0.500000")
            .put("salesAmountMinor", -6400).put("refundReversalAmountMinor", 6400)
            .put("costAmountMinor", JSONObject.NULL).put("contributionProfitMinor", JSONObject.NULL)
            .put("costCoverageComplete", false)
        val known = salesRow("-1.000000")
            .put("salesAmountMinor", -12800).put("refundReversalAmountMinor", 12800)
            .put("costAmountMinor", -2000).put("contributionProfitMinor", -10800)
        val knownZero = salesRow("0.000000")
            .put("salesAmountMinor", 0).put("refundReversalAmountMinor", 0)
            .put("costAmountMinor", 0).put("contributionProfitMinor", 0)
        respondWith(unknown, known, knownZero)
        val rows = read().getJSONArray("rows")
        val first = rows.getJSONObject(0)
        assertEquals("-0.500000", first.get("quantity"))
        assertEquals(-6400L, first.getLong("salesAmountMinor"))
        // SQL negates refund sales deltas for the separate reversal amount.
        assertEquals(6400L, first.getLong("refundReversalAmountMinor"))
        assertTrue(first.has("costAmountMinor") && first.isNull("costAmountMinor"))
        assertTrue(first.has("contributionProfitMinor") && first.isNull("contributionProfitMinor"))
        assertFalse(first.getBoolean("costCoverageComplete"))
        assertEquals("数据不足", BusinessReports.amount(first, "costAmountMinor"))
        val second = rows.getJSONObject(1)
        assertEquals("-1.000000", second.get("quantity"))
        assertEquals(-12800L, second.getLong("salesAmountMinor"))
        assertEquals(-2000L, second.getLong("costAmountMinor"))
        assertEquals(-10800L, second.getLong("contributionProfitMinor"))
        assertTrue(second.getBoolean("costCoverageComplete"))
        val third = rows.getJSONObject(2)
        assertFalse(third.isNull("costAmountMinor"))
        assertEquals(0L, third.getLong("costAmountMinor"))
        assertEquals(0L, third.getLong("contributionProfitMinor"))
        assertTrue(third.getBoolean("costCoverageComplete"))
        assertEquals("¥0.00", BusinessReports.amount(third, "costAmountMinor"))
    }

    @Test fun emptyServerArrayIsAnEmptyReportWithoutFabricatedRowsOrTotals() {
        respondWith()
        val result = read()
        assertEquals(0, result.getJSONArray("rows").length())
        assertEquals(setOf("rows"), result.keys().asSequence().toSet())
        assertEquals(1, reportRequests().size)
        assertFalse(model.businessRequestInFlight)
    }

    @Test fun malformedQuantitiesFailThroughTheRealReportChainAndReleaseTheReadLock() {
        for (quantity in listOf("NaN", "Infinity", "1e3", " 1.500", "1,500", true, JSONObject.NULL)) {
            respondWith(salesRow(quantity))
            assertThrows("quantity=$quantity", IllegalArgumentException::class.java) { read() }
            assertFalse("Invalid response left report busy", model.businessRequestInFlight)
        }
        respondWith(salesRow("1.500"))
        assertEquals("1.500", read().getJSONArray("rows").getJSONObject(0).get("quantity"))
        assertEquals(actor.employeeId, model.identity?.employeeId)
    }

    @Test fun decimalQuantityDoesNotPermitFractionalOrStringMoneyOnTheWire() {
        for (field in listOf("salesAmountMinor", "refundReversalAmountMinor", "costAmountMinor", "contributionProfitMinor")) {
            respondWith(salesRow("1.500").put(field, 1.5))
            assertThrows("fractional $field", ArithmeticException::class.java) { read() }
            respondWith(salesRow("1.500").put(field, "100"))
            assertThrows("string $field", IllegalArgumentException::class.java) { read() }
        }
        assertFalse(model.businessRequestInFlight)
    }

    @Test fun ownAndAllSalesPermissionsKeepAuthenticatedGetAndServerControlledScope() {
        val expected = "$salesPath?startDate=2026-09-01&endDate=2026-09-30"
        val filters = mapOf("startDate" to "2026-09-01", "endDate" to "2026-09-30",
            "employeeId" to "another-employee", "productId" to "another-product", "scope" to "all")
        for (permission in listOf("commercial.sales.view", "commercial.sales.view_all")) {
            auth.put("permissions", JSONArray(listOf(permission)))
            requests.clear()
            respondWith(salesRow("1.500"))
            read(filters)
            assertEquals(listOf("/api/auth/heartbeat", expected), requests.map { it.path })
            val request = reportRequests().single()
            assertNull("StaffAPI uses GET only when the body is null", request.body)
            assertEquals(actor.employeeId, request.headers["x-mbox-staff-employee-id"])
            assertEquals(actor.sessionId, request.headers["x-mbox-staff-session-id"])
            assertFalse(request.headers.containsKey("idempotency-key"))
            assertEquals(setOf(permission), model.identity?.permissions)
        }
    }

    @Test fun heartbeatPermissionRevocationStopsBeforeFetchingSalesRows() {
        for (removed in listOf(false, true)) {
            auth.put("permissions", JSONArray(if (removed) emptyList<String>() else listOf("commercial.sales.view")))
                .put("deniedPermissions", JSONArray(if (removed) emptyList<String>() else listOf("commercial.sales.view")))
            requests.clear()
            respondWith(salesRow("1.500"))
            assertThrows(IllegalArgumentException::class.java) { read() }
            assertEquals(listOf("/api/auth/heartbeat"), requests.map { it.path })
            assertTrue(reportRequests().isEmpty())
            assertFalse(model.identity!!.allows("commercial.sales.view"))
            assertFalse(model.businessRequestInFlight)
        }
    }

    @Test fun serverDataScopeDenialIsPropagatedWithoutFallbackOrAnotherEmployeeQuery() {
        reportResponse = APIResponse(403, "{\"error\":{\"code\":\"ACCESS_DENIED\",\"message\":\"outside data scope\"}}")
        val failure = assertThrows(StaffAPIError::class.java) { read() }
        assertEquals(403, failure.status)
        assertEquals("ACCESS_DENIED", failure.code)
        assertEquals(listOf("/api/auth/heartbeat", salesPath), requests.map { it.path })
        assertNull(reportRequests().single().body)
        assertEquals(actor.employeeId, model.identity?.employeeId)
        assertFalse(model.businessRequestInFlight)
    }

    private companion object {
        const val salesPath = "/api/commercial-ops/employee-sales"
    }
}
