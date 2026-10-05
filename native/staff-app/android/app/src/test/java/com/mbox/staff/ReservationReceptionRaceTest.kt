package com.mbox.staff

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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

/** Real serialized AppModel IO; navigation invalidates reads without forcing the busy flag off. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class ReservationReceptionRaceTest {
    private val f = ReceptionFixtures
    private val firstId = f.reservationId
    private val secondId = "99999999-9999-4999-8999-999999999999"
    private lateinit var model: AppModel
    private lateinit var auth: JSONObject
    private val requests = CopyOnWriteArrayList<APIRequest>()
    private val gates = mutableListOf<Gate>()
    @Volatile private var reply: (APIRequest) -> APIResponse = { error("offline transport not initialized") }

    private class Gate {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        fun hold() {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "Test did not release delayed request" }
        }
    }

    @Before fun setUp() {
        val app: Application = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        auth = JSONObject().put("session", JSONObject().put("id", f.actor.sessionId)
            .put("employeeId", f.employeeId).put("expiresAt", f.actor.expiresAt).put("onlineLeaseUntil", f.actor.onlineLeaseUntil))
            .put("employee", JSONObject().put("id", f.employeeId).put("code", "staff").put("displayName", "接待员工").put("roleCodes", JSONArray()))
            .put("permissions", JSONArray(f.actor.permissions.toList())).put("deniedPermissions", JSONArray())
        reply = { request ->
            when {
                request.path.startsWith("/api/auth/") -> response(auth)
                request.path == "/api/staff/native-reservation-capabilities" -> response(JSONObject()
                    .put("admissionCreateV1", true).put("receptionSeatV1", true))
                request.path == detailPath(firstId) -> detail(firstId, "预约 A")
                request.path == detailPath(secondId) -> detail(secondId, "预约 B")
                request.path == sessionsPath(firstId) -> response(f.sessionsJson())
                request.path == sessionsPath(secondId) -> response(f.sessionsJson().put("reservationId", secondId))
                else -> error("Unexpected offline path ${request.path}")
            }
        }
        val api = StaffAPI { request -> requests += request; reply(request) }
        api.login("staff", "1234", false)
        model = AppModel(app, apiOverride = api, receptionSecretsOverride = MemoryReceptionSecrets())
        state("Identity", f.actor)
        model.foreground = true
        requests.clear()
    }

    @After fun tearDown() {
        gates.forEach { it.release.countDown() }
        model.viewModelScope.cancel()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun response(data: JSONObject) = APIResponse(200, JSONObject().put("data", data).toString())
    private fun detailPath(id: String) = "$reservationReceptionRoot/$id"
    private fun sessionsPath(id: String) = "${detailPath(id)}/table-sessions"
    private fun detail(id: String, name: String) = response(JSONObject().put("protocol", 1)
        .put("reservation", f.reservation().put("id", id).put("publicId", "reception-${id.take(8)}").put("customerName", name))
        .put("seating", JSONObject.NULL))

    private fun state(name: String, value: Any?) {
        AppModel::class.java.declaredMethods.single { it.name == "set$name" && it.parameterCount == 1 }
            .also { it.isAccessible = true }.invoke(model, value)
    }

    private fun block(path: String, outcome: () -> APIResponse): Gate {
        val previous = reply
        val gate = Gate().also { gates += it }
        reply = { request -> if (request.path == path) { gate.hold(); outcome() } else previous(request) }
        return gate
    }

    private fun awaitEntered(gate: Gate) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (gate.entered.count > 0 && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(2)
        }
        assertEquals("Delayed request was not reached", 0L, gate.entered.count)
        assertTrue(model.businessRequestInFlight)
    }

    private fun awaitIdle() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (model.businessRequestInFlight && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(2)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse("Reception read did not settle", model.businessRequestInFlight)
    }

    @Test fun switchingToBWhileADetailIsDelayedDiscardsAAndRequiresFreshBRead() {
        val gate = block(detailPath(firstId)) { detail(firstId, "旧请求 A") }
        model.selectReception(firstId); model.loadReceptionDetail(firstId); awaitEntered(gate)
        model.selectReception(secondId)
        model.loadReceptionDetail(secondId)
        val selectedState = model.receptionState
        assertTrue(model.busy)
        assertFalse(requests.any { it.path == detailPath(secondId) })
        assertNull(model.receptionDetail)
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionDetail); assertNull(model.receptionSessions)
        assertEquals(selectedState, model.receptionState)
        assertFalse(model.canSeatReception)
        model.loadReceptionDetail(secondId); awaitIdle()
        assertEquals(secondId, model.receptionDetail!!.reservation.id)
        assertEquals("预约 B", model.receptionDetail!!.reservation.name)
        assertTrue(requests.filter { it.path.startsWith(reservationReceptionRoot) }.all { it.body == null })
    }

    @Test fun aToBToAUsesANewViewGenerationEvenThoughReservationIdMatchesAgain() {
        val gate = block(detailPath(firstId)) { detail(firstId, "旧一轮 A") }
        val firstToken = model.selectReception(firstId)
        model.loadReceptionDetail(firstId); awaitEntered(gate)
        model.selectReception(secondId)
        val currentToken = model.selectReception(firstId)
        assertNotEquals(firstToken, currentToken)
        val state = model.receptionState
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionDetail)
        assertEquals(state, model.receptionState)
        model.closeReceptionView(firstToken)
        model.loadReceptionDetail(firstId); awaitIdle()
        assertNotNull("Disposing old A must not close the current A", model.receptionDetail)
        model.closeReceptionView(currentToken)
        assertNull(model.receptionDetail)
        assertNull(model.receptionSessions)
        assertFalse(model.canSeatReception)
    }

    @Test fun delayedSessionsCannotRepopulateAAfterOpeningBOrReenableSeatCommand() {
        model.selectReception(firstId); model.loadReceptionDetail(firstId); awaitIdle()
        val gate = block(sessionsPath(firstId)) { response(f.sessionsJson()) }
        model.loadReceptionSessions(firstId); awaitEntered(gate)
        model.selectReception(secondId)
        val state = model.receptionState
        assertNull(model.receptionDetail); assertNull(model.receptionSessions)
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionDetail); assertNull(model.receptionSessions)
        assertEquals(state, model.receptionState)
        assertFalse(model.canSeatReception)
        assertThrows(IllegalArgumentException::class.java) {
            model.prepareReceptionSeat(firstId, setOf(f.firstSession, f.secondSession), "不应使用旧预约的桌次")
        }
        model.loadReceptionSessions(secondId); awaitIdle()
        assertEquals(secondId, model.receptionDetail!!.reservation.id)
        assertEquals(secondId, model.receptionSessions!!.reservationId)
        assertTrue(model.canSeatReception)
    }

    @Test fun delayedFailureFromClosedPageDoesNotOverwriteNewPagesStateOrConnection() {
        val gate = block(detailPath(firstId)) { throw IOException("old page network error") }
        val token = model.selectReception(firstId)
        model.loadReceptionDetail(firstId); awaitEntered(gate)
        model.closeReceptionView(token)
        model.selectReception(secondId)
        val state = model.receptionState
        val connection = model.connection
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionDetail)
        assertEquals(state, model.receptionState)
        assertEquals(connection, model.connection)
        assertFalse(model.receptionState.contains("old page network error"))
    }

    @Test fun closingDuringHeartbeatPreventsCapabilitiesAndDetailRequestsFromOldView() {
        val gate = block("/api/auth/heartbeat") { response(auth) }
        val token = model.selectReception(firstId)
        model.loadReceptionDetail(firstId); awaitEntered(gate)
        model.closeReceptionView(token)
        val state = model.receptionState
        gate.release.countDown(); awaitIdle()
        assertEquals(listOf("/api/auth/heartbeat"), requests.map { it.path })
        assertNull(model.receptionDetail); assertNull(model.receptionSessions)
        assertEquals(state, model.receptionState)
    }

    @Test fun delayedCapabilityResponseCannotInstallOldCapabilitiesAfterPageCloses() {
        val gate = block("/api/staff/native-reservation-capabilities") { response(JSONObject()
            .put("admissionCreateV1", true).put("receptionSeatV1", true)) }
        val token = model.selectReception(firstId)
        model.loadReceptionDetail(firstId); awaitEntered(gate)
        model.closeReceptionView(token)
        val latest = JSONObject().put("admissionCreateV1", false).put("receptionSeatV1", false)
        model.reservationCapabilities = latest
        gate.release.countDown(); awaitIdle()
        assertSame(latest, model.reservationCapabilities)
        assertFalse(requests.any { it.path == detailPath(firstId) })
        assertNull(model.receptionDetail)
    }

    @Test fun sameEmployeeAuthorityChangesAndRestorationStillInvalidateOldResult() {
        val gate = block(detailPath(firstId)) { detail(firstId, "旧权限下的结果") }
        model.selectReception(firstId); model.loadReceptionDetail(firstId); awaitEntered(gate)
        state("Identity", f.actor.copy(denied = setOf("reservation.view")))
        state("Identity", f.actor)
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionDetail)
        assertFalse(model.canSeatReception)
    }

    @Test fun closedCreateDialogCannotFillAReopenedDialogWithTheSameDates() {
        val arrival = Instant.now().plusSeconds(3600); val end = arrival.plusSeconds(7200)
        val path = ReservationReceptionOptions.path(arrival, end)
        val gate = block(path) { response(f.optionsJson().put("arrivalAt", arrival.toString()).put("expectedEndAt", end.toString())) }
        val oldToken = model.beginReceptionCreation()
        model.loadReceptionOptions(arrival, end); awaitEntered(gate)
        model.closeReceptionView(oldToken)
        val currentToken = model.beginReceptionCreation()
        val state = model.receptionState
        gate.release.countDown(); awaitIdle()
        assertNull(model.receptionOptions)
        assertFalse(model.canCreateReception)
        assertEquals(state, model.receptionState)
        model.closeReceptionView(oldToken)
        model.loadReceptionOptions(arrival, end); awaitIdle()
        assertNotNull(model.receptionOptions)
        assertTrue(model.canCreateReception)
        val draft = f.draft().copy(arrival = arrival, end = end)
        val prepared = model.prepareReceptionCreate(draft, viewToken = currentToken)
        assertTrue(model.canExecuteLive(prepared))
        model.closeReceptionView(currentToken)
        assertNull(model.receptionOptions)
        assertFalse(model.canCreateReception)
        val reopenedToken = model.beginReceptionCreation()
        model.loadReceptionOptions(arrival, end, viewToken = reopenedToken); awaitIdle()
        assertTrue(model.canCreateReception)
        assertFalse("Same dates do not revive a closed dialog's prepared create", model.canExecuteLive(prepared))
        val fresh = model.prepareReceptionCreate(draft, viewToken = reopenedToken)
        assertTrue(model.canExecuteLive(fresh))
        assertFalse(model.canExecuteLive(prepared))
    }

    @Test fun changedEmployeeSessionOrWorkspaceInvalidatesDelayedDetail() {
        for (mutation in listOf("session", "employee", "workspace")) {
            val gate = block(detailPath(firstId)) { detail(firstId, "失效工作区结果") }
            model.selectReception(firstId); model.loadReceptionDetail(firstId); awaitEntered(gate)
            when (mutation) {
                "session" -> state("Identity", f.actor.copy(sessionId = "new-session"))
                "employee" -> state("Identity", f.actor.copy(employeeId = f.customerId))
                "workspace" -> state("WorkspaceVersion", model.workspaceVersion + 1)
            }
            gate.release.countDown(); awaitIdle()
            assertNull("mutation=$mutation", model.receptionDetail)
            assertFalse(model.canSeatReception)
            state("Identity", f.actor)
        }
    }

    @Test fun staleUiTokenCannotInvalidateStealSelectionReadOrReplaceCurrentPreparedCommand() {
        val oldToken = model.selectReception(firstId)
        val currentToken = model.selectReception(secondId)
        model.loadReceptionSessions(secondId, viewToken = currentToken); awaitIdle()
        val detail = model.receptionDetail
        val sessions = model.receptionSessions
        val state = model.receptionState
        val prepared = model.prepareReceptionSeat(secondId, setOf(f.firstSession, f.secondSession),
            "已核对当前预约全部桌位", viewToken = currentToken)
        assertTrue(model.canExecuteLive(prepared))
        requests.clear()
        model.invalidateReceptionRead(viewToken = oldToken)
        model.loadReceptionDetail(firstId, viewToken = oldToken)
        model.loadReceptionSessions(firstId, viewToken = oldToken)
        model.loadReceptionOptions(f.arrival, f.end, viewToken = oldToken)
        assertThrows(Exception::class.java) {
            model.prepareReceptionSeat(secondId, setOf(f.firstSession, f.secondSession), "旧页面不应替换新确认", viewToken = oldToken)
        }
        assertThrows(Exception::class.java) { model.prepareReceptionCreate(f.draft(), viewToken = oldToken) }
        model.closeReceptionView(oldToken)
        awaitIdle()
        assertTrue(requests.isEmpty())
        assertTrue(model.isReceptionViewCurrent(currentToken))
        assertFalse(model.isReceptionViewCurrent(oldToken))
        assertSame(detail, model.receptionDetail)
        assertSame(sessions, model.receptionSessions)
        assertEquals(state, model.receptionState)
        assertTrue(model.canExecuteLive(prepared))
    }

    @Test fun preparedSeatCommandCannotExecuteAfterLeavingAndReturningToIdenticalReservation() {
        val firstToken = model.selectReception(firstId)
        model.loadReceptionSessions(firstId, viewToken = firstToken); awaitIdle()
        val original = model.prepareReceptionSeat(firstId, setOf(f.firstSession, f.secondSession),
            "已核对本组全部桌次和人数", viewToken = firstToken)
        assertTrue(model.canExecuteLive(original))
        model.selectReception(secondId)
        val currentToken = model.selectReception(firstId)
        model.loadReceptionSessions(firstId, viewToken = currentToken); awaitIdle()
        assertTrue(model.canSeatReception)
        assertFalse("Matching reservation ID and table tuples do not revive an old confirmation", model.canExecuteLive(original))
        val before = requests.size
        model.executeLive(original); awaitIdle()
        assertEquals(before, requests.size)
        assertNull(model.livePending)
        val fresh = model.prepareReceptionSeat(firstId, setOf(f.firstSession, f.secondSession),
            "已核对本组全部桌次和人数", viewToken = currentToken)
        assertNotEquals(original.id, fresh.id)
        assertEquals(original.steps.single().body, fresh.steps.single().body)
        assertTrue(model.canExecuteLive(fresh))
        assertFalse(model.canExecuteLive(original))
    }
}
