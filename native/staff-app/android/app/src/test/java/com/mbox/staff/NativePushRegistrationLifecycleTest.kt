package com.mbox.staff

import java.time.Instant
import java.util.Base64
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** State-machine fixtures only: no SDK, real provider token, HTTP registration, or delivery. */
class NativePushRegistrationLifecycleTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val other = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    private val expiry = now.plusSeconds(3600)
    private val delivery = "55555555-5555-4555-8555-555555555555"
    private val token1 = NativePushSdkToken("test-only-contract", "fixture-only-provider", "opaque-fixture-token-1")
    private val token2 = NativePushSdkToken("test-only-contract", "fixture-only-provider", "opaque-fixture-token-2")

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        var failWrites = false
        var failAfterWrite = false
        var writes = 0
        override fun read() = value
        override fun write(value: String) {
            check(!failWrites) { "fixture storage unavailable" }
            this.value = value; writes++
            check(!failAfterWrite) { "fixture readback unavailable" }
        }
        override fun remove() { error("Registration recovery must not be erased") }
    }

    private fun secret(n: Int) = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { (it + n).toByte() })
    private fun key() = "native-push-${UUID.randomUUID()}"
    private fun lifecycle(store: MemoryStore = MemoryStore()) = NativePushLifecycle(store) { now }.also { it.reconcileOwner(owner) }
    private fun context(state: NativePushLifecycle) = NativePushTokenContext(state.owner!!, state.generation)
    private fun request(state: NativePushLifecycle, revision: Long = state.currentBinding?.revision ?: 0,
        token: NativePushSdkToken = token1, actor: NativePushOwner = owner, generation: Long = state.generation,
        installationId: String = state.installationId, secret: String = secret(70), requestKey: String = key()) =
        NativePushRegistrationRequest(actor, generation, installationId, revision, token.contractId, token.provider,
            token.value, "fixture-app-version", requestKey, secret)
    private fun receipt(request: NativePushRegistrationRequest) = NativePushInstallation(request.owner,
        request.targetBinding, NativePushInstallationStatus.ACTIVE, true, expiry, request.requestKey)
    private fun attach(state: NativePushLifecycle, revision: Long = 1, secret: String = secret(1)): NativePushInstallation {
        state.reconcileOwner(owner)
        val row = NativePushInstallation(owner, NativePushBinding(state.installationId, revision),
            NativePushInstallationStatus.ACTIVE, true, expiry, key())
        assertTrue(state.recordVerifiedInstallation(row, state.generation, secret))
        return row
    }

    @Test fun originalBodyKeySecretAndAttemptSurviveRestartWithoutReplacingUnknownRequest() {
        val store = MemoryStore(); val state = lifecycle(store)
        assertTrue(state.stageToken(context(state), token1))
        val seed = request(state)
        val original = NativePushRegistrationRequest.fromJson(seed.toJson().put("body", JSONObject(seed.bodyText).toString(2)))
        assertTrue(state.stageRegistration(original))
        assertFalse(state.registrationAttempted())
        assertTrue(state.markRegistrationAttempt(original))
        assertTrue(state.stageRegistration(original))
        assertFalse(state.stageRegistration(request(state, token = token2)))
        val restored = NativePushLifecycle(store) { now }
        assertEquals(state.installationId, restored.installationId)
        assertTrue(original.same(restored.pendingRegistration()!!))
        assertEquals(original.bodyText, restored.pendingRegistration()!!.bodyText)
        assertEquals(original.revocationSecret, restored.pendingRegistration()!!.revocationSecret)
        assertTrue(restored.registrationAttempted())
        assertTrue(restored.queuedToken()!!.same(token1))
        assertFalse(original.toString().contains(original.token))
        assertFalse(original.toString().contains(original.revocationSecret))
        assertFalse(restored.remoteEnabled)
        assertThrows(NativePushUnsupportedException::class.java) { restored.registerAndroid() }
        assertThrows(NativePushUnsupportedException::class.java) { restored.rotateAndroidToken() }
    }

    @Test fun currentOwnerGenerationInstallationRevisionAndQueuedTokenMustMatchBeforeStaging() {
        val state = lifecycle(); attach(state, revision = 4)
        assertTrue(state.stageToken(context(state), token1))
        for (bad in listOf(request(state, actor = other), request(state, generation = state.generation - 1),
            request(state, installationId = UUID.randomUUID().toString()), request(state, revision = 3),
            request(state, token = token2))) {
            assertFalse(state.stageRegistration(bad)); assertNull(state.pendingRegistration())
        }
        // A fresh server GET can legitimately be ahead of the local confirmed cache.
        val original = request(state, revision = 7)
        assertTrue(state.stageRegistration(original))
        assertTrue(state.acceptRegistration(original, receipt(original)))
        assertEquals(8L, state.currentBinding!!.revision)
        val newInstall = lifecycle()
        assertTrue(newInstall.stageRegistration(request(newInstall, revision = 12)))
    }

    @Test fun onlyExactOriginalActiveUnexpiredReceiptConfirmsAndOrdinaryGetCannotBypassPending() {
        val store = MemoryStore(); val state = lifecycle(store)
        val original = request(state); assertTrue(state.stageRegistration(original))
        val valid = receipt(original)
        val wrongRows = listOf(valid.copy(owner = other), valid.copy(binding = valid.binding.copy(revision = 2)),
            valid.copy(binding = NativePushBinding(UUID.randomUUID().toString(), 1)), valid.copy(lastRequestKey = key()),
            valid.copy(boundToCurrentSession = false), valid.copy(expiresAt = now),
            valid.copy(status = NativePushInstallationStatus.REVOKED), valid.copy(status = NativePushInstallationStatus.INVALID_TOKEN),
            valid.copy(status = NativePushInstallationStatus.EXPIRED))
        for (bad in wrongRows) {
            assertFalse(state.acceptRegistration(original, bad))
            assertTrue(original.same(NativePushLifecycle(store) { now }.pendingRegistration()!!))
        }
        assertFalse(state.acceptRegistration(request(state), valid))
        assertFalse(state.rejectRegistration(request(state)))
        assertFalse(state.recordVerifiedInstallation(valid, state.generation, original.revocationSecret))
        assertFalse(state.recordVerifiedInstallation(valid.copy(lastRequestKey = key()), state.generation))
        assertNull(state.currentBinding)
        assertTrue(state.acceptRegistration(original, valid))
        assertNull(state.pendingRegistration()); assertFalse(state.registrationAttempted())
        assertEquals(valid.binding, NativePushLifecycle(store) { now }.currentBinding)
        assertFalse(state.acceptRegistration(original, valid))
    }

    @Test fun newerSdkTokenQueuesAcrossUnknownReplyAndSameConfirmedTokenDoesNotQueueAnotherRevision() {
        val store = MemoryStore(); val state = lifecycle(store)
        assertTrue(state.stageToken(context(state), token1))
        val first = request(state); assertTrue(state.stageRegistration(first)); assertTrue(state.markRegistrationAttempt(first))
        assertTrue(state.stageToken(context(state), token2))
        assertTrue(first.same(state.pendingRegistration()!!))
        var restored = NativePushLifecycle(store) { now }
        assertTrue(restored.queuedToken()!!.same(token2))
        assertTrue(restored.acceptRegistration(first, receipt(first)))
        assertTrue(restored.queuedToken()!!.same(token2))
        val second = request(restored, token = token2, secret = secret(71))
        assertTrue(restored.stageRegistration(second)); assertTrue(restored.acceptRegistration(second, receipt(second)))
        restored = NativePushLifecycle(store) { now }
        assertTrue(restored.stageToken(context(restored), token2))
        assertNull(restored.queuedToken()); assertNull(restored.pendingRegistration())
        assertEquals(2L, restored.currentBinding!!.revision)
        assertTrue(restored.stageToken(context(restored), token1))
        assertNotNull(restored.queuedToken())
        assertTrue(restored.stageToken(context(restored), token2))
        assertNull(restored.queuedToken())
        assertFalse(restored.acceptRegistration(first, receipt(first)))
        assertTrue(restored.stageToken(context(restored), token1))
        val third = request(restored, token = token1, secret = secret(72))
        assertTrue(restored.stageRegistration(third))
        // A callback reverting to the old registered token while another request is
        // uncertain is a real latest value, not a duplicate that may be discarded.
        assertTrue(restored.stageToken(context(restored), token2))
        assertTrue(restored.queuedToken()!!.same(token2))
        assertTrue(third.same(restored.pendingRegistration()!!))
    }

    @Test fun rejectionKeepsLatestTokenButOnlyExactRequestCanClearAndFutureAttemptStartsFresh() {
        val state = lifecycle(); state.stageToken(context(state), token1)
        val original = request(state); assertTrue(state.stageRegistration(original))
        assertTrue(state.markRegistrationAttempt(original))
        state.stageToken(context(state), token2)
        assertFalse(state.rejectRegistration(request(state, token = token2)))
        // This invocation represents an independently proven not_committed refusal, not a timeout.
        assertTrue(state.rejectRegistration(original))
        assertFalse(state.registrationAttempted()); assertTrue(state.queuedToken()!!.same(token2))
        val next = request(state, token = token2, secret = secret(71))
        assertTrue(state.stageRegistration(next)); assertFalse(state.registrationAttempted())
        assertFalse(state.markRegistrationAttempt(original))
    }

    @Test fun terminalOrDifferentVerifiedBindingInvalidatesConfirmedTokenDeduplication() {
        for (replaceRevision in listOf(false, true)) {
            val store = MemoryStore(); val state = lifecycle(store)
            state.stageToken(context(state), token1)
            val original = request(state); state.stageRegistration(original)
            assertTrue(state.acceptRegistration(original, receipt(original)))
            val changed = if (replaceRevision) receipt(original).copy(binding = original.targetBinding.copy(revision = 2))
                else receipt(original).copy(status = NativePushInstallationStatus.REVOKED)
            assertTrue(state.recordVerifiedInstallation(changed, state.generation))
            val restored = NativePushLifecycle(store) { now }
            assertTrue(restored.stageToken(context(restored), token1))
            assertTrue(restored.queuedToken()!!.same(token1))
        }
    }

    @Test fun logoutRetiresConfirmedAndUnknownTargetsAndAbaLateCallbacksCannotRestoreThem() {
        val store = MemoryStore(); val state = lifecycle(store)
        val active = attach(state)
        val oldContext = context(state)
        val callback = state.captureCallbackContext()!!
        val original = request(state); assertTrue(state.stageRegistration(original)); state.markRegistrationAttempt(original)
        state.stageToken(oldContext, token2)
        state.disable()
        val slots = NativePushLifecycle(store) { now }.pendingRevocations()
        assertEquals(setOf(active.binding, original.targetBinding), slots.map { it.request.binding }.toSet())
        assertEquals(original.revocationSecret, slots.single { it.request.binding == original.targetBinding }.capability!!.revocationSecret)
        assertNull(state.pendingRegistration()); assertNull(state.queuedToken()); assertFalse(state.registrationAttempted())
        state.reconcileOwner(other); state.reconcileOwner(owner)
        assertFalse(state.stageToken(oldContext, token1))
        assertFalse(state.acceptRegistration(original, receipt(original)))
        assertFalse(state.stageRegistration(original))
        assertNull(state.stageCallback(callback.owner, callback.binding, delivery, NativePushObservationKind.OPENED, callback.generation))
        val newer = attach(state, revision = 3, secret = secret(3))
        assertTrue(state.acceptCapability(slots.single { it.request.binding == original.targetBinding }, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
        assertEquals(newer.binding, state.currentBinding)
        assertEquals(1, state.pendingRevocationCount)
    }

    @Test fun storageFailureBeforeSendAfterReceiptAndDuringLogoutNeverDiscardsOriginalRecovery() {
        val store = MemoryStore(); val state = lifecycle(store)
        attach(state); val original = request(state)
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { state.stageRegistration(original) }
        assertNull(state.pendingRegistration())
        store.failWrites = false; assertTrue(state.stageRegistration(original))
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { state.markRegistrationAttempt(original) }
        assertFalse(state.registrationAttempted())
        assertThrows(IllegalStateException::class.java) { state.acceptRegistration(original, receipt(original)) }
        assertTrue(original.same(NativePushLifecycle(store) { now }.pendingRegistration()!!))
        assertThrows(IllegalStateException::class.java) { state.disable() }
        assertNull(state.owner); assertNull(state.currentBinding); assertNull(state.pendingRemoteOpen)
        assertThrows(IllegalStateException::class.java) { state.pendingRegistration() }
        assertThrows(IllegalStateException::class.java) { state.pendingRevocations() }
        store.failWrites = false; state.reconcileOwner(null)
        val restored = NativePushLifecycle(store) { now }
        assertNull(restored.pendingRegistration()); assertNull(restored.queuedToken())
        assertEquals(2, restored.pendingRevocationCount)
        assertEquals(original.revocationSecret, restored.pendingRevocations().single { it.request.binding == original.targetBinding }.capability!!.revocationSecret)
    }

    @Test fun writeSucceededButReadbackFailedStillRecoversAttemptedOriginalAfterRestart() {
        val store = MemoryStore(); val state = lifecycle(store)
        val original = request(state); state.stageRegistration(original)
        store.failAfterWrite = true
        assertThrows(IllegalStateException::class.java) { state.markRegistrationAttempt(original) }
        val restored = NativePushLifecycle(store) { now }
        assertTrue(restored.registrationAttempted())
        assertTrue(original.same(restored.pendingRegistration()!!))
        store.failAfterWrite = false
        assertTrue(restored.markRegistrationAttempt(original))
        assertTrue(restored.acceptRegistration(original, receipt(original)))
        assertNull(restored.pendingRegistration())
    }

    @Test fun rotationReservesTwoRevocationSlotsAndFullQueueNeverBlocksLogout() {
        for (queuedCount in listOf(30, 31)) {
            val store = MemoryStore(); val state = lifecycle(store)
            repeat(queuedCount) { index -> attach(state, index + 1L, secret(index + 1)); state.disable() }
            attach(state, queuedCount + 1L, secret(queuedCount + 1))
            val original = request(state)
            if (queuedCount == 30) assertTrue(state.stageRegistration(original)) else {
                assertThrows(IllegalStateException::class.java) { state.stageRegistration(original) }
                assertNull(state.pendingRegistration())
            }
            state.disable()
            assertNull(state.owner); assertNull(state.currentBinding)
            assertEquals(32, NativePushLifecycle(store) { now }.pendingRevocationCount)
        }
    }

    @Test fun v1UpgradePreservesBindingOpenObservationAndCorruptV2NeverResetsInstallation() {
        val store = MemoryStore(); val state = lifecycle(store)
        val active = attach(state)
        val observation = state.stageCallback(owner, active.binding, delivery, NativePushObservationKind.OPENED, state.generation)!!
        store.value = JSONObject(store.value!!).apply {
            put("version", 1); remove("pendingRegistration"); remove("queuedToken"); remove("registrationAttempted"); remove("registeredToken"); remove("consumedOpens")
        }.toString()
        val restored = NativePushLifecycle(store) { now }
        assertEquals(state.installationId, restored.installationId); assertEquals(active.binding, restored.currentBinding)
        assertEquals(observation.requestKey, restored.pendingRemoteOpen!!.requestKey)
        assertEquals(listOf(observation), restored.pendingObservations())
        assertNull(restored.pendingRegistration()); assertNull(restored.queuedToken()); assertFalse(restored.registrationAttempted())
        restored.stageToken(context(restored), token1)
        assertEquals(2, JSONObject(store.value!!).getInt("version"))
        val original = request(restored); restored.stageRegistration(original)
        val valid = store.value!!
        val corrupted = listOf(
            JSONObject(valid).apply { getJSONObject("pendingRegistration").put("generation", restored.generation + 1) }.toString(),
            JSONObject(valid).apply { getJSONObject("pendingRegistration").put("employeeId", other.employeeId) }.toString(),
            JSONObject(valid).apply { getJSONObject("pendingRegistration").put("body", "{\"token\":\"${original.token}\"") }.toString(),
            JSONObject(valid).put("registrationAttempted", "true").toString(),
            JSONObject(valid).put("pendingRegistration", JSONObject.NULL).put("registrationAttempted", true).toString(),
        )
        for (raw in corrupted) {
            val broken = MemoryStore(raw)
            val error = assertThrows(IllegalStateException::class.java) { NativePushLifecycle(broken) { now } }
            assertEquals(raw, broken.value); assertEquals(0, broken.writes)
            assertFalse(error.toString().contains(original.token)); assertNull(error.cause)
        }
    }

    @Test fun openedCallbackPersistsExactlyOneObservationAndOpenTogetherWithOriginalKey() {
        val store = MemoryStore(); val state = lifecycle(store)
        val active = attach(state); val durable = store.value
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) {
            state.stageCallback(owner, active.binding, delivery, NativePushObservationKind.OPENED, state.generation)
        }
        assertEquals(durable, store.value); assertNull(state.pendingRemoteOpen); assertEquals(1, state.pendingObservationCount)
        store.failWrites = false
        val first = state.stageCallback(owner, active.binding, delivery, NativePushObservationKind.OPENED, state.generation)!!
        val restored = NativePushLifecycle(store) { now }
        val duplicate = restored.stageCallback(owner, active.binding, delivery, NativePushObservationKind.OPENED, restored.generation)
        assertEquals(first, duplicate); assertEquals(first.requestKey, restored.pendingRemoteOpen!!.requestKey)
        assertEquals(listOf(first), restored.pendingObservations())
        assertTrue(restored.pendingObservations().none { it.kind == NativePushObservationKind.RECEIVED })
        assertNotNull(restored.stageCallback(owner, active.binding, delivery, NativePushObservationKind.RECEIVED, restored.generation))
        assertEquals(2, restored.pendingObservationCount)
        assertEquals(first.requestKey, restored.pendingRemoteOpen!!.requestKey)
    }
}
