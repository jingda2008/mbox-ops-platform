package com.mbox.staff

import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.UUID
import org.json.JSONObject

class LiveReservation(val source: JSONObject) {
    val id = source.getString("id")
    val publicId = source.getString("publicId")
    val name = source.getString("customerName")
    val count = source.getInt("guestCount")
    val arrival = source.getString("arrivalAt")
    val status = source.getString("status")
    val receptionProtocol: Int? = source.optJSONObject("reservationSnapshot")?.let {
        if (!it.has("receptionProtocol") || it.isNull("receptionProtocol")) null
        else receptionInteger(it, "receptionProtocol", 1, Int.MAX_VALUE.toLong()).toInt()
    }
    val tables =
        source
            .getJSONArray("tableLocks")
            .objects()
            .filter { it.getString("status") in listOf("held", "confirmed") }
            .joinToString("、") { it.getString("tableCode") }
            .ifEmpty { "待安排桌位" }
    val actions
        get() =
            when (status) {
                "pending" -> listOf("confirm", "arrive", "cancel")
                "confirmed" -> listOf("arrive", "cancel")
                "arrived" -> if (receptionProtocol != null) listOf("cancel") else listOf("complete", "cancel")
                "seated" -> listOf("complete", "cancel")
                else -> emptyList()
            }

    val statusLabel
        get() =
            mapOf(
                "pending" to "待确认",
                "confirmed" to "已确认",
                "arrived" to "已到店",
                "seated" to "已入座",
                "completed" to "已完成",
                "cancelled" to "已取消",
                "no_show" to "未到店",
            )[status] ?: "状态待核对"
}

class LiveReservationIntake(val source: JSONObject) {
    val kind = source.getString("kind")
    val publicId = source.getString("publicId")
    val name = source.getString("customerName")
    val arrival = source.getString("arrivalAt")
    val count = source.getInt("guestCount")
    val status = source.getString("status")
    val id = "$kind:$publicId"
    val active
        get() = status !in listOf("completed", "cancelled", "no_show", "expired", "converted", "seated")
}

data class ReservationQuery(val range: String, val from: String, val to: String) {
    companion object {
        val zone = ZoneId.of("Asia/Shanghai")

        fun day() = LocalDate.now(zone).toString()

        fun window(from: String, to: String): Pair<String, String> {
            val a = LocalDate.parse(from)
            val b = LocalDate.parse(to)
            require(
                a.toString() == from && b.toString() == to && ChronoUnit.DAYS.between(a, b) in 0..30
            ) {
                "请选择有效日期，最多连续查询31天"
            }
            return a.atStartOfDay(zone).toInstant().toString() to
                b.plusDays(1).atStartOfDay(zone).toInstant().toString()
        }
    }

    val path: String
        get() {
            require(range in listOf("current", "carryover", "history"))
            if (range == "current") return "/api/staff/reservations"
            if (range == "carryover") return "/api/staff/reservations?range=carryover"
            val w = window(from, to)
            return "/api/staff/reservations?range=history&from=" +
                LiveCommand.part(w.first) +
                "&to=" +
                LiveCommand.part(w.second)
        }

    val intakePath: String
        get() {
            val w = window(from, to)
            return "/api/staff/reservation-intake?from=" +
                LiveCommand.part(w.first) +
                "&to=" +
                LiveCommand.part(w.second)
        }
}

object ReservationCommands {
    val labels =
        mapOf(
            "confirm" to "确认预约",
            "arrive" to "确认已到店",
            "complete" to "完成预约",
            "cancel" to "取消预约",
            "promote" to "上调优先级",
            "demote" to "下调优先级",
            "clear" to "恢复默认排序",
        )

