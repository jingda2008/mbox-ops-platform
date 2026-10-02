package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

val observationExpressions =
    mapOf(
        "objective_fact" to "客观事实",
        "customer_quote" to "客人原话",
        "staff_judgement" to "员工判断",
        "system_inference" to "系统推测",
    )
val observationTypes =
    mapOf(
        "remaining" to "剩余情况",
        "consumed_little" to "食用较少",
        "praise" to "表扬",
        "complaint" to "投诉",
        "too_sweet" to "太甜",
        "too_cold" to "太冷",
        "served_late" to "上菜较晚",
        "presentation" to "呈现问题",
        "portion" to "份量问题",
        "other" to "其他",
    )
val observationDegrees =
    mapOf(
        "little" to "少量",
        "half" to "约一半",
        "most" to "大部分",
        "almost_untouched" to "几乎未动",
        "unknown" to "不确定",
    )
val recommendationReasons =
    mapOf(
        "customer_request" to "客人要求",
        "availability_substitution" to "库存替代",
        "service_recovery" to "服务补救",
        "staff_judgement" to "员工判断",
    )

class ObservationBoard(val source: JSONObject) {
    val session = source.getString("tableSessionId")
    val enabled = source.getBoolean("durable")
    val draft = source.optJSONObject("draft")
    val history = source.getJSONObject("history")
    val items = history.getJSONArray("items").objects()

    fun parse(raw: String, immediate: Boolean, actor: StaffIdentity, inputKind: String = "text"): LiveCommand {
        require(inputKind in setOf("text", "voice_transcript")) { "无效的记录来源" }
        val raw = raw.trim()
        require(enabled && actor.allows("observation.record") && raw.length in 2..2000) {
            "请填写2—2000字现场事实，并核对记录权限"
        }
        return ObservationCommands.make(
            actor,
            "识别桌台观察",
            "observation.record",
            "/api/staff/native-table-sessions/" + LiveCommand.part(session) + "/observations/parse",
            JSONObject()
                .put("rawContent", raw)
                .put("inputKind", inputKind)
                .put("needsImmediateAction", immediate),
            JSONObject()
                .put("kind", "parse")
                .put("tableSessionId", session)
                .put(
                    "confirmation",
                    raw + "\n" + if (immediate) "核对确认后会生成现场服务任务。" else "识别结果仍需逐项核对后确认。",
                ),
        )
    }

    fun confirm(
        candidate: String,
        expression: String,
        type: String,
        degree: String,
        excerpt: String,
        actor: StaffIdentity,
    ): LiveCommand {
        require(
            enabled && actor.allows("observation.confirm") && draft?.getString("status") == "draft"
        ) {
            "原草稿已变化或无确认权限，请刷新"
        }
        val draft = draft!!
        val selected =
            draft.getJSONArray("candidates").objects().find { it.getString("id") == candidate }
        require(candidate.isEmpty() || selected != null)
        val event =
            ObservationCommands.event(
                expression,
                type,
                degree,
                excerpt,
                if (selected == null) "table" else "product",
                selected?.getString("id"),
                selected?.getString("productId"),
                selected?.getDouble("confidence") ?: minOf(draft.getDouble("parseConfidence"), 0.5),
            )
        return ObservationCommands.make(
            actor,
            "确认桌台观察",
            "observation.confirm",
            "/api/staff/native-observations/" +
                LiveCommand.part(draft.getString("publicId")) +
                "/confirm",
            JSONObject().put("events", JSONArray().put(event)),
            JSONObject()
                .put("kind", "confirm")
                .put("tableSessionId", session)
                .put("publicId", draft.getString("publicId"))
                .put("immediate", draft.getBoolean("needsImmediateAction"))
                .put(
                    "confirmation",
                    excerpt +
                        "\n" +
                        observationExpressions[expression] +
                        " · " +
                        observationTypes[type] +
                        "\n" +
                        (selected?.getString("productName") ?: "不关联具体商品") +
                        "\n确认后保留原记录；资金和赠送须另行处理。",
                ),
        )
    }

