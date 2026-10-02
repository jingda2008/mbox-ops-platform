package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveOrderingTest {
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
                        JSONArray(listOf("order.create", "order.gift", "service.execute")),
                    )
            )

    private val product
        get() = LiveProduct(fixture("live-catalog.json").getJSONObject("product").toString())

    private val line
        get() = LiveDraftLine.make(product, mapOf("g1" to listOf("p1")), "少冰")

    private val access = LiveOrderAccess("employee-1", true, true, 20000, "CNY")
    private val context =
        LiveOrderContext(
            "A".repeat(43),
            "employee-1",
            "session-1",
            "table-session-1",
            Instant.parse("2099-01-01T00:00:00Z"),
        )

    private fun make(
        gift: Boolean = false,
        reason: String = "顾客回访",
        lines: List<LiveDraftLine> = listOf(line),
        products: List<LiveProduct> = listOf(product),
        actor: StaffIdentity = auth,
    ) =
        LiveOrderSubmission.make(
            lines,
            products,
            actor,
            access,
            context,
            "table-session-1",
            "A5",
            gift,
            reason,
            "一起出品",
            "immediate_payment",
        )

    @Test
    fun submissionRules() {
        assertEquals("immediate_payment", JSONObject(make().body).getString("settlementMode"))
        assertEquals("table_tab", JSONObject(make(true).body).getString("settlementMode"))
        assertThrows(IllegalArgumentException::class.java) { make(true, "") }
        assertThrows(IllegalArgumentException::class.java) {
            make(true, lines = listOf(line, line))
        }
        assertThrows(IllegalArgumentException::class.java) { make(products = emptyList()) }
        val repriced =
            LiveProduct(
                fixture("live-catalog.json")
                    .getJSONObject("product")
                    .put(
                        "standardPrice",
                        JSONObject().put("amountMinor", "19900").put("currency", "CNY"),
                    )
                    .toString()
            )
        assertThrows(IllegalArgumentException::class.java) { make(products = listOf(repriced)) }
        assertThrows(IllegalArgumentException::class.java) {
            make(actor = auth.copy(denied = setOf("order.create")))
        }
    }

    @Test
    fun retryIdentityAndReceiptBinding() {
        val command = make()
        val restored = LiveOrderSubmission.parse(JSONObject(command.json().toString()))
        assertEquals(command, restored)
        assertTrue(command.canReplay(auth))
        assertFalse(command.canReplay(auth.copy(sessionId = "new-session")))
        assertFalse(command.canReplay(auth, command.createdAt.plusSeconds(13 * 3600)))
        var response =
            JSONObject()
                .put("id", "order-id")
                .put("publicId", command.publicId)
                .put("tableSessionId", command.tableSessionID)
                .put("currency", "CNY")
                .put("totalAmountMinor", 19800)
                .put("paymentNextStep", JSONObject().put("orderId", "order-id"))
        val requests = mutableListOf<APIRequest>()
        val api = StaffAPI { request ->
            requests.add(request)
            APIResponse(201, response.toString())
        }
        assertEquals(19800L, api.submitOrder(command).amount)
        api.submitOrder(restored)
        assertTrue(
            requests.all {
                it.headers["idempotency-key"] == command.key &&
                    it.headers["x-assisted-order-context"] == command.token
            }
        )
        response.put("publicId", "another-order")
        assertThrows(StaffAPIError::class.java) { api.submitOrder(command) }
    }

    @Test
    fun initialRejectionNeverTreatsAmbiguityAsFailure() {
        assertEquals(
            "INVENTORY_INSUFFICIENT",
            LiveOrderSubmission.initialRejection(StaffAPIError(409, "INVENTORY_INSUFFICIENT", "")),
        )
        assertNull(
            LiveOrderSubmission.initialRejection(StaffAPIError(409, "IDEMPOTENCY_CONFLICT", ""))
        )
        assertNull(LiveOrderSubmission.initialRejection(StaffAPIError(503, "REQUEST_INVALID", "")))
    }
}
