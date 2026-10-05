package com.mbox.staff

import android.app.Application
import android.os.Looper
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.cancel
import androidx.lifecycle.viewModelScope
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

/** Real AppModel coroutines with an offline StaffAPI transport; no server or production identity. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class WorkspaceModelRefreshTest {
    private lateinit var model: AppModel
    private lateinit var actor: StaffIdentity
    private lateinit var auth: JSONObject
    private val requests = AtomicInteger()
    @Volatile private var reply: (APIRequest) -> APIResponse = { error("transport not initialized") }

    private fun fixture(name: String) = JSONObject(javaClass.classLoader!!
        .getResourceAsStream(name)!!.bufferedReader().use { it.readText() })

    private fun setState(name: String, value: Any?) {
        AppModel::class.java.declaredMethods.single { it.name == "set$name" && it.parameterCount == 1 }
            .also { it.isAccessible = true }.invoke(model, value)
    }

    @Before fun setUp() {
        val app: Application = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        auth = fixture("live-service.json").getJSONObject("auth")
            .put("permissions", JSONArray(listOf("kds.prepare", "kds.deliver", "staff.access.configure", "service.execute", "service.manage")))
            .put("deniedPermissions", JSONArray())
        reply = { request ->
            when {
                request.path.startsWith("/api/auth/") -> response(auth)
                request.path.startsWith("/api/commerce/kitchen-board") -> response(fixture("live-kitchen.json"))
                request.path == "/api/commerce/pickup-board" -> response(fixture("live-pickup.json"))
                request.path == "/api/native-service-center" -> response(fixture("live-service.json").getJSONObject("board"))
                request.path == "/api/operations" -> response(fixture("live-service.json").getJSONObject("operations"))
                else -> error("Unexpected offline test path: ${request.path}")
            }
        }
        val api = StaffAPI { request -> requests.incrementAndGet(); reply(request) }
        actor = api.login("staff", "1234", false)
        model = AppModel(app)
        AppModel::class.java.getDeclaredField("api").also { it.isAccessible = true }.set(model, api)
        setState("Identity", actor)
        model.foreground = true
        requests.set(0)
    }

    @After fun tearDown() {
        model.viewModelScope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun response(data: JSONObject) = APIResponse(200, JSONObject().put("data", data).toString())

    private fun awaitIdle() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (model.businessRequestInFlight && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(2)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse("AppModel read did not finish", model.businessRequestInFlight)
    }

    private fun awaitEntered(latch: CountDownLatch) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (latch.count > 0 && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(2)
        }
        assertEquals("Offline transport did not receive the request", 0L, latch.count)
    }

    @Test fun failedAutomaticReadsRetainRealBoardsDisableActionsAndManualRefreshRestoresThem() {
        model.loadKitchen("kitchen"); awaitIdle()
        model.loadPickup(); awaitIdle()
        model.loadService(); awaitIdle()
        val kitchen = model.kitchenBoard
        val pickup = model.pickupBoard
        val service = model.serviceBoard
        assertNotNull(kitchen); assertNotNull(pickup); assertNotNull(service)
        assertTrue(model.canAct("kds.prepare")); assertTrue(model.canAct("kds.deliver")); assertTrue(model.canUseService)
        val original = reply
        reply = { request -> if (request.path.startsWith("/api/auth/")) original(request) else throw IOException("offline") }
        model.loadKitchen("kitchen", automatic = true); awaitIdle()
        model.loadPickup(automatic = true); awaitIdle()
        model.loadService(automatic = true); awaitIdle()
        assertSame(kitchen, model.kitchenBoard); assertSame(pickup, model.pickupBoard); assertSame(service, model.serviceBoard)
        assertTrue(model.kitchenState.contains("已过期")); assertTrue(model.pickupState.contains("已过期")); assertTrue(model.serviceState.contains("已过期"))
        assertFalse(model.canAct("kds.prepare")); assertFalse(model.canAct("kds.deliver")); assertFalse(model.canUseService)
        reply = original
        model.loadKitchen("kitchen"); awaitIdle()
        model.loadPickup(); awaitIdle()
        model.loadService(); awaitIdle()
        assertTrue(model.canAct("kds.prepare")); assertTrue(model.canAct("kds.deliver")); assertTrue(model.canUseService)
    }

    @Test fun businessAndHeartbeatLocksPreventAllThreeQueueReadsWithoutClearingData() {
        model.loadKitchen("kitchen"); awaitIdle()
        val previous = model.kitchenBoard
        val before = requests.get()
        for (state in listOf("Busy", "HeartbeatBusy")) {
            setState(state, true)
            model.loadKitchen("kitchen", automatic = true)
            model.loadPickup(automatic = true)
            model.loadService(automatic = true)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(before, requests.get())
            assertSame(previous, model.kitchenBoard)
            setState(state, false)
        }
    }

    @Test fun lateBusinessResponseCannotRepopulateChangedWorkspace() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val original = reply
        reply = { request ->
            if (request.path.startsWith("/api/commerce/kitchen-board")) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
            original(request)
        }
        try {
            model.loadKitchen("kitchen", automatic = true)
            awaitEntered(entered)
            setState("WorkspaceVersion", model.workspaceVersion + 1)
            setState("Identity", actor.copy(employeeId = "another-employee"))
        } finally { release.countDown() }
        awaitIdle()
        assertNull(model.kitchenBoard)
        assertEquals("another-employee", model.identity?.employeeId)
    }

    @Test fun heartbeatPermissionRevocationCannotRefreshOrReenableOldKitchenRows() {
        model.loadKitchen("kitchen"); awaitIdle()
        assertNotNull(model.kitchenBoard)
        val original = reply
        var boardRequests = 0
        reply = { request ->
            if (request.path == "/api/auth/heartbeat") response(JSONObject(auth.toString()).put("deniedPermissions", JSONArray(listOf("kds.prepare"))))
            else if (request.path.startsWith("/api/commerce/kitchen-board")) {
                boardRequests++
                APIResponse(403, "{\"error\":{\"code\":\"ACCESS_REVOKED\"}}")
            } else original(request)
        }
        model.loadKitchen("kitchen", automatic = true); awaitIdle()
        // Permission errors intentionally clear sensitive views; only transient failures retain them.
        assertNull(model.kitchenBoard)
        assertEquals(1, boardRequests)
        assertFalse(model.canAct("kds.prepare"))
        assertTrue(model.kitchenState.contains("已过期"))
    }

    @Test fun realHeartbeatAndQueueCoroutinesCannotOverlapInEitherDirection() {
        val original = reply
        for (queueFirst in listOf(true, false)) {
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            reply = { request ->
                if (request.path == "/api/auth/heartbeat") {
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                }
                original(request)
            }
            try {
                if (queueFirst) model.loadKitchen("kitchen", automatic = true) else model.heartbeat()
                awaitEntered(entered)
                val activeRequests = requests.get()
                model.loadKitchen("kitchen", automatic = true)
                model.loadPickup(automatic = true)
                model.loadService(automatic = true)
                model.heartbeat()
                shadowOf(Looper.getMainLooper()).idle()
                assertTrue(model.businessRequestInFlight)
                assertEquals("A running request must exclude other queue/heartbeat reads", activeRequests, requests.get())
            } finally { release.countDown() }
            awaitIdle()
            assertNotNull(model.kitchenBoard)
        }
    }

    @Test fun closedServiceRoutePreventsManualAndAutomaticReadsDespiteRetainedPermissions() {
        auth.put("navigation", JSONArray())
        setState("Identity", actor.copy(navigationRoutes = emptyList()))
        assertTrue(model.identity!!.allows("service.execute"))
        assertTrue(model.identity!!.allows("service.manage"))
        val before = requests.get()
        model.loadService()
        awaitIdle()
        model.loadService(automatic = true)
        awaitIdle()
        assertEquals("A closed service entry must not begin even a heartbeat/read chain", before, requests.get())
        assertNull(model.serviceBoard)
        assertFalse(model.canUseService)
        assertNull(model.livePending)
    }

    @Test fun preparedRealServiceCommandCannotExecuteAfterOnlyItsNavigationRouteIsWithdrawn() {
        auth.put("navigation", JSONArray().put(JSONObject().put("route", "/staff/tasks")))
        setState("Identity", actor.copy(navigationRoutes = listOf("/staff/tasks")))
        model.loadService()
        awaitIdle()
        assertTrue(model.canUseService)
        val prepared = model.prepareService("task-1", "complete", "已核对并处理客人反馈", "", "normal")
        assertTrue(model.canExecuteLive(prepared))
        assertNotNull(prepared.steps.single().serviceProof)
        val current = model.identity!!
        val before = requests.get()
        auth.put("navigation", JSONArray())
        setState("Identity", current.copy(navigationRoutes = emptyList()))
        assertEquals(current.employeeId, model.identity!!.employeeId)
        assertEquals(current.sessionId, model.identity!!.sessionId)
        assertEquals(current.permissions, model.identity!!.permissions)
        assertEquals(current.denied, model.identity!!.denied)
        assertFalse(model.canUseService)
        assertThrows(IllegalStateException::class.java) {
            model.prepareService("task-1", "complete", "已核对并处理客人反馈", "", "normal")
        }
        assertFalse(model.canExecuteLive(prepared))
        model.executeLive(prepared)
        awaitIdle()
        assertEquals("The previously prepared command must not start a request under the narrowed route", before, requests.get())
        assertNull(model.livePending)
    }

    @Test fun heartbeatRouteWithdrawalPreservesOriginalServiceRequestUntilSameKeyRecovery() {
        val openNavigation = JSONArray().put(JSONObject().put("route", "/staff/tasks"))
        auth.put("navigation", openNavigation)
        setState("Identity", actor.copy(navigationRoutes = listOf("/staff/tasks")))
        model.loadService()
        awaitIdle()
        val prepared = model.prepareService("task-1", "complete", "已核对并处理客人反馈", "", "normal")
        val originalStep = prepared.steps.single()
        assertTrue(model.canExecuteLive(prepared))

        val writes = mutableListOf<APIRequest>()
        val originalReply = reply
        reply = { request ->
            when {
                request.path == originalStep.path -> {
                    writes += request
                    val completed = JSONObject(fixture("live-service.json").getJSONObject("board")
                        .getJSONArray("tasks").getJSONObject(0).toString()).put("status", "completed")
                    APIResponse(200, JSONObject().put("data", completed)
                        .put("meta", JSONObject().put("replayed", false)).toString())
                }
                request.path == "/api/native-service-center" && writes.isNotEmpty() ->
                    response(fixture("live-service.json").getJSONObject("board").put("tasks", JSONArray()))
                else -> originalReply(request)
            }
        }

        // Only the next server heartbeat changes. The locally prepared command still passes
        // executeLive's initial guard, so this exercises the final check before a business write.
        auth.put("navigation", JSONArray())
        assertTrue(model.canExecuteLive(prepared))
        val before = requests.get()
        model.executeLive(prepared)
        awaitIdle()
        assertTrue("Execution must have reached the server heartbeat", requests.get() > before)
        assertTrue(model.identity!!.navigationRoutes!!.isEmpty())
        assertTrue(model.identity!!.allows(prepared.permission))
        assertTrue("A route withdrawn by heartbeat must prevent the business POST", writes.isEmpty())
        val retained = model.livePending!!
        assertEquals(prepared.id, retained.id)
        assertEquals(prepared.employeeID, retained.employeeID)
        assertEquals(0, retained.completedSteps)
        assertFalse(retained.rejected)
        assertEquals(originalStep, retained.steps.single())

        // Restore only the server route and recover the durable request, without preparing a
        // replacement command or changing the local identity to bypass the recovery heartbeat.
        auth.put("navigation", openNavigation)
        model.recoverLive()
        awaitIdle()
        val sent = writes.single()
        assertEquals("POST", sent.method)
        assertEquals(originalStep.path, sent.path)
        assertEquals(originalStep.key, sent.headers[originalStep.keyHeader])
        assertEquals(originalStep.body, sent.body!!.toString())
        assertNull("A verified original receipt should finish the saved request", model.livePending)
    }
}
