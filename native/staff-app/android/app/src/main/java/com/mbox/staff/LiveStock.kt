package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

fun nativeNonnegativeMoney(text: String): Int? =
    if (Regex("^0{1,6}(\\.0{1,2})?$").matches(text)) 0 else parseMoney(text)

class StockBoard(val source: JSONObject) {
    val employee = source.getString("currentEmployeeId")
    val durable = source.getBoolean("nativeCommands")
    val items = source.getJSONArray("items").objects()
    val receipts = source.getJSONArray("receipts").objects()
    val costs = source.getJSONObject("visibility").getBoolean("costs")

    companion object {
        val permissions =
            listOf(
                "inventory.view",
                "inventory.receive",
                "inventory.manage",
                "inventory.count",
                "inventory.count.approve",
                "inventory.waste",
                "inventory.cost.view",
            )
    }
}

data class StockLine(
    val itemID: String,
    val name: String,
    val unit: String,
    val quantity: String,
    val cost: Int,
    val scanCode: String? = null,
    val packageQuantity: String? = null,
) {
    val id
        get() = "$itemID:${scanCode ?: "manual"}"

    val summary
        get() =
            "$name · $quantity" +
                (if (scanCode == null) unit else "包（每包${packageQuantity ?: "?"}$unit）") +
                " · 本批金额 ${money(cost)}"

    fun payload() =
        JSONObject().put("totalCostMinor", cost.toString()).also {
            if (scanCode == null) it.put("inventoryItemId", itemID).put("quantity", quantity)
            else it.put("scanCode", scanCode).put("packages", quantity).put("expectedInventoryItemId",itemID).put("expectedPackageQuantity",packageQuantity)
        }

    fun json() =
        JSONObject()
            .put("itemID", itemID)
            .put("name", name)
            .put("unit", unit)
            .put("quantity", quantity)
            .put("cost", cost)
            .put("scanCode", scanCode ?: JSONObject.NULL)
            .put("packageQuantity", packageQuantity ?: JSONObject.NULL)

    companion object {
        fun parse(j: JSONObject) =
            StockLine(
                j.getString("itemID"),
                j.getString("name"),
                j.getString("unit"),
                j.getString("quantity"),
                j.getInt("cost"),
                j.textOrNull("scanCode"),
                j.textOrNull("packageQuantity"),
            )

        fun make(item: JSONObject, quantity: String, amount: String, scan: JSONObject?): StockLine {
            val q = quantity.trim()
            val decimal = q.toBigDecimalOrNull()
            val cost = nativeNonnegativeMoney(amount)
            require(
                Regex("^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$").matches(q) &&
                    decimal != null &&
                    decimal.signum() > 0 &&
                    cost != null &&
                    cost >= 0
            ) {
                "请核对数量和本批总金额"
            }
            require(scan == null || scan.getString("inventoryItemId") == item.getString("id")) {
                "条码物料已变化"
            }
            require(
                !item.getBoolean("wholeUnitCount") ||
                    scan != null ||
                    decimal.stripTrailingZeros().scale() <= 0
            ) {
                "此物料需按整件录入"
            }
            return StockLine(
                item.getString("id"),
                item.getString("name"),
                item.getString("baseUnit"),
                q,
                cost,
                scan?.getString("code"),
                scan?.getString("packageQuantity"),
            )
        }
    }
}

fun stockCommand(
    actor: StaffIdentity,
    board: StockBoard,
    lines: List<StockLine> = emptyList(),
    receiptID: String? = null,
): LiveCommand {
    require(
        board.durable && board.employee == actor.employeeId && actor.allows("inventory.receive")
    ) {
        "请刷新库存并核对收货权限及服务器支持"
    }
    val proof = JSONObject().put("employeeId", actor.employeeId).put("currency", "CNY")
    val path: String
    val body: JSONObject
    val title: String
    if (receiptID != null) {
        val r = board.receipts.firstOrNull { it.getString("id") == receiptID } ?: error("请刷新原采购单")
        require(r.getString("status") == "draft" && r.getString("currency") == "CNY") {
            "原采购单状态已变化"
        }
        path = "/api/native/inventory/receipts/$receiptID/receive"
        body = JSONObject()
        title = "确认实物已收货"
        proof
            .put("kind", "receive")
            .put("id", receiptID)
            .put("status", "received")
            .put("lineCount", r.getInt("lineCount"))
            .put(
                "confirmation",
                r.getString("publicId") +
                    "\n" +
                    r.getJSONArray("lines").objects().joinToString("\n") {
                        it.getString("itemName") +
                            " ×" +
                            it.getString("quantity") +
                            it.getString("baseUnit")
                    } +
                    "\n确认以上实物已验收；本操作正式入库，不自动修改商品上下架。",
            )
    } else {
        require(
            lines.isNotEmpty() &&
                lines.size <= 200 &&
                lines.map { it.id }.toSet().size == lines.size &&
                lines.all { line -> board.items.any { it.getString("id") == line.itemID } }
        ) {
            "请添加1—200项有效物料，同物料同条码请合并数量"
        }
        lines.forEach { line ->
            require(line.cost in 0..99999999) { "采购草稿金额无效" }
            val item = board.items.first { it.getString("id") == line.itemID }
            if (line.scanCode == null) stockQuantity(line.quantity, item, false)
            else
                require(
                    Regex("^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$").matches(line.quantity) &&
                        line.quantity.toBigDecimal().signum() > 0
                ) {
                    "包装数量无效"
                }
        }
        val total = lines.sumOf { it.cost.toLong() }
        require(total <= 1_000_000_000) { "本批金额过大" }
        path = "/api/native/inventory/receipts"
        title = "建立采购待验收单"
        body =
            JSONObject()
                .put("currency", "CNY")
                .put("invoiceTotalMinor", total.toString())
                .put("note", "原生App采购待实物验收")
                .put("lines", JSONArray(lines.map { it.payload() }))
        proof
            .put("kind", "create")
            .put("status", "draft")
            .put("lineCount", lines.size)
            .put("draftFingerprint", JSONArray(lines.map { it.json() }).toString())
            .put(
                "confirmation",
                lines.joinToString("\n") { it.summary } +
                    "\n合计 ${historyMoney(total)}\n这里只建立待验收单；核对服务器换算后的实际数量，再确认入库。",
            )
    }
    val id = UUID.randomUUID().toString()
    return LiveCommand(
        id,
        actor.employeeId,
        title,
        "inventory.receive",
        listOf(
            LiveStep(
                path,
                body.toString(),
                "idempotency-key",
                "native-stock-$id",
                JSONObject().put("stock", proof).toString(),
            )
        ),
    )
}

