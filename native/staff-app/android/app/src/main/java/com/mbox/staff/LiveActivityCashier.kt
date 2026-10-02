package com.mbox.staff

import java.time.Instant
import java.util.UUID
import org.json.JSONObject

class CashierActivity(val source: JSONObject) {
    val id = source.getString("id")
    val publicId = source.getString("publicId")
    val title = source.getString("activityTitle")
    val currency = source.getString("currency")
    val payment = source.optJSONObject("payment")?.let(::CashierPayment)
    val late = source.optJSONArray("lateSuccessPayments")?.objects() ?: emptyList()
    val authorization = source.optJSONObject("recollectionAuthorization")
    val refunded
        get() =
            source.getString("status") == "refunded" ||
                source.getString("paymentStatus") == "refunded"

    val due
        get() = source.getLong(if (refunded) "paidAmountMinor" else "amountDueMinor")

    val onlinePending
        get() =
            payment?.let {
                it.provider in listOf("postar", "wechat") &&
                    it.status in listOf("created", "pending")
            } == true

    val canCollect
        get() =
            due > 0 &&
                !onlinePending &&
                late.isEmpty() &&
                (payment?.refunds?.all {
                    it.status in listOf("failed", "rejected", "cancelled") ||
                        refunded && it.status == "succeeded"
                } != false) &&
                if (refunded)
                    authorization
                        ?.textOrNull("expiresAt")
                        ?.let(::assignmentDate)
                        ?.isAfter(Instant.now()) == true
                else
                    source.getString("status") == "payment_pending" &&
                        source.getString("paymentStatus") == "pending"
}

fun LiveCashier.activityCommand(
    actor: StaffIdentity,
    registrationID: String,
    action: String,
    provider: String = "cash",
    reference: String = "",
    terminal: String = "",
    externalMethod: String = "bank_transfer",
    reason: String = "",
    paymentPublicID: String = "",
    confirmed: Boolean = false,
): LiveCommand {
    val r = activities.find { it.id == registrationID }
    require(
        actor.allows("community.activity.cashier") &&
            actions.optBoolean("canUseActivityCashier") &&
            actions.optBoolean("supportsGuardedActivityCashier") &&
            r != null &&
            r.currency == "CNY"
    ) {
        "活动收银权限或原报名已变化，请刷新"
    }
    val id = UUID.randomUUID().toString()
    val note = reason.trim()
    val ref = reference.trim()
    val term = terminal.trim()
    val body = JSONObject()
    var amount = r.due
    val permission: String
    val title: String
    val path: String
    val proof =
        JSONObject()
            .put("activity", action)
            .put("registrationId", r.id)
            .put("registrationPublicId", r.publicId)
            .put("actorId", actor.employeeId)
    when (action) {
        "collect" -> {
            val method =
                mapOf(
                    "cash" to listOf("cash", "payment.manual.cash.record", "canRecordManualCash"),
                    "physical_pos" to
                        listOf("card", "payment.manual.pos.record", "canRecordManualPos"),
                    "external_manual" to
                        listOf(
                            "manual",
                            "payment.manual.external.record",
                            "canRecordManualExternal",
                        ),
                )[provider]
            require(method != null && actions.optBoolean(method[2]) && r.canCollect && confirmed) {
                "须核对已实际收款；旧款未退、渠道未知或授权过期不能另收"
            }
            permission = method[1]
            require(
                (provider == "cash" || ref.length in 3..256) &&
                    (provider != "physical_pos" || term.length in 2..128)
            ) {
                "请填写可核对的原收款凭证和POS终端"
            }
            require(
                provider != "external_manual" ||
                    externalMethod in
                        listOf(
                            "bank_transfer",
                            "mobile_wallet",
                            "stored_value_voucher",
                            "corporate_account",
                            "other",
                        ) && note.length in 2..500
            ) {
                "请填写实际收款方式及2—500字说明"
            }
            body
                .put("publicId", "APP-ACT-$id")
                .put("provider", provider)
                .put("method", method[0])
                .put("expectedAmountMinor", amount)
            if (provider != "cash") body.put("receiptReference", ref)
            if (provider == "physical_pos") body.put("terminalId", term)
            if (provider == "external_manual")
                body.put("externalMethodCode", externalMethod).put("collectionNote", note)
            path = "/api/activity-registrations/${LiveCommand.part(r.publicId)}/manual-collections"
            title = "登记活动款已实际收到"
        }
        "recollect" -> {
            permission = "payment.recollect.authorize"
            require(
                actions.optBoolean("canAuthorizeRecollection") &&
                    r.refunded &&
                    r.due > 0 &&
                    r.late.isEmpty() &&
                    r.authorization == null &&
                    note.length in 4..500
            ) {
                "请核对已退款报名、迟到旧款及4—500字重新收款原因"
            }
            body.put("reason", note)
            path =
                "/api/activity-registrations/${LiveCommand.part(r.publicId)}/recollection-authorizations"
            title = "授权活动再次收款"
        }
        "refund" -> {
            permission = "refund.request"
            require(actions.optBoolean("canRequestRefund") && note.length in 2..1000) {
                "请核对退款权限并填写2—1000字原因"
            }
            val publicID: String
            if (paymentPublicID.isEmpty()) {
                val p = r.payment
                require(
                    p != null &&
                        p.status in listOf("succeeded", "partially_refunded") &&
                        p.remaining > 0 &&
                        p.refunds.all { it.status in listOf("failed", "rejected", "cancelled") }
                ) {
                    "原款不可重复申请退款，请先处理在途退款"
                }
                publicID = p.publicId
                amount = p.remaining
                proof.put("paymentId", p.id)
            } else {
                val late = r.late.find { it.getString("publicId") == paymentPublicID }
                require(
                    late != null &&
                        late.getString("currency") == "CNY" &&
                        late.getLong("remainingRefundableMinor") > 0 &&
                        (late.textOrNull("refundStatus") == null ||
                            late.textOrNull("refundStatus") in
                                listOf("failed", "rejected", "cancelled"))
                ) {
                    "仅对已确认迟到到账且无在途退款的旧款申请"
                }
                publicID = late.getString("publicId")
                amount = late.getLong("remainingRefundableMinor")
            }
            body.put("expectedPaymentPublicId", publicID).put("reason", note)
            proof.put("paymentPublicId", publicID)
            path =
                "/api/staff/community-activity-registrations/${LiveCommand.part(r.publicId)}/refunds"
            title = "申请活动原款全额退回"
        }
        else -> error("不支持的活动操作")
    }
    require(actor.allows(permission) && amount > 0) { "当前权限或金额已变化" }
    proof
        .put("amountMinor", amount)
        .put(
            "confirmation",
            "${r.title} · ${r.source.getInt("partySize")}人\n报名 ${r.publicId}\n$title：${historyMoney(amount)}\n凭证：$ref\n说明：$note\n活动与桌台订单分别记账；退款需另一员工复核。重新收款仍须通过名额及库存校验。",
        )
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
                "native-activity-$id",
                proof.toString(),
            )
        ),
    )
}

