package com.mbox.staff

import java.io.IOException
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Exercise the actual persistence codec, without replacing it with a test serializer. */
class NotificationRecoveryPersistenceTest {
    private class MemoryStore : NotificationStateStore {
        var value: String? = null
        var failWrites = false
        var failReads = false
        override fun read(): String? {
            if (failReads) throw IOException("storage locked")
            return value
        }
        override fun write(value: String) {
            if (failWrites) throw IOException("storage full")
            this.value = value
        }
        override fun remove() { value = null }
    }

    private val now = Instant.parse("2026-10-05T04:00:00Z")
    private val actor = NotificationTaskIdentity("employee-one", "session-one", "access-revision", true)
    private val target = NotificationTaskTarget("notification-one", actor.employeeId, actor.staffSessionId,
        "task-one", "table-session-one", now.minusSeconds(20), now.plusSeconds(3600))
    private val task = NotificationTaskFact(target.taskId, target.tableSessionId, "pending", true)

    private fun snapshot(start: Long = 1, finish: Long = 2, fact: NotificationTaskFact = task) =
        AuthorizedNotificationTaskSnapshot(actor, now.plusSeconds(start), now.plusSeconds(finish), listOf(fact), true)

    private fun pending(store: MemoryStore): NotificationTaskRecovery {
        val codec = NotificationRecoveryPersistence(store)
        val state = codec.read().offer(target, actor, now).recovery
        codec.write(state)
        return state
    }

    private fun focused(store: MemoryStore): NotificationTaskRecovery =
        pending(store).resolve(actor, snapshot(), now.plusSeconds(3)).also {
            assertTrue(it.decision is NotificationTaskDecision.Focus)
            NotificationRecoveryPersistence(store).write(it.recovery)
        }.recovery

