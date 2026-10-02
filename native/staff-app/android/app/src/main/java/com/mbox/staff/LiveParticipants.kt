package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class LiveParticipant(
    val id: String,
    val role: String,
    val identity: String,
    val confirmation: String,
    val seat: String?,
) {
    val label
        get() = seat?.takeIf { it.isNotBlank() } ?: if (identity == "member") "会员" else "顾客"

    val detail
        get() =
            (mapOf(
                "organizer" to "主联系人",
                "payer" to "付款人",
                "reservation_owner" to "预约人",
                "companion" to "同行顾客",
            )[role] ?: "角色待确认") +
                " · " +
                (mapOf("confirmed" to "身份已确认", "corrected" to "身份已更正")[confirmation] ?: "请当面确认身份")

    companion object {
        fun parse(j: JSONObject) =
            LiveParticipant(
                j.getString("publicId"),
                j.getString("role"),
                j.getString("identityLevel"),
                j.getString("confirmationState"),
                j.textOrNull("seatLabel"),
            )
    }
}

data class ParticipantInput(
    val employeeID: String,
    val sourceID: String,
    val sourceCode: String,
    val session: String,
    val targetID: String,
    val targetCode: String,
    val kind: String,
    val sourceGuests: Int,
    val sourceVersion: Int,
    val quantity: Int,
    val targetSession: String?,
    val participants: List<String>,
    val reason: String,
    val capacityReason: String,
) {
    val path
        get() = "/api/table-management/sessions/" + LiveCommand.part(session)

    fun body() =
        JSONObject()
            .put("sourceTableSessionId", session)
            .put("movementKind", kind)
            .put("targetTableId", targetID)
            .put("targetTableSessionId", targetSession ?: JSONObject.NULL)
            .put("movedGuestCount", quantity)
            .put("participantPublicIds", JSONArray(participants))
            .put("reason", reason)
            .also {
                if (capacityReason.isNotEmpty()) it.put("capacityOverrideReason", capacityReason)
            }

    companion object {
        const val permission = "table.participation.manage"

        fun make(
            actor: StaffIdentity,
            source: LiveTable,
            target: LiveTable,
            members: List<LiveParticipant>,
            selected: Set<String>,
            quantity: Int,
            kind: String,
            reason: String,
            capacityReason: String,
        ): ParticipantInput {
            val note = reason.trim()
            val capacity = capacityReason.trim()
            val s = source.display
            val t = target.display
            require(
                actor.allows(permission) &&
                    s.id != t.id &&
                    s.session != null &&
                    source.sessionStatus == "open" &&
                    source.locationVersion != null &&
                    quantity in 1..200 &&
                    quantity <= s.people &&
                    members.map { it.id }.distinct().size == members.size &&
                    members.map { it.id }.containsAll(selected) &&
                    quantity >= selected.size &&
                    note.length in 2..1000 &&
                    capacity.length <= 1000 &&
                    (capacity.isEmpty() || capacity.length >= 2) &&
                    kind in listOf("participant_split", "participant_merge")
            ) {
                "请核对原桌次、实际人数、顾客名单、目标桌和原因"
            }
            if (kind == "participant_split")
                require(
                    selected.isNotEmpty() &&
                        quantity < s.people &&
                        target.status == "available" &&
                        t.session == null
                ) {
                    "拆桌须选择顾客和空闲桌，原桌至少保留一人"
                }
            else
                require(
                    target.sessionStatus == "open" &&
                        (if (members.isEmpty()) quantity == s.people else selected.isNotEmpty()) &&
                        (quantity != s.people || selected.size == members.size)
                ) {
                    "并桌须选择营业中的目标桌；全员并桌应选齐全部顾客并确认整桌人数"
                }
            return ParticipantInput(
                actor.employeeId,
                s.id,
                s.code,
                s.session!!,
                t.id,
                t.code,
                kind,
                s.people,
                source.locationVersion!!,
                quantity,
                t.session,
                selected.sorted(),
                note,
                capacity,
            )
        }
    }
}

class ParticipantPreview(val source: JSONObject) {
    val enabled
        get() = source.optBoolean("supportsNativeParticipantRecovery")

    val blockers
        get() = source.getJSONArray("blockers").objects()

    val adjustments
        get() = source.getJSONArray("roleAdjustments").objects()

