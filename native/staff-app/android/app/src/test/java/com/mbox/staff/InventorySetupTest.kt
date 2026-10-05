package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class InventorySetupTest {
    private val actor = StaffIdentity("session", "employee", "manager", "经理", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", emptyList(), setOf("inventory.manage"), emptySet())
    private fun fields() = JSONObject().put("sku", "TEST-NEW").put("name", "原料").put("itemType", "ingredient").put("baseUnit", "ml").put("categoryCode", "spirits").put("lowStockThreshold", "").put("wholeUnitCount", false).put("reasonableWasteQuantity", "0").put("packageVolumeMl", "750")
    private fun item() = fields().put("id", UUID.randomUUID().toString()).put("status", "active").put("updatedAt", "2026-10-05 09:00:00+08").put("barcodes", JSONArray()).put("lowStockThreshold", JSONObject.NULL)
    private fun board(vararg items: JSONObject) = InventorySetupBoard(JSONObject().put("currentEmployeeId", actor.employeeId).put("nativeInventorySetupProtocol", 1).put("items", JSONArray(items.toList())))
    private fun envelope(data: JSONObject) = JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true)).toString()

    @Test fun firstMaterialSupportsEmptyInventoryAndRoundTripsOriginalRecoveryKey() {
        val b = board(); val c = inventorySetupCommand(actor, b, InventorySetupSelection("create", fields = fields()))
        assertTrue(validInventorySetupSelection(c, b)); assertEquals(c, LiveCommand.parse(c.json()))
        val payload = JSONObject(c.steps.single().body)
        assertFalse(payload.has("initialStock")); assertFalse(payload.has("lowStockThreshold"))
        val result = item().put("reasonableWasteQuantity", "0.000000").put("packageVolumeMl", "750.000000")
        validateInventorySetupReply(envelope(result), c.steps.single())
        assertThrows(Exception::class.java) { validateInventorySetupReply(envelope(result.put("sku", "WRONG")), c.steps.single()) }
    }

    @Test fun materialPermissionsAndLiquidUnitRulesPreventUnsafeRequests() {
        val b = board()
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor.copy(denied = setOf("inventory.manage")), b, InventorySetupSelection("create", fields = fields())) }
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor.copy(employeeId = "other"), b, InventorySetupSelection("create", fields = fields())) }
        listOf(fields().put("baseUnit", "bottle"), fields().put("packageVolumeMl", ""), fields().put("lowStockThreshold", "1.0000001"), fields().put("sku", "\n")).forEach { f ->
            assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor, b, InventorySetupSelection("create", fields = f)) }
        }
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor, board(item()), InventorySetupSelection("create", fields = fields())) }
    }

    @Test fun editsRequireOriginalVersionAndCannotChangeUnitsOrAcknowledgeAnotherItem() {
        val original = item(); val b = board(original)
        val c = inventorySetupCommand(actor, b, InventorySetupSelection("edit", original.getString("id"), fields().put("name", "新名称")))
        val step = c.steps.single(); val body = JSONObject(step.body)
        assertFalse(body.has("sku")); assertFalse(body.has("baseUnit")); assertEquals(original.getString("updatedAt"), body.getString("expectedUpdatedAt"))
        assertTrue(validInventorySetupSelection(c, b))
        assertFalse(validInventorySetupSelection(c, board(JSONObject(original.toString()).put("updatedAt", "later"))))
        assertFalse(validInventorySetupSelection(c.copy(permission = "inventory.receive"), b))
        val reply = JSONObject(original.toString()).put("name", "新名称")
        validateInventorySetupReply(envelope(reply), step)
        assertThrows(Exception::class.java) { validateInventorySetupReply(envelope(reply.put("id", UUID.randomUUID().toString())), step) }
        val changed = fields().put("categoryCode", "spirits").put("baseUnit", "g")
        val solid = item().put("baseUnit", "g").put("categoryCode", "snack")
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor, board(solid), InventorySetupSelection("edit", solid.getString("id"), changed)) }
    }

    @Test fun barcodeBindingUsesExactQuantityAndCannotTakeOverExistingCode() {
        val item = item(); val b = board(item)
        val fields = JSONObject().put("code", "6970000000123").put("codeType", "barcode").put("packageQuantity", "750")
        val c = inventorySetupCommand(actor, b, InventorySetupSelection("bind", item.getString("id"), fields))
        assertTrue(validInventorySetupSelection(c, b)); assertEquals(c, LiveCommand.parse(c.json()))
        val reply = JSONObject(fields.toString()).put("id", UUID.randomUUID().toString()).put("inventoryItemId", item.getString("id")).put("packageQuantity", "750.000000")
        validateInventorySetupReply(envelope(reply), c.steps.single())
        listOf("code" to "different", "inventoryItemId" to "other", "packageQuantity" to "1", "codeType" to "qr").forEach { (key, value) ->
            assertThrows(Exception::class.java) { validateInventorySetupReply(envelope(JSONObject(reply.toString()).put(key, value)), c.steps.single()) }
        }
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor, b, InventorySetupSelection("bind", item.getString("id"), JSONObject(fields.toString()).put("packageQuantity", "1"))) }
        val other = item().put("sku", "OTHER").put("barcodes", JSONArray().put(JSONObject(fields.toString())))
        assertThrows(IllegalArgumentException::class.java) { inventorySetupCommand(actor, board(item, other), InventorySetupSelection("bind", item.getString("id"), fields)) }
    }
}
