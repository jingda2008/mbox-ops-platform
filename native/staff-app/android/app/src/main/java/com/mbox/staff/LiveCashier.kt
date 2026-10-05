package com.mbox.staff

import java.net.URLEncoder
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

val refundPurposes =
    linkedMapOf(
        "return_goods" to "退货或取消商品",
        "price_adjustment" to "退差价",
        "service_compensation" to "服务补偿，商品继续供应",
        "duplicate_payment" to "重复收款退回",
    )

data class CashierItem(val source: JSONObject) {
    val id = source.getString("id")
    val name = source.getString("productName")
    val quantity = source.getInt("quantity")
    val remaining = source.longOrNull("remainingRefundableMinor")
    val fundsOnly = source.optBoolean("fundsOnly", false)
}

data class CashierRefund(val source: JSONObject) {
    val id = source.getString("id")
    val publicId = source.getString("publicId")
    val paymentId = source.getString("paymentId")
    val amount = source.getLong("amountMinor")
    val currency = source.getString("currency")
    val status = source.getString("status")
    val submission = source.getString("providerSubmissionState")
    val requesterName = source.getString("requestedByEmployeeName")
    val requester = source.getString("requestedByEmployeeId")
    val reason = source.getString("reason")
    val afterSales = source.optJSONObject("afterSalesCase")
}

data class CashierPayment(val source: JSONObject) {
    val id = source.getString("id")
    val publicId = source.getString("publicId")
    val provider = source.getString("provider")
    val currency = source.getString("currency")
    val status = source.getString("status")
    val amount = source.getLong("amountMinor")
    val remaining = source.getLong("remainingRefundableMinor")
    val reserved = source.getLong("reservedRefundAmountMinor")
    val items = source.getJSONArray("refundableItems").objects().map(::CashierItem)
    val refunds = source.getJSONArray("refunds").objects().map(::CashierRefund)
    val manual
        get() = provider in listOf("cash", "physical_pos", "external_manual")
}

data class CashierOrder(val source: JSONObject) {
    val id = source.getString("id")
    val publicId = source.getString("publicId")
    val code = source.getString("tableCode")
    val currency = source.getString("currency")
    val amount = source.getLong("totalAmountMinor")
    val due = source.getLong("outstandingAmountMinor")
    val paymentStatus = source.getString("paymentStatus")
    val over = source.getLong("overCollectedAmountMinor")
    val payments = source.getJSONArray("payments").objects().map(::CashierPayment)
    val recovery = source.optJSONObject("closedDebtRecovery")
    val authorization = source.optJSONObject("recollectionAuthorization")
    val needsRecollection: Boolean
        get() =
            due > 0 &&
                source.getString("status") !in listOf("draft", "cancelled") &&
                authorization == null &&
                if (source.textOrNull("tableSessionStatus") == "closed")
                    recovery?.optString("status") == "authorization_required"
                else
                    source.textOrNull("tableSessionStatus") in listOf("open", "closing") &&
                        payments.any { p -> p.refunds.any { it.status == "succeeded" } }
}

data class LiveCashier(val source: JSONObject) {
    val activities =
        source.optJSONArray("activityRegistrations")?.objects()?.map(::CashierActivity)
            ?: emptyList()
    val date = source.getString("businessDate")
    val query = source.getString("query")
    val actions = source.getJSONObject("actions")
    val orders = source.getJSONArray("orders").objects().map(::CashierOrder)

