package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class MemberVisitStatus(val source: JSONObject) {
    val memberNo = source.getString("memberNo")
    val date = source.getString("businessDate")
    val visit = source.optJSONObject("visit")
    val enabled = source.optBoolean("durableNativeVisits")

    fun command(cancel: Boolean, reason: String, actor: StaffIdentity): LiveCommand {
        val reason = reason.trim()
        require(
            enabled &&
                source.getBoolean("canCheckIn") &&
                actor.allows("loyalty.account.view") &&
                actor.allows("customer.relationship.manage") &&
                if (cancel) visit?.getString("status") == "checked_in" && reason.length in 2..300
                else visit?.getString("status") != "checked_in"
        ) {
            "请重新读取会员签到状态并核对权限；撤销须填写原因"
        }
        val body = JSONObject().put("code", memberNo).put("businessDate", date)
        if (cancel) {
            body.put("visitId", visit!!.getString("id")).put("reason", reason)
        }
        return MemberCommands.make(
            actor,
            if (cancel) "撤销到店签到" else "确认到店签到",
            "customer.relationship.manage",
            "/api/staff/native-member-visits/" + if (cancel) "cancel" else "check-in",
            body,
            JSONObject()
                .put("kind", "visit")
                .put("memberNo", memberNo)
                .put("businessDate", date)
                .put("status", if (cancel) "cancelled" else "checked_in")
                .put("visitId", if (cancel) visit!!.getString("id") else "")
                .put(
                    "confirmation",
                    "会员 $memberNo · 营业日 $date\n" +
                        if (cancel) "撤销原签到，不自动撤销已经领取的奖励。\n" + reason
                        else "已当面核对会员本人到店。签到奖励须单独审批，实物领取另行核销。",
                ),
        )
    }
}

class MemberRewardBoard(val source: JSONObject) {
    val rows = source.getJSONArray("items").objects()
    val enabled = source.optBoolean("durableNativeDecisions")
    val next = source.textOrNull("nextCursor")

    fun command(
        ids: Set<String>,
        approve: Boolean,
        reason: String,
        actor: StaffIdentity,
    ): LiveCommand {
        val reason = reason.trim()
        val selected = rows.filter { it.getString("id") in ids }
        require(
            enabled &&
                actor.allows("loyalty.configuration.approve") &&
                ids.size in 1..50 &&
                selected.size == ids.size &&
                reason.length in 2..300 &&
                selected.all {
                    it.getString("status") == "pending" &&
                        (!approve || it.getInt("cancelled_sources") == 0)
                }
        ) {
            "请选择1—50条有效待审批记录并填写原因；签到撤销记录需先核对"
        }
        return MemberCommands.make(
            actor,
            if (approve) "审批签到奖励" else "驳回签到奖励",
            "loyalty.configuration.approve",
            "/api/staff/native-member-visit-rewards",
            JSONObject()
                .put("action", if (approve) "approve" else "reject")
                .put("ids", JSONArray(ids.sorted()))
                .put("reason", reason),
            JSONObject()
                .put("kind", "reward")
                .put("ids", JSONArray(ids.sorted()))
                .put("status", if (approve) "issued" else "rejected")
                .put(
                    "confirmation",
                    selected.joinToString("\n") {
                        "${it.getString("member_no")} · ${it.getString("name")} · ${it.getInt("quantity")}份"
                    } +
                        "\n" +
                        reason +
                        "\n" +
                        if (approve) "发放的是权益券；实物领取仍需单独核销。" else "本轮签到按原规则记为已处理；不能重复用本轮次数领取。",
                ),
        )
    }
}

object MemberCommands {
    fun code(raw: String): String {
        val value =
            raw.trim().replace(Regex("^MBOX_MEMBER_V1:", RegexOption.IGNORE_CASE), "").trim()
        require(
            value.isNotEmpty() &&
                value.length <= 128 &&
                value.none { it.isWhitespace() || it in ":/?#" }
        ) {
            "请扫描会员码或输入完整会员号；不能使用付款码或点心核销链接"
        }
        return value
    }

    fun make(
        actor: StaffIdentity,
        title: String,
        permission: String,
        path: String,
        body: JSONObject,
        proof: JSONObject,
    ): LiveCommand {
        val id = UUID.randomUUID().toString()
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
                    "native-business-$id",
                    JSONObject().put("member", proof).toString(),
                )
            ),
        )
    }
}

val LiveStep.memberProof: JSONObject?
    get() = recoveryBody?.let { runCatching { JSONObject(it).optJSONObject("member") }.getOrNull() }

fun validateMemberReply(text: String, step: LiveStep) {
    val root = JSONObject(text)
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    val data = root.getJSONObject("data")
    val p = step.memberProof!!
    when (p.getString("kind")) {
        "visit" -> {
            require(
                data.getString("id").isNotBlank() &&
                    data.getString("memberNo") == p.getString("memberNo") &&
                    data.getString("businessDate") == p.getString("businessDate") &&
                    data.getString("status") == p.getString("status") &&
                    assignmentDate(data.getString("checkedInAt")) != null &&
                    (p.getString("visitId").isEmpty() ||
                        data.getString("id") == p.getString("visitId"))
            )
        }
        "benefit" -> {
            require(data.getString("id").isNotBlank())
            for (key in listOf("benefitId", "customerId", "tableSessionId")) require(
                data.getString(key) == p.getString(key)
            )
            require(
                data.get("quantity") is Number &&
                    data.getDouble("quantity") == p.getDouble("quantity")
            )
            if (p.getString("action") == "cancel") {
                require(
                    data.getString("id") == p.getString("reservationId") &&
                        data.getString("status") == "cancelled" &&
                        data.getString("cancelReason") == JSONObject(step.body).getString("reason")
                )
            } else {
                require(
                    p.getString("action") == "redeem" &&
                        data.getString("benefitReservationId") == p.getString("reservationId") &&
                        data.getString("giftOrderReference").isNotBlank() &&
                        assignmentDate(data.getString("redeemedAt")) != null &&
                        data.getJSONObject("authorizationSource").getString("employeeId") ==
                            p.getString("employeeId")
                )
            }
        }
        "reward" -> {
            val items = data.getJSONArray("items").objects()
            val ids =
                p.getJSONArray("ids").let { a -> (0 until a.length()).map { a.getString(it) } }
            require(
                items.size == ids.size &&
                    items.map { it.getString("id") }.toSet() == ids.toSet() &&
                    items.all { it.getString("status") == p.getString("status") }
            )
        }
        else -> error("原会员操作回执不一致")
    }
}

