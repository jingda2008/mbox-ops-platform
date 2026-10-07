package com.mbox.staff

import android.Manifest
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** Frozen provider contract; SDK CID is an opaque, 32 character hexadecimal installation token. */
object GetuiRegistrationContract : NativePushRegistrationContract {
    override val id = "getui-v1"
    override fun accepts(token: NativePushSdkToken) = token.contractId == id && token.provider == "getui" &&
        Regex("[0-9a-f]{32}").matches(token.value)
}

object GetuiPush {
    const val action = "com.mbox.staff.nativeapp.NATIVE_PUSH"
    const val channel = "mbox-service-realtime"
    private const val preferences = "getui-employee-consent-v1"
    fun consented(c: Context, owner: NativePushOwner?): Boolean = owner != null && c.getSharedPreferences(preferences, 0).let {
        it.getString("employee", null) == owner.employeeId && it.getString("session", null) == owner.staffSessionId
    }
    fun grant(c: Context, owner: NativePushOwner) {
        check(BuildConfig.GETUI_CONFIGURED) { "安装包尚未配置实时通知平台" }
        check(c.getSharedPreferences(preferences, 0).edit().clear().putString("employee", owner.employeeId)
            .putString("session", owner.staffSessionId).commit()) { "通知授权未保存" }
    }
    fun revoke(c: Context) {
        // Disable components first, even if storage subsequently fails. A stale preference is not
        // sufficient to start the SDK: foreground registration always rechecks backend/identity.
        GetuiSdk.stop(c)
        check(c.getSharedPreferences(preferences, 0).edit().clear().commit()) { "通知授权撤销未保存，请重试" }
    }
    fun allowed(c: Context): Boolean = (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        NotificationManagerCompat.from(c).areNotificationsEnabled() &&
        (c.getSystemService(NotificationManager::class.java).getNotificationChannel(channel)?.importance ?: 3) > 0
    fun createChannel(c: Context) = c.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(channel, "门店实时服务提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "服务任务提醒，打开后重新验证员工权限和任务状态"
            lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
        })
    /** Intent is untrusted input. No employee, task, table, URL or permission is accepted. */
    fun payload(text: String?): JSONObject? = runCatching {
        require(text != null && text.length <= 1024)
        val root = JSONObject(text)
        require(root.keys().asSequence().toSet() == setOf("mbox"))
        root.getJSONObject("mbox").also { require(parseNativePushNotification(it) != null) }
    }.getOrNull()
    fun payload(intent: Intent?): JSONObject? = if (intent?.action == action)
        payload(runCatching { intent.getStringExtra("payload") }.getOrNull()) else null
}