    fun unpaidCommand(
        actor: StaffIdentity,
        orderID: String,
        settle: Boolean,
        reasonCode: String,
        note: String,
    ): LiveCommand {
        val permission = if (settle) "order.settle_exception" else "order.cancel_unpaid"
        val reasons =
            if (settle) listOf("manager_comp", "uncollectible", "test_cleanup")
            else listOf("guest_left", "duplicate_order", "test_cleanup", "other")
        val order = orders.find { it.id == orderID }
        val reason = note.trim()
        require(
            actor.allows(permission) &&
                order != null &&
                order.paymentStatus == "unpaid" &&
                order.currency == "CNY" &&
                reasonCode in reasons &&
                reason.length in 4..500 &&
                order.payments.none {
                    it.status in
                        listOf("created", "pending", "succeeded", "partially_refunded", "refunded")
                } &&
                (if (settle)
                    order.source.getString("status") == "cancelled" &&
                        order.due > 0 &&
                        order.source.optJSONObject("settlementException") == null &&
                        order.source.getJSONArray("items").objects().any {
                            it.getString("status") == "delivered"
                        }
                else order.source.getString("status") != "cancelled") &&
                (!settle || reasonCode != "test_cleanup" || "OWNER" in actor.roles)
        ) {
            "仅处理当前未付款原单；有在途或到账款项应先核对，免单需相应权限"
        }
        val action = if (settle) "settle-exception" else "cancel-unpaid"
        val id = UUID.randomUUID().toString()
        val title = if (settle) "异常结清已送达未付款金额" else "取消未付款原订单"
        val proof =
            JSONObject()
                .put("cashier", true)
                .put("action", action)
                .put("orderId", order.id)
                .put("orderPublicId", order.publicId)
                .put("sourceBusinessDate", order.source.textOrNull("businessDate") ?: date)
                .put("amountMinor", order.due)
                .put(
                    "confirmation",
                    "${order.code} · ${order.publicId}\n当前未收 ${historyMoney(order.due)}\n$title\n原因：$reason\n这不是收款，也不会删除已送达商品、已消耗库存和原营业日记录。",
                )
        return LiveCommand(
            id,
            actor.employeeId,
            title,
            permission,
            listOf(
                LiveStep(
                    "/api/orders/${LiveCommand.part(order.id)}/$action",
                    JSONObject().put("reasonCode", reasonCode).put("reasonNote", reason).toString(),
                    "idempotency-key",
                    "native-unpaid-$id",
                    proof.toString(),
                )
            ),
        )
    }

    fun validateHistoricalSelection(
        actor: StaffIdentity,
        orderID: String,
        amount: Long,
        session: String,
        authorizationID: String,
        provider: String,
    ): CashierOrder {
        val mode = collectionMethods[provider]
        val order = orders.find { it.id == orderID }
        require(
            mode != null &&
                actions.optBoolean("supportsGuardedClosedDebtCollection") &&
                actions.optBoolean(mode[1]) &&
                actions.optBoolean("canAuthorizeRecollection") &&
                listOf(mode[0], "payment.collect.all_tables", "payment.recollect.authorize").all {
                    actor.allows(it)
                } &&
                order != null &&
                order.source.getString("status") !in listOf("draft", "cancelled") &&
                order.currency == "CNY" &&
                order.source.textOrNull("tableSessionStatus") == "closed" &&
                session.isNotEmpty() &&
                order.source.textOrNull("tableSessionId") == session &&
                order.recovery?.optString("status") == "available" &&
                order.recovery.getJSONArray("pendingPaymentIds").length() == 0 &&
                amount > 0 &&
                amount == order.due &&
                authorizationID.isNotEmpty() &&
                order.authorization?.optString("id") == authorizationID &&
                order.authorization.getLong("amountMinor") == amount
        ) {
            "历史欠款、原桌次、授权或权限已变化，或服务器尚未支持安全补收；请刷新原单"
        }
        return order
    }

