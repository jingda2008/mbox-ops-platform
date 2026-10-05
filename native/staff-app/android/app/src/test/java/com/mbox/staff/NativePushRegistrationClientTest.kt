package com.mbox.staff

import java.net.HttpCookie
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The synthetic contract is test-only; it is not a selected or working Android provider. */
class NativePushRegistrationClientTest {
    private val employee = "11111111-1111-4111-8111-111111111111"
    private val session = "22222222-2222-4222-8222-222222222222"
    private val installationId = "33333333-3333-4333-8333-333333333333"
    private val anotherId = "44444444-4444-4444-8444-444444444444"
    private val originalKey = "native-push-55555555-5555-4555-8555-555555555555"
    private val otherKey = "native-push-66666666-6666-4666-8666-666666666666"
    private val owner get() = NativePushOwner(employee, session)
    private val contract = object : NativePushRegistrationContract {
        override val id = "test-only-android-contract"
        override fun accepts(token: NativePushSdkToken) = token.provider == "test-only-provider"
    }

    private fun request(expectedRevision: Long = 0, contractId: String = contract.id,
        provider: String = "test-only-provider", requestOwner: NativePushOwner = owner) = NativePushRegistrationRequest(
        requestOwner, 2, installationId, expectedRevision, contractId, provider,
        "opaque:UPPER_lower/token+value=", "test-build", originalKey,
        Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { (it + 1).toByte() }),
    )

    private fun auth() = JSONObject()
        .put("session", JSONObject().put("id", session).put("employeeId", employee)
            .put("expiresAt", "2099-01-01T00:00:00Z").put("onlineLeaseUntil", "2020-01-01T00:00:00Z"))
        .put("employee", JSONObject().put("id", employee).put("code", "STAFF")
            .put("displayName", "值班员工").put("roleCodes", JSONArray()))
        .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray())

    private fun authenticatedApi(answer: (APIRequest) -> APIResponse): StaffAPI {
        val api = StaffAPI(transport = { transportRequest ->
            if (transportRequest.path == "/api/auth/login") APIResponse(200,
                JSONObject().put("data", auth()).toString(), mapOf("Set-Cookie" to listOf(
                    "__Host-mbox_staff_session=test-session-cookie; Path=/; Secure; HttpOnly; Max-Age=3600",
                    "__Host-mbox_device_lease=test-device-cookie; Path=/; Secure; HttpOnly; Max-Age=3600",
                ))) else answer(transportRequest)
        })
        api.login("STAFF", "1234", false)
        return api
    }

    private fun receipt(request: NativePushRegistrationRequest, replayed: Any = false) = JSONObject()
        .put("data", JSONObject().put("protocol", 1).put("employeeId", employee).put("staffSessionId", session)
            .put("requestKey", request.requestKey)
            .put("installation", JSONObject().put("installationId", request.installationId)
                .put("revision", request.targetBinding.revision).put("status", "active")
                .put("boundToCurrentSession", true).put("expiresAt", "2099-01-01T00:00:00Z")
                .put("lastRequestKey", request.requestKey)))
        .put("meta", JSONObject().put("replayed", replayed))

    @Test fun firstCreatedAndOriginalReplayRetainIdenticalPutBodyKeyAndAuthentication() {
        val original = request()
        val requests = mutableListOf<APIRequest>()
        val api = authenticatedApi { transportRequest ->
            requests += transportRequest
            val replayed = requests.size > 1
            APIResponse(if (replayed) 200 else 201, receipt(original, replayed).toString())
        }
        val client = NativePushClient(api, registrationContract = contract)

        val first = client.registerAndroid(original)
        val restored = NativePushRegistrationRequest.fromJson(original.toJson())
        val replay = client.registerAndroid(restored)

        assertFalse(first.replayed)
        assertTrue(replay.replayed)
        assertEquals(original.targetBinding, first.installation.binding)
        assertEquals(first.installation, replay.installation)
        assertEquals(original.requestKey, replay.requestKey)
        assertTrue(original.same(restored))
        assertEquals(2, requests.size)
        for (sent in requests) {
            val body = requireNotNull(sent.body)
            assertEquals("PUT", sent.method)
            assertEquals(original.path, sent.path)
            assertEquals(original.bodyText, body.toString())
            assertEquals(original.requestKey, sent.headers["Idempotency-Key"])
            assertEquals(employee, sent.headers["x-mbox-staff-employee-id"])
            assertEquals(session, sent.headers["x-mbox-staff-session-id"])
            assertEquals(original.token, body.getString("token"))
            // Preserve the actual name/value check when CookieManager quotes version-1 cookies.
            val cookies = sent.headers.entries.filter { it.key.equals("Cookie", ignoreCase = true) }
                .flatMap { it.value.split(';') }.map(String::trim).filter { it.isNotEmpty() && !it.startsWith('$') }
                .flatMap(HttpCookie::parse)
            assertEquals("test-session-cookie", cookies.single { it.name == "__Host-mbox_staff_session" }.value)
            assertEquals("test-device-cookie", cookies.single { it.name == "__Host-mbox_device_lease" }.value)
            assertEquals("APIRequest(redacted)", sent.toString())
        }
    }

    @Test fun rotationAcceptsUpdatedAndReplayed200ForExactNextRevision() {
        val original = request(expectedRevision = 4)
        var replayed = false
        val api = authenticatedApi { APIResponse(200, receipt(original, replayed).toString()) }
        val client = NativePushClient(api, registrationContract = contract)

        assertEquals(5L, client.rotateAndroidToken(original).installation.binding.revision)
        replayed = true
        assertTrue(client.rotateAndroidToken(original).replayed)
    }

    @Test fun noProductionContractOrUnacceptedProviderNeverCallsTransport() {
        var calls = 0
        val api = authenticatedApi { calls++; APIResponse(500, "{}") }
        val production = NativePushClient(api)
        assertFalse(production.registrationAvailable)
        assertFalse(production.supportsRegistration(NativePushSdkToken(contract.id, "test-only-provider", "opaque")))
        assertThrows(NativePushUnsupportedException::class.java) { production.registerAndroid(request()) }
        assertThrows(NativePushUnsupportedException::class.java) { production.rotateAndroidToken(request(1)) }

        val gated = NativePushClient(api, registrationContract = contract)
        assertTrue(gated.registrationAvailable)
        assertThrows(NativePushUnsupportedException::class.java) { gated.registerAndroid(request(contractId = "other-contract")) }
        assertThrows(NativePushUnsupportedException::class.java) { gated.registerAndroid(request(provider = "other-provider")) }
        assertEquals(0, calls)
    }

    @Test fun wrongRequestOwnerAndFirstRegistrationPassedAsRotationNeverCallTransport() {
        var calls = 0
        val client = NativePushClient(authenticatedApi { calls++; APIResponse(500, "{}") }, registrationContract = contract)
        assertThrows(IllegalArgumentException::class.java) {
            client.registerAndroid(request(requestOwner = NativePushOwner(anotherId, session)))
        }
        assertThrows(IllegalArgumentException::class.java) { client.rotateAndroidToken(request()) }
        assertEquals(0, calls)
    }

    @Test fun mismatchedOwnerKeyRevisionAndBindingCannotBePromotedAsReceipt() {
        val original = request()
        var result = receipt(original)
        val client = NativePushClient(authenticatedApi { APIResponse(201, result.toString()) }, registrationContract = contract)
        val bad = listOf<(JSONObject) -> Unit>(
            { it.getJSONObject("data").put("employeeId", anotherId) },
            { it.getJSONObject("data").put("staffSessionId", anotherId) },
            { it.getJSONObject("data").put("requestKey", otherKey) },
            { it.getJSONObject("data").getJSONObject("installation").put("installationId", anotherId) },
            { it.getJSONObject("data").getJSONObject("installation").put("revision", 2) },
            { it.getJSONObject("data").getJSONObject("installation").put("lastRequestKey", otherKey) },
            { it.getJSONObject("data").getJSONObject("installation").put("boundToCurrentSession", false) },
            { it.getJSONObject("data").getJSONObject("installation").put("status", "revoked") },
        )
        for (mutate in bad) {
            result = receipt(original).also(mutate)
            assertThrows(NativePushInvalidResponse::class.java) { client.registerAndroid(original) }
        }
    }

    @Test fun createdStatusRequiresFirstNonReplayAndUpdatedStatusRequiresRotationOrReplay() {
        for ((original, status, replayed) in listOf(
            Triple(request(), 201, true),
            Triple(request(1), 201, false),
            Triple(request(1), 201, true),
            Triple(request(), 200, false),
        )) {
            val client = NativePushClient(authenticatedApi { APIResponse(status, receipt(original, replayed).toString()) },
                registrationContract = contract)
            assertThrows(NativePushInvalidResponse::class.java) { client.registerAndroid(original) }
        }
    }

    @Test fun malformedStatusOrCoercibleReplayMetadataIsNotAccepted() {
        val original = request()
        for ((status, replayed) in listOf(202 to false, 204 to false, 201 to "false", 201 to 0)) {
            val client = NativePushClient(authenticatedApi { APIResponse(status, receipt(original, replayed).toString()) },
                registrationContract = contract)
            assertThrows(NativePushInvalidResponse::class.java) { client.registerAndroid(original) }
        }
    }

    @Test fun identityLostWhilePutIsInFlightRejectsOtherwiseValidReceipt() {
        val original = request()
        lateinit var api: StaffAPI
        api = authenticatedApi {
            api.clearIdentity()
            APIResponse(201, receipt(original).toString())
        }
        val client = NativePushClient(api, registrationContract = contract)

        assertThrows(IllegalArgumentException::class.java) { client.registerAndroid(original) }
        assertNull(api.identity)
    }
}
