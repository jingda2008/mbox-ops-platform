package com.mbox.staff

import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class LiveOrderAccess(
    val employeeID: String,
    val canCreateOrder: Boolean,
    val giftEnabled: Boolean,
    val giftLimit: Long?,
    val giftCurrency: String?,
) {
    companion object {
        fun parse(j: JSONObject): LiveOrderAccess {
            val g = j.optJSONObject("gift")
            return LiveOrderAccess(
                j.getString("employeeId"),
                j.getBoolean("canCreateOrder"),
                g?.getBoolean("enabled") == true,
                if (g == null || g.isNull("maximumAmountMinor")) null
                else g.getLong("maximumAmountMinor"),
                g?.getString("currency"),
            )
        }
    }
}

data class LiveOrderContext(
    val token: String,
    val employeeID: String,
    val authSessionID: String,
    val session: String,
    val expiry: Instant,
) {
    companion object {
        fun parse(j: JSONObject) =
            LiveOrderContext(
                j.getString("token"),
                j.getString("employeeId"),
                j.getString("staffSessionId"),
                j.getString("tableSessionId"),
                serverInstant(j.getString("expiresAt")),
            )
    }
}

data class LiveReplacement(
    val itemID: String,
    val caseID: String,
    val originalOrderID: String,
    val originalPublicID: String,
    val productName: String,
    val session: String,
    val tableCode: String,
    val employeeID: String,
    val previousOrderID: String?,
) {
    val draftSession
        get() = "$session:replacement:$caseID:${previousOrderID ?: "first"}"

    val explanation
        get() = "原单 $originalPublicID · $productName。新商品按当前价格另计，原退款不自动抵扣；原申请的审批、退款和实物处理仍需分别完成。"

    fun json() =
        JSONObject()
            .put("itemID", itemID)
            .put("caseID", caseID)
            .put("originalOrderID", originalOrderID)
            .put("originalPublicID", originalPublicID)
            .put("productName", productName)
            .put("session", session)
            .put("tableCode", tableCode)
            .put("employeeID", employeeID)
            .put("previousOrderID", previousOrderID ?: JSONObject.NULL)

    fun validate(board: LiveAfterSales, actor: StaffIdentity) {
        require(make(board, caseID, actor) == this) { "原商品、桌次或换品关联已变化，请返回原商品重新核对" }
    }

    fun recoveredReceipt(
        board: LiveAfterSales,
        publicID: String,
        orderID: String? = null,
    ): LiveOrderReceipt? {
        board.validate(itemID)
        require(board.item.getString("orderId") == originalOrderID) { "原商品订单不匹配" }
        val matches =
            board.source
                .optJSONArray("replacementOrders")
                ?.objects()
                ?.filter { it.getString("publicId") == publicID }
                .orEmpty()
        require(matches.size <= 1) { "换品回执重复，请核对" }
        val link = matches.firstOrNull() ?: return null
        require(
            link.getString("sourceCaseId") == caseID &&
                link.getString("orderId").isNotBlank() &&
                (orderID == null || orderID == link.getString("orderId"))
        ) {
            "换品新单关联不匹配"
        }
        return LiveOrderReceipt(publicID, link.getString("orderId"), null, true)
    }

    companion object {
        fun parse(j: JSONObject) =
            LiveReplacement(
                j.getString("itemID"),
                j.getString("caseID"),
                j.getString("originalOrderID"),
                j.getString("originalPublicID"),
                j.getString("productName"),
                j.getString("session"),
                j.getString("tableCode"),
                j.getString("employeeID"),
                j.textOrNull("previousOrderID"),
            )

        fun make(board: LiveAfterSales, caseID: String, actor: StaffIdentity): LiveReplacement {
            board.validate(board.id)
            val row = board.cases.find { it.getString("caseId") == caseID }
            val previous = row?.optJSONObject("replacementOrder")
            val session = board.item.textOrNull("tableSessionId")
            require(
                board.source.optBoolean("supportsNativeReplacementRecovery") &&
                    actor.allows("refund.request") &&
                    actor.allows("order.create") &&
                    !session.isNullOrBlank() &&
                    row?.optBoolean("canReplace") == true &&
                    row.textOrNull("revisedByCaseId") == null &&
                    row.getString("status") in listOf("requested", "approved", "completed") &&
                    row.getInt("heldQuantity") + row.getInt("stoppedQuantity") > 0 &&
                    (previous == null || previous.getString("status") == "cancelled")
            ) {
                "原申请、换品权限或已关联新单发生变化，请刷新原商品"
            }
            return LiveReplacement(
                board.id,
                caseID,
                board.item.getString("orderId"),
                board.item.getString("orderPublicId"),
                board.item.getString("name"),
                session!!,
                board.item.getString("tableCode"),
                actor.employeeId,
                previous?.getString("orderId"),
            )
        }
    }
}

