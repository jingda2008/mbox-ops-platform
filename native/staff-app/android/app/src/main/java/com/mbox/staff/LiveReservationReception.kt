package com.mbox.staff

import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

const val reservationReceptionRoot = "/api/staff/reservation-receptions"
private const val receptionMaxSafeInteger = 9007199254740991L
private val receptionStatuses = setOf("pending", "confirmed", "arrived", "seated", "completed", "cancelled", "no_show")
val reservationReceptionSeatPreferences = linkedMapOf(
    "no_preference" to "无特别偏好", "stage_atmosphere" to "舞台氛围",
    "quiet_chat" to "安静交谈", "comfortable_booth" to "舒适卡座", "outdoor_view" to "户外景观",
)

internal fun receptionInteger(source: JSONObject, field: String, min: Long = 0, max: Long = receptionMaxSafeInteger): Long {
    val value = source.get(field)
    require(value is Number && value.toDouble().isFinite()) { "预约数字字段无效：$field" }
    val integer = BigDecimal(value.toString()).longValueExact()
    require(integer in min..max) { "预约数字字段超出范围：$field" }
    return integer
}

private fun receptionText(source: JSONObject, field: String, min: Int = 1, max: Int = Int.MAX_VALUE): String {
    val value = source.get(field)
    require(value is String && value.length in min..max) { "预约文本字段无效：$field" }
    return value
}

private fun receptionUuid(source: JSONObject, field: String): String = receptionText(source, field).also {
    require(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}").matches(it)) { "预约引用无效：$field" }
    UUID.fromString(it)
}

private fun receptionPublicId(source: JSONObject, field: String = "publicId") = receptionText(source, field, 8, 128).also {
    require(Regex("[A-Za-z0-9][A-Za-z0-9._-]*").matches(it)) { "预约公开号无效" }
}

private fun receptionProtocol(source: JSONObject) { require(receptionInteger(source, "protocol", 1, 1) == 1L) }
private fun receptionFalse(source: JSONObject, field: String) { require(source.get(field) == false) { "当前预约协议尚不支持此接待方式" } }
private fun receptionDate(source: JSONObject, field: String) = receptionText(source, field).also { require(LocalDate.parse(it).toString() == it) }
private fun receptionKeys(source: JSONObject, allowed: Set<String>) { require(source.keys().asSequence().toSet() == allowed) { "原预约请求字段不完整或含未知字段" } }

class ReservationReceptionOptions(val source: JSONObject) {
    init { receptionProtocol(source); receptionFalse(source, "physicalTablesPreassigned") }
    // A capability read can race with the store switching new admissions off.
    // Missing or non-boolean flags never authorize a new intent.
    val creationEnabled = source.opt("creationEnabled") == true
    val arrival: Instant = serverInstant(receptionText(source, "arrivalAt"))
    val end: Instant = serverInstant(receptionText(source, "expectedEndAt"))
    private val policy = source.getJSONObject("policy")
    val policyVersion = receptionInteger(policy, "version", 1, Int.MAX_VALUE.toLong())
    val maxAdvanceDays = receptionInteger(policy, "maxAdvanceDays", 0, Int.MAX_VALUE.toLong()).toInt()
    val defaultDurationMinutes = receptionInteger(policy, "defaultDurationMinutes", 1, Int.MAX_VALUE.toLong()).toInt()
    val arrivalGraceMinutes = receptionInteger(policy, "arrivalGraceMinutes", 0, Int.MAX_VALUE.toLong()).toInt()
    private val capacity = source.getJSONObject("capacity")
    val totalGuests = receptionInteger(capacity, "totalGuests", 0, Int.MAX_VALUE.toLong()).toInt()
    val committedGuests = receptionInteger(capacity, "committedGuests", 0, Int.MAX_VALUE.toLong()).toInt()
    val remainingGuests get() = (totalGuests - committedGuests).coerceAtLeast(0)
    init { require(end.isAfter(arrival)) }

    companion object {
        fun path(arrival: Instant, end: Instant) = "$reservationReceptionRoot/options?arrivalAt=${LiveCommand.part(arrival.toString())}&expectedEndAt=${LiveCommand.part(end.toString())}"
    }
}