    fun historicalCollection(
        actor: StaffIdentity,
        order: CashierOrder,
        provider: String,
        tender: Long?,
        reference: String,
        terminal: String,
        method: String,
        note: String,
    ): LiveCommand {
        val current =
            validateHistoricalSelection(
                actor,
                order.id,
                order.due,
                order.source.textOrNull("tableSessionId") ?: "",
                order.authorization?.optString("id") ?: "",
                provider,
            )
        val mode = collectionMethods[provider]!!
        val id = UUID.randomUUID().toString()
        val amount = current.due
        // Top-level amountMinor selects a batch/partial flow that is invalid for closed history.
        val body =
            JSONObject()
                .put("orderId", current.id)
                .put("publicId", "APP-PAY-$id")
                .put("provider", provider)
                .put("method", mode[2])
                .put(
                    "closedDebtGuard",
                    JSONObject()
                        .put("amountMinor", amount)
                        .put("authorizationId", current.authorization!!.getString("id")),
                )
        var cashDetail = ""
        if (provider == "cash") {
            require(tender != null && tender >= amount) { "实际收到现金不能少于本次补收金额" }
            body.put("receiptReference", "CASH-APP-$id")
            cashDetail = "\n实收现金：${historyMoney(tender)} · 找零：${historyMoney(tender - amount)}"
        } else {
            require(reference.trim().length in 3..256) { "请填写原收款凭证号（3—256字）" }
            body.put("receiptReference", reference.trim())
        }
        require(terminal.trim().length <= 128) { "终端编号过长" }
        if (terminal.isNotBlank()) body.put("terminalId", terminal.trim())
        if (provider == "external_manual") {
            require(
                method in
                    listOf(
                        "bank_transfer",
                        "mobile_wallet",
                        "stored_value_voucher",
                        "corporate_account",
                        "other",
                    ) && note.trim().length in 2..500
            ) {
                "请选择外部收款方式并填写说明"
            }
            body.put("externalMethodCode", method).put("collectionNote", note.trim())
        }
        val confirmation =
            "原订单：${current.publicId}\n原桌次：${current.source.getString("tableSessionId")}\n原营业日：${current.recovery!!.getString("originalBusinessDate")}\n本次全额补收：${historyMoney(amount)} · ${mode[3]}$cashDetail\n凭证：${body.getString("receiptReference")}\n确认款项已实际收到。记入服务器收款时的营业日，保留原订单与已关桌状态，不重新开桌、不新增出品。"
        val proof =
            JSONObject()
                .put("cashier", true)
                .put("action", "historical-collection")
                .put("orderId", current.id)
                .put("tableSessionId", current.source.getString("tableSessionId"))
                .put("amountMinor", amount)
                .put("actorId", actor.employeeId)
                .put("authorizationId", current.authorization.getString("id"))
                .put("confirmation", confirmation)
        return LiveCommand(
            id,
            actor.employeeId,
            "${current.code} · 登记历史补收 ${historyMoney(amount)}",
            mode[0],
            listOf(
                LiveStep(
                    "/api/payments/manual/closed-debt",
                    body.toString(),
                    "idempotency-key",
                    "native-payment-$id",
                    proof.toString(),
                )
            ),
        )
    }

