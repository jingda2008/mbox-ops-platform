package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

class LiveServiceTask(val source: JSONObject) {
    val id = source.getString("id")
    val session = source.getString("tableSessionId")
    val table = source.getString("tableCode")
    val type = source.getString("taskType")
    val title = source.getString("title")
    val status = source.getString("status")
    val priority = source.getString("priority")
    val assigned = source.textOrNull("assignedEmployeeId")
    val specialized
        get() = type == "goods.redelivery"

    val experience
        get() = type.startsWith("experience.")

    val actions
        get() =
            when (status) {
                "pending" ->
                    listOf("acknowledge", "start", "complete") +
                        (if (experience) emptyList() else listOf("cancel"))
                "acknowledged" ->
                    listOf("start", "complete") +
                        (if (experience) emptyList() else listOf("cancel"))
                "in_progress" ->
                    listOf("complete") + (if (experience) emptyList() else listOf("cancel"))
                else -> emptyList()
            }
}

class LiveServiceBoard(val source: JSONObject) {
    val employee = source.getString("currentEmployeeId")
    val durableExperience = source.optBoolean("durableExperience", false)
    val enabled = source.getBoolean("durableTasks")
    val tasks = source.getJSONArray("tasks").objects().map(::LiveServiceTask)
    val employees = source.getJSONArray("employees").objects()

    companion object {
        val labels =
            mapOf(
                "acknowledge" to "接收任务",
                "start" to "开始处理",
                "complete" to "确认已完成",
                "cancel" to "主管取消任务",
                "assign" to "转交员工",
                "priority" to "调整优先级",
            )
        val priorities = mapOf("urgent" to "紧急", "high" to "优先", "normal" to "普通", "low" to "稍后")
    }

    fun command(
        id: String,
        action: String,
        note: String,
        employee: String,
        priority: String,
        actor: StaffIdentity,
    ): LiveCommand {
        val row = tasks.find { it.id == id }
        require(
            enabled &&
                this.employee == actor.employeeId &&
                actor.allows("service.execute") &&
                row != null &&
                !row.specialized &&
                (action in row.actions ||
                    action in listOf("assign", "priority") && row.actions.isNotEmpty())
        ) {
            "任务已变化；补送和体验计划需从原事项处理"
        }
        require(!row!!.experience || durableExperience && note.trim().length >= 2) {
            "请刷新体验服务能力并记录实际处理结果"
        }
        val manager =
            action in listOf("assign", "priority", "cancel") || row.type == "guest.complaint"
        val reason = note.trim()
        require(
            reason.length <= 1000 &&
                (!manager ||
                    actor.allows("service.manage") &&
                        reason.length >= if (row.type == "guest.complaint") 4 else 2)
        ) {
            "请核对主管权限并记录处理结果；投诉至少4个字"
        }
        val body =
            JSONObject()
                .put("employeeId", actor.employeeId)
                .put("tableSessionId", row.session)
                .put("taskType", row.type)
                .put("expectedStatus", row.status)
                .put("expectedPriority", row.priority)
                .put("expectedAssignedEmployeeId", row.assigned ?: JSONObject.NULL)
                .put("note", reason)
        val proof =
            JSONObject()
                .put("taskId", id)
                .put("tableSessionId", row.session)
                .put("taskType", row.type)
                .put("action", action)
                .put(
                    "status",
                    mapOf(
                        "acknowledge" to "acknowledged",
                        "start" to "in_progress",
                        "complete" to "completed",
                        "cancel" to "cancelled",
                    )[action] ?: row.status,
                )
        if (row.experience) proof.put("experience", true)
        var extra = ""
        if (action == "assign") {
            val selected = employees.find { it.getString("id") == employee }
            require(
                selected != null &&
                    (row.type != "guest.complaint" || selected.getBoolean("canManage")) &&
                    employee != row.assigned
            ) {
                "请选择可接手此事项的另一名在岗员工"
            }
            body.put("assignedEmployeeId", employee)
            proof.put("assignedEmployeeId", employee)
            extra = "交给：" + selected.getString("name")
        }
        if (action == "priority") {
            require(priority in priorities && priority != row.priority) { "请选择新的任务优先级" }
            body.put("priority", priority)
            proof.put("priority", priority)
            extra = "优先级：" + priorities[priority]
        }
        val title = row.table + " · " + labels[action]
        proof.put(
            "confirmation",
            row.title +
                "\n" +
                title +
                "\n" +
                extra +
                "\n处理说明：" +
                reason +
                (if (row.experience) "\n确认完成将同步原体验节点；请核对原计划要求。单独取消节点不可用。"
                else "\n只处理原服务任务，不变更顾客账单。"),
        )
        val key = UUID.randomUUID().toString()
        return LiveCommand(
            key,
            actor.employeeId,
            title,
            if (manager) "service.manage" else "service.execute",
            listOf(
                LiveStep(
                    "/api/native-service-tasks/" + LiveCommand.part(id) + "/" + action,
                    body.toString(),
                    "idempotency-key",
                    "native-business-$key",
                    JSONObject().put("service", proof).toString(),
                )
            ),
        )
    }
}

val LiveStep.serviceProof: JSONObject?
    get() =
        recoveryBody?.let { runCatching { JSONObject(it).optJSONObject("service") }.getOrNull() }

fun validateServiceReply(text: String, step: LiveStep) {
    val root = JSONObject(text)
    val row = root.getJSONObject("data")
    val proof = step.serviceProof!!
    require(
        root.getJSONObject("meta").get("replayed") is Boolean &&
            row.getString("id") == proof.getString("taskId") &&
            row.getString("tableSessionId") == proof.getString("tableSessionId") &&
            row.getString("taskType") == proof.getString("taskType") &&
            row.getString("status") == proof.getString("status")
    )
    if (proof.optBoolean("experience", false)) {
        val cue = row.getJSONObject("nativeExperienceCue")
        require(
            cue.getString("cueId").isNotBlank() &&
                cue.getString("planId").isNotBlank() &&
                cue.getString("tableSessionId") == proof.getString("tableSessionId") &&
                cue.getString("serviceTaskId") == proof.getString("taskId") &&
                (proof.getString("action") != "complete" || cue.getString("status") == "completed")
        )
    }
    for (key in listOf("assignedEmployeeId", "priority")) {
        if (proof.has(key)) require(row.getString(key) == proof.getString(key))
    }
}