data class ReservationReceptionDraft(
    val arrival: Instant,
    val end: Instant,
    val name: String = "",
    val contact: String = "",
    val note: String = "",
    val source: String = "phone",
    val seat: String = "no_preference",
    val initial: String = "confirmed",
    val people: Int = 2,
    val preferredScheduleId: String? = null,
) {
    fun command(actor: StaffIdentity, options: ReservationReceptionOptions, now: Instant = Instant.now()): LiveCommand {
        require(actor.allows("reservation.manage")) { "当前员工无预约登记权限" }
        require(options.creationEnabled) { "门店已暂停新预约登记，请刷新后核对" }
        require(arrival.isAfter(now) && end.isAfter(arrival) && options.arrival == arrival && options.end == end) { "请按当前到店与结束时间重新读取接待名额" }
        require(!arrival.isAfter(now.plusSeconds(options.maxAdvanceDays.toLong() * 86400))) { "最多可提前${options.maxAdvanceDays}天预约，请重新核对到店时间" }
        require(people <= options.remainingGuests) { "当前时段接待名额不足，请重新读取后核对" }
        val publicId = "reception-${UUID.randomUUID()}"
        val body = JSONObject().put("protocol", 1).put("publicId", publicId)
            .put("customerName", name.trim()).put("contact", contact.trim()).put("guestCount", people)
            .put("arrivalAt", arrival.toString()).put("expectedEndAt", end.toString())
            .put("source", source).put("initialStatus", initial).put("note", note.trim().ifEmpty { null } ?: JSONObject.NULL)
            .put("seatPreference", seat).put("reservationPolicyVersion", options.policyVersion)
            .put("preferredScheduleId", preferredScheduleId ?: JSONObject.NULL)
        validateReceptionCreateBody(body)
        return receptionCommand(actor, "登记预约 · ${name.trim()}", reservationReceptionRoot, body,
            JSONObject().put("kind", "reception-create").put("publicId", publicId)
                .put("confirmation", "${name.trim()} · ${people}人\n${reservationDraftTime(arrival)} — ${reservationDraftTime(end)}\n${reservationReceptionSeatPreferences.getValue(seat)} · ${if (initial == "pending") "待确认" else "已确认"}\n只登记接待名额；到店后须另行开台、核对全部实际桌位再确认入座。未收取定金。"))
    }
}

data class ReservationReceptionSession(
    val tableSessionId: String, val tableId: String, val tableCode: String,
    val locationVersion: Long, val guestCount: Int, val businessDate: String, val openedAt: Instant,
) {
    internal fun tuple() = JSONObject().put("tableSessionId", tableSessionId).put("expectedTableId", tableId)
        .put("expectedLocationVersion", locationVersion).put("expectedGuestCount", guestCount)
    companion object {
        fun parse(source: JSONObject) = ReservationReceptionSession(
            receptionUuid(source, "tableSessionId"), receptionUuid(source, "tableId"), receptionText(source, "tableCode"),
            receptionInteger(source, "locationVersion"), receptionInteger(source, "guestCount", 1, 200).toInt(),
            receptionDate(source, "businessDate"), serverInstant(receptionText(source, "openedAt")),
        )
    }
}

class ReservationReceptionSessions(val source: JSONObject) {
    init { receptionProtocol(source); receptionFalse(source, "partialSeatingSupported") }
    val reservationId = receptionUuid(source, "reservationId")
    val version = receptionInteger(source, "reservationVersion", 1)
    val guestCount = receptionInteger(source, "reservationGuestCount", 1, 200).toInt()
    val status = receptionText(source, "reservationStatus")
    val sessions = source.getJSONArray("sessions").objects().map(ReservationReceptionSession::parse)
    init {
        require(status in receptionStatuses && (status == "arrived" || sessions.isEmpty()))
        require(sessions.map { it.tableSessionId }.toSet().size == sessions.size && sessions.map { it.tableId }.toSet().size == sessions.size)
        require(sessions.map { it.businessDate }.toSet().size <= 1) { "实际桌次营业日不一致，请刷新" }
    }
    companion object { fun path(id: String) = "$reservationReceptionRoot/${LiveCommand.part(id)}/table-sessions" }
}

