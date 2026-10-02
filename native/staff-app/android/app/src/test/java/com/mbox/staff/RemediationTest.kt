package com.mbox.staff

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemediationTest {
    private fun fixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-remediation.json")!!
                .bufferedReader()
                .readText()
        )

    private fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))

    private fun af() = LiveAfterSales(fixture().getJSONObject("afterSales"))

    private fun board() = LiveFulfillment(fixture().getJSONObject("fulfillment"))

    private fun reject(block: () -> Unit) {
        assertThrows(IllegalArgumentException::class.java, block)
    }

    private fun remedy(action: String, target: String = "", qty: Int = 1, checked: Boolean = true) =
        af().remediationCommand(actor(), action, target, qty, "核对原实物", checked)

    private fun command(b: LiveFulfillment, action: String, qty: Int = 1) =
        b.command(actor(), "task-remake", action, qty, "核对实际进度", true)

    @Test
    fun invalidCountsAndExplicitRollbackProof() {
        val a = af()
        a.redeliveries[0].put("pausedQuantity", 9)
        reject { a.validate("item-original") }
        assertTrue(
            StaffAPIError(409, "NATIVE_PHYSICAL_NOT_COMMITTED", "未提交", "not_committed")
                .definitivelyRejected
        )
        assertFalse(StaffAPIError(409, "NATIVE_PHYSICAL_NOT_COMMITTED", "待确认").definitivelyRejected)
    }

    @Test
    fun oldServerCannotReceiveUnsafeNativeMutations() {
        val a = af()
        a.source.remove("supportsNativePhysicalRecovery")
        reject {
            a.remediationCommand(
                actor(),
                "request",
                quantity = 1,
                reason = "原实物补送",
                confirmed = true,
            )
        }
        val b = board()
        b.actor.remove("supportsNativePhysicalRecovery")
        reject { command(b, "complete") }
        assertTrue(remedy("request").steps[0].path.contains("native-redeliveries"))
        assertTrue(command(board(), "start").steps[0].path.contains("native-kds"))
    }

    @Test
    fun originalRedeliveryAndExplicitConfirmation() {
        val c = remedy("request", qty = 2)
        val body = JSONObject(c.steps[0].body)
        assertEquals("item-original", body.getString("orderItemId"))
        assertTrue(body.getBoolean("originalGoodsAvailable"))
        reject { remedy("request", checked = false) }
        reject { remedy("request", qty = 3) }
    }

    @Test
    fun heldPortionsAndRemainingCancellation() {
        assertEquals("kds.deliver", remedy("complete", "redelivery-1").permission)
        reject { remedy("complete", "redelivery-1", 2) }
        reject { remedy("cancel", "other") }
        val c = remedy("cancel", "redelivery-1")
        assertEquals("service.execute", c.permission)
        assertFalse(JSONObject(c.steps[0].body).has("quantity"))
    }

    @Test
    fun remakeGenerationsAndCounts() {
        val c = remedy("remake", "task-original")
        assertTrue(JSONObject(c.steps[0].body).getBoolean("originalGoodsLost"))
        assertEquals("production_remake", JSONObject(c.steps[0].body).getString("reasonCode"))
        assertTrue(remedy("remake", "task-remake", 2).steps[0].path.endsWith("task-remake/remake"))
        reject { remedy("remake", "task-original", 2) }
        reject {
            af().remediationCommand(actor(), "remake", "task-remake", 1, "字".repeat(501), true)
        }
    }

    @Test
    fun permissionDenialWinsOverCapability() {
        val a =
            fixture()
                .getJSONObject("auth")
                .put("deniedPermissions", JSONArray(listOf("kds.exception.manage", "kds.deliver")))
        reject {
            af()
                .remediationCommand(
                    StaffIdentity.parse(a),
                    "remake",
                    "task-original",
                    1,
                    "实物损坏",
                    true,
                )
        }
        reject {
            af()
                .remediationCommand(
                    StaffIdentity.parse(a),
                    "complete",
                    "redelivery-1",
                    1,
                    "已送到客桌",
                    true,
                )
        }
    }

    private fun deliveryReceipt() =
        JSONObject(
            """{"id":"redelivery-1","itemId":"item-original","taskId":"service-1","status":"in_progress","selectedQuantity":3,"pendingQuantity":1,"pausedQuantity":1,"deliveredQuantity":2,"cancelledQuantity":0,"units":[{"id":"u1","outcome":"delivered"},{"id":"u2","outcome":"delivered"},{"id":"u3","outcome":null}]}"""
        )

    private fun response(d: JSONObject) =
        JSONObject().put("data", d).put("replayed", true).toString()

    @Test
    fun receiptMustMatchItemTaskAndCounts() {
        val step = remedy("complete", "redelivery-1").steps[0]
        validateAfterSalesReply(response(deliveryReceipt()), step)
        listOf(
                "itemId" to "other",
                "id" to "other",
                "selectedQuantity" to 2,
                "pendingQuantity" to 0,
            )
            .forEach { (key, value) ->
                reject {
                    validateAfterSalesReply(response(deliveryReceipt().put(key, value)), step)
                }
            }
        reject {
            validateAfterSalesReply(
                response(deliveryReceipt()),
                remedy("cancel", "redelivery-1").steps[0],
            )
        }
    }

    @Test
    fun remakeReceiptBindsNewPhysicalBatch() {
        val d =
            JSONObject(
                """{"batchId":"new-batch","taskId":"new-task","itemId":"item-original","quantity":2}"""
            )
        val step = remedy("remake", "task-remake", 2).steps[0]
        validateAfterSalesReply(response(d), step)
        reject { validateAfterSalesReply(response(d.put("quantity", 1)), step) }
    }

    @Test
    fun queueIdentityQuantityAndSharedPickup() {
        val b = board()
        b.validate(actor().employeeId)
        reject { b.validate("other") }
        assertEquals(1, JSONObject(command(b, "start").steps[0].body).getInt("quantity"))
        assertEquals(2, JSONObject(command(b, "complete", 2).steps[0].body).getInt("quantity"))
        reject { command(b, "start", 2) }
        reject { command(b, "complete", 3) }
        reject { command(b, "deliver") }
        reject { command(b, "fail") }
    }

    @Test
    fun cannotBypassPhysicalBatchBoardOrExpiredSession() {
        val b = board()
        b.rows[0].put("productionScreen", "kitchen")
        reject { command(b, "complete") }
        val expired = board()
        expired.actor.put("actionSessionValid", false)
        reject { command(expired, "complete") }
    }

    private fun failed(): LiveFulfillment {
        val b = board()
        b.rows[0]
            .put("quantities", JSONObject.NULL)
            .put("kdsStatus", "failed")
            .put("canPrepare", false)
            .put("canRemake", true)
            .put("canManagerCancel",true)
        return b
    }

    @Test
    fun batchEndRequiresSeparateEligibleCarryoverTasks() {
        val b=failed();b.rows[0].put("carryover",true)
        val duplicate=JSONObject(b.rows[0].toString()).put("taskId","another-task")
        b.source.getJSONArray("workItems").put(duplicate)
        val fresh=LiveFulfillment(b.source)
        val command=batchFulfillmentCancellation(fresh,actor(),listOf("task-remake","another-task"),"现场确认两项均不再出品",true)
        assertEquals(2,command.steps.size);assertEquals(2,command.steps.map{it.key}.distinct().size)
        assertTrue(validFulfillmentCommandSelection(command,fresh));assertEquals(command,LiveCommand.parse(command.json()))
        duplicate.put("carryover",false);assertFalse(validFulfillmentCommandSelection(command,LiveFulfillment(b.source)))
        reject{batchFulfillmentCancellation(fresh,actor(),listOf("task-remake","task-remake"),"现场核对不再出品",true)}
        reject{batchFulfillmentCancellation(LiveFulfillment(b.source),actor(),listOf("another-task"),"现场核对不再出品",true)}
    }

    @Test
    fun batchLostSecondReplyStopsAndReplaysOnlyOriginalSecondKey() = runBlocking {
        val b=failed();b.rows[0].put("carryover",true);b.source.getJSONArray("workItems").put(JSONObject(b.rows[0].toString()).put("taskId","another-task"))
        val command=batchFulfillmentCancellation(LiveFulfillment(b.source),actor(),listOf("task-remake","another-task"),"现场核对不再出品",true)
        var disk=command;val keys=mutableListOf<String>()
        try{LiveCommandRunner.advance(command,{step->keys.add(step.key);if(keys.size==2)error("second receipt lost")},{disk=it});fail("expected interruption")}catch(_:IllegalStateException){}
        assertEquals(1,disk.completedSteps)
        LiveCommandRunner.advance(LiveCommand.parse(disk.json()),{keys.add(it.key)},{disk=it})
        assertEquals(listOf(command.steps[0].key,command.steps[1].key,command.steps[1].key),keys)
        assertEquals(2,disk.completedSteps)
    }

    @Test
    fun legacyExceptionDoesNotUseQuantityRemake() {
        assertFalse(JSONObject(command(failed(), "remake").steps[0].body).has("quantity"))
        assertTrue(command(failed(), "manager-cancel").steps[0].path.endsWith("manager-cancel"))
        val waiting=failed();waiting.rows[0].put("kdsStatus","pending").put("canRemake",false)
        assertTrue(command(waiting,"manager-cancel").steps[0].path.endsWith("manager-cancel"))
        waiting.rows[0].put("kdsStatus","ready");reject{command(waiting,"manager-cancel")}

    }

    @Test
    fun productionReceiptRejectsDuplicateUnitsAndForeignRemake() {
        val d =
            JSONObject(
                """{"id":"task-remake","orderId":"order-original","orderItemId":"item-original","stationCode":"kitchen","normalizedStatus":"ready","affectedQuantity":2,"affectedUnitIds":["u1","u2"],"meta":{"replayed":true}}"""
            )
        val step = command(board(), "complete", 2).steps[0]
        validateFulfillmentReply(d.toString(), step)
        reject {
            validateFulfillmentReply(
                d.put("affectedUnitIds", JSONArray(listOf("u1", "u1"))).toString(),
                step,
            )
        }
        val remade =
            JSONObject(
                """{"id":"new-task","orderId":"order-original","orderItemId":"item-original","stationCode":"kitchen","normalizedStatus":"pending","remakeOf":"task-remake","meta":{"replayed":true}}"""
            )
        val remake = command(failed(), "remake").steps[0]
        validateFulfillmentReply(remade.toString(), remake)
        reject { validateFulfillmentReply(remade.put("remakeOf", "other").toString(), remake) }
    }

    @Test
    fun lostReplyAndCompletedRefreshKeepOriginalCommand() = runBlocking {
        var disk = remedy("remake", "task-remake", 2)
        val calls = mutableListOf<LiveStep>()
        try {
            LiveCommandRunner.advance(
                disk,
                {
                    calls.add(it)
                    throw java.io.IOException("lost reply")
                },
                { disk = it },
            )
        } catch (_: java.io.IOException) {}
        val restored = LiveCommand.parse(disk.json())
        LiveCommandRunner.advance(restored, { calls.add(it) }, { disk = it })
        assertEquals(2, calls.size)
        assertEquals(calls[0], calls[1])
        assertEquals(1, disk.completedSteps)
        LiveCommandRunner.advance(disk, { error("confirmed step resubmitted") }, {})
        Unit
    }
}
