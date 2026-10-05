package com.mbox.staff

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
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

/** Real AppModel lifecycle, journal, authenticated transport and recovery; no remote writes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class ReservationReceptionWorkspaceTest {
    private val f = ReceptionFixtures
    private lateinit var app: Application
    private lateinit var api: StaffAPI
    private lateinit var auth: JSONObject
    private lateinit var model: AppModel
    private val models = mutableListOf<AppModel>()
    private val requests = CopyOnWriteArrayList<APIRequest>()
    private val secrets = MemoryReceptionSecrets()
    @Volatile private var receptionResponse: (APIRequest) -> APIResponse = { error("unexpected reception read") }

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        auth = JSONObject().put("session", JSONObject().put("id", f.actor.sessionId)
            .put("employeeId", f.employeeId).put("expiresAt", f.actor.expiresAt).put("onlineLeaseUntil", f.actor.onlineLeaseUntil))
            .put("employee", JSONObject().put("id", f.employeeId).put("code", "staff").put("displayName", "接待员工").put("roleCodes", JSONArray()))
            .put("permissions", JSONArray(f.actor.permissions.toList())).put("deniedPermissions", JSONArray())
        api = StaffAPI { request ->
            requests += request
            when {
                request.path.startsWith("/api/auth/") -> APIResponse(200, JSONObject().put("data", auth).toString())
                request.path.startsWith("/api/staff/reservation-receptions") -> receptionResponse(request)
                request.path.startsWith("/api/staff/reservations") || request.path.startsWith("/api/staff/reservation-intake") -> APIResponse(200, "{\"data\":[]}")
                request.path == "/api/staff/native-reservation-capabilities" -> APIResponse(200, "{\"data\":{\"durableTransitions\":true,\"durableCreate\":true,\"admissionCreateV1\":false,\"receptionSeatV1\":false,\"tableBoundCreate\":false}}")
                request.path == "/api/staff/native-waitlist-capabilities" -> APIResponse(200, "{\"data\":{\"durableTransitions\":false}}")
                else -> error("Unexpected offline route ${request.path}")
            }
        }
        api.login("staff", "1234", false)
        model = reopen()
        requests.clear()
    }

    private fun reopen() = AppModel(app, apiOverride = api, receptionSecretsOverride = secrets).also {
        models += it
        state(it, "Identity", f.actor)
        it.foreground = true
    }

    private fun state(target: AppModel = model, name: String, value: Any?) {
        AppModel::class.java.declaredMethods.single { it.name == "set$name" && it.parameterCount == 1 }
            .also { it.isAccessible = true }.invoke(target, value)
    }

    private fun field(name: String, value: Any?) {
        AppModel::class.java.getDeclaredField(name).also { it.isAccessible = true }.set(model, value)
    }

    private fun persist(command: LiveCommand) {
        AppModel::class.java.getDeclaredMethod("saveLive", LiveCommand::class.java)
            .also { it.isAccessible = true }.invoke(model, command)
        state(name = "LivePending", value = command)
    }

    private fun awaitIdle(target: AppModel = model) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (target.businessRequestInFlight && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(2)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse("AppModel recovery did not finish", target.businessRequestInFlight)
    }

    private fun activate(): LiveCommand {
        val now = Instant.now()
        val arrival = now.plusSeconds(3600); val end = now.plusSeconds(10800)
        val options = ReservationReceptionOptions(f.optionsJson().put("arrivalAt", arrival.toString()).put("expectedEndAt", end.toString()))
        state(name = "ReceptionOptions", value = options)
        field("receptionOptionsUpdated", now); field("receptionActor", f.employeeId)
        model.reservationCapabilities = JSONObject().put("admissionCreateV1", true).put("receptionSeatV1", true)
        return f.draft().copy(arrival = arrival, end = end).command(f.actor, options, now)
    }

    @After fun tearDown() {
        models.forEach { it.viewModelScope.cancel() }
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun newCreateRequiresStrictCapabilitiesCurrentEmployeePermissionAndFreshRead() {
        var command = activate()
        assertTrue(model.canExecuteLive(command))
        for (capabilities in listOf(JSONObject(), JSONObject().put("durableCreate", true),
            JSONObject().put("admissionCreateV1", "true").put("receptionSeatV1", true),
            JSONObject().put("admissionCreateV1", true).put("receptionSeatV1", false))) {
            model.reservationCapabilities = capabilities
            assertFalse(model.canExecuteLive(command))
        }
        command = activate(); assertTrue(model.canExecuteLive(command)); field("receptionOptionsUpdated", Instant.now().minusSeconds(61))
        assertFalse(model.canExecuteLive(command))
        command = activate(); assertTrue(model.canExecuteLive(command)); state(name = "Identity", value = f.actor.copy(denied = setOf("reservation.manage")))
        assertFalse(model.canExecuteLive(command))
        state(name = "Identity", value = f.actor.copy(employeeId = f.customerId))
        assertFalse(model.canExecuteLive(command))
        state(name = "Identity", value = f.actor); command = activate(); assertTrue(model.canExecuteLive(command)); state(name = "LiveStorageDamaged", value = true)
        assertFalse(model.canExecuteLive(command))
    }

    @Test fun seatingGateUsesReservationIdAndEveryFreshTableTuple() {
        activate()
        val command = f.seat()
        state(name = "ReceptionDetail", value = ReservationReceptionDetail(JSONObject().put("protocol", 1)
            .put("reservation", f.reservation()).put("seating", JSONObject.NULL)))
        state(name = "ReceptionSessions", value = ReservationReceptionSessions(f.sessionsJson()))
        field("receptionSessionsUpdated", Instant.now())
        assertTrue(model.canSeatReception)
        assertTrue(model.canExecuteLive(command))
        val moved = f.sessionsJson()
        moved.getJSONArray("sessions").getJSONObject(1).put("locationVersion", 5)
        state(name = "ReceptionSessions", value = ReservationReceptionSessions(moved))
        assertFalse(model.canExecuteLive(command))
        state(name = "ReceptionSessions", value = ReservationReceptionSessions(f.sessionsJson()))
        assertTrue(model.canExecuteLive(command))
        state(name = "Identity", value = f.actor.copy(denied = setOf("table.open")))
        assertFalse(model.canExecuteLive(command))
        state(name = "Identity", value = f.actor)
        field("receptionSessionsUpdated", Instant.now().minusSeconds(61))
        assertFalse(model.canExecuteLive(command))
    }

    @Test fun restart404KeepsOriginalPrivateSlotAndExplicitRetryUsesSameRequestWithCapabilitiesClosed() {
        val original = f.create()
        val secure = secureReservationReceptionCommand(original, secrets)
        persist(secure)
        model = reopen()
        assertEquals(secure, model.livePending)
        model.reservationCapabilities = JSONObject().put("admissionCreateV1", false).put("receptionSeatV1", false)
        val saved = File(app.filesDir, "live-pending-v1.json").readText()
        val originalSecrets = secrets.values.toMap()
        receptionResponse = { request ->
            if (request.body == null) APIResponse(404, "{\"error\":{\"code\":\"RESERVATION_RECEIPT_NOT_FOUND\",\"message\":\"not found\"}}")
            else APIResponse(200, f.receipt(original, replayed = true).toString())
        }
        model.recoverLive(); awaitIdle()
        assertEquals(saved, File(app.filesDir, "live-pending-v1.json").readText())
        assertEquals(originalSecrets, secrets.values)
        assertEquals(0, model.livePending!!.completedSteps)
        assertFalse(model.livePending!!.rejected)
        assertFalse(requests.any { it.path.startsWith("/api/staff/reservation-receptions") && it.body != null })
        model.recoverLive(retryReceptionOriginal = true); awaitIdle()
        val post = requests.single { it.path == original.steps.single().path && it.body != null }
        assertEquals(original.steps.single().key, post.headers["idempotency-key"])
        assertEquals(original.steps.single().body, post.body.toString())
        assertNull(model.livePending)
        assertTrue(secrets.values.isEmpty())
    }

    @Test fun anotherEmployeeAndHeartbeatRevocationCannotRecoverOrDiscardOriginalPending() {
        val secure = secureReservationReceptionCommand(f.create(), secrets)
        persist(secure)
        val saved = File(app.filesDir, "live-pending-v1.json").readText()
        state(name = "Identity", value = f.actor.copy(employeeId = f.customerId))
        model.recoverLive(); awaitIdle()
        assertTrue(requests.isEmpty())
        state(name = "Identity", value = f.actor)
        auth.put("deniedPermissions", JSONArray(listOf("reservation.manage")))
        model.recoverLive(); awaitIdle()
        assertEquals(listOf("/api/auth/heartbeat"), requests.map { it.path })
        assertEquals(saved, File(app.filesDir, "live-pending-v1.json").readText())
        assertEquals(secure, model.livePending)
        assertEquals(1, secrets.values.size)
    }

    @Test fun confirmedCreateWithFailedSecretRemovalKeepsCheckpointAndNeverResubmits() {
        val original = f.create(); persist(secureReservationReceptionCommand(original, secrets))
        secrets.failRemove = true
        receptionResponse = { request ->
            assertNull(request.body)
            APIResponse(200, f.receipt(original, replayed = true).toString())
        }
        model.recoverLive(); awaitIdle()
        assertEquals(1, model.livePending!!.completedSteps)
        assertEquals(1, secrets.values.size)
        assertEquals(1, requests.count { it.path.startsWith("/api/staff/reservation-receptions") })
        model = reopen(); secrets.failRemove = false
        model.recoverLive(retryReceptionOriginal = true); awaitIdle()
        assertNull(model.livePending)
        assertTrue(secrets.values.isEmpty())
        assertEquals(1, requests.count { it.path.startsWith("/api/staff/reservation-receptions") })
        assertFalse(requests.any { it.path.startsWith("/api/staff/reservation-receptions") && it.body != null })
    }

    @Test fun secureStoreFailurePreventsFirstSubmissionAndDoesNotCreatePlaintextPending() {
        val original = activate()
        secrets.failWrite = true
        model.executeLive(original); awaitIdle()
        assertTrue(requests.isEmpty())
        assertNull(model.livePending)
        assertFalse(File(app.filesDir, "live-pending-v1.json").exists())
        assertTrue(secrets.values.isEmpty())
    }

    @Test fun corruptedOuterOwnerOrRequestAnchorsCannotUseAnotherEmployeesSecureSlot() {
        val other = f.actor.copy(employeeId = f.customerId)
        val original = f.draft().command(other, f.options(), f.now)
        val securedOther = secureReservationReceptionCommand(original, secrets)
        val securedCurrent = secureReservationReceptionCommand(f.create(), secrets)
        val step = securedCurrent.steps.single()
        val wrongKind = JSONObject(step.recoveryBody!!).also { it.getJSONObject("reception").put("secureKind", "seat") }
        val corruptions = listOf(securedOther.copy(employeeID = f.employeeId),
            securedCurrent.copy(id = "99999999-9999-4999-8999-999999999999"),
            securedCurrent.copy(permission = "reservation.view"),
            securedCurrent.copy(steps = listOf(step, step)),
            securedCurrent.copy(steps = listOf(step.copy(body = "{\"contact\":\"tampered\"}"))),
            securedCurrent.copy(steps = listOf(step.copy(recoveryBody = wrongKind.toString()))))
        val before = secrets.values.toMap()
        for (corrupted in corruptions) {
            val disk = corrupted.json().toString()
            File(app.filesDir, "live-pending-v1.json").writeText(disk)
            model = reopen()
            requests.clear()
            model.recoverLive(retryReceptionOriginal = true); awaitIdle()
            assertTrue(requests.isEmpty())
            assertEquals(disk, File(app.filesDir, "live-pending-v1.json").readText())
            assertEquals(before, secrets.values)
        }
    }
}