    fun transition(
        row: LiveReservation,
        action: String,
        reason: String,
        override: Boolean,
        actor: StaffIdentity,
    ): LiveCommand {
        val note = reason.trim()
        require(
            actor.allows("reservation.manage") &&
                action in row.actions &&
                note.length <= 500 &&
                (action != "cancel" || note.length >= 2) &&
                (!override || action == "cancel" && actor.allows("reservation.cancel.override"))
        ) {
            "请刷新预约并核对权限；取消须填写原因"
        }
        val body = JSONObject()
        if (note.isNotEmpty()) body.put("reason", note)
        if (action == "cancel") body.put("overridePolicy", override)
        return make(
            actor,
            "${labels[action]} · ${row.name}",
            "/api/staff/native-reservations/" + LiveCommand.part(row.id) + "/" + action,
            body,
            JSONObject()
                .put("kind", "transition")
                .put("id", row.id)
                .put("publicId", row.publicId)
                .put(
                    "status",
                    mapOf(
                        "confirm" to "confirmed",
                        "arrive" to "arrived",
                        "complete" to "completed",
                        "cancel" to "cancelled",
                    )[action],
                )
                .put(
                    "confirmation",
                    "${row.name} · ${row.count}人 · ${row.tables}\n${row.arrival}\n${labels[action]}\n$note" +
                        if (override) "\n主管例外取消；此操作不会退款。" else "",
                ),
        )
    }

    fun priority(
        row: LiveReservationIntake,
        mode: String,
        reason: String,
        actor: StaffIdentity,
    ): LiveCommand {
        val note = reason.trim()
        require(
            actor.allows("reservation.manage") &&
                row.active &&
                row.kind in listOf("reservation", "waitlist") &&
                mode in listOf("promote", "demote", "clear") &&
                note.length in 2..500
        ) {
            "请核对队列并填写2—500字调整原因"
        }
        return make(
            actor,
            "${labels[mode]} · ${row.name}",
            "/api/staff/native-reservation-intake/${row.kind}/" +
                LiveCommand.part(row.publicId) +
                "/priority-override",
            JSONObject().put("mode", mode).put("reason", note),
            JSONObject()
                .put("kind", "priority")
                .put("targetKind", row.kind)
                .put("publicId", row.publicId)
                .put("mode", mode)
                .put("reason", note)
                .put("confirmation", "${row.name} · ${labels[mode]}\n$note\n仅调整同一到店时段内的排序，不承诺新增座位。"),
        )
    }

    val waitlistLabels = mapOf("notified" to "已联系客人", "arrived" to "确认已到店", "seated" to "已安排入座", "cancelled" to "取消候位", "expired" to "结束过期候位")
    fun waitlistActions(status: String) = when(status) {
        "waiting" -> listOf("notified", "arrived", "cancelled", "expired")
        "notified" -> listOf("arrived", "cancelled", "expired")
        "arrived" -> listOf("seated", "cancelled")
        else -> emptyList()
    }
    fun waitlist(row: LiveReservationIntake, to: String, reason: String, actor: StaffIdentity): LiveCommand {
        val note = reason.trim()
        require(row.kind == "waitlist" && to in waitlistActions(row.status) && actor.allows("reservation.manage") && note.length in 2..500) { "请核对候位状态并填写2—500字实际处理说明" }
        return make(actor, "${waitlistLabels[to]} · ${row.name}", "/api/staff/native-waitlist/${LiveCommand.part(row.publicId)}/transition",
            JSONObject().put("expectedStatus",row.status).put("to",to).put("reason",note),
            JSONObject().put("kind","waitlist").put("publicId",row.publicId).put("status",to).put("previousStatus",row.status).put("reason",note)
                .put("confirmation", "${row.name} · ${row.count}人 · ${waitlistLabels[to]}\n$note\n仅记录已经完成的现场处理，不会自动发送短信、开台或退款。"))
    }

    fun make(
        actor: StaffIdentity,
        title: String,
        path: String,
        body: JSONObject,
        proof: JSONObject,
    ): LiveCommand {
        val id = UUID.randomUUID().toString()
        return LiveCommand(
            id,
            actor.employeeId,
            title,
            "reservation.manage",
            listOf(
                LiveStep(
                    path,
                    body.toString(),
                    "idempotency-key",
                    "native-business-$id",
                    JSONObject().put("reservation", proof).toString(),
                )
            ),
        )
    }
}

val LiveStep.reservationProof: JSONObject?
    get() =
        recoveryBody?.let {
            runCatching { JSONObject(it).optJSONObject("reservation") }.getOrNull()
        }

