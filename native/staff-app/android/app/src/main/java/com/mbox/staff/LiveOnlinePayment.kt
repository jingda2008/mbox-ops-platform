package com.mbox.staff

import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

val LiveStep.onlineProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.opt("online") is String }

fun onlinePayment(
    actor: StaffIdentity,
    access: JSONObject,
    orders: List<LivePaymentOrder>,
    session: String,
    amount: Int,
    method: String,
    code: String = "",
): LiveCommand {
    val value = code.trim()
    require(
        actor.allows("payment.initiate.staff") &&
            access.getString("employeeId") == actor.employeeId &&
            access.getBoolean("canInitiatePayment") &&
            access.textOrNull("onlinePaymentProvider") == "postar" &&
            session.isNotBlank() &&
            orders.isNotEmpty() &&
            orders.size <= 50 &&
            orders.map { it.id }.distinct().size == orders.size &&
            orders.all { it.selectable } &&
            amount > 0 &&
            amount.toLong() <= orders.sumOf { it.amount.toLong() } &&
            method in listOf("native_qr", "auth_code") &&
            (method != "auth_code" || Regex("^[0-9]{16,32}$").matches(value))
    ) {
        "请核对线上支付开关、岗位、原单应收和付款码；原款未知不能重复收款"
    }
    val id = UUID.randomUUID().toString()
    val body =
        JSONObject()
            .put("orderId", orders[0].id)
            .put("orderIds", JSONArray(orders.map { it.id }))
            .put("amountMinor", amount)
            .put("publicId", "APP-ONLINE-$id")
            .put("provider", "postar")
            .put("method", method)
    val proof =
        JSONObject()
            .put("online", "init")
            .put("employeeId", actor.employeeId)
            .put("tableSessionId", session)
            .put(
                "confirmation",
                "本次收款 ${money(amount)}\n原订单：${orders.joinToString("、") { it.publicId }}\n${if (method == "auth_code") "扫描付款码将请求扣款，请确认顾客同意。" else "展示本单付款二维码，由顾客付款。"}\n只有服务器确认到账才算收款，超时不能换号重收。",
            )
    if (method == "auth_code") {
        body.put("customerAuthCode", value)
        proof.put("authCodeKey", id)
    }
    return LiveCommand(
        id,
        actor.employeeId,
        "线上收款 " + money(amount),
        "payment.initiate.staff",
        listOf(
            LiveStep(
                "/api/payments",
                body.toString(),
                "idempotency-key",
                "native-online-$id",
                proof.toString(),
            )
        ),
    )
}

fun onlineRelease(
    actor: StaffIdentity,
    orders: List<LivePaymentOrder>,
    paymentID: String,
    session: String,
    reason: String,
): LiveCommand {
    val note = reason.trim()
    require(
        actor.allows("payment.initiate.staff") &&
            orders.any { it.pendingId == paymentID } &&
            note.length in 4..500
    ) {
        "请刷新原付款并填写4—500字重收原因"
    }
    val id = UUID.randomUUID().toString()
    val proof =
        JSONObject()
            .put("online", "release")
            .put("tableSessionId", session)
            .put("paymentId", paymentID)
            .put(
                "confirmation",
                "原付款仍可能后到。本操作只允许另行收款，不代表旧款失败或通道已关闭。请确认顾客知晓可能重复付款；后到款需要财务核对退款。\n原因：$note",
            )
    return LiveCommand(
        id,
        actor.employeeId,
        "保留旧款待核对，允许重收",
        "payment.initiate.staff",
        listOf(
            LiveStep(
                "/api/payments/${LiveCommand.part(paymentID)}/retry-release",
                JSONObject().put("reason", note).toString(),
                "idempotency-key",
                "native-release-$id",
                proof.toString(),
            )
        ),
    )
}

