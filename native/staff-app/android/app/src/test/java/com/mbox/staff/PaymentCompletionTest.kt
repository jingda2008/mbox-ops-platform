package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PaymentCompletionTest {
    private fun fixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-payment-completion.json")!!
                .bufferedReader()
                .readText()
        )

    private fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))

    private fun af() = LiveAfterSales(fixture().getJSONObject("afterSales"))

    private fun board() = LiveCashier(fixture().getJSONObject("cashier"))

    private fun reject(block: () -> Unit) {
        assertThrows(IllegalArgumentException::class.java, block)
    }

    @Test
    fun originalBundleAndAvailableQuantity() {
        val a = af()
        a.validate("item-original")
        reject { a.validate("other") }
        val c = a.command(actor(), "request", quantity = 1, reason = "客人取消")
        assertEquals("item-original", JSONObject(c.steps[0].body).getString("orderItemId"))
        reject { a.command(actor(), "request", quantity = 2, reason = "客人取消") }
    }

    @Test
    fun fundingMustMatchActualOriginalMoney() {
        reject {
            af()
                .command(
                    actor(),
                    "approved",
                    "case-original",
                    reason = "核对原款",
                    shares = mapOf("payment-cash" to 8000),
                )
        }
        reject {
            af()
                .command(
                    actor(),
                    "approved",
                    "case-original",
                    reason = "核对原款",
                    shares = mapOf("payment-cash" to 3000, "payment-pos" to 3000),
                )
        }
        val c =
            af()
                .command(
                    actor(),
                    "approved",
                    "case-original",
                    reason = "核对原款",
                    shares = mapOf("payment-cash" to 4000, "payment-pos" to 4000),
                )
        assertTrue(c.steps[0].afterSalesProof!!.getString("confirmation").contains("payment-cash"))
        val denied =
            StaffIdentity.parse(
                fixture()
                    .getJSONObject("auth")
                    .put("deniedPermissions", JSONArray(listOf("refund.approve")))
            )
        reject {
            af()
                .command(
                    denied,
                    "approved",
                    "case-original",
                    reason = "核对原款",
                    shares = mapOf("payment-cash" to 4000, "payment-pos" to 4000),
                )
        }
    }

    @Test
    fun physicalTruthAndNoticesDoNotAutomaticallyClear() {
        listOf("unit-free", "unit-unmade").forEach { id ->
            reject {
                af()
                    .command(
                        actor(),
                        "returned_unopened",
                        "case-original",
                        reason = "实物核对",
                        unitIDs = setOf(id),
                        confirmed = true,
                    )
            }
        }
        val c =
            af()
                .command(
                    actor(),
                    "returned_unopened",
                    "case-original",
                    reason = "实物核对",
                    unitIDs = setOf("unit-held"),
                    confirmed = true,
                )
        assertTrue(JSONObject(c.steps[0].body).getBoolean("unopenedReceived"))
        reject { af().command(actor(), "notice-ack", "case-original", reason = "岗位确认") }
        assertTrue(
            af()
                .command(actor(), "notice-ack", "case-original", reason = "岗位确认", confirmed = true)
                .steps[0]
                .afterSalesProof!!
                .getString("confirmation")
                .contains("暂停两瓶")
        )
    }

    @Test
    fun onlineRefundCannotBeMarkedCashPaid() {
        reject {
            af()
                .command(
                    actor(),
                    "cash-paid",
                    "case-original",
                    reason = "实退核对",
                    refundID = "refund-original",
                    confirmed = true,
                )
        }
        af()
            .command(
                actor(),
                "refund-retry",
                "case-original",
                reason = "原失败重试",
                refundID = "refund-original",
            )
    }

    @Test
    fun originalAfterSalesAcknowledgement() {
        val c = af().command(actor(), "request", quantity = 1, reason = "客人取消")
        val d =
            JSONObject()
                .put("caseId", "case-new")
                .put("orderId", "order-original")
                .put("selectedQuantity", 1)
                .put("physicalComplete", false)
                .put("moneyComplete", false)
                .put("succeededMinor", 0)
        validateAfterSalesReply(
            JSONObject().put("replayed", false).put("data", d).toString(),
            c.steps[0],
        )
        d.put("orderId", "other")
        assertThrows(Exception::class.java) {
            validateAfterSalesReply(
                JSONObject().put("replayed", true).put("data", d).toString(),
                c.steps[0],
            )
        }
    }

    @Test
    fun activityConfirmationEvidenceAndOldServerGate() {
        val c = board().activityCommand(actor(), "activity-reg", "collect", confirmed = true)
        assertEquals(8800, JSONObject(c.steps[0].body).getInt("expectedAmountMinor"))
        reject { board().activityCommand(actor(), "activity-reg", "collect") }
        reject {
            board()
                .activityCommand(
                    actor(),
                    "activity-reg",
                    "collect",
                    provider = "physical_pos",
                    reference = "POS-123",
                    confirmed = true,
                )
        }
        reject {
            board()
                .activityCommand(
                    actor(),
                    "activity-reg",
                    "collect",
                    provider = "external_manual",
                    reference = "TX-123",
                    confirmed = true,
                )
        }
        val b = fixture().getJSONObject("cashier")
        b.getJSONObject("actions").remove("supportsGuardedActivityCashier")
        reject {
            LiveCashier(b).activityCommand(actor(), "activity-reg", "collect", confirmed = true)
        }
    }

    @Test
    fun lateSuccessStopsReplacementAndRefundTargetsOriginal() {
        val b = fixture().getJSONObject("cashier")
        val r = b.getJSONArray("activityRegistrations").getJSONObject(0)
        r.put(
            "lateSuccessPayments",
            JSONArray()
                .put(
                    JSONObject()
                        .put("publicId", "LATE-ORIGINAL")
                        .put("currency", "CNY")
                        .put("remainingRefundableMinor", 8800)
                ),
        )
        val board = LiveCashier(b)
        reject { board.activityCommand(actor(), "activity-reg", "collect", confirmed = true) }
        val c =
            board.activityCommand(
                actor(),
                "activity-reg",
                "refund",
                reason = "迟到旧款退回",
                paymentPublicID = "LATE-ORIGINAL",
            )
        assertEquals(
            "LATE-ORIGINAL",
            JSONObject(c.steps[0].body).getString("expectedPaymentPublicId"),
        )
    }

    @Test
    fun changedActivityAmountCannotBeAcknowledged() {
        val c = board().activityCommand(actor(), "activity-reg", "collect", confirmed = true)
        val d =
            JSONObject()
                .put("id", "payment-original")
                .put("publicId", JSONObject(c.steps[0].body).getString("publicId"))
                .put("payableKind", "activity_registration")
                .put("activityRegistrationId", "activity-reg")
                .put("amountMinor", 8800)
                .put("currency", "CNY")
                .put("status", "succeeded")
                .put("provider", "cash")
                .put("method", "cash")
                .put(
                    "providerSnapshot",
                    JSONObject().put("collectedByEmployeeId", actor().employeeId),
                )
        val root = JSONObject().put("meta", JSONObject().put("replayed", true)).put("data", d)
        validateActivityReply(root.toString(), c.steps[0])
        d.put("amountMinor", 8801)
        assertThrows(Exception::class.java) { validateActivityReply(root.toString(), c.steps[0]) }
    }

    @Test
    fun printingDistinguishesFailureUnknownAndInFlight() {
        val j = fixture().getJSONObject("printJob")
        val id = j.getString("id")
        printingCommand(actor(), "retry", id, "缺纸已补充", j, confirmed = true)
        j.put("failureCode", "print_result_unknown")
        reject { printingCommand(actor(), "retry", id, "结果不明", j, confirmed = true) }
        reject { printingCommand(actor(), "reprint", id, "原单出纸模糊", j) }
        j.put("status", "printing")
        reject { printingCommand(actor(), "reprint", id, "原单出纸模糊", j, confirmed = true) }
    }

    @Test
    fun reprintAcknowledgementBoundToImmutableOriginal() {
        val j = fixture().getJSONObject("printJob")
        val c =
            printingCommand(actor(), "reprint", j.getString("id"), "原单出纸模糊", j, confirmed = true)
        val d =
            JSONObject()
                .put("id", "22222222-2222-4222-8222-222222222222")
                .put("status", "pending")
                .put("reprintOfJobId", j.getString("id"))
                .put("reprintReason", "原单出纸模糊")
        val root = JSONObject().put("replayed", false).put("data", d)
        validatePrintReply(root.toString(), c.steps[0])
        d.put("reprintOfJobId", "other-job")
        assertThrows(Exception::class.java) { validatePrintReply(root.toString(), c.steps[0]) }
    }

    @Test
    fun cashCountRequiresAnotherPersonAndFreshLedger() {
        val b = fixture().getJSONObject("cashHandover")
        reject { cashHandoverCommand(actor(), b, "approve", 8100, reason = "独立核对原现金") }
        val auth = fixture().getJSONObject("auth")
        auth.getJSONObject("employee").put("id", "another-reviewer")
        auth.getJSONObject("session").put("employeeId", "another-reviewer")
        val reviewer = StaffIdentity.parse(auth)
        val c = cashHandoverCommand(reviewer, b, "approve", 8100, reason = "独立核对原现金")
        assertEquals(3, JSONObject(c.steps[0].body).getInt("expectedRevision"))
        reject { cashHandoverCommand(reviewer, b, "approve", 8200, reason = "金额不符禁止交接") }
        b.getJSONObject("ledger").put("count", 3)
        reject { cashHandoverCommand(reviewer, b, "approve", 8100, reason = "新增现金流水检查") }
        reject { cashCount(mapOf("3" to 1)) }
        assertEquals(10100, cashCount(mapOf("10000" to 1, "50" to 2)))
    }

    @Test
    fun voucherSecretsAreSeparateAndReviewCannotApproveSelf() {
        val f = fixture()
        val c =
            voucherRedeem(
                actor(),
                f.getJSONObject("voucherPreview"),
                f.getJSONObject("voucherPlatform"),
                "ORIGINAL-VOUCHER-CODE",
                confirmed = true,
            )
        var secret = ""
        val safe = secureVoucherCommand(c) { _, s -> secret = s }
        val body = JSONObject(safe.steps[0].body)
        assertFalse(body.has("voucherCode"))
        assertFalse(body.has("prepareHandle"))
        assertEquals(
            "ORIGINAL-VOUCHER-CODE",
            voucherRequestBody(safe.steps[0]) { secret }.getString("voucherCode"),
        )
        assertThrows(Exception::class.java) {
            secureVoucherCommand(c) { _, _ -> error("storage failed") }
        }
        val row = f.getJSONObject("voucherOperation")
        reject { voucherFollowup(actor(), row, "approve", confirmed = true) }
        val auth = f.getJSONObject("auth")
        auth.getJSONObject("employee").put("id", "another-reviewer")
        auth.getJSONObject("session").put("employeeId", "another-reviewer")
        val r =
            voucherFollowup(
                StaffIdentity.parse(auth),
                row,
                "reject",
                reason = "原证据需要补充",
                confirmed = true,
            )
        assertEquals(
            row.getJSONObject("review").getString("id"),
            JSONObject(r.steps[0].body).getString("reviewId"),
        )
    }

    @Test
    fun unknownResultsNeverDiscardOriginalCommands() {
        assertFalse(StaffAPIError(409, "VOUCHER_OPERATION_REVIEW", "unknown").definitivelyRejected)
        assertFalse(StaffAPIError(400, "FINANCE_REVIEW_FAILED", "unknown").definitivelyRejected)
        assertTrue(
            StaffAPIError(409, "CASH_HANDOVER_CHANGED", "stale", "not_committed")
                .definitivelyRejected
        )
    }

    @Test
    fun concurrentOnlineReuseRequiresServerBindingOfOriginalScope() {
        val f = fixture().getJSONObject("onlineReuse")
        val step =
            LiveStep(
                "/api/payments",
                f.getJSONObject("body").toString(),
                "idempotency-key",
                f.getString("key"),
                f.getJSONObject("proof").toString(),
            )
        validateOnlineReply(f.getJSONObject("reply").toString(), step)
        listOf("orderIds", "employeeId", "idempotencyKey", "amountMinor", "paymentId").forEach {
            field ->
            val bad = JSONObject(f.getJSONObject("reply").toString())
            bad.getJSONObject("meta")
                .getJSONObject("requestBinding")
                .put(
                    field,
                    when (field) {
                        "orderIds" -> JSONArray(listOf("another-order"))
                        "amountMinor" -> 9999
                        else -> "wrong"
                    },
                )
            assertThrows(Exception::class.java) { validateOnlineReply(bad.toString(), step) }
        }
    }

    @Test
    fun durableVoucherRecoveryDoesNotNeedLostDeviceSecret() =
        kotlinx.coroutines.runBlocking {
            val f = fixture()
            val c =
                voucherRedeem(
                    actor(),
                    f.getJSONObject("voucherPreview"),
                    f.getJSONObject("voucherPlatform"),
                    "ORIGINAL-VOUCHER-CODE",
                    confirmed = true,
                )
            val safe = secureVoucherCommand(c) { _, _ -> }
            val row =
                f.getJSONObject("voucherOperation")
                    .put("publicId", JSONObject(c.steps[0].body).getString("publicId"))
            var sends = 0
            var reads = 0
            performVoucherStep(
                safe.steps[0],
                read = {
                    JSONObject()
                        .put("meta", JSONObject().put("protocol", 1))
                        .put("data", row)
                        .toString()
                },
                send = {
                    sends++
                    error("no send")
                },
                secret = {
                    reads++
                    error("lost secret")
                },
            )
            assertEquals(0, sends)
            assertEquals(0, reads)
        }
}
