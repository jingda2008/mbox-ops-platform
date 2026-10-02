package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DailyPaymentTest {
    private val actor
        get() =
            StaffIdentity.parse(
                JSONObject(
                        javaClass.classLoader!!
                            .getResourceAsStream("live-contract.json")!!
                            .bufferedReader()
                            .readText()
                    )
                    .getJSONObject("auth")
                    .put(
                        "permissions",
                        JSONArray(
                            listOf(
                                "payment.initiate.staff",
                                "reconciliation.view",
                                "reconciliation.manage",
                                "business_day.close",
                            )
                        ),
                    )
            )

    private val access
        get() =
            JSONObject()
                .put("employeeId", actor.employeeId)
                .put("canInitiatePayment", true)
                .put("onlinePaymentProvider", "postar")

    private val order =
        LivePaymentOrder(
            "11111111-1111-4111-8111-111111111111",
            "ORDER-ORIGINAL",
            "CNY",
            "unpaid",
            8800,
            false,
            null,
        )

    private fun command(
        method: String = "native_qr",
        amount: Int = 4000,
        code: String = "",
        orders: List<LivePaymentOrder> = listOf(order),
        access: JSONObject = this.access,
        actor: StaffIdentity = this.actor,
    ) = onlinePayment(actor, access, orders, "session-original", amount, method, code)

    private fun reply(c: LiveCommand): JSONObject {
        val body = JSONObject(c.steps[0].body)
        return JSONObject()
            .put("meta", JSONObject().put("replayed", false))
            .put(
                "data",
                JSONObject()
                    .put("id", "payment-original")
                    .put("publicId", body.getString("publicId"))
                    .put("provider", "postar")
                    .put("method", body.getString("method"))
                    .put("currency", "CNY")
                    .put("amountMinor", body.getInt("amountMinor"))
                    .put("status", "pending")
                    .put(
                        "providerAction",
                        JSONObject()
                            .put("paymentId", "payment-original")
                            .put("paymentPublicId", body.getString("publicId"))
                            .put("status", "pending")
                            .put(
                                "presentation",
                                if (body.getString("method") == "native_qr") "qr" else "barcode",
                            )
                            .put("expiresAt", "2099-01-01T00:00:00Z")
                            .put(
                                "payload",
                                JSONObject()
                                    .put("qrCodeUrl", "https://example.invalid/mock-payment-only"),
                            ),
                    ),
            )
    }

    @Test
    fun boundsAndOriginalOrders() {
        listOf(0, -1, 8801).forEach {
            assertThrows(IllegalArgumentException::class.java) { command(amount = it) }
        }
        listOf(
                emptyList(),
                listOf(order, order),
                listOf(order.copy(pending = true, pendingId = "original")),
            )
            .forEach { assertThrows(IllegalArgumentException::class.java) { command(orders = it) } }
    }

    @Test
    fun currentActorPermissionAndProvider() {
        listOf(
                access.put("employeeId", "other"),
                access.put("canInitiatePayment", false),
                access.put("onlinePaymentProvider", "simulation"),
            )
            .forEach { assertThrows(IllegalArgumentException::class.java) { command(access = it) } }
        assertThrows(IllegalArgumentException::class.java) {
            command(actor = actor.copy(denied = setOf("payment.initiate.staff")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            command(method = "auth_code", code = "https://table-link")
        }
    }

    @Test
    fun paymentCodeNeverStoredInJournalAndOriginalIdSurvives() {
        val original = command(method = "auth_code", code = "0000000000000000")
        val secrets = mutableMapOf<String, String>()
        val safe = secureOnlineCommand(original) { key, value -> secrets[key] = value }
        assertFalse(safe.json().toString().contains("0000000000000000"))
        val restored = LiveCommand.parse(safe.json())
        assertEquals(original.id, restored.id)
        assertEquals(original.steps[0].key, restored.steps[0].key)
        assertEquals(
            "0000000000000000",
            onlineRequestBody(restored.steps[0]) { secrets.getValue(it) }
                .getString("customerAuthCode"),
        )
        assertThrows(IllegalStateException::class.java) {
            onlineRequestBody(restored.steps[0]) { error("secret unavailable") }
        }
        assertThrows(IllegalStateException::class.java) {
            secureOnlineCommand(original) { _, _ -> error("storage full") }
        }
    }

    @Test
    fun wrongReceiptsCannotConfirmMoney() {
        val c = command()
        validateOnlineReply(reply(c).toString(), c.steps[0])
        listOf("id", "publicId", "provider", "method", "currency", "amountMinor").forEach { key ->
            val bad = reply(c)
            bad.getJSONObject("data").put(key, if (key == "amountMinor") 999 else "wrong")
            assertThrows(Exception::class.java) { validateOnlineReply(bad.toString(), c.steps[0]) }
        }
        val bad = reply(c)
        bad.getJSONObject("data").getJSONObject("providerAction").put("paymentId", "other")
        assertThrows(Exception::class.java) { validateOnlineReply(bad.toString(), c.steps[0]) }
    }

    @Test
    fun expiredAndConfirmedQRNeverDisplayed() {
        val receipt = JSONObject().put("kind", "init").put("response", reply(command()))
        assertNotNull(onlineQR(receipt, "pending"))
        listOf("succeeded", "unknown", "failed").forEach { assertNull(onlineQR(receipt, it)) }
        assertNull(onlineQR(receipt, "pending", Instant.parse("2100-01-01T00:00:00Z")))
    }

    @Test
    fun retryReleaseKeepsPendingAndBindsOriginalPayment() {
        val pending = order.copy(pending = true, pendingId = "original")
        val c = onlineRelease(actor, listOf(pending), "original", "session-original", "顾客确认改用现金")
        val response =
            JSONObject()
                .put("meta", JSONObject().put("replayed", true))
                .put(
                    "data",
                    JSONObject()
                        .put("id", "original")
                        .put("publicId", "PAY-ORIGINAL")
                        .put("status", "pending")
                        .put("retryReleasedAt", "2026-09-27 12:00:00+00")
                        .put("retryReleaseReason", "顾客确认改用现金"),
                )
        validateOnlineReply(response.toString(), c.steps[0])
        assertThrows(IllegalArgumentException::class.java) {
            onlineRelease(actor, listOf(pending), "other", "session-original", "顾客确认改用现金")
        }
        response.getJSONObject("data").put("retryReleaseReason", "different reason")
        assertThrows(Exception::class.java) { validateOnlineReply(response.toString(), c.steps[0]) }
    }

    @Test
    fun lostReplyReusesOriginalKeyAndEncryptedCode() {
        val c =
            secureOnlineCommand(command(method = "auth_code", code = "0000000000000000")) { _, _ ->
            }
        var count = 0
        val api = StaffAPI { req ->
            count++
            assertEquals(c.steps[0].key, req.headers["idempotency-key"])
            assertEquals("0000000000000000", req.body!!.getString("customerAuthCode"))
            if (count == 1) throw java.net.SocketTimeoutException("lost response")
            APIResponse(201, reply(c).toString())
        }
        val step =
            c.steps[0].copy(body = onlineRequestBody(c.steps[0]) { "0000000000000000" }.toString())
        assertThrows(java.net.SocketTimeoutException::class.java) { api.execute(step) }
        api.execute(step)
        assertEquals(2, count)
    }

    @Test
    fun ledgerQueryAndInvalidDates() {
        val path = FinanceQuery("2026-09-27", "refund").path("original+cursor/next")
        assertTrue(path.contains("entryType=refund") && path.contains("%2B"))
        assertThrows(Exception::class.java) { FinanceQuery("2026-02-30").path() }
        assertThrows(IllegalArgumentException::class.java) { FinanceQuery(type = "unknown").path() }
    }

    private val row
        get() =
            JSONObject()
                .put("id", "original")
                .put("publicId", "PAY-ORIGINAL")
                .put("status", "pending")

    @Test
    fun unresolvedMoneyCannotBeResolvedOrManagedWithoutPermission() {
        assertThrows(IllegalArgumentException::class.java) {
            financeCommand(actor, row, "正在核对渠道", resolve = true)
        }
        assertThrows(IllegalArgumentException::class.java) {
            financeCommand(actor.copy(denied = setOf("reconciliation.manage")), row, "正在核对渠道")
        }
        assertFalse(
            financeCanResolve(
                row.put("status", "succeeded")
                    .put("financialSignals", JSONArray(listOf("confirmed_payment_not_applied")))
            )
        )
    }

    @Test
    fun financeReceiptMustMatchActorPaymentNoteAndAction() {
        val c = financeCommand(actor, row, "正在核对渠道")
        val response =
            JSONObject()
                .put("replayed", false)
                .put(
                    "data",
                    JSONObject()
                        .put("paymentId", "original")
                        .put("ownerEmployeeId", actor.employeeId)
                        .put("note", "正在核对渠道")
                        .put("status", "reviewing"),
                )
        validateFinanceReply(response.toString(), c.steps[0])
        listOf("paymentId", "ownerEmployeeId", "note", "status").forEach { key ->
            val wrong = JSONObject(response.toString())
            wrong.getJSONObject("data").put(key, "wrong")
            assertThrows(Exception::class.java) {
                validateFinanceReply(wrong.toString(), c.steps[0])
            }
        }
    }

    @Test
    fun emptyClosureValidButInventedCountersRejected() {
        val c = financeCommand(actor, closeDay = true)
        val response =
            JSONObject()
                .put("meta", JSONObject().put("replayed", false))
                .put(
                    "data",
                    JSONObject()
                        .put("businessDays", JSONArray())
                        .put("closedBusinessDayCount", 0)
                        .put("closedTableSessionCount", 0)
                        .put("blockedTableSessionCount", 0),
                )
        validateFinanceReply(response.toString(), c.steps[0])
        response.getJSONObject("data").put("closedTableSessionCount", 1)
        assertThrows(Exception::class.java) {
            validateFinanceReply(response.toString(), c.steps[0])
        }
        assertThrows(IllegalArgumentException::class.java) {
            financeCommand(actor.copy(denied = setOf("business_day.close")), closeDay = true)
        }
    }

    @Test
    fun signedLedgerAndCursorGuards() {
        val row =
            JSONObject()
                .put("id", "ledger-original")
                .put("currency", "CNY")
                .put("businessDate", "2026-09-27")
                .put("occurredAt", "2026-09-27 12:00:00+00")
                .put("entryType", "refund")
                .put("amountMinor", -4000)
        fun page(r: JSONObject, next: String? = null) =
            JSONObject()
                .put("data", JSONArray().put(r))
                .put("meta", JSONObject().put("nextCursor", next ?: JSONObject.NULL))
        val q = FinanceQuery("2026-09-27", "refund")
        validateFinancePage(page(row), q, null)
        listOf("amountMinor" to 4000, "businessDate" to "2026-09-26", "entryType" to "payment")
            .forEach { (key, value) ->
                assertThrows(Exception::class.java) {
                    validateFinancePage(page(JSONObject(row.toString()).put(key, value)), q, null)
                }
            }
        assertThrows(Exception::class.java) { validateFinancePage(page(row, "same"), q, "same") }
    }

    private fun cashierFixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-cashier.json")!!
                .bufferedReader()
                .readText()
        )

    @Test
    fun unpaidCancellationAndExceptionBindOriginalOrderAndMoney() {
        val board = cashierFixture()
        val order =
            board
                .getJSONArray("orders")
                .getJSONObject(0)
                .put("payments", JSONArray())
                .put("paymentStatus", "unpaid")
                .put("status", "submitted")
                .put("outstandingAmountMinor", 10000)
        val manager =
            actor.copy(permissions = setOf("order.cancel_unpaid", "order.settle_exception"))
        val c =
            LiveCashier(board)
                .unpaidCommand(manager, order.getString("id"), false, "guest_left", "现场确认未付款离店")
        val data =
            JSONObject()
                .put("eventId", "event-original")
                .put("orderPublicId", order.getString("publicId"))
                .put("sourceBusinessDate", "2026-09-26")
                .put("actionBusinessDate", "2026-09-27")
                .put("occurredAt", "2026-09-27 12:00:00+00")
                .put("replayed", false)
                .put("deliveredItemCount", 1)
                .put("cancelledItemCount", 0)
                .put("cancelledKdsTaskCount", 0)
                .put("releasedInventoryReservationCount", 0)
        fun response(d: JSONObject) =
            JSONObject().put("data", d).put("meta", JSONObject().put("replayed", false)).toString()
        validateCashierReply(response(data), c.steps[0])
        assertThrows(Exception::class.java) {
            validateCashierReply(
                response(JSONObject(data.toString()).put("orderPublicId", "other")),
                c.steps[0],
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            LiveCashier(board)
                .unpaidCommand(actor, order.getString("id"), false, "guest_left", "现场确认未付款离店")
        }
        order.put("status", "cancelled")
        val e =
            LiveCashier(board)
                .unpaidCommand(manager, order.getString("id"), true, "uncollectible", "现场确认无法收回原款")
        data.put("settledAmountMinor", 10000)
        validateCashierReply(response(data), e.steps[0])
        assertThrows(Exception::class.java) {
            validateCashierReply(response(data.put("settledAmountMinor", 9999)), e.steps[0])
        }
    }

    @Test
    fun pendingOrCapturedPaymentNeverAllowsUnpaidCancellation() {
        listOf("pending", "succeeded", "partially_refunded", "refunded").forEach { state ->
            val board = cashierFixture()
            val order =
                board
                    .getJSONArray("orders")
                    .getJSONObject(0)
                    .put("paymentStatus", "unpaid")
                    .put("status", "submitted")
            order.getJSONArray("payments").getJSONObject(0).put("status", state)
            assertThrows(IllegalArgumentException::class.java) {
                LiveCashier(board)
                    .unpaidCommand(
                        actor.copy(permissions = setOf("order.cancel_unpaid")),
                        order.getString("id"),
                        false,
                        "guest_left",
                        "现场确认未付款离店",
                    )
            }
        }
    }
}
