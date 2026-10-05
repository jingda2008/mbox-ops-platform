package com.mbox.staff

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NotificationIntentsTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val target = NotificationTaskTarget("notice-one", "employee-one", "staff-session-one",
        "task-one", "table-session-one", Instant.parse("2026-10-05T10:00:00Z"), Instant.parse("2026-10-05T10:30:00Z"))
    private fun intent() = NotificationIntents.create(context, target)
    private fun assertInvalid(value: Intent) = assertEquals(NotificationIntentResult.Invalid, NotificationIntents.parse(value))

    @Test fun roundTripIsExplicitMinimalAndContainsNoIdentityInItsDataUri() {
        val value = intent()
        assertEquals(ComponentName(context, MainActivity::class.java), value.component)
        assertEquals(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP, value.flags)
        assertEquals(8, value.extras!!.size())
        for (reference in listOf(target.notificationId, target.employeeId, target.staffSessionId, target.taskId, target.tableSessionId)) {
            assertFalse(value.dataString!!.contains(reference))
        }
        assertEquals(NotificationIntentResult.Target(target), NotificationIntents.parse(value))
    }

    @Test @Config(sdk = [35])
    fun differentNotificationsAndChangedTargetsDoNotReplaceOldPendingIntents() {
        val other = target.copy(notificationId = "notice-two", taskId = "task-two")
        val changed = target.copy(staffSessionId = "staff-session-two")
        val firstIntent = intent()
        val otherIntent = NotificationIntents.create(context, other)
        val changedIntent = NotificationIntents.create(context, changed)
        assertFalse(firstIntent.filterEquals(otherIntent))
        assertFalse(firstIntent.filterEquals(changedIntent))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val first = PendingIntent.getActivity(context, 1999, firstIntent, flags)
        val second = PendingIntent.getActivity(context, 1999, otherIntent, flags)
        val third = PendingIntent.getActivity(context, 1999, changedIntent, flags)
        assertNotEquals(first, second)
        assertNotEquals(first, third)
        assertEquals(NotificationIntentResult.Target(target), NotificationIntents.parse(shadowOf(first).savedIntent))
        assertEquals(NotificationIntentResult.Target(other), NotificationIntents.parse(shadowOf(second).savedIntent))
        assertEquals(NotificationIntentResult.Target(changed), NotificationIntents.parse(shadowOf(third).savedIntent))
    }

    @Test fun ordinaryLaunchesAreIgnoredButUnknownNotificationActionIsInvalid() {
        assertEquals(NotificationIntentResult.Ignored, NotificationIntents.parse(null))
        assertEquals(NotificationIntentResult.Ignored, NotificationIntents.parse(Intent(Intent.ACTION_MAIN)))
        assertEquals(NotificationIntentResult.Ignored, NotificationIntents.parse(Intent(context, MainActivity::class.java)))
        assertInvalid(intent().setAction("unknown.action"))
        assertInvalid(intent().setAction(null))
    }

    @Test fun missingUnknownAndIncorrectlyTypedFieldsAreRejectedWithoutCrashing() {
        assertInvalid(intent().apply { removeExtra("mbox.notification.schema") })
        assertInvalid(intent().putExtra("mbox.notification.schema", 2))
        assertInvalid(intent().putExtra("mbox.notification.schema", "1"))
        assertInvalid(intent().putExtra("mbox.notification.schema", 1L))
        assertInvalid(intent().putExtra("mbox.notification.task", 1))
        assertInvalid(intent().putExtra("mbox.notification.task", true))
        assertInvalid(intent().putExtra("mbox.notification.task", "x".repeat(257)))
        assertInvalid(intent().putExtra("mbox.notification.task", "task\nwrong"))
        assertInvalid(intent().putExtra("mbox.notification.employee", ""))
        assertInvalid(intent().putExtra("unrelated-secret", "must-not-be-accepted"))
    }

    @Test fun malformedTimesAndImpossibleLifetimesAreRejected() {
        assertInvalid(intent().putExtra("mbox.notification.issuedAt", "not-a-time"))
        assertInvalid(intent().putExtra("mbox.notification.expiresAt", Long.MAX_VALUE))
        assertInvalid(intent().putExtra("mbox.notification.expiresAt", "9".repeat(65)))
        assertInvalid(intent().putExtra("mbox.notification.expiresAt", target.issuedAt.toString()))
        for (bad in listOf(target.copy(expiresAt = target.issuedAt),
            target.copy(expiresAt = target.issuedAt.minusSeconds(1)),
            target.copy(expiresAt = target.issuedAt.plusSeconds(86_401)))) {
            assertThrows(IllegalArgumentException::class.java) { NotificationIntents.create(context, bad) }
        }
        // This parser has no wall clock; recovery separately decides whether the reference expired.
        val old = target.copy(issuedAt = Instant.parse("2000-01-01T00:00:00Z"), expiresAt = Instant.parse("2000-01-01T00:30:00Z"))
        assertEquals(NotificationIntentResult.Target(old), NotificationIntents.parse(NotificationIntents.create(context, old)))
    }

    @Test fun forgedRoutingAndMutatedReferencesCannotBecomeAValidTarget() {
        assertInvalid(intent().setComponent(null))
        assertInvalid(intent().setComponent(ComponentName("other.app", MainActivity::class.java.name)))
        assertInvalid(intent().setPackage("other.app"))
        assertInvalid(intent().setData(Uri.parse("https://mbox.shmbox.com/")))
        assertInvalid(intent().putExtra("mbox.notification.task", "different-task"))
        assertInvalid(intent().addCategory(Intent.CATEGORY_BROWSABLE))
        assertInvalid(intent().setType("text/plain"))
        assertInvalid(intent().apply { selector = Intent(Intent.ACTION_VIEW) })
    }
}
