package com.mbox.staff

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.sp

@Composable
fun ActivityCashierCard(m: AppModel, r: CashierActivity, propose: (LiveCommand) -> Unit) {
    var provider by remember { mutableStateOf("cash") }
    var reference by remember { mutableStateOf("") }
    var terminal by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("bank_transfer") }
    var reason by remember { mutableStateOf("") }
    fun act(action: String, payment: String = "") {
        try {
            propose(
                m.prepareActivity(
                    r.id,
                    action,
                    provider,
                    reference,
                    terminal,
                    method,
                    reason,
                    payment,
                    action == "collect",
                )
            )
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新原报名"
        }
    }
    fun paymentAct(
        payment: CashierPayment,
        action: String,
        refundID: String = "",
        note: String = "",
        ref: String = "",
        ok: Boolean = true,
    ) {
        try {
            propose(
                m.prepareCashier(
                    r.id,
                    payment.id,
                    action,
                    refundID,
                    reason = note,
                    reference = ref,
                    succeeded = ok,
                )
            )
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新原付款"
        }
    }
    Foldout("活动 · ${r.title} · ${historyMoney(r.due)}") {
        Text("${r.publicId} · ${r.source.getInt("partySize")}人", fontSize = 12.sp)
        Text(
            "${r.source.getString("startsAt")} · ${cashierStatus(r.source.getString("paymentStatus"))}",
            fontSize = 12.sp,
        )
        if (m.cashier?.actions?.optBoolean("supportsGuardedActivityCashier") != true)
            Text("活动资金操作需要后台升级，当前只供核对原记录。", fontSize = 12.sp)
        OutlinedTextField(reason, { reason = it }, label = { Text("操作原因或收款说明") })
        if (r.onlinePending) Text("原线上付款待确认，其他收款入口已锁定。请先查询原款。")
        if (r.refunded && r.authorization == null && r.late.isEmpty())
            Primary("授权活动重新收款", enabled = m.canUseActivity) { act("recollect") }
        r.authorization?.let {
            Text(
                "授权一次 ${historyMoney(it.getLong("amountMinor"))} · 截止 ${it.getString("expiresAt")}",
                fontSize = 12.sp,
            )
        }
        if (r.canCollect) {
            listOf("cash", "physical_pos", "external_manual").forEach { code ->
                FilterChip(
                    selected = provider == code,
                    onClick = { provider = code },
                    label = { Text(cashierProvider(code)) },
                )
            }
            if (provider != "cash")
                OutlinedTextField(reference, { reference = it }, label = { Text("独立收款凭证号") })
            if (provider == "physical_pos")
                OutlinedTextField(terminal, { terminal = it }, label = { Text("POS终端编号") })
            if (provider == "external_manual")
                mapOf(
                        "bank_transfer" to "银行转账",
                        "mobile_wallet" to "其他钱包",
                        "stored_value_voucher" to "储值凭证",
                        "corporate_account" to "公司账户",
                        "other" to "其他批准方式",
                    )
                    .forEach { (code, label) ->
                        FilterChip(
                            selected = method == code,
                            onClick = { method = code },
                            label = { Text(label) },
                        )
                    }
            Primary("已实际收到 ${historyMoney(r.due)} · 核对登记", enabled = m.canUseActivity) {
                act("collect")
            }
        }
        r.payment?.let { payment ->
            Text("原付款 ${payment.publicId} · ${cashierStatus(payment.status)}", fontSize = 12.sp)
            if (payment.provider == "postar")
                Primary("查询原活动付款", enabled = m.canUseActivity) {
                    paymentAct(payment, "payment-query")
                }
            if (
                payment.remaining > 0 &&
                    payment.refunds.all { it.status in listOf("failed", "rejected", "cancelled") }
            )
                Primary("申请活动原款全额退款", enabled = m.canUseActivity) { act("refund") }
            if (r.onlinePending)
                Primary("核对渠道并关闭原活动付款", enabled = m.canUseActivity) {
                    paymentAct(payment, "payment-close", note = reason)
                }
            payment.refunds.forEach { refund ->
                CashierRefundCard(m, payment, refund) { action, note, ref, ok ->
                    paymentAct(payment, action, refund.id, note, ref, ok)
                }
            }
        }
        r.late.forEach { late ->
            late.optJSONObject("payment")?.let(::CashierPayment)?.let { payment ->
                payment.refunds.forEach { refund ->
                    CashierRefundCard(m, payment, refund) { action, note, ref, ok ->
                        paymentAct(payment, action, refund.id, note, ref, ok)
                    }
                }
            }
            Text(
                "迟到旧款 ${late.getString("publicId")} · 待退 ${historyMoney(late.getLong("remainingRefundableMinor"))} · ${cashierStatus(late.textOrNull("refundStatus") ?: "succeeded")}",
                fontSize = 12.sp,
            )
            if (
                late.textOrNull("refundStatus") == null ||
                    late.textOrNull("refundStatus") in listOf("failed", "rejected", "cancelled")
            )
                Primary("申请退回这笔迟到旧款", enabled = m.canUseActivity) {
                    act("refund", late.getString("publicId"))
                }
        }
    }
}
