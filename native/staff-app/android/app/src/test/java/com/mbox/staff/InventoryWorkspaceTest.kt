package com.mbox.staff

import android.app.Application
import androidx.compose.runtime.MutableState
import java.io.File
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Exercises the real AppModel submission gates and on-disk recovery without server access. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class InventoryWorkspaceTest {
    private lateinit var app: Application
    private lateinit var model: AppModel
    private val actor = StaffIdentity("session-a", "employee-a", "A", "原员工",
        "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z", emptyList(), setOf("inventory.manage"), emptySet())

    @Before fun prepare() {
        app = RuntimeEnvironment.getApplication()
        app.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        model = AppModel(app)
    }

    @Suppress("UNCHECKED_CAST")
    private fun state(name: String, value: Any?, target: AppModel = model) {
        if (name == "identity") {
            AppModel::class.java.getDeclaredMethod("setIdentity", StaffIdentity::class.java)
                .apply { isAccessible = true }.invoke(target, value as StaffIdentity?)
            return
        }
        val field = AppModel::class.java.getDeclaredField(name + "\$delegate").apply { isAccessible = true }
        (field.get(target) as MutableState<Any?>).value = value
    }

    private fun timestamp(name: String, value: Instant?) {
        AppModel::class.java.getDeclaredField(name).apply { isAccessible = true }.set(model, value)
    }

    private fun setup(protocol: Int = 1, employee: String = actor.employeeId, version: String = "2026-10-05T10:00:00Z") =
        InventorySetupBoard(JSONObject().put("nativeInventorySetupProtocol", protocol).put("currentEmployeeId", employee)
            .put("items", JSONArray().put(JSONObject().put("id", "11111111-1111-4111-8111-111111111111")
                .put("name", "纸杯").put("sku", "CUP-1").put("status", "active").put("categoryCode", "packaging")
                .put("baseUnit", "piece").put("itemType", "packaging").put("updatedAt", version).put("barcodes", JSONArray()))))

    private fun activate(board: InventorySetupBoard = setup()) {
        state("identity", actor)
        state("inventorySetupBoard", board)
        timestamp("inventorySetupUpdated", Instant.now())
    }

    private fun bind(board: InventorySetupBoard = setup()) = inventorySetupCommand(actor, board,
        InventorySetupSelection("bind", board.items.single().getString("id"),
            JSONObject().put("code", "CUP-BOX").put("codeType", "barcode").put("packageQuantity", "6")))

    @Test fun materialWritesRequireCurrentProtocolEmployeePermissionAndFreshWorkspace() {
        val command = bind()
        assertFalse(model.canExecuteLive(command))
        activate()
        assertTrue(model.canExecuteLive(command))
        for (board in listOf(setup(protocol = 0), setup(employee = "another-employee"))) {
            state("inventorySetupBoard", board)
            assertFalse(model.canExecuteLive(command))
        }
        activate()
        timestamp("inventorySetupUpdated", Instant.now().minusSeconds(61))
        assertFalse(model.canExecuteLive(command))
        activate()
        state("identity", actor.copy(denied = setOf("inventory.manage")))
        assertFalse(model.canExecuteLive(command))
        activate()
        state("liveStorageDamaged", true)
        assertFalse(model.canExecuteLive(command))
    }

    @Test fun changedMaterialOrExistingUnsettledOperationCannotStartANewWrite() {
        activate()
        val command = bind()
        assertTrue(model.canExecuteLive(command))
        state("inventorySetupBoard", setup(version = "2026-10-05T10:01:00Z"))
        assertFalse(model.canExecuteLive(command))
        activate()
        assertFalse(model.canExecuteLive(command.copy(steps = command.steps + command.steps)))
        state("livePending", command)
        assertFalse(model.canExecuteLive(command))
    }

    @Test fun savedMaterialRequestRestoresOriginalVersionAndCannotBeReplayedByAnotherEmployee() {
        val command = bind()
        AppModel::class.java.getDeclaredMethod("saveLive", LiveCommand::class.java)
            .apply { isAccessible = true }.invoke(model, command)
        val file = File(app.filesDir, "live-pending-v1.json")
        val saved = file.readText()
        val reopened = AppModel(app)
        assertEquals(command, reopened.livePending)
        assertEquals("2026-10-05T10:00:00Z", JSONObject(reopened.livePending!!.steps.single().body).getString("expectedUpdatedAt"))
        assertEquals(command.steps.single().key, reopened.livePending!!.steps.single().key)
        state("identity", actor.copy(employeeId = "employee-b", sessionId = "session-b"), reopened)
        reopened.recoverLive()
        assertEquals("请由发起操作的员工登录后核对", reopened.message)
        assertEquals(saved, file.readText())
        assertEquals(command, reopened.livePending)
    }

    @Test fun wholeReceiptPublishNeedsAllPermissionsAndTheCurrentFreshPreview() {
        val receiptId = "22222222-2222-4222-8222-222222222222"
        val productId = "33333333-3333-4333-8333-333333333333"
        val receiver = actor.copy(permissions = inventoryPublishPermissions.toSet())
        val lines = JSONArray().put(JSONObject().put("itemName", "柠檬").put("quantity", "20").put("baseUnit", "piece"))
        val board = InventoryPublishBoard(JSONObject().put("nativeInventoryPublishProtocol", 1).put("currentEmployeeId", actor.employeeId)
            .put("receipt", JSONObject().put("id", receiptId).put("publicId", "PR-100").put("status", "draft").put("currency", "CNY").put("lines", lines))
            .put("products", JSONArray().put(JSONObject().put("id", productId).put("name", "柠檬水"))))
        val quote = JSONObject().put("nativeInventoryPublishProtocol", 1).put("currentEmployeeId", actor.employeeId)
            .put("receiptId", receiptId).put("receiptPublicId", "PR-100").put("receiptLines", lines).put("currency", "CNY")
            .put("productId", productId).put("productName", "柠檬水").put("expectedVersion", "a".repeat(64))
            .put("guestVisible", true).put("allowedChannels", JSONArray(listOf("guest_qr", "staff_assisted")))
            .put("sellableServings", 20).put("standardPriceMinor", 2000).put("costAmountMinor", 200).put("grossProfitMinor", 1800).put("recipeVersion", 1)
        val preview = InventoryPublishPreview(quote)
        val command = inventoryPublishCommand(receiver, board, preview, confirmedWholeReceipt = true)
        state("identity", receiver)
        state("inventoryPublishBoard", board)
        timestamp("inventoryPublishUpdated", Instant.now())
        assertTrue(model.canUseInventoryPublish)
        assertFalse(model.canExecuteLive(command))
        state("inventoryPublishPreview", preview)
        timestamp("inventoryPublishPreviewUpdated", Instant.now())
        assertTrue(model.canExecuteLive(command))
        for (permission in inventoryPublishPermissions) {
            state("identity", receiver.copy(denied = setOf(permission)))
            assertFalse(model.canExecuteLive(command))
        }
        state("identity", receiver)
        timestamp("inventoryPublishPreviewUpdated", Instant.now().minusSeconds(61))
        assertFalse(model.canExecuteLive(command))
        timestamp("inventoryPublishPreviewUpdated", Instant.now())
        state("inventoryPublishPreview", InventoryPublishPreview(JSONObject(quote.toString()).put("expectedVersion", "b".repeat(64))))
        assertFalse(model.canExecuteLive(command))
        state("inventoryPublishPreview", preview)
        assertTrue(model.canExecuteLive(command))
        state("livePending", command)
        assertFalse(model.canExecuteLive(command))
    }
}