class BenefitFulfillmentBoard(val source: JSONObject) {
    val enabled = source.getBoolean("durable")
    val date = source.getString("businessDate")
    val snacksEnabled = source.getBoolean("snacksEnabled")

    class Row(val raw: JSONObject, val kind: String) {
        val id = raw.getString(if (kind == "annual") "reservationId" else "id")
        val reservationId =
            raw.optString(if (kind == "annual") "reservationId" else "benefitReservationId", "")
        val benefitId = raw.optString("benefitId", "")
        val customerId = raw.optString("customerId", "")
        val session = raw.optString("tableSessionId", "")
        val table = raw.optString("tableCode", "桌号待核对")
        val member = raw.optString("memberNo", "会员号未提供")
        val title = raw.getString("title")
        val quantity = raw.getInt("quantity")
        val status = if (kind == "annual") "reserved" else raw.getString("status")
        val expires = raw.optString("expiresAt", "")
        val products = raw.optJSONArray("allowedProducts")?.objects() ?: emptyList()
        val original = raw.optString("originalProductId", "")
        val fulfillment = raw.optString("currentFulfillmentStatus", "")
        val available
            get() =
                status == "reserved" &&
                    (assignmentDate(expires)?.isAfter(java.time.Instant.now()) == true)
    }

    val rows =
        source.getJSONArray("gifts").objects().map { Row(it, "annual") } +
            source.getJSONArray("snacks").objects().map { Row(it, "snack") }

    fun command(
        rowID: String,
        cancel: Boolean,
        product: String,
        rawReason: String,
        actor: StaffIdentity,
    ): LiveCommand {
        val reason = rawReason.trim()
        val row = rows.find { it.id == rowID }
        require(
            enabled &&
                actor.allows("loyalty.redemption.fulfill") &&
                row != null &&
                row.status == "reserved" &&
                ((cancel && row.kind == "snack") || row.available) &&
                row.quantity in 1..100 &&
                listOf(row.reservationId, row.benefitId, row.customerId, row.session).all {
                    runCatching { UUID.fromString(it).toString() == it.lowercase() }
                        .getOrDefault(false)
                } &&
                (!cancel || reason.length in 2..256)
        ) {
            "原暂留已变化，请刷新并核对权限、会员和取消原因"
        }
        val body =
            JSONObject()
                .put("kind", row.kind)
                .put("benefitId", row.benefitId)
                .put("customerId", row.customerId)
                .put("tableSessionId", row.session)
                .put("quantity", row.quantity)
        var productName = "原点心商品"
        if (row.kind == "snack") body.put("claimCode", row.raw.getString("claimCode"))
        if (cancel) body.put("reason", reason)
        else if (row.kind == "annual") {
            val chosen = row.products.find { it.getString("productId") == product }
            require(chosen != null && (product == row.original || reason.length in 2..240)) {
                "请选择允许的商品；替换原商品需填写2—240字原因"
            }
            body.put("selectedProductId", product)
            productName = chosen.getString("name")
            if (product != row.original) body.put("substitutionReason", reason)
        }
        val action = if (cancel) "cancel" else "redeem"
        return MemberCommands.make(
            actor,
            if (cancel) "取消权益暂留" else "确认权益兑付",
            "loyalty.redemption.fulfill",
            "/api/staff/native-benefit-reservations/${row.reservationId}/$action",
            body,
            JSONObject()
                .put("kind", "benefit")
                .put("action", action)
                .put("employeeId", actor.employeeId)
                .put("reservationId", row.reservationId)
                .put("benefitId", row.benefitId)
                .put("customerId", row.customerId)
                .put("tableSessionId", row.session)
                .put("quantity", row.quantity)
                .put(
                    "confirmation",
                    "${row.table} · ${row.member}\n${row.title} · ${row.quantity}份\n" +
                        if (cancel) "$reason\n只取消未核销暂留；不撤销已经核销的赠品，不退款。"
                        else
                            productName +
                                (if (reason.isBlank()) "" else "\n$reason") +
                                "\n核销后进入出品流程。制作与送达须在出品、取送工作台分别完成。",
                ),
        )
    }
}

fun benefitStatusLabel(value: String) =
    mapOf(
        "reserved" to "待核销",
        "redeemed" to "已核销 · 待履约",
        "fulfilled" to "历史已履约",
        "cancelled" to "已取消暂留",
        "expired" to "暂留已过期",
        "pending" to "待制作",
        "ready" to "待取送",
        "delivered" to "当前已送达",
        "cancelled_after_redemption" to "核销后已取消",
        "compensated" to "已补偿",
    )[value] ?: "状态待核对"
