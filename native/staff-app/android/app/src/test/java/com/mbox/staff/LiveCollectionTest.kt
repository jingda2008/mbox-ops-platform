package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveCollectionTest {
    private val auth
        get() =
            StaffIdentity.parse(
                JSONObject(
                        javaClass.classLoader!!
                            .getResourceAsStream("live-contract.json")!!
                            .bufferedReader()
                            .use { it.readText() }
                    )
                    .getJSONObject("auth")
                    .put(
                        "permissions",
                        JSONArray(
                            listOf(
                                "payment.manual.cash.record",
                                "payment.manual.pos.record",
                                "payment.manual.external.record",
                            )
                        ),
                    )
            )

    private val due =
        LivePaymentOrder("order-id", "original-order", "CNY", "partially_paid", 1000, false, null)

    private fun cash(orders: List<LivePaymentOrder>, amount: Int = 500) =
        manualCollection(orders, auth, amount, "cash", "", "", "", "")

    @Test
    fun receiptAndScopeRules() {
        val partial = cash(listOf(due))
        val body = JSONObject(partial.steps[0].body)
        assertEquals(500, body.getInt("amountMinor"))
        assertFalse(body.has("orderIds"))
        val batch = cash(listOf(due, due.copy(id = "order-2", amount = 500)), 1500)
        assertEquals(
            listOf("order-id", "order-2"),
            JSONObject(batch.steps[0].body).getJSONArray("orderIds").strings(),
        )
        assertThrows(IllegalArgumentException::class.java) { cash(listOf(due), 1001) }
        assertThrows(IllegalArgumentException::class.java) { cash(listOf(due, due)) }
        assertThrows(IllegalArgumentException::class.java) {
            cash(listOf(due.copy(pending = true, pendingId = "original-payment")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            manualCollection(
                listOf(due),
                auth.copy(denied = setOf("payment.manual.cash.record")),
                500,
                "cash",
                "",
                "",
                "",
                "",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            manualCollection(listOf(due), auth, 500, "physical_pos", "", "", "", "")
        }
        val external =
            manualCollection(
                listOf(due),
                auth,
                500,
                "external_manual",
                "BANK-123",
                "",
                "bank_transfer",
                "原转账已核对",
            )
        assertEquals("BANK-123", JSONObject(external.steps[0].body).getString("receiptReference"))
    }

    @Test
    fun serverReceiptMustMatchAndBeSettled() {
        val command = cash(listOf(due))
        val body = JSONObject(command.steps[0].body)
        val data =
            JSONObject()
                .put("publicId", body.getString("publicId"))
                .put("status", "succeeded")
                .put("currency", "CNY")
                .put("amountMinor", 500)
        val response =
            JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true))
        val api = StaffAPI { APIResponse(200, response.toString()) }
        api.execute(command.steps[0])
        data.put("status", "pending")
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
        data.put("status", "succeeded").put("amountMinor", 501)
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
    }

    @Test
    fun originalSessionReadbackSurvivesRestartWithoutTablePermissions() {
        val command =
            manualCollection(
                listOf(due),
                auth,
                500,
                "cash",
                "",
                "",
                "",
                "",
                session = "original-session",
            )
        val restored = LiveCommand.parse(command.json())
        assertEquals("original-session", restored.steps[0].collectionSession)
        assertFalse(JSONObject(restored.steps[0].body).has("collectionSession"))
        assertEquals(command, restored)
    }
}
