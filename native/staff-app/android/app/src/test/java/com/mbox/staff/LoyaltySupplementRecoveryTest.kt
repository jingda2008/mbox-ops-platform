package com.mbox.staff

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Uses the raw-plus-validator dispatch used by AppModel, not StaffAPI.execute's generic branch. */
class LoyaltySupplementRecoveryTest {
    private val actor = StaffIdentity("session", "reviewer", "staff", "复核员工",
        "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", emptyList(),
        setOf("loyalty.accrual.request", "loyalty.accrual.approve"), emptySet())
    private val supplementId = "LSP-11111111-1111-4111-8111-111111111111"

    private fun command(action: String = "approve"): LiveCommand {
        val row = JSONObject().put("publicId", supplementId).put("orderPublicId", "ORDER-123")
            .put("memberNo", "MEMBER-123").put("requestedByEmployeeId", "another-employee")
            .put("status", if (action == "request") "missing" else "requested")
        return loyaltySupplementCommand(actor, action, row, "已核对原订单、历史退款与原积分流水")
    }

    // Native route binds this envelope to action, employee, original key, and source public ID.
    private fun receipt(command: LiveCommand, status: String = "executed", points: Any = -30,
                        growth: Any = -20, replayed: Boolean = false): JSONObject {
        val step = command.steps.single()
        val result = JSONObject().put("publicId", supplementId).put("status", status)
        if (step.loyaltySupplementProof!!.getString("action") == "request")
            result.put("requestedPoints", points).put("requestedGrowth", growth)
        else result.put("pointsDelta", points).put("growthDelta", growth)
        return JSONObject().put("meta", JSONObject().put("protocol", 1).put("replayed", replayed))
            .put("data", JSONObject().put("action", step.loyaltySupplementProof!!.getString("action"))
                .put("employeeId", actor.employeeId).put("requestKey", step.key)
                .put("sourcePublicId", JSONObject(step.body).getString("publicId")).put("result", result))
    }

    private fun send(api: StaffAPI, step: LiveStep) {
        validateLoyaltySupplementReply(api.raw(step.path, JSONObject(step.body),
            mapOf(step.keyHeader to step.key)).text, step)
    }

