package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class LivePaymentOrder(
    val id: String,
    val publicId: String,
    val currency: String,
    val paymentStatus: String,
    val amount: Int,
    val pending: Boolean,
    val pendingId: String?,
) {
    val selectable
        get() = currency == "CNY" && amount > 0 && !pending && pendingId == null

    companion object {
        val permissions =
            listOf(
                "payment.initiate.staff",
                "payment.manual.cash.record",
                "payment.manual.pos.record",
                "payment.manual.external.record",
            )

        fun parse(j: JSONObject): LivePaymentOrder {
            val amount = j.getLong("outstandingAmountMinor")
            require(amount in 0..Int.MAX_VALUE.toLong()) { "应收金额超出当前可处理范围，请到收银台核对" }
            return LivePaymentOrder(
                j.getString("id"),
                j.getString("publicId"),
                j.getString("currency"),
                j.getString("paymentStatus"),
                amount.toInt(),
                j.getBoolean("hasOnlinePaymentInProgress"),
                if (j.isNull("unresolvedOnlinePaymentId")) null
                else j.getString("unresolvedOnlinePaymentId"),
            )
        }
    }
}

fun manualCollection(
    orders: List<LivePaymentOrder>,
    actor: StaffIdentity,
    amount: Int,
    provider: String,
    reference: String,
    terminal: String,
    method: String,
    note: String,
    session: String? = null,
): LiveCommand {
    val permission =
        mapOf(
            "cash" to "payment.manual.cash.record",
            "physical_pos" to "payment.manual.pos.record",
            "external_manual" to "payment.manual.external.record",
        )[provider]
    require(
        permission != null &&
            actor.allows(permission) &&
            orders.isNotEmpty() &&
            orders.size <= 50 &&
            orders.map { it.id }.distinct().size == orders.size &&
            orders.all { it.selectable } &&
            amount > 0 &&
            amount.toLong() <= orders.sumOf { it.amount.toLong() }
    ) {
        "订单、权限或收款金额已变化；原款未确认时不能再次收款"
    }
    val id = UUID.randomUUID().toString()
    val body =
        JSONObject()
            .put("orderId", orders[0].id)
            .put("amountMinor", amount)
            .put("publicId", "APP-PAY-$id")
            .put("provider", provider)
            .put(
                "method",
                if (provider == "cash") "cash"
                else if (provider == "physical_pos") "card" else "manual",
            )
    if (orders.size > 1) body.put("orderIds", JSONArray(orders.map { it.id }))
    if (provider == "cash") body.put("receiptReference", "CASH-APP-$id")
    else {
        require(reference.trim().length in 3..256) { "请填写原收款凭证号（3—256字）" }
        body.put("receiptReference", reference.trim())
    }
    if (terminal.isNotBlank()) {
        require(terminal.trim().length <= 128) { "终端编号过长" }
        body.put("terminalId", terminal.trim())
    }
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
    return LiveCommand(
        id,
        actor.employeeId,
        "登记已收款 ${money(amount)} · ${orders.size}笔订单",
        permission,
        listOf(
            LiveStep(
                "/api/payments/manual",
                body.toString(),
                "idempotency-key",
                "native-payment-$id",
                recoveryBody = session?.let { JSONObject().put("collectionSession", it).toString() },
            )
        ),
    )
}

val LiveStep.collectionSession: String?
    get() =
        if (path == "/api/payments/manual")
            recoveryBody?.let { JSONObject(it).textOrNull("collectionSession") }
        else null
