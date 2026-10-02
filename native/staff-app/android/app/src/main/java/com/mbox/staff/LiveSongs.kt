package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

class LiveSong(val source: JSONObject) {
    val id = source.getString("id")
    val session = source.getString("tableSessionId")
    val title = source.getString("songTitle")
    val status = source.getString("status")
    val amount: Long? = if (source.isNull("quotedAmountMinor")) null else source.getLong("quotedAmountMinor")
    val currency = source.optString("currency", "")
    val statusLabel get() = SongCommands.statuses[status] ?: "状态待核对"
    fun actions(actor: StaffIdentity): List<String> = buildList {
        if (actor.allows("song.manage")) {
            if (status in listOf("requested", "confirming")) addAll(listOf("confirm", "reject"))
            if (status in listOf("requested", "confirming", "accepted")) add("cancel")
            if (status == "paid" || status == "accepted" && amount == 0L) add("performed")
        }
        if (status == "accepted" && amount != null && amount > 0 && currency == "CNY" && actor.allows("song.payment.record")) add("paid")
    }
}
object SongCommands {
    val statuses = linkedMapOf("requested" to "待受理", "confirming" to "待确认", "accepted" to "已报价", "paid" to "已收款", "performed" to "已演唱", "rejected" to "已拒绝", "cancelled" to "已取消")
    val labels = mapOf("confirm" to "确认报价", "reject" to "拒绝点歌", "paid" to "关联已收付款", "performed" to "确认已演唱", "cancel" to "取消点歌")
    fun command(row: LiveSong, actor: StaffIdentity, action: String, reason: String, amountText: String = "", evidence: JSONObject? = null): LiveCommand {
        require(action in row.actions(actor)) { "点歌状态或岗位权限已变化，请刷新" }
        require(reason.trim().length in 2..500) { "请填写2至500字处理说明" }
        val body = JSONObject().put("expectedStatus", row.status).put("reason", reason.trim())
        val target = mapOf("confirm" to "accepted", "reject" to "rejected", "paid" to "paid", "performed" to "performed", "cancel" to "cancelled").getValue(action)
        var amount = row.amount
        if (action == "confirm") {
            amount = nativeNonnegativeMoney(amountText)?.toLong() ?: error("请填写有效报价，免费填写0")
            body.put("quotedAmountMinor", amount).put("currency", "CNY")
        }
        if (action == "paid") {
            require(evidence != null && evidence.getLong("amountMinor") == row.amount && evidence.getString("currency") == row.currency) { "请重新读取并选择原付款凭证" }
            body.put("paymentId", UUID.fromString(evidence.getString("paymentId")).toString())
                .put("reconciliationEntryId", UUID.fromString(evidence.getString("reconciliationEntryId")).toString())
        }
        val confirmation = "${row.title}\n${row.statusLabel} → ${statuses[target]}\n" +
            (amount?.let { "报价 ${historyMoney(it)}\n" } ?: "") +
            (evidence?.let { "付款 ${it.getString("publicId")}\n" } ?: "") +
            "说明：${reason.trim()}\n" + when (action) {
                "paid" -> "仅关联已经收妥的原付款和对账凭证，本次不会再次扣款。"
                "performed" -> "请在实际演唱完成后确认。"
                "cancel" -> "仅取消点歌，不自动退款。已收款点歌不能在此取消。"
                "confirm" -> "确认报价不会收款；付费点歌需要核对原付款后才能确认演唱。"
                else -> "请核对已向客人说明。"
            }
        val proof = JSONObject().put("id", row.id).put("tableSessionId", row.session).put("status", target)
            .put("previousStatus", row.status).put("action", action).put("reason", reason.trim())
            .put("quotedAmountMinor", amount ?: JSONObject.NULL).put("currency", if(action == "confirm") "CNY" else row.source.opt("currency"))
            .put("paymentId", body.opt("paymentId") ?: JSONObject.NULL).put("reconciliationEntryId", body.opt("reconciliationEntryId") ?: JSONObject.NULL)
            .put("confirmation", confirmation)
        val id = UUID.randomUUID().toString()
        return LiveCommand(id, actor.employeeId, labels.getValue(action), if(action == "paid") "song.payment.record" else "song.manage",
            listOf(LiveStep("/api/staff/native-song-requests/${LiveCommand.part(row.id)}/$action", body.toString(), "idempotency-key", "native-business-$id", recoveryBody = JSONObject().put("song", proof).toString())))
    }
}
val LiveStep.songProof: JSONObject? get() = recoveryBody?.let { runCatching { JSONObject(it).optJSONObject("song") }.getOrNull() }
fun validateSongReply(text: String, step: LiveStep) {
    val root = JSONObject(text); require(root.getJSONObject("meta").get("replayed") is Boolean)
    val data = root.getJSONObject("data"); val row = data.getJSONObject("request"); val proof = step.songProof!!
    for (key in listOf("id", "tableSessionId", "status")) require(row.getString(key) == proof.getString(key)) { "点歌回执不匹配，请保留原请求核对" }
    for (key in listOf("quotedAmountMinor", "currency")) require(row.opt(key)?.toString() == proof.opt(key)?.toString()) { "点歌金额回执不匹配" }
    for (key in listOf("previousStatus", "action", "reason", "paymentId", "reconciliationEntryId")) require(data.opt(key)?.toString() == proof.opt(key)?.toString()) { "点歌原操作回执不匹配" }
}
