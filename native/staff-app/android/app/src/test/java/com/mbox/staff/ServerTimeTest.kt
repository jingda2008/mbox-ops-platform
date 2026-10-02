package com.mbox.staff

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeParseException
import java.util.TimeZone
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ServerTimeTest {
    @Test fun deviceGrantAcceptsPostgresTimestamp() {
        val api = StaffAPI { APIResponse(200, """{"data":{"expiresAt":"2099-09-30 01:06:06.09+08"}}""") }
        api.grant("fixture-only", "android-fixture")
        assertEquals("2099-09-29T17:06:06.090Z", api.deviceExpiresAt)
    }

    @Test fun screenshotTimestampPreservesActualInstantAndFraction() {
        assertEquals(Instant.parse("2026-09-29T17:06:06.090Z"), serverInstant("2026-09-30 01:06:06.09+08"))
        assertEquals(Instant.parse("2026-09-29T17:06:06.123456Z"), serverInstant("2026-09-30 01:06:06.123456+08"))
    }

    @Test fun equivalentOffsetsAndIsoRemainCompatible() {
        val expected = Instant.parse("2026-09-29T17:06:06.090Z")
        listOf("2026-09-30T01:06:06.09+08:00", "2026-09-30 01:06:06.09+0800",
            "2026-09-29T17:06:06.090Z", "2026-09-29 17:06:06.09+00",
            "2026-09-29 22:36:06.09+05:30", "2026-09-29 13:06:06.09-04",
            "2026-09-29 22:36:36.09+05:30:30").forEach { assertEquals(it, expected, serverInstant(it)) }
    }

    @Test fun parsingNeverAssumesPhoneTimezone() {
        val previous = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone(ZoneId.of("America/Los_Angeles")))
            assertEquals(Instant.parse("2026-09-29T17:06:06.090Z"), serverInstant("2026-09-30 01:06:06.09+08"))
        } finally { TimeZone.setDefault(previous) }
    }

    @Test fun missingTimezoneAndInvalidDatesAreRejected() {
        listOf("2026-09-30 01:06:06", "2026-02-30 01:06:06+08", "2026-09-30 25:06:06+08",
            "2026-09-30 01:06:06+25", "2026-09-30", "", "infinity",
            "2026-09-30 01:06:06.1234567890+08").forEach {
            assertThrows(it, DateTimeParseException::class.java) { serverInstant(it) }
        }
    }

    @Test fun expiredOrMalformedGrantCannotAdmitDevice() {
        listOf("2000-01-01 00:00:00+08", "2099-01-01 00:00:00").forEach { expiry ->
            val api = StaffAPI { APIResponse(200, JSONObject().put("data", JSONObject().put("expiresAt", expiry)).toString()) }
            val error = assertThrows(StaffAPIError::class.java) { api.grant("fixture-only", "android-fixture") }
            assertEquals("INVALID_RESPONSE", error.code)
            assertNull(api.deviceExpiresAt)
            assertNull(api.identity)
        }
    }

    @Test fun loginHeartbeatAndRestartAcceptDatabaseTimestampsWithCookies() {
        val auth = JSONObject(javaClass.classLoader!!.getResourceAsStream("live-contract.json")!!.bufferedReader().use { it.readText() }).getJSONObject("auth")
        auth.getJSONObject("session").put("expiresAt", "2099-01-01 08:00:00+08").put("onlineLeaseUntil", "2099-01-01 08:00:00.123456+08")
        val store = SessionTest.MemoryStore()
        val requests = mutableListOf<APIRequest>()
        val wire: (APIRequest) -> APIResponse = { request ->
            requests.add(request)
            if (request.path == "/api/auth/device-access") APIResponse(200,
                """{"data":{"expiresAt":"2099-01-01 08:00:00+08"}}""",
                mapOf("Set-Cookie" to listOf("__Host-mbox_device_lease=fixture-device; Path=/; Secure; HttpOnly; Max-Age=3600")))
            else APIResponse(200, JSONObject().put("data", auth).toString(),
                if (request.path == "/api/auth/login") mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=fixture-session; Path=/; Secure; HttpOnly; Max-Age=3600")) else emptyMap())
        }
        val api = StaffAPI(store, wire)
        api.rememberSession = true
        api.grant("fixture-only", "android-fixture")
        val identity = api.login("staff", "1234", false)
        assertEquals("2099-01-01T00:00:00Z", identity.expiresAt)
        assertEquals("2099-01-01T00:00:00.123456Z", identity.onlineLeaseUntil)
        assertTrue(requests.last().headers["Cookie"]!!.contains("fixture-device"))
        api.heartbeat()
        val restored = StaffAPI(store, wire)
        assertEquals(identity, restored.restoreSession())
        assertEquals("/api/auth/heartbeat", requests.last().path)
        assertTrue(requests.last().headers["Cookie"]!!.contains("fixture-session"))
        assertFalse(store.text!!.contains("\"pin\""))
        assertFalse(store.text!!.contains("fixture-only"))
    }

    @Test fun orderingContextAndHistoryUseSameTimestampRules() {
        val context = LiveOrderContext.parse(JSONObject("""{"token":"fixture","employeeId":"e","staffSessionId":"s","tableSessionId":"t","expiresAt":"2099-09-30 01:06:06.09+08"}"""))
        assertEquals(Instant.parse("2099-09-29T17:06:06.090Z"), context.expiry)
        assertEquals("2026-09-30 01:06:06", historyExportTime("2026-09-30 01:06:06.09+08"))
        assertEquals("invalid", historyExportTime("invalid"))
        assertNull(assignmentDate("2026-09-30 01:06:06"))
    }
}
