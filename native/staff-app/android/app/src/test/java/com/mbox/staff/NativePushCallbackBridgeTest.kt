package com.mbox.staff

import java.time.Instant
import java.util.concurrent.CancellationException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePushCallbackBridgeTest {
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val otherOwner = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val delivery = "55555555-5555-4555-8555-555555555555"
    private val otherDelivery = "66666666-6666-4666-8666-666666666666"
    private val key = "native-push-77777777-7777-4777-8777-777777777777"
    private val now = Instant.parse("2026-10-05T12:00:00Z")

    private class MemoryStore(var value: String? = null) : NotificationStateStore {
        val saved = mutableListOf<String>()
        var writeError: Exception? = null
        override fun read() = value
        override fun write(value: String) {
            writeError?.let { throw it }
            this.value = value
            saved += value
        }
        override fun remove() { error("Callback recovery must not erase registration state") }
    }

    private fun payload(id: String = delivery) = JSONObject()
        .put("protocol", 1).put("kind", "service_task").put("deliveryId", id)

    private fun attach(lifecycle: NativePushLifecycle, actor: NativePushOwner = owner, revision: Long = 1): NativePushInstallation {
        lifecycle.reconcileOwner(actor)
        return NativePushInstallation(actor, NativePushBinding(lifecycle.installationId, revision),
            NativePushInstallationStatus.ACTIVE, true, now.plusSeconds(300), key).also {
            assertTrue(lifecycle.recordVerifiedInstallation(it, lifecycle.generation))
        }
    }

    @Test fun captureRequiresVerifiedActiveUnexpiredBindingAndUsesOneCurrentOwnerGeneration() {
        var clock = now
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { clock }
        val bridge = NativePushCallbackBridge(lifecycle)
        assertNull(bridge.captureContext())
        lifecycle.reconcileOwner(owner)
        assertNull(bridge.captureContext())
        val row = attach(lifecycle)
        val context = bridge.captureContext()!!
        assertEquals(owner, context.owner)
        assertEquals(row.binding, context.binding)
        assertEquals(lifecycle.generation, context.generation)
        clock = row.expiresAt
        assertNull(bridge.captureContext())
        val before = store.value
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onOpened(context, payload()))
        assertEquals(before, store.value)
        assertFalse(lifecycle.remoteEnabled)
    }

    @Test fun allTerminalInstallationStatesBlockCapturedAndNewCallbacks() {
        for (status in listOf(NativePushInstallationStatus.REVOKED, NativePushInstallationStatus.INVALID_TOKEN,
            NativePushInstallationStatus.EXPIRED)) {
            val store = MemoryStore()
            val lifecycle = NativePushLifecycle(store) { now }
            val row = attach(lifecycle)
            val bridge = NativePushCallbackBridge(lifecycle)
            val context = bridge.captureContext()!!
            assertTrue(lifecycle.recordVerifiedInstallation(row.copy(status = status), lifecycle.generation))
            assertNull(bridge.captureContext())
            val before = store.value
            assertEquals(NativePushCallbackOutcome.STALE, bridge.onReceived(context, payload()))
            assertEquals(NativePushCallbackOutcome.STALE, bridge.onOpened(context, payload()))
            assertEquals(before, store.value)
        }
    }

    @Test fun receivedPersistsOriginalObservationAcrossRestartWithoutCreatingAnOpen() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onReceived(context, payload()))
        val request = lifecycle.pendingObservations().single()
        assertEquals(owner, request.owner)
        assertEquals(context.binding, request.binding)
        assertEquals(delivery, request.deliveryId)
        assertEquals(NativePushObservationKind.RECEIVED, request.kind)
        assertNull(lifecycle.pendingRemoteOpen)
        val restored = NativePushLifecycle(store) { now }
        val restartedBridge = NativePushCallbackBridge(restored)
        assertEquals(NativePushCallbackOutcome.STAGED, restartedBridge.onReceived(context, payload()))
        assertEquals(listOf(request), restored.pendingObservations())
        assertNull(restored.pendingRemoteOpen)
        assertFalse(restored.remoteEnabled)
    }

    @Test fun openedAtomicallySavesOneOriginalObservationAndOpenAndNeverSynthesizesReceived() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        val writesBefore = store.saved.size
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onOpened(context, payload()))
        assertEquals(writesBefore + 1, store.saved.size)
        val original = lifecycle.pendingObservations().single()
        val open = lifecycle.pendingRemoteOpen!!
        assertEquals(NativePushObservationKind.OPENED, original.kind)
        assertEquals(original.owner, open.owner)
        assertEquals(original.binding, open.binding)
        assertEquals(original.deliveryId, open.deliveryId)
        assertEquals(original.requestKey, open.requestKey)
        val saved = JSONObject(store.saved.last())
        assertEquals(original.requestKey, saved.getJSONObject("remoteOpen").getString("requestKey"))
        assertEquals(1, saved.getJSONArray("observations").length())
        val restored = NativePushLifecycle(store) { now }
        assertEquals(NativePushCallbackOutcome.STAGED, NativePushCallbackBridge(restored).onOpened(context, payload()))
        assertEquals(open, restored.pendingRemoteOpen)
        assertEquals(listOf(original), restored.pendingObservations())
        assertFalse(restored.remoteEnabled)
    }

    @Test fun receivedAndOpenedRemainIndependentAndNewOpenDoesNotEraseEarlierReport() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onReceived(context, payload()))
        val received = lifecycle.pendingObservations().single()
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onOpened(context, payload()))
        val firstOpened = lifecycle.pendingObservations().single { it.kind == NativePushObservationKind.OPENED }
        assertNotEquals(received.requestKey, firstOpened.requestKey)
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onOpened(context, payload(otherDelivery)))
        assertEquals(otherDelivery, lifecycle.pendingRemoteOpen!!.deliveryId)
        assertTrue(lifecycle.pendingObservations().contains(received))
        assertTrue(lifecycle.pendingObservations().contains(firstOpened))
        assertEquals(3, lifecycle.pendingObservationCount)
    }

    @Test fun malformedPayloadAndUntrustedIdentityOrDestinationFieldsNeverStageAnything() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        val malformed = mutableListOf(
            payload().put("protocol", "1"), payload().put("protocol", 1.0), payload().put("kind", "open_url"),
            payload().put("deliveryId", 123), payload().put("deliveryId", "https://untrusted.example/"),
            payload().apply { remove("deliveryId") }, JSONObject().put("mbox", payload()),
        )
        for (field in listOf("employeeId", "staffSessionId", "taskId", "tableSessionId", "token", "secret", "url"))
            malformed += payload().put(field, "untrusted")
        val before = store.value
        val writesBefore = store.saved.size
        for (mbox in malformed) {
            assertEquals(NativePushCallbackOutcome.INVALID, bridge.onReceived(context, mbox))
            assertEquals(NativePushCallbackOutcome.INVALID, bridge.onOpened(context, mbox))
        }
        assertEquals(before, store.value)
        assertEquals(writesBefore, store.saved.size)
        assertNull(lifecycle.pendingRemoteOpen)
        assertEquals(0, lifecycle.pendingObservationCount)
    }

    @Test fun lateCallbackCannotMoveToAnotherEmployeeOrReturnThroughSameOwnerAba() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        val original = attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        lifecycle.reconcileOwner(otherOwner)
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onOpened(context, payload()))
        lifecycle.reconcileOwner(owner)
        assertTrue(lifecycle.recordVerifiedInstallation(original, lifecycle.generation))
        val current = bridge.captureContext()!!
        assertEquals(context.owner, current.owner)
        assertEquals(context.binding, current.binding)
        assertNotEquals(context.generation, current.generation)
        val before = store.value
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onReceived(context, payload()))
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onOpened(context, payload()))
        assertEquals(before, store.value)
        assertNull(lifecycle.pendingRemoteOpen)
    }

    @Test fun oldInstallationRevisionIsRejectedEvenWhenLoginAndGenerationAreUnchanged() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        val original = attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val old = bridge.captureContext()!!
        assertTrue(lifecycle.recordVerifiedInstallation(original.copy(binding = original.binding.copy(revision = 2)), lifecycle.generation))
        val current = bridge.captureContext()!!
        assertEquals(old.generation, current.generation)
        assertNotEquals(old.binding, current.binding)
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onReceived(old, payload()))
        assertEquals(NativePushCallbackOutcome.STALE, bridge.onOpened(old, payload()))
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onOpened(current, payload()))
        assertEquals(current.binding, lifecycle.pendingRemoteOpen!!.binding)
    }

    @Test fun failedOpenedSaveNeverAcknowledgesOrPartiallyPersistsCallbackAndRetryIsDurable() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val bridge = NativePushCallbackBridge(lifecycle)
        val context = bridge.captureContext()!!
        val before = store.value
        store.writeError = IllegalStateException("fixture storage unavailable")
        assertEquals(NativePushCallbackOutcome.STORAGE_UNAVAILABLE, bridge.onOpened(context, payload()))
        assertEquals(before, store.value)
        val durable = NativePushLifecycle(MemoryStore(store.value)) { now }
        assertNull(durable.pendingRemoteOpen)
        assertEquals(0, durable.pendingObservationCount)
        store.writeError = null
        assertEquals(NativePushCallbackOutcome.STAGED, bridge.onOpened(context, payload()))
        val restored = NativePushLifecycle(store) { now }
        assertEquals(restored.pendingObservations().single().requestKey, restored.pendingRemoteOpen!!.requestKey)
        assertEquals(NativePushObservationKind.OPENED, restored.pendingObservations().single().kind)
    }

    @Test fun interruptedCallbackSaveIsNotReportedAsAnOrdinaryStorageProblem() {
        for (error in listOf(CancellationException("cancelled fixture"), InterruptedException("interrupted fixture"))) {
            val store = MemoryStore()
            val lifecycle = NativePushLifecycle(store) { now }
            attach(lifecycle)
            val bridge = NativePushCallbackBridge(lifecycle)
            val context = bridge.captureContext()!!
            store.writeError = error
            val actual = assertThrows(error.javaClass) { bridge.onOpened(context, payload()) }
            assertSame(error, actual)
        }
    }

    @Test fun absentProviderCoordinatorNeverRegistersOrSavesAnSdkToken() {
        val store = MemoryStore()
        val lifecycle = NativePushLifecycle(store) { now }
        attach(lifecycle)
        val before = store.value
        val token = NativePushSdkToken("fixture-contract", "fixture-provider", "fixture-token-do-not-log")
        val bridge = NativePushCallbackBridge(lifecycle)
        assertEquals(NativePushRegistrationOutcome.UNSUPPORTED,
            bridge.onTokenAvailable(NativePushTokenContext(owner, lifecycle.generation), token))
        assertEquals(before, store.value)
        assertFalse(store.value!!.contains(token.value))
        assertFalse(token.toString().contains(token.value))
        assertFalse(lifecycle.remoteEnabled)
    }
}
