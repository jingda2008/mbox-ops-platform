package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

internal object ReceptionFixtures {
    const val employeeId = "11111111-1111-4111-8111-111111111111"
    const val reservationId = "22222222-2222-4222-8222-222222222222"
    const val customerId = "33333333-3333-4333-8333-333333333333"
    const val firstSession = "44444444-4444-4444-8444-444444444444"
    const val secondSession = "55555555-5555-4555-8555-555555555555"
    const val firstTable = "66666666-6666-4666-8666-666666666666"
    const val secondTable = "77777777-7777-4777-8777-777777777777"
    const val batchId = "88888888-8888-4888-8888-888888888888"
    const val name = "隐私预约顾客"
    const val contact = "13900001234"
    val now: Instant = Instant.parse("2026-10-05T04:00:00Z")
    val arrival: Instant = now.plusSeconds(3600)
    val end: Instant = now.plusSeconds(10800)
    val actor = StaffIdentity("reservation-session", employeeId, "staff", "接待员工",
        "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", emptyList(),
        setOf("reservation.view", "reservation.manage", "table.open"), emptySet())

    fun optionsJson() = JSONObject().put("protocol", 1).put("arrivalAt", arrival.toString())
        .put("expectedEndAt", end.toString()).put("physicalTablesPreassigned", false)
        .put("policy", JSONObject().put("version", 7).put("maxAdvanceDays", 30)
            .put("defaultDurationMinutes", 120).put("arrivalGraceMinutes", 10))
        .put("capacity", JSONObject().put("totalGuests", 40).put("committedGuests", 12))
    fun options() = ReservationReceptionOptions(optionsJson())
    fun draft() = ReservationReceptionDraft(arrival, end, name = name, contact = contact, people = 6)
    fun create() = draft().command(actor, options(), now)
    fun reservation(status: String = "arrived") = JSONObject()
        .put("id", reservationId).put("publicId", "reception-existing")
        .put("customerId", customerId).put("customerName", name).put("guestCount", 6)
        .put("arrivalAt", arrival.toString()).put("expectedEndAt", end.toString())
        .put("status", status).put("aggregateVersion", 2).put("source", "phone")
        .put("ownerEmployeeId", employeeId).put("tableLocks", JSONArray())
        .put("reservationSnapshot", JSONObject().put("receptionProtocol", 1).put("bookingMode", "direct")
            .put("physicalTablesPreassigned", false)).put("contactAvailable", true)
    fun sessionsJson() = JSONObject().put("protocol", 1).put("reservationId", reservationId)
        .put("reservationVersion", 2).put("reservationGuestCount", 6).put("reservationStatus", "arrived")
        .put("partialSeatingSupported", false).put("sessions", JSONArray().put(session(firstSession, firstTable, "A01", 0))
            .put(session(secondSession, secondTable, "A02", 4)))
    private fun session(id: String, table: String, code: String, version: Int) = JSONObject()
        .put("tableSessionId", id).put("tableId", table).put("tableCode", code)
        .put("locationVersion", version).put("guestCount", 3).put("businessDate", "2026-10-05")
        .put("openedAt", "2026-10-05 12:30:00+08")
    fun seat() = reservationReceptionSeatCommand(LiveReservation(reservation()), ReservationReceptionSessions(sessionsJson()),
        setOf(firstSession, secondSession), "已核对本组全部实际桌位和人数", actor)

    fun receipt(command: LiveCommand, replayed: Boolean = false): JSONObject {
        val step = command.steps.single()
        val body = JSONObject(step.body)
        val create = step.path == "/api/staff/reservation-receptions"
        val row = if (create) reservation(body.getString("initialStatus"))
            .put("publicId", body.getString("publicId")).put("aggregateVersion", 1)
            .put("customerName", body.getString("customerName")).put("guestCount", body.getInt("guestCount"))
            .put("arrivalAt", body.getString("arrivalAt")).put("expectedEndAt", body.getString("expectedEndAt"))
            .put("source", body.getString("source"))
        else reservation("seated").put("aggregateVersion", 3)
        val data = JSONObject().put("protocol", 1).put("operation", if (create) "create" else "seat")
            .put("employeeId", employeeId).put("requestKey", step.key).put("reservation", row)
        if (create) data.put("maskedContact", "139****1234")
        else data.put("seating", JSONObject().put("batchId", batchId).put("customerId", customerId)
            .put("seatedAt", "2026-10-05T05:00:00Z").put("seatedByEmployeeId", employeeId)
            .put("seatedGuestCount", 6).put("reservationGuestCount", 6).put("reason", body.getString("reason"))
            .put("sessions", JSONArray(body.getJSONArray("sessions").objects().map { selection ->
                JSONObject().put("tableSessionId", selection.getString("tableSessionId"))
                    .put("tableIdAtSeating", selection.getString("expectedTableId"))
                    .put("tableCodeAtSeating", if (selection.getString("tableSessionId") == firstSession) "A01" else "A02")
                    .put("locationVersionAtSeating", selection.getLong("expectedLocationVersion"))
                    .put("guestCountAtSeating", selection.getInt("expectedGuestCount"))
            })))
        return JSONObject().put("data", data).put("meta", JSONObject().put("replayed", replayed))
    }
}

