package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReplacementTest {
    private fun fixture(name: String = "live-replacement.json") =
        JSONObject(javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText())

    private fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))

    private fun board() = LiveAfterSales(fixture().getJSONObject("afterSales"))

    private fun source(b: LiveAfterSales = board()) =
        LiveReplacement.make(b, "case-original", actor())

    private fun product() =
        LiveProduct(fixture("live-catalog.json").getJSONObject("product").toString())

    private fun line() = LiveDraftLine.make(product(), mapOf("g1" to listOf("p1")), "少冰")

    private fun order(
        s: LiveReplacement? = source(),
        b: LiveAfterSales? = board(),
        gift: Boolean = false,
    ): LiveOrderSubmission {
        val a = actor()
        return LiveOrderSubmission.make(
            listOf(line()),
            listOf(product()),
            a,
            LiveOrderAccess(a.employeeId, true, false, null, null),
            LiveOrderContext(
                "context",
                a.employeeId,
                a.sessionId,
                "table-session-1",
                Instant.parse("2099-01-01T00:00:00Z"),
            ),
            "table-session-1",
            "A5",
            gift,
            "换品核对",
            "",
            "table_tab",
            s,
            b,
        )
    }

    private fun row(b: LiveAfterSales) = b.cases[0]

    private fun link(publicID: String = "APP-FIRST", status: String = "submitted") =
        JSONObject()
            .put("orderId", "new-1")
            .put("publicId", publicID)
            .put("status", status)
            .put("sourceCaseId", "case-original")

    private fun reject(work: () -> Unit) {
        assertThrows(IllegalArgumentException::class.java, work)
    }

    @Test
    fun separatelyPricedOriginalBinding() {
        val c = order()
        c.validate()
        val obj = JSONObject(c.body)
        assertEquals("case-original", obj.getString("replacementCaseId"))
        assertEquals("paid", obj.getString("orderMode"))
        assertFalse(obj.has("amountMinor"))
        assertFalse(obj.has("refundAmountMinor"))
        assertFalse(obj.has("replacementPreviousOrderId"))
        reject { order(gift = true) }
        reject { order(b = null) }
    }

    @Test
    fun staleSourceAndOldBackendBlocked() {
        for (mutation in
            listOf<(LiveAfterSales) -> Unit>(
                { row(it).put("canReplace", false) },
                { row(it).put("status", "withdrawn") },
                { row(it).put("revisedByCaseId", "another") },
                { row(it).put("heldQuantity", 0).put("stoppedQuantity", 0) },
                { it.source.remove("supportsNativeReplacementRecovery") },
                { it.item.put("tableSessionId", "other") },
                { row(it).put("replacementOrder", link()) },
            )) {
            val b = board()
            mutation(b)
            reject { source().validate(b, actor()) }
        }
    }

    @Test
    fun deniedEmployeeCannotReplace() {
        val raw =
            fixture()
                .getJSONObject("auth")
                .put("deniedPermissions", JSONArray(listOf("refund.request")))
        reject { source().validate(board(), StaffIdentity.parse(raw)) }
    }

    @Test
    fun cancelledPredecessorRequiresExplicitNewGeneration() {
        val b = board()
        row(b).put("replacementOrder", link(status = "cancelled"))
        val next = source(b)
        val c = order(next, b)
        assertEquals("new-1", JSONObject(c.body).getString("replacementPreviousOrderId"))
        assertNotEquals(source().draftSession, next.draftSession)
        reject { source().validate(b, actor()) }
    }

    @Test
    fun ordinaryAndReplacementDraftsAreSeparate() {
        val a = actor()
        val s = source()
        val book =
            LiveDraftBook()
                .add(line(), a.employeeId, s.session)
                .add(line(), a.employeeId, s.draftSession)
        assertEquals(2, book.entries.size)
        assertEquals(1, book.entries[LiveDraftBook.key(a.employeeId, s.session)]!!.size)
    }

    @Test
    fun durableRequestKeepsBodyKeyAndSource() {
        val c = order()
        val restored = LiveOrderSubmission.parse(c.json())
        assertEquals(c.key, restored.key)
        assertEquals(c.body, restored.body)
        assertEquals(c.replacement, restored.replacement)
        assertEquals(source().draftSession, restored.draftSession)
        val broken = c.copy(replacement = source().copy(previousOrderID = "wrong"))
        reject { broken.validate() }
        val ordinary = order(null, null).json()
        ordinary.remove("replacement")
        assertEquals("table-session-1", LiveOrderSubmission.parse(ordinary).draftSession)
    }

    @Test
    fun cancelledSupersededOrderRecoversWithoutCreatingAnother() {
        val c = order()
        val b = board()
        row(b).put("replacementOrder", link("APP-NEWER"))
        b.source.put(
            "replacementOrders",
            JSONArray().put(link(c.publicId, "cancelled")).put(link("APP-NEWER")),
        )
        val found = source().recoveredReceipt(b, c.publicId)
        assertEquals("new-1", found!!.id)
        assertTrue(found.recovered)
        assertNull(source().recoveredReceipt(b, "missing"))
        reject { source().recoveredReceipt(b, c.publicId, "wrong") }
    }

    @Test
    fun anotherCaseOrDuplicateReceiptCannotClearOriginalRequest() {
        val c = order()
        val b = board()
        b.source.put(
            "replacementOrders",
            JSONArray().put(link(c.publicId).put("sourceCaseId", "other")),
        )
        reject { source().recoveredReceipt(b, c.publicId) }
        b.source.put("replacementOrders", JSONArray().put(link(c.publicId)).put(link(c.publicId)))
        reject { source().recoveredReceipt(b, c.publicId) }
    }

    @Test
    fun creationReceiptIsCheckpointedBeforeSecondaryReadFinishes() {
        val c = order()
        val ack = c.copy(receipt = LiveOrderReceipt(c.publicId, "new-1", 19800, false))
        val checkpoint = LiveOrderSubmission.parse(ack.json())
        assertNotNull(checkpoint.receipt)
        assertFalse(checkpoint.canFinish)
        val verified = checkpoint.copy(replacementVerified = true)
        verified.validate()
        assertTrue(verified.canFinish)
        reject { c.copy(replacementVerified = true).validate() }
    }

    @Test
    fun ambiguousConflictAndExpiredContextStayPending() {
        val c = order()
        assertFalse(c.canReplay(actor(), c.createdAt.plusSeconds(13 * 3600)))
        assertNull(
            LiveOrderSubmission.initialRejection(StaffAPIError(409, "QUANTITY_UNAVAILABLE", ""))
        )
    }
}