    fun recoveryCommand(
        actor: StaffIdentity,
        orderID: String,
        paymentID: String,
        action: String,
        reason: String,
    ): LiveCommand {
        val order = orders.find { it.id == orderID }
        val trimmed = reason.trim()
        require(
            order != null &&
                order.currency == "CNY" &&
                actor.allows("payment.recollect.authorize") &&
                actions.optBoolean("canAuthorizeRecollection") &&
                trimmed.length in 4..500
        ) {
            "请刷新原订单、核对授权权限并填写4—500字原因"
        }
        val proof =
            JSONObject()
                .put("cashier", true)
                .put("action", action)
                .put("orderId", order.id)
                .put("actorId", actor.employeeId)
        val path: String
        val title: String
        val confirmation: String
        if (action == "recollect") {
            require(order.needsRecollection) { "当前订单不需要重新收款授权，请刷新原单" }
            proof.put("amountMinor", order.due)
            path = "/api/orders/${LiveCommand.part(order.id)}/recollection-authorizations"
            title = "${order.code} · 授权再次收款 ${historyMoney(order.due)}"
            confirmation =
                "原订单：${order.publicId}\n客人明确同意再次支付当前应收 ${historyMoney(order.due)}。原补偿仍然有效。仅授权此原单，默认30分钟内一次使用；此操作不扣款。\n原因：$trimmed"
        } else {
            val payment = order.payments.find { it.id == paymentID }
            val recovery = order.recovery
            val scope =
                recovery?.optJSONArray("closableUnpresentedPayments")?.objects()?.find {
                    it.optString("paymentId") == paymentID
                }
            require(
                action == "close-history" &&
                    order.source.textOrNull("tableSessionStatus") == "closed" &&
                    order.due > 0 &&
                    recovery?.optString("status") == "pending_payment" &&
                    actions.optBoolean("canViewReconciliation") &&
                    actions.optBoolean("canInitiateOnlinePayment") &&
                    listOf(
                            "payment.initiate.staff",
                            "reconciliation.view",
                            "payment.collect.all_tables",
                        )
                        .all { actor.allows(it) } &&
                    payment != null &&
                    payment.currency == "CNY" &&
                    payment.status in listOf("created", "pending") &&
                    scope != null &&
                    recovery.optJSONArray("closableUnpresentedPaymentIds")?.let {
                        (0 until it.length()).any { i -> it.getString(i) == paymentID }
                    } == true &&
                    recovery.getJSONArray("pendingPaymentIds").let {
                        (0 until it.length()).any { i -> it.getString(i) == paymentID }
                    }
            ) {
                "只可关闭服务端确认未对外展示的历史付款；请核对完整原付款范围和权限"
            }
            val ids =
                scope.getJSONArray("orderIds").let { a ->
                    (0 until a.length()).map { a.getString(it) }
                }
            val publicIDs =
                scope.getJSONArray("orderPublicIds").let { a ->
                    (0 until a.length()).map { a.getString(it) }
                }
            val kind = scope.getString("payableKind")
            val total = scope.getLong("totalAmountMinor")
            val index = ids.indexOf(order.id)
            require(
                kind in listOf("order", "order_batch") &&
                    scope.getString("currency") == "CNY" &&
                    total > 0 &&
                    ids.size == publicIDs.size &&
                    ids.distinct().size == ids.size &&
                    publicIDs.distinct().size == publicIDs.size &&
                    ids.none { it.isEmpty() } &&
                    publicIDs.none { it.isEmpty() } &&
                    index >= 0 &&
                    publicIDs[index] == order.publicId &&
                    (kind != "order" || ids.size == 1)
            ) {
                "原付款完整范围缺失，请刷新核对"
            }
            proof
                .put("paymentId", payment.id)
                .put("paymentPublicId", payment.publicId)
                .put("amountMinor", total)
                .put("payableKind", kind)
                .put("orderIds", JSONArray(ids))
            path = "/api/payments/${LiveCommand.part(payment.id)}/close-unpresented-history"
            title = "关闭历史未外送付款 · 整笔 ${historyMoney(total)}"
            confirmation =
                "原付款：${payment.publicId}\n涉及全部订单：${publicIDs.joinToString("、")}\n整笔金额：${historyMoney(total)}，不是本单分摊。仅本地关闭未外送尝试，不联系支付渠道、不退款、不重新开桌。\n原因：$trimmed"
        }
        proof.put("confirmation", confirmation)
        val id = UUID.randomUUID().toString()
        return LiveCommand(
            id,
            actor.employeeId,
            title,
            "payment.recollect.authorize",
            listOf(
                LiveStep(
                    path,
                    JSONObject().put("reason", trimmed).toString(),
                    "idempotency-key",
                    "native-cashier-$id",
                    proof.toString(),
                )
            ),
        )
    }

