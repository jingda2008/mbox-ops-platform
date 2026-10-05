package com.mbox.staff

import java.net.SocketTimeoutException
import java.time.Instant
import java.util.Collections
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePushRegistrationCoordinatorTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val otherOwner = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    private val otherKey = "native-push-55555555-5555-4555-8555-555555555555"
    private val contract = object : NativePushRegistrationContract {
        override val id = "offline-test-contract"
        override fun accepts(token: NativePushSdkToken) = token.contractId == id && token.provider == "fixture-provider"
    }
    private fun token(value: String = "fixture-token-one") = NativePushSdkToken(contract.id, "fixture-provider", value)

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        var reads = 0
        var writes = 0
        var failWrite: (String) -> Boolean = { false }
        override fun read(): String? { reads++; return value }
        override fun write(value: String) {
            if (failWrite(value)) throw IllegalStateException("fixture storage unavailable")
            this.value = value
            writes++
        }
        override fun remove() { error("Registration recovery must preserve unresolved originals") }
    }

    private fun auth() = JSONObject()
        .put("session", JSONObject().put("id", owner.staffSessionId).put("employeeId", owner.employeeId)
            .put("expiresAt", "2099-01-01T00:00:00Z").put("onlineLeaseUntil", "2099-01-01T00:00:00Z"))
        .put("employee", JSONObject().put("id", owner.employeeId).put("code", "STAFF").put("displayName", "测试员工")
            .put("roleCodes", JSONArray()))
        .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray())

    private fun envelope() = JSONObject().put("protocol", 1)
        .put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)

    private fun error(status: Int, code: String, disposition: String? = null,
        retryAfter: String? = null): APIResponse = APIResponse(status,
        JSONObject().put("error", JSONObject().put("code", code).put("message", "离线测试响应")
            .apply { if (disposition != null) put("commitDisposition", disposition) }).toString(),
        if (retryAfter == null) emptyMap() else mapOf("Retry-After" to listOf(retryAfter)))

    private inner class Fixture(withContract: Boolean = true) {
        val store = MemoryStore()
        var lifecycle = NativePushLifecycle(store) { now }
        var elapsed = 1_000L
        var serverRow: JSONObject? = null
        val requests = Collections.synchronizedList(mutableListOf<APIRequest>())
        var respond: (APIRequest) -> APIResponse = { request -> ordinaryResponse(request) }
        var api = newApi()
        var coordinator = newCoordinator(withContract)

        init { lifecycle.reconcileOwner(owner) }

        fun context() = NativePushTokenContext(owner, lifecycle.generation)

        private fun newApi(): StaffAPI = StaffAPI(transport = { request ->
            if (request.path == "/api/auth/login") APIResponse(200, JSONObject().put("data", auth()).toString(),
                mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=fixture-session; Path=/; Secure; HttpOnly; Max-Age=3600")))
            else {
                require(request.path.startsWith("/api/native/push/installations/")) { "Unexpected business request" }
                requests += request
                respond(request)
            }
        }).also { it.login("STAFF", "1234", false) }

        private fun newCoordinator(withContract: Boolean = true) = NativePushRegistrationCoordinator(lifecycle,
            NativePushClient(api, registrationContract = if (withContract) contract else null), "fixture-app-version") { elapsed }

        fun restart() {
            lifecycle = NativePushLifecycle(store) { now }
            api = newApi()
            coordinator = newCoordinator()
        }

        fun queryResponse(): APIResponse = serverRow?.let {
            APIResponse(200, JSONObject().put("data", envelope().put("installation", it)).toString())
        } ?: error(404, "PUSH_NOT_FOUND")

        fun acceptPut(request: APIRequest): APIResponse {
            assertEquals("PUT", request.method)
            val body = request.body!!
            val requestKey = request.headers["Idempotency-Key"]!!
            serverRow = JSONObject().put("installationId", request.path.substringAfterLast('/'))
                .put("revision", body.getLong("expectedRevision") + 1).put("status", "active")
                .put("boundToCurrentSession", true).put("expiresAt", now.plusSeconds(300).toString())
                .put("lastRequestKey", requestKey)
            return APIResponse(if (body.getLong("expectedRevision") == 0L) 201 else 200,
                JSONObject().put("data", envelope().put("requestKey", requestKey).put("installation", serverRow))
                    .put("meta", JSONObject().put("replayed", false)).toString())
        }

        fun ordinaryResponse(request: APIRequest) = when (request.method) {
            "GET" -> queryResponse()
            "PUT" -> acceptPut(request)
            else -> error("Business writes are outside push registration")
        }

        fun puts() = requests.filter { it.method == "PUT" }
        fun pending() = lifecycle.pendingRegistration()!!
    }

    @Test fun defaultProductionClientRejectsTokenBeforeNetworkOrSecureStateChanges() {
        val f = Fixture(withContract = false)
        val before = f.store.value
        val reads = f.store.reads
        val writes = f.store.writes
        val bridge = NativePushCallbackBridge(f.lifecycle, f.coordinator)
        assertEquals(NativePushRegistrationOutcome.UNSUPPORTED, bridge.onTokenAvailable(f.context(), token()))
        assertEquals(NativePushRegistrationOutcome.UNSUPPORTED, f.coordinator.resume())
        assertEquals(reads, f.store.reads)
        assertEquals(writes, f.store.writes)
        assertEquals(before, f.store.value)
        assertTrue(f.requests.isEmpty())
        assertFalse(f.store.value!!.contains(token().value))
        assertFalse(f.lifecycle.remoteEnabled)
    }

    @Test fun adapterWithoutQueuedTokenOrVerifiedBindingDoesNotReportRegistrationSuccess() {
        val f = Fixture()
        assertEquals(NativePushRegistrationOutcome.STALE, f.coordinator.resume())
        assertTrue(f.requests.isEmpty())
        assertNull(f.lifecycle.currentBinding)
    }

    @Test fun bridgeDelegatesGetPrepareDurablePutAndFreshGetBeforePromotingExactBinding() {
        val f = Fixture()
        var sentOriginal: NativePushRegistrationRequest? = null
        f.respond = { request ->
            assertEquals(owner.employeeId, request.headers["x-mbox-staff-employee-id"])
            assertEquals(owner.staffSessionId, request.headers["x-mbox-staff-session-id"])
            if (request.method == "PUT") {
                val persisted = NativePushLifecycle(MemoryStore(f.store.value)) { now }
                val original = persisted.pendingRegistration()!!
                assertTrue(persisted.registrationAttempted())
                assertEquals(original.bodyText, request.body!!.toString())
                assertEquals(original.requestKey, request.headers["Idempotency-Key"])
                assertEquals(0L, original.expectedRevision)
                assertNull(f.lifecycle.currentBinding)
                sentOriginal = original
            }
            f.ordinaryResponse(request)
        }
        assertEquals(NativePushRegistrationOutcome.REGISTERED,
            NativePushCallbackBridge(f.lifecycle, f.coordinator).onTokenAvailable(f.context(), token()))
        assertEquals(listOf("GET", "GET", "PUT", "GET"), f.requests.map { it.method })
        assertEquals(sentOriginal!!.targetBinding, f.lifecycle.currentBinding)
        assertNull(f.lifecycle.pendingRegistration())
        assertNull(f.lifecycle.queuedToken())
        assertFalse(f.lifecycle.remoteEnabled)
        val requestsBeforeDuplicate = f.requests.size
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(requestsBeforeDuplicate, f.requests.size)
        f.restart()
        assertEquals(sentOriginal!!.targetBinding, f.lifecycle.currentBinding)
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(requestsBeforeDuplicate, f.requests.size)
    }

    @Test fun lostPutReceiptSurvivesRestartAndExactGetConfirmsWithoutASecondPut() {
        val f = Fixture()
        f.respond = { request ->
            if (request.method == "PUT") {
                f.acceptPut(request)
                throw SocketTimeoutException("offline fixture lost response")
            }
            f.queryResponse()
        }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        val original = f.pending()
        assertTrue(f.lifecycle.registrationAttempted())
        assertNull(f.lifecycle.currentBinding)
        f.restart()
        assertTrue(original.same(f.pending()))
        assertTrue(f.lifecycle.registrationAttempted())
        f.respond = { request -> f.ordinaryResponse(request) }
        val before = f.requests.size
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        assertEquals(listOf("GET"), f.requests.drop(before).map { it.method })
        assertEquals(1, f.puts().size)
        assertEquals(original.targetBinding, f.lifecycle.currentBinding)
        assertNull(f.lifecycle.pendingRegistration())
    }

    @Test fun missingGetAfterUnknownNeverClearsOriginalAndReplayKeepsBodyKeyAndSecret() {
        val f = Fixture()
        f.respond = { request -> if (request.method == "PUT") error(500, "PUSH_REQUEST_UNCONFIRMED") else f.queryResponse() }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        val original = f.pending()
        f.restart()
        f.respond = { request ->
            if (request.method == "GET") {
                assertTrue(original.same(f.pending()))
                error(404, "PUSH_NOT_FOUND")
            } else f.acceptPut(request)
        }
        // The post-PUT GET is deliberately still unknown; a receipt alone cannot promote it.
        assertEquals(NativePushRegistrationOutcome.PENDING, f.coordinator.resume())
        assertTrue(original.same(f.pending()))
        assertNull(f.lifecycle.currentBinding)
        assertEquals(2, f.puts().size)
        assertTrue(f.puts().all { it.headers["Idempotency-Key"] == original.requestKey && it.body!!.toString() == original.bodyText })
        f.respond = { request -> f.ordinaryResponse(request) }
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        assertEquals(2, f.puts().size)
    }

    @Test fun laterNotCommittedResponseCannotEraseAnEarlierUnknownAttempt() {
        val f = Fixture()
        f.respond = { request -> if (request.method == "PUT") error(500, "PUSH_REQUEST_UNCONFIRMED") else f.queryResponse() }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        val original = f.pending()
        f.restart()
        f.respond = { request -> if (request.method == "PUT") error(503, "PUSH_NOT_CONFIGURED", "not_committed") else f.queryResponse() }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.resume())
        assertTrue(original.same(f.pending()))
        assertTrue(f.lifecycle.registrationAttempted())
        assertTrue(f.lifecycle.queuedToken()!!.same(token()))
        assertTrue(f.puts().all { it.headers["Idempotency-Key"] == original.requestKey })
    }

    @Test fun firstDefiniteRefusalClearsOnlyOriginalButKeepsTokenAndBacksOffBeforeNewCas() {
        val f = Fixture()
        f.respond = { request -> if (request.method == "PUT") error(503, "PUSH_NOT_CONFIGURED", "not_committed") else f.queryResponse() }
        assertEquals(NativePushRegistrationOutcome.NOT_COMMITTED, f.coordinator.tokenAvailable(f.context(), token()))
        val rejected = f.puts().single()
        assertNull(f.lifecycle.pendingRegistration())
        assertFalse(f.lifecycle.registrationAttempted())
        assertTrue(f.lifecycle.queuedToken()!!.same(token()))
        val before = f.requests.size
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(before, f.requests.size)
        f.elapsed += 60_000
        f.respond = { request -> f.ordinaryResponse(request) }
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        assertEquals(2, f.puts().size)
        assertNotEquals(rejected.headers["Idempotency-Key"], f.puts().last().headers["Idempotency-Key"])
        assertNotEquals(rejected.body!!.getString("revocationSecret"), f.puts().last().body!!.getString("revocationSecret"))
    }

    @Test fun newerTokenIsDurableDuringUnknownOriginalAndRotatesOnlyAfterOriginalConfirmation() {
        val f = Fixture()
        val second = token("fixture-token-two")
        f.respond = { request ->
            if (request.method == "PUT") {
                assertEquals(NativePushRegistrationOutcome.PENDING, f.coordinator.tokenAvailable(f.context(), second))
                assertTrue(NativePushLifecycle(MemoryStore(f.store.value)) { now }.queuedToken()!!.same(second))
                f.acceptPut(request)
                throw SocketTimeoutException("offline original response lost")
            }
            f.queryResponse()
        }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        val original = f.pending()
        assertEquals(token().value, original.token)
        assertTrue(f.lifecycle.queuedToken()!!.same(second))
        f.restart()
        f.respond = { request -> f.ordinaryResponse(request) }
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        assertEquals(original.targetBinding, f.lifecycle.currentBinding)
        assertEquals(1, f.puts().size)
        assertTrue(f.lifecycle.queuedToken()!!.same(second))
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        val rotation = f.puts().last()
        assertEquals(2, f.puts().size)
        assertEquals(1L, rotation.body!!.getLong("expectedRevision"))
        assertEquals(second.value, rotation.body!!.getString("token"))
        assertNotEquals(original.requestKey, rotation.headers["Idempotency-Key"])
        assertNotEquals(original.revocationSecret, rotation.body!!.getString("revocationSecret"))
        assertEquals(2L, f.lifecycle.currentBinding!!.revision)
        assertNull(f.lifecycle.queuedToken())
    }

    @Test fun concurrentResumeIsSingleFlightWhileTransportIsInProgress() {
        val f = Fixture()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        var firstGet = true
        f.respond = { request ->
            if (request.method == "GET" && firstGet) {
                firstGet = false
                entered.countDown()
                check(release.await(3, TimeUnit.SECONDS)) { "Fixture release timed out" }
            }
            f.ordinaryResponse(request)
        }
        try {
            val running = executor.submit<NativePushRegistrationOutcome> { f.coordinator.tokenAvailable(f.context(), token()) }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            assertEquals(NativePushRegistrationOutcome.PENDING, f.coordinator.resume())
            assertEquals(1, f.requests.size)
            release.countDown()
            assertEquals(NativePushRegistrationOutcome.REGISTERED, running.get(5, TimeUnit.SECONDS))
            assertEquals(1, f.puts().size)
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    @Test fun putReplyAfterOwnerAbaCannotPromoteRetiredBindingAndKeepsOriginalRevocation() {
        val f = Fixture()
        val originalGeneration = f.lifecycle.generation
        var original: NativePushRegistrationRequest? = null
        f.respond = { request ->
            if (request.method == "PUT") {
                original = f.pending()
                f.lifecycle.reconcileOwner(otherOwner)
                f.lifecycle.reconcileOwner(owner)
                f.acceptPut(request)
            } else f.queryResponse()
        }
        assertEquals(NativePushRegistrationOutcome.STALE, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(owner, f.lifecycle.owner)
        assertNotEquals(originalGeneration, f.lifecycle.generation)
        assertNull(f.lifecycle.currentBinding)
        assertNull(f.lifecycle.pendingRegistration())
        assertNull(f.lifecycle.queuedToken())
        val revoke = f.lifecycle.pendingRevocations().single()
        assertEquals(original!!.owner, revoke.request.owner)
        assertEquals(original!!.targetBinding, revoke.request.binding)
        assertEquals(original!!.revocationSecret, JSONObject(revoke.capability!!.body).getString("revocationSecret"))
        assertEquals(listOf("GET", "GET", "PUT"), f.requests.map { it.method })
        val before = f.requests.size
        assertEquals(NativePushRegistrationOutcome.STALE,
            f.coordinator.tokenAvailable(NativePushTokenContext(owner, originalGeneration), token()))
        assertEquals(before, f.requests.size)
    }

    @Test fun storageFailureBeforeTokenOriginalOrAttemptMarkerAlwaysPreventsPut() {
        for (stage in listOf("token", "original", "attempt")) {
            val f = Fixture()
            f.store.failWrite = { raw ->
                val json = JSONObject(raw)
                when (stage) {
                    "token" -> !json.isNull("queuedToken")
                    "original" -> !json.isNull("pendingRegistration")
                    else -> json.optBoolean("registrationAttempted", false)
                }
            }
            assertEquals(stage, NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
            assertTrue(stage, f.puts().isEmpty())
            val saved = NativePushLifecycle(MemoryStore(f.store.value)) { now }
            assertFalse(stage, saved.registrationAttempted())
            if (stage == "token") assertTrue(f.requests.isEmpty())
            if (stage == "original") assertNull(saved.pendingRegistration())
            if (stage == "attempt") assertNotNull(saved.pendingRegistration())
            f.store.failWrite = { false }
            f.elapsed += 60_000
            assertEquals(stage, NativePushRegistrationOutcome.REGISTERED, f.coordinator.tokenAvailable(f.context(), token()))
            assertEquals(stage, 1, f.puts().size)
        }
    }

    @Test fun retryAfterBlocksRepeatedCallbacksUntilSpecifiedMonotonicDeadline() {
        val f = Fixture()
        f.respond = { error(429, "PUSH_RATE_LIMITED", retryAfter = "180") }
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(1, f.requests.size)
        assertTrue(f.lifecycle.queuedToken()!!.same(token()))
        f.elapsed += 179_999
        assertEquals(NativePushRegistrationOutcome.RETRY_LATER, f.coordinator.tokenAvailable(f.context(), token()))
        assertEquals(1, f.requests.size)
        f.elapsed++
        f.respond = { request -> f.ordinaryResponse(request) }
        assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
        assertEquals(1, f.puts().size)
    }

    @Test fun cancellationAndInterruptionPreserveOriginalAndReleaseSingleFlightWithoutSwallowing() {
        for (interruption in listOf(CancellationException("fixture cancelled"), InterruptedException("fixture interrupted"))) {
            val f = Fixture()
            f.respond = { request -> if (request.method == "PUT") throw interruption else f.queryResponse() }
            assertSame(interruption, assertThrows(interruption.javaClass) { f.coordinator.tokenAvailable(f.context(), token()) })
            val original = f.pending()
            assertTrue(f.lifecycle.registrationAttempted())
            f.respond = { request -> f.ordinaryResponse(request) }
            assertEquals(NativePushRegistrationOutcome.REGISTERED, f.coordinator.resume())
            assertEquals(2, f.puts().size)
            assertTrue(f.puts().all { it.headers["Idempotency-Key"] == original.requestKey })
        }
    }

    @Test fun laterRevisionWrongKeyOrTerminalGetCannotReviveHistoricalPutReceipt() {
        for (mismatch in listOf("revision", "key", "terminal")) {
            val f = Fixture()
            assertTrue(f.lifecycle.stageToken(f.context(), token()))
            val original = NativePushRegistrationRequest.prepare(f.context(), f.lifecycle.installationId, 0, token(), "fixture-version")
            assertTrue(f.lifecycle.stageRegistration(original))
            assertTrue(f.lifecycle.markRegistrationAttempt(original))
            f.serverRow = JSONObject().put("installationId", f.lifecycle.installationId)
                .put("revision", if (mismatch == "revision") 2 else 1)
                .put("status", if (mismatch == "terminal") "revoked" else "active")
                .put("boundToCurrentSession", true).put("expiresAt", now.plusSeconds(300).toString())
                .put("lastRequestKey", if (mismatch == "key") otherKey else original.requestKey)
            assertEquals(mismatch, NativePushRegistrationOutcome.PENDING, f.coordinator.resume())
            assertTrue(mismatch, original.same(f.pending()))
            assertNull(mismatch, f.lifecycle.currentBinding)
            assertTrue(mismatch, f.puts().isEmpty())
            assertEquals(listOf("GET"), f.requests.map { it.method })
        }
    }
}