fun reservationReceptionSeatCommand(
    row: LiveReservation, board: ReservationReceptionSessions, selectedSessionIds: Set<String>, reason: String, actor: StaffIdentity,
): LiveCommand {
    require(actor.allows("reservation.manage") && actor.allows("table.open")) { "确认入座需要预约管理和开台权限" }
    val customerId = receptionUuid(row.source, "customerId")
    require(row.receptionProtocol == 1 && row.status == "arrived" && board.status == "arrived" && row.id == board.reservationId &&
        receptionInteger(row.source, "aggregateVersion", 1) == board.version && receptionInteger(row.source, "guestCount", 1, 200).toInt() == board.guestCount) { "预约已变化，请重新读取接待详情" }
    val selected = board.sessions.filter { it.tableSessionId in selectedSessionIds }.sortedBy { it.tableSessionId }
    require(selectedSessionIds.size in 1..20 && selected.size == selectedSessionIds.size) { "请核对并选择本组全部实际桌位，最多20桌" }
    val body = JSONObject().put("protocol", 1).put("reservationVersion", board.version)
        .put("sessions", JSONArray(selected.map { it.tuple() })).put("reason", reason.trim())
    validateReceptionSeatBody(body)
    val total = selected.sumOf { it.guestCount }
    val proof = JSONObject().put("kind", "reception-seat").put("reservationId", row.id).put("publicId", row.publicId)
        .put("customerId", customerId).put("reservationGuestCount", board.guestCount).put("reservationVersion", board.version)
        .put("sessions", JSONArray(selected.map { it.tuple().put("tableCode", it.tableCode) }))
        .put("confirmation", "${row.name} · 预约 ${row.publicId}\n预约 ${board.guestCount}人，实际整组 ${total}人\n" +
            selected.joinToString("\n") { "${it.tableCode} · ${it.guestCount}人" } +
            (if (total != board.guestCount) "\n实际人数与预约不符，请确认说明包含实际原因。" else "") +
            "\n${reason.trim()}\n一次关联以上全部实际桌次，不支持分批追加，不会开台、付款或退款。")
    return receptionCommand(actor, "确认整组入座 · ${row.name}", "$reservationReceptionRoot/${LiveCommand.part(row.id)}/seat", body, proof)
}

private fun receptionCommand(actor: StaffIdentity, title: String, path: String, body: JSONObject, proof: JSONObject): LiveCommand {
    receptionUuid(JSONObject().put("employeeId", actor.employeeId), "employeeId")
    val id = UUID.randomUUID().toString()
    proof.put("employeeId", actor.employeeId)
    return LiveCommand(id, actor.employeeId, title, "reservation.manage", listOf(LiveStep(path, body.toString(), "idempotency-key", "native-reception-$id", JSONObject().put("reception", proof).toString())))
}

val LiveStep.receptionProof: JSONObject?
    get() = recoveryBody?.let { runCatching { JSONObject(it).optJSONObject("reception") }.getOrNull() }

fun reservationReceptionCreateRecoveryPath(step: LiveStep): String {
    val proof = requireNotNull(step.receptionProof)
    require(proof.getString("kind") == "reception-create" && step.path == reservationReceptionRoot && step.keyHeader == "idempotency-key" && step.key.length in 8..160)
    return "$reservationReceptionRoot/by-public-id/${LiveCommand.part(receptionPublicId(proof))}?requestKey=${LiveCommand.part(step.key)}"
}

