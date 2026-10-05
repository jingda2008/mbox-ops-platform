package com.mbox.staff

import java.net.HttpCookie
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StaffAPIMethodTest {
    @Test fun existingCallsKeepGetAndPostDefaults() {
        val requests = mutableListOf<APIRequest>()
        val api = StaffAPI(transport = { requests += it; APIResponse(200, "{}") })
        val body = JSONObject().put("value", "original")

        api.raw("/api/example")
        api.raw("/api/example", body)

        assertEquals(listOf("GET", "POST"), requests.map { it.method })
        assertNull(requests[0].body)
        assertSame(body, requests[1].body)
        assertEquals("application/json", requests[0].headers["Accept"])
        assertEquals("GET", APIRequest("/api/example", null, emptyMap()).method)
        assertEquals("POST", APIRequest("/api/example", body, emptyMap()).method)
    }

    @Test fun explicitPutPreservesOriginalBodyHeadersAndCreatedResponse() {
        val requests = mutableListOf<APIRequest>()
        val response = APIResponse(201, "{\"data\":{\"accepted\":true}}")
        val api = StaffAPI(transport = { requests += it; response })
        val body = JSONObject().put("expectedRevision", 0).put("value", "original")

        val actual = api.raw("/api/example", body, mapOf("idempotency-key" to "original-key"), method = "PUT")

        assertSame(response, actual)
        assertEquals(1, requests.size)
        assertEquals("PUT", requests.single().method)
        assertSame(body, requests.single().body)
        assertEquals("original-key", requests.single().headers["idempotency-key"])
    }

    @Test fun explicitMethodIsNotRecomputedForRequestsWithoutBodies() {
        val methods = mutableListOf<String>()
        val api = StaffAPI(transport = { methods += it.method; APIResponse(200, "{}") })

        for (method in listOf("GET", "POST", "PUT")) api.raw("/api/example", method = method)

        assertEquals(listOf("GET", "POST", "PUT"), methods)
    }

    @Test fun invalidMethodsAndGetBodiesNeverReachTransport() {
        var calls = 0
        val api = StaffAPI(transport = { calls++; APIResponse(200, "{}") })
        for (method in listOf("", "get", "put", " PUT", "PUT ", "PATCH", "DELETE", "HEAD", "POST\r\nX-Test: value")) {
            assertThrows(IllegalArgumentException::class.java) {
                api.raw("/api/example", method = method)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            api.raw("/api/example", JSONObject(), method = "GET")
        }
        assertEquals(0, calls)
    }

    @Test fun authenticatedPutRetainsIdentityCookiesAndOriginalRequestHeaders() {
        val employee = "11111111-1111-4111-8111-111111111111"
        val session = "22222222-2222-4222-8222-222222222222"
        val auth = JSONObject()
            .put("session", JSONObject().put("id", session).put("employeeId", employee)
                .put("expiresAt", "2099-01-01T00:00:00Z").put("onlineLeaseUntil", "2020-01-01T00:00:00Z"))
            .put("employee", JSONObject().put("id", employee).put("code", "STAFF")
                .put("displayName", "值班员工").put("roleCodes", JSONArray()))
            .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray())
        val requests = mutableListOf<APIRequest>()
        val api = StaffAPI(transport = { request ->
            requests += request
            if (request.path == "/api/auth/login") APIResponse(
                200,
                JSONObject().put("data", auth).toString(),
                mapOf("Set-Cookie" to listOf(
                    "__Host-mbox_staff_session=test-session-cookie; Path=/; Secure; HttpOnly; Max-Age=3600",
                    "__Host-mbox_device_lease=test-device-cookie; Path=/; Secure; HttpOnly; Max-Age=3600",
                )),
            ) else APIResponse(200, "{}")
        })
        api.login("STAFF", "1234", false)
        api.raw("/api/example", JSONObject().put("expectedRevision", 1),
            mapOf("idempotency-key" to "original-key"), method = "PUT")

        val request = requests.last()
        assertEquals("POST", requests.first().method)
        assertEquals("PUT", request.method)
        assertEquals(employee, request.headers["x-mbox-staff-employee-id"])
        assertEquals(session, request.headers["x-mbox-staff-session-id"])
        assertEquals("original-key", request.headers["idempotency-key"])
        // CookieManager may emit RFC 2965 version-1 quoted values and $Path/$Domain attributes.
        val cookies = request.headers.entries.filter { it.key.equals("Cookie", ignoreCase = true) }
            .flatMap { it.value.split(';') }.map(String::trim).filter { it.isNotEmpty() && !it.startsWith('$') }
            .flatMap(HttpCookie::parse)
        assertEquals("test-session-cookie", cookies.single { it.name == "__Host-mbox_staff_session" }.value)
        assertEquals("test-device-cookie", cookies.single { it.name == "__Host-mbox_device_lease" }.value)
        assertEquals(employee, api.identity?.employeeId)
        assertEquals(session, api.identity?.sessionId)
    }

    @Test fun requestDiagnosticsNeverRevealBodyHeadersOrQueryValues() {
        val request = APIRequest(
            "/api/example?private=path-secret",
            JSONObject().put("pin", "pin-secret").put("token", "token-secret"),
            mapOf("Cookie" to "cookie-secret", "Authorization" to "header-secret"),
            "PUT",
        )
        assertEquals("APIRequest(redacted)", request.toString())
        assertEquals("APIRequest(redacted)", request.copy().toString())
    }
}
