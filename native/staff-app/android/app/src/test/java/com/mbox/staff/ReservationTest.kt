package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReservationTest {
    fun fixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-reservations.json")!!
                .bufferedReader()
                .readText()
        )

    fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))

    fun row() = LiveReservation(fixture().getJSONObject("row"))

    @Test fun newReservationRecoveryAndValidation(){
        val choices=listOf(ReservationTable("table-1","A5","大厅",4));val draft=ReservationDraft(name="顾客",contact="测试联系方式",tables=setOf("table-1"))
        val c=draft.command(actor(),choices);assertEquals("/api/staff/native-reservations",c.steps[0].path);assertEquals(c,LiveCommand.parse(JSONObject(c.json().toString())))
        assertThrows(IllegalArgumentException::class.java){draft.copy(people=5).command(actor(),choices)}
        assertThrows(IllegalArgumentException::class.java){draft.copy(arrival=java.time.Instant.EPOCH).command(actor(),choices)}
        val body=JSONObject(c.steps[0].body).put("id","new-reservation").put("status","confirmed").put("tableLocks",org.json.JSONArray().put(JSONObject().put("tableId","table-1")))
        val response=JSONObject().put("data",body).put("meta",JSONObject().put("replayed",true));validateReservationReply(response.toString(),c.steps[0])
        body.put("guestCount",99);assertThrows(Exception::class.java){validateReservationReply(response.toString(),c.steps[0])}
    }

    @Test
    fun transitions() {
        val row = row()
        val a = actor()
        val c = ReservationCommands.transition(row, "confirm", "已核对", false, a)
        assertEquals("/api/staff/native-reservations/reservation-1/confirm", c.steps[0].path)
        for (action in listOf("complete", "other")) assertThrows(
            IllegalArgumentException::class.java
        ) {
            ReservationCommands.transition(row, action, "", false, a)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ReservationCommands.transition(row, "cancel", "", false, a)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ReservationCommands.transition(row, "confirm", "", true, a)
        }
    }

    @Test
    fun receipt() {
        val c = ReservationCommands.transition(row(), "confirm", "已核对", false, actor())
        val data = fixture().getJSONObject("row").put("status", "confirmed")
        val reply = JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true))
        validateReservationReply(reply.toString(), c.steps[0])
        for (k in listOf("id", "publicId", "status")) {
            val bad = JSONObject(reply.toString())
            bad.getJSONObject("data").put(k, "other")
            assertThrows(Exception::class.java) {
                validateReservationReply(bad.toString(), c.steps[0])
            }
        }
    }

    @Test
    fun queue() {
        val q = LiveReservationIntake(fixture().getJSONObject("queue"))
        val c = ReservationCommands.priority(q, "promote", "现场安排", actor())
        assertEquals("reservation", c.steps[0].reservationProof!!.getString("targetKind"))
        assertThrows(IllegalArgumentException::class.java) {
            ReservationCommands.priority(q, "other", "现场安排", actor())
        }
        assertThrows(IllegalArgumentException::class.java) {
            ReservationCommands.priority(q, "promote", "", actor())
        }
    }

    @Test
    fun dates() {
        val w = ReservationQuery.window("2026-09-28", "2026-09-28")
        assertEquals("2026-09-27T16:00:00Z", w.first)
        assertEquals("2026-09-28T16:00:00Z", w.second)
        for ((a, b) in
            listOf(
                "2026-02-30" to "2026-03-01",
                "2026-09-28" to "2026-09-01",
                "2026-09-01" to "2026-10-02",
            )) assertThrows(Exception::class.java) { ReservationQuery.window(a, b) }
    }
    @Test fun waitlistStateAndRecoveryProof() {
        val source = fixture().getJSONObject("queue").put("kind", "waitlist").put("status", "waiting")
        val row = LiveReservationIntake(source)
        val c = ReservationCommands.waitlist(row, "notified", "电话已联系", actor())
        assertEquals(c, LiveCommand.parse(JSONObject(c.json().toString())))
        val reply = JSONObject().put("data", JSONObject().put("id", "waitlist-id").put("publicId", row.publicId)
            .put("status", "notified").put("previousStatus", "waiting").put("reason", "电话已联系"))
            .put("meta", JSONObject().put("replayed", true))
        validateReservationReply(reply.toString(), c.steps.single())
        reply.getJSONObject("data").put("previousStatus", "arrived")
        assertThrows(Exception::class.java) { validateReservationReply(reply.toString(), c.steps.single()) }
        assertThrows(IllegalArgumentException::class.java) { ReservationCommands.waitlist(row, "seated", "现场核对", actor()) }
        assertThrows(IllegalArgumentException::class.java) { ReservationCommands.waitlist(row, "cancelled", "", actor()) }
        assertTrue(ReservationCommands.waitlistActions("seated").isEmpty())
        assertFalse(LiveReservationIntake(source.put("status", "seated")).active)
    }

}
