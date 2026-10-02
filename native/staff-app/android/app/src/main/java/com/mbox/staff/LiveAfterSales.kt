package com.mbox.staff

import java.net.URLEncoder
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class LiveAfterSales(val source: JSONObject) {
    val item = source.getJSONObject("item")
    val units = financeRows(source, "units")
    val cases = financeRows(source, "cases")
    val funding = financeRows(source, "fundingSources")
    val redeliveries =
        if (source.has("redeliveries") && !source.isNull("redeliveries"))
            financeRows(source, "redeliveries")
        else emptyList()
    val remakes =
        if (source.has("remakes") && !source.isNull("remakes")) financeRows(source, "remakes")
        else emptyList()
    val id
        get() = item.getString("id")

    val available
        get() =
            if (units.isEmpty()) item.getInt("quantity")
            else
                units.count {
                    it.textOrNull("heldByCaseId") == null &&
                        it.textOrNull("stoppedByCaseId") == null &&
                        !it.optBoolean("operationallyStopped")
                }

    fun held(row: JSONObject) =
        units
            .filter {
                it.textOrNull("heldByCaseId") == row.getString("caseId") &&
                    (it.getString("productionState") != "unmade" ||
                        row.optBoolean("canDisposeHeldUnmade"))
            }
            .sortedBy { it.getInt("index") }

    fun validate(itemID: String) {
        require(
            id == itemID &&
                item.getInt("quantity") > 0 &&
                units.map { it.getString("id") }.distinct().size == units.size &&
                cases.map { it.getString("caseId") }.distinct().size == cases.size &&
                cases.all { it.getString("orderId") == item.getString("orderId") } &&
                funding.map { it.getString("paymentId") }.distinct().size == funding.size &&
                funding.all { it.getLong("availableMinor") >= 0 } &&
                redeliveries.map { it.getString("id") }.distinct().size == redeliveries.size &&
                redeliveries.all { row ->
                    val n = row.getInt("selectedQuantity")
                    n in 1..999 &&
                        listOf(
                                "pendingQuantity",
                                "deliveredQuantity",
                                "cancelledQuantity",
                                "pausedQuantity",
                            )
                            .all { row.getInt(it) in 0..n } &&
                        row.getInt("pendingQuantity") +
                            row.getInt("deliveredQuantity") +
                            row.getInt("cancelledQuantity") == n &&
                        row.getInt("pausedQuantity") <= row.getInt("pendingQuantity")
                } &&
                remakes.map { it.getString("taskId") }.distinct().size == remakes.size &&
                remakes.all { row ->
                    val n = row.getInt("total")
                    n in 1..999 &&
                        listOf(
                                "unmade",
                                "started",
                                "ready",
                                "delivered",
                                "cancelled",
                                "held",
                                "successorAvailableQuantity",
                            )
                            .all { row.getInt(it) in 0..n } &&
                        listOf("unmade", "started", "ready", "delivered", "cancelled").sumOf {
                            row.getInt(it)
                        } == n
                }
        ) {
            "原商品数据不兼容，请刷新"
        }
    }

    fun command(
        actor: StaffIdentity,
        action: String,
        caseID: String = "",
        quantity: Int = 0,
        reason: String,
        shares: Map<String, Int> = emptyMap(),
        unitIDs: Set<String> = emptySet(),
        refundID: String = "",
        confirmed: Boolean = false,
    ): LiveCommand {
        val note = reason.trim()
        require(note.length in 2..1000) { "请填写2—1000字实际原因" }
        val row = cases.find { it.getString("caseId") == caseID }
        var body = JSONObject().put("reason", note)
        val prefix = "/api/commerce/item-after-sales"
        var path = "$prefix/${LiveCommand.part(caseID)}/$action"
        var permission = "refund.request"
        val title: String
        when (action) {
            "request" -> {
                require(
                    source.getBoolean("canRequest") && quantity in 1..999 && quantity <= available
                ) {
                    "当前原商品不能新增此份数售后，请刷新"
                }
                path = "$prefix/requests"
                body.put("orderItemId", id).put("quantity", quantity)
                title = "申请暂停并处理${quantity}份原商品"
            }
            "approved",
            "rejected",
            "withdrawn" -> {
                val flag =
                    mapOf(
                            "approved" to "canApprove",
                            "rejected" to "canReject",
                            "withdrawn" to "canWithdraw",
                        )
                        .getValue(action)
                require(row?.optBoolean(flag) == true) { "当前岗位或原申请状态不允许此决定" }
                permission =
                    if (action == "withdrawn") "refund.request"
                    else if (row!!.getString("kind") == "unpaid_stop") {
                        if (actor.allows("order.settle_exception")) "order.settle_exception"
                        else "order.cancel_unpaid"
                    } else "refund.approve"
                if (action == "approved" && row!!.optBoolean("requiresFundingChoice")) {
                    val amounts = shares.filterValues { it != 0 }
                    require(
                        amounts.isNotEmpty() &&
                            amounts.size <= 50 &&
                            amounts.values.all { it > 0 } &&
                            amounts.values.sumOf { it.toLong() } == row.getLong("amountMinor") &&
                            amounts.all { (key, value) ->
                                funding.any {
                                    it.getString("paymentId") == key &&
                                        value <= it.getLong("availableMinor")
                                }
                            }
                    ) {
                        "原付款退款分摊合计须等于服务端核定金额，并且不能超过各原款可退余额"
                    }
                    body.put(
                        "funding",
                        JSONArray(
                            amounts.toSortedMap().map { (id, amount) ->
                                JSONObject().put("paymentId", id).put("amountMinor", amount)
                            }
                        ),
                    )
                } else require(shares.values.none { it != 0 }) { "此操作不接受额外退款分摊" }
                body.put("decision", action)
                path = "$prefix/${LiveCommand.part(caseID)}/decision"
                title =
                    mapOf("approved" to "批准原申请", "rejected" to "拒绝原申请", "withdrawn" to "撤回本人申请")
                        .getValue(action)
            }
            "revision" -> {
                require(
                    row?.optBoolean("canRevise") == true &&
                        quantity in 1..999 &&
                        quantity <= available + row.getInt("heldQuantity")
                ) {
                    "只能修改本人尚未执行的原申请及可处理份数"
                }
                body.put("quantity", quantity)
                title = "修改为${quantity}份，重新审核"
            }
            "resume" -> {
                require(row?.optBoolean("canResume") == true) { "当前不能继续原商品" }
                title = "确认继续原商品"
            }
            "resolve-unpaid" -> {
                require(row?.optBoolean("canResolveUnpaid") == true) { "原款未确认，不按未付款减账" }
                title = "原款确认未收，继续停止减账"
            }
            "notice-ack" -> {
                require(
                    row != null &&
                        source.getBoolean("canAcknowledgeNotices") &&
                        row.getJSONArray("notices").length() in 1..100 &&
                        confirmed
                ) {
                    "请先实际联系所示岗位确认知悉"
                }
                body.put(
                    "noticeIds",
                    JSONArray(financeRows(row, "notices").map { it.getString("id") }.sorted()),
                )
                title = "确认所示岗位已知悉"
            }
            "used_loss",
            "returned_unopened" -> {
                require(
                    row != null &&
                        row.optBoolean("canDisposeMade", row.getString("status") == "approved") &&
                        unitIDs.isNotEmpty() &&
                        unitIDs.size <= 999 &&
                        held(row).map { it.getString("id") }.containsAll(unitIDs) &&
                        confirmed
                ) {
                    "请选原申请的实际份数并确认实物去向"
                }
                if (action == "returned_unopened") {
                    require(
                        source.getBoolean("canReceive") &&
                            units
                                .filter { it.getString("id") in unitIDs }
                                .all {
                                    it.optJSONObject("returnEligibility")
                                        ?.optBoolean("canReturn") == true
                                }
                    ) {
                        "所选份数未确认可退库，请核对原库存，不要以报损清待办"
                    }
                    permission = "inventory.receive"
                    title = "确认实物收回或未制作预留释放"
                } else {
                    require(source.getBoolean("canRecordUsed")) { "当前无报损权限" }
                    permission = "inventory.waste"
                    title = "实物已消耗，不退库存"
                }
                require(actor.allows("refund.request")) { "缺少商品售后权限" }
                body
                    .put("unitIds", JSONArray(unitIDs.sorted()))
                    .put("disposition", action)
                    .put("unopenedReceived", action == "returned_unopened")
                path = "$prefix/${LiveCommand.part(caseID)}/physical"
            }
            "refund-retry",
            "cash-paid" -> {
                val refund =
                    row?.let {
                        financeRows(it, "refunds").find { r -> r.getString("id") == refundID }
                    }
                require(refund != null && source.getBoolean("canExecuteRefund")) { "请刷新原退款及执行权限" }
                permission = "refund.execute"
                if (action == "refund-retry") {
                    require(refund.optBoolean("canRetry")) { "仅重试已核实失败的原退款" }
                    body.put("refundId", refundID)
                    title = "重试原退款 ${historyMoney(refund.getLong("amountMinor"))}"
                } else {
                    require(
                        refund.getString("provider") == "cash" &&
                            refund.getString("status") in listOf("approved", "processing") &&
                            confirmed
                    ) {
                        "须确认现金已实际退给客人"
                    }
                    path = "/api/refunds/${LiveCommand.part(refundID)}/manual-result"
                    body = JSONObject().put("succeeded", true)
                    title = "登记现金已退 ${historyMoney(refund.getLong("amountMinor"))}"
                }
            }
            else -> error("不支持的售后操作")
        }
        require(actor.allows(permission)) { "当前岗位权限已变化" }
        val key = UUID.randomUUID().toString()
        val proof =
            JSONObject()
                .put("afterSales", action)
                .put("itemId", id)
                .put("orderId", item.getString("orderId"))
                .put("caseId", caseID)
                .put("refundId", refundID)
                .put("quantity", quantity)
                .put(
                    "confirmation",
                    "${item.getString("tableCode")} · ${item.getString("orderPublicId")}\n${item.getString("name")}\n$title\n原申请金额：${row?.longOrNull("amountMinor")?.let { historyMoney(it) } ?: "由服务器按原成交事实计算"}\n原因：$note\n资金与商品/库存分别处理；未确认成功不能当作已退，撤回或拒绝不会自动恢复商品。",
                )
        row?.let { financeRows(it, "refunds").find { r -> r.getString("id") == refundID } }
            ?.let { proof.put("amountMinor", it.getLong("amountMinor")) }
        val detail = buildList {
            if (unitIDs.isNotEmpty())
                add(
                    "实际处理份号：" +
                        units
                            .filter { it.getString("id") in unitIDs }
                            .sortedBy { it.getInt("index") }
                            .joinToString("、") { it.getInt("index").toString() }
                )
            if (shares.isNotEmpty())
                add(
                    "原款分摊：\n" +
                        shares
                            .filterValues { it > 0 }
                            .toSortedMap()
                            .entries
                            .joinToString("\n") { "${it.key}：${historyMoney(it.value.toLong())}" }
                )
            if (action == "notice-ack")
                add(
                    financeRows(row!!, "notices").joinToString("\n") {
                        "${it.getString("stationCode")}：${it.getString("instruction")}"
                    }
                )
        }
        proof.put(
            "confirmation",
            proof.getString("confirmation") + "\n" + detail.joinToString("\n"),
        )
        return LiveCommand(
            key,
            actor.employeeId,
            title,
            permission,
            listOf(
                LiveStep(
                    path,
                    body.toString(),
                    "idempotency-key",
                    "native-aftersales-$key",
                    proof.toString(),
                )
            ),
        )
    }
}