val LiveStep.stockProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it).optJSONObject("stock") }

fun validateStockReply(text: String, step: LiveStep) {
    val proof = step.stockProof ?: error("缺少原库存操作")
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    UUID.fromString(data.getString("id"))
    require(
        data.getString("publicId").isNotBlank() &&
            data.getString("status") == proof.getString("status") &&
            data.getString("currency") == "CNY" &&
            data.getInt("lineCount") == proof.getInt("lineCount") &&
            (!proof.has("id") || proof.getString("id") == data.getString("id"))
    ) {
        "库存回执与原操作不符，请按原请求核对"
    }
}

class StockCountPage(val data: JSONObject) {
    val employee = data.getString("currentEmployeeId")
    val durable = data.getBoolean("nativeCommands")
    val counts = data.getJSONArray("counts").objects()
    val page = data.getInt("page")
    val more = data.getBoolean("hasMore")
}

class StockWastePage(val data: JSONObject) {
    val employee = data.getString("currentEmployeeId")
    val durable = data.getBoolean("nativeCommands")
    val items = data.getJSONArray("items").objects()
    val page = data.getInt("page")
    val more = data.getBoolean("hasMore")
}

fun stockQuantity(raw: String, item: JSONObject, zero: Boolean): String {
    val q = raw.trim()
    val d = q.toBigDecimalOrNull()
    require(
        Regex("^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$").matches(q) &&
            d != null &&
            (if (zero) d.signum() >= 0 else d.signum() > 0) &&
            (!item.getBoolean("wholeUnitCount") || d.stripTrailingZeros().scale() <= 0)
    ) {
        "请核对数量；整件物料不能录入小数"
    }
    return q
}