data class LiveOrderReceipt(
    val publicId: String,
    val id: String?,
    val amount: Long?,
    val recovered: Boolean,
) {
    fun json() =
        JSONObject()
            .put("publicId", publicId)
            .put("id", id ?: JSONObject.NULL)
            .put("amount", amount ?: JSONObject.NULL)
            .put("recovered", recovered)

    companion object {
        fun parse(j: JSONObject) =
            LiveOrderReceipt(
                j.getString("publicId"),
                if (j.isNull("id")) null else j.getString("id"),
                if (j.isNull("amount")) null else j.getLong("amount"),
                j.getBoolean("recovered"),
            )
    }
}

data class LiveOrderSubmission(
    val key: String,
    val publicId: String,
    val employeeID: String,
    val authSessionID: String,
    val tableSessionID: String,
    val tableCode: String,
    val createdAt: Instant,
    val draftIDs: List<String>,
    val body: String,
    val token: String,
    val receipt: LiveOrderReceipt? = null,
    val rejectedCode: String? = null,
    val replacement: LiveReplacement? = null,
    val replacementVerified: Boolean = false,
) {
    val canFinish
        get() = receipt != null && (replacement == null || replacementVerified)

    val draftSession
        get() = replacement?.draftSession ?: tableSessionID

    fun json(): JSONObject =
        JSONObject()
            .put("key", key)
            .put("publicId", publicId)
            .put("employeeID", employeeID)
            .put("authSessionID", authSessionID)
            .put("tableSessionID", tableSessionID)
            .put("tableCode", tableCode)
            .put("createdAt", createdAt.toString())
            .put("draftIDs", JSONArray(draftIDs))
            .put("body", body)
            .put("token", token)
            .put("receipt", receipt?.json() ?: JSONObject.NULL)
            .put("rejectedCode", rejectedCode ?: JSONObject.NULL)
            .put("replacement", replacement?.json() ?: JSONObject.NULL)
            .put("replacementVerified", replacementVerified)

    fun validate() {
        require(!replacementVerified || (replacement != null && receipt != null)) { "换品回执核对标记无效" }
        val obj = JSONObject(body)
        if (replacement != null) {
            require(
                replacement.employeeID == employeeID &&
                    replacement.session == tableSessionID &&
                    replacement.tableCode == tableCode &&
                    replacement.caseID.isNotBlank() &&
                    replacement.itemID.isNotBlank() &&
                    obj.getString("replacementCaseId") == replacement.caseID &&
                    obj.textOrNull("replacementPreviousOrderId") == replacement.previousOrderID &&
                    obj.getString("orderMode") == "paid"
            ) {
                "换品原请求不匹配"
            }
        } else
            require(!obj.has("replacementCaseId") && !obj.has("replacementPreviousOrderId")) {
                "缺少换品原请求记录"
            }
        if (
            key.isBlank() ||
                publicId.isBlank() ||
                employeeID.isBlank() ||
                authSessionID.isBlank() ||
                tableSessionID.isBlank() ||
                draftIDs.isEmpty() ||
                obj.getString("publicId") != publicId ||
                obj.getString("tableSessionId") != tableSessionID ||
                obj.getString("assistedOrderContextToken") != token ||
                obj.getJSONArray("items").length() == 0 ||
                (receipt != null && receipt.publicId != publicId)
        )
            invalidResponse()
    }

    fun parseReceipt(text: String): LiveOrderReceipt {
        val j = JSONObject(text)
        if (
            j.getString("publicId") != publicId ||
                j.getString("tableSessionId") != tableSessionID ||
                j.getString("id").isBlank() ||
                j.getString("currency") != "CNY" ||
                j.getLong("totalAmountMinor") < 0 ||
                j.getJSONObject("paymentNextStep").getString("orderId") != j.getString("id")
        )
            invalidResponse()
        return LiveOrderReceipt(publicId, j.getString("id"), j.getLong("totalAmountMinor"), false)
    }

    fun canReplay(identity: StaffIdentity, now: Instant = Instant.now()): Boolean {
        val zone = ZoneId.of("Asia/Shanghai")
        return identity.employeeId == employeeID &&
            identity.sessionId == authSessionID &&
            identity.allows("order.create") &&
            !now.isBefore(createdAt) &&
            java.time.Duration.between(createdAt, now).seconds < 12 * 3600 &&
            createdAt.atZone(zone).minusHours(6).toLocalDate() ==
                now.atZone(zone).minusHours(6).toLocalDate()
    }

    companion object {
        fun initialRejection(error: Exception): String? {
            val e = error as? StaffAPIError ?: return null
            return e.code.takeIf {
                e.status in listOf(400, 409) &&
                    it in
                        setOf(
                            "ORDER_ITEMS_INVALID",
                            "ORDER_DUPLICATE_PRODUCT",
                            "REQUEST_INVALID",
                            "ORDER_PRODUCT_UNAVAILABLE",
                            "TABLE_SESSION_UNAVAILABLE",
                            "INVENTORY_RECIPE_MISSING",
                            "INVENTORY_BALANCE_MISSING",
                            "INVENTORY_INSUFFICIENT",
                            "GIFT_REASON_REQUIRED",
                            "SETTLEMENT_MODE_INVALID",
                            "BUNDLE_SELECTION_INVALID",
                        )
            }
        }

        fun parse(j: JSONObject) =
            LiveOrderSubmission(
                    j.getString("key"),
                    j.getString("publicId"),
                    j.getString("employeeID"),
                    j.getString("authSessionID"),
                    j.getString("tableSessionID"),
                    j.getString("tableCode"),
                    serverInstant(j.getString("createdAt")),
                    j.getJSONArray("draftIDs").strings(),
                    j.getString("body"),
                    j.getString("token"),
                    j.optJSONObject("receipt")?.let(LiveOrderReceipt::parse),
                    if (j.isNull("rejectedCode")) null
                    else j.optString("rejectedCode").takeIf { it.isNotBlank() },
                    j.optJSONObject("replacement")?.let(LiveReplacement::parse),
                    j.optBoolean("replacementVerified"),
                )
                .also { it.validate() }

        fun make(
            lines: List<LiveDraftLine>,
            products: List<LiveProduct>,
            identity: StaffIdentity,
            access: LiveOrderAccess,
            context: LiveOrderContext,
            session: String,
            tableCode: String,
            gift: Boolean,
            reason: String,
            note: String,
            settlement: String,
            replacement: LiveReplacement? = null,
            source: LiveAfterSales? = null,
        ): LiveOrderSubmission {
            require(
                identity.allows("order.create") &&
                    access.employeeID == identity.employeeId &&
                    access.canCreateOrder &&
                    context.employeeID == identity.employeeId &&
                    context.authSessionID == identity.sessionId &&
                    context.session == session &&
                    context.expiry.isAfter(Instant.now()) &&
                    note.length <= 500 &&
                    settlement in listOf("table_tab", "immediate_payment")
            ) {
                "身份、桌次或点单权限已变化，请刷新重试"
            }
            if (replacement != null) {
                require(
                    !gift &&
                        source != null &&
                        replacement.session == session &&
                        replacement.tableCode == tableCode
                ) {
                    "换品须关联原桌次并按新商品独立计价"
                }
                replacement.validate(source, identity)
            }
            lines.forEach { line ->
                val latest = products.find { it.id == line.product.id }
                require(latest != null && latest.price == line.product.price) {
                    "商品价格已变化，请移除该商品并重新选择"
                }
                LiveDraftLine.make(latest, line.choices, line.note)
                require(lines.count { it.product.id == latest.id } <= latest.maxOrderQuantity) {
                    "商品限购数量已变化，请减少数量"
                }
            }
            if (gift) {
                val total = lines.sumOf { (it.product.price ?: 0).toLong() }
                require(
                    identity.allows("order.gift") &&
                        access.giftEnabled &&
                        access.giftCurrency == "CNY" &&
                        (access.giftLimit == null || total <= access.giftLimit) &&
                        reason.trim().length in 2..200
                ) {
                    "赠送权限、额度或理由不符合要求"
                }
            }
            val key = "native-order-" + UUID.randomUUID()
            val publicId = "APP-" + UUID.randomUUID()
            val obj =
                JSONObject()
                    .put("publicId", publicId)
                    .put("tableSessionId", session)
                    .put("assistedOrderContextToken", context.token)
                    .put("items", liveOrderItems(lines))
                    .put("orderMode", if (gift) "gift" else "paid")
                    .put("settlementMode", if (gift) "table_tab" else settlement)
            replacement?.let {
                obj.put("replacementCaseId", it.caseID)
                it.previousOrderID?.let { previous ->
                    obj.put("replacementPreviousOrderId", previous)
                }
            }
            if (gift) obj.put("giftReason", reason.trim())
            if (note.isNotBlank()) obj.put("fulfillmentNote", note.trim())
            return LiveOrderSubmission(
                key,
                publicId,
                identity.employeeId,
                identity.sessionId,
                session,
                tableCode,
                Instant.now(),
                lines.map { it.id },
                obj.toString(),
                context.token,
                replacement = replacement,
            )
        }
    }
}
