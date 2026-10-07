package com.mbox.staff

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.cancel
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** Actual AppModel/StaffAPI boundaries with offline payloads and isolated secure-store substitutes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class AppModelNativePushTest {
    private lateinit var app: Application
    private val models = mutableListOf<AppModel>()
    private val wires = mutableListOf<OfflineWire>()
    private val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    private val otherOwner = NativePushOwner("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
    private val delivery = "55555555-5555-4555-8555-555555555555"
    private val otherDelivery = "66666666-6666-4666-8666-666666666666"
    private val task = "77777777-7777-4777-8777-777777777777"
    private val tableSession = "88888888-8888-4888-8888-888888888888"
    private val requestKey = "native-push-99999999-9999-4999-8999-999999999999"
    // Deterministic fixture bytes, never a production revocation capability.
    private val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })

    private class MemoryStore : NotificationStateStore {
        @Volatile var value: String? = null
        @Volatile var failWrites = false
        override fun read() = value
        override fun write(value: String) {
            check(!failWrites) { "offline secure-store unavailable" }
            this.value = value
        }
        override fun remove() { value = null }
    }

    private fun fixture() = JSONObject(javaClass.classLoader!!.getResourceAsStream("live-service.json")!!
        .bufferedReader().use { it.readText() })

    private fun board(): JSONObject = fixture().getJSONObject("board").apply {
        put("currentEmployeeId", owner.employeeId)
        getJSONArray("tasks").getJSONObject(0).put("id", task).put("tableSessionId", tableSession)
            .put("assignedEmployeeId", owner.employeeId)
    }

    private fun response(data: JSONObject, cookie: Boolean = false) = APIResponse(200,
        JSONObject().put("data", data).toString(),
        if (cookie) mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=offline-push-session; Path=/; Secure; HttpOnly; Max-Age=3600")) else emptyMap())

    private fun denied(status: Int, code: String) = APIResponse(status,
        JSONObject().put("error", JSONObject().put("code", code).put("message", "离线测试目标不可用")).toString())

    private fun payload(id: String = delivery) = JSONObject().put("protocol", 1).put("kind", "service_task").put("deliveryId", id)

    private fun localTarget(id: String = "local-reminder") = Instant.now().let { at ->
        NotificationTaskTarget(id, owner.employeeId, owner.staffSessionId, task, tableSession,
            at.minusSeconds(5), at.plusSeconds(600))
    }

    private inner class OfflineWire(val binding: NativePushBinding) {
        val auth = fixture().getJSONObject("auth").apply {
            getJSONObject("session").put("id", owner.staffSessionId).put("employeeId", owner.employeeId)
            getJSONObject("employee").put("id", owner.employeeId)
            put("permissions", JSONArray(listOf("service.view", "service.execute")))
            put("deniedPermissions", JSONArray())
        }
        private val requests = Collections.synchronizedList(mutableListOf<APIRequest>())
        @Volatile var service: (APIRequest) -> APIResponse = { response(board()) }
        @Volatile var target: (APIRequest) -> APIResponse = { request -> response(targetData(request.path.split('/')[5])) }
        @Volatile var heartbeat: () -> APIResponse = { response(auth) }

        fun targetData(id: String = delivery) = JSONObject().put("protocol", 1)
            .put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
            .put("deliveryId", id).put("installationId", binding.installationId).put("revision", binding.revision)
            .put("kind", "service_task").put("taskId", task).put("tableSessionId", tableSession)

        val api = StaffAPI { request ->
            requests += request
            when {
                request.path in setOf("/api/auth/login", "/api/auth/switch") -> response(auth, cookie = true)
                request.path == "/api/auth/heartbeat" -> heartbeat()
                request.path == "/api/native-service-center" -> service(request)
                request.path.startsWith("/api/native/push/deliveries/") && request.path.endsWith("/target") -> target(request)
                request.path.startsWith("/api/native/push/deliveries/") && request.path.endsWith("/observations") -> {
                    val kind = request.body!!.getString("kind")
                    val at = Instant.now().toString()
                    APIResponse(200, JSONObject().put("data", JSONObject().put("protocol", 1)
                        .put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
                        .put("requestKey", request.headers["Idempotency-Key"]).put("deliveryId", request.path.split('/')[5])
                        .put("kind", kind).put("clientReportedReceivedAt", if (kind == "received") at else JSONObject.NULL)
                        .put("clientReportedOpenedAt", if (kind == "opened") at else JSONObject.NULL))
                        .put("meta", JSONObject().put("replayed", false)).toString())
                }
                else -> throw IOException("Unexpected offline push route: ${request.path}")
            }
        }

        fun recorded(): List<APIRequest> = synchronized(requests) { requests.toList() }
        fun taskReads() = recorded().count { it.path == "/api/native-service-center" }
        fun targetReads() = recorded().count { it.path.endsWith("/target") }
    }

    private inner class Seed(opened: Boolean = true) {
        val localStore = MemoryStore()
        val pushStore = MemoryStore()
        val seeded = NativePushLifecycle(pushStore)
        val installation: NativePushInstallation
        val context: NativePushCallbackContext
        val wire: OfflineWire
        init {
            seeded.reconcileOwner(owner)
            installation = NativePushInstallation(owner, NativePushBinding(seeded.installationId, 1),
                NativePushInstallationStatus.ACTIVE, true, Instant.parse("2099-01-01T00:00:00Z"), requestKey)
            assertTrue(seeded.recordVerifiedInstallation(installation, seeded.generation, secret))
            context = NativePushCallbackBridge(seeded).captureContext()!!
            if (opened) assertEquals(NativePushCallbackOutcome.STAGED, NativePushCallbackBridge(seeded).onOpened(context, payload()))
            wire = OfflineWire(installation.binding).also { wires += it }
        }
        fun saved() = NativePushLifecycle(pushStore)
        fun model(signedIn: Boolean = true): AppModel {
            val actor = if (signedIn) wire.api.login("staff", "1234", false) else null
            return AppModel(app, notificationStoreOverride = localStore, apiOverride = wire.api,
                pushStateStoreOverride = pushStore).also {
                models += it
                if (actor != null) identity(it, actor)
                it.foreground = true
            }
        }
    }

    private fun identity(model: AppModel, actor: StaffIdentity?) {
        AppModel::class.java.getDeclaredMethod("setIdentity", StaffIdentity::class.java)
            .apply { isAccessible = true }.invoke(model, actor)
    }

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        do {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(2)
        } while (System.nanoTime() < deadline)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(message, condition())
    }
    private fun idle(model: AppModel) = await("Native push recovery did not finish") { !model.businessRequestInFlight }

    private fun consentForGetuiFixture() {
        assertTrue(app.getSharedPreferences("getui-employee-consent-v1", 0).edit().clear()
            .putString("employee", owner.employeeId).putString("session", owner.staffSessionId).commit())
    }

    @Test fun coldGetuiIntentWaitsForLoginAndServerTargetBeforeItCanStageOrNavigate() {
        val f = Seed(opened = false)
        val m = f.model(signedIn = false)
        consentForGetuiFixture()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        f.wire.target = { request ->
            entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS))
            response(f.wire.targetData(request.path.split('/')[5]))
        }
        try {
            m.receiveGetuiPayload(JSONObject().put("mbox", payload()).toString(), true)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(f.wire.recorded().isEmpty())
            assertNull(f.saved().pendingRemoteOpen)
            identity(m, f.wire.api.login("staff", "1234", false))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
            await("Getui target was not queried after login") { entered.count == 0L }
            assertNull("An unverified intent must not enter durable recovery", f.saved().pendingRemoteOpen)
            assertNull(m.notificationOpenTarget)
            release.countDown()
            await("Verified getui click did not reach current task") { m.notificationOpenTarget?.id == task }
            assertEquals(delivery, f.saved().pendingRemoteOpen?.deliveryId)
            assertTrue(f.wire.targetReads() >= 2) // ingress verification and normal recovery each reauthorize
        } finally { release.countDown() }
    }

    @Test fun disabledPeriodicChannelDoesNotRetireRealtimeBindingOnResume() {
        val f = Seed(opened = false)
        val m = f.model()
        GetuiPush.createChannel(app)
        app.getSystemService(android.app.NotificationManager::class.java).createNotificationChannel(
            android.app.NotificationChannel(ServiceReminders.channel, "Periodic", android.app.NotificationManager.IMPORTANCE_NONE))
        m.resumeNativePushRecovery()
        idle(m)
        assertEquals(f.installation.binding, f.saved().currentBinding)
        assertEquals(0, f.saved().pendingRevocationCount)
    }

    @Test fun turningOffRememberLoginRetiresPushAndClearsGetuiConsent() {
        val f = Seed(opened = false)
        val m = f.model()
        consentForGetuiFixture()
        assertTrue(m.nativePushConsented)
        m.changeRememberLogin(false)
        idle(m)
        assertFalse(m.nativePushConsented)
        assertNull(f.saved().currentBinding)
        assertEquals(1, f.saved().pendingRevocationCount)
    }

    @Test fun oldEmployeeGetuiCallbackCannotStageAfterIdentityChangesDuringTargetRead() {
        val f = Seed(opened = false)
        val m = f.model()
        consentForGetuiFixture()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        f.wire.target = { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); response(f.wire.targetData()) }
        try {
            m.receiveGetuiPayload(JSONObject().put("mbox", payload()).toString(), true)
            await("Getui target query did not begin") { entered.count == 0L }
            identity(m, m.identity!!.copy(employeeId = otherOwner.employeeId, sessionId = otherOwner.staffSessionId))
            release.countDown()
            idle(m)
            assertNull(f.saved().pendingRemoteOpen)
            assertEquals(0, f.saved().pendingObservationCount)
            assertNull(m.notificationOpenTarget)
            assertEquals(0, f.wire.taskReads())
        } finally { release.countDown() }
    }

    @Test fun explicitClosedTaskRoutePreservesRemoteClickUntilSameSessionRouteReturns() {
        for (restoredRoute in listOf("explicit", "legacy-omitted")) {
            val f = Seed(opened = false)
            f.wire.auth.put("navigation", JSONArray())
            val m = f.model()
            assertTrue(m.identity!!.allows("service.view"))
            assertEquals(emptyList<String>(), m.identity!!.navigationRoutes)
            assertEquals(NativePushCallbackOutcome.STAGED, m.receiveNativePushPayload(f.context, payload(), opened = true))
            idle(m)
            val original = f.saved().pendingRemoteOpen!!
            assertEquals(0, f.wire.targetReads())
            assertEquals(0, f.wire.taskReads())
            assertNull(m.notificationOpenTarget)
            var opened = 0
            m.consumeNotificationNavigation { opened++ }
            assertEquals(0, opened)
            assertEquals(original, f.saved().pendingRemoteOpen)
            assertEquals(f.context.generation, f.saved().generation)

            if (restoredRoute == "explicit") f.wire.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
            else f.wire.auth.remove("navigation")
            identity(m, f.wire.api.heartbeat())
            assertEquals(owner.employeeId, m.identity!!.employeeId)
            assertEquals(owner.staffSessionId, m.identity!!.sessionId)
            m.resumeNativePushOpen()
            idle(m)
            assertEquals(1, f.wire.targetReads())
            assertEquals(1, f.wire.taskReads())
            assertEquals(task, m.notificationOpenTarget?.id)
            assertEquals(original, f.saved().pendingRemoteOpen)
            m.consumeNotificationNavigation { opened++ }
            idle(m)
            assertEquals(1, opened)
            assertNull(f.saved().pendingRemoteOpen)
            m.viewModelScope.cancel()
        }
    }

    @Test fun heartbeatRemovingTaskRouteStopsRemoteTargetAndTaskReadsWithoutConsumingPending() {
        val f = Seed()
        f.wire.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
        val m = f.model()
        val original = f.saved().pendingRemoteOpen!!
        f.wire.auth.put("navigation", JSONArray())
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(emptyList<String>(), m.identity!!.navigationRoutes)
        assertTrue(m.identity!!.allows("service.view"))
        assertEquals(0, f.wire.targetReads())
        assertEquals(0, f.wire.taskReads())
        assertNull(m.notificationOpenTarget)
        assertEquals(original, f.saved().pendingRemoteOpen)
        assertEquals(f.context.generation, f.saved().generation)
        var opened = false
        m.consumeNotificationNavigation { opened = true }
        assertFalse(opened)
        assertEquals(original, f.saved().pendingRemoteOpen)
    }

    @Test fun remoteUiClaimCannotOpenAfterTaskRouteClosesAndMustReadAgainWhenRestored() {
        val f = Seed()
        val m = f.model()
        assertNull(m.identity!!.navigationRoutes) // Permission-only legacy auth remains compatible.
        val original = f.saved().pendingRemoteOpen!!
        m.resumeNativePushOpen()
        idle(m)
        assertNotNull(m.notificationOpenTarget)
        val actor = m.identity!!
        identity(m, actor.copy(navigationRoutes = emptyList()))
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        idle(m)
        assertEquals(0, opened)
        assertEquals(original, f.saved().pendingRemoteOpen)
        assertEquals(f.context.generation, f.saved().generation)
        val targets = f.wire.targetReads()
        val tasks = f.wire.taskReads()
        identity(m, actor)
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(targets + 1, f.wire.targetReads())
        assertEquals(tasks + 1, f.wire.taskReads())
        m.consumeNotificationNavigation { opened++ }
        idle(m)
        assertEquals(1, opened)
        assertNull(f.saved().pendingRemoteOpen)
    }

    @Test fun taskRouteClosingDuringRemoteTargetOrBoardReadKeepsBindingAndRequiresFreshResolution() {
        for (phase in listOf("target", "board")) {
            val f = Seed()
            f.wire.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
            val m = f.model()
            val original = f.saved().pendingRemoteOpen!!
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            if (phase == "target") f.wire.target = { request ->
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(f.wire.targetData(request.path.split('/')[5]))
            } else f.wire.service = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(board())
            }
            try {
                m.resumeNativePushOpen()
                await("Remote $phase read was not entered") { entered.count == 0L }
                f.wire.auth.put("navigation", JSONArray())
                identity(m, m.identity!!.copy(navigationRoutes = emptyList()))
                release.countDown()
                idle(m)
                assertNull(phase, m.notificationOpenTarget)
                assertNull(phase, m.serviceBoard)
                assertEquals(phase, original, f.saved().pendingRemoteOpen)
                assertEquals(phase, f.installation.binding, f.saved().currentBinding)
                assertEquals(phase, f.context.generation, f.saved().generation)
                assertEquals(phase, 1, f.wire.targetReads())
                assertEquals(phase, if (phase == "target") 0 else 1, f.wire.taskReads())
                var opened = 0
                m.consumeNotificationNavigation { opened++ }
                assertEquals(phase, 0, opened)
                val targets = f.wire.targetReads()
                val tasks = f.wire.taskReads()

                f.wire.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
                identity(m, f.wire.api.heartbeat())
                m.resumeNativePushOpen()
                idle(m)
                assertEquals(phase, targets + 1, f.wire.targetReads())
                assertEquals(phase, tasks + 1, f.wire.taskReads())
                assertEquals(phase, task, m.notificationOpenTarget?.id)
                assertEquals(phase, original, f.saved().pendingRemoteOpen)
                m.consumeNotificationNavigation { opened++ }
                idle(m)
                assertEquals(phase, 1, opened)
                assertNull(phase, f.saved().pendingRemoteOpen)
            } finally { release.countDown(); m.viewModelScope.cancel() }
        }
    }

    @Test fun coldPendingOpenWaitsForOriginalLoginThenRevalidatesDeliveryAndTaskBeforeUiAck() {
        val f = Seed()
        val original = f.saved().pendingRemoteOpen!!
        val m = f.model(signedIn = false)
        m.resumeNativePushOpen()
        idle(m)
        assertTrue(f.wire.recorded().isEmpty())
        assertEquals(original, f.saved().pendingRemoteOpen)
        assertEquals(f.context.generation, f.saved().generation)
        assertNull(m.notificationOpenTarget)
        identity(m, f.wire.api.login("staff", "1234", false))
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(task, m.notificationOpenTarget?.id)
        assertEquals(tableSession, m.notificationOpenTarget?.session)
        assertEquals(original, f.saved().pendingRemoteOpen)
        val paths = f.wire.recorded().map { it.path }
        assertTrue(paths.indexOf("/api/auth/heartbeat") < paths.indexOf("/api/native/push/deliveries/$delivery/target"))
        assertTrue(paths.indexOf("/api/native/push/deliveries/$delivery/target") < paths.indexOf("/api/native-service-center"))
        var opened = 0
        m.consumeNotificationNavigation { opened++; assertEquals(task, it.id) }
        assertEquals(1, opened)
        assertNull(f.saved().pendingRemoteOpen)
        assertEquals("pending", m.serviceBoard!!.tasks.single().status)
        assertNull(m.livePending)
        assertNull(m.liveOrderPending)
        val local = NotificationRecoveryPersistence(f.localStore).read()
        assertNull(local.pending)
        assertTrue("Remote delivery must not become a fabricated 24-hour local authorization", local.consumed.isEmpty())
    }

    @Test fun processRestartDoesNotReuseAnEarlierVerifiedFocusOrInventNotificationExpiry() {
        val f = Seed()
        val first = f.model()
        first.resumeNativePushOpen()
        idle(first)
        assertNotNull(first.notificationOpenTarget)
        val original = f.saved().pendingRemoteOpen!!
        val targets = f.wire.targetReads()
        val tasks = f.wire.taskReads()
        first.viewModelScope.cancel()
        val restored = f.model()
        assertNull(restored.notificationOpenTarget)
        restored.resumeNativePushOpen()
        idle(restored)
        assertEquals(targets + 1, f.wire.targetReads())
        assertEquals(tasks + 1, f.wire.taskReads())
        assertEquals(original, f.saved().pendingRemoteOpen)
        var count = 0
        restored.consumeNotificationNavigation { count++ }
        restored.consumeNotificationNavigation { count++ }
        assertEquals(1, count)
        assertNull(f.saved().pendingRemoteOpen)
    }

    @Test fun unknownTargetOrTaskReadKeepsOriginalReferenceWithoutAnAutomaticRetryLoop() {
        for (failure in listOf("target", "task")) {
            val f = Seed()
            val original = f.saved().pendingRemoteOpen!!
            val m = f.model()
            if (failure == "target") f.wire.target = { throw IOException("offline target unknown") }
            else f.wire.service = { throw IOException("offline task unknown") }
            m.resumeNativePushOpen()
            idle(m)
            assertNull(failure, m.notificationOpenTarget)
            assertEquals(failure, original, f.saved().pendingRemoteOpen)
            assertTrue("Unknown remote open must keep the retry control visible", m.hasPendingNotification)
            val requests = f.wire.recorded().size
            val quietUntil = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100)
            do {
                shadowOf(Looper.getMainLooper()).idle()
                assertEquals(failure, requests, f.wire.recorded().size)
                Thread.sleep(2)
            } while (System.nanoTime() < quietUntil)
            f.wire.target = { request -> response(f.wire.targetData(request.path.split('/')[5])) }
            f.wire.service = { response(board()) }
            m.resumeNotificationOpen() // The shared retry button respects the remote backoff.
            idle(m)
            assertEquals(requests, f.wire.recorded().size)
            ShadowSystemClock.advanceBy(Duration.ofSeconds(60))
            m.resumeNotificationOpen()
            idle(m)
            assertEquals(failure, task, m.notificationOpenTarget?.id)
            assertEquals(failure, original, f.saved().pendingRemoteOpen)
            m.viewModelScope.cancel()
        }
    }

    @Test fun serverUnavailableOrExpiredTargetCannotOpenOrClaimTaskCompletion() {
        for (status in listOf(404, 410)) {
            val f = Seed()
            val m = f.model()
            f.wire.target = { denied(status, if (status == 410) "PUSH_TARGET_EXPIRED" else "PUSH_NOT_FOUND") }
            m.resumeNativePushOpen()
            idle(m)
            assertNull(m.notificationOpenTarget)
            assertNull(f.saved().pendingRemoteOpen)
            assertEquals(0, f.wire.taskReads())
            assertFalse(m.notificationOpenStatus.contains("已完成"))
            var count = 0
            m.consumeNotificationNavigation { count++ }
            assertEquals(0, count)
            m.viewModelScope.cancel()
        }
    }

    @Test fun missingClosedOrReusedTableSessionCannotBeSubstitutedForOriginalTask() {
        for (change in listOf("missing", "closed", "new-table-session")) {
            val f = Seed()
            val m = f.model()
            f.wire.service = {
                val current = board()
                when (change) {
                    "missing" -> current.put("tasks", JSONArray())
                    "closed" -> current.getJSONArray("tasks").getJSONObject(0).put("status", "completed")
                    else -> current.getJSONArray("tasks").getJSONObject(0).put("tableSessionId", otherDelivery)
                }
                response(current)
            }
            m.resumeNativePushOpen()
            idle(m)
            assertNull(change, m.notificationOpenTarget)
            assertNull(change, f.saved().pendingRemoteOpen)
            assertEquals(change, 1, f.wire.taskReads())
            assertFalse(change, m.notificationOpenStatus.contains("已完成"))
            assertNull(change, m.livePending)
            m.viewModelScope.cancel()
        }
    }

    @Test fun ownerAbaDuringTaskReadCannotRestoreRetiredOpenOrFocus() {
        val f = Seed()
        val m = f.model()
        val actor = m.identity!!
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        f.wire.service = {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            response(board())
        }
        try {
            m.resumeNativePushOpen()
            await("Original push task read was not entered") { entered.count == 0L }
            identity(m, actor.copy(employeeId = otherOwner.employeeId, sessionId = otherOwner.staffSessionId))
            identity(m, actor)
            release.countDown()
            idle(m)
            assertEquals(owner.employeeId, m.identity!!.employeeId)
            assertNull(m.notificationOpenTarget)
            assertNull(m.serviceBoard)
            assertNull(f.saved().pendingRemoteOpen)
            assertNull(f.saved().currentBinding)
            assertTrue(f.saved().generation > f.context.generation)
            assertEquals(f.installation.binding, f.saved().pendingRevocations().single().request.binding)
            var count = 0
            m.consumeNotificationNavigation { count++ }
            assertEquals(0, count)
        } finally { release.countDown() }
    }

    @Test fun supersedingClickGetsItsOwnFreshTargetAndBoardReadAfterOldReadReturns() {
        val f = Seed()
        val m = f.model()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val reads = AtomicInteger()
        f.wire.service = {
            if (reads.incrementAndGet() == 1) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
            response(board())
        }
        try {
            m.resumeNativePushOpen()
            await("First push task read was not entered") { entered.count == 0L }
            assertEquals(NativePushCallbackOutcome.STAGED, m.receiveNativePushPayload(f.context, payload(otherDelivery), opened = true))
            assertEquals(otherDelivery, f.saved().pendingRemoteOpen!!.deliveryId)
            assertEquals(1, reads.get())
            release.countDown()
            await("Replacement push did not get one new authorized read") { reads.get() == 2 && !m.businessRequestInFlight }
            assertEquals(listOf(delivery, otherDelivery), f.wire.recorded().filter { it.path.endsWith("/target") }.map { it.path.split('/')[5] })
            assertEquals(task, m.notificationOpenTarget?.id)
            var count = 0
            m.consumeNotificationNavigation { count++ }
            assertEquals(1, count)
            assertNull(f.saved().pendingRemoteOpen)
        } finally { release.countDown() }
    }

    @Test fun stopAfterInflightOrVerifiedPushRequiresFreshDeliveryAndTaskReadsOnReturn() {
        for (phase in listOf("reading", "verified")) {
            val f = Seed()
            val m = f.model()
            val original = f.saved().pendingRemoteOpen!!
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            if (phase == "reading") f.wire.service = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(board())
            }
            try {
                m.resumeNativePushOpen()
                if (phase == "reading") await("Inflight push was not entered") { entered.count == 0L }
                else { idle(m); assertNotNull(m.notificationOpenTarget) }
                m.foreground = false
                m.suspendNotificationOpen()
                release.countDown()
                idle(m)
                assertNull(phase, m.notificationOpenTarget)
                assertEquals(phase, original, f.saved().pendingRemoteOpen)
                val targets = f.wire.targetReads()
                val tasks = f.wire.taskReads()
                m.foreground = true
                var count = 0
                m.consumeNotificationNavigation { count++ }
                assertEquals(phase, 0, count)
                f.wire.service = { response(board()) }
                m.resumeNativePushOpen()
                idle(m)
                assertEquals(phase, targets + 1, f.wire.targetReads())
                assertEquals(phase, tasks + 1, f.wire.taskReads())
                m.consumeNotificationNavigation { count++ }
                assertEquals(phase, 1, count)
            } finally { release.countDown(); m.viewModelScope.cancel() }
        }
    }

    @Test fun failedUiPresentationDoesNotConsumeOriginalAndRetryRevalidatesDelivery() {
        val f = Seed()
        val m = f.model()
        val original = f.saved().pendingRemoteOpen!!
        m.resumeNativePushOpen()
        idle(m)
        m.consumeNotificationNavigation { error("Offline UI could not present task") }
        idle(m) // Drain the independent observation flush before explicitly retrying navigation.
        assertEquals(original, f.saved().pendingRemoteOpen)
        assertNull(m.notificationOpenTarget)
        var count = 0
        m.consumeNotificationNavigation { count++ }
        assertEquals(0, count)
        val targets = f.wire.targetReads()
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(targets + 1, f.wire.targetReads())
        m.consumeNotificationNavigation { count++ }
        assertEquals(1, count)
        assertNull(f.saved().pendingRemoteOpen)
    }

    @Test fun failedNewClickSaveKeepsNewestIntentAndRetrySavesItBeforeOpening() {
        val f = Seed()
        val m = f.model()
        m.resumeNativePushOpen()
        idle(m)
        assertNotNull(m.notificationOpenTarget)
        val old = f.saved().pendingRemoteOpen!!
        f.pushStore.failWrites = true
        assertEquals(NativePushCallbackOutcome.STORAGE_UNAVAILABLE,
            m.receiveNativePushPayload(f.context, payload(otherDelivery), opened = true))
        assertNull(m.notificationOpenTarget)
        assertEquals(old, f.saved().pendingRemoteOpen) // Failure cannot falsely claim a durable replacement.
        f.pushStore.failWrites = false
        val before = f.wire.targetReads()
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(before + 1, f.wire.targetReads())
        assertEquals(otherDelivery, f.saved().pendingRemoteOpen!!.deliveryId)
        assertEquals(otherDelivery, f.wire.recorded().last { it.path.endsWith("/target") }.path.split('/')[5])
        assertEquals(task, m.notificationOpenTarget?.id)
        var count = 0
        m.consumeNotificationNavigation { count++ }
        assertEquals(1, count)
    }

    @Test fun receivedCallbackOnlyReportsReceiptAndDoesNotCreateNavigationIntent() {
        val f = Seed(opened = false)
        val m = f.model()
        assertEquals(NativePushCallbackOutcome.STAGED, m.receiveNativePushPayload(f.context, payload(), opened = false))
        idle(m)
        assertNull(m.notificationOpenTarget)
        assertNull(f.saved().pendingRemoteOpen)
        assertEquals(0, f.wire.taskReads())
        val reports = f.wire.recorded().filter { it.path.endsWith("/observations") }
        assertEquals(1, reports.size)
        assertEquals("received", reports.single().body!!.getString("kind"))
        assertTrue(f.saved().pendingObservations().isEmpty())
        val before = f.wire.recorded().size
        m.resumeNativePushOpen()
        idle(m)
        assertEquals(before, f.wire.recorded().size)
    }

    @Test fun invalidNewRemoteClickCannotReviveEitherRemoteOrLocalInflightTask() {
        for (oldSource in listOf("remote", "local")) {
            val f = Seed(opened = oldSource == "remote")
            val m = f.model()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            f.wire.service = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(board())
            }
            try {
                if (oldSource == "remote") m.resumeNativePushOpen()
                else assertTrue(m.receiveNotificationTarget(localTarget("previous-local")))
                await("Original $oldSource task read was not entered") { entered.count == 0L }
                assertEquals(NativePushCallbackOutcome.INVALID,
                    m.receiveNativePushPayload(f.context, payload().put("url", "untrusted"), opened = true))
                release.countDown()
                idle(m)
                assertNull(oldSource, m.notificationOpenTarget)
                assertNull(oldSource, NotificationRecoveryPersistence(f.localStore).read().pending)
                val before = f.wire.recorded().size
                m.resumeNotificationOpen()
                idle(m)
                assertEquals(oldSource, before, f.wire.recorded().size)
                var count = 0
                m.consumeNotificationNavigation { count++ }
                assertEquals(oldSource, 0, count)
                m.viewModelScope.cancel()
                val taskReads = f.wire.taskReads()
                val targetReads = f.wire.targetReads()
                val restored = f.model()
                restored.resumeNotificationOpen()
                idle(restored)
                assertEquals(oldSource, taskReads, f.wire.taskReads())
                assertEquals(oldSource, targetReads, f.wire.targetReads())
                assertNull(oldSource, restored.notificationOpenTarget)
                assertNull(oldSource, f.saved().pendingRemoteOpen)
            } finally { release.countDown(); m.viewModelScope.cancel() }
        }
    }

    @Test fun localClickStillPersistsAndOpensWhenClearingOldPushReferenceCannotBeSaved() {
        val f = Seed()
        val m = f.model()
        m.resumeNativePushOpen()
        idle(m)
        assertNotNull(m.notificationOpenTarget)
        val oldRemote = f.saved().pendingRemoteOpen!!
        f.pushStore.failWrites = true
        val local = localTarget("current-local-click")
        val targetReads = f.wire.targetReads()
        assertTrue(m.receiveNotificationTarget(local))
        idle(m)
        assertEquals(oldRemote, f.saved().pendingRemoteOpen)
        assertEquals(local, NotificationRecoveryPersistence(f.localStore).read().pending!!.target)
        assertEquals(targetReads, f.wire.targetReads())
        assertEquals(task, m.notificationOpenTarget?.id)
        assertTrue(m.hasPendingNotification)
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        assertEquals(local, NotificationRecoveryPersistence(f.localStore).read().consumed.single().target)
        assertFalse(m.hasPendingNotification)
        val before = f.wire.recorded().size
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(before, f.wire.recorded().size)
        assertNull(m.notificationOpenTarget)
        f.pushStore.failWrites = false
    }

    @Test fun consumedLocalClickKeepsOldUncancelledRemoteSuppressedAcrossRestart() {
        val f = Seed()
        val m = f.model()
        val oldRemote = f.saved().pendingRemoteOpen!!
        f.pushStore.failWrites = true
        val local = localTarget("consumed-local-overrides-remote")
        assertTrue(m.receiveNotificationTarget(local))
        idle(m)
        assertEquals(task, m.notificationOpenTarget?.id)
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        val localState = NotificationRecoveryPersistence(f.localStore).read()
        assertNull(localState.pending)
        assertEquals(local, localState.consumed.single().target)
        assertEquals("The original push cancellation has not reached disk", oldRemote, f.saved().pendingRemoteOpen)
        assertFalse(m.hasPendingNotification)
        m.viewModelScope.cancel()

        f.pushStore.failWrites = false
        val targets = f.wire.targetReads()
        val tasks = f.wire.taskReads()
        val restored = f.model()
        restored.resumeNotificationOpen()
        idle(restored)
        restored.resumeNativePushOpen()
        idle(restored)
        assertEquals("Restart must not authorize a superseded remote delivery", targets, f.wire.targetReads())
        assertEquals(tasks, f.wire.taskReads())
        assertNull(restored.notificationOpenTarget)
        assertFalse(restored.hasPendingNotification)
        restored.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
    }

    @Test fun duplicateOpenedCallbacksAfterUiAckAndProcessRestartCannotNavigateAgain() {
        val f = Seed()
        val m = f.model()
        var opened = 0
        m.resumeNativePushOpen()
        idle(m)
        m.consumeNotificationNavigation { opened++ }
        idle(m)
        assertEquals(1, opened)
        assertNull(f.saved().pendingRemoteOpen)
        val tasks = f.wire.taskReads()
        assertEquals(NativePushCallbackOutcome.STAGED, m.receiveNativePushPayload(f.context, payload(), opened = true))
        idle(m)
        m.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        assertEquals(tasks, f.wire.taskReads())
        assertNull(m.notificationOpenTarget)
        m.viewModelScope.cancel()
        val restored = f.model()
        assertEquals(NativePushCallbackOutcome.STAGED,
            restored.receiveNativePushPayload(f.context, payload(), opened = true))
        idle(restored)
        restored.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        assertEquals(tasks, f.wire.taskReads())
        assertNull(restored.notificationOpenTarget)
        assertFalse(restored.hasPendingNotification)
    }

    @Test fun invalidRemoteClickWithFailedPushSaveLeavesCrossStoreBarrierAcrossRestart() {
        val f = Seed()
        val m = f.model()
        val oldRemote = f.saved().pendingRemoteOpen!!
        f.pushStore.failWrites = true
        assertEquals(NativePushCallbackOutcome.STORAGE_UNAVAILABLE,
            m.receiveNativePushPayload(f.context, payload(otherDelivery).put("url", "untrusted"), opened = true))
        idle(m)
        assertEquals("The original remote cancellation could not reach its own store", oldRemote, f.saved().pendingRemoteOpen)
        val localPersistence = NotificationRecoveryPersistence(f.localStore)
        assertEquals(oldRemote.requestKey, localPersistence.suppressedRemoteRequestKey())
        assertNull(localPersistence.read().pending)
        assertNull(m.notificationOpenTarget)
        m.viewModelScope.cancel()

        f.pushStore.failWrites = false
        val targets = f.wire.targetReads()
        val tasks = f.wire.taskReads()
        val restored = f.model()
        restored.resumeNotificationOpen()
        idle(restored)
        restored.resumeNativePushOpen()
        idle(restored)
        assertEquals("Invalid newer click must keep the old delivery suppressed after restart", targets, f.wire.targetReads())
        assertEquals(tasks, f.wire.taskReads())
        assertNull(restored.notificationOpenTarget)
        assertFalse(restored.hasPendingNotification)
        var opened = 0
        restored.consumeNotificationNavigation { opened++ }
        assertEquals(0, opened)
    }

    @Test fun remoteRateLimitLeavesRetryVisibleAndSharedButtonHonorsRetryAfter() {
        val f = Seed()
        val m = f.model()
        f.wire.target = {
            denied(429, "PUSH_RATE_LIMITED").copy(headers = mapOf("Retry-After" to listOf("180")))
        }
        m.resumeNativePushOpen()
        idle(m)
        assertTrue(m.hasPendingNotification)
        assertNotNull(f.saved().pendingRemoteOpen)
        assertNull(m.notificationOpenTarget)
        val before = f.wire.recorded().size
        f.wire.target = { request -> response(f.wire.targetData(request.path.split('/')[5])) }
        ShadowSystemClock.advanceBy(Duration.ofSeconds(179))
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(before, f.wire.recorded().size)
        assertTrue(m.hasPendingNotification)
        ShadowSystemClock.advanceBy(Duration.ofSeconds(1))
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(task, m.notificationOpenTarget?.id)
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        idle(m)
        assertEquals(1, opened)
        assertFalse(m.hasPendingNotification)
    }

    @Before fun prepare() {
        app = RuntimeEnvironment.getApplication()
        app.getSharedPreferences("getui-employee-consent-v1", 0).edit().clear().commit()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        app.noBackupFilesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    @After fun finish() {
        models.forEach { it.viewModelScope.cancel() }
        shadowOf(Looper.getMainLooper()).idle()
        for (wire in wires) {
            val recorded = wire.recorded()
            assertTrue("Only auth and client observations may write; no registration or business command",
                recorded.filter { it.body != null }.all { it.path.startsWith("/api/auth/") ||
                    it.method == "POST" && it.path.startsWith("/api/native/push/deliveries/") && it.path.endsWith("/observations") })
            assertTrue("No registration PUT is permitted", recorded.none { it.method == "PUT" })
            recorded.filter { it.path.endsWith("/target") || it.path == "/api/native-service-center" }.forEach { request ->
                assertEquals("GET", request.method)
                assertEquals(owner.employeeId, request.headers["x-mbox-staff-employee-id"])
                assertEquals(owner.staffSessionId, request.headers["x-mbox-staff-session-id"])
                assertTrue(request.headers.entries.any { it.key.equals("Cookie", true) && it.value.contains("offline-push-session") })
            }
        }
    }
}
