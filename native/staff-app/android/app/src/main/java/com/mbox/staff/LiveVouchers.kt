package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

fun voucherRedeem(
    actor: StaffIdentity,
    preview: JSONObject,
    platform: JSONObject,
    code: String,
    orderID: String? = null,
    sessionID: String? = null,
    confirmed: Boolean = false,
): LiveCommand {
    require(
        actor.allows("commercial.voucher.redeem") &&
            platform.optBoolean("enabled") &&
            platform.getString("mode") == "production" &&
            platform.getString("code") == preview.getString("platform") &&
            confirmed &&
            code.length in 4..256 &&
            preview.getString("currency") == "CNY" &&
            preview.getLong("faceValueMinor") >= 0 &&
            preview.getLong("settlementAmountMinor") >= 0 &&
            preview.getInt("quantity") > 0 &&
            (orderID == null) == (sessionID == null)
    ) {
        "请核对正式平台、原券、原订单桌次及实际核销确认"
    }
    val id = UUID.randomUUID().toString()
    val body =
        JSONObject()
            .put("publicId", "APP-VOUCHER-$id")
            .put("platform", preview.getString("platform"))
            .put("voucherCode", code)
            .put("prepareHandle", preview.getString("prepareHandle"))
    if (orderID != null) body.put("orderId", orderID).put("tableSessionId", sessionID)
    val p =
        JSONObject()
            .put("voucher", "redeem")
            .put("voucherSecretKey", "voucher-$id")
            .put("platform", preview.getString("platform"))
            .put("publicId", "APP-VOUCHER-$id")
            .put("actorId", actor.employeeId)
            .put(
                "confirmation",
                "${preview.getString("platformLabel")} · ${preview.getString("campaignName")}\n券码 ${preview.getString("voucherCodeMasked")} · ${preview.getInt("quantity")}份\n面额 ${historyMoney(preview.getLong("faceValueMinor"))} · 平台结算额 ${historyMoney(preview.getLong("settlementAmountMinor"))}\n${orderID?.let {"关联原订单 $it"} ?: "不关联桌单"}\n确认平台消费券；登记核销不等于收到平台结算款，也不自动抵减桌单应收。未知结果不再次核销。",
            )
    return voucherCommand(
        actor,
        id,
        "commercial.voucher.redeem",
        "确认原券核销",
        "/api/commercial-ops/vouchers/operations/redeem",
        body,
        p,
    )
}

fun voucherFollowup(
    actor: StaffIdentity,
    row: JSONObject,
    action: String,
    outcome: String = "consumed",
    certificate: String = "",
    verify: String = "",
    evidence: String = "",
    reason: String = "",
    confirmed: Boolean = false,
): LiveCommand {
    require(actor.allows("commercial.voucher.redeem")) { "当前岗位无核销恢复权限" }
    val permission =
        if (action in listOf("approve", "reject")) "reconciliation.manage"
        else "commercial.voucher.redeem"
    val body = JSONObject()
    val review = row.optJSONObject("review")
    when (action) {
        "recover" ->
            require(row.getString("status") !in listOf("recorded", "not_consumed")) {
                "该事项已有终态，请刷新核对"
            }
        "review" -> {
            require(
                row.getString("status") in listOf("dispatching", "unknown") &&
                    review == null &&
                    outcome in listOf("consumed", "not_consumed") &&
                    confirmed &&
                    reason.trim().length in 4..500 &&
                    evidence.trim().length in 4..500 &&
                    certificate.length <= 256 &&
                    verify.length <= 256 &&
                    (outcome != "consumed" || certificate.isNotBlank() && verify.isNotBlank())
            ) {
                "请按平台原凭证提供核销结果、查询依据及实际原因，不能猜测结果"
            }
            body
                .put("outcome", outcome)
                .put("certificateId", certificate)
                .put("verifyId", verify)
                .put("evidenceReference", evidence)
                .put("reason", reason)
        }
        "approve",
        "reject" ->
            require(
                review != null &&
                    review.getString("employeeId") != actor.employeeId &&
                    review.textOrNull("approvedBy") == null &&
                    confirmed &&
                    actor.allows(permission) &&
                    row.getString("status") in listOf("dispatching", "unknown")
            ) {
                "必须由另一名财务复核人员独立核对平台凭证"
            }
        else -> error("不支持的核销操作")
    }
    if (action in listOf("approve", "reject")) {
        body.put("reviewId", review!!.getString("id"))
        if (action == "reject") {
            require(reason.trim().length in 4..500) { "请填写实际驳回原因" }
            body.put("reason", reason)
        }
    }
    val id = UUID.randomUUID().toString()
    val title =
        mapOf(
                "recover" to "恢复原核销记录",
                "review" to "提交平台凭证待另一人复核",
                "approve" to "确认已独立核对平台结果",
                "reject" to "驳回原证据并重新核对",
            )
            .getValue(action)
    val fact = review ?: body
    val detail =
        if (action == "recover") "只恢复持久化原记录，不再次消耗券。"
        else
            "${if(fact.getString("outcome")=="consumed") "平台已核销" else "已证实未核销"}\n证书 ${fact.getString("certificateId")}\n核销号 ${fact.getString("verifyId")}\n依据 ${fact.getString("evidenceReference")}\n${fact.getString("reason") }"
    val p =
        JSONObject()
            .put("voucher", action)
            .put("operationId", row.getString("id"))
            .put("platform", row.getString("platform"))
            .put("publicId", row.getString("publicId"))
            .put(
                "confirmation",
                "${row.getString("campaignName")} · ${row.getString("voucherCodeMasked")}\n$title\n$detail\n${if(action=="reject")"驳回原因：$reason" else ""}\n人工双人复核会单独留痕，不作为支付平台自动回执或平台结算到账。",
            )
    return voucherCommand(
        actor,
        id,
        permission,
        title,
        "/api/commercial-ops/vouchers/operations/${LiveCommand.part(row.getString("id"))}/$action",
        body,
        p,
    )
}