class ReservationReceptionTest {
    private val f = ReceptionFixtures

    @Test fun admissionCreateContainsNoTableOrCustomerAssignmentAndKeepsOriginalIntent() {
        val command = f.create()
        val step = command.steps.single()
        val body = JSONObject(step.body)
        assertEquals("/api/staff/reservation-receptions", step.path)
        assertEquals(setOf("protocol", "publicId", "customerName", "contact", "guestCount", "arrivalAt",
            "expectedEndAt", "source", "initialStatus", "note", "seatPreference", "reservationPolicyVersion", "preferredScheduleId"),
            body.keys().asSequence().toSet())
        assertEquals(7, body.getInt("reservationPolicyVersion"))
        assertEquals(6, body.getInt("guestCount"))
        assertEquals(f.contact, body.getString("contact"))
        assertFalse(body.has("tableIds")); assertFalse(body.has("customerId")); assertFalse(body.has("employeeId"))
        assertEquals(command, LiveCommand.parse(JSONObject(command.json().toString())))
        assertTrue(reservationReceptionCreateRecoveryPath(step).contains(body.getString("publicId")))
        assertTrue(reservationReceptionCreateRecoveryPath(step).contains(step.key))
    }

    @Test fun createRequiresCurrentDatesCapacityPolicyAndAuthorizedEmployee() {
        for (draft in listOf(f.draft().copy(people = 0), f.draft().copy(people = 201), f.draft().copy(people = 29),
            f.draft().copy(name = " "), f.draft().copy(contact = "12"), f.draft().copy(note = "x".repeat(1001)),
            f.draft().copy(source = "guest"), f.draft().copy(initial = "arrived"),
            f.draft().copy(seat = "table-A01"), f.draft().copy(arrival = f.now),
            f.draft().copy(end = f.arrival), f.draft().copy(arrival = f.arrival.plusSeconds(60)))) {
            assertThrows(Exception::class.java) { draft.command(f.actor, f.options(), f.now) }
        }
        assertThrows(Exception::class.java) { f.draft().command(f.actor.copy(denied = setOf("reservation.manage")), f.options(), f.now) }
        val distant = f.now.plusSeconds(31 * 86400L)
        val options = ReservationReceptionOptions(f.optionsJson().put("arrivalAt", distant.toString())
            .put("expectedEndAt", distant.plusSeconds(7200).toString()))
        assertThrows(Exception::class.java) { f.draft().copy(arrival = distant, end = distant.plusSeconds(7200)).command(f.actor, options, f.now) }
    }

    @Test fun optionsRejectCoercedNumbersOrPreassignedTables() {
        for (bad in listOf(f.optionsJson().put("protocol", "1"), f.optionsJson().put("physicalTablesPreassigned", true),
            f.optionsJson().put("physicalTablesPreassigned", "false"))) {
            assertThrows(Exception::class.java) { ReservationReceptionOptions(bad) }
        }
        for (value in listOf("40", 40.5, -1, 9007199254740992L)) {
            val bad = f.optionsJson()
            bad.getJSONObject("capacity").put("totalGuests", value)
            assertThrows(Exception::class.java) { ReservationReceptionOptions(bad) }
        }
    }

    @Test fun createReceiptIsBoundToEmployeeKeyPublicIdDatesAndRealReservation() {
        val command = f.create()
        val step = command.steps.single()
        validateReservationReceptionReply(f.receipt(command).toString(), step)
        for ((field, value) in listOf("employeeId" to f.customerId, "requestKey" to "wrong-key", "operation" to "seat", "protocol" to "1")) {
            val bad = f.receipt(command); bad.getJSONObject("data").put(field, value)
            assertThrows(Exception::class.java) { validateReservationReceptionReply(bad.toString(), step) }
        }
        for ((field, value) in listOf("publicId" to "reception-other", "customerName" to "另一个人", "guestCount" to 6.5,
            "arrivalAt" to f.arrival.plusSeconds(60).toString(), "expectedEndAt" to f.end.plusSeconds(60).toString(),
            "status" to "pending", "ownerEmployeeId" to f.customerId)) {
            val bad = f.receipt(command); bad.getJSONObject("data").getJSONObject("reservation").put(field, value)
            assertThrows(Exception::class.java) { validateReservationReceptionReply(bad.toString(), step) }
        }
    }