fun secureOnlineCommand(command: LiveCommand, store: (String, String) -> Unit): LiveCommand =
    command.copy(
        steps =
            command.steps.map { step ->
                val key = step.onlineProof?.textOrNull("authCodeKey")
                val body = JSONObject(step.body)
                val code = body.textOrNull("customerAuthCode")
                if (key != null && code != null) {
                    store(key, code)
                    body.remove("customerAuthCode")
                    step.copy(body = body.toString())
                } else step
            }
    )

fun onlineRequestBody(step: LiveStep, secret: (String) -> String): JSONObject =
    JSONObject(step.body).also { body ->
        step.onlineProof?.textOrNull("authCodeKey")?.let {
            body.put("customerAuthCode", secret(it))
        }
    }

fun validateOnlineReply(text: String, step: LiveStep) {
    val proof = step.onlineProof ?: invalidResponse()
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    val body = JSONObject(step.body)
    val id = data.getString("id")
    val publicID = data.getString("publicId")
    if (
        root.getJSONObject("meta").get("replayed") !is Boolean ||
            id.isBlank() ||
            publicID.isBlank() ||
            data.getString("status") !in
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
    if (proof.getString("online") == "release") {
        if (
            id != proof.getString("paymentId") ||
                step.path != "/api/payments/${LiveCommand.part(id)}/retry-release" ||
                data.getString("retryReleaseReason") != body.getString("reason") ||
                assignmentDate(data.getString("retryReleasedAt")) == null
        )
            invalidResponse()
        return
    }
    val action = data.getJSONObject("providerAction")
    if (
        proof.getString("online") != "init" ||
            step.path != "/api/payments" ||
            (publicID != body.getString("publicId") &&
                !validOnlineBinding(root, step, id, publicID)) ||
            data.getString("currency") != "CNY" ||
            data.getString("provider") != "postar" ||
            data.getString("method") != body.getString("method") ||
            (data.get("amountMinor") !is Int && data.get("amountMinor") !is Long) ||
            data.getLong("amountMinor") != body.getLong("amountMinor") ||
            action.getString("paymentId") != id ||
            action.getString("paymentPublicId") != publicID ||
            action.getString("status") !in listOf("pending", "unknown", "failed", "resolved") ||
            action.getString("presentation") !=
                (if (body.getString("method") == "native_qr") "qr" else "barcode") ||
            assignmentDate(action.getString("expiresAt")) == null
    )
        invalidResponse()
}

fun onlineQR(receipt: JSONObject, status: String, now: Instant = Instant.now()): String? {
    if (receipt.getString("kind") != "init" || status != "pending") return null
    val action =
        receipt.getJSONObject("response").getJSONObject("data").optJSONObject("providerAction")
            ?: return null
    if (
        action.getString("status") != "pending" ||
            action.getString("presentation") != "qr" ||
            assignmentDate(action.getString("expiresAt"))?.isAfter(now) != true
    )
        return null
    return action.optJSONObject("payload")?.textOrNull("qrCodeUrl")?.takeIf {
        it.isNotEmpty() && it.toByteArray().size <= 4096
    }
}

private fun validOnlineBinding(
    root: JSONObject,
    step: LiveStep,
    id: String,
    publicID: String,
): Boolean {
    val b = root.optJSONObject("meta")?.optJSONObject("requestBinding") ?: return false
    val body = JSONObject(step.body)
    val actor = step.onlineProof?.textOrNull("employeeId") ?: return false
    val orders = b.optJSONArray("orderIds") ?: return false
    val expected = body.optJSONArray("orderIds") ?: return false
    return b.optInt("protocol") == 1 &&
        b.optString("idempotencyKey") == step.key &&
        b.optString("requestedPublicId") == body.optString("publicId") &&
        b.optString("paymentId") == id &&
        b.optString("paymentPublicId") == publicID &&
        b.optLong("amountMinor", -1) == body.optLong("amountMinor", -2) &&
        b.optString("provider") == body.optString("provider") &&
        b.optString("method") == body.optString("method") &&
        b.optString("employeeId") == actor &&
        orders.length() == expected.length() &&
        (0 until orders.length()).map { orders.getString(it) }.toSet() ==
            (0 until expected.length()).map { expected.getString(it) }.toSet()
}