val LiveStep.activityProof: JSONObject?
    get() = recoveryBody?.let(::JSONObject)?.takeIf { it.opt("activity") is String }

fun validateActivityReply(text: String, step: LiveStep) {
    val p = step.activityProof ?: invalidResponse()
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    val body = JSONObject(step.body)
    if (
        root.getJSONObject("meta").get("replayed") !is Boolean ||
            d.getString("id").isBlank() ||
            d.getLong("amountMinor") != p.getLong("amountMinor") ||
            d.getString("currency") != "CNY"
    )
        invalidResponse()
    when (p.getString("activity")) {
        "collect" -> {
            if (
                d.getString("publicId") != body.getString("publicId") ||
                    d.getString("activityRegistrationId") != p.getString("registrationId") ||
                    d.getString("payableKind") != "activity_registration" ||
                    d.getString("status") != "succeeded" ||
                    d.getString("provider") != body.getString("provider") ||
                    d.getString("method") != body.getString("method")
            )
                invalidResponse()
            val snapshot = d.getJSONObject("providerSnapshot")
            if (snapshot.getString("collectedByEmployeeId") != p.getString("actorId"))
                invalidResponse()
            listOf("receiptReference", "terminalId", "externalMethodCode", "collectionNote")
                .filter { body.has(it) }
                .forEach { if (snapshot.getString(it) != body.getString(it)) invalidResponse() }
        }
        "recollect" ->
            if (
                d.getString("activityRegistrationId") != p.getString("registrationId") ||
                    d.getString("authorizedByEmployeeId") != p.getString("actorId") ||
                    d.getString("reason") != body.getString("reason") ||
                    assignmentDate(d.getString("expiresAt")) == null
            )
                invalidResponse()
        "refund" -> {
            if (
                d.getString("status") != "requested" ||
                    d.getString("paymentId").isBlank() ||
                    p.has("paymentId") && d.getString("paymentId") != p.getString("paymentId") ||
                    d.getString("reason") != body.getString("reason") ||
                    d.getString("activityRegistrationId") != p.getString("registrationId")
            )
                invalidResponse()
        }
        else -> invalidResponse()
    }
}