val LiveStep.afterSalesProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.opt("afterSales") is String }

fun validateAfterSalesReply(text: String, step: LiveStep) {
    val p = step.afterSalesProof ?: invalidResponse()
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    val action = p.getString("afterSales")
    if (action.startsWith("remedy-")) {
        validateRemediationReply(root, p)
        return
    }
    if (action == "cash-paid") {
        if (
            root.getJSONObject("meta").get("replayed") !is Boolean ||
                data.getString("id") != p.getString("refundId") ||
                data.getString("status") != "succeeded" ||
                data.getLong("amountMinor") != p.getLong("amountMinor") ||
                data.getString("currency") != "CNY"
        )
            invalidResponse()
        return
    }
    if (
        root.get("replayed") !is Boolean ||
            data.getString("caseId").isBlank() ||
            data.getString("orderId") != p.getString("orderId") ||
            data.getInt("selectedQuantity") <= 0 ||
            data.get("physicalComplete") !is Boolean ||
            data.get("moneyComplete") !is Boolean ||
            data.getLong("succeededMinor") < 0
    )
        invalidResponse()
    if (action in listOf("request", "revision")) {
        if (
            data.getInt("selectedQuantity") != p.getInt("quantity") ||
                action == "revision" && data.getString("revisesCaseId") != p.getString("caseId")
        )
            invalidResponse()
    } else if (data.getString("caseId") != p.getString("caseId")) invalidResponse()
}

