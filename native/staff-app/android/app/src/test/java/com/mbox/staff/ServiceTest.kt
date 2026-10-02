package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ServiceTest {
    private fun fixture(name: String = "live-service.json") =
        JSONObject(javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText())

    private fun actor() = StaffIdentity.parse(fixture().getJSONObject("auth"))

    private fun command(
        action: String = "complete",
        note: String = "已与客人沟通处理",
        employee: String = "manager-2",
        priority: String = "normal",
        board: LiveServiceBoard = LiveServiceBoard(fixture().getJSONObject("board")),
    ) = board.command("task-1", action, note, employee, priority, actor())

    @Test
    fun complaintGuards() {
        assertEquals("service.manage", command().permission)
        assertEquals("session-old", JSONObject(command().steps[0].body).getString("tableSessionId"))
        assertThrows(IllegalArgumentException::class.java) { command(note = "完成") }
        assertThrows(IllegalArgumentException::class.java) {
            command("assign", employee = "worker-2")
        }
        assertThrows(IllegalArgumentException::class.java) {
            command("priority", priority = "urgent")
        }
        assertThrows(IllegalArgumentException::class.java) { command("other") }
        assertEquals(
            "manager-2",
            command("assign").steps[0].serviceProof!!.getString("assignedEmployeeId"),
        )
    }

    @Test
    fun receiptAndSpecialized() {
        val row =
            fixture()
                .getJSONObject("board")
                .getJSONArray("tasks")
                .getJSONObject(0)
                .put("status", "completed")
        val result = JSONObject().put("data", row).put("meta", JSONObject().put("replayed", true))
        validateServiceReply(result.toString(), command().steps[0])
        row.put("tableSessionId", "reused-table-session")
        assertThrows(Exception::class.java) {
            validateServiceReply(result.toString(), command().steps[0])
        }
        for (type in listOf("goods.redelivery", "experience.followup")) {
            val b = fixture().getJSONObject("board")
            b.getJSONArray("tasks").getJSONObject(0).put("taskType", type)
            assertThrows(IllegalArgumentException::class.java) {
                command(board = LiveServiceBoard(b))
            }
        }
    }

    @Test fun experienceLifecycleReceipt() {
        val raw=fixture().getJSONObject("board").put("durableExperience",true)
        val row=raw.getJSONArray("tasks").getJSONObject(0).put("taskType","experience.followup")
        val board=LiveServiceBoard(raw);val done=command(board=board)
        assertTrue(done.steps[0].serviceProof!!.getBoolean("experience"))
        assertThrows(Exception::class.java){command("cancel",board=board)}
        assertThrows(Exception::class.java){command(note="",board=board)}
        row.put("status","completed")
        fun reply()=JSONObject().put("data",row).put("meta",JSONObject().put("replayed",true)).toString()
        assertThrows(Exception::class.java){validateServiceReply(reply(),done.steps[0])}
        row.put("nativeExperienceCue",JSONObject().put("cueId","cue-1").put("planId","plan-1").put("serviceTaskId","task-1").put("tableSessionId","session-old").put("status","completed"))
        validateServiceReply(reply(),done.steps[0])
    }

    @Test
    fun compatibleCrossTableBatch() {
        val raw = fixture("live-kitchen.json")
        val rows = raw.getJSONArray("pending")
        val other =
            JSONObject(rows.getJSONObject(0).toString())
                .put("taskId", "task-other")
                .put("tableId", "table-other")
                .put("tableSessionId", "session-other")
                .put("tableCode", "B2")
        rows.put(other)
        val board = LiveKitchen(raw)
        val result =
            JSONObject(
                    board
                        .command(
                            actor(),
                            "start",
                            "task1",
                            selections = mapOf("task1" to 2, "task-other" to 1),
                        )
                        .steps[0]
                        .body
                )
                .getJSONObject("command")
        assertEquals(2, result.getJSONArray("items").length())
        assertThrows(IllegalArgumentException::class.java) {
            board.command(actor(), "start", "task1", selections = mapOf("missing" to 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            board.command(actor(), "start", "task1", selections = mapOf("task1" to 99))
        }
        other.put("itemNote", "不同备注")
        assertThrows(IllegalArgumentException::class.java) {
            LiveKitchen(raw)
                .command(
                    actor(),
                    "start",
                    "task1",
                    selections = mapOf("task1" to 1, "task-other" to 1),
                )
        }
    }

    @Test
    fun scopedWorkHistory() {
        assertTrue(HistoryQuery(workKind = "prepared").path().contains("workKind=prepared"))
        assertThrows(IllegalArgumentException::class.java) {
            HistoryQuery(workKind = "other").path()
        }
    }
}
