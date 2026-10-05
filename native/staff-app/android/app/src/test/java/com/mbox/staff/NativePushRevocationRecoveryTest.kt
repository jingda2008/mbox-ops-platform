package com.mbox.staff

import java.time.Instant
import java.util.concurrent.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePushRevocationRecoveryTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val nextOwner = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val originalKey = "native-push-55555555-5555-4555-8555-555555555555"
    private val expiry = Instant.parse("2099-01-01T00:00:00Z")
    private val fixtureSecret = "A".repeat(43)

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        var failWrites = false
        override fun read() = value
        override fun write(value: String) { check(!failWrites) { "fixture storage unavailable" }; this.value = value }
        override fun remove() { error("Never discard original recovery records") }
    }

    private fun install(lifecycle: NativePushLifecycle, revision: Long, actor: NativePushOwner = owner, secret: String? = fixtureSecret) {
        lifecycle.reconcileOwner(actor)
        assertTrue(lifecycle.recordVerifiedInstallation(NativePushInstallation(actor,
            NativePushBinding(lifecycle.installationId, revision), NativePushInstallationStatus.ACTIVE,
            true, expiry, originalKey), lifecycle.generation, secret))
    }
    private fun pending(count: Int = 1, store: MemoryStore = MemoryStore(), secret: String? = fixtureSecret) =
        NativePushLifecycle(store).also { lifecycle ->
            repeat(count) { install(lifecycle, it.toLong() + 1, secret = secret); lifecycle.disable() }
        }
    private fun authenticated(answer: (APIRequest) -> APIResponse): StaffAPI = StaffAPI(transport = { request ->
        if (request.path != "/api/auth/login") answer(request) else {
            val auth = JSONObject()
                .put("session", JSONObject().put("id", owner.staffSessionId).put("employeeId", owner.employeeId)
                    .put("expiresAt", expiry.toString()).put("onlineLeaseUntil", expiry.toString()))
                .put("employee", JSONObject().put("id", owner.employeeId).put("code", "STAFF")
                    .put("displayName", "测试员工").put("roleCodes", JSONArray()))
                .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray())
            APIResponse(200, JSONObject().put("data", auth).toString(),
                mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=test-cookie; Path=/; Secure; HttpOnly; Max-Age=3600")))
        }
    }).also { it.login("STAFF", "1234", false) }
    private fun ordinaryReceipt(request: APIRequest, installationId: String): APIResponse {
        val requestKey = request.headers.getValue("Idempotency-Key")
        val row = JSONObject().put("installationId", installationId).put("revision", request.body!!.getLong("expectedRevision"))
            .put("status", "revoked").put("boundToCurrentSession", true).put("expiresAt", expiry.toString()).put("lastRequestKey", requestKey)
        val data = JSONObject().put("protocol", 1).put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
            .put("requestKey", requestKey).put("installation", row)
        return APIResponse(200, JSONObject().put("data", data).put("meta", JSONObject().put("replayed", false)).toString())
    }
    private fun accepted() = APIResponse(200, "{\"data\":{\"protocol\":1,\"accepted\":true}}")
    private fun unavailable() = APIResponse(503, "{\"error\":{\"code\":\"PUSH_REVOKE_UNCONFIRMED\",\"message\":\"撤销待确认\"}}")
    private fun limited() = APIResponse(429, "{\"error\":{\"code\":\"PUSH_RATE_LIMITED\",\"message\":\"稍后重试\"}}", mapOf("Retry-After" to listOf("120")))

    @Test fun sameCurrentOwnerUsesOriginalOrdinaryRequestBeforeCapability() {
        val lifecycle = pending(); val original = lifecycle.pendingRevocations().single().request
        val ordinary = mutableListOf<APIRequest>()
        val client = NativePushClient(authenticated { ordinary += it; ordinaryReceipt(it, lifecycle.installationId) },
            capabilityTransport = { error("Successful ordinary revoke must not send capability") })
        val result = NativePushRevocationRecovery(lifecycle, client).run { owner }
        assertEquals(NativePushRevocationResult(0, 1, false), result)
        assertEquals(original.path, ordinary.single().path)
        assertEquals(original.body, ordinary.single().body.toString())
        assertEquals(original.requestKey, ordinary.single().headers["Idempotency-Key"])
    }

    @Test fun defaultAnonymousRecoveryCarriesNoOldAuthenticationAndDoesNotClearANewerBinding() {
        val lifecycle = pending()
        val slot = lifecycle.pendingRevocations().single()
        install(lifecycle, 2, nextOwner)
        val newerBinding = lifecycle.currentBinding
        val sent = mutableListOf<APIRequest>()
        val api = authenticated { error("Anonymous-only driver must not reuse the logged-in client") }
        val client = NativePushClient(api, capabilityTransport = { sent += it; accepted() })
        val result = NativePushRevocationRecovery(lifecycle, client).run()
        assertEquals(NativePushRevocationResult(0, 1, false), result)
        assertEquals(slot.capability!!.body, sent.single().body.toString())
        assertEquals(setOf("Accept"), sent.single().headers.keys)
        assertEquals(owner, NativePushOwner.from(api.identity!!))
        assertEquals(nextOwner, lifecycle.owner); assertEquals(newerBinding, lifecycle.currentBinding)
        assertFalse(lifecycle.remoteEnabled)
    }

    @Test fun ordinaryUnknownFallsBackToCapabilityAndCapabilityUnknownPreservesOriginalSlotAcrossRestart() {
        val store = MemoryStore(); val lifecycle = pending(store = store)
        val original = lifecycle.pendingRevocations().single()
        val ordinary = mutableListOf<APIRequest>(); val capabilities = mutableListOf<APIRequest>()
        var capabilityResult = unavailable()
        val client = NativePushClient(authenticated { ordinary += it; unavailable() },
            capabilityTransport = { capabilities += it; capabilityResult })
        assertEquals(NativePushRevocationResult(1, 0, false), NativePushRevocationRecovery(lifecycle, client).run { owner })
        val restored = NativePushLifecycle(store)
        assertEquals(original.request, restored.pendingRevocations().single().request)
        capabilityResult = accepted()
        assertEquals(NativePushRevocationResult(0, 1, false), NativePushRevocationRecovery(restored, client).run { owner })
        assertEquals(2, ordinary.size); assertEquals(2, capabilities.size)
        assertTrue(ordinary.all { it.headers["Idempotency-Key"] == original.request.requestKey && it.body.toString() == original.request.body })
        assertTrue(capabilities.all { it.body.toString() == original.capability!!.body })
    }

    @Test fun rateLimitInEitherRouteStopsTheRoundAndReturnsRetryAfterWithoutFallbackOrFurtherSlots() {
        for (useOrdinary in listOf(true, false)) {
            val lifecycle = pending(2)
            var ordinaryCalls = 0; var capabilityCalls = 0
            val client = NativePushClient(authenticated { ordinaryCalls++; limited() },
                capabilityTransport = { capabilityCalls++; limited() })
            val result = NativePushRevocationRecovery(lifecycle, client).run { if (useOrdinary) owner else null }
            assertEquals(NativePushRevocationResult(2, 0, true, 120), result)
            assertEquals(if (useOrdinary) 1 else 0, ordinaryCalls)
            assertEquals(if (useOrdinary) 0 else 1, capabilityCalls)
        }
    }

    @Test fun eachRoundHasAFourSlotBoundAndRereadsOwnerBeforeEveryOrdinaryAttempt() {
        val lifecycle = pending(6)
        var ownerReads = 0; var ordinaryCalls = 0; var capabilityCalls = 0
        val client = NativePushClient(authenticated { ordinaryCalls++; ordinaryReceipt(it, lifecycle.installationId) },
            capabilityTransport = { capabilityCalls++; accepted() })
        val result = NativePushRevocationRecovery(lifecycle, client).run { if (++ownerReads == 1) owner else null }
        assertEquals(NativePushRevocationResult(2, 4, false), result)
        assertEquals(4, ownerReads); assertEquals(1, ordinaryCalls); assertEquals(3, capabilityCalls)
    }

    @Test fun acceptedNetworkResponseWithFailedLocalSaveIsNotCountedAndStopsFurtherNetworkWrites() {
        val store = MemoryStore(); val lifecycle = pending(2, store)
        val originals = lifecycle.pendingRevocations().map { it.request }
        var ordinaryCalls = 0; var capabilityCalls = 0
        val client = NativePushClient(authenticated {
            ordinaryCalls++; store.failWrites = true; ordinaryReceipt(it, lifecycle.installationId)
        }, capabilityTransport = { capabilityCalls++; accepted() })
        val result = NativePushRevocationRecovery(lifecycle, client).run { owner }
        assertEquals(NativePushRevocationResult(2, 0, false), result)
        assertEquals(1, ordinaryCalls); assertEquals(0, capabilityCalls)
        assertEquals(originals, NativePushLifecycle(store).pendingRevocations().map { it.request })
    }

    @Test fun dirtyQueueStorageFailurePreventsAllNetworkHandoff() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        install(lifecycle, 1)
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { lifecycle.disable() }
        val client = NativePushClient(StaffAPI(), capabilityTransport = { error("Unsaved queue must not be transmitted") })
        assertEquals(NativePushRevocationResult(1, 0, false), NativePushRevocationRecovery(lifecycle, client).run())
    }

    @Test fun missingCapabilityAndMissingCurrentOwnerStayPendingWithoutBorrowingAnotherIdentity() {
        val lifecycle = pending(secret = null)
        val client = NativePushClient(authenticated { error("No current owner must not reuse old authentication") },
            capabilityTransport = { error("No secret must not synthesize capability") })
        assertEquals(NativePushRevocationResult(1, 0, false), NativePushRevocationRecovery(lifecycle, client).run { nextOwner })
    }

    @Test fun olderRecordsWithoutCapabilityDoNotStarveALaterRecoverableSlot() {
        val lifecycle = pending(4, secret = null)
        install(lifecycle, 5); lifecycle.disable()
        var calls = 0
        val client = NativePushClient(StaffAPI(), capabilityTransport = { calls++; accepted() })
        assertEquals(NativePushRevocationResult(4, 1, false), NativePushRevocationRecovery(lifecycle, client).run())
        assertEquals(1, calls)
        assertTrue(lifecycle.pendingRevocations().all { it.capability == null })
    }

    @Test fun cancellationAndInterruptionArePropagatedAndDoNotConsumeOrFallback() {
        val lifecycle = pending()
        val client = NativePushClient(StaffAPI(), capabilityTransport = { error("Cancelled recovery must not send") })
        val recovery = NativePushRevocationRecovery(lifecycle, client)
        assertThrows(CancellationException::class.java) { recovery.run { throw CancellationException("fixture cancellation") } }
        assertThrows(InterruptedException::class.java) { recovery.run { throw InterruptedException("fixture interruption") } }
        assertEquals(1, lifecycle.pendingRevocationCount)
    }
}
