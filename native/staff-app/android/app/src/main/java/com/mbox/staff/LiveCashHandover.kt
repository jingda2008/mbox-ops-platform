package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

val cashDenominations = listOf(10000L, 5000L, 2000L, 1000L, 500L, 100L, 50L, 10L, 5L, 2L, 1L)

fun cashCount(values: Map<String, Int>): Long {
    var total = 0L
    values.forEach { (k, q) ->
        val d = k.toLongOrNull()
        require(d in cashDenominations && q in 0..99999) { "面额或张数无效" }
        total += d!! * q
    }
    require(total <= 10000000000L) { "盘点金额超限" }
    return total
}

fun cashHandoverCommand(
    actor: StaffIdentity,
    board: JSONObject,
    action: String,
    amount: Long? = null,
    direction: String = "in",
    reference: String = "",
    reason: String,
    denominations: Map<String, Int> = emptyMap(),
): LiveCommand {
    val note = reason.trim()
    val manager = action in listOf("movement", "approve")
    val permission =
        if (manager) "reconciliation.manage"
        else if (actor.allows("payment.manual.cash.record")) "payment.manual.cash.record"
        else "reconciliation.manage"
    require(
        actor.allows("reconciliation.view") &&
            actor.allows(permission) &&
            board.getBoolean("canCount") &&
            (!manager || board.getBoolean("canManage")) &&
            note.length in 4..500
    ) {
        "请刷新交接权限并填写4—500字实际说明"
    }
    val row =
        board.getJSONArray("handovers").objects().firstOrNull { it.getString("status") != "closed" }
    val b = JSONObject().put("action", action).put("reason", note)
    var status = "open"
    val detail: String
    if (action == "open") {
        require(row == null && amount != null && amount in 0..10000000000L) { "已有交接或备用金金额无效" }
        b.put("amountMinor", amount)
        detail = "实点期初现金 ${historyMoney(amount!!)}"
    } else {
        require(row != null) { "请先建立门店现金交接" }
        b.put("id", row.getString("id")).put("expectedRevision", row.getInt("revision"))
        val count = row.optJSONObject("count")
        when (action) {
            "movement" -> {
                require(
                    row.getString("status") == "open" &&
                        amount != null &&
                        amount in 1..10000000000L &&
                        direction in listOf("in", "out") &&
                        reference.trim().length in 3..256
                ) {
                    "请核对实际取存款及独立凭证"
                }
                b.put("amountMinor", amount).put("direction", direction).put("reference", reference)
                detail =
                    "非营业${if(direction=="in")"存入" else "取出"} ${historyMoney(amount!!)}\n凭证 $reference"
            }
            "count" -> {
                require(row.getString("status") == "open") { "请先由原盘点人撤回再重新实点" }
                val counted = cashCount(denominations)
                b.put("denominations", JSONObject(denominations))
                status = "count_submitted"
                detail =
                    "实点 ${historyMoney(counted)} · 当前账面 ${historyMoney(row.getLong("expectedMinor"))}\n预计差异 ${historyMoney(counted-row.getLong("expectedMinor"))}，差异保留，不自动调平。"
            }
            "withdraw" -> {
                require(
                    row.getString("status") == "count_submitted" &&
                        count?.getString("employeeId") == actor.employeeId
                ) {
                    "只能由原盘点人撤回"
                }
                detail = "保留原盘点留痕，撤回后重新实点"
            }
            "approve" -> {
                val ledger = board.getJSONObject("ledger")
                require(
                    row.getString("status") == "count_submitted" &&
                        count != null &&
                        count.getString("employeeId") != actor.employeeId &&
                        amount == count.getLong("countedMinor") &&
                        count.getLong("ledgerNet") == ledger.getLong("net") &&
                        count.getLong("ledgerCount") == ledger.getLong("count")
                ) {
                    "须由另一人独立实点；收退款变化后原盘点人须撤回重盘"
                }
                b.put("reviewCountedMinor", amount)
                status = "closed"
                detail =
                    "另一人独立实点 ${historyMoney(amount!!)}\n账面 ${historyMoney(count!!.getLong("expectedMinor"))} · 差异 ${historyMoney(count.getLong("differenceMinor"))}\n确认接收并保留差异待查，不自动修改收退款。"
            }
            else -> error("未知交接操作")
        }
    }
    val id = UUID.randomUUID().toString()
    val title =
        mapOf(
                "open" to "建立现金交接",
                "movement" to "登记非营业现金取存",
                "count" to "提交现金盘点",
                "withdraw" to "撤回并重新盘点",
                "approve" to "双人确认现金交接",
            )
            .getValue(action)
    val p =
        JSONObject()
            .put("cashHandover", action)
            .put("status", status)
            .put("revision", if (action == "open") 1 else row!!.getInt("revision") + 1)
            .put("confirmation", "范围：门店全部现金合计（所有收银点）\n$detail\n$note\n盘点与交接期间暂停现金收退；新收退款会要求重新盘点。")
    row?.let { p.put("id", it.getString("id")) }
    if (action == "open") p.put("openingMinor", amount)
    return LiveCommand(
        id,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(
                "/api/commercial-ops/cash-handovers/commands",
                b.toString(),
                "idempotency-key",
                "native-cash-$id",
                p.toString(),
            )
        ),
    )
}

val LiveStep.cashHandoverProof: JSONObject?
    get() = recoveryBody?.let(::JSONObject)?.takeIf { it.opt("cashHandover") is String }

fun validateCashHandoverReply(text: String, step: LiveStep) {
    val p = step.cashHandoverProof ?: invalidResponse()
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    UUID.fromString(d.getString("id"))
    if (
        root.getJSONObject("meta").getInt("protocol") != 1 ||
            d.getString("status") != p.getString("status") ||
            d.getInt("revision") != p.getInt("revision") ||
            p.has("id") && d.getString("id") != p.getString("id") ||
            p.has("openingMinor") && d.getLong("openingMinor") != p.getLong("openingMinor")
    )
        invalidResponse()
}
