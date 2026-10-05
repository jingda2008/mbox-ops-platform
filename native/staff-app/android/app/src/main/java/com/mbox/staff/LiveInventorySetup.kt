package com.mbox.staff

import java.math.BigDecimal
import java.util.UUID
import org.json.JSONObject

class InventorySetupBoard(val source: JSONObject) {
    val actor = source.getString("currentEmployeeId")
    val enabled = source.optInt("nativeInventorySetupProtocol") == 1
    val items = source.getJSONArray("items").objects()
}

data class InventorySetupSelection(val kind: String, val itemId: String? = null, val fields: JSONObject)

private fun setupText(source: JSONObject, key: String, max: Int): String = source.getString(key).trim().also {
    require(it.isNotEmpty() && it.length <= max && it.none(Char::isISOControl)) { "请核对名称、编号和条码，不能留空或含换行" }
}

private fun setupDecimal(raw: String, zero: Boolean): String = raw.trim().also {
    require(Regex("^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?$").matches(it) &&
        (if (zero) BigDecimal(it) >= BigDecimal.ZERO else BigDecimal(it) > BigDecimal.ZERO)) { "数量须为${if (zero) "非负" else "正"}数，最多6位小数" }
}

private fun liquidCategory(category: String) = listOf("spirits", "wine", "mixer", "beer", "bottled_spirits", "alcohol").any {
    category == it || category.startsWith("${it}.")
}

fun inventorySetupCommand(actor: StaffIdentity, board: InventorySetupBoard, selection: InventorySetupSelection): LiveCommand {
    require(board.enabled && board.actor == actor.employeeId && actor.allows("inventory.manage")) { "请重新读取物料并核对管理权限" }
    val fields = selection.fields
    val original = selection.itemId?.let { id -> board.items.firstOrNull { it.getString("id") == id } ?: error("原物料已停用或不存在") }
    val body = JSONObject()
    val proof = JSONObject().put("kind", selection.kind)
    val path: String
    val title: String
    val detail: String
    when (selection.kind) {
        "create", "edit" -> {
            val name = setupText(fields, "name", 200)
            val category = setupText(fields, "categoryCode", 64)
            require(Regex("^[a-z][a-z0-9_.-]{1,63}$").matches(category)) { "分类编码须为2—64位小写英文、数字或 ._-，以字母开头" }
            val threshold = fields.textOrNull("lowStockThreshold")?.trim()?.takeIf { it.isNotEmpty() }?.let { setupDecimal(it, true) }
            val volume = fields.textOrNull("packageVolumeMl")?.trim()?.takeIf { it.isNotEmpty() }?.let { setupDecimal(it, false) }
            body.put("name", name).put("categoryCode", category).put("packageVolumeMl", volume ?: JSONObject.NULL)
            val unit: String
            if (selection.kind == "create") {
                require(original == null && selection.itemId == null)
                val sku = setupText(fields, "sku", 64)
                val type = setupText(fields, "itemType", 30)
                unit = setupText(fields, "baseUnit", 20)
                require(type in listOf("ingredient", "bottle", "food", "packaging", "consumable", "other") && unit in listOf("ml", "g", "piece", "bottle", "portion")) { "请选择物料类型和基础单位" }
                require(board.items.none { it.getString("sku") == sku }) { "此物料编号已存在，请选择已有物料" }
                body.put("sku", sku).put("itemType", type).put("baseUnit", unit)
                    .put("wholeUnitCount", fields.getBoolean("wholeUnitCount"))
                    .put("reasonableWasteQuantity", setupDecimal(fields.optString("reasonableWasteQuantity", "0"), true))
                threshold?.let { body.put("lowStockThreshold", it) }
                path = "/api/native/inventory/items"
                title = "新建库存物料"
                detail = "编号 $sku · 类型 $type · 单位 $unit\n初始库存为0；请通过采购收货入库。"
            } else {
                val item = requireNotNull(original)
                unit = item.getString("baseUnit")
                body.put("expectedUpdatedAt", item.getString("updatedAt"))
                    .put("lowStockThreshold", threshold ?: JSONObject.NULL)
                proof.put("itemId", item.getString("id")).put("sku", item.getString("sku"))
                    .put("baseUnit", unit).put("itemType", item.getString("itemType"))
                path = "/api/native/inventory/items/${item.getString("id")}"; title = "更新物料资料"
                detail = "编号 ${item.getString("sku")} · 基础单位 $unit 保留\n原名称 ${item.getString("name")} → $name"
                require(!liquidCategory(item.getString("categoryCode")) || unit == "ml" || liquidCategory(category)) { "历史酒水须保留酒水分类并由有权人员完成毫升迁移" }
            }
            require(!liquidCategory(category) || (volume != null && (unit == "ml" || original != null && liquidCategory(original.getString("categoryCode"))))) { "酒水须按毫升建库存，并填写每瓶净含量" }
            proof.put("confirmation", "$title\n$name\n$detail\n分类 $category\n低库存提醒 ${threshold ?: "不设置"}\n每瓶净含量 ${volume?.plus(" ml") ?: "不设置"}\n库存余额和历史订单不在此修改。")
        }
        "bind" -> {
            val item = requireNotNull(original) { "请选择要绑定条码的原物料" }
            val code = setupText(fields, "code", 128)
            val type = setupText(fields, "codeType", 20)
            require(type in listOf("barcode", "qr", "internal")) { "请选择条码类型" }
            val quantity = setupDecimal(fields.getString("packageQuantity"), false)
            if (item.getString("baseUnit") == "ml") {
                val volume = item.textOrNull("packageVolumeMl")?.toBigDecimalOrNull()
                require(volume != null && volume > BigDecimal.ZERO && quantity.toBigDecimal().compareTo(volume) == 0) { "毫升物料的每码包装量必须等于已登记的每瓶净含量" }
            }
            val existing = board.items.flatMap { it.getJSONArray("barcodes").objects().map { code -> it to code } }.firstOrNull { it.second.getString("code") == code }
            require(existing == null || (existing.first.getString("id") == item.getString("id") && existing.second.getString("codeType") == type && existing.second.getString("packageQuantity").toBigDecimal().compareTo(quantity.toBigDecimal()) == 0)) { "此条码已绑定其他物料或包装量，请核对原绑定" }
            body.put("code", code).put("codeType", type).put("packageQuantity", quantity).put("expectedUpdatedAt", item.getString("updatedAt"))
            proof.put("itemId", item.getString("id"))
            title = "绑定包装条码"; path = "/api/native/inventory/items/${item.getString("id")}/barcodes"
            proof.put("confirmation", "${item.getString("name")} · ${item.getString("sku")}\n条码 $code\n每码代表 $quantity ${item.getString("baseUnit")}\n收货扫描将按此包装量换算基础库存；绑定后不修改旧收货单。")
        }
        else -> error("不支持的物料操作")
    }
    val id = UUID.randomUUID().toString()
    return LiveCommand(id, actor.employeeId, title, "inventory.manage", listOf(LiveStep(path, body.toString(), "idempotency-key", "native-inventory-setup-$id", JSONObject().put("inventorySetup", proof).toString())))
}

