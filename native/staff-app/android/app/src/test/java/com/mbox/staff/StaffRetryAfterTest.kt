package com.mbox.staff

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StaffRetryAfterTest {
    private val now = Instant.parse("2026-10-05T12:00:00Z")

    @Test fun parsesNonNegativeDecimalSecondsWithoutCoercionOrOverflow() {
        assertEquals(0L, parseRetryAfterSeconds("0", now))
        assertEquals(60L, parseRetryAfterSeconds(" 60\t", now))
        assertEquals(1L, parseRetryAfterSeconds("001", now))
        for (invalid in listOf(null, "", " ", "-1", "+1", "1.5", "1e3", "NaN", "60, 120",
            "9223372036854775808", "30\r\nSet-Cookie: secret", "30\u0000", "9".repeat(129)))
            assertNull(invalid, parseRetryAfterSeconds(invalid, now))
    }

    @Test fun strictRfc1123DatesNeverRetryBeforeTheRequestedInstant() {
        assertEquals(60L, parseRetryAfterSeconds("Mon, 05 Oct 2026 12:01:00 GMT", now))
        assertEquals(60L, parseRetryAfterSeconds("Mon, 5 Oct 2026 20:01:00 +0800", now))
        assertEquals(61L, parseRetryAfterSeconds("Mon, 05 Oct 2026 12:01:01 GMT", now.plusMillis(200)))
        assertEquals(0L, parseRetryAfterSeconds("Mon, 05 Oct 2026 12:00:00 GMT", now))
        for (invalid in listOf("Mon, 05 Oct 2026 11:59:59 GMT", "Tue, 05 Oct 2026 12:01:00 GMT",
            "Mon, 32 Oct 2026 12:01:00 GMT", "Mon, 05 Oct 2026 25:01:00 GMT", "2026-10-05T12:01:00Z"))
            assertNull(invalid, parseRetryAfterSeconds(invalid, now))
    }

    @Test fun transportRetryAfterReachesTheOriginalErrorWithoutChangingCommitClassification() {
        val error = JSONObject().put("code", "PUSH_RATE_LIMITED").put("message", "请稍后重试")
        var response = APIResponse(429, JSONObject().put("error", error).toString(), mapOf("retry-after" to listOf("120")))
        val api = StaffAPI(transport = { response })
        val rateLimited = assertThrows(StaffAPIError::class.java) { api.raw("/api/native/push/capabilities") }
        assertEquals(429, rateLimited.status)
        assertEquals("PUSH_RATE_LIMITED", rateLimited.code)
        assertEquals("请稍后重试", rateLimited.message)
        assertEquals(120L, rateLimited.retryAfterSeconds)
        assertTrue(rateLimited.commitDisposition.isNullOrEmpty())
        assertFalse(rateLimited.definitivelyRejected)

        error.put("code", "NATIVE_BUSINESS_NOT_COMMITTED").put("commitDisposition", "not_committed")
        response = APIResponse(409, JSONObject().put("error", error).toString(), mapOf("Retry-After" to listOf("5")))
        val rejected = assertThrows(StaffAPIError::class.java) { api.raw("/api/native/push/capabilities") }
        assertEquals("not_committed", rejected.commitDisposition)
        assertTrue(rejected.definitivelyRejected)
        assertEquals(5L, rejected.retryAfterSeconds)
    }

    @Test fun absentMalformedAndAmbiguousResponseHeadersRemainUnknown() {
        var headers = emptyMap<String, List<String>>()
        val api = StaffAPI(transport = { APIResponse(429, "{\"error\":{\"code\":\"PUSH_RATE_LIMITED\",\"message\":\"请稍后重试\"}}", headers) })
        for (candidate in listOf(emptyMap(), mapOf("Retry-After" to listOf("-5")),
            mapOf("Retry-After" to listOf("60", "120")),
            mapOf("Retry-After" to listOf("60"), "retry-after" to listOf("120")),
            mapOf("Retry-After" to listOf("60, 120")), mapOf("Unrelated" to listOf("300")))) {
            headers = candidate
            val failure = assertThrows(StaffAPIError::class.java) { api.raw("/api/native/push/capabilities") }
            assertNull(failure.retryAfterSeconds)
            assertEquals("PUSH_RATE_LIMITED", failure.code)
        }
    }

    @Test fun anonymousCapabilityRateLimitCarriesDelayWithoutAnAcceptanceReceipt() {
        val client = NativePushClient(StaffAPI(), capabilityTransport = {
            APIResponse(429, "{\"error\":{\"code\":\"PUSH_RATE_LIMITED\",\"message\":\"请稍后重试\"}}", mapOf("Retry-After" to listOf("180")))
        })
        val request = NativePushCapabilityRevocation(NativePushBinding("11111111-1111-4111-8111-111111111111", 1), "A".repeat(43))
        val failure = assertThrows(StaffAPIError::class.java) { client.revokeCapability(request) }
        assertEquals(180L, failure.retryAfterSeconds)
        assertFalse(failure.definitivelyRejected)
        assertTrue(failure.commitDisposition.isNullOrEmpty())
    }
}