fun stockAuditCommand(
    actor: StaffIdentity,
    board: StockBoard,
    kind: String,
    lines: List<JSONObject> = emptyList(),
    itemID: String? = null,
    quantity: String = "",
    reason: String = "",
    wasteType: String = "other",
    count: JSONObject? = null,
    waste: JSONObject? = null,
): LiveCommand {
    require(board.durable && board.employee == actor.employeeId) { "请刷新库存" }
    var body = JSONObject()
    val proof = JSONObject().put("kind", kind)
    val path: String
    val permission: String
    val title: String
    val note = reason.trim()
    when (kind) {
        "count" -> {
            permission = "inventory.count"
            title = "提交实物盘点"
            path = "/api/native/inventory/stock-count-submissions"
            require(
                lines.size in 1..500 &&
                    lines.map { it.getString("inventoryItemId") }.toSet().size == lines.size
            ) {
                "请添加1—500项不重复物料"
            }
            lines.forEach { line ->
                val item =
                    board.items.firstOrNull {
                        it.getString("id") == line.getString("inventoryItemId")
                    } ?: error("物料已变化")
                require(
                    line.getString("reason").isNotBlank() && line.getString("reason").length <= 500
                ) {
                    "请填写盘点原因"
                }
                stockQuantity(line.getString("countedQuantity"), item, true)
            }
            proof.put("draftFingerprint", JSONArray(lines).toString())
            body.put("lines", JSONArray(lines)).put("note", "原生App实物盘点，待独立审核")
            proof
                .put("status", "submitted")
                .put(
                    "confirmation",
                    lines.joinToString("\n") {
                        it.getString("name") +
                            " 实点 " +
                            it.getString("countedQuantity") +
                            it.getString("baseUnit")
                    } + "\n不立即改库存，需另一位有权员工审核。盘点期间请暂停这些物料的实物移动。",
                )
        }
        "waste" -> {
            permission = "inventory.waste"
            title = "提交物料报损"
            val item = board.items.firstOrNull { it.getString("id") == itemID } ?: error("请选择物料")
            require(
                note.isNotEmpty() &&
                    note.length <= 500 &&
                    wasteType in
                        listOf(
                            "mixing_failure",
                            "discarded",
                            "expired",
                            "tasting",
                            "complimentary",
                            "count_difference",
                            "other",
                        )
            ) {
                "请填写报损原因与类型"
            }
            val q = stockQuantity(quantity, item, false)
            path = "/api/native/inventory/items/${LiveCommand.part(item.getString("id"))}/waste"
            body
                .put("quantity", q)
                .put("reason", note)
                .put("wasteType", wasteType)
                .put("requestApproval", true)
            proof.put(
                "confirmation",
                item.getString("name") +
                    " 报损 " +
                    q +
                    item.getString("baseUnit") +
                    "\n" +
                    note +
                    "\n后台按现有报损额度规则决定直接记账或进入独立审批；不会绕过原规则。",
            )
        }
        "countApprove",
        "countReject" -> {
            permission = "inventory.count.approve"
            title = if (kind == "countApprove") "批准盘点差异" else "驳回盘点"
            require(
                count != null &&
                    count.getBoolean("canReview") &&
                    count.getString("createdByEmployeeId") != actor.employeeId &&
                    count.getString("status") == "submitted" &&
                    (kind != "countApprove" ||
                        count.getJSONArray("lines").objects().none { it.getBoolean("stale") })
            ) {
                "不可自审；库存变化时需驳回旧单重新清点"
            }
            if (kind == "countReject") {
                require(note.isNotEmpty() && note.length <= 1000) { "请填写驳回原因" }
                body.put("reason", note)
            }
            path =
                "/api/native/inventory/stock-counts/${LiveCommand.part(count.getString("id"))}/" +
                    (if (kind == "countApprove") "approve" else "reject")
            proof
                .put("id", count.getString("id"))
                .put("status", if (kind == "countApprove") "approved" else "rejected")
                .put(
                    "confirmation",
                    count.getString("publicId") +
                        "\n" +
                        count.getJSONArray("lines").objects().joinToString("\n") {
                            it.getString("itemName") +
                                " 账面 " +
                                it.getString("systemQuantity") +
                                " / 实点 " +
                                it.getString("countedQuantity") +
                                " / 差异 " +
                                it.getString("varianceQuantity")
                        } +
                        "\n批准将按原盘点差异调整库存；后台再次核对并发出入库。",
                )
        }
        "wasteApprove",
        "wasteReject" -> {
            permission = "inventory.count.approve"
            title = if (kind == "wasteApprove") "批准报损" else "驳回报损"
            require(
                waste != null &&
                    waste.getBoolean("canReview") &&
                    waste.getString("requestedByEmployeeId") != actor.employeeId &&
                    waste.getString("status") == "pending" &&
                    note.isNotEmpty() &&
                    note.length <= 500
            ) {
                "不可自审；请核对申请并填写审核原因"
            }
            body.put("reason", note)
            path =
                "/api/native/inventory/waste-requests/${LiveCommand.part(waste.getString("id"))}/" +
                    (if (kind == "wasteApprove") "approve" else "reject")
            proof
                .put("id", waste.getString("id"))
                .put("status", if (kind == "wasteApprove") "approved" else "rejected")
                .put(
                    "confirmation",
                    waste.getString("itemName") +
                        " ×" +
                        waste.getString("quantity") +
                        waste.getString("baseUnit") +
                        "\n原原因：" +
                        waste.getString("reason") +
                        "\n审核意见：" +
                        note,
                )
        }
        else -> error("不支持的库存操作")
    }
    require(actor.allows(permission)) { "当前岗位无操作权限" }
    val id = UUID.randomUUID().toString()
    return LiveCommand(
        id,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(
                path,
                body.toString(),
                "idempotency-key",
                "native-stock-audit-$id",
                JSONObject().put("stockAudit", proof).toString(),
            )
        ),
    )
}

val LiveStep.stockAuditProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it).optJSONObject("stockAudit") }

fun validateStockAuditReply(text: String, step: LiveStep) {
    val p = step.stockAuditProof ?: error("原库存凭证缺失")
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    require(root.getJSONObject("meta").get("replayed") is Boolean) { "回执无效" }
    if (p.getString("kind") == "waste") {
        when (d.getString("status")) {
            "pending" -> UUID.fromString(d.getString("id"))
            "recorded" -> UUID.fromString(d.getString("movementId"))
            else -> error("报损状态不匹配")
        }
    } else {
        UUID.fromString(d.getString("id"))
        require(
            (!p.has("id") || p.getString("id") == d.getString("id")) &&
                p.getString("status") == d.getString("status")
        ) {
            "库存原单回执不匹配"
        }
    }
}
