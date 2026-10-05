package com.mbox.staff

import java.time.Duration
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class NotificationTaskRecoveryTest {
    private val now = Instant.parse("2026-10-05T04:00:00Z")
    private val identity = NotificationTaskIdentity("employee-a", "login-a", "access-v1", true)
    private fun target(id: String = "notification-a", taskId: String = "task-a", tableSession: String = "table-session-a") =
        NotificationTaskTarget(id, identity.employeeId, identity.staffSessionId, taskId, tableSession, now.minusSeconds(30), now.plusSeconds(3600))
    private fun fact(target: NotificationTaskTarget = target(), status: String = "pending", authorized: Boolean = true) =
        NotificationTaskFact(target.taskId, target.tableSessionId, status, authorized)
    private fun offered(target: NotificationTaskTarget = target(), policy: NotificationTaskRecoveryPolicy = NotificationTaskRecoveryPolicy()) =
        NotificationTaskRecovery.empty(policy).offer(target, identity, now).recovery
    private fun snapshot(
        tasks: List<NotificationTaskFact> = listOf(fact()),
        actor: NotificationTaskIdentity = identity,
        started: Instant = now.plusSeconds(1),
        completed: Instant = now.plusSeconds(2),
        complete: Boolean = true,
    ) = AuthorizedNotificationTaskSnapshot(actor, started, completed, tasks, complete)

    private fun assertRejected(result: NotificationTaskTransition, reason: NotificationTaskRejection) {
        assertEquals(NotificationTaskDecision.Rejected(reason), result.decision)
        assertTrue(result.recovery.consumed.isEmpty())
    }

    @Test fun freshAuthorizedTaskFocusesOnlyOnceAndNeedsSeparateNavigationAcknowledgement() {
        val target = target(); val original = fact(target, "acknowledged")
        val clicked = NotificationTaskRecovery.empty().offer(target, identity, now)
        assertEquals(NotificationTaskDecision.RefreshRequired(clicked.recovery.pending!!), clicked.decision)
        val verified = clicked.recovery.resolve(identity, snapshot(listOf(original)), now.plusSeconds(3))
        assertEquals(NotificationTaskDecision.Focus(target, original), verified.decision)
        assertNotNull(verified.recovery.pending)
        assertTrue(verified.recovery.consumed.isEmpty())
        assertEquals(NotificationTaskDecision.Duplicate, verified.recovery.resolve(identity, snapshot(), now.plusSeconds(4)).decision)
        assertEquals(NotificationTaskDecision.Duplicate, verified.recovery.offer(target, identity, now.plusSeconds(4)).decision)
        val opened = verified.recovery.acknowledgeOpened(identity, now.plusSeconds(4))
        assertEquals(NotificationTaskDecision.Opened, opened.decision)
        assertNull(opened.recovery.pending)
        assertEquals(listOf(ConsumedNotificationTask(target, now.plusSeconds(4))), opened.recovery.consumed)
        assertEquals("acknowledged", original.status) // Opening has not changed the service task.
        assertEquals(NotificationTaskDecision.Duplicate, opened.recovery.offer(target, identity, now.plusSeconds(5)).decision)
    }

    @Test fun notificationWithoutLoginKeepsOriginalBindingAndDoesNotAdoptTheNextLogin() {
        val clicked = NotificationTaskRecovery.empty().offer(target(), null, now)
        assertEquals(NotificationTaskDecision.LoginRequired, clicked.decision)
        assertEquals(target(), clicked.recovery.pending!!.target)
        val restored = NotificationTaskRecovery.restore(clicked.recovery.pending, clicked.recovery.consumed)
        assertEquals(NotificationTaskDecision.LoginRequired, restored.defer(null, now.plusSeconds(1)).decision)
        val wrongEmployee = restored.retry(identity.copy(employeeId = "employee-b"), now.plusSeconds(2))
        assertRejected(wrongEmployee, NotificationTaskRejection.WRONG_EMPLOYEE)
        assertNull(wrongEmployee.recovery.pending)
        assertRejected(restored.retry(identity.copy(staffSessionId = "new-login-same-employee"), now.plusSeconds(2)), NotificationTaskRejection.WRONG_LOGIN_SESSION)
        val sameSession = restored.retry(identity, now.plusSeconds(2))
        assertTrue(sameSession.decision is NotificationTaskDecision.RefreshRequired)
        assertEquals(target(), sameSession.recovery.pending!!.target)
    }

    @Test fun rejectsWrongActorSessionPermissionAndChangedPermissionScope() {
        assertRejected(NotificationTaskRecovery.empty().offer(target(), identity.copy(employeeId = "other"), now), NotificationTaskRejection.WRONG_EMPLOYEE)
        assertRejected(NotificationTaskRecovery.empty().offer(target(), identity.copy(staffSessionId = "other"), now), NotificationTaskRejection.WRONG_LOGIN_SESSION)
        assertRejected(offered().resolve(identity.copy(canReadTasks = false), snapshot(), now.plusSeconds(3)), NotificationTaskRejection.ACCESS_DENIED)
        val changed = identity.copy(accessRevision = "access-v2")
        val stale = offered().resolve(changed, snapshot(), now.plusSeconds(3))
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), stale.decision)
        assertNotNull(stale.recovery.pending)
        assertTrue(stale.recovery.resolve(changed, snapshot(actor = changed), now.plusSeconds(4)).decision is NotificationTaskDecision.Focus)
        val claimed = offered().resolve(identity, snapshot(), now.plusSeconds(3)).recovery
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), claimed.acknowledgeOpened(changed, now.plusSeconds(4)).decision)
        assertTrue(claimed.consumed.isEmpty())
    }

    @Test fun onlyExactOriginalTaskAndTableSessionCanBeFocused() {
        assertRejected(offered().resolve(identity, snapshot(listOf(fact().copy(tableSessionId = "reopened-table-session"))), now.plusSeconds(3)), NotificationTaskRejection.WRONG_TABLE_SESSION)
        // A newly opened table has a different task even if it happens to reuse the same table label.
        assertRejected(offered().resolve(identity, snapshot(listOf(fact().copy(taskId = "new-task"))), now.plusSeconds(3)), NotificationTaskRejection.TASK_UNAVAILABLE)
        assertRejected(offered().resolve(identity, snapshot(listOf(fact(authorized = false))), now.plusSeconds(3)), NotificationTaskRejection.ACCESS_DENIED)
        for (status in listOf("completed", "cancelled", "unknown-status")) {
            assertRejected(offered().resolve(identity, snapshot(listOf(fact(status = status))), now.plusSeconds(3)), NotificationTaskRejection.TASK_NOT_ACTIVE)
        }
        // An authorized unfinished task can legitimately belong to a historical
        // table session; the resolver does not invent a new active-table constraint.
        val historical = target(tableSession = "historical-session")
        assertTrue(offered(historical).resolve(identity, snapshot(listOf(fact(historical, "in_progress"))), now.plusSeconds(3)).decision is NotificationTaskDecision.Focus)
    }

    @Test fun missingTaskIsUnknownUntilACompleteCurrentAuthorizedReadExists() {
        val incomplete = offered().resolve(identity, snapshot(emptyList(), complete = false), now.plusSeconds(3))
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.INCOMPLETE_SNAPSHOT), incomplete.decision)
        assertEquals(target(), incomplete.recovery.pending!!.target)
        val missing = incomplete.recovery.resolve(identity, snapshot(emptyList()), now.plusSeconds(4))
        assertRejected(missing, NotificationTaskRejection.TASK_UNAVAILABLE)
        assertFalse(NotificationTaskRejection.TASK_UNAVAILABLE.message.contains("已完成"))
        assertNull(missing.recovery.pending)
        assertTrue(offered().resolve(identity, snapshot(complete = false), now.plusSeconds(3)).decision is NotificationTaskDecision.Focus)
    }

    @Test fun networkUnknownPreservesOriginalTargetAcrossRestoreAndRetry() {
        val original = offered()
        val offline = original.defer(identity, now.plusSeconds(3))
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.NETWORK_UNKNOWN), offline.decision)
        assertEquals(original.pending, offline.recovery.pending)
        assertTrue(offline.recovery.consumed.isEmpty())
        val restored = NotificationTaskRecovery.restore(offline.recovery.pending, offline.recovery.consumed)
        val retried = restored.retry(identity, now.plusSeconds(20))
        assertEquals(target(), retried.recovery.pending!!.target)
        assertEquals(now.plusSeconds(20), retried.recovery.pending!!.requestedAt)
        val oldRead = retried.recovery.resolve(identity, snapshot(), now.plusSeconds(21))
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), oldRead.decision)
        assertTrue(retried.recovery.resolve(identity, snapshot(started = now.plusSeconds(21), completed = now.plusSeconds(22)), now.plusSeconds(23)).decision is NotificationTaskDecision.Focus)
    }

    @Test fun freshMeansTheReadStartedAfterTheClickAndFinishedBeforeNow() {
        val invalidReads = listOf(
            snapshot(started = now.minusSeconds(1)),
            snapshot(started = now.plusSeconds(3), completed = now.plusSeconds(2)),
            snapshot(completed = now.plusSeconds(5)),
            snapshot(actor = identity.copy(employeeId = "other")),
            snapshot(actor = identity.copy(staffSessionId = "other")),
        )
        invalidReads.forEach { read ->
            val result = offered().resolve(identity, read, now.plusSeconds(4))
            assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), result.decision)
            assertNotNull(result.recovery.pending)
        }
        assertTrue(offered().resolve(identity, snapshot(), now.plusSeconds(90)).decision is NotificationTaskDecision.Focus)
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), offered().resolve(identity, snapshot(), now.plusSeconds(91)).decision)
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.INCONSISTENT_SNAPSHOT), offered().resolve(identity, snapshot(listOf(fact(), fact(status = "completed"))), now.plusSeconds(3)).decision)
    }

    @Test fun validatesReferenceShapeTtlAndExpiryWithoutOpeningExpiredNotifications() {
        val base = target()
        val malformed = listOf(base.copy(notificationId = ""), base.copy(taskId = " task"), base.copy(employeeId = "a\nb"), base.copy(tableSessionId = "x".repeat(257)),
            base.copy(expiresAt = base.issuedAt), base.copy(expiresAt = base.issuedAt.plus(Duration.ofHours(25))))
        malformed.forEach { target ->
            assertFalse(target.isWellFormed())
            assertRejected(NotificationTaskRecovery.empty().offer(target, identity, now), NotificationTaskRejection.INVALID_TARGET)
        }
        assertTrue(base.copy(expiresAt = base.issuedAt.plus(Duration.ofHours(24))).isWellFormed())
        assertRejected(NotificationTaskRecovery.empty().offer(base.copy(issuedAt = now.plusSeconds(1)), identity, now), NotificationTaskRejection.NOT_YET_VALID)
        assertRejected(NotificationTaskRecovery.empty().offer(base, identity, base.expiresAt), NotificationTaskRejection.EXPIRED)
        val expiresSoon = base.copy(expiresAt = now.plusSeconds(4))
        val claimed = offered(expiresSoon).resolve(identity, snapshot(), now.plusSeconds(3)).recovery
        assertRejected(claimed.acknowledgeOpened(identity, now.plusSeconds(4)), NotificationTaskRejection.EXPIRED)
    }

    @Test fun coldStartNeverRestoresFocusAuthorityButDoesRestoreConsumedDeduplication() {
        val focus = offered().resolve(identity, snapshot(), now.plusSeconds(3)).recovery
        val coldPending = NotificationTaskRecovery.restore(focus.pending, focus.consumed)
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT), coldPending.acknowledgeOpened(identity, now.plusSeconds(4)).decision)
        val retried = coldPending.retry(identity, now.plusSeconds(5)).recovery
        val refocused = retried.resolve(identity, snapshot(started = now.plusSeconds(6), completed = now.plusSeconds(7)), now.plusSeconds(8)).recovery
        val opened = refocused.acknowledgeOpened(identity, now.plusSeconds(9)).recovery
        val coldConsumed = NotificationTaskRecovery.restore(opened.pending, opened.consumed)
        assertEquals(NotificationTaskDecision.Duplicate, coldConsumed.offer(target(), identity, now.plusSeconds(10)).decision)
        assertEquals(1, coldConsumed.consumed.size)
    }

    @Test fun boundedDeduplicationDoesNotEvictLiveRecordsAndReopenTheSameNotification() {
        val policy = NotificationTaskRecoveryPolicy(maxConsumed = 1)
        val first = target().copy(expiresAt = now.plusSeconds(10))
        val consumed = offered(first, policy).resolve(identity, snapshot(), now.plusSeconds(3)).recovery.acknowledgeOpened(identity, now.plusSeconds(4)).recovery
        val second = target("notification-b", "task-b")
        val clicked = consumed.offer(second, identity, now.plusSeconds(5)).recovery
        val read = snapshot(listOf(fact(second)), started = now.plusSeconds(6), completed = now.plusSeconds(7))
        val full = clicked.resolve(identity, read, now.plusSeconds(8))
        assertEquals(NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.DEDUP_CAPACITY), full.decision)
        assertEquals(second, full.recovery.pending!!.target)
        assertEquals(NotificationTaskDecision.Duplicate, full.recovery.offer(first, identity, now.plusSeconds(9)).decision)
        val afterExpiry = full.recovery.retry(identity, now.plusSeconds(11)).recovery
        assertTrue(afterExpiry.consumed.isEmpty())
        assertTrue(afterExpiry.resolve(identity, snapshot(listOf(fact(second)), started = now.plusSeconds(12), completed = now.plusSeconds(13)), now.plusSeconds(14)).decision is NotificationTaskDecision.Focus)
    }

    @Test fun notificationIdCannotBeReusedToRedirectAnExistingPendingOrConsumedReference() {
        val original = offered()
        val conflict = original.offer(target().copy(taskId = "another-task"), identity, now.plusSeconds(1))
        assertRejected(conflict, NotificationTaskRejection.REFERENCE_CONFLICT)
        assertNull(conflict.recovery.pending)
        val consumed = original.resolve(identity, snapshot(), now.plusSeconds(3)).recovery.acknowledgeOpened(identity, now.plusSeconds(4)).recovery
        val redirect = consumed.offer(target().copy(tableSessionId = "new-table-session"), identity, now.plusSeconds(5))
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.REFERENCE_CONFLICT), redirect.decision)
        assertEquals(consumed.consumed, redirect.recovery.consumed)
    }

    @Test fun rejectedNewClickCancelsOldNavigationIntentionWithoutChangingConsumedHistory() {
        val first = target("already-opened", "opened-task")
        val consumed = offered(first).resolve(identity, snapshot(listOf(fact(first))), now.plusSeconds(3))
            .recovery.acknowledgeOpened(identity, now.plusSeconds(4)).recovery
        val oldPending = target("old-pending", "old-task")
        val state = consumed.offer(oldPending, identity, now.plusSeconds(5)).recovery
        val invalidClicks = listOf(
            target("invalid").copy(taskId = ""),
            target("expired").copy(expiresAt = now.plusSeconds(5)),
            target("future").copy(issuedAt = now.plusSeconds(20)),
            target("wrong-owner").copy(employeeId = "another-employee"),
            target("wrong-login").copy(staffSessionId = "another-login"),
            oldPending.copy(tableSessionId = "conflicting-table-session"),
            first.copy(taskId = "conflicting-consumed-task"),
        )
        for (clicked in invalidClicks) {
            val rejected = state.offer(clicked, identity, now.plusSeconds(6))
            assertTrue(clicked.notificationId, rejected.decision is NotificationTaskDecision.Rejected)
            assertNull(clicked.notificationId, rejected.recovery.pending)
            assertEquals(consumed.consumed, rejected.recovery.consumed)
            assertEquals(NotificationTaskDecision.Idle, rejected.recovery.retry(identity, now.plusSeconds(7)).decision)
            assertEquals(NotificationTaskDecision.Idle, rejected.recovery.resolve(identity, snapshot(listOf(fact(oldPending)),
                started = now.plusSeconds(6), completed = now.plusSeconds(7)), now.plusSeconds(8)).decision)
        }
        val denied = state.offer(target("denied"), identity.copy(canReadTasks = false), now.plusSeconds(6))
        assertEquals(NotificationTaskDecision.Rejected(NotificationTaskRejection.ACCESS_DENIED), denied.decision)
        assertNull(denied.recovery.pending)
        assertEquals(consumed.consumed, denied.recovery.consumed)
    }

    @Test fun clickingAnAlreadyOpenedNotificationDoesNotResumeAnotherPendingTask() {
        val first = target()
        val consumed = offered(first).resolve(identity, snapshot(), now.plusSeconds(3))
            .recovery.acknowledgeOpened(identity, now.plusSeconds(4)).recovery
        val pending = consumed.offer(target("next", "next-task"), identity, now.plusSeconds(5)).recovery
        val duplicate = pending.offer(first, identity, now.plusSeconds(6))
        assertEquals(NotificationTaskDecision.Duplicate, duplicate.decision)
        assertNull(duplicate.recovery.pending)
        assertEquals(consumed.consumed, duplicate.recovery.consumed)
        assertEquals(NotificationTaskDecision.Idle, duplicate.recovery.retry(identity, now.plusSeconds(7)).decision)
    }

    @Test fun corruptedSavedStateIsRejectedInsteadOfSilentlyDroppingDeduplication() {
        val consumed = ConsumedNotificationTask(target(), now.plusSeconds(1))
        assertThrows(IllegalArgumentException::class.java) { NotificationTaskRecovery.restore(null, listOf(consumed, consumed)) }
        assertThrows(IllegalArgumentException::class.java) { NotificationTaskRecovery.restore(PendingNotificationTask(target(), now.minusSeconds(60)), emptyList()) }
        assertThrows(IllegalArgumentException::class.java) { NotificationTaskRecovery.restore(null, listOf(consumed.copy(openedAt = target().expiresAt))) }
        val tooMany = listOf(consumed, ConsumedNotificationTask(target("other"), now.plusSeconds(1)))
        assertThrows(IllegalArgumentException::class.java) { NotificationTaskRecovery.restore(null, tooMany, NotificationTaskRecoveryPolicy(maxConsumed = 1)) }
        val mutable = mutableListOf(consumed)
        val restored = NotificationTaskRecovery.restore(null, mutable)
        mutable.clear()
        assertEquals(listOf(consumed), restored.consumed)
    }
}