fun validateReservationReply(text: String, step: LiveStep) {
    val root = JSONObject(text)
    val row = root.getJSONObject("data")
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    val p = step.reservationProof!!
    require(
        row.getString("id").isNotBlank() && row.getString("publicId") == p.getString("publicId")
    )
    when (p.getString("kind")) {
        "create" -> {
            val body = JSONObject(step.body)
            require(
                row.getString("status") == body.getString("initialStatus") &&
                    row.getString("customerName") == body.getString("customerName") &&
                    row.getInt("guestCount") == body.getInt("guestCount")
            )
            require(
                serverInstant(row.getString("arrivalAt")) ==
                    serverInstant(body.getString("arrivalAt")) &&
                    serverInstant(row.getString("expectedEndAt")) ==
                        serverInstant(body.getString("expectedEndAt"))
            )
            val locks = row.getJSONArray("tableLocks").objects().map { it.getString("tableId") }
            val ids =
                body.getJSONArray("tableIds").let { a ->
                    (0 until a.length()).map { a.getString(it) }
                }
            require(locks.size == ids.size && locks.toSet() == ids.toSet())
        }
        "transition" ->
            require(
                row.getString("id") == p.getString("id") &&
                    row.getString("status") == p.getString("status")
            )
        "waitlist" -> require(row.getString("status") == p.getString("status") && row.getString("previousStatus") == p.getString("previousStatus") && row.getString("reason") == p.getString("reason"))
        "priority" ->
            require(
                row.getString("targetKind") == p.getString("targetKind") &&
                    row.getString("mode") == p.getString("mode") &&
                    row.getString("reason") == p.getString("reason") &&
                    assignmentDate(row.getString("createdAt")) != null
            )
        else -> error("原回执不一致")
    }
}

data class ReservationTable(
    val id: String,
    val code: String,
    val areaName: String,
    val capacity: Int,
) {
    companion object {
        fun parse(o: JSONObject) =
            ReservationTable(
                o.getString("id"),
                o.getString("code"),
                o.getString("areaName"),
                o.getInt("capacity"),
            )
    }
}

data class ReservationDraft(
    val name: String = "",
    val contact: String = "",
    val note: String = "",
    val source: String = "phone",
    val seat: String = "no_preference",
    val initial: String = "confirmed",
    val people: Int = 2,
    val arrival: java.time.Instant = java.time.Instant.now().plusSeconds(3600),
    val end: java.time.Instant = java.time.Instant.now().plusSeconds(10800),
    val tables: Set<String> = emptySet(),
) {
    fun command(
        actor: StaffIdentity,
        choices: List<ReservationTable>,
        now: java.time.Instant = java.time.Instant.now(),
    ): LiveCommand {
        val selected = choices.filter { it.id in tables }
        require(
            actor.allows("reservation.manage") &&
                name.trim().length in 1..120 &&
                contact.trim().length in 1..256 &&
                note.trim().length <= 2000 &&
                people in 1..200 &&
                arrival.isAfter(now) &&
                end.isAfter(arrival) &&
                tables.size in 1..20 &&
                selected.size == tables.size &&
                selected.sumOf { it.capacity } >= people &&
                source in listOf("phone", "employee") &&
                initial in listOf("confirmed", "pending") &&
                seat in
                    listOf(
                        "no_preference",
                        "stage_atmosphere",
                        "quiet_chat",
                        "comfortable_booth",
                        "outdoor_view",
                    )
        ) {
            "请核对姓名、联系方式、未来到店时间及结束时间，选择足够容量的1—20张桌台"
        }
        val id = "NRES-" + UUID.randomUUID().toString()
        return ReservationCommands.make(
            actor,
            "新建预约 · " + name.trim(),
            "/api/staff/native-reservations",
            JSONObject()
                .put("publicId", id)
                .put("customerName", name.trim())
                .put("contactToken", contact.trim())
                .put("guestCount", people)
                .put("arrivalAt", arrival.toString())
                .put("expectedEndAt", end.toString())
                .put("source", source)
                .put("seatPreference", seat)
                .put("initialStatus", initial)
                .put("note", note.trim())
                .put("tableIds", org.json.JSONArray(tables.sorted())),
            JSONObject()
                .put("kind", "create")
                .put("publicId", id)
                .put(
                    "confirmation",
                    "${name.trim()} · ${people}人 · ${selected.joinToString("、"){it.code}}\n${reservationDraftTime(arrival)} — ${reservationDraftTime(end)}\n${if(initial=="pending")"暂留待确认，逾时会释放座位" else "确认预约"}\n未收取定金；到店后还需开台。",
                ),
        )
    }
}

fun reservationDraftTime(at: java.time.Instant) =
    java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm")
        .withZone(ReservationQuery.zone)
        .format(at)