private fun voucherCommand(
    actor: StaffIdentity,
    id: String,
    permission: String,
    title: String,
    path: String,
    body: JSONObject,
    p: JSONObject,
) =
    LiveCommand(
        id,
        actor.employeeId,
        title,
        permission,
        listOf(
            LiveStep(path, body.toString(), "idempotency-key", "native-voucher-$id", p.toString())
        ),
    )

val LiveStep.voucherProof: JSONObject?
    get() = recoveryBody?.let(::JSONObject)?.takeIf { it.opt("voucher") is String }

fun secureVoucherCommand(command: LiveCommand, store: (String, String) -> Unit): LiveCommand {
    val step = command.steps.firstOrNull() ?: return command
    val p = step.voucherProof ?: return command
    if (p.getString("voucher") != "redeem") return command
    val body = JSONObject(step.body)
    val secret =
        JSONObject()
            .put("voucherCode", body.getString("voucherCode"))
            .put("prepareHandle", body.getString("prepareHandle"))
    store(p.getString("voucherSecretKey"), secret.toString())
    body.remove("voucherCode")
    body.remove("prepareHandle")
    return command.copy(steps = listOf(step.copy(body = body.toString())))
}

fun voucherRequestBody(step: LiveStep, secret: (String) -> String): JSONObject {
    val body = JSONObject(step.body)
    step.voucherProof?.textOrNull("voucherSecretKey")?.let { key ->
        val s = JSONObject(secret(key))
        body
            .put("voucherCode", s.getString("voucherCode"))
            .put("prepareHandle", s.getString("prepareHandle"))
    }
    return body
}

fun validateVoucherReply(text: String, step: LiveStep) {
    val p = step.voucherProof ?: invalidResponse()
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    if (
        root.getJSONObject("meta").getInt("protocol") != 1 ||
            d.getString("id").isBlank() ||
            d.getString("platform") != p.getString("platform") ||
            d.getString("publicId") != p.getString("publicId") ||
            d.getString("currency") != "CNY" ||
            d.getString("status") !in
                listOf("dispatching", "unknown", "provider_succeeded", "recorded", "not_consumed")
    )
        invalidResponse()
    if (p.getString("voucher") == "redeem") {
        if (d.getString("actorEmployeeId") != p.getString("actorId")) invalidResponse()
    } else if (d.getString("id") != p.getString("operationId")) invalidResponse()
    if (d.getString("status") == "recorded") {
        val r = d.getJSONObject("result")
        if (
            r.getString("publicId") != p.getString("publicId") ||
                r.getString("currency") != "CNY" ||
                r.getBoolean("isSettled")
        )
            invalidResponse()
    }
}

suspend fun performVoucherStep(
    step: LiveStep,
    read: suspend (String) -> String,
    send: suspend (JSONObject) -> String,
    secret: (String) -> String,
) {
    val p = step.voucherProof
    if (p?.getString("voucher") == "redeem") {
        val text =
            read(
                "/api/commercial-ops/vouchers/operations/by-public-id/" +
                    LiveCommand.part(p.getString("publicId"))
            )
        val root = JSONObject(text)
        if (root.getJSONObject("meta").getInt("protocol") != 1 || !root.has("data"))
            invalidResponse()
        if (!root.isNull("data")) {
            validateVoucherReply(text, step)
            return
        }
    }
    validateVoucherReply(send(voucherRequestBody(step, secret)), step)
}
