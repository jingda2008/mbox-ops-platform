package com.mbox.staff

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

val assignmentKinds = linkedMapOf("primary" to "主服务员", "backup" to "候补服务员", "temporary" to "临时支援")

fun assignmentDate(value: String): Instant? = runCatching { serverInstant(value) }.getOrNull()

fun assignmentTime(value: String): String =
    assignmentDate(value)?.let {
        DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(it)
    } ?: "时间待核对"

private fun assignmentRows(rows: JSONArray) = (0 until rows.length()).map { rows.getJSONObject(it) }

class LiveAssignments(val options: JSONObject, tables: JSONArray, assignments: JSONArray, val schedule: AssignmentSchedule? = null) {
    val tables = assignmentRows(tables)
    val assignments = assignmentRows(assignments)
    val employees = assignmentRows(options.getJSONArray("employees"))
    val roles = assignmentRows(options.getJSONArray("roles"))

    private val commandRoot: String
        get() = if (options.optBoolean("supportsGuardedAssignmentRecovery", false))
            "/api/table-management/guarded-assignments" else "/api/table-management/assignments"

    init {
        for (rows in listOf(this.tables, this.assignments, employees, roles)) {
            val ids = rows.map { it.getString("id") }
            if (ids.any { it.isBlank() } || ids.distinct().size != ids.size) invalidResponse()
        }
        this.assignments.forEach {
            if (
                assignmentDate(it.getString("startsAt")) == null ||
                    (!it.isNull("endsAt") && assignmentDate(it.getString("endsAt")) == null)
            )
                invalidResponse()
        }
    }

    fun visibleTables(query: String): List<JSONObject> {
        fun normalized(text: String) =
            Normalizer.normalize(text, Normalizer.Form.NFKC)
                .lowercase(java.util.Locale.ROOT)
                .filterNot(Char::isWhitespace)
        val q = normalized(query)
        return tables
            .filter {
                it.getString("status") == "available" &&
                    normalized(it.getString("code") + it.getString("areaName")).contains(q)
            }
            .sortedWith(
                compareBy<JSONObject> { it.isNull("activeSessionId") }
                    .thenBy {
                        Regex("[0-9]+").replace(it.getString("code")) { match ->
                            match.value.padStart(20, '0')
                        }
                    }
            )
    }

    fun assign(
        actor: StaffIdentity,
        tableIDs: Set<String>,
        employeeID: String,
        roleID: String,
        kind: String,
        start: Instant,
        end: Instant?,
        reason: String,
    ): LiveCommand {
        val note = reason.trim()
        val employee = employees.find { it.getString("id") == employeeID }
        val role = roles.find { it.getString("id") == roleID }
        require(
            actor.allows(permission) &&
                tableIDs.size in 1..80 &&
                kind in assignmentKinds &&
                employee != null &&
                role != null &&
                tableIDs.all { id ->
                    tables.any { it.getString("id") == id && it.getString("status") == "available" }
                } &&
                (end == null || end > start) &&
                note.length in 2..1000
        ) {
            "请核对可用桌台、员工、岗位、起止时间和2—1000字原因"
        }
        val startsAt = start.truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()
        val endsAt = end?.truncatedTo(java.time.temporal.ChronoUnit.SECONDS)?.toString()
        require(endsAt == null || serverInstant(endsAt) > serverInstant(startsAt)) {
            "结束时间必须晚于开始时间"
        }
        val conflicts =
            assignments.filter { item ->
                item.getString("tableId") in tableIDs &&
                    (end == null || assignmentDate(item.getString("startsAt"))!! < end) &&
                    (item.isNull("endsAt") || assignmentDate(item.getString("endsAt"))!! > start) &&
                    (item.getString("employeeId") == employeeID ||
                        (kind == "primary" && item.getString("assignmentType") == "primary"))
            }
        require(conflicts.isEmpty()) {
            "责任时段冲突：" +
                conflicts.joinToString("、") {
                    it.getString("tableCode") + " · " + it.getString("employeeName")
                } +
                "。请先核对并结束原责任，或调整起止时间。"
        }
        val body =
            JSONObject()
                .put("tableIds", JSONArray(tableIDs.sorted()))
                .put("employeeId", employeeID)
                .put("roleId", roleID)
                .put("assignmentType", kind)
                .put("startsAt", startsAt)
                .put("endsAt", endsAt ?: JSONObject.NULL)
                .put("reason", note)
        val codes =
            visibleTables("")
                .filter { it.getString("id") in tableIDs }
                .joinToString("、") { it.getString("code") }
        val confirmation =
            "员工：${employee.getString("displayName")} · 岗位：${role.getString("name")}\n责任：${assignmentKinds[kind]}\n桌台：$codes\n上海时间：${assignmentTime(startsAt)} 起，${endsAt?.let(::assignmentTime) ?: "不设结束时间"}\n原因：$note\n所选桌台一次提交；冲突时不会部分生效。岗位仅用于责任记录，不授予账号新权限。"
        return make(
            actor,
            "$commandRoot/batch",
            body,
            JSONObject()
                .put("assignment", "batch")
                .put("actorId", actor.employeeId)
                .put("confirmation", confirmation),
            "${employee.getString("displayName")} · 安排${tableIDs.size}张责任桌",
        )
    }

