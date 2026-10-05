package com.mbox.staff

import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePushClientTest {
    private val employee = "11111111-1111-4111-8111-111111111111"
    private val session = "22222222-2222-4222-8222-222222222222"
    private val installationId = "33333333-3333-4333-8333-333333333333"
    private val delivery = "44444444-4444-4444-8444-444444444444"
    private val task = "55555555-5555-4555-8555-555555555555"
    private val tableSession = "66666666-6666-4666-8666-666666666666"
    private val requestKey = "native-push-77777777-7777-4777-8777-777777777777"
    private val owner get() = NativePushOwner(employee, session)
    private val binding get() = NativePushBinding(installationId, 1)

    private fun auth(denied: Boolean = false) = JSONObject()
        .put("session", JSONObject().put("id", session).put("employeeId", employee)
            .put("expiresAt", "2099-01-01T00:00:00Z").put("onlineLeaseUntil", "2020-01-01T00:00:00Z"))
        .put("employee", JSONObject().put("id", employee).put("code", "STAFF").put("displayName", "值班员工").put("roleCodes", JSONArray()))
        .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray(if (denied) listOf("service.view") else emptyList<String>()))
    private fun data() = JSONObject().put("protocol", 1).put("employeeId", employee).put("staffSessionId", session)
    private fun reply(data: JSONObject, replayed: Any? = null): APIResponse = APIResponse(200,
        JSONObject().put("data", data).apply { if (replayed != null) put("meta", JSONObject().put("replayed", replayed)) }.toString())
    private fun api(denied: Boolean = false, answer: (APIRequest) -> APIResponse): StaffAPI {
        val api = StaffAPI(transport = { request ->
            if (request.path == "/api/auth/login") APIResponse(200, JSONObject().put("data", auth(denied)).toString(),
                mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=private-session-cookie; Path=/; Secure; HttpOnly; Max-Age=3600")))
            else answer(request)
        })
        api.login("STAFF", "1234", false)
        return api
    }
    private fun capability(enabled: Boolean = false) = data().put("enabled", enabled)
        .put("reasonCode", if (enabled) JSONObject.NULL else "PUSH_DISABLED")
        .put("platforms", JSONObject()
            .put("ios", JSONObject().put("provider", "apns").put("configured", enabled).put("environment", if (enabled) "production" else JSONObject.NULL))
            .put("android", JSONObject().put("provider", JSONObject.NULL).put("configured", false).put("reasonCode", "PROVIDER_NOT_SELECTED")))
    private fun installation(status: String = "active", bound: Boolean = true) = JSONObject()
        .put("installationId", installationId).put("revision", 1).put("status", status).put("boundToCurrentSession", bound)
        .put("expiresAt", "2099-01-01T00:00:00Z").put("lastRequestKey", if (bound) requestKey else JSONObject.NULL)
    private fun target() = data().put("deliveryId", delivery).put("installationId", installationId).put("revision", 1)
        .put("kind", "service_task").put("taskId", task).put("tableSessionId", tableSession)
    private fun observation() = data().put("requestKey", requestKey).put("deliveryId", delivery).put("kind", "opened")
        .put("clientReportedReceivedAt", JSONObject.NULL).put("clientReportedOpenedAt", "2026-10-05T12:00:00Z")

    @Test fun payloadReferencesAreStableAndNeverAcceptIdentitySecretsOrExternalDestinations() {
        fun payload() = JSONObject().put("protocol", 1).put("kind", "service_task").put("deliveryId", delivery)
        val first = parseNativePushNotification(payload())
        assertEquals(NativePushNotificationReference(delivery), first)
        assertEquals(first, parseNativePushNotification(JSONObject(payload().toString())))
        for ((field, value) in listOf("protocol" to "1", "protocol" to 1.0, "kind" to "open_url", "kind" to 123,
            "deliveryId" to "https://untrusted.example/", "deliveryId" to 123, "deliveryId" to "1-1-1-1-1")) {
            assertNull(parseNativePushNotification(payload().put(field, value)))
        }
        for (field in listOf("employeeId", "staffSessionId", "taskId", "tableSessionId", "secret", "path", "url"))
            assertNull(parseNativePushNotification(payload().put(field, "unexpected")))
        val missing = payload().apply { remove("deliveryId") }
        assertNull(parseNativePushNotification(missing))
        assertNull(parseNativePushNotification(JSONObject().put("mbox", payload())))
    }

    @Test fun androidStaysUnsupportedEvenWhenIosIsConfiguredAndNoRegistrationRequestIsSent() {
        val requests = mutableListOf<APIRequest>()
        var result = capability()
        val client = NativePushClient(api { requests += it; reply(result) })
        assertThrows(NativePushUnsupportedException::class.java) { client.registerAndroid() }
        assertThrows(NativePushUnsupportedException::class.java) { client.rotateAndroidToken() }
        assertTrue(requests.isEmpty())
        assertFalse(client.capabilities(owner).enabled)
        result = capability(true)
        val enabled = client.capabilities(owner)
        assertTrue(enabled.enabled)
        assertFalse(enabled.androidAvailable)
        assertEquals("PROVIDER_NOT_SELECTED", enabled.androidReasonCode)
        assertTrue(requests.all { it.body == null && it.path == "/api/native/push/capabilities" })
        assertTrue(requests.all { it.headers["x-mbox-staff-employee-id"] == employee && it.headers["x-mbox-staff-session-id"] == session })
        // An expired foreground onlineLease is not a background logout under this contract.
        assertEquals(owner, enabled.owner)
    }

    @Test fun capabilitiesFailClosedOnWrongIdentityCoercibleTypesOrInventedAndroidProvider() {
        var result = capability()
        val client = NativePushClient(api { reply(result) })
        val malformed = listOf(
            capability().put("protocol", "1"), capability().put("enabled", "false"),
            capability().put("employeeId", task), capability().put("staffSessionId", task),
            capability().apply { getJSONObject("platforms").getJSONObject("android").put("provider", "apns") },
            capability().apply { getJSONObject("platforms").getJSONObject("android").put("configured", true) },
            capability().apply { getJSONObject("platforms").getJSONObject("android").remove("provider") },
            capability(true).apply { getJSONObject("platforms").getJSONObject("ios").put("environment", "unknown") },
        )
        for (value in malformed) {
            result = value
            assertThrows(NativePushInvalidResponse::class.java) { client.capabilities(owner) }
        }
    }

    @Test fun installationChecksSafeIntegerAndBindingWithoutRevealingPreviousEmployee() {
        var result = data().put("installation", installation(bound = false))
        val client = NativePushClient(api { reply(result) })
        val previous = client.installation(owner, installationId)
        assertFalse(previous.boundToCurrentSession)
        assertNull(previous.lastRequestKey)
        assertEquals(owner, previous.owner)
        assertEquals(binding, previous.binding)
        for (revision in listOf<Any>(0, -1, "1", 1.5, 9_007_199_254_740_992L)) {
            result = data().put("installation", installation().put("revision", revision))
            assertThrows(NativePushInvalidResponse::class.java) { client.installation(owner, installationId) }
        }
        for (row in listOf(installation().put("installationId", task), installation().put("boundToCurrentSession", "true"),
            installation(bound = false).put("lastRequestKey", requestKey), installation().put("status", "delivered"),
            installation().put("expiresAt", "yesterday"))) {
            result = data().put("installation", row)
            assertThrows(NativePushInvalidResponse::class.java) { client.installation(owner, installationId) }
        }
    }

    @Test fun targetResolvesOnlyOriginalDeliveryInstallationRevisionAndTableSession() {
        var result = target()
        val requests = mutableListOf<APIRequest>()
        val client = NativePushClient(api { requests += it; reply(result) })
        val resolved = client.target(owner, delivery, binding)
        assertEquals(task, resolved.taskId)
        assertEquals(tableSession, resolved.tableSessionId)
        for ((field, value) in listOf("deliveryId" to task, "installationId" to task, "revision" to 2,
            "employeeId" to task, "staffSessionId" to task, "kind" to "table", "taskId" to "not-a-uuid", "tableSessionId" to 123)) {
            result = target().put(field, value)
            assertThrows(NativePushInvalidResponse::class.java) { client.target(owner, delivery, binding) }
        }
        assertTrue(requests.all { it.body == null && it.path.endsWith("/target") })
    }

    @Test fun observationsReuseOriginalBodyAndKeyAndNeverInventReceivedFromOpened() {
        val requests = mutableListOf<APIRequest>()
        val client = NativePushClient(api { request ->
            requests += request
            if (request.path.endsWith("/target")) reply(target()) else reply(observation(), true)
        })
        val original = NativePushObservationRequest(owner, binding, delivery, NativePushObservationKind.OPENED, requestKey)
        repeat(2) {
            val receipt = client.observe(original)
            assertTrue(receipt.replayed)
            assertNull(receipt.clientReportedReceivedAt)
            assertNotNull(receipt.clientReportedOpenedAt)
        }
        val posts = requests.filter { it.body != null }
        assertEquals(2, posts.size)
        assertTrue(posts.all { it.body.toString() == "{\"kind\":\"opened\"}" && it.headers["Idempotency-Key"] == requestKey })
        assertEquals(2, requests.count { it.path.endsWith("/target") })
    }

    @Test fun observationRejectsStaleBindingBeforePostAndRejectsUnrelatedOrMalformedReceipts() {
        var targetResult = target().put("revision", 2)
        var result = observation()
        var replayed: Any = false
        var posts = 0
        val client = NativePushClient(api {
            if (it.path.endsWith("/target")) reply(targetResult) else { posts++; reply(result, replayed) }
        })
        val request = NativePushObservationRequest(owner, binding, delivery, NativePushObservationKind.OPENED, requestKey)
        assertThrows(NativePushInvalidResponse::class.java) { client.observe(request) }
        assertEquals(0, posts)
        targetResult = target()
        for ((field, value) in listOf("requestKey" to "native-push-$task", "deliveryId" to task, "kind" to "received",
            "clientReportedOpenedAt" to JSONObject.NULL, "clientReportedReceivedAt" to 123)) {
            result = observation().put(field, value)
            assertThrows(NativePushInvalidResponse::class.java) { client.observe(request) }
        }
        result = observation(); replayed = "true"
        assertThrows(NativePushInvalidResponse::class.java) { client.observe(request) }
    }

    @Test fun ordinaryRevokeVerifiesOriginalRevisionKeyAndExplicitRevokedStatus() {
        var row = installation("revoked")
        var key = requestKey
        val requests = mutableListOf<APIRequest>()
        val client = NativePushClient(api { requests += it; reply(data().put("requestKey", key).put("installation", row), true) })
        val original = NativePushRevokeRequest(owner, binding, requestKey)
        val receipt = client.revoke(original)
        assertEquals(NativePushInstallationStatus.REVOKED, receipt.installation.status)
        assertEquals(binding, receipt.installation.binding)
        assertTrue(receipt.replayed)
        for (invalid in listOf(installation("active"), installation("revoked").put("revision", 2),
            installation("revoked").put("lastRequestKey", "native-push-$task"), installation("revoked", false))) {
            row = invalid
            assertThrows(NativePushInvalidResponse::class.java) { client.revoke(original) }
        }
        row = installation("revoked"); key = "native-push-$task"
        assertThrows(NativePushInvalidResponse::class.java) { client.revoke(original) }
        assertTrue(requests.all { it.headers["Idempotency-Key"] == requestKey && it.body.toString() == "{\"expectedRevision\":1}" })
    }

    @Test fun capabilityRevocationHasNoStaffCookieHeadersOrRememberedCredentialsAndOnlyReportsAcceptance() {
        val ordinary = api { error("能力撤销不得复用当前员工客户端") }
        val requests = mutableListOf<APIRequest>()
        val client = NativePushClient(ordinary, capabilityTransport = {
            requests += it
            APIResponse(200, "{\"data\":{\"protocol\":1,\"accepted\":true}}", mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=must-not-survive; Path=/; Secure; HttpOnly; Max-Age=3600")))
        })
        val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })
        val request = NativePushCapabilityRevocation(binding, secret)
        repeat(2) { assertEquals(NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED, client.revokeCapability(request)) }
        assertFalse(request.toString().contains(secret))
        assertEquals(employee, ordinary.identity!!.employeeId)
        for (sent in requests) {
            assertEquals(setOf("Accept"), sent.headers.keys)
            assertEquals(setOf("revision", "revocationSecret"), sent.body!!.keys().asSequence().toSet())
            assertEquals(secret, sent.body.getString("revocationSecret"))
        }
    }

    @Test fun unavailableAndMalformedCapabilityReceiptsKeepTheirFailureSemantics() {
        var response = APIResponse(503, "{\"error\":{\"code\":\"PUSH_REVOKE_UNCONFIRMED\",\"message\":\"撤销未确认\"}}")
        val client = NativePushClient(StaffAPI(), capabilityTransport = { response })
        val request = NativePushCapabilityRevocation(binding, "A".repeat(43))
        val failure = assertThrows(StaffAPIError::class.java) { client.revokeCapability(request) }
        assertEquals("PUSH_REVOKE_UNCONFIRMED", failure.code)
        for (text in listOf("{\"data\":{\"protocol\":1,\"accepted\":\"true\"}}",
            "{\"data\":{\"protocol\":\"1\",\"accepted\":true}}", "{\"data\":{\"protocol\":1,\"accepted\":false}}",
            "{\"data\":{\"protocol\":1,\"accepted\":true,\"status\":\"revoked\"}}")) {
            response = APIResponse(200, text)
            assertThrows(NativePushInvalidResponse::class.java) { client.revokeCapability(request) }
        }
        assertThrows(IllegalArgumentException::class.java) { NativePushCapabilityRevocation(binding, "A".repeat(42) + "B") }
    }

    @Test fun localOwnerOrPermissionChangesStopRequestsAndUncertainServerErrorsAreNotRewritten() {
        var requests = 0
        val denied = NativePushClient(api(denied = true) { requests++; reply(capability()) })
        assertThrows(IllegalArgumentException::class.java) { denied.capabilities(owner) }
        assertEquals(0, requests)
        val client = NativePushClient(api { requests++; APIResponse(409, "{\"error\":{\"code\":\"PUSH_RECEIPT_CONFLICT\",\"message\":\"原请求待核对\"}}") })
        assertThrows(IllegalArgumentException::class.java) { client.capabilities(NativePushOwner(employee, task)) }
        assertEquals(0, requests)
        val failure = assertThrows(StaffAPIError::class.java) { client.revoke(NativePushRevokeRequest(owner, binding, requestKey)) }
        assertEquals("PUSH_RECEIPT_CONFLICT", failure.code)
        assertFalse(failure.definitivelyRejected)
    }
}