/** Verify the decrypted original intent before either a receipt lookup or a POST. */
fun validateReservationReceptionRequest(step: LiveStep, body: JSONObject = JSONObject(step.body)) {
    val proof = requireNotNull(step.receptionProof)
    require(step.reservationProof == null && step.keyHeader == "idempotency-key" && step.key.length in 8..160 && step.key == step.key.trim()) { "预约原请求头或类型不一致" }
    receptionUuid(proof, "employeeId"); receptionPublicId(proof)
    val kind = receptionText(proof, "kind")
    if (proof.has("payloadKey")) {
        receptionUuid(proof, "payloadKey")
        require(receptionText(proof, "secureKind") == when (kind) {
            "reception-create" -> "create"
            "reception-seat" -> "seat"
            else -> error("预约原请求类型无效")
        }) { "预约安全槽类型不一致" }
    }
    when (kind) {
        "reception-create" -> {
            validateReceptionCreateBody(body)
            require(step.path == reservationReceptionRoot && body.getString("publicId") == proof.getString("publicId")) { "创建预约路径或原公开号不一致" }
        }
        "reception-seat" -> {
            val expected = validateReceptionSeatBody(body)
            val id = receptionUuid(proof, "reservationId")
            receptionUuid(proof, "customerId"); receptionInteger(proof, "reservationGuestCount", 1, 200)
            require(step.path == "$reservationReceptionRoot/${LiveCommand.part(id)}/seat" && receptionInteger(proof, "reservationVersion", 1) == receptionInteger(body, "reservationVersion", 1)) { "入座预约路径或原版本不一致" }
            val original = proof.getJSONArray("sessions").objects()
            require(original.size == expected.size && original.map { receptionUuid(it, "tableSessionId") }.toSet().size == original.size && original.map { receptionUuid(it, "expectedTableId") }.toSet().size == original.size)
            val byId = original.associateBy { it.getString("tableSessionId") }
            for (entry in expected) {
                val saved = requireNotNull(byId[entry.getString("tableSessionId")])
                require(receptionUuid(saved, "expectedTableId") == entry.getString("expectedTableId") &&
                    receptionInteger(saved, "expectedLocationVersion") == receptionInteger(entry, "expectedLocationVersion") &&
                    receptionInteger(saved, "expectedGuestCount", 1, 200) == receptionInteger(entry, "expectedGuestCount", 1, 200)) { "原入座桌次或人数不一致" }
                receptionText(saved, "tableCode")
            }
        }
        else -> error("未知预约接待请求")
    }
}

/** The caller supplies the decrypted original body when the ordinary pending slot is redacted. */
fun validateReservationReceptionReply(text: String, step: LiveStep, body: JSONObject = JSONObject(step.body)) {
    validateReservationReceptionRequest(step, body)
    val proof = requireNotNull(step.receptionProof)
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    receptionProtocol(data)
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    require(step.keyHeader == "idempotency-key" && step.key.length in 8..160)
    require(receptionUuid(data, "employeeId") == receptionUuid(proof, "employeeId") && receptionText(data, "requestKey", 8, 160) == step.key) { "接待回执员工或原请求键不一致，保留原请求待核对" }
    val reservation = data.getJSONObject("reservation")
    receptionUuid(reservation, "id")
    require(receptionPublicId(reservation) == receptionPublicId(proof))
    require(!data.has("contact") && !data.has("contactToken") && !reservation.has("contact") && !reservation.has("contactToken")) { "接待回执含不应返回的联系方式" }
    when (proof.getString("kind")) {
        "reception-create" -> {
            validateReceptionCreateBody(body)
            require(step.path == reservationReceptionRoot && receptionText(data, "operation") == "create" && body.getString("publicId") == proof.getString("publicId"))
            require(receptionText(reservation, "customerName") == body.getString("customerName") && receptionInteger(reservation, "guestCount", 1, 200) == receptionInteger(body, "guestCount", 1, 200))
            for (field in listOf("arrivalAt", "expectedEndAt")) require(serverInstant(receptionText(reservation, field)) == serverInstant(body.getString(field)))
            require(receptionText(reservation, "status") == body.getString("initialStatus") && receptionText(reservation, "source") == body.getString("source"))
            require(receptionUuid(reservation, "ownerEmployeeId") == proof.getString("employeeId") && receptionInteger(reservation, "aggregateVersion", 1) == 1L)
            receptionUuid(reservation, "customerId")
            require(reservation.getJSONArray("tableLocks").length() == 0 && reservation.get("contactAvailable") == true)
            val snapshot = reservation.getJSONObject("reservationSnapshot")
            require(receptionInteger(snapshot, "receptionProtocol", 1, 1) == 1L && receptionText(snapshot, "bookingMode") == "direct")
            receptionFalse(snapshot, "physicalTablesPreassigned")
            // These fields belong to the full Reservation DTO; compact receipts may omit them.
            for (field in listOf("note", "seatPreference", "preferredScheduleId")) if (reservation.has(field)) require(calendarJson(reservation.get(field)) == calendarJson(body.get(field)))
            if (reservation.has("reservationPolicyVersion")) require(receptionInteger(reservation, "reservationPolicyVersion", 1) == receptionInteger(body, "reservationPolicyVersion", 1))
        }
        "reception-seat" -> {
            val expected = validateReceptionSeatBody(body)
            val reservationId = receptionUuid(proof, "reservationId")
            require(step.path == "$reservationReceptionRoot/${LiveCommand.part(reservationId)}/seat" && receptionText(data, "operation") == "seat" && reservation.getString("id") == reservationId)
            val originalVersion = receptionInteger(body, "reservationVersion", 1, receptionMaxSafeInteger - 1)
            require(originalVersion == receptionInteger(proof, "reservationVersion", 1) && receptionInteger(reservation, "aggregateVersion", 1) == originalVersion + 1 && receptionText(reservation, "status") == "seated")
            val seating = data.getJSONObject("seating")
            validateReceptionSeating(seating, proof, expected, body.getString("reason"))
        }
        else -> error("未知接待回执，保留原请求待核对")
    }
}