    fun revise(
        publicId: String,
        eventID: String,
        expression: String,
        type: String,
        degree: String,
        reason: String,
        actor: StaffIdentity,
    ): LiveCommand {
        val reason = reason.trim()
        require(
            enabled &&
                history.getJSONObject("permissions").getBoolean("canCorrect") &&
                history.getJSONObject("permissions").getBoolean("canViewRaw") &&
                actor.allows("observation.correct") &&
                reason.length in 2..500
        ) {
            "请核对原观察、原文权限和修订原因"
        }
        val row = items.find { it.getString("publicId") == publicId } ?: error("原记录不存在")
        val old =
            row.getJSONArray("events").objects().find { it.getString("id") == eventID }
                ?: error("原事件不存在")
        val excerpt = old.textOrNull("rawExcerpt") ?: error("没有原文查看权限")
        val event =
            ObservationCommands.event(
                expression,
                type,
                degree,
                excerpt,
                old.getString("scopeKind"),
                old.textOrNull("selectedCandidateId"),
                old.textOrNull("productId"),
                old.getDouble("confidence"),
            )
        for (key in listOf("reasonCode", "seatLabel", "customerId")) event.put(
            key,
            old.opt(key) ?: JSONObject.NULL,
        )
        return ObservationCommands.make(
            actor,
            "修订桌台观察",
            "observation.correct",
            "/api/staff/native-observations/" +
                LiveCommand.part(publicId) +
                "/events/" +
                LiveCommand.part(eventID) +
                "/revise",
            JSONObject().put("reason", reason).put("replacement", event),
            JSONObject()
                .put("kind", "revise")
                .put("tableSessionId", session)
                .put("publicId", publicId)
                .put("eventId", eventID)
                .put("eventGroupId", old.getString("eventGroupId"))
                .put("revision", old.getInt("revision") + 1)
                .put(
                    "confirmation",
                    excerpt +
                        "\n修订为：" +
                        observationExpressions[expression] +
                        " · " +
                        observationTypes[type] +
                        "\n" +
                        reason +
                        "\n追加修订，保留原记录及商品关联。",
                ),
        )
    }
}

class RecommendationBoard(val source: JSONObject) {
    val enabled = source.getBoolean("durable")
    val session = source.getString("tableSessionId")
    val snapshot = source.optJSONObject("snapshot")

    fun command(
        sourceID: String,
        targetID: String,
        reason: String,
        actor: StaffIdentity,
    ): LiveCommand {
        require(
            enabled &&
                actor.allows("recommendation.staff.modify") &&
                snapshot != null &&
                snapshot.getString("tableSessionId") == session &&
                sourceID != targetID &&
                reason in recommendationReasons
        ) {
            "请在本桌原推荐快照中选择不同商品及调整原因"
        }
        val snapshot = snapshot!!
        val options = snapshot.getJSONArray("options").objects()
        val a = options.find { it.getString("productId") == sourceID } ?: error("原推荐不存在")
        val b = options.find { it.getString("productId") == targetID } ?: error("目标推荐不存在")
        return ObservationCommands.make(
            actor,
            "调整本桌推荐",
            "recommendation.staff.modify",
            "/api/staff/native-customer-experience/recommendations/" +
                LiveCommand.part(snapshot.getString("recommendationPublicId")) +
                "/modifications",
            JSONObject()
                .put("sourceProductId", sourceID)
                .put("targetProductId", targetID)
                .put("reasonCode", reason),
            JSONObject()
                .put("kind", "recommendation")
                .put("tableSessionId", session)
                .put("publicId", snapshot.getString("recommendationPublicId"))
                .put("employeeId", actor.employeeId)
                .put(
                    "confirmation",
                    a.getString("productName") +
                        " → " +
                        b.getString("productName") +
                        "\n" +
                        recommendationReasons[reason] +
                        "\n仅记录推荐调整，不修改订单、价格或收款。",
                ),
        )
    }
}