    fun command(
        actor: StaffIdentity,
        orderID: String,
        paymentID: String,
        action: String,
        refundID: String = "",
        amounts: Map<String, Long> = emptyMap(),
        reason: String = "",
        purpose: String = "",
        reference: String = "",
        succeeded: Boolean = true,
    ): LiveCommand {
        if (action in listOf("recollect", "close-history"))
            return recoveryCommand(actor, orderID, paymentID, action, reason)
        val order = orders.find { it.id == orderID }
        val activity = activities.find { it.id == orderID }
        val payment =
            order?.payments?.find { it.id == paymentID }
                ?: activity?.payment?.takeIf { it.id == paymentID }
                ?: activity
                    ?.late
                    ?.mapNotNull { it.optJSONObject("payment")?.let(::CashierPayment) }
                    ?.find { it.id == paymentID }
        require(
            payment != null &&
                (order?.currency ?: activity?.currency) == "CNY" &&
                payment.currency == "CNY" &&
                (activity == null ||
                    actor.allows("community.activity.cashier") &&
                        actions.optBoolean("canUseActivityCashier") &&
                        action != "request")
        ) {
            "原订单或付款已变化，请刷新"
        }
        val permission =
            when (action) {
                "request" -> "refund.request"
                "approve",
                "reject" -> "refund.approve"
                "payment-query",
                "payment-close" -> "reconciliation.view"
                else -> "refund.execute"
            }
        require(actor.allows(permission) && actions.optBoolean(flags[permission] ?: "", false)) {
            "当前账号或收银工作台未授权此操作"
        }
        val id = UUID.randomUUID().toString()
        val trimmed = reason.trim()
        var body = JSONObject()
        val proof =
            JSONObject()
                .put("cashier", true)
                .put("action", action)
                .put("paymentId", payment.id)
                .put("paymentPublicId", payment.publicId)
        val path: String
        val title: String
        if (action == "request") {
            require(
                payment.status in listOf("succeeded", "partially_refunded") &&
                    purpose in refundPurposes &&
                    trimmed.length in 2..1000 &&
                    amounts.size in 1..50
            ) {
                "请选择退款用途、原商品金额并填写2—1000字原因"
            }
            var total = 0L
            amounts.forEach { (itemID, amount) ->
                val item = payment.items.find { it.id == itemID }
                require(
                    amount > 0 &&
                        item?.remaining != null &&
                        amount <= item.remaining &&
                        !(item.fundsOnly &&
                            purpose !in listOf("price_adjustment", "duplicate_payment"))
                ) {
                    "所选商品可退余额或用途已变化；资金调整项只允许退差价或退重复款"
                }
                total = Math.addExact(total, amount)
            }
            require(total <= payment.remaining) { "退款超出原付款剩余可退金额" }
            val publicID = "APP-REF-$id"
            body =
                JSONObject()
                    .put("publicId", publicID)
                    .put("reason", trimmed)
                    .put("purpose", purpose)
                    .put(
                        "allocations",
                        JSONArray(
                            amounts.toSortedMap().map {
                                JSONObject().put("orderItemId", it.key).put("amountMinor", it.value)
                            }
                        ),
                    )
                    .put("requestEvidence", JSONObject().put("source", "native_cashier"))
            proof.put("refundPublicId", publicID).put("amountMinor", total)
            path = "/api/payments/${LiveCommand.part(payment.id)}/refunds"
            title =
                "${order?.code ?: activity?.title ?: ""} · 申请退款 ${historyMoney(total)} · 等待另一员工复核"
        } else if (action == "payment-close") {
            val whole = payment.source.longOrNull("originalAmountMinor")
            require(
                actions.optBoolean("supportsProviderClose") &&
                    actor.allows("payment.initiate.staff") &&
                    payment.provider == "postar" &&
                    payment.status in listOf("created", "pending") &&
                    whole != null &&
                    whole > 0 &&
                    trimmed.length in 4..500
            ) {
                "请刷新原付款整笔金额、渠道关单能力及权限，并填写4—500字原因"
            }
            body.put("reason", trimmed).put("expectedAmountMinor", whole)
            proof.put("amountMinor", whole)
            proof.put(
                "confirmation",
                "核对并关闭原渠道付款 ${payment.publicId}\n整笔金额 ${historyMoney(whole)}\n关联订单：${payment.source.optJSONArray("originalOrderPublicIds") ?: ""}\n原因：$trimmed\n先查渠道再关单；已到账则保留到账事实，不能另收。合并付款将处理整笔原款，不只当前订单。未知结果保留原请求。",
            )
            path = "/api/payments/${LiveCommand.part(payment.id)}/provider-close"
            title = "核对渠道并关闭原付款"
        } else if (action == "payment-query") {
            require(payment.provider == "postar") { "该付款不支持此渠道查询" }
            // Workbench amount may be only this order's share of a combined payment.
            // Compare only the explicit whole-payment amount supplied by the server.
            payment.source.longOrNull("originalAmountMinor")?.let {
                require(it > 0) { "原付款整笔金额无效，请刷新核对" }
                proof.put("originalAmountMinor", it)
            }
            path = "/api/payments/${LiveCommand.part(payment.id)}/provider-query"
            title = "核对原付款 ${payment.publicId} · 不再次扣款"
        } else {
            val refund = payment.refunds.find { it.id == refundID }
            require(refund != null && refund.paymentId == payment.id && refund.currency == "CNY") {
                "原退款记录已变化，请刷新"
            }
            require(refund.afterSales == null || action == "refund-query") {
                "这是原商品售后退款，必须通过原售后单处理"
            }
            proof
                .put("refundId", refund.id)
                .put("refundPublicId", refund.publicId)
                .put("amountMinor", refund.amount)
            var endpoint = action
            when (action) {
                "approve",
                "reject" -> {
                    require(
                        refund.status == "requested" &&
                            refund.requester != actor.employeeId &&
                            trimmed.length in 2..1000
                    ) {
                        "发起人不能复核自己的退款；请填写复核说明并核对待复核状态"
                    }
                    body.put("reason", trimmed)
                }
                "execute" ->
                    require(
                        refund.status == "approved" ||
                            (!payment.manual &&
                                refund.status == "processing" &&
                                refund.submission == "not_started")
                    ) {
                        "此退款不能重复提交执行，请先查询原退款"
                    }
                "refund-query" -> {
                    require(
                        payment.provider == "postar" &&
                            refund.status == "processing" &&
                            refund.submission != "not_started"
                    ) {
                        "退款尚未提交渠道或已返回最终结果，请刷新"
                    }
                    endpoint = "provider-query"
                }
                "manual-result" -> {
                    require(payment.manual && refund.status == "processing") { "仅处理中的线下退款可以登记实际结果" }
                    require(payment.provider == "cash" || reference.trim().length in 1..256) {
                        "请填写独立退款凭证号"
                    }
                    body.put("succeeded", succeeded)
                    if (payment.provider != "cash") body.put("receiptReference", reference.trim())
                    proof.put("succeeded", succeeded)
                }
                else -> error("不支持此退款操作")
            }
            path = "/api/refunds/${LiveCommand.part(refund.id)}/$endpoint"
            val label =
                when (action) {
                    "approve" -> "复核通过（线上可能自动提交原路退款）"
                    "reject" -> "驳回退款"
                    "execute" -> if (payment.manual) "开始人工退款" else "提交原路退款"
                    "refund-query" -> "查询退款结果"
                    else -> if (succeeded) "登记款项已实际退给客人" else "登记本次实际退款失败"
                }
            title =
                "${order?.code ?: activity?.title ?: ""} · $label · ${historyMoney(refund.amount)}"
        }
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
                    "native-cashier-$id",
                    proof.toString(),
                )
            ),
        )
    }

    companion object {
        val collectionMethods =
            mapOf(
                "cash" to listOf("payment.manual.cash.record", "canRecordManualCash", "cash", "现金"),
                "physical_pos" to
                    listOf("payment.manual.pos.record", "canRecordManualPos", "card", "实体POS"),
                "external_manual" to
                    listOf(
                        "payment.manual.external.record",
                        "canRecordManualExternal",
                        "manual",
                        "外部收款",
                    ),
            )
        val permissions =
            listOf(
                "reconciliation.view",
                "reconciliation.manage",
                "payment.settlement.view",
                "payment.manual.cash.record",
                "payment.manual.pos.record",
                "payment.manual.external.record",
                "refund.request",
                "refund.approve",
                "refund.execute",
                "community.activity.cashier",
                "business_day.close",
            )
        val flags =
            mapOf(
                "payment.recollect.authorize" to "canAuthorizeRecollection",
                "refund.request" to "canRequestRefund",
                "refund.approve" to "canApproveRefund",
                "refund.execute" to "canExecuteRefund",
                "reconciliation.view" to "canQueryOnlinePayment",
            )

        fun path(query: String) =
            "/api/payments/workbench?limit=100&query=" + URLEncoder.encode(query, "UTF-8")
    }
}