    @Test fun coldStartRestoresPendingButNeverPersistedFocusAuthority() {
        val store = MemoryStore()
        val focus = focused(store)
        val json = JSONObject(store.value!!)
        assertEquals(setOf("version", "pending", "consumed"), json.keys().asSequence().toSet())
        assertEquals(setOf("target", "requestedAt"), json.getJSONObject("pending").keys().asSequence().toSet())
        assertEquals(setOf("notificationId", "employeeId", "staffSessionId", "taskId", "tableSessionId", "issuedAt", "expiresAt"),
            json.getJSONObject("pending").getJSONObject("target").keys().asSequence().toSet())
        assertFalse(store.value!!.contains(actor.accessRevision))
        assertEquals(0, json.getJSONArray("consumed").length())

        val restarted = NotificationRecoveryPersistence(store).read()
        assertEquals(focus.pending, restarted.pending)
        assertTrue(restarted.consumed.isEmpty())
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT),
            restarted.acknowledgeOpened(actor, now.plusSeconds(4)).decision)
        val retried = restarted.retry(actor, now.plusSeconds(5)).recovery
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT),
            retried.resolve(actor, snapshot(), now.plusSeconds(6)).decision)
        assertTrue(retried.resolve(actor, snapshot(6, 7), now.plusSeconds(8)).decision is NotificationTaskDecision.Focus)
    }

    @Test fun acknowledgedNavigationRemainsDuplicateAfterProcessRestart() {
        val store = MemoryStore()
        val opened = focused(store).acknowledgeOpened(actor, now.plusSeconds(4))
        assertEquals(NotificationTaskDecision.Opened, opened.decision)
        NotificationRecoveryPersistence(store).write(opened.recovery)
        val restarted = NotificationRecoveryPersistence(store).read()
        assertNull(restarted.pending)
        assertEquals(listOf(ConsumedNotificationTask(target, now.plusSeconds(4))), restarted.consumed)
        assertEquals(NotificationTaskDecision.Duplicate, restarted.offer(target, actor, now.plusSeconds(5)).decision)
        assertEquals("pending", task.status) // A navigation receipt does not complete the business task.
    }

    @Test fun persistedReferencesStillRequireCurrentTimeEmployeeSessionAccessAndOriginalTable() {
        val store = MemoryStore()
        pending(store)
        fun restored() = NotificationRecoveryPersistence(store).read()
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.EXPIRED),
            restored().retry(actor, target.expiresAt).decision)
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.WRONG_EMPLOYEE),
            restored().retry(actor.copy(employeeId = "other-employee"), now.plusSeconds(1)).decision)
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.WRONG_LOGIN_SESSION),
            restored().retry(actor.copy(staffSessionId = "another-login"), now.plusSeconds(1)).decision)
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.ACCESS_DENIED),
            restored().retry(actor.copy(canReadTasks = false), now.plusSeconds(1)).decision)
        assertEquals(NotificationTaskDecision.LoginRequired, restored().retry(null, now.plusSeconds(1)).decision)
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.WRONG_TABLE_SESSION),
            restored().resolve(actor, snapshot(fact = task.copy(tableSessionId = "reopened-table-session")), now.plusSeconds(3)).decision)
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.ACCESS_DENIED),
            restored().resolve(actor, snapshot(fact = task.copy(authorized = false)), now.plusSeconds(3)).decision)
        assertTrue(restored().consumed.isEmpty())
    }

    @Test fun malformedAndWrongTypeRecordsAreRejectedAndNeverRemoved() {
        val store = MemoryStore()
        pending(store)
        val valid = store.value!!
        val changes: List<(JSONObject) -> Unit> = listOf(
            { it.put("version", "1") },
            { it.put("version", 1.5) },
            { it.remove("pending") },
            { it.remove("consumed") },
            { it.put("pending", JSONArray()) },
            { it.put("consumed", JSONObject()) },
            { it.put("consumed", JSONArray().put("not-a-receipt")) },
            { it.getJSONObject("pending").put("requestedAt", true) },
            { it.getJSONObject("pending").put("requestedAt", "not-an-instant") },
            { it.getJSONObject("pending").getJSONObject("target").put("taskId", 123) },
            { it.getJSONObject("pending").getJSONObject("target").put("employeeId", "x".repeat(257)) },
            { it.getJSONObject("pending").getJSONObject("target").put("expiresAt", target.issuedAt.toString()) },
        )
        for (corrupt in listOf("not-json") + changes.map { change -> JSONObject(valid).also(change).toString() }) {
            store.value = corrupt
            assertThrows(Exception::class.java) { NotificationRecoveryPersistence(store).read() }
            assertEquals(corrupt, store.value)
        }
    }

    @Test fun contradictoryOrOversizedDeduplicationRecordsFailClosed() {
        val store = MemoryStore()
        val opened = focused(store).acknowledgeOpened(actor, now.plusSeconds(4)).recovery
        NotificationRecoveryPersistence(store).write(opened)
        val valid = store.value!!
        val receipt = JSONObject(valid).getJSONArray("consumed").getJSONObject(0)
        store.value = JSONObject(valid).put("consumed", JSONArray().put(receipt).put(receipt)).toString()
        assertThrows(IllegalArgumentException::class.java) { NotificationRecoveryPersistence(store).read() }
        val overLimit = JSONArray()
        for (index in 0..24) overLimit.put(JSONObject(receipt.toString()).apply {
            getJSONObject("target").put("notificationId", "notification-$index")
        })
        store.value = JSONObject(valid).put("consumed", overLimit).toString()
        assertThrows(IllegalArgumentException::class.java) { NotificationRecoveryPersistence(store).read() }
    }

    @Test fun failedConsumptionWriteKeepsPendingAndCannotManufactureDurableAcknowledgement() {
        val store = MemoryStore()
        val focus = focused(store)
        val previous = store.value
        val opened = focus.acknowledgeOpened(actor, now.plusSeconds(4))
        store.failWrites = true
        assertThrows(IOException::class.java) { NotificationRecoveryPersistence(store).write(opened.recovery) }
        assertEquals(previous, store.value)
        val restarted = NotificationRecoveryPersistence(store).read()
        assertEquals(target, restarted.pending!!.target)
        assertTrue(restarted.consumed.isEmpty())
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT),
            restarted.acknowledgeOpened(actor, now.plusSeconds(5)).decision)
        store.failWrites = false
        val fresh = restarted.retry(actor, now.plusSeconds(6)).recovery
            .resolve(actor, snapshot(7, 8), now.plusSeconds(9)).recovery
            .acknowledgeOpened(actor, now.plusSeconds(10))
        NotificationRecoveryPersistence(store).write(fresh.recovery)
        assertEquals(NotificationTaskDecision.Duplicate,
            NotificationRecoveryPersistence(store).read().offer(target, actor, now.plusSeconds(11)).decision)

        val saved = store.value
        store.failReads = true
        assertThrows(IOException::class.java) { NotificationRecoveryPersistence(store).read() }
        assertEquals(saved, store.value)
    }

    @Test fun remoteSuppressionUpgradesV1AndSurvivesConsumptionUntilExplicitlyCleared() {
        val store = MemoryStore()
        val focus = focused(store)
        val marker = "native-push-11111111-1111-4111-8111-111111111111"
        val codec = NotificationRecoveryPersistence(store)
        assertEquals(1, JSONObject(store.value!!).getInt("version"))
        assertNull(codec.suppressedRemoteRequestKey())

        codec.write(focus, marker)
        assertEquals(setOf("version", "pending", "consumed", "suppressedRemoteRequestKey"),
            JSONObject(store.value!!).keys().asSequence().toSet())
        assertEquals(2, JSONObject(store.value!!).getInt("version"))
        assertEquals(marker, NotificationRecoveryPersistence(store).suppressedRemoteRequestKey())
        assertEquals(focus.pending, NotificationRecoveryPersistence(store).read().pending)

        val opened = focus.acknowledgeOpened(actor, now.plusSeconds(4)).recovery
        codec.write(opened) // The normal local consume must preserve suppression in the same record.
        val restarted = NotificationRecoveryPersistence(store)
        assertNull(restarted.read().pending)
        assertEquals(opened.consumed, restarted.read().consumed)
        assertEquals(marker, restarted.suppressedRemoteRequestKey())

        restarted.write(restarted.read(), suppressedRemoteRequestKey = "*")
        restarted.write(restarted.read())
        assertEquals("*", NotificationRecoveryPersistence(store).suppressedRemoteRequestKey())

        restarted.write(restarted.read(), suppressedRemoteRequestKey = null)
        assertEquals(setOf("version", "pending", "consumed"), JSONObject(store.value!!).keys().asSequence().toSet())
        assertEquals(1, JSONObject(store.value!!).getInt("version"))
        assertNull(restarted.suppressedRemoteRequestKey())
        // A conforming v2 reader also accepts an explicit JSON null marker.
        store.value = JSONObject(store.value!!).put("version", 2).put("suppressedRemoteRequestKey", JSONObject.NULL).toString()
        assertNull(NotificationRecoveryPersistence(store).suppressedRemoteRequestKey())
        assertEquals(opened.consumed, NotificationRecoveryPersistence(store).read().consumed)
    }

    @Test fun malformedSuppressionFailsClosedAndFailedWriteKeepsWholePreviousRecord() {
        val store = MemoryStore()
        val state = pending(store)
        val marker = "native-push-11111111-1111-4111-8111-111111111111"
        val codec = NotificationRecoveryPersistence(store)
        codec.write(state, marker)
        val valid = store.value!!
        val corruptions: List<(JSONObject) -> Unit> = listOf(
            { it.remove("suppressedRemoteRequestKey") },
            { it.put("suppressedRemoteRequestKey", 123) },
            { it.put("suppressedRemoteRequestKey", true) },
            { it.put("suppressedRemoteRequestKey", "null") },
            { it.put("suppressedRemoteRequestKey", marker.uppercase()) },
            { it.put("suppressedRemoteRequestKey", marker + "\n") },
            { it.put("version", "2") },
            { it.put("version", 2.5) },
            { it.put("version", 1) },
            { it.put("unexpected", "value") },
            { it.put("consumed", JSONObject()) },
        )
        for (change in corruptions) {
            val corrupt = JSONObject(valid).also(change).toString()
            store.value = corrupt
            assertThrows(Exception::class.java) { codec.read() }
            assertThrows(Exception::class.java) { codec.suppressedRemoteRequestKey() }
            assertThrows(Exception::class.java) { codec.write(state) }
            assertEquals(corrupt, store.value)
        }
        store.value = valid
        assertThrows(IllegalArgumentException::class.java) { codec.write(state, "not-an-original-request-key") }
        assertEquals(valid, store.value)
        store.failWrites = true
        assertThrows(IOException::class.java) { codec.write(NotificationTaskRecovery.empty(), suppressedRemoteRequestKey = null) }
        assertEquals(valid, store.value)
        assertEquals(marker, codec.suppressedRemoteRequestKey())
        assertEquals(state.pending, codec.read().pending)
    }
}
