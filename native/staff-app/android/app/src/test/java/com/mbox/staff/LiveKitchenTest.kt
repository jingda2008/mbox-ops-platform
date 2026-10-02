package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveKitchenTest {
    private fun fixture(name: String) =
        JSONObject(
            javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use {
                it.readText()
            }
        )

    private val auth
        get() =
            StaffIdentity.parse(
                fixture("live-contract.json")
                    .getJSONObject("auth")
                    .put(
                        "permissions",
                        JSONArray(listOf("kds.prepare", "table.close", "table.turnover_unsettled")),
                    )
            )

    @Test
    fun portionsLocationAndOwnerGuards() {
        val board = LiveKitchen(fixture("live-kitchen.json"))
        val start = board.command(auth, "start", "task1", 2, "炸炉", 180)
        val body = JSONObject(start.steps[0].body).getJSONObject("command")
        assertEquals("[\"product1\",\"规格/A\",\"少盐\",\"\"]", body.getString("compatibilityKey"))
        assertEquals(3, body.getJSONArray("items").getJSONObject(0).getInt("expectedUnmade"))
        assertEquals(7, body.getJSONArray("items").getJSONObject(0).getInt("locationVersion"))
        assertThrows(IllegalArgumentException::class.java) {
            board.command(auth, "start", "task1", 4)
        }
        assertThrows(IllegalArgumentException::class.java) {
            board.command(auth.copy(denied = setOf("kds.prepare")), "start", "task1")
        }
        val quick =
            JSONObject(board.command(auth, "quick-ready", "task1", 1, "炸炉", 180).steps[0].body)
                .getJSONObject("command")
        assertTrue(quick.isNull("equipment") && quick.isNull("expectedSeconds"))
        val ready = board.command(auth, "ready", "batch1", unitIDs = setOf("unit1"))
        val readyBody = JSONObject(ready.steps[0].body).getJSONObject("command")
        assertEquals(4, readyBody.getInt("expectedOwnershipVersion"))
        assertThrows(IllegalArgumentException::class.java) {
            board.command(auth, "ready", "batch1", unitIDs = setOf("held"))
        }
        val data =
            JSONObject()
                .put("batchId", "batch1")
                .put("action", "ready")
                .put("quantity", 1)
                .put("released", false)
        val response = JSONObject().put("data", data).put("replayed", true)
        val api = StaffAPI { APIResponse(200, response.toString()) }
        api.execute(ready.steps[0])
        data.put("quantity", 2)
        assertThrows(StaffAPIError::class.java) { api.execute(ready.steps[0]) }
        data.put("quantity", 1)
        data.put("batchId", "another-batch")
        assertThrows(StaffAPIError::class.java) { api.execute(ready.steps[0]) }
    }

    @Test
    fun retainedDebtTurnoverNeedsBothCapabilities() {
        val table =
            LiveOperations.parse(fixture("live-contract.json").getJSONObject("operations"))
                .tables[0]
        val command = LiveCommand.make("turnover", table, auth, reason = "顾客已离店，主管继续追账")
        assertTrue(command.steps[0].path.endsWith("close-after-customer-left"))
        assertThrows(IllegalArgumentException::class.java) {
            LiveCommand.make(
                "turnover",
                table,
                auth.copy(denied = setOf("table.close")),
                reason = "顾客已离店",
            )
        }
    }
    @Test fun tableCapacityOverrideUsesExistingServerContract() {
        val source=fixture("live-contract.json");val actor=StaffIdentity.parse(source.getJSONObject("auth"));val ops=LiveOperations.parse(source.getJSONObject("operations"))
        val command=LiveCommand.make("open",ops.tables[1],actor,people=5,reason="现场加椅，通道已核对")
        assertEquals("现场加椅，通道已核对",JSONObject(command.steps[0].body).getString("capacityOverrideReason"))
        assertThrows(IllegalArgumentException::class.java) { LiveCommand.make("open",ops.tables[1],actor,people=5) }
        assertThrows(IllegalArgumentException::class.java) { LiveCommand.make("open",ops.tables[1],actor,people=201,reason="现场加椅") }
        assertFalse(JSONObject(LiveCommand.make("open",ops.tables[1],actor,people=2,reason="旧加座说明").steps[0].body).has("capacityOverrideReason"))
        source.getJSONObject("operations").getJSONArray("tables").getJSONObject(1).put("capacity",1)
        val target=LiveOperations.parse(source.getJSONObject("operations")).tables[1]
        assertThrows(IllegalArgumentException::class.java) { LiveCommand.make("transfer",ops.tables[0],actor,target=target) }
        val transfer=JSONObject(LiveCommand.make("transfer",ops.tables[0],actor,target=target,reason="现场加椅并核对通道").steps[0].body)
        assertEquals(7,transfer.getInt("expectedLocationVersion"));assertEquals("现场加椅并核对通道",transfer.getString("capacityOverrideReason"))
    }

}