object ObservationCommands {
    fun event(
        expression: String,
        type: String,
        degree: String,
        excerpt: String,
        scope: String,
        candidate: String?,
        product: String?,
        confidence: Double,
    ): JSONObject {
        val excerpt = excerpt.trim()
        require(
            expression in observationExpressions &&
                type in observationTypes &&
                (degree.isEmpty() || degree in observationDegrees) &&
                excerpt.length in 1..1000 &&
                confidence.isFinite() &&
                confidence in 0.0..1.0
        ) {
            "请明确区分客观事实、原话和判断，并核对原文片段"
        }
        return JSONObject()
            .put("expressionKind", expression)
            .put("scopeKind", scope)
            .put("eventType", type)
            .put("degree", degree.ifEmpty { null } ?: JSONObject.NULL)
            .put("reasonCode", JSONObject.NULL)
            .put("seatLabel", JSONObject.NULL)
            .put("customerId", JSONObject.NULL)
            .put("candidateId", candidate ?: JSONObject.NULL)
            .put("productId", product ?: JSONObject.NULL)
            .put("confidence", confidence)
            .put("rawExcerpt", excerpt)
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
                    JSONObject().put("observation", proof).toString(),
                )
            ),
        )
    }
}

val LiveStep.observationProof: JSONObject?
    get() =
        recoveryBody?.let {
            runCatching { JSONObject(it).optJSONObject("observation") }.getOrNull()
        }

fun validateObservationReply(text: String, step: LiveStep) {
    val root = JSONObject(text)
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    val data = root.getJSONObject("data")
    val p = step.observationProof!!
    val body = JSONObject(step.body)
    fun event(data: JSONObject, expected: JSONObject) {
        require(data.getString("id").isNotBlank())
        for ((key, input) in
            mapOf(
                "expressionKind" to "expressionKind",
                "scopeKind" to "scopeKind",
                "eventType" to "eventType",
                "degree" to "degree",
                "productId" to "productId",
                "selectedCandidateId" to "candidateId",
                "rawExcerpt" to "rawExcerpt",
            )) require(data.opt(key) == expected.opt(input))
    }
    when (p.getString("kind")) {
        "parse" ->
            require(
                data.getString("publicId").isNotBlank() &&
                    data.getString("status") == "draft" &&
                    data.getString("rawContent") == body.getString("rawContent") &&
                    data.getBoolean("needsImmediateAction") ==
                        body.getBoolean("needsImmediateAction") &&
                    data.getJSONArray("candidates") != null
            )
        "confirm" -> {
            val rows = data.getJSONArray("events").objects()
            val expected = body.getJSONArray("events").objects()
            require(
                data.getString("publicId") == p.getString("publicId") &&
                    data.getString("status") == "confirmed" &&
                    rows.size == expected.size &&
                    rows.size == 1 &&
                    (!p.getBoolean("immediate") ||
                        !data.textOrNull("serviceTaskId").isNullOrBlank())
            )
            event(rows[0], expected[0])
        }
        "revise" -> {
            require(
                data.getString("eventGroupId") == p.getString("eventGroupId") &&
                    data.getInt("revision") == p.getInt("revision") &&
                    data.getString("id") != p.getString("eventId")
            )
            event(data, body.getJSONObject("replacement"))
        }
        "recommendation" -> {
            require(
                data.getString("eventId").isNotBlank() &&
                    data.getString("recommendationPublicId") == p.getString("publicId") &&
                    data.getString("tableSessionId") == p.getString("tableSessionId") &&
                    data.getString("employeeId") == p.getString("employeeId")
            )
            for (key in listOf("sourceProductId", "targetProductId", "reasonCode")) require(
                data.getString(key) == body.getString(key)
            )
        }
        else -> error("原观察操作回执不一致")
    }
}
