package com.mbox.staff

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import java.io.IOException
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
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** Real AppModel coroutines, real StaffAPI cookies and entirely injected offline transport. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class AppModelNotificationTest {
    private lateinit var app: Application
    private val models = mutableListOf<AppModel>()
    private val wires = mutableListOf<OfflineWire>()

    private class MemoryStore : NotificationStateStore {
        @Volatile var value: String? = null
        @Volatile var failWrites = false
        override fun read() = value
        override fun write(value: String) {
            check(!failWrites) { "fixture notification storage unavailable" }
            this.value = value
        }
        override fun remove() { value = null }
    }

    private fun fixture() = JSONObject(javaClass.classLoader!!.getResourceAsStream("live-service.json")!!
        .bufferedReader().use { it.readText() })

    private fun response(data: JSONObject, cookie: Boolean = false) = APIResponse(
        200, JSONObject().put("data", data).toString(),
        if (cookie) mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=offline-notification-session; Path=/; Secure; HttpOnly; Max-Age=3600")) else emptyMap(),
    )

    private inner class OfflineWire {
        val auth: JSONObject = fixture().getJSONObject("auth")
            .put("permissions", JSONArray(listOf("service.view", "service.execute")))
            .put("deniedPermissions", JSONArray())
        private val requests = Collections.synchronizedList(mutableListOf<APIRequest>())
        @Volatile var service: (APIRequest) -> APIResponse = { response(fixture().getJSONObject("board")) }
        val api = StaffAPI { request ->
            requests.add(request)
            when (request.path) {
                "/api/auth/login", "/api/auth/switch" -> response(auth, cookie = true)
                "/api/auth/heartbeat" -> response(auth)
                "/api/native-service-center" -> service(request)
                else -> throw IOException("Unexpected offline notification route: ${request.path}")
            }
        }
        fun recorded(): List<APIRequest> = synchronized(requests) { requests.toList() }
        fun serviceReads() = recorded().count { it.path == "/api/native-service-center" }
    }

    @Before fun prepare() {
        app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        app.noBackupFilesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    @After fun finish() {
        models.forEach { it.viewModelScope.cancel() }
        shadowOf(Looper.getMainLooper()).idle()
        for (wire in wires) {
            val recorded = wire.recorded()
            assertEquals("Opening a notification must never POST a business command", emptyList<APIRequest>(), recorded.filter { it.body != null && !it.path.startsWith("/api/auth/") })
            assertTrue("No fallback or real server route is allowed", recorded.all { it.path in setOf("/api/auth/login", "/api/auth/switch", "/api/auth/heartbeat", "/api/native-service-center") })
            recorded.filter { it.path == "/api/native-service-center" }.forEach { request ->
                assertNull(request.body)
                assertEquals("employee-1", request.headers["x-mbox-staff-employee-id"])
                assertEquals("session-1", request.headers["x-mbox-staff-session-id"])
                assertTrue("Service read must carry the cookie issued by the fake login", request.headers.entries.any { it.key.equals("Cookie", true) && it.value.contains("offline-notification-session") })
            }
        }
    }

    private fun wire() = OfflineWire().also { wires += it }
    private fun model(store: MemoryStore, wire: OfflineWire, signedIn: Boolean = true, pushStore: MemoryStore = MemoryStore()): AppModel {
        val actor = if (signedIn) wire.api.login("staff", "1234", false) else null
        return AppModel(app, notificationStoreOverride = store, apiOverride = wire.api, pushStateStoreOverride = pushStore).also {
            models += it
            if (actor != null) identity(it, actor)
            it.foreground = true
        }
    }

    private fun identity(model: AppModel, value: StaffIdentity?) {
        // Exercise the real owner-reconciliation setter; never bypass the backing state.
        AppModel::class.java.getDeclaredMethod("setIdentity", StaffIdentity::class.java)
            .apply { isAccessible = true }.invoke(model, value)
    }

    private fun target(id: String = "notification-1"): NotificationTaskTarget {
        val at = Instant.now()
        return NotificationTaskTarget(id, "employee-1", "session-1", "task-1", "session-old", at.minusSeconds(5), at.plusSeconds(600))
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

    private fun idle(model: AppModel) = await("AppModel notification read did not finish") { !model.businessRequestInFlight }
    private fun persisted(store: MemoryStore) = NotificationRecoveryPersistence(store).read()

    @Test fun explicitClosedTaskRoutePreservesLocalClickUntilSameSessionRouteReturns() {
        for (restoredRoute in listOf("explicit", "legacy-omitted")) {
            val store = MemoryStore()
            val offline = wire()
            offline.auth.put("navigation", JSONArray())
            val m = model(store, offline)
            val original = target("route-closed-$restoredRoute")
            assertTrue(m.identity!!.allows("service.view"))
            assertEquals(emptyList<String>(), m.identity!!.navigationRoutes)
            assertTrue(m.receiveNotificationTarget(original))
            idle(m)
            assertEquals(0, offline.serviceReads())
            assertNull(m.notificationOpenTarget)
            assertEquals(original, persisted(store).pending!!.target)
            var opened = 0
            m.consumeNotificationNavigation { opened++ }
            assertEquals(0, opened)
            assertEquals(original, persisted(store).pending!!.target)
            assertTrue(persisted(store).consumed.isEmpty())

            if (restoredRoute == "explicit") offline.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
            else offline.auth.remove("navigation")
            identity(m, offline.api.heartbeat())
            assertEquals(original.employeeId, m.identity!!.employeeId)
            assertEquals(original.staffSessionId, m.identity!!.sessionId)
            m.resumeNotificationOpen()
            idle(m)
            assertEquals(1, offline.serviceReads())
            assertEquals(original.taskId, m.notificationOpenTarget?.id)
            m.consumeNotificationNavigation { opened++ }
            assertEquals(1, opened)
            assertEquals(original, persisted(store).consumed.single().target)
            m.viewModelScope.cancel()
        }
    }

    @Test fun heartbeatRemovingTaskRouteStopsLocalTaskReadWithoutConsumingPending() {
        val store = MemoryStore()
        val offline = wire()
        offline.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
        val m = model(store, offline)
        val original = target("heartbeat-route-closed")
        offline.auth.put("navigation", JSONArray())
        assertTrue(m.receiveNotificationTarget(original))
        idle(m)
        assertEquals(emptyList<String>(), m.identity!!.navigationRoutes)
        assertTrue(m.identity!!.allows("service.view"))
        assertEquals(0, offline.serviceReads())
        assertNull(m.notificationOpenTarget)
        assertEquals(original, persisted(store).pending!!.target)
        var opened = false
        m.consumeNotificationNavigation { opened = true }
        assertFalse(opened)
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(persisted(store).consumed.isEmpty())
    }

    @Test fun localUiClaimCannotOpenAfterTaskRouteClosesAndMustReadAgainWhenRestored() {
        val store = MemoryStore()
        val offline = wire()
        val m = model(store, offline)
        val original = target("route-closed-before-ui")
        assertNull(m.identity!!.navigationRoutes) // Older responses omit navigation and remain supported.
        m.receiveNotificationTarget(original)
        idle(m)
        assertNotNull(m.notificationOpenTarget)
        val actor = m.identity!!
        identity(m, actor.copy(navigationRoutes = emptyList()))
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        assertEquals(0, opened)
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(persisted(store).consumed.isEmpty())
        val reads = offline.serviceReads()
        identity(m, actor)
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(reads + 1, offline.serviceReads())
        m.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        assertEquals(original, persisted(store).consumed.single().target)
    }

    @Test fun taskRouteClosingDuringLocalBoardReadPreservesLatestClickUntilFreshAllowedRead() {
        for (superseded in listOf(false, true)) {
            val store = MemoryStore()
            val offline = wire()
            offline.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
            val m = model(store, offline)
            val original = target("inflight-local-route")
            val latest = if (superseded) target("newer-local-while-route-closed") else original
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            offline.service = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(fixture().getJSONObject("board"))
            }
            try {
                assertTrue(m.receiveNotificationTarget(original))
                await("Local board read was not entered") { entered.count == 0L }
                offline.auth.put("navigation", JSONArray())
                identity(m, m.identity!!.copy(navigationRoutes = emptyList()))
                if (superseded) assertTrue(m.receiveNotificationTarget(latest))
                assertEquals(latest, persisted(store).pending!!.target)
                release.countDown()
                idle(m)
                assertNull(m.notificationOpenTarget)
                assertNull(m.serviceBoard)
                assertEquals(1, offline.serviceReads())
                assertEquals(latest, persisted(store).pending!!.target)
                assertTrue(persisted(store).consumed.isEmpty())
                var opened = 0
                m.consumeNotificationNavigation { opened++ }
                assertEquals(0, opened)

                offline.auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
                identity(m, offline.api.heartbeat())
                m.resumeNotificationOpen()
                idle(m)
                assertEquals(2, offline.serviceReads())
                assertEquals(latest.taskId, m.notificationOpenTarget?.id)
                m.consumeNotificationNavigation { opened++ }
                assertEquals(1, opened)
                assertEquals(latest, persisted(store).consumed.single().target)
            } finally { release.countDown(); m.viewModelScope.cancel() }
        }
    }

    @Test fun coldStartRetainsPendingAndRealLoginThenFreshReadsFocusTheOriginalTask() {
        val store = MemoryStore(); val original = target()
        val beforeRestart = model(store, wire(), signedIn = false)
        assertTrue(beforeRestart.receiveNotificationTarget(original))
        assertTrue(beforeRestart.hasPendingNotification)
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(beforeRestart.notificationOpenStatus.contains("登录"))
        assertNull(beforeRestart.notificationOpenTarget)
        beforeRestart.viewModelScope.cancel()

        val offline = wire(); val restored = model(store, offline, signedIn = false)
        restored.resumeNotificationOpen()
        assertEquals(0, offline.recorded().size)
        assertTrue(restored.hasPendingNotification)
        restored.login("staff", "1234")
        idle(restored)
        assertEquals(original.taskId, restored.notificationOpenTarget?.id)
        assertEquals(original.tableSessionId, restored.notificationOpenTarget?.session)
        assertTrue(restored.hasPendingNotification) // Focus has not yet been presented.
        val opened = mutableListOf<ServiceAttention.Entry>()
        restored.consumeNotificationNavigation { opened += it }
        assertEquals(listOf(original.taskId), opened.map { it.id })
        assertFalse(restored.hasPendingNotification)
        assertNull(persisted(store).pending)
        assertEquals(original, persisted(store).consumed.single().target)
        assertEquals("pending", restored.serviceBoard!!.tasks.single().status)
    }

    @Test fun networkUnknownKeepsOriginalStoredReferenceAndRetryUsesFreshTaskRead() {
        val store = MemoryStore(); val offline = wire(); val m = model(store, offline); val original = target()
        offline.service = { throw IOException("offline reply not available") }
        assertTrue(m.receiveNotificationTarget(original))
        idle(m)
        assertTrue(m.hasPendingNotification)
        assertNull(m.notificationOpenTarget)
        assertTrue(m.notificationOpenStatus.contains("无法核实"))
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(persisted(store).consumed.isEmpty())
        val reads = offline.serviceReads()
        offline.service = { response(fixture().getJSONObject("board")) }
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(reads + 1, offline.serviceReads())
        assertEquals(original.taskId, m.notificationOpenTarget?.id)
        val opened = AtomicInteger()
        m.consumeNotificationNavigation { opened.incrementAndGet() }
        assertEquals(1, opened.get())
        assertEquals(original, persisted(store).consumed.single().target)
    }

    @Test fun delayedOldEmployeeResponseCannotRefillOrOpenTheNewEmployeesWorkspace() {
        val store = MemoryStore(); val offline = wire(); val m = model(store, offline); val original = target()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        offline.service = {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "Test must release the delayed response" }
            response(fixture().getJSONObject("board"))
        }
        try {
            m.receiveNotificationTarget(original)
            await("Service read was not entered") { entered.count == 0L }
            identity(m, m.identity!!.copy(employeeId = "employee-2", sessionId = "session-2"))
            release.countDown()
            idle(m)
            assertEquals("employee-2", m.identity!!.employeeId)
            assertNull(m.notificationOpenTarget)
            assertNull(m.serviceBoard)
            assertEquals(original, persisted(store).pending!!.target)
            assertTrue(persisted(store).consumed.isEmpty())
            val reads = offline.serviceReads()
            m.resumeNotificationOpen()
            idle(m)
            assertEquals(reads, offline.serviceReads())
            assertNull(m.notificationOpenTarget)
            assertTrue(m.notificationOpenStatus.contains("原员工"))
        } finally { release.countDown() }
    }

    @Test fun missingEndedOrChangedTableTaskNeverCompletesOrOpensBusinessWork() {
        for (kind in listOf("missing", "completed", "changed-table-session")) {
            val store = MemoryStore(); val offline = wire(); val m = model(store, offline)
            offline.service = {
                val board = fixture().getJSONObject("board")
                when (kind) {
                    "missing" -> board.put("tasks", JSONArray())
                    "completed" -> board.getJSONArray("tasks").getJSONObject(0).put("status", "completed")
                    else -> board.getJSONArray("tasks").getJSONObject(0).put("tableSessionId", "new-table-session-same-table-number")
                }
                response(board)
            }
            m.receiveNotificationTarget(target("notification-$kind"))
            idle(m)
            assertNull(kind, m.notificationOpenTarget)
            assertFalse(kind, m.hasPendingNotification)
            assertTrue(kind, persisted(store).consumed.isEmpty())
            assertFalse(kind, m.notificationOpenStatus.contains("已完成"))
            var opened = false
            m.consumeNotificationNavigation { opened = true }
            assertFalse(kind, opened)
            assertNull(m.livePending)
            assertNull(m.liveOrderPending)
        }
    }

    @Test fun duplicateIntentDuringReadAndAfterColdStartDoesNotFocusTwice() {
        val store = MemoryStore(); val offline = wire(); val m = model(store, offline); val original = target()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        offline.service = {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            response(fixture().getJSONObject("board"))
        }
        try {
            m.receiveNotificationTarget(original)
            await("Service read was not entered") { entered.count == 0L }
            assertTrue(m.receiveNotificationTarget(original))
            assertEquals(1, offline.serviceReads())
            release.countDown()
            idle(m)
            val count = AtomicInteger()
            m.consumeNotificationNavigation { count.incrementAndGet() }
            m.receiveNotificationTarget(original)
            idle(m)
            m.consumeNotificationNavigation { count.incrementAndGet() }
            assertEquals(1, count.get())
            assertEquals(1, offline.serviceReads())
            assertEquals(1, persisted(store).consumed.size)
            m.viewModelScope.cancel()
            val freshWire = wire(); val freshModel = model(store, freshWire)
            freshModel.receiveNotificationTarget(original)
            idle(freshModel)
            freshModel.consumeNotificationNavigation { count.incrementAndGet() }
            assertEquals(1, count.get())
            assertEquals(0, freshWire.serviceReads())
            assertEquals(1, persisted(store).consumed.size)
        } finally { release.countDown() }
    }

    @Test fun invalidNewClickCancelsOldPendingNavigationAcrossAutomaticRetryAndRestart() {
        for (kind in listOf("invalid", "expired", "wrong-employee", "wrong-session")) {
            val store = MemoryStore(); val offline = wire(); val m = model(store, offline)
            val original = target("old-$kind")
            offline.service = { throw IOException("offline") }
            m.receiveNotificationTarget(original)
            idle(m)
            assertEquals(original, persisted(store).pending!!.target)
            val fresh = target("new-$kind")
            val rejected = when (kind) {
                "invalid" -> fresh.copy(taskId = "")
                "expired" -> fresh.copy(issuedAt = fresh.issuedAt.minusSeconds(30), expiresAt = fresh.issuedAt)
                "wrong-employee" -> fresh.copy(employeeId = "employee-2")
                else -> fresh.copy(staffSessionId = "different-login")
            }
            val reads = offline.serviceReads()
            offline.service = { response(fixture().getJSONObject("board")) }
            assertTrue(m.receiveNotificationTarget(rejected))
            m.resumeNotificationOpen()
            idle(m)
            assertEquals(kind, reads, offline.serviceReads())
            assertNull(kind, m.notificationOpenTarget)
            assertNull(kind, persisted(store).pending)
            assertTrue(kind, persisted(store).consumed.isEmpty())
            val restoredWire = wire(); val restored = model(store, restoredWire)
            restored.resumeNotificationOpen()
            idle(restored)
            assertEquals(kind, 0, restoredWire.serviceReads())
            assertNull(kind, restored.notificationOpenTarget)
        }
    }

    @Test fun failedNavigationCallbackCannotConsumeWithoutFocusAndCanRetryTheOriginalTarget() {
        val store = MemoryStore(); val offline = wire(); val m = model(store, offline); val original = target()
        m.receiveNotificationTarget(original)
        idle(m)
        assertNotNull(m.notificationOpenTarget)
        m.consumeNotificationNavigation { error("UI navigation could not be presented") }
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(persisted(store).consumed.isEmpty())
        var opened = 0
        m.consumeNotificationNavigation { opened++ }
        assertEquals(0, opened)
        assertEquals(original, persisted(store).pending!!.target)
        assertTrue(persisted(store).consumed.isEmpty())
        val reads = offline.serviceReads()
        m.resumeNotificationOpen()
        idle(m)
        assertEquals(reads + 1, offline.serviceReads())
        assertEquals(original.taskId, m.notificationOpenTarget?.id)
        m.consumeNotificationNavigation { opened++ }
        assertEquals(1, opened)
        assertEquals(original, persisted(store).consumed.single().target)
    }

    @Test fun realIdentitySetterRetiresTheOriginalBindingOnEmployeeSessionLogoutAndServiceRevocation() {
        val owner = NativePushOwner("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
        val anotherEmployee = "33333333-3333-4333-8333-333333333333"
        val anotherSession = "44444444-4444-4444-8444-444444444444"
        val delivery = "55555555-5555-4555-8555-555555555555"
        val requestKey = "native-push-77777777-7777-4777-8777-777777777777"
        // Fixture bytes only, never a provider registration or production capability.
        val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })
        for (change in listOf("employee", "session", "logout", "permissions-removed", "permissions-denied")) {
            val offline = wire()
            val actor = StaffIdentity.parse(offline.auth).copy(employeeId = owner.employeeId, sessionId = owner.staffSessionId)
            val pushStore = MemoryStore()
            val seeded = NativePushLifecycle(pushStore)
            seeded.reconcileOwner(owner)
            val installation = NativePushInstallation(owner, NativePushBinding(seeded.installationId, 1),
                NativePushInstallationStatus.ACTIVE, true, Instant.parse("2099-01-01T00:00:00Z"), requestKey)
            assertTrue(seeded.recordVerifiedInstallation(installation, seeded.generation, secret))
            assertNotNull(seeded.stageRemoteOpen(owner, installation.binding, delivery, seeded.generation))
            assertNotNull(seeded.stageObservation(NativePushObservationRequest(owner, installation.binding,
                delivery, NativePushObservationKind.OPENED, requestKey), seeded.generation))
            val m = model(MemoryStore(), offline, signedIn = false, pushStore = pushStore)
            identity(m, actor)
            assertEquals(change, installation.binding, NativePushLifecycle(pushStore).currentBinding)
            assertEquals(change, 0, m.pendingPushRevocations)
            val next = when (change) {
                "employee" -> actor.copy(employeeId = anotherEmployee, sessionId = anotherSession)
                "session" -> actor.copy(sessionId = anotherSession)
                "logout" -> null
                "permissions-removed" -> actor.copy(permissions = emptySet())
                else -> actor.copy(denied = actor.permissions)
            }
            identity(m, next)
            val restored = NativePushLifecycle(pushStore)
            assertNull(change, restored.currentBinding)
            assertEquals(change, seeded.installationId, restored.installationId)
            assertEquals(change, seeded.generation + 1, restored.generation)
            assertFalse(change, restored.remoteEnabled)
            assertNull(change, restored.pendingRemoteOpen)
            assertEquals(change, 0, restored.pendingObservationCount)
            assertEquals(change, 1, restored.pendingRevocationCount)
            assertEquals(change, 1, m.pendingPushRevocations)
            val slot = restored.pendingRevocations().single()
            assertEquals(change, owner, slot.request.owner)
            assertEquals(change, installation.binding, slot.request.binding)
            assertEquals(change, secret, JSONObject(slot.capability!!.body).getString("revocationSecret"))
            assertEquals(change, next?.takeIf { it.canReadService() }?.let(NativePushOwner::from), restored.owner)
            identity(m, next) // Same setter value must not create another generation or revoke request.
            val repeated = NativePushLifecycle(pushStore)
            assertEquals(change, restored.generation, repeated.generation)
            assertEquals(change, slot.request, repeated.pendingRevocations().single().request)
            assertTrue("Setter must not send registration, observation, revoke or auth requests: $change", offline.recorded().isEmpty())
        }
    }

    @Test fun backgroundSuspendsBothInflightAndVerifiedFocusUntilANewForegroundRead() {
        for (phase in listOf("in-flight", "already-verified")) {
            val store = MemoryStore(); val offline = wire(); val m = model(store, offline); val original = target(phase)
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            if (phase == "in-flight") offline.service = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                response(fixture().getJSONObject("board"))
            }
            try {
                m.receiveNotificationTarget(original)
                if (phase == "in-flight") await("Service read was not entered") { entered.count == 0L }
                else { idle(m); assertNotNull(m.notificationOpenTarget) }
                m.foreground = false
                m.suspendNotificationOpen()
                release.countDown()
                idle(m)
                assertNull(phase, m.notificationOpenTarget)
                assertEquals(phase, original, persisted(store).pending!!.target)
                assertTrue(phase, persisted(store).consumed.isEmpty())
                val beforeResume = offline.serviceReads()
                var opened = 0
                m.foreground = true
                m.consumeNotificationNavigation { opened++ }
                assertEquals(phase, 0, opened)
                assertEquals(phase, beforeResume, offline.serviceReads())
                offline.service = { response(fixture().getJSONObject("board")) }
                m.resumeNotificationOpen()
                idle(m)
                assertEquals(phase, beforeResume + 1, offline.serviceReads())
                assertEquals(phase, original.taskId, m.notificationOpenTarget?.id)
                m.consumeNotificationNavigation { opened++ }
                assertEquals(phase, 1, opened)
                assertEquals(phase, original, persisted(store).consumed.single().target)
            } finally { release.countDown(); m.viewModelScope.cancel() }
        }
    }

    @Test fun secondClickDuringAnInflightReadGetsOneFreshReadAndUnknownDoesNotLoop() {
        for (secondFails in listOf(false, true)) {
            val store = MemoryStore(); val offline = wire(); val m = model(store, offline)
            val first = target("first-$secondFails"); val latest = target("second-$secondFails")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val reads = AtomicInteger()
            offline.service = {
                if (reads.incrementAndGet() == 1) {
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                } else if (secondFails) throw IOException("latest task read is unknown")
                response(fixture().getJSONObject("board"))
            }
            try {
                m.receiveNotificationTarget(first)
                await("First service read was not entered") { entered.count == 0L }
                assertTrue(m.receiveNotificationTarget(latest))
                assertEquals(latest, persisted(store).pending!!.target)
                assertEquals(1, reads.get())
                release.countDown()
                await("Latest notification did not receive exactly one replacement read") {
                    reads.get() >= 2 && !m.businessRequestInFlight
                }
                assertEquals(2, reads.get())
                if (secondFails) {
                    assertNull(m.notificationOpenTarget)
                    assertEquals(latest, persisted(store).pending!!.target)
                    assertTrue(persisted(store).consumed.isEmpty())
                    assertTrue(m.notificationOpenStatus.contains("无法核实"))
                    // Pump queued continuations for a bounded interval without initiating retry.
                    val quietDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100)
                    do {
                        shadowOf(Looper.getMainLooper()).idle()
                        assertEquals("An unchanged failed intent must not automatically retry", 2, reads.get())
                        Thread.sleep(2)
                    } while (System.nanoTime() < quietDeadline)
                } else {
                    var opened = 0
                    m.consumeNotificationNavigation { opened++ }
                    assertEquals(1, opened)
                    assertEquals(latest, persisted(store).consumed.single().target)
                    assertNull(persisted(store).pending)
                }
            } finally { m.viewModelScope.cancel(); release.countDown() }
        }
    }

    @Test fun failedSaveRetainsTheLatestReplacementOrDismissalAndNeverReopensTheOldIntent() {
        for (action in listOf("replace", "dismiss", "replace-then-dismiss")) {
            val store = MemoryStore(); val offline = wire(); val m = model(store, offline)
            val original = target("original-$action"); val latest = target("latest-$action")
            m.receiveNotificationTarget(original)
            idle(m)
            assertNotNull(m.notificationOpenTarget)
            val originalReads = offline.serviceReads()
            store.failWrites = true
            if (action != "dismiss") assertFalse(m.receiveNotificationTarget(latest))
            if (action != "replace") m.dismissNotificationOpen()
            assertEquals("A failed atomic write leaves the original disk bytes intact", original, persisted(store).pending!!.target)
            assertNull(action, m.notificationOpenTarget)
            var opened = 0
            m.consumeNotificationNavigation { opened++ }
            m.resumeNotificationOpen()
            idle(m)
            assertEquals(action, 0, opened)
            assertEquals(action, originalReads, offline.serviceReads())
            assertNull(action, m.notificationOpenTarget)
            store.failWrites = false
            m.resumeNotificationOpen()
            idle(m)
            if (action == "replace") {
                assertEquals(action, originalReads + 1, offline.serviceReads())
                assertEquals(action, latest, persisted(store).pending!!.target)
                m.consumeNotificationNavigation { opened++ }
                assertEquals(action, 1, opened)
                assertEquals(action, latest, persisted(store).consumed.single().target)
            } else {
                assertEquals(action, originalReads, offline.serviceReads())
                assertNull(action, m.notificationOpenTarget)
                assertTrue(action, persisted(store).consumed.isEmpty())
            }
            assertNull(action, persisted(store).pending)
            val restoredWire = wire(); val restored = model(store, restoredWire)
            restored.resumeNotificationOpen()
            idle(restored)
            restored.consumeNotificationNavigation { opened++ }
            assertEquals(action, 0, restoredWire.serviceReads())
            assertEquals(action, if (action == "replace") 1 else 0, opened)
        }
    }

    @Test fun sameEmployeeNewLoginSessionDoesNotAdoptTheOldNotification() {
        val store = MemoryStore(); val offline = wire(); val m = model(store, offline)
        val original = target()
        identity(m, m.identity!!.copy(sessionId = "new-login"))
        m.receiveNotificationTarget(original)
        idle(m)
        assertNull(m.notificationOpenTarget)
        assertEquals(0, offline.serviceReads())
        assertTrue(m.notificationOpenStatus.contains("原登录会话"))
        assertTrue(persisted(store).consumed.isEmpty())
        assertNull(m.livePending)
    }
}