    @Test fun multiTableSeatCarriesEveryOriginalTupleAndRequiresTableOpenPermission() {
        val command = f.seat()
        val body = JSONObject(command.steps.single().body)
        assertEquals(2, body.getJSONArray("sessions").length())
        assertEquals(setOf(f.firstSession, f.secondSession), body.getJSONArray("sessions").objects().map { it.getString("tableSessionId") }.toSet())
        body.getJSONArray("sessions").objects().forEach {
            assertEquals(setOf("tableSessionId", "expectedTableId", "expectedLocationVersion", "expectedGuestCount"), it.keys().asSequence().toSet())
            assertEquals(3, it.getInt("expectedGuestCount"))
        }
        assertEquals(command, LiveCommand.parse(JSONObject(command.json().toString())))
        for (permission in listOf("reservation.manage", "table.open")) {
            assertThrows(Exception::class.java) { reservationReceptionSeatCommand(LiveReservation(f.reservation()),
                ReservationReceptionSessions(f.sessionsJson()), setOf(f.firstSession, f.secondSession), "全部实际桌位已核对", f.actor.copy(denied = setOf(permission))) }
        }
    }

    @Test fun sessionOptionsRejectDuplicateTablesOrSessionsAndWrongReservationState() {
        for (field in listOf("tableSessionId", "tableId")) {
            val bad = f.sessionsJson(); val sessions = bad.getJSONArray("sessions")
            sessions.getJSONObject(1).put(field, sessions.getJSONObject(0).getString(field))
            assertThrows(Exception::class.java) { ReservationReceptionSessions(bad) }
        }
        assertThrows(Exception::class.java) { reservationReceptionSeatCommand(LiveReservation(f.reservation("confirmed")),
            ReservationReceptionSessions(f.sessionsJson()), setOf(f.firstSession), "客人尚未到店", f.actor) }
        assertThrows(Exception::class.java) { reservationReceptionSeatCommand(LiveReservation(f.reservation()),
            ReservationReceptionSessions(f.sessionsJson()), emptySet(), "未选择实际桌位", f.actor) }
    }

    @Test fun seatReceiptRequiresWholeTupleSetAndKeepsOriginalAtSeatingFacts() {
        val command = f.seat(); val step = command.steps.single()
        validateReservationReceptionReply(f.receipt(command, replayed = true).toString(), step)
        val renamed = f.receipt(command, replayed = true)
        renamed.getJSONObject("data").getJSONObject("seating").getJSONArray("sessions")
            .getJSONObject(0).put("tableCodeAtSeating", "新版桌号A01")
        validateReservationReceptionReply(renamed.toString(), step)
        for (field in listOf("tableSessionId", "tableIdAtSeating", "locationVersionAtSeating", "guestCountAtSeating")) {
            val bad = f.receipt(command); val row = bad.getJSONObject("data").getJSONObject("seating").getJSONArray("sessions").getJSONObject(0)
            row.put(field, if (field.endsWith("AtSeating") && field != "tableIdAtSeating") 99 else f.customerId)
            assertThrows(Exception::class.java) { validateReservationReceptionReply(bad.toString(), step) }
        }
        val missing = f.receipt(command)
        missing.getJSONObject("data").getJSONObject("seating").getJSONArray("sessions").remove(1)
        assertThrows(Exception::class.java) { validateReservationReceptionReply(missing.toString(), step) }
        val changedTotal = f.receipt(command)
        changedTotal.getJSONObject("data").getJSONObject("seating").put("seatedGuestCount", 3)
        assertThrows(Exception::class.java) { validateReservationReceptionReply(changedTotal.toString(), step) }
    }

    @Test fun detailKeepsOriginalAndCurrentTablesSeparateAndParsesPostgresTimestamp() {
        val reply = f.receipt(f.seat()).getJSONObject("data")
        val seating = reply.getJSONObject("seating").put("reservationVersion", 2)
            .put("businessDate", "2026-10-05").put("seatedAt", "2026-10-05 13:00:00+08")
        seating.getJSONArray("sessions").objects().forEach { row ->
            row.put("currentTableId", f.firstTable).put("currentTableCode", "A09")
                .put("currentLocationVersion", 8).put("currentStatus", "closed")
        }
        val detail = ReservationReceptionDetail(reply)
        assertEquals(Instant.parse("2026-10-05T05:00:00Z"), detail.seating!!.seatedAt)
        val second = detail.seating!!.sessions.single { it.tableSessionId == f.secondSession }
        assertEquals(f.secondTable, second.tableIdAtSeating)
        assertEquals("A02", second.tableCodeAtSeating)
        assertEquals(f.firstTable, second.currentTableId)
        assertEquals("A09", second.currentTableCode)
        assertEquals("closed", second.currentStatus)
        assertEquals(4L, second.locationVersionAtSeating)
        assertEquals(8L, second.currentLocationVersion)
    }
}
