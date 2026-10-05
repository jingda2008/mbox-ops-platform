package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class InventoryPublishTest {
    private val actor = StaffIdentity("session", "employee", "manager", "经理", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", emptyList(), inventoryPublishPermissions.toSet(), emptySet())
    private val receiptId = UUID.randomUUID().toString(); private val productId = UUID.randomUUID().toString()
    private fun lines() = JSONArray().put(JSONObject().put("itemName", "酒液").put("quantity", "750").put("baseUnit", "ml").put("batchCode", "LOT-1"))
        .put(JSONObject().put("itemName", "非本商品纸杯").put("quantity", "20").put("baseUnit", "piece").put("batchCode", "LOT-2"))
    private fun board() = InventoryPublishBoard(JSONObject().put("currentEmployeeId", actor.employeeId).put("nativeInventoryPublishProtocol", 1)
        .put("receipt", JSONObject().put("id", receiptId).put("publicId", "PO-ORIGINAL").put("status", "draft").put("currency", "CNY").put("lines", lines()))
        .put("products", JSONArray().put(JSONObject().put("id", productId).put("name", "新酒水"))))
    private fun preview() = InventoryPublishPreview(JSONObject().put("currentEmployeeId", actor.employeeId).put("nativeInventoryPublishProtocol", 1).put("expectedVersion", "a".repeat(64))
        .put("receiptId", receiptId).put("receiptPublicId", "PO-ORIGINAL").put("currency", "CNY").put("receiptLines", lines()).put("productId", productId).put("productName", "新酒水")
        .put("guestVisible", true).put("allowedChannels", JSONArray(listOf("guest_qr", "staff_assisted"))).put("costAmountMinor", 300).put("standardPriceMinor", 1000).put("grossProfitMinor", 700).put("recipeVersion", 2).put("sellableServings", 15))
    private fun command() = inventoryPublishCommand(actor, board(), preview(), true)
    private fun reply() = JSONObject().put("data", JSONObject().put("id", receiptId).put("receiptPublicId", "PO-ORIGINAL").put("productId", productId).put("receiptStatus", "received").put("productStatus", "active")
        .put("costAmountMinor", 300).put("standardPriceMinor", 1000).put("grossProfitMinor", 700).put("recipeCostVersionId", UUID.randomUUID().toString()).put("publishedAt", "2026-10-05 10:00:00+08"))
        .put("meta", JSONObject().put("replayed", true))

    @Test fun requiresWholeReceiptAcceptanceAndConfirmsEveryLineBeforeAtomicCommand() {
        assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor, board(), preview()) }
        val c = command(); val step = c.steps.single()
        assertTrue(step.inventoryPublishProof!!.getString("confirmation").contains("非本商品纸杯"))
        assertTrue(step.inventoryPublishProof!!.getString("confirmation").contains("全部采购行一并入库"))
        assertTrue(validInventoryPublishSelection(c, board(), preview()))
        assertEquals(c, LiveCommand.parse(c.json()))
        assertEquals("a".repeat(64), JSONObject(step.body).getString("expectedVersion"))
        validateInventoryPublishReply(reply().toString(), step)
    }

    @Test fun requiresAllThreePermissionsCurrentProductAndCurrentQuote() {
        inventoryPublishPermissions.forEach { permission -> assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor.copy(denied = setOf(permission)), board(), preview(), true) } }
        assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor.copy(employeeId = "other"), board(), preview(), true) }
        assertFalse(validInventoryPublishSelection(command(), board(), InventoryPublishPreview(preview().source.put("expectedVersion", "b".repeat(64)))))
        assertFalse(validInventoryPublishSelection(command(), board(), InventoryPublishPreview(preview().source.put("productId", UUID.randomUUID().toString()))))
        assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor, board(), InventoryPublishPreview(preview().source.put("sellableServings", 0)), true) }
        assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor, board(), InventoryPublishPreview(preview().source.put("guestVisible", false)), true) }
        assertThrows(IllegalArgumentException::class.java) { inventoryPublishCommand(actor, board(), InventoryPublishPreview(preview().source.put("receiptLines", JSONArray())), true) }
    }

    @Test fun mismatchedReceiptAmountsOrPublicationCannotClearOriginalPendingRequest() {
        val c = command(); val original = c.json().toString()
        mapOf("id" to "wrong", "productId" to "wrong", "receiptPublicId" to "PO-WRONG", "receiptStatus" to "draft", "productStatus" to "inactive", "costAmountMinor" to 301, "standardPriceMinor" to 1001, "grossProfitMinor" to 701).forEach { (key, value) ->
            val wrong = reply().also { it.getJSONObject("data").put(key, value) }
            assertThrows(Exception::class.java) { validateInventoryPublishReply(wrong.toString(), c.steps.single()) }
            assertEquals(original, c.json().toString())
        }
        validateInventoryPublishReply(reply().toString(), LiveCommand.parse(JSONObject(original)).steps.single())
    }
}
