package com.mbox.staff

import java.time.Instant
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePushLifecycleTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val nextOwner = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val delivery = "55555555-5555-4555-8555-555555555555"
    private val otherDelivery = "66666666-6666-4666-8666-666666666666"
    private val key = "native-push-77777777-7777-4777-8777-777777777777"
    private val otherKey = "native-push-88888888-8888-4888-8888-888888888888"
    private val expiry = Instant.parse("2099-01-01T00:00:00Z")
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    // Deterministic fixture bytes only. No production key or provider token is created.
    private val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })
    private val otherSecret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { (it + 1).toByte() })

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        var failWrites = false
        var writes = 0
        override fun read() = value
        override fun write(value: String) {
            if (failWrites) throw IllegalStateException("fixture storage unavailable")
            this.value = value; writes++
        }
        override fun remove() { error("Registration recovery must never be erased") }
    }

    private fun installation(lifecycle: NativePushLifecycle, actor: NativePushOwner = owner, revision: Long = 1) =
        NativePushInstallation(actor, NativePushBinding(lifecycle.installationId, revision),
            NativePushInstallationStatus.ACTIVE, true, expiry, key)
    private fun attach(lifecycle: NativePushLifecycle, actor: NativePushOwner = owner, revision: Long = 1, savedSecret: String? = secret): NativePushInstallation {
        lifecycle.reconcileOwner(actor)
        return installation(lifecycle, actor, revision).also {
            assertTrue(lifecycle.recordVerifiedInstallation(it, lifecycle.generation, savedSecret))
        }
    }
    private fun observation(binding: NativePushBinding, requestKey: String = key) =
        NativePushObservationRequest(owner, binding, delivery, NativePushObservationKind.OPENED, requestKey)
    private fun revoked(slot: NativePushRevocationSlot) = NativePushRevokeReceipt(
        NativePushInstallation(slot.request.owner, slot.request.binding, NativePushInstallationStatus.REVOKED,
            true, expiry, slot.request.requestKey), slot.request.requestKey, false)

    @Test fun installationIdentitySurvivesRestartAndAndroidCanNeverBeEnabledOrRegister() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store)
        assertTrue(Regex("^[0-9a-f-]{36}$").matches(lifecycle.installationId))
        assertFalse(lifecycle.remoteEnabled)
        assertNull(lifecycle.owner)
        assertThrows(NativePushUnsupportedException::class.java) { lifecycle.registerAndroid() }
        assertThrows(NativePushUnsupportedException::class.java) { lifecycle.rotateAndroidToken() }
        val restored = NativePushLifecycle(store)
        assertEquals(lifecycle.installationId, restored.installationId)
        // A historical preference is data, never an authority to bypass the v1 provider gate.
        store.value = JSONObject(store.value!!).put("remoteEnabled", true).toString()
        assertFalse(NativePushLifecycle(store).remoteEnabled)
        val json = JSONObject(store.value!!)
        assertEquals(setOf("version", "remoteEnabled", "installationId", "generation", "owner", "binding",
            "revocations", "remoteOpen", "observations", "pendingRegistration", "queuedToken", "registrationAttempted", "registeredToken", "consumedOpens"), json.keys().asSequence().toSet())
        assertFalse(json.has("token")); assertFalse(json.has("cookie")); assertFalse(json.has("pin"))
    }

    @Test fun switchingOwnerClearsOldOpenAndObservationsButPersistsOriginalRevocationForUnknownRetry() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        val original = attach(lifecycle)
        val generation = lifecycle.generation
        val open = lifecycle.stageRemoteOpen(owner, original.binding, delivery, generation)
        assertNotNull(open)
        assertEquals(open, lifecycle.stageRemoteOpen(owner, original.binding, delivery, generation))
        assertNotNull(lifecycle.stageObservation(observation(original.binding), generation))
        lifecycle.reconcileOwner(nextOwner)
        assertEquals(nextOwner, lifecycle.owner); assertNull(lifecycle.currentBinding)
        assertFalse(lifecycle.remoteEnabled); assertNull(lifecycle.pendingRemoteOpen)
        assertEquals(0, lifecycle.pendingObservationCount)
        assertFalse(lifecycle.recordVerifiedInstallation(original, generation, secret))
        assertNull(lifecycle.stageRemoteOpen(owner, original.binding, delivery, generation))
        assertNull(lifecycle.stageObservation(observation(original.binding), generation))
        val slot = lifecycle.pendingRevocations().single()
        val restored = NativePushLifecycle(store).pendingRevocations().single()
        assertEquals(slot.request, restored.request)
        assertEquals("{\"expectedRevision\":1}", restored.request.body)
        assertEquals(slot.capability!!.body, restored.capability!!.body)
        assertEquals(secret, JSONObject(restored.capability!!.body).getString("revocationSecret"))
        assertFalse(slot.toString().contains(secret)); assertFalse(slot.capability.toString().contains(secret))
        assertEquals(1, lifecycle.pendingRevocationCount) // no receipt: no consumption
    }

    @Test fun originalCapabilityAcceptanceOnlyRemovesItsExactSlotAndNeverClearsNewerBinding() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        attach(lifecycle); lifecycle.disable()
        val old = lifecycle.pendingRevocations().single()
        val newer = attach(lifecycle, nextOwner, 2, otherSecret)
        assertFalse(lifecycle.acceptCapability(NativePushRevocationSlot(old.request, otherSecret),
            NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
        assertEquals(1, lifecycle.pendingRevocationCount)
        assertTrue(lifecycle.acceptCapability(old, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
        assertEquals(0, lifecycle.pendingRevocationCount)
        assertEquals(newer.binding, lifecycle.currentBinding); assertEquals(nextOwner, lifecycle.owner)
        assertFalse(lifecycle.remoteEnabled)
        assertFalse(lifecycle.acceptCapability(old, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
        assertEquals(newer.binding, NativePushLifecycle(store).currentBinding)
    }

    @Test fun ordinaryRevokeRequiresOriginalOwnerRevisionKeyAndVerifiedRevokedStatus() {
        val lifecycle = NativePushLifecycle(MemoryStore())
        attach(lifecycle, savedSecret = null); lifecycle.disable()
        val slot = lifecycle.pendingRevocations().single()
        assertNull(slot.capability)
        assertFalse(lifecycle.acceptCapability(slot, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
        val receipt = revoked(slot)
        for (bad in listOf(receipt.copy(requestKey = otherKey),
            receipt.copy(installation = receipt.installation.copy(owner = nextOwner)),
            receipt.copy(installation = receipt.installation.copy(binding = slot.request.binding.copy(revision = 2))),
            receipt.copy(installation = receipt.installation.copy(status = NativePushInstallationStatus.ACTIVE)),
            receipt.copy(installation = receipt.installation.copy(lastRequestKey = otherKey)),
            receipt.copy(installation = receipt.installation.copy(boundToCurrentSession = false)))) {
            assertFalse(lifecycle.acceptRevoke(slot, bad)); assertEquals(1, lifecycle.pendingRevocationCount)
        }
        val newer = attach(lifecycle, nextOwner, 2, otherSecret)
        assertTrue(lifecycle.acceptRevoke(slot, receipt)); assertEquals(newer.binding, lifecycle.currentBinding)
        assertFalse(lifecycle.acceptRevoke(slot, receipt))
    }

    @Test fun observationRetryKeepsOriginalBodyAndKeyAndDoesNotInventAReceivedCallback() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        val row = attach(lifecycle)
        val request = observation(row.binding)
        assertEquals(request, lifecycle.stageObservation(request, lifecycle.generation))
        assertEquals(request, lifecycle.stageObservation(request.copy(requestKey = otherKey), lifecycle.generation))
        assertThrows(IllegalArgumentException::class.java) {
            lifecycle.stageObservation(request.copy(deliveryId = otherDelivery), lifecycle.generation)
        }
        val restored = NativePushLifecycle(store)
        assertEquals(listOf(request), restored.pendingObservations())
        assertEquals("{\"kind\":\"opened\"}", restored.pendingObservations().single().body)
        val receivedOnly = NativePushObservationReceipt(owner, delivery, NativePushObservationKind.OPENED, key, now, null, false)
        assertFalse(restored.acceptObservation(request, receivedOnly))
        assertFalse(restored.acceptObservation(request, receivedOnly.copy(clientReportedOpenedAt = now, requestKey = otherKey)))
        val actualOpened = receivedOnly.copy(clientReportedReceivedAt = null, clientReportedOpenedAt = now)
        assertTrue(restored.acceptObservation(request, actualOpened))
        assertEquals(0, NativePushLifecycle(store).pendingObservationCount)
    }

    @Test fun logoutStorageFailureStopsLocallyAndNeverHandsOffAnUndurableOrInventedReplacementRequest() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        val row = attach(lifecycle)
        lifecycle.stageRemoteOpen(owner, row.binding, delivery, lifecycle.generation)
        lifecycle.stageObservation(observation(row.binding), lifecycle.generation)
        val durableBefore = store.value
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) { lifecycle.disable() }
        assertFalse(lifecycle.remoteEnabled); assertNull(lifecycle.owner); assertNull(lifecycle.currentBinding)
        assertNull(lifecycle.pendingRemoteOpen); assertEquals(0, lifecycle.pendingObservationCount)
        assertEquals(1, lifecycle.pendingRevocationCount)
        assertEquals(durableBefore, store.value)
        assertThrows(IllegalStateException::class.java) { lifecycle.pendingRevocations() }
        store.failWrites = false
        lifecycle.reconcileOwner(null) // retries the original dirty queue, no new key
        val original = lifecycle.pendingRevocations().single()
        assertEquals(original.request, NativePushLifecycle(store).pendingRevocations().single().request)
        store.failWrites = true
        assertThrows(IllegalStateException::class.java) {
            lifecycle.acceptCapability(original, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED)
        }
        assertEquals(1, lifecycle.pendingRevocationCount)
        assertEquals(original.request, NativePushLifecycle(store).pendingRevocations().single().request)
        store.failWrites = false
        assertTrue(lifecycle.acceptCapability(original, NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED))
    }

    @Test fun newerBindingInvalidatesOldPendingReferencesAndRejectsLowerRevisionOrUnboundRecords() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        val row = attach(lifecycle)
        val open = lifecycle.stageRemoteOpen(owner, row.binding, delivery, lifecycle.generation)!!
        val pending = observation(row.binding)
        lifecycle.stageObservation(pending, lifecycle.generation)
        val newer = installation(lifecycle, revision = 2)
        assertTrue(lifecycle.recordVerifiedInstallation(newer, lifecycle.generation, otherSecret))
        assertNull(lifecycle.pendingRemoteOpen); assertEquals(0, lifecycle.pendingObservationCount)
        assertFalse(lifecycle.clearRemoteOpen(open))
        assertFalse(lifecycle.recordVerifiedInstallation(row, lifecycle.generation, secret))
        assertThrows(IllegalArgumentException::class.java) {
            lifecycle.recordVerifiedInstallation(newer.copy(boundToCurrentSession = false), lifecycle.generation)
        }
        assertThrows(IllegalArgumentException::class.java) {
            lifecycle.recordVerifiedInstallation(newer.copy(lastRequestKey = null), lifecycle.generation)
        }
        assertEquals(newer.binding, NativePushLifecycle(store).currentBinding)
    }

    @Test fun everyTerminalStatusClearsPendingReferencesAndCannotBeReactivatedByAnOldSameRevisionReply() {
        for (terminal in listOf(NativePushInstallationStatus.REVOKED, NativePushInstallationStatus.INVALID_TOKEN,
            NativePushInstallationStatus.EXPIRED)) {
            val store = MemoryStore(); val lifecycle = NativePushLifecycle(store) { now }
            val active = attach(lifecycle)
            lifecycle.stageRemoteOpen(owner, active.binding, delivery, lifecycle.generation)
            lifecycle.stageObservation(observation(active.binding), lifecycle.generation)
            assertTrue(lifecycle.recordVerifiedInstallation(active.copy(status = terminal), lifecycle.generation))
            assertNull(lifecycle.pendingRemoteOpen); assertEquals(0, lifecycle.pendingObservationCount)
            assertTrue(lifecycle.pendingObservations().isEmpty())
            assertNull(lifecycle.stageRemoteOpen(owner, active.binding, delivery, lifecycle.generation))
            assertNull(lifecycle.stageObservation(observation(active.binding), lifecycle.generation))
            assertFalse(lifecycle.recordVerifiedInstallation(active, lifecycle.generation, secret))
            val restored = NativePushLifecycle(store) { now }
            assertFalse(restored.recordVerifiedInstallation(active, restored.generation))
            assertNull(restored.stageRemoteOpen(owner, active.binding, delivery, restored.generation))
            assertFalse(restored.remoteEnabled)
            val newer = active.copy(binding = active.binding.copy(revision = 2))
            assertTrue(restored.recordVerifiedInstallation(newer, restored.generation, otherSecret))
            assertNotNull(restored.stageRemoteOpen(owner, newer.binding, delivery, restored.generation))
            assertNotNull(restored.stageObservation(observation(newer.binding), restored.generation))
        }
    }

    @Test fun expiryBoundaryBlocksNewReferencesAndHidesPreviouslyStagedReferencesUntilRevalidated() {
        var clock = now
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store) { clock }
        lifecycle.reconcileOwner(owner)
        val active = installation(lifecycle).copy(expiresAt = now.plusSeconds(10))
        assertTrue(lifecycle.recordVerifiedInstallation(active, lifecycle.generation, secret))
        assertNotNull(lifecycle.stageRemoteOpen(owner, active.binding, delivery, lifecycle.generation))
        assertNotNull(lifecycle.stageObservation(observation(active.binding), lifecycle.generation))
        clock = active.expiresAt
        assertNull(lifecycle.stageRemoteOpen(owner, active.binding, otherDelivery, lifecycle.generation))
        assertNull(lifecycle.stageObservation(observation(active.binding, otherKey), lifecycle.generation))
        assertNull(lifecycle.pendingRemoteOpen); assertTrue(lifecycle.pendingObservations().isEmpty())
        val restored = NativePushLifecycle(store) { clock }
        assertNull(restored.pendingRemoteOpen); assertTrue(restored.pendingObservations().isEmpty())
        // Even if a GET still labels an elapsed record active, it cannot preserve its old references.
        assertTrue(restored.recordVerifiedInstallation(active, restored.generation))
        assertEquals(0, restored.pendingObservationCount)
        assertTrue(JSONObject(store.value!!).isNull("remoteOpen"))
        assertEquals(0, JSONObject(store.value!!).getJSONArray("observations").length())
    }

    @Test fun aNewRevisionNeverInheritsThePreviousRevisionRevocationSecret() {
        val lifecycle = NativePushLifecycle(MemoryStore()) { now }
        val active = attach(lifecycle)
        lifecycle.disable()
        val original = lifecycle.pendingRevocations().single()
        lifecycle.reconcileOwner(owner)
        val newer = active.copy(binding = active.binding.copy(revision = 2))
        assertTrue(lifecycle.recordVerifiedInstallation(newer, lifecycle.generation))
        lifecycle.disable()
        val slots = lifecycle.pendingRevocations()
        assertEquals(2, slots.size)
        assertEquals(original.capability!!.body, slots.single { it.request.binding.revision == 1L }.capability!!.body)
        assertNull(slots.single { it.request.binding.revision == 2L }.capability)
        val directReplacement = NativePushLifecycle(MemoryStore()) { now }
        val previous = attach(directReplacement)
        assertTrue(directReplacement.recordVerifiedInstallation(previous.copy(binding = previous.binding.copy(revision = 2)), directReplacement.generation))
        directReplacement.disable()
        assertNull(directReplacement.pendingRevocations().single().capability)
    }

    @Test fun corruptedOrTypeCoercedRecoveryIsRejectedWithoutErasingOriginalOrLeakingItsText() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        attach(lifecycle); lifecycle.disable()
        val valid = store.value!!
        val badRecords = listOf(
            "{\"secret\":\"$secret", // raw parser error must not include this source
            JSONObject(valid).put("version", "1").toString(),
            JSONObject(valid).put("remoteEnabled", "false").toString(),
            JSONObject(valid).put("generation", 1.5).toString(),
            JSONObject(valid).put("token", "unexpected").toString(),
            JSONObject(valid).apply { remove("owner") }.toString(),
            JSONObject(valid).apply { getJSONArray("revocations").getJSONObject(0).put("body", "{\"expectedRevision\":2}") }.toString(),
            JSONObject(valid).apply { getJSONArray("revocations").getJSONObject(0).put("secret", 123) }.toString(),
        )
        for (raw in badRecords) {
            val broken = MemoryStore(raw)
            val error = assertThrows(IllegalStateException::class.java) { NativePushLifecycle(broken) }
            assertEquals(raw, broken.value); assertEquals(0, broken.writes)
            assertFalse(error.toString().contains(secret)); assertNull(error.cause)
        }
    }

    @Test fun boundedPendingQueueReservesRoomForLogoutAndDoesNotDiscardPriorRevocations() {
        val store = MemoryStore(); val lifecycle = NativePushLifecycle(store)
        repeat(32) { index -> attach(lifecycle, revision = index.toLong() + 1); lifecycle.disable() }
        assertEquals(32, lifecycle.pendingRevocationCount)
        lifecycle.reconcileOwner(owner)
        assertThrows(IllegalStateException::class.java) {
            lifecycle.recordVerifiedInstallation(installation(lifecycle, revision = 33), lifecycle.generation, secret)
        }
        lifecycle.disable()
        assertNull(lifecycle.currentBinding); assertNull(lifecycle.owner)
        assertEquals(32, NativePushLifecycle(store).pendingRevocationCount)
    }
}