    private fun complete(command: LiveCommand, text: String): LiveCommand = runBlocking {
        var disk = command.json().toString()
        val api = StaffAPI { request ->
            assertEquals(command.steps.single().path, request.path)
            assertEquals(command.steps.single().key, request.headers["idempotency-key"])
            APIResponse(200, text)
        }
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, { disk = it.json().toString() })
        LiveCommand.parse(JSONObject(disk))
    }

    private fun assertNotCheckpointed(command: LiveCommand, text: String) {
        var checkpoints = 0
        var requests = 0
        var disk = command.json().toString()
        val before = disk
        val api = StaffAPI { requests++; APIResponse(200, text) }
        assertThrows(Exception::class.java) {
            runBlocking { LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, {
                checkpoints++; disk = it.json().toString()
            }) }
        }
        assertEquals(1, requests)
        assertEquals(0, checkpoints)
        assertEquals(before, disk)
        assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
    }

    @Test fun approvalAcceptsSignedHistoricalRefundDeltasForBothFinalStatuses() {
        for (status in listOf("executed", "not_required")) {
            for ((points, growth) in listOf(-30L to -20L, -3L to 2L, 2L to -3L, 0L to 0L,
                20L to 30L, -9007199254740991L to 9007199254740991L)) {
                val command = command()
                val reply = receipt(command, status, points, growth)
                val done = complete(command, reply.toString())
                assertEquals(1, done.completedSteps)
                assertEquals(command.steps, done.steps)
                assertEquals(points, reply.getJSONObject("data").getJSONObject("result").getLong("pointsDelta"))
                assertEquals(growth, reply.getJSONObject("data").getJSONObject("result").getLong("growthDelta"))
            }
        }
    }

    @Test fun lostResponseReplaysOriginalRequestAndPublicIdWithoutAnotherMutation() = runBlocking {
        val command = command()
        var disk = command.json().toString()
        val sent = mutableListOf<APIRequest>()
        val committed = mutableMapOf<String, String>()
        var mutations = 0
        var checkpoints = 0
        val api = StaffAPI { request ->
            sent += request
            val key = request.headers.getValue("idempotency-key")
            val prior = committed[key]
            if (prior == null) {
                mutations++
                committed[key] = receipt(command, "not_required", -30, -20).toString()
                throw IOException("server committed; acknowledgement lost")
            }
            APIResponse(200, JSONObject(prior).put("meta", JSONObject().put("protocol", 1).put("replayed", true)).toString())
        }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, {
                checkpoints++; disk = it.json().toString()
            })
            fail("Expected lost acknowledgement")
        } catch (_: IOException) { }
        assertEquals(0, checkpoints)
        assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, {
            checkpoints++; disk = it.json().toString()
        })
        assertEquals(1, mutations)
        assertEquals(1, checkpoints)
        assertEquals(1, LiveCommand.parse(JSONObject(disk)).completedSteps)
        assertEquals(2, sent.size)
        sent.forEach {
            val body = requireNotNull(it.body)
            assertEquals(command.steps.single().key, it.headers["idempotency-key"])
            assertEquals(command.steps.single().path, it.path)
            assertEquals(command.steps.single().body, body.toString())
            assertEquals(supplementId, body.getString("publicId"))
            assertEquals(setOf("publicId", "reason"), body.keys().asSequence().toSet())
        }
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { error("Completed command must not resend") }, {})
        assertEquals(2, sent.size)
    }

    @Test fun failedCheckpointRetainsOriginalRequestForValidatedReplay() = runBlocking {
        val command = command()
        val disk = command.json().toString()
        val keys = mutableListOf<String>()
        val api = StaffAPI { request ->
            keys += request.headers.getValue("idempotency-key")
            APIResponse(200, receipt(command, "executed", -30, 10, replayed = keys.size > 1).toString())
        }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, { throw IOException("disk full") })
            fail("Expected checkpoint failure")
        } catch (_: IOException) { }
        assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
        var recovered = disk
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { send(api, it) }, { recovered = it.json().toString() })
        assertEquals(listOf(command.steps.single().key, command.steps.single().key), keys)
        assertEquals(1, LiveCommand.parse(JSONObject(recovered)).completedSteps)
    }

    @Test fun rejectedDecisionRequiresZeroDeltas() {
        val command = command("reject")
        assertEquals(1, complete(command, receipt(command, "rejected", 0, 0).toString()).completedSteps)
        for ((points, growth) in listOf(-1 to 0, 1 to 0, 0 to -1, 0 to 1))
            assertNotCheckpointed(command, receipt(command, "rejected", points, growth).toString())
    }

    @Test fun malformedFractionalAndUnsafeDeltaValuesNeverCheckpoint() {
        val command = command()
        for (field in listOf("pointsDelta", "growthDelta")) {
            for (value in listOf("-30", 1.5, -1.5, 9007199254740992L, -9007199254740992L, true, JSONObject.NULL)) {
                val reply = receipt(command)
                reply.getJSONObject("data").getJSONObject("result").put(field, value)
                assertNotCheckpointed(command, reply.toString())
            }
            val missing = receipt(command)
            missing.getJSONObject("data").getJSONObject("result").remove(field)
            assertNotCheckpointed(command, missing.toString())
            val nonFinite = receipt(command)
            nonFinite.getJSONObject("data").getJSONObject("result").put(field, "INVALID_DELTA")
            assertNotCheckpointed(command, nonFinite.toString().replace("\"INVALID_DELTA\"", "1e309"))
        }
    }

    @Test fun requestAmountsRemainStrictNonnegativeIntegers() {
        val command = command("request")
        assertEquals(1, complete(command, receipt(command, "requested", 20, 0).toString()).completedSteps)
        assertNotCheckpointed(command, receipt(command, "requested", 0, 0).toString())
        for (field in listOf("requestedPoints", "requestedGrowth")) {
            for (value in listOf(-1, "20", 0.5, 9007199254740992L, JSONObject.NULL)) {
                val reply = receipt(command, "requested", 20, 0)
                reply.getJSONObject("data").getJSONObject("result").put(field, value)
                assertNotCheckpointed(command, reply.toString())
            }
        }
    }

    @Test fun mismatchedReceiptAnchorsAndStatusNeverCheckpoint() {
        val command = command()
        for ((field, value) in listOf("action" to "reject", "employeeId" to "another-employee",
            "requestKey" to "native-business-another-key", "sourcePublicId" to "LSP-22222222-2222-4222-8222-222222222222")) {
            val reply = receipt(command)
            reply.getJSONObject("data").put(field, value)
            assertNotCheckpointed(command, reply.toString())
        }
        for ((field, value) in listOf("publicId" to "LSP-22222222-2222-4222-8222-222222222222", "status" to "rejected")) {
            val reply = receipt(command)
            reply.getJSONObject("data").getJSONObject("result").put(field, value)
            assertNotCheckpointed(command, reply.toString())
        }
    }
}
