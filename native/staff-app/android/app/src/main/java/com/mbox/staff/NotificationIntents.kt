package com.mbox.staff

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.security.MessageDigest
import java.time.Instant

sealed interface NotificationIntentResult {
    data object Ignored : NotificationIntentResult
    data object Invalid : NotificationIntentResult
    data class Target(val target: NotificationTaskTarget) : NotificationIntentResult
}

/** Internal local-notification envelope, not a push-provider or public deep-link contract.
 * The hash separates PendingIntents; it does not authenticate a caller. Recovery must still
 * revalidate the original employee/session and read the task from the server before navigating.
 */
object NotificationIntents {
    private const val ACTION = "com.mbox.staff.nativeapp.OPEN_SERVICE_NOTIFICATION"
    private const val PREFIX = "mbox.notification."
    private const val SCHEMA = PREFIX + "schema"
    private const val ID = PREFIX + "id"
    private const val EMPLOYEE = PREFIX + "employee"
    private const val SESSION = PREFIX + "session"
    private const val TASK = PREFIX + "task"
    private const val TABLE_SESSION = PREFIX + "tableSession"
    private const val ISSUED_AT = PREFIX + "issuedAt"
    private const val EXPIRES_AT = PREFIX + "expiresAt"
    private const val SCHEME = "mbox-internal-notification"
    private val keys = setOf(SCHEMA, ID, EMPLOYEE, SESSION, TASK, TABLE_SESSION, ISSUED_AT, EXPIRES_AT)

    fun create(context: Context, target: NotificationTaskTarget): Intent {
        require(target.isWellFormed()) { "通知任务引用无效" }
        return Intent(context, MainActivity::class.java).apply {
            action = ACTION
            data = identityUri(target)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(SCHEMA, 1)
            putExtra(ID, target.notificationId)
            putExtra(EMPLOYEE, target.employeeId)
            putExtra(SESSION, target.staffSessionId)
            putExtra(TASK, target.taskId)
            putExtra(TABLE_SESSION, target.tableSessionId)
            putExtra(ISSUED_AT, target.issuedAt.toString())
            putExtra(EXPIRES_AT, target.expiresAt.toString())
        }
    }

    @Suppress("DEPRECATION") // Bundle.get preserves the actual stored type on every supported API.
    fun parse(intent: Intent?): NotificationIntentResult {
        if (intent == null) return NotificationIntentResult.Ignored
        return try {
            val extras = intent.extras
            if (intent.action != ACTION) {
                if (intent.data?.scheme == SCHEME || extras?.keySet()?.any { it.startsWith(PREFIX) } == true)
                    NotificationIntentResult.Invalid
                else NotificationIntentResult.Ignored
            } else {
                require(intent.component == ComponentName(BuildConfig.APPLICATION_ID, MainActivity::class.java.name))
                require(intent.`package` == null || intent.`package` == BuildConfig.APPLICATION_ID)
                require(intent.selector == null && intent.clipData == null && intent.type == null)
                require(intent.categories.isNullOrEmpty())
                require(extras != null && extras.keySet() == keys)
                require(extras.get(SCHEMA) is Int && extras.get(SCHEMA) == 1)
                fun text(key: String, maximum: Int = 256): String {
                    val value = extras.get(key)
                    require(value is String && value.length in 1..maximum)
                    return value
                }
                val target = NotificationTaskTarget(
                    notificationId = text(ID),
                    employeeId = text(EMPLOYEE),
                    staffSessionId = text(SESSION),
                    taskId = text(TASK),
                    tableSessionId = text(TABLE_SESSION),
                    issuedAt = Instant.parse(text(ISSUED_AT, 64)),
                    expiresAt = Instant.parse(text(EXPIRES_AT, 64)),
                )
                require(target.isWellFormed())
                require(intent.data == identityUri(target))
                // Expiry and future issuance are evaluated by recovery using its injected clock.
                NotificationIntentResult.Target(target)
            }
        } catch (_: Exception) {
            NotificationIntentResult.Invalid
        }
    }

    private fun identityUri(target: NotificationTaskTarget): Uri {
        val values = listOf(target.notificationId, target.employeeId, target.staffSessionId,
            target.taskId, target.tableSessionId, target.issuedAt.toString(), target.expiresAt.toString())
        // Length-prefixing is unambiguous even when an allowed reference contains punctuation.
        val identity = values.joinToString("") { "${it.length}:$it" }
        val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return Uri.Builder().scheme(SCHEME).authority("task").appendPath(digest).build()
    }
}
