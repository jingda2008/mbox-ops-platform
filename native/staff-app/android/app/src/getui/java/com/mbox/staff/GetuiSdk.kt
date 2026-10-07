package com.mbox.staff

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import com.igexin.sdk.GTIntentService
import com.igexin.sdk.PushManager
import com.igexin.sdk.message.GTNotificationMessage
import com.igexin.sdk.message.GTTransmitMessage

/** No preInit in Application/ContentProvider. Components start disabled in the merged manifest. */
object GetuiSdk {
    private var tokenCallback: ((String) -> Unit)? = null
    private var notificationCallback: ((String, Boolean) -> Unit)? = null
    private var started = false
    private fun components(c: Context, enabled: Boolean) {
        val pkg = c.packageManager.getPackageInfo(c.packageName, PackageManager.GET_SERVICES or PackageManager.GET_PROVIDERS or
            PackageManager.GET_RECEIVERS or PackageManager.GET_ACTIVITIES or PackageManager.MATCH_DISABLED_COMPONENTS)
        val components = listOfNotNull(pkg.services?.toList(), pkg.providers?.toList(), pkg.receivers?.toList(), pkg.activities?.toList()).flatten()
        val prefixes = listOf("com.igexin.", "com.getui.", "com.g.gysdk.", "com.zx.a.I8b7.")
        components.filter { it.name == MboxGetuiIntentService::class.java.name || prefixes.any(it.name::startsWith) }.forEach {
            val action = { c.packageManager.setComponentEnabledSetting(ComponentName(c.packageName, it.name),
                if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP) }
            if (enabled) action() else runCatching { action() }
        }
    }
    @Synchronized fun start(c: Context, owner: NativePushOwner, token: (String) -> Unit, notification: (String, Boolean) -> Unit): Boolean {
        if (!BuildConfig.GETUI_CONFIGURED || !GetuiPush.consented(c, owner) || !GetuiPush.allowed(c)) return false
        tokenCallback = token; notificationCallback = notification
        components(c, true)
        val push = PushManager.getInstance()
        // Disable optional identifiers and unrelated personalization/nearby/cross-app functions.
        push.setImeiEnable(c, false); push.setImsiEnable(c, false); push.setMacEnable(c, false)
        push.setIccIdEnable(c, false); push.setSerialNumberEnable(c, false); push.setAdvertisingIdEnable(c, false)
        push.setCellInfoEnable(c, false); push.setIndividuationPush(c, false); push.setScenePush(c, false)
        push.setLinkMerge(c, false); push.setGuardOptions(c, false, false)
        push.registerPushIntentService(c, MboxGetuiIntentService::class.java)
        push.preInit(c); push.initialize(c); push.turnOnPush(c)
        started = true
        push.getClientid(c)?.takeIf { GetuiRegistrationContract.accepts(NativePushSdkToken("getui-v1", "getui", it)) }?.let(token)
        return true
    }
    @Synchronized fun stop(c: Context) {
        tokenCallback = null; notificationCallback = null
        if (started) runCatching { PushManager.getInstance().turnOffPush(c) }
        started = false
        runCatching { components(c, false) }
        runCatching { c.stopService(Intent().setClassName(c.packageName, "com.igexin.sdk.PushService")) }
        runCatching { c.stopService(Intent(c, MboxGetuiIntentService::class.java)) }
        runCatching { c.stopService(Intent().setClassName(c.packageName, "com.getui.gtc.GtcService")) }
    }
    @Synchronized fun token(value: String) { if (started) tokenCallback?.invoke(value) }
    @Synchronized fun notification(value: String?, opened: Boolean) { if (started && value != null) notificationCallback?.invoke(value, opened) }
}

/** Runs in the app process. Dropped background observations are not fabricated as deliveries. */
class MboxGetuiIntentService : GTIntentService() {
    override fun onReceiveClientId(context: Context, clientid: String) = GetuiSdk.token(clientid)
    override fun onReceiveMessageData(context: Context, msg: GTTransmitMessage) {
        // This app sends notifications, not commands. A transmission is never a business write.
        if ((msg.payload?.size ?: 0) <= 1024) GetuiSdk.notification(msg.payload?.toString(Charsets.UTF_8), false)
    }
    private fun notify(msg: GTNotificationMessage, opened: Boolean) {
        val payload = msg.payload?.takeIf { GetuiPush.payload(it) != null } ?: runCatching {
            val intent = Intent.parseUri(msg.intentUri, Intent.URI_INTENT_SCHEME)
            if (GetuiPush.payload(intent) != null) intent.getStringExtra("payload") else null
        }.getOrNull()
        GetuiSdk.notification(payload, opened)
    }
    override fun onNotificationMessageArrived(context: Context, msg: GTNotificationMessage) = notify(msg, false)
    override fun onNotificationMessageClicked(context: Context, msg: GTNotificationMessage) = notify(msg, true)
}