    fun end(
        actor: StaffIdentity,
        id: String,
        reason: String,
        now: Instant = Instant.now(),
    ): LiveCommand {
        val item = assignments.find { it.getString("id") == id }
        val note = reason.trim()
        require(
            actor.allows(permission) &&
                item != null &&
                assignmentDate(item.getString("startsAt"))?.isBefore(now) == true &&
                (item.isNull("endsAt") ||
                    assignmentDate(item.getString("endsAt"))?.isAfter(now) == true) &&
                note.length in 2..1000
        ) {
            "责任安排已变化或不在生效期内，请刷新并填写结束原因"
        }
        val time = now.truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()
        require(serverInstant(time) > assignmentDate(item.getString("startsAt"))!!) {
            "刚生效的安排请稍后再结束"
        }
        val proof = JSONObject().put("assignment", "end")
        listOf("id", "tableId", "employeeId", "roleId", "assignmentType", "startsAt").forEach {
            proof.put(it, item.getString(it))
        }
        proof.put(
            "confirmation",
            "${item.getString("tableCode")} · ${item.getString("employeeName")} · ${assignmentKinds[item.getString("assignmentType")]}\n上海时间 ${assignmentTime(time)} 结束责任。\n原因：$note\n仅结束人员责任，不关桌、不清除该桌待办。",
        )
        return make(
            actor,
            "$commandRoot/${LiveCommand.part(id)}/end",
            JSONObject().put("endsAt", time).put("reason", note),
            proof,
            "结束 ${item.getString("tableCode")} · ${item.getString("employeeName")} 的责任",
        )
    }

    private fun make(
        actor: StaffIdentity,
        path: String,
        body: JSONObject,
        proof: JSONObject,
        title: String,
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
                    "x-idempotency-key",
                    "native-assignment-$id",
                    proof.toString(),
                )
            ),
        )
    }

    companion object {
        const val permission = "table.assignment.manage"
    }
}

val LiveStep.assignmentProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.opt("assignment") is String }

fun validateAssignmentReply(text: String, step: LiveStep) {
    val proof = step.assignmentProof ?: invalidResponse()
    if (proof.optString("assignment") == "schedule") { validateAssignmentScheduleReply(text, step); return }
    val root = JSONObject(text)
    val data = root.getJSONObject("data")
    val body = JSONObject(step.body)
    if (data.getString("id").isBlank() || root.getJSONObject("meta").get("replayed") !is Boolean)
        invalidResponse()
    fun sameTime(a: JSONObject, b: JSONObject, key: String): Boolean {
        if (a.isNull(key)) return b.isNull(key)
        val left = assignmentDate(a.getString(key)) ?: return false
        return left == assignmentDate(b.optString(key))
    }
    if (proof.getString("assignment") == "batch") {
        val rows = assignmentRows(data.getJSONArray("assignments"))
        val expectedArray = body.getJSONArray("tableIds")
        val expected = (0 until expectedArray.length()).map { expectedArray.getString(it) }.toSet()
        if (
            step.path !in listOf("/api/table-management/assignments/batch", "/api/table-management/guarded-assignments/batch") ||
                rows.size != expected.size ||
                rows.map { it.getString("tableId") }.toSet() != expected ||
                rows.map { it.getString("id") }.toSet().size != rows.size
        )
            invalidResponse()
        rows.forEach { row ->
            if (
                row.getString("id").isBlank() ||
                    row.getString("createdByEmployeeId") != proof.getString("actorId")
            )
                invalidResponse()
            listOf("employeeId", "roleId", "assignmentType", "reason").forEach {
                if (row.getString(it) != body.getString(it)) invalidResponse()
            }
            if (!sameTime(row, body, "startsAt") || !sameTime(row, body, "endsAt"))
                invalidResponse()
        }
    } else {
        if (
            proof.getString("assignment") != "end" ||
                data.getString("id") != proof.getString("id") ||
                step.path !in listOf(
                    "/api/table-management/assignments/${LiveCommand.part(data.getString("id"))}/end",
                    "/api/table-management/guarded-assignments/${LiveCommand.part(data.getString("id"))}/end")
        )
            invalidResponse()
        listOf("tableId", "employeeId", "roleId", "assignmentType").forEach {
            if (data.getString(it) != proof.getString(it)) invalidResponse()
        }
        if (!sameTime(data, proof, "startsAt") || !sameTime(data, body, "endsAt")) invalidResponse()
    }
}
