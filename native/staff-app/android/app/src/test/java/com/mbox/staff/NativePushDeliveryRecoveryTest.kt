package com.mbox.staff

import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Offline transport exercises the real StaffAPI/client validators; no provider or delivery claim. */
class NativePushDeliveryRecoveryTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val other = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val deliveryA = "55555555-5555-4555-8555-555555555555"
    private val deliveryB = "66666666-6666-4666-8666-666666666666"
    private val task = "77777777-7777-4777-8777-777777777777"
    private val table = "88888888-8888-4888-8888-888888888888"
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    private val expires = Instant.parse("2099-01-01T00:00:00Z")

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        var failWrites = false
        var failAfterWrite = false
        override fun read() = value
        override fun write(value: String) {
            check(!failWrites) { "fixture disk unavailable" }; this.value = value
            check(!failAfterWrite) { "fixture readback unavailable" }
        }
        override fun remove() { error("Do not erase notification recovery") }
    }
    private fun lifecycle(store: MemoryStore = MemoryStore()) = NativePushLifecycle(store) { now }.also { state ->
        state.reconcileOwner(owner)
        assertTrue(state.recordVerifiedInstallation(NativePushInstallation(owner, NativePushBinding(state.installationId, 1),
            NativePushInstallationStatus.ACTIVE, true, expires, "native-push-${UUID.randomUUID()}"), state.generation, "A".repeat(43)))
    }
    private fun stage(state: NativePushLifecycle, delivery: String = deliveryA, kind: NativePushObservationKind = NativePushObservationKind.OPENED) =
        state.stageCallback(owner, state.currentBinding!!, delivery, kind, state.generation)!!
    private fun open(state: NativePushLifecycle, delivery: String = deliveryA) =
        state.stageRemoteOpen(owner, state.currentBinding!!, delivery, state.generation)!!
    private fun data() = JSONObject().put("protocol", 1).put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
    private fun envelope(value: JSONObject, replayed: Boolean? = null) = APIResponse(200, JSONObject().put("data", value)
        .apply { if (replayed != null) put("meta", JSONObject().put("replayed", replayed)) }.toString())
    private fun target(state: NativePushLifecycle, delivery: String = deliveryA, binding: NativePushBinding = state.currentBinding!!) =
        envelope(data().put("deliveryId", delivery).put("installationId", binding.installationId).put("revision", binding.revision)
            .put("kind", "service_task").put("taskId", task).put("tableSessionId", table))
    private fun observation(request: APIRequest, delivery: String = request.path.substringAfter("/deliveries/").substringBefore('/')) =
        envelope(data().put("requestKey", request.headers.getValue("Idempotency-Key")).put("deliveryId", delivery)
            .put("kind", request.body!!.getString("kind"))
            .put("clientReportedReceivedAt", if (request.body.getString("kind") == "received") now.toString() else JSONObject.NULL)
            .put("clientReportedOpenedAt", if (request.body.getString("kind") == "opened") now.toString() else JSONObject.NULL), true)
    private fun failure(status: Int, code: String) = APIResponse(status,
        JSONObject().put("error", JSONObject().put("code", code).put("message", "fixture safe failure")).toString(),
        if (status == 429) mapOf("Retry-After" to listOf("120")) else emptyMap())
    private fun api(answer: (APIRequest) -> APIResponse): StaffAPI = StaffAPI(transport = { request ->
        if (request.path != "/api/auth/login") answer(request) else envelope(JSONObject()
            .put("session", JSONObject().put("id", owner.staffSessionId).put("employeeId", owner.employeeId)
                .put("expiresAt", expires.toString()).put("onlineLeaseUntil", expires.toString()))
            .put("employee", JSONObject().put("id", owner.employeeId).put("code", "fixture")
                .put("displayName", "测试员工").put("roleCodes", JSONArray()))
            .put("permissions", JSONArray(listOf("service.view"))).put("deniedPermissions", JSONArray()))
    }).also { it.login("fixture", "1234", false) }

    @Test fun lostObservationReplyRetriesOriginalGetPostBodyAndKeyAfterRestart() {
        val store = MemoryStore(); val state = lifecycle(store); val original = stage(state)
        val requests = mutableListOf<APIRequest>(); var loseReply = true
        val client = NativePushClient(api { request ->
            requests += request
            if (request.method == "GET") target(state) else {
                if (loseReply) throw IOException("fixture response lost")
                observation(request)
            }
        })
        assertEquals(NativePushObservationFlushResult(1, 0, false), NativePushDeliveryRecovery(state, client).flushObservations { owner })
        val restored = NativePushLifecycle(store) { now }; loseReply = false
        assertEquals(NativePushObservationFlushResult(0, 1, false), NativePushDeliveryRecovery(restored, client).flushObservations { owner })
        assertEquals(listOf("GET", "POST", "GET", "POST"), requests.map { it.method })
        val posts = requests.filter { it.method == "POST" }
        assertTrue(posts.all { it.path == original.path && it.body.toString() == original.body && it.headers["Idempotency-Key"] == original.requestKey })
        assertNotNull(restored.pendingRemoteOpen) // acknowledgement alone never navigates/consumes the click
    }

    @Test fun wrongReceiptOrFailedLocalSavePreservesOriginalWithoutSendingFurtherObservations() {
        for (failureKind in listOf("wrong-key", "disk")) {
            val store = MemoryStore(); val state = lifecycle(store)
            val first = stage(state); stage(state, deliveryB)
            var posts = 0
            val client = NativePushClient(api { request ->
                val delivery = request.path.substringAfter("/deliveries/").substringBefore('/')
                if (request.method == "GET") target(state, delivery) else {
                    posts++
                    if (failureKind == "disk") { store.failWrites = true; observation(request) }
                    else APIResponse(200, JSONObject(observation(request).text).apply {
                        getJSONObject("data").put("requestKey", "native-push-${UUID.randomUUID()}")
                    }.toString())
                }
            })
            assertEquals(NativePushObservationFlushResult(2, 0, false), NativePushDeliveryRecovery(state, client).flushObservations { owner })
            assertEquals(1, posts)
            assertEquals(first, NativePushLifecycle(store) { now }.pendingObservations().first())
        }
    }

    @Test fun rateLimitBeforeOrDuringPostPreservesQueueAndReturnsRetryAfter() {
        for (onPost in listOf(false, true)) {
            val state = lifecycle(); stage(state); stage(state, deliveryB)
            val calls = mutableListOf<APIRequest>()
            val client = NativePushClient(api { request ->
                calls += request
                if (request.method == "GET" && onPost) target(state) else failure(429, "PUSH_RATE_LIMITED")
            })
            assertEquals(NativePushObservationFlushResult(2, 0, true, 120), NativePushDeliveryRecovery(state, client).flushObservations { owner })
            assertEquals(if (onPost) 2 else 1, calls.size)
        }
    }

    @Test fun fourAttemptBoundAndTerminalTargetDiscardNeverCountAsAcceptedDelivery() {
        val state = lifecycle()
        val ids = (0 until 6).map { UUID.randomUUID().toString() }
        ids.forEach { stage(state, it, NativePushObservationKind.RECEIVED) }
        val requests = mutableListOf<APIRequest>()
        val client = NativePushClient(api { request ->
            requests += request
            val id = request.path.substringAfter("/deliveries/").substringBefore('/')
            when {
                request.method == "POST" -> observation(request)
                id == ids[0] -> failure(404, "PUSH_NOT_FOUND")
                id == ids[1] -> failure(410, "PUSH_TARGET_EXPIRED")
                else -> target(state, id)
            }
        })
        val result = NativePushDeliveryRecovery(state, client).flushObservations { owner }
        assertEquals(NativePushObservationFlushResult(2, 2, false, discarded = 2), result)
        assertEquals(4, requests.count { it.method == "GET" }); assertEquals(2, requests.count { it.method == "POST" })
        assertEquals(ids.takeLast(2), state.pendingObservations().map { it.deliveryId })
    }

    @Test fun authLossAndSameOwnerAbaDuringTargetNeverSendPostUsingNewAuthority() {
        for (mode in listOf("aba", "clear-api", "unauthorized", "forbidden")) {
            val state = lifecycle(); stage(state); val originalBinding = state.currentBinding!!
            var posts = 0
            lateinit var transport: StaffAPI
            transport = api { request ->
                if (request.method == "POST") { posts++; observation(request) }
                else when (mode) {
                    "unauthorized" -> failure(401, "AUTH_REQUIRED")
                    "forbidden" -> failure(403, "PUSH_FORBIDDEN")
                    "clear-api" -> { transport.clearIdentity(); target(state) }
                    else -> {
                        state.reconcileOwner(other); state.reconcileOwner(owner)
                        state.recordVerifiedInstallation(NativePushInstallation(owner, originalBinding,
                            NativePushInstallationStatus.ACTIVE, true, expires, "native-push-${UUID.randomUUID()}"), state.generation)
                        stage(state) // identical owner/binding/delivery, different generation and original request
                        target(state)
                    }
                }
            }
            assertEquals(0, NativePushDeliveryRecovery(state, NativePushClient(transport)).flushObservations { owner }.accepted)
            assertEquals(0, posts); assertEquals(1, state.pendingObservationCount)
        }
    }

    @Test fun anotherCurrentOwnerOrDefaultClosedCallerDoesNotReadOrPostOldObservation() {
        val state = lifecycle(); stage(state)
        val recovery = NativePushDeliveryRecovery(state, NativePushClient(api { error("Wrong owner must not send") }))
        assertEquals(NativePushObservationFlushResult(1, 0, false), recovery.flushObservations())
        assertEquals(NativePushObservationFlushResult(1, 0, false), recovery.flushObservations { other })
    }

    @Test fun everyOpenResolveFreshlyReadsAuthenticatedTargetWithoutClearingOrNavigating() {
        val state = lifecycle(); val original = open(state); var reads = 0
        val recovery = NativePushDeliveryRecovery(state, NativePushClient(api { request ->
            assertEquals("GET", request.method); reads++; target(state)
        }))
        repeat(2) {
            val resolved = recovery.resolvePendingOpen { owner }
            assertEquals(NativePushOpenOutcome.RESOLVED, resolved.outcome)
            assertEquals(original, resolved.verified!!.open)
            assertEquals(state.generation, resolved.verified.generation)
            assertEquals(task, resolved.verified.target.taskId); assertEquals(table, resolved.verified.target.tableSessionId)
            assertTrue(state.isCurrentOpen(resolved.verified.open, resolved.verified.generation))
            assertEquals(original, state.pendingRemoteOpen)
        }
        assertEquals(2, reads); assertEquals(0, state.pendingObservationCount)
    }

    @Test fun expiredAndNotFoundOnlyClearExactOriginalClickAndUnknownKeepsIt() {
        for ((status, code, expected) in listOf(Triple(404, "PUSH_NOT_FOUND", NativePushOpenOutcome.UNAVAILABLE),
            Triple(410, "PUSH_TARGET_EXPIRED", NativePushOpenOutcome.EXPIRED), Triple(503, "PUSH_NOT_CONFIGURED", NativePushOpenOutcome.UNKNOWN),
            Triple(401, "AUTH_REQUIRED", NativePushOpenOutcome.UNAVAILABLE), Triple(403, "PUSH_FORBIDDEN", NativePushOpenOutcome.UNAVAILABLE))) {
            val store = MemoryStore(); val state = lifecycle(store); val original = open(state)
            val result = NativePushDeliveryRecovery(state, NativePushClient(api { failure(status, code) })).resolvePendingOpen { owner }
            assertEquals(expected, result.outcome); assertNull(result.verified)
            if (status == 404 || status == 410) assertNull(NativePushLifecycle(store) { now }.pendingRemoteOpen)
            else assertEquals(original, NativePushLifecycle(store) { now }.pendingRemoteOpen)
        }
        val state = lifecycle(); open(state)
        val recovery = NativePushDeliveryRecovery(state, NativePushClient(api {
            open(state, deliveryB); failure(410, "PUSH_TARGET_EXPIRED")
        }))
        assertEquals(NativePushOpenOutcome.STALE, recovery.resolvePendingOpen { owner }.outcome)
        assertEquals(deliveryB, state.pendingRemoteOpen!!.deliveryId)
    }

    @Test fun changedOpenOrAbaWhileGetIsInFlightCannotReturnVerifiedOldDestination() {
        for (aba in listOf(false, true)) {
            val state = lifecycle(); open(state); val binding = state.currentBinding!!
            val recovery = NativePushDeliveryRecovery(state, NativePushClient(api {
                val response = target(state)
                if (aba) {
                    state.reconcileOwner(other); state.reconcileOwner(owner)
                    state.recordVerifiedInstallation(NativePushInstallation(owner, binding, NativePushInstallationStatus.ACTIVE,
                        true, expires, "native-push-${UUID.randomUUID()}"), state.generation)
                    open(state)
                } else open(state, deliveryB)
                response
            }))
            val result = recovery.resolvePendingOpen { owner }
            assertEquals(NativePushOpenOutcome.STALE, result.outcome); assertNull(result.verified)
            assertNotNull(state.pendingRemoteOpen)
        }
    }

    @Test fun failedNewClickBlocksOldOpenAndLaterStorageRecoverySavesOriginalNewClick() {
        val store = MemoryStore(); val state = lifecycle(store); val original = open(state)
        val context = state.captureCallbackContext()!!
        val priorDisk = store.value
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) {
            state.stageCallback(owner, context.binding, deliveryB, NativePushObservationKind.OPENED, context.generation)
        }
        assertEquals(priorDisk, store.value); assertNull(state.pendingRemoteOpen)
        assertFalse(state.isCurrentOpen(original, context.generation))
        val recovery = NativePushDeliveryRecovery(state, NativePushClient(api { error("Blocked click must not resolve old target") }))
        assertEquals(NativePushOpenOutcome.STORAGE_UNAVAILABLE, recovery.resolvePendingOpen { owner }.outcome)
        // The failed disk write cannot promise B survived process death; the barrier is in-memory.
        assertEquals(original, NativePushLifecycle(store) { now }.pendingRemoteOpen)
        store.failWrites = false
        val recovered = state.capturePendingOpen()!!.open
        assertEquals(deliveryB, recovered.deliveryId)
        assertEquals(state.pendingObservations().single().requestKey, recovered.requestKey)
        assertFalse(state.clearRemoteOpen(original)); assertTrue(state.clearRemoteOpen(recovered))
        assertNull(state.capturePendingOpen())
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { stage(state, deliveryA) }
        store.failWrites = false
        val restored = state.capturePendingOpen()!!.open
        val repeated = stage(state, deliveryA)
        assertEquals(deliveryA, restored.deliveryId); assertEquals(restored.requestKey, repeated.requestKey)
    }

    @Test fun onlyCurrentCallbackCanBlockAndFailedNewerClickInvalidatesAlreadyRunningResolve() {
        val store = MemoryStore(); val state = lifecycle(store); val original = open(state)
        val binding = state.currentBinding!!; val generation = state.generation
        assertFalse(state.blockRemoteOpen(other, binding, generation)); assertEquals(original, state.pendingRemoteOpen)
        assertFalse(state.blockRemoteOpen(owner, binding, generation - 1)); assertEquals(original, state.pendingRemoteOpen)
        val recovery = NativePushDeliveryRecovery(state, NativePushClient(api {
            val response = target(state)
            store.failWrites = true
            assertThrows(IllegalStateException::class.java) { stage(state, deliveryB) }
            response
        }))
        assertEquals(NativePushOpenOutcome.STALE, recovery.resolvePendingOpen { owner }.outcome)
        assertNull(state.pendingRemoteOpen)
        store.failWrites = false; val recovered = state.capturePendingOpen()!!.open
        state.clearRemoteOpen(recovered); open(state)
        assertTrue(state.blockRemoteOpen(owner, binding, generation)); assertNull(state.pendingRemoteOpen)
        assertNull(NativePushLifecycle(store) { now }.pendingRemoteOpen)
        assertThrows(IllegalStateException::class.java) { state.capturePendingOpen() }
        val fresh = open(state, deliveryB); assertEquals(fresh, state.capturePendingOpen()!!.open)
    }

    @Test fun newClickReadbackFailureRetainsItsExactKeyAndExplicitInvalidationDurablyCancelsIt() {
        val store = MemoryStore(); val state = lifecycle(store); open(state)
        store.failAfterWrite = true
        assertThrows(IllegalStateException::class.java) { stage(state, deliveryB) }
        val persisted = NativePushLifecycle(store) { now }.pendingRemoteOpen!!
        assertEquals(deliveryB, persisted.deliveryId); assertNull(state.pendingRemoteOpen)
        store.failAfterWrite = false
        assertEquals(persisted, state.capturePendingOpen()!!.open)
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { stage(state, deliveryA) }
        assertThrows(IllegalStateException::class.java) { state.blockRemoteOpen(owner, state.currentBinding!!, state.generation) }
        store.failWrites = false
        assertThrows(IllegalStateException::class.java) { state.capturePendingOpen() }
        assertNull(NativePushLifecycle(store) { now }.pendingRemoteOpen)
        assertNull(state.pendingRemoteOpen)
    }

    @Test fun newerCapacityFailureCannotBeUnblockedBySavingPreviouslyDirtyClick() {
        val store = MemoryStore(); val state = lifecycle(store); open(state)
        repeat(31) { index ->
            stage(state, UUID.nameUUIDFromBytes("fixture-capacity-$index".toByteArray()).toString(), NativePushObservationKind.RECEIVED)
        }
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { stage(state, deliveryB) }
        assertEquals(32, state.pendingObservationCount)
        val newest = UUID.randomUUID().toString()
        assertThrows(IllegalStateException::class.java) { stage(state, newest) }
        store.failWrites = false
        val recoveredReports = state.pendingObservations() // Saves dirty B, but C is the latest click.
        val previous = recoveredReports.single { it.deliveryId == deliveryB }
        assertTrue(recoveredReports.none { it.deliveryId == newest })
        assertNull(state.pendingRemoteOpen)
        assertFalse(state.isCurrentOpen(NativePushRemoteOpen(owner, state.currentBinding!!, deliveryB, previous.requestKey), state.generation))
        assertThrows(IllegalStateException::class.java) { state.capturePendingOpen() }
        // A new explicit click on B may reuse its original report and establish a new safe intent.
        assertEquals(previous.requestKey, stage(state, deliveryB).requestKey)
        assertEquals(deliveryB, state.capturePendingOpen()!!.open.deliveryId)
    }

    @Test fun successfulUiConsumeSuppressesRepeatedOpenedAcrossRestartWithoutInventingReports() {
        val store = MemoryStore(); val state = lifecycle(store)
        val original = stage(state); val originalOpen = state.pendingRemoteOpen!!
        assertTrue(state.acknowledgeRemoteOpen(originalOpen, state.generation))
        assertNull(state.pendingRemoteOpen); assertEquals(listOf(original), state.pendingObservations())
        assertTrue(state.acceptObservation(original, NativePushObservationReceipt(owner, deliveryA,
            NativePushObservationKind.OPENED, original.requestKey, null, now, false)))
        val restored = NativePushLifecycle(store) { now }
        open(restored, deliveryB)
        val repeated = stage(restored)
        assertEquals(original.requestKey, repeated.requestKey)
        assertNull(restored.pendingRemoteOpen); assertEquals(0, restored.pendingObservationCount)
        assertFalse(restored.acknowledgeRemoteOpen(originalOpen, restored.generation))
        assertNull(NativePushLifecycle(store) { now }.pendingRemoteOpen)
    }

    @Test fun dismissalAllowsAnotherClickAndConsumedHistoryIsBoundedAndCompact() {
        val store = MemoryStore(); val state = lifecycle(store)
        val dismissed = open(state)
        assertTrue(state.clearRemoteOpen(dismissed))
        val again = stage(state)
        assertNotNull(state.pendingRemoteOpen); assertEquals(deliveryA, again.deliveryId)
        state.clearRemoteOpen(state.pendingRemoteOpen!!)
        repeat(256) { index ->
            val candidate = open(state, UUID.nameUUIDFromBytes("fixture-consumed-$index".toByteArray()).toString())
            assertTrue(state.acknowledgeRemoteOpen(candidate, state.generation))
        }
        assertEquals(256, JSONObject(store.value!!).getJSONArray("consumedOpens").length())
        assertTrue(store.value!!.toByteArray(Charsets.UTF_8).size < KeystoreNotificationStateStore.MAX_STATE_BYTES)
        val restored = NativePushLifecycle(store) { now }
        assertThrows(IllegalStateException::class.java) { stage(restored, UUID.randomUUID().toString()) }
        assertNull(restored.pendingRemoteOpen)
    }

    @Test fun rateLimitedOpenAndFailedTerminalCleanupRemainRecoverableAndCancellationPropagates() {
        val store = MemoryStore(); val state = lifecycle(store); val original = open(state)
        val limited = NativePushDeliveryRecovery(state, NativePushClient(api { failure(429, "PUSH_RATE_LIMITED") }))
        assertEquals(NativePushOpenResolution(NativePushOpenOutcome.RATE_LIMITED, retryAfterSeconds = 120), limited.resolvePendingOpen { owner })
        assertEquals(original, state.pendingRemoteOpen)
        val terminal = NativePushDeliveryRecovery(state, NativePushClient(api { store.failWrites = true; failure(410, "PUSH_TARGET_EXPIRED") }))
        assertEquals(NativePushOpenOutcome.STORAGE_UNAVAILABLE, terminal.resolvePendingOpen { owner }.outcome)
        assertEquals(original, NativePushLifecycle(store) { now }.pendingRemoteOpen)
        assertThrows(CancellationException::class.java) { limited.resolvePendingOpen { throw CancellationException("fixture") } }
    }
}