private fun validateReceptionCreateBody(body: JSONObject) {
    receptionKeys(body, setOf("protocol", "publicId", "customerName", "contact", "guestCount", "arrivalAt", "expectedEndAt", "source", "initialStatus", "note", "seatPreference", "reservationPolicyVersion", "preferredScheduleId"))
    receptionProtocol(body); receptionPublicId(body)
    for ((field, bounds) in listOf("customerName" to 1..120, "contact" to 3..256)) {
        val value = receptionText(body, field, bounds.first, bounds.last)
        require(value == value.trim())
    }
    receptionInteger(body, "guestCount", 1, 200)
    require(serverInstant(receptionText(body, "expectedEndAt")).isAfter(serverInstant(receptionText(body, "arrivalAt"))))
    require(receptionText(body, "source") in setOf("phone", "employee") && receptionText(body, "initialStatus") in setOf("pending", "confirmed"))
    require(receptionText(body, "seatPreference") in reservationReceptionSeatPreferences)
    receptionInteger(body, "reservationPolicyVersion", 1, Int.MAX_VALUE.toLong())
    if (!body.isNull("note")) require(receptionText(body, "note", 1, 1000).let { it == it.trim() })
    if (!body.isNull("preferredScheduleId")) receptionUuid(body, "preferredScheduleId")
}

private fun validateReceptionSeatBody(body: JSONObject): List<JSONObject> {
    receptionKeys(body, setOf("protocol", "reservationVersion", "sessions", "reason"))
    receptionProtocol(body); receptionInteger(body, "reservationVersion", 1, receptionMaxSafeInteger - 1)
    require(receptionText(body, "reason", 4, 1000).let { it == it.trim() }) { "请填写4—1000字整组实际桌位及人数核对说明" }
    val sessions = body.getJSONArray("sessions").objects()
    require(sessions.size in 1..20)
    for (session in sessions) {
        receptionKeys(session, setOf("tableSessionId", "expectedTableId", "expectedLocationVersion", "expectedGuestCount"))
        receptionUuid(session, "tableSessionId"); receptionUuid(session, "expectedTableId")
        receptionInteger(session, "expectedLocationVersion"); receptionInteger(session, "expectedGuestCount", 1, 200)
    }
    require(sessions.map { it.getString("tableSessionId") }.toSet().size == sessions.size && sessions.map { it.getString("expectedTableId") }.toSet().size == sessions.size)
    return sessions
}

private fun validateReceptionSeating(seating: JSONObject, proof: JSONObject, expected: List<JSONObject>, reason: String) {
    receptionUuid(seating, "batchId")
    require(receptionUuid(seating, "customerId") == receptionUuid(proof, "customerId") && receptionUuid(seating, "seatedByEmployeeId") == proof.getString("employeeId"))
    serverInstant(receptionText(seating, "seatedAt"))
    require(receptionText(seating, "reason", 4, 1000) == reason && receptionInteger(seating, "reservationGuestCount", 1, 200) == receptionInteger(proof, "reservationGuestCount", 1, 200))
    val actual = seating.getJSONArray("sessions").objects()
    require(actual.size == expected.size && actual.map { receptionUuid(it, "tableSessionId") }.toSet().size == actual.size && actual.map { receptionUuid(it, "tableIdAtSeating") }.toSet().size == actual.size)
    val byId = actual.associateBy { it.getString("tableSessionId") }
    for (entry in expected) {
        val row = requireNotNull(byId[entry.getString("tableSessionId")])
        require(row.getString("tableIdAtSeating") == entry.getString("expectedTableId"))
        // The command binds the real table/session tuple. A later table-code edit is not a new seat.
        receptionText(row, "tableCodeAtSeating")
        require(receptionInteger(row, "locationVersionAtSeating") == receptionInteger(entry, "expectedLocationVersion") && receptionInteger(row, "guestCountAtSeating", 1, 200) == receptionInteger(entry, "expectedGuestCount", 1, 200))
    }
    require(receptionInteger(seating, "seatedGuestCount", 1, 4000) == expected.sumOf { receptionInteger(it, "expectedGuestCount", 1, 200) })
}