val LiveStep.cashierProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.optBoolean("cashier", false) }

fun validateCashierReply(text: String, step: LiveStep) {
    val proof = step.cashierProof ?: invalidResponse()
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    if (root.getJSONObject("meta").get("replayed") !is Boolean) invalidResponse()
    val action = proof.getString("action")
    if (action in listOf("cancel-unpaid", "settle-exception")) {
        if (
            data.getString("eventId").isBlank() ||
                step.path !=
                    "/api/orders/${LiveCommand.part(proof.getString("orderId"))}/$action" ||
                data.getString("orderPublicId") != proof.getString("orderPublicId") ||
                data.getString("sourceBusinessDate") != proof.getString("sourceBusinessDate") ||
                assignmentDate(data.getString("occurredAt")) == null ||
                data.get("replayed") !is Boolean ||
                data.getBoolean("replayed") != root.getJSONObject("meta").getBoolean("replayed")
        )
            invalidResponse()
        FinanceQuery(date = data.getString("actionBusinessDate")).path()
        if (action == "settle-exception") {
            if (
                data.getLong("settledAmountMinor") <= 0 ||
                    data.getLong("settledAmountMinor") != proof.getLong("amountMinor")
            )
                invalidResponse()
        } else
            listOf(
                    "deliveredItemCount",
                    "cancelledItemCount",
                    "cancelledKdsTaskCount",
                    "releasedInventoryReservationCount",
                )
                .forEach { if (data.getInt(it) < 0) invalidResponse() }
        return
    }
    if (action == "historical-collection") {
        val body = JSONObject(step.body)
        val evidence = data.getJSONObject("providerSnapshot")
        if (
            step.path != "/api/payments/manual/closed-debt" ||
                data.getString("id").isEmpty() ||
                data.getString("status") != "succeeded" ||
                data.getString("payableKind") != "order" ||
                data.getString("orderId") != proof.getString("orderId") ||
                data.getString("publicId") != body.getString("publicId") ||
                data.getLong("amountMinor") != proof.getLong("amountMinor") ||
                data.getString("currency") != "CNY" ||
                data.getString("provider") != body.getString("provider") ||
                data.getString("method") != body.getString("method") ||
                data.getString("providerTransactionId") != body.getString("receiptReference") ||
                evidence.getString("collectedByEmployeeId") != proof.getString("actorId") ||
                evidence.getString("receiptReference") != body.getString("receiptReference")
        )
            invalidResponse()
        listOf("terminalId", "externalMethodCode", "collectionNote")
            .filter { body.has(it) }
            .forEach { if (evidence.getString(it) != body.getString(it)) invalidResponse() }
        return
    }
    if (action == "recollect") {
        if (
            data.getString("id").isEmpty() ||
                data.getString("publicId").isEmpty() ||
                data.getString("orderId") != proof.getString("orderId") ||
                data.getString("authorizedByEmployeeId") != proof.getString("actorId") ||
                data.getLong("amountMinor") != proof.getLong("amountMinor") ||
                data.getString("currency") != "CNY" ||
                data.getString("reason") != JSONObject(step.body).getString("reason") ||
                data.getString("expiresAt").isEmpty() ||
                data.getString("createdAt").isEmpty()
        )
            invalidResponse()
        return
    }
    val status = data.getString("status")
    // Public payment serialization removes the internal local-close marker.
    if (action == "close-history") {
        if (
            status != "closed" ||
                data.getString("id") != proof.getString("paymentId") ||
                data.getString("publicId") != proof.getString("paymentPublicId") ||
                data.getLong("amountMinor") != proof.getLong("amountMinor") ||
                data.getString("currency") != "CNY" ||
                data.getString("payableKind") != proof.getString("payableKind")
        )
            invalidResponse()
        return
    }
    if (action == "payment-close") {
        if (
            data.getString("id") != proof.getString("paymentId") ||
                data.getString("publicId") != proof.getString("paymentPublicId") ||
                data.getLong("amountMinor") != proof.getLong("amountMinor") ||
                data.getString("currency") != "CNY" ||
                status !in
                    listOf("closed", "failed", "succeeded", "partially_refunded", "refunded") ||
                status == "closed" && !root.getJSONObject("meta").optBoolean("providerClosed")
        )
            invalidResponse()
        return
    }
    if (action == "payment-query") {
        if (
            step.path != "/api/payments/${LiveCommand.part(proof.getString("paymentId"))}/provider-query" ||
                data.getString("publicId") != proof.getString("paymentPublicId") ||
                (data.has("id") && data.getString("id") != proof.getString("paymentId")) ||
                (data.has("currency") && data.getString("currency") != "CNY") ||
                (data.has("amountMinor") && (data.getLong("amountMinor") <= 0 ||
                    proof.has("originalAmountMinor") && data.getLong("amountMinor") != proof.getLong("originalAmountMinor"))) ||
                status !in
                    listOf(
                        "created",
                        "pending",
                        "succeeded",
                        "failed",
                        "closed",
                        "partially_refunded",
                        "refunded",
                    )
        )
            invalidResponse()
        return
    }
    if (action == "refund-query" && status == "processing" && !data.has("id")) return
    if (
        data.getString("id").isEmpty() ||
            (proof.has("refundId") && data.getString("id") != proof.getString("refundId")) ||
            data.getString("publicId") != proof.getString("refundPublicId") ||
            data.getString("paymentId") != proof.getString("paymentId") ||
            data.getLong("amountMinor") != proof.getLong("amountMinor") ||
            data.getString("currency") != "CNY"
    )
        invalidResponse()
    if (action == "request") {
        val expected = JSONObject(step.body).getJSONArray("allocations").objects()
        val actual = data.getJSONArray("allocations").objects()
        if (
            expected.size != actual.size ||
                actual.map { it.getString("orderItemId") }.distinct().size != actual.size ||
                actual.any { row ->
                    expected.none {
                        it.getString("orderItemId") == row.getString("orderItemId") &&
                            it.getLong("amountMinor") == row.getLong("amountMinor")
                    }
                }
        )
            invalidResponse()
    }
    val allowed =
        when (action) {
            "request" -> listOf("requested")
            "approve" -> listOf("approved", "processing", "succeeded")
            "reject" -> listOf("rejected")
            "execute",
            "refund-query" -> listOf("processing", "succeeded", "failed")
            "manual-result" -> listOf(if (proof.getBoolean("succeeded")) "succeeded" else "failed")
            else -> emptyList()
        }
    if (status !in allowed) invalidResponse()
}
