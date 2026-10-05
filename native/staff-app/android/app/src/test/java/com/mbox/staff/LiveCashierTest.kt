package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveCashierTest {
    private fun fixture(name: String) =
        JSONObject(javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText())

    private fun raw() = fixture("live-cashier.json")

    private fun payment(raw: JSONObject) =
        raw.getJSONArray("orders").getJSONObject(0).getJSONArray("payments").getJSONObject(0)

    private fun refund(raw: JSONObject) = payment(raw).getJSONArray("refunds").getJSONObject(0)

    private val actor
        get() =
            StaffIdentity.parse(
                fixture("live-contract.json")
                    .getJSONObject("auth")
                    .put(
                        "permissions",
                        JSONArray(
                            listOf(
                                "refund.request",
                                "refund.approve",
                                "refund.execute",
                                "reconciliation.view",
                            )
                        ),
                    )
            )

    private fun request(
        board: LiveCashier = LiveCashier(raw()),
        amounts: Map<String, Long> = mapOf("item1" to 2000L),
        purpose: String = "price_adjustment",
    ) =
        board.command(
            actor,
            "order1",
            "pay1",
            "request",
            amounts = amounts,
            reason = "客人确认退差价",
            purpose = purpose,
        )

    @Test
    fun originalItemCapsAndPurpose() {
        val command = request()
        assertEquals("price_adjustment", JSONObject(command.steps[0].body).getString("purpose"))
        assertEquals(2000, command.steps[0].cashierProof!!.getInt("amountMinor"))
        assertEquals(command, LiveCommand.parse(command.json()))
        assertThrows(IllegalArgumentException::class.java) {
            request(amounts = mapOf("item1" to 5001L))
        }
        assertThrows(IllegalArgumentException::class.java) {
            request(amounts = mapOf("foreign" to 100L))
        }
        val raw = raw()
        payment(raw).getJSONArray("refundableItems").getJSONObject(0).put("fundsOnly", true)
        listOf("return_goods", "service_compensation").forEach {
            assertThrows(IllegalArgumentException::class.java) {
                request(LiveCashier(raw), purpose = it)
            }
        }
        raw.getJSONObject("actions").put("canRequestRefund", false)
        assertThrows(IllegalArgumentException::class.java) { request(LiveCashier(raw)) }
    }

    @Test
    fun makerCheckerAndCaseIsolation() {
        val raw = raw()
        refund(raw).put("requestedByEmployeeId", actor.employeeId)
        listOf("approve", "reject").forEach {
            assertThrows(IllegalArgumentException::class.java) {
                LiveCashier(raw).command(actor, "order1", "pay1", it, "refund1", reason = "核对原款通过")
            }
        }
        refund(raw).put("requestedByEmployeeId", "other")
        val command =
            LiveCashier(raw)
                .command(actor, "order1", "pay1", "approve", "refund1", reason = "核对原款通过")
        assertEquals("refund.approve", command.permission)
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw)
                .command(
                    actor.copy(denied = setOf("refund.approve")),
                    "order1",
                    "pay1",
                    "approve",
                    "refund1",
                    reason = "核对原款通过",
                )
        }
        refund(raw)
            .put(
                "afterSalesCase",
                JSONObject()
                    .put("caseId", "case1")
                    .put("orderItemId", "item1")
                    .put("status", "requested"),
            )
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw)
                .command(actor, "order1", "pay1", "approve", "refund1", reason = "核对原款通过")
        }
    }

    @Test
    fun executionAndManualResultBoundaries() {
        val raw = raw()
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw).command(actor, "order1", "pay1", "execute", "refund1")
        }
        refund(raw).put("status", "processing")
        val manual = LiveCashier(raw).command(actor, "order1", "pay1", "manual-result", "refund1")
        assertFalse(JSONObject(manual.steps[0].body).has("receiptReference"))
        payment(raw).put("provider", "physical_pos")
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw).command(actor, "order1", "pay1", "manual-result", "refund1")
        }
        payment(raw).put("provider", "postar")
        refund(raw).put("providerSubmissionState", "submitted")
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw).command(actor, "order1", "pay1", "manual-result", "refund1")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(raw).command(actor, "order1", "pay1", "execute", "refund1")
        }
        val query = LiveCashier(raw).command(actor, "order1", "pay1", "refund-query", "refund1")
        validateCashierReply(
            """{"data":{"status":"processing"},"meta":{"replayed":false}}""",
            query.steps[0],
        )
    }

    @Test
    fun paymentQueryBindsReturnedMoneyToWholeOriginalPayment() {
        val raw = raw()
        payment(raw).put("provider", "postar").put("originalAmountMinor", 15000)
        val step = LiveCashier(raw).command(actor, "order1", "pay1", "payment-query").steps.single()
        val publicID = payment(raw).getString("publicId")
        val complete = JSONObject().put("id", "pay1").put("publicId", publicID)
            .put("currency", "CNY").put("amountMinor", 15000).put("status", "succeeded")
        validateCashierReply(reply(complete), step)
        // The actual API also returns a compact observation without id/amount.
        validateCashierReply(reply(JSONObject().put("publicId", publicID).put("status", "pending")), step)
        mapOf("id" to "another-payment", "currency" to "USD", "amountMinor" to 14999).forEach { (field, value) ->
            val bad = JSONObject(complete.toString()).put(field, value)
            assertThrows(Exception::class.java) { validateCashierReply(reply(bad), step) }
        }
        assertThrows(Exception::class.java) {
            validateCashierReply(reply(complete), step.copy(path = "/api/payments/another-payment/provider-query"))
        }
        // Never compare the order allocation against the combined whole payment.
        payment(raw).put("amountMinor", 5000)
        val combined = LiveCashier(raw).command(actor, "order1", "pay1", "payment-query").steps.single()
        validateCashierReply(reply(complete), combined)
        assertThrows(Exception::class.java) {
            validateCashierReply(reply(JSONObject(complete.toString()).put("amountMinor", 5000)), combined)
        }
    }

    @Test
    fun lostAcknowledgementAndWrongMoney() {
        val command = request()
        val receipt =
            JSONObject()
                .put("id", "new-refund")
                .put("publicId", command.steps[0].cashierProof!!.getString("refundPublicId"))
                .put("paymentId", "pay1")
                .put("amountMinor", 2000)
                .put("currency", "CNY")
                .put("status", "requested")
                .put("allocations", JSONObject(command.steps[0].body).getJSONArray("allocations"))
        val response =
            JSONObject().put("data", receipt).put("meta", JSONObject().put("replayed", true))
        val sent = mutableListOf<APIRequest>()
        var lost = true
        val api = StaffAPI { req ->
            sent.add(req)
            if (lost) {
                lost = false
                throw java.io.IOException("lost reply")
            }
            APIResponse(200, response.toString())
        }
        assertThrows(Exception::class.java) { api.execute(command.steps[0]) }
        api.execute(LiveCommand.parse(command.json()).steps[0])
        assertEquals(sent[0].body.toString(), sent[1].body.toString())
        assertEquals(sent[0].headers, sent[1].headers)
        receipt.getJSONArray("allocations").getJSONObject(0).put("orderItemId", "other")
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
        receipt.getJSONArray("allocations").getJSONObject(0).put("orderItemId", "item1")
        receipt.put("amountMinor", 1999)
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
        receipt.put("amountMinor", 2000).put("paymentId", "other")
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
    }

    private val manager
        get() =
            actor.copy(
                permissions =
                    setOf(
                        "payment.recollect.authorize",
                        "payment.initiate.staff",
                        "reconciliation.view",
                        "payment.collect.all_tables",
                    )
            )

    private fun recovery() = fixture("live-cashier-recovery.json")

    private fun close(raw: JSONObject = recovery(), who: StaffIdentity = manager) =
        LiveCashier(raw).command(who, "order1", "pay1", "close-history", reason = "核对原款未对外展示")

    private fun closeReceipt() =
        JSONObject(
            """{"id":"pay1","publicId":"PAY-one","amountMinor":15000,"currency":"CNY","status":"closed","payableKind":"order_batch","providerSnapshot":{}}"""
        )

    private fun reply(data: JSONObject) =
        JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true)).toString()

    @Test
    fun historyCloseWholeScopeAndCapabilities() {
        val command = close()
        assertEquals(15000, command.steps[0].cashierProof!!.getInt("amountMinor"))
        assertTrue(command.steps[0].cashierProof!!.getString("confirmation").contains("APP-second"))
        assertEquals(command, LiveCommand.parse(command.json()))
        manager.permissions.forEach { capability ->
            assertThrows(IllegalArgumentException::class.java) {
                close(who = manager.copy(denied = setOf(capability)))
            }
        }
        listOf("available", "settled", "permission_required").forEach { status ->
            val source = recovery()
            source
                .getJSONArray("orders")
                .getJSONObject(0)
                .getJSONObject("closedDebtRecovery")
                .put("status", status)
            assertThrows(IllegalArgumentException::class.java) { close(source) }
        }
        val missing = recovery()
        missing
            .getJSONArray("orders")
            .getJSONObject(0)
            .getJSONObject("closedDebtRecovery")
            .remove("closableUnpresentedPayments")
        assertThrows(IllegalArgumentException::class.java) { close(missing) }
        val badScope = recovery()
        badScope
            .getJSONArray("orders")
            .getJSONObject(0)
            .getJSONObject("closedDebtRecovery")
            .getJSONArray("closableUnpresentedPayments")
            .getJSONObject(0)
            .put("orderPublicIds", JSONArray(listOf("APP-second", "APP-order")))
        assertThrows(IllegalArgumentException::class.java) { close(badScope) }
        val disabled =
            recovery().also { it.getJSONObject("actions").put("canInitiateOnlinePayment", false) }
        assertThrows(IllegalArgumentException::class.java) { close(disabled) }
    }

    @Test
    fun historyCloseLostReceiptRetainsOriginalCommand() {
        val command = close()
        validateCashierReply(reply(closeReceipt()), command.steps[0])
        mapOf(
                "amountMinor" to 10000,
                "id" to "another",
                "status" to "pending",
                "payableKind" to "order",
            )
            .forEach { (key, bad) ->
                assertThrows(StaffAPIError::class.java) {
                    validateCashierReply(reply(closeReceipt().put(key, bad)), command.steps[0])
                }
            }
        val sent = mutableListOf<APIRequest>()
        var lost = true
        val api = StaffAPI { req ->
            sent.add(req)
            if (lost) {
                lost = false
                throw java.io.IOException("lost acknowledgement")
            }
            APIResponse(200, reply(closeReceipt()))
        }
        assertThrows(Exception::class.java) { api.execute(command.steps[0]) }
        api.execute(LiveCommand.parse(command.json()).steps[0])
        assertEquals(sent[0].body.toString(), sent[1].body.toString())
        assertEquals(sent[0].headers, sent[1].headers)
    }

    @Test
    fun recollectionAuthorizationIsNotCollection() {
        val source = recovery()
        fun authorize() =
            LiveCashier(source).command(manager, "order1", "", "recollect", reason = "客人同意再次支付")
        assertThrows(IllegalArgumentException::class.java) { authorize() }
        val order = source.getJSONArray("orders").getJSONObject(0)
        order.getJSONObject("closedDebtRecovery").put("status", "authorization_required")
        val command = authorize()
        assertEquals("/api/orders/order1/recollection-authorizations", command.steps[0].path)
        assertEquals(2000, command.steps[0].cashierProof!!.getInt("amountMinor"))
        val receipt =
            JSONObject()
                .put("id", "auth1")
                .put("publicId", "recollect-one")
                .put("orderId", "order1")
                .put("amountMinor", 2000)
                .put("currency", "CNY")
                .put("reason", "客人同意再次支付")
                .put("authorizedByEmployeeId", manager.employeeId)
                .put("expiresAt", "2026-09-27T02:00:00Z")
                .put("createdAt", "2026-09-27T01:30:00Z")
        validateCashierReply(reply(receipt), command.steps[0])
        mapOf(
                "amountMinor" to 2100,
                "orderId" to "other",
                "authorizedByEmployeeId" to "other",
                "reason" to "changed",
            )
            .forEach { (key, bad) ->
                assertThrows(StaffAPIError::class.java) {
                    validateCashierReply(
                        reply(JSONObject(receipt.toString()).put(key, bad)),
                        command.steps[0],
                    )
                }
            }
        order.put(
            "recollectionAuthorization",
            JSONObject()
                .put("id", "existing")
                .put("amountMinor", 2000)
                .put("expiresAt", "2026-09-27T02:00:00Z"),
        )
        assertThrows(IllegalArgumentException::class.java) { authorize() }
        order.remove("recollectionAuthorization")
        order.put("outstandingAmountMinor", 0)
        assertThrows(IllegalArgumentException::class.java) { authorize() }
    }

    private fun historyRaw() = fixture("live-historical-collection.json")

    private val collector
        get() =
            manager.copy(
                permissions =
                    manager.permissions +
                        setOf(
                            "payment.manual.cash.record",
                            "payment.manual.pos.record",
                            "payment.manual.external.record",
                        )
            )

    private fun historical(
        source: JSONObject = historyRaw(),
        provider: String = "cash",
        tender: Long? = 3000,
        ref: String = "POS-001",
        method: String = "bank_transfer",
        note: String = "核对实际转账到账",
        who: StaffIdentity = collector,
        original: CashierOrder? = null,
    ): LiveCommand {
        val board = LiveCashier(source)
        return board.historicalCollection(
            who,
            original ?: board.orders[0],
            provider,
            tender,
            ref,
            if (provider == "cash") "" else "POS-01",
            method,
            note,
        )
    }

    private fun historicalReceipt(command: LiveCommand): JSONObject {
        val body = JSONObject(command.steps[0].body)
        val evidence =
            JSONObject()
                .put("collectedByEmployeeId", collector.employeeId)
                .put("receiptReference", body.getString("receiptReference"))
        listOf("terminalId", "externalMethodCode", "collectionNote")
            .filter { body.has(it) }
            .forEach { evidence.put(it, body.get(it)) }
        return JSONObject()
            .put("id", "payment-history")
            .put("publicId", body.getString("publicId"))
            .put("orderId", "order1")
            .put("payableKind", "order")
            .put("amountMinor", 2000)
            .put("currency", "CNY")
            .put("status", "succeeded")
            .put("provider", body.getString("provider"))
            .put("method", body.getString("method"))
            .put("providerTransactionId", body.getString("receiptReference"))
            .put("providerSnapshot", evidence)
    }

    @Test
    fun historicalOriginalFullAmountAndEvidence() {
        val command = historical()
        val body = JSONObject(command.steps[0].body)
        assertEquals("/api/payments/manual/closed-debt", command.steps[0].path)
        assertFalse(body.has("amountMinor"))
        assertFalse(body.has("orderIds"))
        assertEquals(2000, body.getJSONObject("closedDebtGuard").getInt("amountMinor"))
        assertNull(command.steps[0].collectionSession)
        assertTrue(
            command.steps[0]
                .cashierProof!!
                .getString("confirmation")
                .contains("找零：${historyMoney(1000)}")
        )
        listOf(null, 1999L).forEach { tender ->
            assertThrows(IllegalArgumentException::class.java) { historical(tender = tender) }
        }
        listOf("physical_pos", "external_manual").forEach { provider ->
            assertThrows(IllegalArgumentException::class.java) {
                historical(provider = provider, ref = "")
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            historical(provider = "external_manual", method = "invalid")
        }
        assertThrows(IllegalArgumentException::class.java) {
            historical(provider = "external_manual", note = "")
        }
        listOf("cash", "physical_pos", "external_manual").forEach { provider ->
            val c = historical(provider = provider)
            validateCashierReply(reply(historicalReceipt(c)), c.steps[0])
        }
    }

    @Test
    fun historicalOldServerDeniedAndStaleForm() {
        val old =
            historyRaw().also {
                it.getJSONObject("actions").remove("supportsGuardedClosedDebtCollection")
            }
        assertThrows(IllegalArgumentException::class.java) { historical(source = old) }
        listOf(
                "payment.manual.cash.record",
                "payment.collect.all_tables",
                "payment.recollect.authorize",
            )
            .forEach { permission ->
                assertThrows(IllegalArgumentException::class.java) {
                    historical(who = collector.copy(denied = setOf(permission)))
                }
            }
        listOf("amount", "session", "authorization", "pending").forEach { field ->
            val source = historyRaw()
            val order = source.getJSONArray("orders").getJSONObject(0)
            when (field) {
                "amount" -> order.put("outstandingAmountMinor", 2500)
                "session" -> order.put("tableSessionId", "another-session")
                "authorization" ->
                    order.getJSONObject("recollectionAuthorization").put("id", "another-auth")
                "pending" ->
                    order
                        .getJSONObject("closedDebtRecovery")
                        .put("pendingPaymentIds", JSONArray(listOf("unknown")))
            }
            assertThrows(IllegalArgumentException::class.java) {
                historical(source = source, original = LiveCashier(historyRaw()).orders[0])
            }
        }
    }

    @Test
    fun historicalMismatchAndLostReceiptStayBoundToOriginal() {
        val command = historical()
        mapOf(
                "amountMinor" to 3000,
                "orderId" to "other",
                "status" to "pending",
                "payableKind" to "order_batch",
                "providerTransactionId" to "wrong",
                "currency" to "USD",
            )
            .forEach { (key, bad) ->
                assertThrows(StaffAPIError::class.java) {
                    validateCashierReply(
                        reply(historicalReceipt(command).put(key, bad)),
                        command.steps[0],
                    )
                }
            }
        val wrong = historicalReceipt(command)
        wrong.getJSONObject("providerSnapshot").put("collectedByEmployeeId", "other")
        assertThrows(StaffAPIError::class.java) {
            validateCashierReply(reply(wrong), command.steps[0])
        }
        val sent = mutableListOf<APIRequest>()
        var lost = true
        val api = StaffAPI { req ->
            sent.add(req)
            if (lost) {
                lost = false
                throw java.io.IOException("lost reply")
            }
            APIResponse(200, reply(historicalReceipt(command)))
        }
        assertThrows(Exception::class.java) { api.execute(command.steps[0]) }
        api.execute(LiveCommand.parse(command.json()).steps[0])
        assertEquals(sent[0].body.toString(), sent[1].body.toString())
        assertEquals(sent[0].headers, sent[1].headers)
    }

    @Test
    fun onlyExplicitHistoricalRollbackUnlocksRecheck() {
        assertTrue(
            StaffAPIError(409, "HISTORICAL_COLLECTION_CHANGED", "changed", "not_committed")
                .definitivelyRejected
        )
        assertFalse(
            StaffAPIError(409, "HISTORICAL_COLLECTION_CHANGED", "changed").definitivelyRejected
        )
        assertFalse(
            StaffAPIError(409, "FINANCIAL_REFERENCE_CONFLICT", "duplicate", "not_committed")
                .definitivelyRejected
        )
    }
}