fun afterSalesPendingPath(cursor: JSONObject?): String =
    "/api/commerce/item-after-sales/pending" +
        if (cursor == null) ""
        else
            "?cursorId=" +
                URLEncoder.encode(cursor.getString("id"), "UTF-8") +
                "&createdAt=" +
                URLEncoder.encode(cursor.getString("createdAt"), "UTF-8")

fun LiveAfterSales.remediationCommand(
    actor: StaffIdentity,
    action: String,
    target: String = "",
    quantity: Int = 0,
    reason: String,
    confirmed: Boolean,
): LiveCommand {
    require(source.optBoolean("supportsNativePhysicalRecovery")) { "服务器尚未启用安全补送与重做，请使用原网页流程" }
    val note = reason.trim()
    require(confirmed && note.length in 2..(if (action == "remake") 500 else 1000)) {
        "请填写实际原因并核对实物；重做原因最多500字"
    }
    val body = JSONObject().put("reason", note)
    val prefix = "/api/commerce/item-after-sales/native-redeliveries"
    val path: String
    val permission: String
    val title: String
    val row = redeliveries.find { it.getString("id") == target }
    when (action) {
        "request" -> {
            require(
                source.optBoolean("canRequestRedelivery") &&
                    quantity in 1..minOf(999, source.optInt("redeliveryAvailableQuantity"))
            ) {
                "可补送份数已变化，请刷新"
            }
            path = prefix
            permission = "refund.request"
            title = "原实物补送 ${quantity}份"
            body
                .put("orderItemId", id)
                .put("quantity", quantity)
                .put("originalGoodsAvailable", true)
        }
        "complete",
        "cancel" -> {
            require(
                row != null &&
                    row.getString("status") in listOf("pending", "acknowledged", "in_progress")
            ) {
                "原补送任务已变化，请刷新"
            }
            path = "$prefix/${LiveCommand.part(target)}/$action"
            if (action == "complete") {
                require(
                    source.optBoolean("canConfirmRedelivery") &&
                        quantity in
                            1..minOf(
                                    999,
                                    row.getInt("pendingQuantity") - row.getInt("pausedQuantity"),
                                )
                ) {
                    "不能确认已暂停或超出剩余的份数"
                }
                permission = "kds.deliver"
                title = "确认实际补送 ${quantity}份"
                body.put("quantity", quantity)
            } else {
                require(source.optBoolean("canCancelRedelivery")) { "当前无取消补送权限" }
                permission = "service.execute"
                title = "取消本次剩余补送"
            }
        }
        "remake" -> {
            val maximum =
                if (target == source.textOrNull("originalKdsTaskId"))
                    source.optInt("firstRemakeAvailableQuantity")
                else
                    remakes
                        .find { it.getString("taskId") == target }
                        ?.getInt("successorAvailableQuantity") ?: 0
            require(
                source.optBoolean("canManageRemake") &&
                    target.isNotBlank() &&
                    quantity in 1..minOf(999, maximum)
            ) {
                "当前批次、制作岗位或可重做份数已变化"
            }
            path = "/api/commerce/native-kds/${LiveCommand.part(target)}/remake"
            permission = "kds.exception.manage"
            title = "重新制作 ${quantity}份"
            body
                .put("actorId", actor.employeeId)
                .put("quantity", quantity)
                .put("originalGoodsLost", true)
                .put("reasonCode", "production_remake")
        }
        else -> error("不支持的实物处理")
    }
    require(actor.allows(permission)) { "当前岗位权限已变化" }
    val explanation =
        when (action) {
            "remake" -> "已确认本批原实物无法直接补送。新增制作批次和耗料，原单不重复收费。"
            "cancel" -> "只取消本次未完成补送，已送份数和原商品、账款保持原记录。"
            "complete" -> "已确认以上份数实际送给客人；暂停部分不计入。"
            else -> "已确认原实物仍在且可交付，不重新制作、不重复扣库存。"
        }
    val key = UUID.randomUUID().toString()
    val proof =
        JSONObject()
            .put("afterSales", "remedy-$action")
            .put("itemId", id)
            .put("orderId", item.getString("orderId"))
            .put("target", target)
            .put("quantity", quantity)
            .put("selectedQuantity", row?.getInt("selectedQuantity") ?: quantity)
            .put("taskId", row?.getString("taskId") ?: "")
            .put("deliveredBefore", row?.getInt("deliveredQuantity") ?: 0)
            .put(
                "confirmation",
                "${item.getString("tableCode")} · ${item.getString("orderPublicId")}\n${item.getString("name")}\n$title\n$explanation\n原因：$note",
            )
    return LiveCommand(
        key,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(
                path,
                body.toString(),
                "idempotency-key",
                "native-remedy-$key",
                proof.toString(),
            )
        ),
    )
}

