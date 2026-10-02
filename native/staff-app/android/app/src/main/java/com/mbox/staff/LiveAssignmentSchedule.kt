package com.mbox.staff

import org.json.JSONObject
import java.time.Instant
import java.util.UUID

val assignmentScheduleModes = linkedMapOf("future" to "未来安排", "history" to "已结束", "cancelled" to "已取消")
class AssignmentSchedule(val source: JSONObject) {
    val rows = source.getJSONArray("rows").objects()
    val mode = source.getString("mode")
    val page = source.getInt("page")
    val hasMore = source.getBoolean("hasMore")
    val employee = source.getString("employeeId")
    init { require(mode in assignmentScheduleModes && page >= 0 && rows.size <= 50) }
    fun command(actor: StaffIdentity, id: String, reason: String, schedule: JSONObject?, now: Instant = Instant.now()): LiveCommand {
        val row = rows.find { it.getString("id") == id } ?: error("请刷新排班")
        require(actor.employeeId == employee && actor.allows(LiveAssignments.permission) && mode == "future" && row.isNull("cancelledAt") && serverInstant(row.getString("startsAt")) > now) { "仅能修改或取消尚未生效的排班，请刷新核对" }
        val note = reason.trim(); require(note.length in 2..1000) { "请填写2至1000字原因" }
        if(schedule != null) {
            require(schedule.getString("assignmentType") in assignmentKinds)
            for(key in listOf("employeeId", "roleId")) UUID.fromString(schedule.getString(key))
            val start = serverInstant(schedule.getString("startsAt"))
            require(start > now && (schedule.isNull("endsAt") || serverInstant(schedule.getString("endsAt")) > start)) { "开始须为未来时间，结束须晚于开始" }
        }
        val kind = if(schedule == null) "cancel" else "update"
        val body = JSONObject().put("kind", kind).put("id", id).put("expected", row.getString("configurationFingerprint")).put("reason", note)
        if(schedule != null) body.put("schedule", schedule)
        val proof = JSONObject().put("assignment", "schedule").put("actorId", actor.employeeId).put("before", JSONObject(row.toString()))
        proof.put("confirmation", "${row.getString("tableCode")} · ${row.getString("employeeName")}\n原时段：${assignmentTime(row.getString("startsAt"))} → ${if(row.isNull("endsAt")) "不设结束" else assignmentTime(row.getString("endsAt"))}\n${if(schedule == null) "取消后不再生效，原记录和原因保留。" else "修改后按新的责任人及起止时间生效。"}\n原因：$note")
        val key = UUID.randomUUID().toString()
        return LiveCommand(key, actor.employeeId, if(schedule == null) "取消未来排班" else "修改未来排班", LiveAssignments.permission,
            listOf(LiveStep("/api/table-management/native-assignment-schedule/commands", body.toString(), "idempotency-key", "native-business-$key", proof.toString())))
    }
}
fun validateAssignmentScheduleReply(text: String, step: LiveStep) {
    require(step.path == "/api/table-management/native-assignment-schedule/commands")
    val root = JSONObject(text); val data = root.getJSONObject("data"); val body = JSONObject(step.body); val proof = step.assignmentProof!!
    require(root.getJSONObject("meta").get("replayed") is Boolean && data.getString("employeeId") == proof.getString("actorId"))
    for(key in listOf("kind", "reason")) require(data.getString(key) == body.getString(key))
    require(data.getString("previousFingerprint") == body.getString("expected"))
    val row = data.getJSONObject("row"); val before = proof.getJSONObject("before")
    require(row.getString("id") == body.getString("id") && row.getString("tableId") == before.getString("tableId"))
    fun same(a: JSONObject, b: JSONObject, key: String): Boolean = if(a.isNull(key)) b.isNull(key) else !b.isNull(key) && serverInstant(a.getString(key)) == serverInstant(b.getString(key))
    if(body.getString("kind") == "cancel") {
        require(!row.isNull("cancelledAt") && row.getString("cancellationReason") == body.getString("reason"))
        for(key in listOf("employeeId", "roleId", "assignmentType")) require(row.getString(key) == before.getString(key))
        require(same(row,before,"startsAt") && serverInstant(row.getString("endsAt")) == serverInstant(row.getString("startsAt")))
    } else {
        val expected = body.getJSONObject("schedule")
        for(key in listOf("employeeId", "roleId", "assignmentType")) require(row.getString(key) == expected.getString(key))
        require(row.isNull("cancelledAt") && row.getString("reason") == body.getString("reason") && same(row,expected,"startsAt") && same(row,expected,"endsAt"))
    }
}