val LiveStep.inventorySetupProof: JSONObject? get() = recoveryBody?.let { JSONObject(it).optJSONObject("inventorySetup") }

fun validInventorySetupSelection(command: LiveCommand, board: InventorySetupBoard): Boolean = runCatching {
    require(board.enabled && board.actor == command.employeeID && command.permission == "inventory.manage" && command.steps.size == 1)
    val step = command.steps.single(); val proof = requireNotNull(step.inventorySetupProof); val body = JSONObject(step.body)
    when (proof.getString("kind")) {
        "create" -> require(step.path == "/api/native/inventory/items" && !proof.has("itemId"))
        "edit", "bind" -> {
            val id = proof.getString("itemId"); val item = board.items.first { it.getString("id") == id }
            require(body.getString("expectedUpdatedAt") == item.getString("updatedAt") && item.getString("status") == "active")
            require(step.path == "/api/native/inventory/items/$id" + if (proof.getString("kind") == "bind") "/barcodes" else "")
        }
        else -> error("未知物料操作")
    }; true
}.getOrDefault(false)

fun validateInventorySetupReply(text: String, step: LiveStep) {
    val root = JSONObject(text); val data = root.getJSONObject("data"); val proof = requireNotNull(step.inventorySetupProof); val body = JSONObject(step.body)
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    UUID.fromString(data.getString("id"))
    if (proof.getString("kind") == "bind") {
        require(data.getString("inventoryItemId") == proof.getString("itemId") && data.getString("code") == body.getString("code") && data.getString("codeType") == body.getString("codeType") && data.getString("packageQuantity").toBigDecimal().compareTo(body.getString("packageQuantity").toBigDecimal()) == 0) { "条码回执与原物料、包装量不一致，保留原请求待核对" }
    } else {
        require(data.getString("status") == "active")
        if (proof.getString("kind") == "edit") require(data.getString("id") == proof.getString("itemId") && listOf("sku", "baseUnit", "itemType").all { data.getString(it) == proof.getString(it) })
        for (field in listOf("name", "categoryCode", "sku", "baseUnit", "itemType")) if (body.has(field)) require(data.getString(field) == body.getString(field)) { "物料回执与原提交不一致，保留原请求待核对" }
        for (field in listOf("packageVolumeMl", "lowStockThreshold", "reasonableWasteQuantity")) {
            val expected = body.textOrNull(field); val actual = data.textOrNull(field)
            if (field != "reasonableWasteQuantity" || body.has(field)) require(if (expected == null) actual == null else actual != null && BigDecimal(actual).compareTo(BigDecimal(expected)) == 0) { "物料数量设置回执不一致，保留原请求待核对" }
        }
        if (body.has("wholeUnitCount")) require(data.getBoolean("wholeUnitCount") == body.getBoolean("wholeUnitCount"))
    }
}
