package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LivePickupTest {
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
                        JSONArray(
                            listOf(
                                "kds.prepare",
                                "kds.exception.manage",
                                "kds.deliver",
                                "staff.access.configure",
                            )
                        ),
                    )
            )

    @Test
    fun pickupPhysicalUnitsAndRestart() {
        val board = LivePickup(fixture("live-pickup.json"))
        val command = board.make(auth, "take", "ts1", setOf("original:unit1", "remake:unit1"))
        val body = JSONObject(command.steps[0].body)
        assertEquals(2, body.getJSONArray("units").length())
        assertEquals(7, body.getInt("locationVersion"))
        assertThrows(IllegalArgumentException::class.java) {
            board.make(auth, "take", "ts1", setOf("missing"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            board.make(
                auth.copy(denied = setOf("kds.deliver")),
                "take",
                "ts1",
                setOf("original:unit1"),
            )
        }
        val undo = JSONObject(board.make(auth, "undo", "receipt1").steps[0].body)
        assertTrue(undo.getBoolean("physicalStillAtPickupPoint"))
        assertEquals(8, undo.getInt("expectedRevision"))
        assertThrows(IllegalArgumentException::class.java) {
            board.make(auth, "device", label = "门店屏")
        }
        assertFalse(
            JSONObject(board.make(auth, "device", label = "门店屏", enabled = false).steps[0].body)
                .getBoolean("enabled")
        )
        assertEquals(command.steps, LiveCommand.parse(command.json()).steps)
        val old = command.json()
        old.getJSONArray("steps").getJSONObject(0).remove("recoveryBody")
        assertNull(LiveCommand.parse(old).steps[0].recoveryBody)
    }

    @Test
    fun originalScopeRecoveryAndWrongReceipt() {
        val board = LivePickup(fixture("live-pickup.json"))
        val command = board.make(auth, "take", "ts1", setOf("original:unit1", "remake:unit1"))
        val receipt = board.history[0].source
        val result = JSONObject().put("receipt", receipt).put("revision", 8).put("replayed", true)
        val login =
            fixture("live-contract.json")
                .getJSONObject("auth")
                .put("permissions", JSONArray(auth.permissions.toList()))
        var reply = JSONObject().put("data", login)
        val requests = mutableListOf<APIRequest>()
        val api = StaffAPI {
            requests.add(it)
            APIResponse(200, reply.toString())
        }
        api.login("staff", "1234", false)
        reply = JSONObject().put("data", result)
        api.execute(command.steps[0])
        assertEquals("/api/commerce/pickup-board/commands", requests.last().path)
        login.getJSONObject("session").put("id", "new-session")
        reply = JSONObject().put("data", login)
        api.login("staff", "1234", false)
        reply = JSONObject().put("data", JSONObject().put("kind", "command").put("data", result))
        api.execute(command.steps[0])
        val recovery = requests.last()
        assertEquals("/api/commerce/pickup-board/recovery", recovery.path)
        assertEquals(auth.sessionId, recovery.body!!.getString("staffSessionId"))
        assertEquals(command.steps[0].key, recovery.body!!.getString("idempotencyKey"))
        assertEquals(board.scope, recovery.body!!.getString("commandScope"))
        assertEquals(
            command.steps[0].body,
            recovery.body!!.getJSONObject("request").getJSONObject("command").toString(),
        )
        receipt.put("tableSessionId", "wrong")
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
        assertFalse(StaffAPIError(409, "PICKUP_STALE", "unknown", "unknown").definitivelyRejected)
        assertTrue(
            StaffAPIError(409, "PICKUP_STALE", "stale", "not_committed").definitivelyRejected
        )
    }

    @Test
    fun handoffFullScopeAndPermissions() {
        val board = LiveKitchen(fixture("live-kitchen.json").put("canHandoff", true))
        val preview = LiveKitchenHandoff(fixture("live-handoff.json"))
        assertThrows(IllegalArgumentException::class.java) {
            preview.command(auth, board, "交班接管", false)
        }
        assertThrows(IllegalArgumentException::class.java) {
            preview.command(auth.copy(denied = setOf("kds.exception.manage")), board, "交班接管", true)
        }
        val body =
            JSONObject(preview.command(auth, board, "交班接管", true).steps[0].body)
                .getJSONObject("command")
        assertTrue(body.getJSONArray("expectedTasks").getJSONObject(0).isNull("expectedEmployeeId"))
        assertEquals(
            4,
            body.getJSONArray("expectedBatches").getJSONObject(0).getInt("expectedOwnershipVersion"),
        )
        val command = preview.command(auth, board, "交班接管", true)
        val receipt = JSONObject().put("batchId","batch1").put("action","handoff").put("quantity",0).put("released",false).put("affectedBatchIds",JSONArray(listOf("batch1"))).put("ownershipVersions",JSONObject().put("batch1",5))
        val api = StaffAPI { APIResponse(200,JSONObject().put("data",receipt).put("replayed",true).toString()) }
        api.execute(command.steps[0])
        receipt.getJSONObject("ownershipVersions").put("batch1",4)
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
    }
}
