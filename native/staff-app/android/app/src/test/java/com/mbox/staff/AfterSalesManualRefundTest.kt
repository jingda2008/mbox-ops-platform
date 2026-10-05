package com.mbox.staff

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AfterSalesManualRefundTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!
        .getResourceAsStream("live-payment-completion.json")!!.bufferedReader().use { it.readText() })
    private fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))
    private fun board(provider: String = "cash", status: String = "approved"): LiveAfterSales {
        val source = fixture().getJSONObject("afterSales")
        source.getJSONArray("cases").getJSONObject(0).put("status", "approved")
            .getJSONArray("refunds").getJSONObject(0).put("provider", provider).put("status", status)
        return LiveAfterSales(source)
    }
    private fun refund(board: LiveAfterSales) = board.cases[0].getJSONArray("refunds").getJSONObject(0)
    private fun command(board: LiveAfterSales = board(), reference: String = "POS-RETURN-123") =
        board.command(actor(), if (refund(board).getString("provider") == "cash") "cash-paid" else "manual-paid",
            "case-original", reason = "核实原款已经实际退给顾客", refundID = "refund-original",
            confirmed = true, receiptReference = reference)

    private fun receipt(step: LiveStep, replayed: Boolean = false): JSONObject {
        val proof = step.afterSalesProof!!
        val body = JSONObject(step.body)
        return JSONObject().put("data", JSONObject()
            .put("id", "refund-original").put("orderId", "order-original")
            .put("paymentProvider", proof.textOrNull("paymentProvider") ?: "cash")
            .put("amountMinor", 8000).put("currency", "CNY")
            .put("status", if (step.path.endsWith("/execute")) "processing" else "succeeded")
            .put("providerRefundId", body.textOrNull("receiptReference") ?: "CASH-REFUND-refund-original"))
            .put("meta", JSONObject().put("replayed", replayed))
    }

    @Test
    fun approvedCashBeginsExecutionBeforeRecordingActualPayout() {
        val command = command()
        assertEquals(2, command.steps.size)
        assertTrue(command.steps[0].path.endsWith("/execute"))
        assertTrue(command.steps[1].path.endsWith("/manual-result"))
        assertEquals(command.steps[1].key + "-begin", command.steps[0].key)
        assertTrue(validAfterSalesCommandSelection(command, board()))
        assertEquals(command, LiveCommand.parse(command.json()))
        command.steps.forEach { validateAfterSalesReply(receipt(it).toString(), it) }
        val processing = command(board(status = "processing"))
        assertEquals(1, processing.steps.size)
        assertTrue(validAfterSalesCommandSelection(processing, board(status = "processing")))
        assertFalse(validAfterSalesCommandSelection(processing, board()))
    }

    @Test
    fun posAndExternalRequireActualRefundReferenceAndConfirmation() {
        listOf("physical_pos", "external_manual").forEach { provider ->
            val board = board(provider)
            val command = command(board, " original-refund-reference ")
            assertEquals(2, command.steps.size)
            assertEquals("original-refund-reference", JSONObject(command.steps.last().body).getString("receiptReference"))
            assertTrue(validAfterSalesCommandSelection(command, board))
            command.steps.forEach { validateAfterSalesReply(receipt(it).toString(), it) }
            assertThrows(IllegalArgumentException::class.java) { command(board, " ") }
            assertThrows(IllegalArgumentException::class.java) { command(board, "x".repeat(257)) }
            assertThrows(IllegalArgumentException::class.java) {
                board.command(actor(), "manual-paid", "case-original", reason = "尚未实际退款",
                    refundID = "refund-original", receiptReference = "ref-123")
            }
            assertThrows(IllegalArgumentException::class.java) {
                board.command(actor().copy(denied = setOf("refund.execute")), "manual-paid", "case-original",
                    reason = "实物核对", refundID = "refund-original", confirmed = true, receiptReference = "ref-123")
            }
        }
        assertThrows(IllegalArgumentException::class.java) { command(board("postar")) }
        listOf("requested", "succeeded", "failed", "rejected").forEach {
            assertThrows(IllegalArgumentException::class.java) { command(board(status = it)) }
        }
    }

    @Test
    fun rejectsReceiptFromAnotherRefundOrderProviderAmountOrReference() {
        val command = command(board("physical_pos"))
        command.steps.forEach { step ->
            mapOf("id" to "other-refund", "orderId" to "other-order", "paymentProvider" to "cash",
                "amountMinor" to 7999, "currency" to "USD", "status" to "approved").forEach { (field, value) ->
                val wrong = receipt(step).also { it.getJSONObject("data").put(field, value) }
                assertThrows(Exception::class.java) { validateAfterSalesReply(wrong.toString(), step) }
            }
        }
        val step = command.steps.last()
        val wrong = receipt(step).also { it.getJSONObject("data").put("providerRefundId", "another-reference") }
        assertThrows(Exception::class.java) { validateAfterSalesReply(wrong.toString(), step) }
    }

    @Test
    fun bothPhasesRecoverLostAcknowledgementWithOriginalKeys() = runBlocking {
        for (lostPhase in 0..1) {
            val original = command()
            var persisted = original
            var state = "approved"
            var lost = false
            val committed = mutableMapOf<String, JSONObject>()
            val sent = mutableListOf<APIRequest>()
            var payouts = 0
            val api = StaffAPI { request ->
                sent += request
                val key = request.headers.getValue("idempotency-key")
                val step = original.steps.single { it.key == key }
                val previous = committed[key]
                if (previous != null) APIResponse(200, JSONObject(previous.toString())
                    .put("meta", JSONObject().put("replayed", true)).toString())
                else {
                    if (step.path.endsWith("/execute")) {
                        check(state == "approved")
                        state = "processing"
                    } else {
                        // Mirrors RefundRepository.completeLocked: approved -> succeeded is invalid.
                        check(state == "processing")
                        state = "succeeded"
                        payouts++
                    }
                    val reply = receipt(step)
                    committed[key] = reply
                    if (!lost && original.steps.indexOf(step) == lostPhase) {
                        lost = true
                        throw IOException("lost acknowledgement")
                    }
                    APIResponse(200, reply.toString())
                }
            }
            try {
                LiveCommandRunner.advance(persisted, { api.execute(it) }, { persisted = it })
                fail("Expected lost response")
            } catch (_: IOException) { }
            assertEquals(lostPhase, persisted.completedSteps)
            LiveCommandRunner.advance(LiveCommand.parse(persisted.json()), { api.execute(it) }, { persisted = it })
            assertEquals(2, persisted.completedSteps)
            assertEquals("succeeded", state)
            assertEquals(1, payouts)
            assertEquals(2, committed.size)
            assertEquals(2, sent.count { it.headers["idempotency-key"] == original.steps[lostPhase].key })
        }
    }

    @Test
    fun failedCheckpointKeepsBothOriginalPhaseKeys() = runBlocking {
        val command = command()
        val calls = mutableListOf<String>()
        try {
            LiveCommandRunner.advance(command, { calls += it.key }, { throw IOException("disk full") })
            fail("Expected checkpoint failure")
        } catch (_: IOException) { }
        LiveCommandRunner.advance(LiveCommand.parse(command.json()), { calls += it.key }, {})
        assertEquals(listOf(command.steps[0].key, command.steps[0].key, command.steps[1].key), calls)
    }

    private fun legacy(): LiveCommand {
        val current = command()
        val final = current.steps.last()
        val proof = final.afterSalesProof!!.also { it.remove("paymentProvider") }
        return current.copy(steps = listOf(final.copy(recoveryBody = proof.toString())))
    }

    @Test
    fun upgradesLegacyApprovedCashWithoutReplacingFinalRequest() {
        val legacy = legacy()
        val originalStep = legacy.steps.single()
        val upgraded = recoverLegacyAfterSalesCashCommand(legacy, board(), actor())
        assertEquals(legacy.id, upgraded.id)
        assertEquals(legacy.employeeID, upgraded.employeeID)
        assertEquals(originalStep, upgraded.steps.last())
        assertEquals(originalStep.key + "-begin", upgraded.steps.first().key)
        assertEquals(upgraded, recoverLegacyAfterSalesCashCommand(upgraded, board(), actor()))
        upgraded.steps.forEach { validateAfterSalesReply(receipt(it).toString(), it) }
    }

    @Test
    fun legacyProcessingOrSucceededReplaysFinalKeyWithoutANewBegin() {
        val legacy = legacy()
        listOf("processing", "succeeded", "failed").forEach { status ->
            assertEquals(legacy, recoverLegacyAfterSalesCashCommand(legacy, board(status = status), actor()))
        }
        assertEquals(legacy.copy(completedSteps = 1), recoverLegacyAfterSalesCashCommand(
            legacy.copy(completedSteps = 1), board(), actor()))
    }

    @Test
    fun legacyMismatchDoesNotUnlockOrChangeUnknownRequest() {
        val legacy = legacy()
        val snapshot = legacy.json().toString()
        assertThrows(IllegalArgumentException::class.java) {
            recoverLegacyAfterSalesCashCommand(legacy, board(), actor().copy(employeeId = "another-employee"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            recoverLegacyAfterSalesCashCommand(legacy, board(), actor().copy(denied = setOf("refund.execute")))
        }
        val changed = board().also { refund(it).put("amountMinor", 7999) }
        assertThrows(IllegalArgumentException::class.java) { recoverLegacyAfterSalesCashCommand(legacy, changed, actor()) }
        assertThrows(IllegalArgumentException::class.java) { recoverLegacyAfterSalesCashCommand(legacy, board("postar"), actor()) }
        val other = board().also { it.item.put("orderId", "another-order") }
        assertThrows(IllegalArgumentException::class.java) { recoverLegacyAfterSalesCashCommand(legacy, other, actor()) }
        assertEquals(snapshot, legacy.json().toString())
    }
}