    fun command(input: ParticipantInput, actor: StaffIdentity, confirmed: Boolean): LiveCommand {
        val projected = source.getInt("projectedGuestCount")
        val capacity = source.getInt("targetCapacity")
        require(
            enabled &&
                actor.employeeId == input.employeeID &&
                actor.allows(ParticipantInput.permission) &&
                confirmed &&
                source.getBoolean("finalRevalidationRequired") &&
                source.getString("movementKind") == input.kind &&
                source.getString("targetTableId") == input.targetID &&
                source.textOrNull("targetTableSessionId") == input.targetSession &&
                source.getInt("movedGuestCount") == input.quantity &&
                source.getInt("selectedParticipantCount") == input.participants.size &&
                capacity in 1..200 &&
                projected in 1..200 &&
                projected >= input.quantity &&
                blockers.isEmpty() &&
                adjustments.all {
                    it.getString("participantPublicId") in input.participants &&
                        it.getString("fromRole") == "organizer" &&
                        it.getString("toRole") == "companion"
                } &&
                source.getBoolean("requiresCapacityOverride") == (projected > capacity) &&
                source.getBoolean("requiresCapacityOverride") ==
                    input.capacityReason.isNotEmpty() &&
                (input.kind != "participant_split" || projected == input.quantity)
        ) {
            "预检不一致、存在未结业务或尚未确认现场，请重新预检"
        }
        val id = UUID.randomUUID().toString()
        val body =
            input
                .body()
                .put("employeeId", actor.employeeId)
                .put(
                    "nativeGuard",
                    JSONObject()
                        .put("sourceTableId", input.sourceID)
                        .put("sourceLocationVersion", input.sourceVersion)
                        .put("sourceGuestCount", input.sourceGuests)
                        .put("targetGuestCount", projected - input.quantity)
                        .put("targetCapacity", capacity),
                )
        val text =
            "${input.sourceCode} → ${input.targetCode} · ${input.quantity}人\n历史订单、支付、任务和观察留在原桌次；顾客移动后须扫描目标桌二维码。\n目标桌$projected/${capacity}人。\n原因：${input.reason}" +
                if (input.capacityReason.isEmpty()) "" else "\n加座：${input.capacityReason}"
        val proof =
            JSONObject()
                .put("sourceTableId", input.sourceID)
                .put("sourceSession", input.session)
                .put("confirmation", text)
                .put("targetTableId", input.targetID)
                .put("selectedCount", input.participants.size)
                .put("projectedCount", projected)
                .put("capacity", capacity)
        return LiveCommand(
            id,
            actor.employeeId,
            "确认人员" + if (input.kind == "participant_split") "拆桌" else "并桌",
            ParticipantInput.permission,
            listOf(
                LiveStep(
                    input.path + "/native-participant-movements",
                    body.toString(),
                    "x-idempotency-key",
                    "native-participants-$id",
                    JSONObject().put("participants", proof).toString(),
                )
            ),
        )
    }
}

val LiveStep.participantProof: JSONObject?
    get() =
        recoveryBody?.let {
            runCatching { JSONObject(it).optJSONObject("participants") }.getOrNull()
        }

fun validateParticipantReply(text: String, step: LiveStep) {
    val root = JSONObject(text)
    val row = root.getJSONObject("data")
    root.getJSONObject("meta").getBoolean("replayed")
    val proof = step.participantProof ?: error("缺少原请求")
    val body = JSONObject(step.body)
    require(
        row.getString("eventId").isNotBlank() &&
            row.getString("targetTableSessionId").isNotBlank() &&
            assignmentDate(row.getString("occurredAt")) != null &&
            row.getInt("movedParticipantCount") == proof.getInt("selectedCount") &&
            row.getInt("targetGuestCountAfter") == proof.getInt("projectedCount") &&
            row.getInt("targetCapacityAtMovement") == proof.getInt("capacity") &&
            row.getInt("targetGuestCountBefore") >= 0 &&
            row.getInt("targetGuestCountBefore") + body.getInt("movedGuestCount") ==
                row.getInt("targetGuestCountAfter") &&
            row.getInt("revokedGuestSessionCount") >= 0 &&
            row.textOrNull("capacityOverrideReason") == body.textOrNull("capacityOverrideReason") &&
            (body.textOrNull("targetTableSessionId") == null ||
                body.getString("targetTableSessionId") == row.getString("targetTableSessionId"))
    ) {
        "人员调整回执不匹配，保留原请求"
    }
}
