package com.mbox.staff

import android.content.Intent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GetuiPushTest {
    private val delivery = "44444444-4444-4444-8444-444444444444"
    private fun payload() = JSONObject().put("mbox", JSONObject().put("protocol", 1).put("kind", "service_task").put("deliveryId", delivery)).toString()
    @Test fun actualSenderUriDecodesToDeliveryReferenceOnly() {
        val uri = "intent:#Intent;action=${GetuiPush.action};launchFlags=0x4000000;package=com.mbox.staff.nativeapp;component=com.mbox.staff.nativeapp/com.mbox.staff.MainActivity;S.payload=${android.net.Uri.encode(payload())};end"
        val parsed = GetuiPush.payload(Intent.parseUri(uri, Intent.URI_INTENT_SCHEME))
        assertEquals(delivery, parsed?.getString("deliveryId"))
        assertEquals(setOf("protocol", "kind", "deliveryId"), parsed?.keys()?.asSequence()?.toSet())
    }
    @Test fun forgedCommandsIdentityAndMalformedPayloadsRejected() {
        for (text in listOf(null, "", "[]", "x".repeat(1025), JSONObject(payload()).put("url", "https://bad.example").toString(),
            JSONObject(payload()).apply { getJSONObject("mbox").put("employeeId", delivery) }.toString(),
            JSONObject(payload()).apply { getJSONObject("mbox").put("protocol", "1") }.toString())) assertNull(GetuiPush.payload(text))
        assertNull(GetuiPush.payload(Intent("unexpected").putExtra("payload", payload())))
    }
    @Test @Config(sdk = [28]) fun disablingPeriodicCheckChannelDoesNotDisableRealtimeChannel() {
        val c = org.robolectric.RuntimeEnvironment.getApplication()
        GetuiPush.createChannel(c)
        c.getSystemService(android.app.NotificationManager::class.java).createNotificationChannel(
            android.app.NotificationChannel(ServiceReminders.channel, "Periodic", android.app.NotificationManager.IMPORTANCE_NONE))
        assertTrue(GetuiPush.allowed(c))
        assertFalse(ServiceReminders.allowed(c))
    }
    @Test @Config(sdk = [28]) fun disablingRealtimeChannelDoesNotDisablePeriodicCheckChannel() {
        val c = org.robolectric.RuntimeEnvironment.getApplication()
        ServiceReminders.createChannel(c)
        c.getSystemService(android.app.NotificationManager::class.java).createNotificationChannel(
            android.app.NotificationChannel(GetuiPush.channel, "Realtime", android.app.NotificationManager.IMPORTANCE_NONE))
        assertFalse(GetuiPush.allowed(c))
        assertTrue(ServiceReminders.allowed(c))
    }
    @Test fun android13AndLaterRequireNotificationPermissionEvenWithEnabledChannel() {
        val c = org.robolectric.RuntimeEnvironment.getApplication()
        GetuiPush.createChannel(c)
        org.robolectric.Shadows.shadowOf(c).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        assertFalse(GetuiPush.allowed(c))
        org.robolectric.Shadows.shadowOf(c).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        assertTrue(GetuiPush.allowed(c))
    }

    @Test fun frozenContractRequiresExactProviderAndCidFormat() {
        assertTrue(GetuiRegistrationContract.accepts(NativePushSdkToken("getui-v1", "getui", "a".repeat(32))))
        for (token in listOf(NativePushSdkToken("other", "getui", "a".repeat(32)), NativePushSdkToken("getui-v1", "apns", "a".repeat(32)),
            NativePushSdkToken("getui-v1", "getui", "A".repeat(32)), NativePushSdkToken("getui-v1", "getui", "g".repeat(32)), NativePushSdkToken("getui-v1", "getui", "a".repeat(31))))
            assertFalse(GetuiRegistrationContract.accepts(token))
    }
    @Test fun missingAppIdCannotGrantConsentOrStartSdk() {
        if (BuildConfig.GETUI_CONFIGURED) return
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
        assertFalse(GetuiPush.consented(context, owner))
        assertThrows(IllegalStateException::class.java) { GetuiPush.grant(context, owner) }
        assertFalse(GetuiSdk.start(context, owner, { fail("No CID before configuration") }, { _, _ -> fail("No provider callback") }))
        assertFalse(GetuiPush.consented(context, owner))
    }
}