private fun validateRemediationReply(root: JSONObject, p: JSONObject) {
    val d = root.getJSONObject("data")
    require(
        root.get("replayed") is Boolean &&
            d.getString("itemId") == p.getString("itemId") &&
            d.getString("taskId").isNotBlank()
    ) {
        "原实物处理回执不匹配"
    }
    if (p.getString("afterSales") == "remedy-remake") {
        require(
            d.getString("batchId").isNotBlank() &&
                d.getString("taskId") != p.getString("target") &&
                d.getInt("quantity") == p.getInt("quantity")
        ) {
            "重做批次回执不匹配"
        }
        return
    }
    val selected = d.getInt("selectedQuantity")
    val pending = d.getInt("pendingQuantity")
    val delivered = d.getInt("deliveredQuantity")
    val cancelled = d.getInt("cancelledQuantity")
    val paused = d.getInt("pausedQuantity")
    val units = financeRows(d, "units")
    require(
        d.getString("id").isNotBlank() &&
            (p.getString("afterSales") == "remedy-request" ||
                (d.getString("id") == p.getString("target") &&
                    d.getString("taskId") == p.getString("taskId"))) &&
            selected in 1..999 &&
            selected == p.getInt("selectedQuantity") &&
            listOf(pending, delivered, cancelled, paused).all { it in 0..selected } &&
            pending + delivered + cancelled == selected &&
            paused <= pending &&
            units.size == selected &&
            units.all { it.getString("id").isNotBlank() } &&
            units.map { it.getString("id") }.distinct().size == selected &&
            units.count { it.has("outcome") && it.isNull("outcome") } == pending &&
            units.count { it.optString("outcome") == "delivered" } == delivered &&
            units.count { it.optString("outcome") == "cancelled" } == cancelled &&
            d.getString("status") in
                listOf("pending", "acknowledged", "in_progress", "completed", "cancelled") &&
            (p.getString("afterSales") != "remedy-cancel" ||
                (pending == 0 && d.getString("status") == "cancelled")) &&
            (p.getString("afterSales") != "remedy-complete" ||
                delivered >= p.getInt("deliveredBefore") + p.getInt("quantity"))
    ) {
        "补送份数或原任务回执不匹配"
    }
}