data class ReservationReceptionLinkedSession(
    val tableSessionId: String, val tableIdAtSeating: String, val tableCodeAtSeating: String,
    val locationVersionAtSeating: Long, val guestCountAtSeating: Int,
    val currentTableId: String, val currentTableCode: String, val currentLocationVersion: Long, val currentStatus: String,
) {
    companion object {
        fun parse(source: JSONObject) = ReservationReceptionLinkedSession(
            receptionUuid(source, "tableSessionId"), receptionUuid(source, "tableIdAtSeating"), receptionText(source, "tableCodeAtSeating"),
            receptionInteger(source, "locationVersionAtSeating"), receptionInteger(source, "guestCountAtSeating", 1, 200).toInt(),
            receptionUuid(source, "currentTableId"), receptionText(source, "currentTableCode"), receptionInteger(source, "currentLocationVersion"), receptionText(source, "currentStatus"),
        )
    }
}

class ReservationReceptionSeating(val source: JSONObject) {
    val batchId = receptionUuid(source, "batchId")
    val customerId = receptionUuid(source, "customerId")
    val seatedAt = serverInstant(receptionText(source, "seatedAt"))
    val seatedByEmployeeId = receptionUuid(source, "seatedByEmployeeId")
    val seatedGuestCount = receptionInteger(source, "seatedGuestCount", 1, 4000).toInt()
    val reservationGuestCount = receptionInteger(source, "reservationGuestCount", 1, 200).toInt()
    val reason = receptionText(source, "reason", 4, 1000)
    val reservationVersion = receptionInteger(source, "reservationVersion", 1)
    val businessDate = receptionDate(source, "businessDate")
    val sessions = source.getJSONArray("sessions").objects().map(ReservationReceptionLinkedSession::parse)
    init {
        require(sessions.size in 1..20 && sessions.map { it.tableSessionId }.toSet().size == sessions.size && sessions.map { it.tableIdAtSeating }.toSet().size == sessions.size)
        require(seatedGuestCount == sessions.sumOf { it.guestCountAtSeating })
    }
}

class ReservationReceptionDetail(val source: JSONObject) {
    init { receptionProtocol(source); require(source.has("seating")) { "预约接待关联状态未读取完整" } }
    val reservation = LiveReservation(source.getJSONObject("reservation"))
    val seating = if (source.isNull("seating")) null else ReservationReceptionSeating(source.getJSONObject("seating"))
    init {
        receptionUuid(reservation.source, "id")
        if (reservation.receptionProtocol == 1) receptionPublicId(reservation.source)
        else receptionText(reservation.source, "publicId", 8, 128)
        receptionInteger(reservation.source, "guestCount", 1, 200); receptionInteger(reservation.source, "aggregateVersion", 1)
        require(serverInstant(receptionText(reservation.source, "expectedEndAt")).isAfter(serverInstant(reservation.arrival)))
        require(reservation.status in receptionStatuses)
        require(!reservation.source.has("contact") && !reservation.source.has("contactToken"))
        seating?.let { require(it.customerId == receptionUuid(reservation.source, "customerId") && it.reservationGuestCount == reservation.count) }
        require(reservation.receptionProtocol != 1 || reservation.status !in setOf("seated", "completed") || seating != null) { "接待关联信息不完整，请重新核对" }
    }
    companion object { fun path(id: String) = "$reservationReceptionRoot/${LiveCommand.part(id)}" }
}
