package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class PickupUnit(val source: JSONObject) {
    val id = source.getString("kind") + ":" + source.getString("unitId")
    val name = source.getString("productName")
    val selection
        get() =
            JSONObject()
                .put("kind", source.getString("kind"))
                .put("unitId", source.getString("unitId"))
                .put("version", source.getInt("version"))
}

data class PickupTable(val source: JSONObject) {
    val id = source.getString("tableSessionId")
    val code = source.getString("tableCode")
    val units = source.getJSONArray("units").objects().map(::PickupUnit)
}

data class PickupReceipt(val source: JSONObject) {
    val id = source.getString("receiptId")
    val code = source.getString("tableCode")
    val quantity = source.getInt("quantity")
    val canUndo = source.getBoolean("canUndo")
    val undone = !source.isNull("undo")
    val units = source.getJSONArray("units").objects().map(::PickupUnit)
}

data class LivePickup(val source: JSONObject) {
    val scope = source.getString("commandScope")
    val actor = source.getJSONObject("actor")
    val setup = source.getJSONObject("setup")
    val device = source.optJSONObject("device")
    val tables = source.getJSONArray("tables").objects().map(::PickupTable)
    val history = source.getJSONArray("history").objects().map(::PickupReceipt)
    val attention = source.getJSONArray("attention").objects()
    val valid = actor.getBoolean("actionSessionValid")

    fun make(
        identity: StaffIdentity,
        action: String,
        target: String = "",
        units: Set<String> = emptySet(),
        label: String = "",
        enabled: Boolean = true,
    ): LiveCommand {
        require(valid && scope.isNotEmpty()) { "设备会话已失效，请重新登录后读取取餐台" }
        val body: JSONObject
        val title: String
        val path: String
        val permission: String
        if (action == "device") {
            require(
                actor.getBoolean("canConfigure") &&
                    identity.allows("staff.access.configure") &&
                    (!enabled || setup.getBoolean("enabled")) &&
                    label.trim().length in 1..40
            ) {
                "请核对设备管理权限、设备名称与当前准入状态"
            }
            body = JSONObject().put("enabled", enabled).put("label", label.trim())
            title = if (enabled) "将本设备设为共享取餐屏" else "停用本设备取餐功能"
            path = "/api/commerce/pickup-board/device"
            permission = "staff.access.configure"
        } else {
            require(device != null && identity.allows("kds.deliver")) { "请在已授权的共享取餐设备操作" }
            path = "/api/commerce/pickup-board/commands"
            permission = "kds.deliver"
            if (action == "take") {
                val table = tables.find { it.id == target }
                require(actor.getBoolean("canPickup") && table != null) { "原桌次或取餐权限已变化" }
                val chosen = table.units.filter { it.id in units }
                require(
                    chosen.isNotEmpty() &&
                        chosen.size == units.size &&
                        chosen.size <= 999 &&
                        chosen.map { it.source.getString("taskId") }.distinct().size <= 50
                ) {
                    "请重新选择本桌实际取走的份数，每次最多999份、50项出品"
                }
                body =
                    JSONObject()
                        .put("action", "take")
                        .put("tableId", table.source.getString("tableId"))
                        .put("tableSessionId", table.id)
                        .put("locationVersion", table.source.getInt("locationVersion"))
                        .put("units", JSONArray(chosen.map { it.selection }))
                title = "${table.code} · 确认取走 ${chosen.size}份并登记取送完成"
            } else {
                val receipt = history.find { it.id == target }
                require(
                    action == "undo" &&
                        actor.getBoolean("canUndo") &&
                        receipt != null &&
                        receipt.canUndo &&
                        !receipt.undone
                ) {
                    "原领取已有后续变化，不能撤回"
                }
                body =
                    JSONObject()
                        .put("action", "undo")
                        .put("receiptId", receipt.id)
                        .put("expectedRevision", receipt.source.getLong("revision"))
                        .put("physicalStillAtPickupPoint", true)
                title = "${receipt.code} · 撤回 ${receipt.quantity}份领取（实物必须仍在取餐区）"
            }
        }
        val id = UUID.randomUUID().toString()
        val proof =
            JSONObject()
                .put("staffSessionId", identity.sessionId)
                .put("commandScope", scope)
                .toString()
        return LiveCommand(
            id,
            identity.employeeId,
            title,
            permission,
            listOf(LiveStep(path, body.toString(), "idempotency-key", "native-pickup-$id", proof)),
        )
    }
}

fun StaffAPI.executePickup(step: LiveStep) {
    val proof = JSONObject(step.recoveryBody ?: invalidResponse())
    val session = proof.getString("staffSessionId")
    val scope = proof.getString("commandScope")
    val current = identity ?: invalidResponse()
    val recovery = session != current.sessionId
    val configure = step.path.endsWith("/device")
    val original = JSONObject(step.body)
    val body =
        if (recovery)
            JSONObject()
                .put("staffSessionId", session)
                .put("commandScope", scope)
                .put("idempotencyKey", step.key)
                .put(
                    "request",
                    JSONObject()
                        .put("kind", if (configure) "device" else "command")
                        .put("command", original),
                )
        else original
    var data =
        JSONObject(
                raw(
                        if (recovery) "/api/commerce/pickup-board/recovery" else step.path,
                        body,
                        mapOf(step.keyHeader to step.key),
                    )
                    .text
            )
            .getJSONObject("data")
    if (recovery) {
        if (data.getString("kind") != if (configure) "device" else "command") invalidResponse()
        data = data.getJSONObject("data")
    }
    if (configure) {
        val board = LivePickup(data)
        val enabled = original.getBoolean("enabled")
        if (
            board.setup.getBoolean("configured") != enabled ||
                (enabled && board.device?.getString("label") != original.getString("label"))
        )
            invalidResponse()
    } else {
        if (data.get("replayed") !is Boolean || data.getLong("revision") < 0) invalidResponse()
        val receipt = PickupReceipt(data.getJSONObject("receipt"))
        if (original.getString("action") == "take") {
            val ids =
                original
                    .getJSONArray("units")
                    .objects()
                    .map { it.getString("kind") + ":" + it.getString("unitId") }
                    .toSet()
            if (
                receipt.source.getString("tableSessionId") !=
                    original.getString("tableSessionId") ||
                    receipt.source.getString("tableId") != original.getString("tableId") ||
                    receipt.quantity != ids.size ||
                    receipt.units.map { it.id }.toSet() != ids
            )
                invalidResponse()
        } else if (receipt.id != original.getString("receiptId") || !receipt.undone)
            invalidResponse()
    }
}
