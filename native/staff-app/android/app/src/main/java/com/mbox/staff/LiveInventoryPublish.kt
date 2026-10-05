package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

class InventoryPublishBoard(val source: JSONObject) {
    val actor = source.getString("currentEmployeeId")
    val enabled = source.optInt("nativeInventoryPublishProtocol") == 1
    val receipt = source.getJSONObject("receipt")
    val products = source.getJSONArray("products").objects()
}

class InventoryPublishPreview(val source: JSONObject) {
    val actor = source.getString("currentEmployeeId")
    val enabled = source.optInt("nativeInventoryPublishProtocol") == 1
    val receiptId = source.getString("receiptId")
    val productId = source.getString("productId")
    val version = source.getString("expectedVersion")
    val ready = source.getBoolean("guestVisible") && source.getJSONArray("allowedChannels").let { channels ->
        (0 until channels.length()).map { channels.getString(it) }.containsAll(listOf("guest_qr", "staff_assisted"))
    } && source.getInt("sellableServings") > 0
}

val inventoryPublishPermissions = listOf("inventory.receive", "catalog.product.manage", "inventory.cost.view")

fun inventoryPublishCommand(actor: StaffIdentity, board: InventoryPublishBoard, preview: InventoryPublishPreview, confirmedWholeReceipt: Boolean = false): LiveCommand {
    require(board.enabled && preview.enabled && board.actor == actor.employeeId && preview.actor == actor.employeeId && inventoryPublishPermissions.all(actor::allows)) { "请核对收货、商品维护与成本查看权限" }
    val receipt = board.receipt; val quote = preview.source
    require(receipt.getString("id") == preview.receiptId && receipt.getString("status") in listOf("draft", "received") && receipt.getString("currency") == "CNY") { "原采购单已变化" }
    require(board.products.any { it.getString("id") == preview.productId } && preview.ready && Regex("^[a-f0-9]{64}$").matches(preview.version)) { "请先完成有效售价、配方、扫码和员工点单渠道配置，并重新预览" }
    require(confirmedWholeReceipt) { "请逐项验收整张采购单，并确认已收到全部实物" }
    val lines = quote.getJSONArray("receiptLines").objects()
    require(lines.isNotEmpty() && quote.getString("receiptPublicId") == receipt.getString("publicId") && quote.getString("currency") == "CNY") { "整单采购明细未读取完整，请重新预览" }
    require(quote.getInt("costAmountMinor") >= 0 && quote.getInt("standardPriceMinor") > 0 && quote.getInt("grossProfitMinor") == quote.getInt("standardPriceMinor") - quote.getInt("costAmountMinor"))
    val confirmation = "整单收货并发布\n采购单 ${receipt.getString("publicId")}\n" + lines.joinToString("\n") {
        "${it.getString("itemName")} · ${it.getString("quantity")} ${it.getString("baseUnit")}" + (it.textOrNull("batchCode")?.let { code -> " · 批次 $code" } ?: "")
    } + "\n以上全部采购行一并入库（已收货单不会重复加库存）。\n发布商品：${quote.getString("productName")}\n售价 ${money(quote.getInt("standardPriceMinor"))} · 每份成本 ${money(quote.getInt("costAmountMinor"))}\n每份毛利 ${money(quote.getInt("grossProfitMinor"))} · 可售 ${quote.getInt("sellableServings")} 份\n配方版本 ${quote.getInt("recipeVersion")} · 已核实整单实物\n售价、成本、库存或配方变化时，整笔操作不提交，须重新核对。"
    val proof = JSONObject().put("receiptId", preview.receiptId).put("receiptPublicId", receipt.getString("publicId"))
        .put("productId", preview.productId).put("confirmation", confirmation)
        .put("costAmountMinor", quote.getInt("costAmountMinor")).put("standardPriceMinor", quote.getInt("standardPriceMinor"))
        .put("grossProfitMinor", quote.getInt("grossProfitMinor"))
    val id = UUID.randomUUID().toString()
    return LiveCommand(id, actor.employeeId, "核对整单收货与商品发布", "inventory.receive", listOf(LiveStep(
        "/api/native/inventory/receipts/${preview.receiptId}/receive-and-publish",
        JSONObject().put("productId", preview.productId).put("expectedVersion", preview.version).toString(),
        "idempotency-key", "native-inventory-publish-$id", JSONObject().put("inventoryPublish", proof).toString(),
    )))
}

val LiveStep.inventoryPublishProof: JSONObject? get() = recoveryBody?.let { JSONObject(it).optJSONObject("inventoryPublish") }

fun validInventoryPublishSelection(command: LiveCommand, board: InventoryPublishBoard, preview: InventoryPublishPreview): Boolean = runCatching {
    require(command.steps.size == 1 && command.permission == "inventory.receive" && command.employeeID == board.actor && preview.actor == board.actor && board.enabled && preview.enabled && preview.ready)
    val step = command.steps.single(); val proof = requireNotNull(step.inventoryPublishProof); val body = JSONObject(step.body)
    require(board.receipt.getString("id") == preview.receiptId && board.receipt.getString("status") in listOf("draft", "received") && board.receipt.getString("currency") == "CNY")
    require(proof.getString("receiptId") == preview.receiptId && proof.getString("productId") == preview.productId && body.getString("productId") == preview.productId && body.getString("expectedVersion") == preview.version)
    require(board.products.any { it.getString("id") == preview.productId } && step.path == "/api/native/inventory/receipts/${preview.receiptId}/receive-and-publish")
    for (field in listOf("costAmountMinor", "standardPriceMinor", "grossProfitMinor")) require(proof.getInt(field) == preview.source.getInt(field))
    true
}.getOrDefault(false)

fun validateInventoryPublishReply(text: String, step: LiveStep) {
    val root = JSONObject(text); val data = root.getJSONObject("data"); val proof = requireNotNull(step.inventoryPublishProof)
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    require(data.getString("id") == proof.getString("receiptId") && data.getString("receiptPublicId") == proof.getString("receiptPublicId") && data.getString("productId") == proof.getString("productId") && data.getString("receiptStatus") == "received" && data.getString("productStatus") == "active") { "收货发布回执与原单不一致，保留原请求待核对" }
    for (field in listOf("costAmountMinor", "standardPriceMinor", "grossProfitMinor")) require(data.getInt(field) == proof.getInt(field)) { "收货发布成本或售价回执不一致，保留原请求待核对" }
    UUID.fromString(data.getString("recipeCostVersionId")); require(data.getString("publishedAt").isNotBlank())
}
