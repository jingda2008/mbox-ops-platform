package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SongTest {
    private fun actor() = StaffIdentity.parse(JSONObject(javaClass.classLoader!!.getResourceAsStream("live-reservations.json")!!.bufferedReader().readText()).getJSONObject("auth")).copy(permissions = setOf("song.manage", "song.payment.record"))
    private fun row(status: String = "requested", amount: Long? = null) = LiveSong(JSONObject().put("id", "song-1").put("tableSessionId", "session-1").put("songTitle", "后来").put("status", status).put("quotedAmountMinor", amount ?: JSONObject.NULL).put("currency", if(amount == null) JSONObject.NULL else "CNY"))
    @Test fun paidAndFreePerformanceRequireDifferentEvidence() {
        assertFalse("performed" in row("accepted", 1000).actions(actor()))
        assertTrue("performed" in row("accepted", 0).actions(actor()))
        assertTrue("performed" in row("paid", 1000).actions(actor()))
        assertFalse("cancel" in row("paid", 1000).actions(actor()))
        assertTrue(row("requested").actions(actor().copy(denied = setOf("song.manage"))).isEmpty())
        assertThrows(Exception::class.java) { SongCommands.command(row(), actor(), "confirm", "现场确认", "-1") }
        assertThrows(Exception::class.java) { SongCommands.command(row("accepted", 1000), actor(), "paid", "核对原款") }
    }
    @Test fun immutableReceiptRejectsAmountOrIdentityMismatch() {
        val command = SongCommands.command(row(), actor(), "confirm", "免费演唱", "0")
        assertEquals(command, LiveCommand.parse(JSONObject(command.json().toString())))
        val request = row("accepted", 0).source
        val data = JSONObject().put("request", request).put("previousStatus", "requested").put("action", "confirm").put("reason", "免费演唱").put("paymentId", JSONObject.NULL).put("reconciliationEntryId", JSONObject.NULL)
        val reply = JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true))
        validateSongReply(reply.toString(), command.steps.single())
        request.put("quotedAmountMinor", 100)
        assertThrows(Exception::class.java) { validateSongReply(reply.toString(), command.steps.single()) }
        request.put("quotedAmountMinor", 0).put("tableSessionId", "other-session")
        assertThrows(Exception::class.java) { validateSongReply(reply.toString(), command.steps.single()) }
    }
}
