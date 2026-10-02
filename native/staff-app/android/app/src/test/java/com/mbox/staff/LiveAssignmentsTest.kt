package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveAssignmentsTest {
    private fun fixture(name: String) =
        JSONObject(javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText())

    private val raw
        get() = fixture("live-assignments.json")

    private val actor
        get() =
            StaffIdentity.parse(
                fixture("live-contract.json")
                    .getJSONObject("auth")
                    .put("permissions", JSONArray(listOf(LiveAssignments.permission)))
            )

    private fun board(value: JSONObject = raw) =
        LiveAssignments(
            value.getJSONObject("options"),
            value.getJSONArray("tables"),
            value.getJSONArray("assignments"),
        )

    private val now = Instant.parse("2026-09-27T12:00:00Z")

    private fun request(
        board: LiveAssignments = board(),
        actor: StaffIdentity = this.actor,
        ids: Set<String> = board.tables.take(2).map { it.getString("id") }.toSet(),
        employee: String = board.employees[0].getString("id"),
        role: String = board.roles[0].getString("id"),
        kind: String = "backup",
        end: Instant? = null,
        reason: String = "晚班调整",
    ) = board.assign(actor, ids, employee, role, kind, now, end, reason)

    private fun receipt(command: LiveCommand): JSONObject {
        val body = JSONObject(command.steps[0].body)
        val ids = body.getJSONArray("tableIds")
        return JSONObject()
            .put("meta", JSONObject().put("replayed", false))
            .put(
                "data",
                JSONObject()
                    .put("id", "batch-id")
                    .put(
                        "assignments",
                        JSONArray(
                            (0 until ids.length()).map { index ->
                                JSONObject(body.toString())
                                    .put("id", "row-$index")
                                    .put("tableId", ids.getString(index))
                                    .put("createdByEmployeeId", actor.employeeId)
                                    .put("startsAt", "2026-09-27 12:00:00+00")
                            }
                        ),
                    ),
            )
    }

    @Test
    fun guardedCapabilityAndOriginalReceiptsRemainCompatible() {
        val raw = raw
        raw.getJSONObject("options").put("supportsGuardedAssignmentRecovery", true)
        val b = board(raw)
        val c = request(board = b)
        assertEquals("/api/table-management/guarded-assignments/batch", c.steps[0].path)
        validateAssignmentReply(receipt(c).toString(), c.steps[0])
        val row = b.assignments[0]
        val end = b.end(actor, row.getString("id"), "交班结束", now)
        val response = JSONObject().put("data", JSONObject(row.toString()).put("endsAt", now.toString()))
            .put("meta", JSONObject().put("replayed", true))
        validateAssignmentReply(response.toString(), end.steps[0])
        assertTrue(end.steps[0].path.contains("guarded-assignments/"))
        assertEquals("/api/table-management/assignments/batch", request().steps[0].path)
    }

    @Test
    fun guardedFailureNeedsExplicitUncommittedEvidence() {
        for (status in listOf(400, 409, 500)) for (disposition in listOf(null, "not_committed", "unknown")) {
            assertEquals(status == 409 && disposition == "not_committed",
                StaffAPIError(status, "TABLE_ASSIGNMENT_NOT_COMMITTED", "冲突", disposition).definitivelyRejected)
        }
        assertFalse(StaffAPIError(409, "TABLE_OPERATION_CONFLICT", "未知", "not_committed").definitivelyRejected)
    }

    @Test
    fun knownOverlapAndAdjacentIntervals() {
        assertThrows(IllegalArgumentException::class.java) { request(kind = "primary") }
        val raw = raw
        val row = raw.getJSONArray("assignments").getJSONObject(0)
        row.put("employeeId", board().employees[0].getString("id"))
        val b = board(raw)
        assertThrows(IllegalArgumentException::class.java) { request(board = b) }
        row.put("endsAt", now.toString())
        request(board = board(raw))
    }

    @Test
    fun scopeSearchAndTime() {
        val board = board()
        assertEquals(listOf("A10", "A2"), board.visibleTables("").map { it.getString("code") })
        assertEquals(listOf("A10"), board.visibleTables("ａ １").map { it.getString("code") })
        assertEquals(2, board.visibleTables("厅").size)
        assertEquals(now, assignmentDate("2026-09-27 12:00:00.000000+00"))
        assertEquals(now, assignmentDate("2026-09-27T20:00:00+08:00"))
        assertEquals("09-27 20:00", assignmentTime(now.toString()))
        assertNull(assignmentDate("invalid"))
    }

    @Test
    fun validationNeverGrantsPermissionsOrUsesUnseenOptions() {
        val b = board()
        listOf(
                emptySet(),
                setOf("foreign"),
                setOf(b.tables[2].getString("id")),
                (1..81).map { "t$it" }.toSet(),
            )
            .forEach { assertThrows(IllegalArgumentException::class.java) { request(ids = it) } }
        assertThrows(IllegalArgumentException::class.java) { request(employee = "foreign") }
        assertThrows(IllegalArgumentException::class.java) { request(role = "foreign") }
        assertThrows(IllegalArgumentException::class.java) { request(kind = "owner") }
        assertThrows(IllegalArgumentException::class.java) {
            request(actor = actor.copy(denied = setOf(LiveAssignments.permission)))
        }
        assertThrows(IllegalArgumentException::class.java) { request(end = now) }
        assertThrows(IllegalArgumentException::class.java) { request(end = now.plusMillis(200)) }
        assertThrows(IllegalArgumentException::class.java) { request(reason = " ") }
        assertThrows(IllegalArgumentException::class.java) { request(reason = "a".repeat(1001)) }
        assertEquals(setOf(LiveAssignments.permission), actor.permissions)
        listOf("primary", "backup", "temporary").forEach {
            assertEquals(
                it,
                JSONObject(
                        request(ids = setOf(b.tables[0].getString("id")), kind = it).steps[0].body
                    )
                    .getString("assignmentType"),
            )
        }
    }

    @Test
    fun batchReceiptRequiresExactSetAndOriginalDetails() {
        val c = request()
        val step = c.steps[0]
        assertEquals("/api/table-management/assignments/batch", step.path)
        assertEquals("x-idempotency-key", step.keyHeader)
        validateAssignmentReply(receipt(c).toString(), step)
        for (key in
            listOf(
                "id",
                "tableId",
                "employeeId",
                "roleId",
                "assignmentType",
                "reason",
                "createdByEmployeeId",
                "startsAt",
                "endsAt",
            )) {
            val value = receipt(c)
            val rows = value.getJSONObject("data").getJSONArray("assignments")
            rows
                .getJSONObject(0)
                .put(key, if (key == "id") rows.getJSONObject(1).getString("id") else "wrong")
            assertThrows(StaffAPIError::class.java) {
                validateAssignmentReply(value.toString(), step)
            }
        }
        val partial = receipt(c)
        partial.getJSONObject("data").getJSONArray("assignments").remove(1)
        assertThrows(StaffAPIError::class.java) {
            validateAssignmentReply(partial.toString(), step)
        }
        val wrongMeta = receipt(c).put("meta", JSONObject().put("replayed", 1))
        assertThrows(StaffAPIError::class.java) {
            validateAssignmentReply(wrongMeta.toString(), step)
        }
        val timed = request(end = now.plusSeconds(3600))
        validateAssignmentReply(receipt(timed).toString(), timed.steps[0])
        assertThrows(StaffAPIError::class.java) {
            validateAssignmentReply(receipt(timed).toString(), step)
        }
    }

    @Test
    fun endBindsOriginalAssignmentAndKeepsOriginalReason() {
        val b = board()
        val row = b.assignments[0]
        val command = b.end(actor, row.getString("id"), "交班结束", now)
        val ended = JSONObject(row.toString()).put("endsAt", "2026-09-27 12:00:00+00")
        val response =
            JSONObject().put("data", ended).put("meta", JSONObject().put("replayed", true))
        validateAssignmentReply(response.toString(), command.steps[0])
        assertNotEquals(
            ended.getString("reason"),
            JSONObject(command.steps[0].body).getString("reason"),
        )
        for (key in
            listOf(
                "id",
                "tableId",
                "employeeId",
                "roleId",
                "assignmentType",
                "startsAt",
                "endsAt",
            )) {
            val wrong = JSONObject(response.toString())
            wrong.getJSONObject("data").put(key, "wrong")
            assertThrows(StaffAPIError::class.java) {
                validateAssignmentReply(wrong.toString(), command.steps[0])
            }
        }
        assertThrows(IllegalArgumentException::class.java) { b.end(actor, "foreign", "交班结束", now) }
        assertThrows(IllegalArgumentException::class.java) {
            b.end(
                actor.copy(denied = setOf(LiveAssignments.permission)),
                row.getString("id"),
                "交班结束",
                now,
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            b.end(actor, row.getString("id"), "交班结束", assignmentDate(row.getString("startsAt"))!!)
        }
    }

    @Test
    fun lostAcknowledgementUsesOriginalRequestAndConflictsRemainUnknown() {
        val original = request()
        val saved = LiveCommand.parse(original.json())
        assertEquals(original, saved)
        var count = 0
        val api = StaffAPI { req ->
            count++
            assertEquals(saved.steps[0].key, req.headers["x-idempotency-key"])
            assertEquals(saved.steps[0].body, req.body.toString())
            if (count == 1) throw java.net.SocketTimeoutException("lost reply")
            APIResponse(201, receipt(saved).toString())
        }
        assertThrows(java.net.SocketTimeoutException::class.java) { api.execute(saved.steps[0]) }
        api.execute(saved.steps[0])
        assertEquals(2, count)
        assertFalse(StaffAPIError(409, "TABLE_OPERATION_CONFLICT", "冲突").definitivelyRejected)
    }
}
