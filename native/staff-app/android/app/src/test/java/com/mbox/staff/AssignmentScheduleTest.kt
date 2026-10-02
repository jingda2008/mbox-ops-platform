package com.mbox.staff

import java.time.Instant
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class AssignmentScheduleTest {
    private val actor get() = StaffIdentity.parse(JSONObject(javaClass.classLoader!!.getResourceAsStream("live-contract.json")!!.bufferedReader().readText()).getJSONObject("auth").put("permissions",JSONArray(listOf(LiveAssignments.permission))))
    private val now = Instant.parse("2026-09-30T10:00:00Z")
    private fun row() = JSONObject().put("id",UUID.randomUUID().toString()).put("tableId",UUID.randomUUID().toString()).put("tableCode","A1")
        .put("employeeId",UUID.randomUUID().toString()).put("employeeName","晚班员工").put("roleId",UUID.randomUUID().toString()).put("assignmentType","primary")
        .put("startsAt","2026-09-30 20:00:00+08").put("endsAt","2026-09-30 23:00:00+08").put("cancelledAt",JSONObject.NULL).put("configurationFingerprint","a".repeat(64))
    private fun board(row: JSONObject, mode: String = "future") = AssignmentSchedule(JSONObject().put("rows",JSONArray().put(row)).put("mode",mode).put("page",0).put("hasMore",false).put("employeeId",actor.employeeId))
    @Test fun cancellationRequiresFutureAndMatchesReceipt() {
        val before = row(); val command = board(before).command(actor,before.getString("id"),"员工请假取消",null,now)
        val step = command.steps[0]; val body = JSONObject(step.body)
        val reply = JSONObject().put("meta",JSONObject().put("replayed",true)).put("data",JSONObject().put("kind","cancel").put("employeeId",actor.employeeId).put("reason",body.getString("reason"))
            .put("previousFingerprint",body.getString("expected")).put("row",JSONObject(before.toString()).put("cancelledAt",now.toString()).put("cancellationReason",body.getString("reason")).put("endsAt",before.getString("startsAt"))))
        validateAssignmentReply(reply.toString(),step)
        reply.getJSONObject("data").getJSONObject("row").put("employeeId",UUID.randomUUID().toString())
        assertThrows(IllegalArgumentException::class.java) { validateAssignmentReply(reply.toString(),step) }
        assertThrows(IllegalArgumentException::class.java) { board(before).command(actor,before.getString("id"),"不应取消",null,now.plusSeconds(7200)) }
        assertThrows(IllegalArgumentException::class.java) { board(before,"history").command(actor,before.getString("id"),"不应取消",null,now) }
    }
    @Test fun updateRequiresFutureValidIntervalAndOriginalResponsibleReceipt() {
        val before = row(); val schedule = JSONObject().put("employeeId",UUID.randomUUID().toString()).put("roleId",before.getString("roleId")).put("assignmentType","backup")
            .put("startsAt","2026-09-30T14:00:00Z").put("endsAt",JSONObject.NULL)
        val command = board(before).command(actor,before.getString("id"),"延后晚班安排",schedule,now)
        val step = command.steps[0]; val body = JSONObject(step.body); val result = JSONObject(before.toString())
        for(key in schedule.keys()) result.put(key,schedule.get(key))
        result.put("reason",body.getString("reason"))
        val reply = JSONObject().put("meta",JSONObject().put("replayed",false)).put("data",JSONObject().put("kind","update").put("employeeId",actor.employeeId).put("reason",body.getString("reason"))
            .put("previousFingerprint",body.getString("expected")).put("row",result))
        validateAssignmentReply(reply.toString(),step)
        result.put("startsAt","2026-09-30T15:00:00Z")
        assertThrows(IllegalArgumentException::class.java) { validateAssignmentReply(reply.toString(),step) }
        schedule.put("endsAt",schedule.getString("startsAt"))
        assertThrows(IllegalArgumentException::class.java) { board(before).command(actor,before.getString("id"),"错误时段",schedule,now) }
    }
}
