package com.mbox.staff

import org.json.JSONObject
import java.util.UUID

fun serviceRecoveryStep(command: LiveCommand): LiveStep {
    require(command.steps.size == 1) { "该操作须按原业务流程核对" }
    val step = command.steps.single()
    val proof = step.serviceProof ?: error("仅服务任务支持此核对入口")
    val body = JSONObject(step.body)
    require(step.path == "/api/native-service-tasks/${proof.getString("taskId")}/${proof.getString("action")}" &&
        step.keyHeader == "idempotency-key" && step.key.startsWith("native-business-") &&
        body.getString("employeeId") == command.employeeID &&
        body.getString("tableSessionId") == proof.getString("tableSessionId") &&
        body.getString("taskType") == proof.getString("taskType")) { "原任务记录不完整，请保留记录联系管理员" }
    UUID.fromString(step.key.removePrefix("native-business-"))
    return step
}

fun serviceRecoveryRequest(command: LiveCommand, reason: String): JSONObject {
    val step = serviceRecoveryStep(command)
    require(reason.trim().length in 4..1000) { "请填写至少4个字的主管核对依据" }
    return JSONObject().put("taskId",step.serviceProof!!.getString("taskId"))
        .put("action",step.serviceProof!!.getString("action")).put("originalKey",step.key)
        .put("original",JSONObject(step.body)).put("reason",reason.trim()).put("confirmed",true)
}

/** Only an exact retained original receipt or a permanent request withdrawal releases the lock. */
fun validateServiceRecoveryReply(text: String, command: LiveCommand): String {
    val step=serviceRecoveryStep(command); val proof=step.serviceProof!!; val body=JSONObject(step.body)
    val root=JSONObject(text); val data=root.getJSONObject("data"); val original=data.getJSONObject("original")
    require(root.getJSONObject("meta").get("replayed") is Boolean)
    require(data.getString("originalKey")==step.key && data.getString("employeeId")==command.employeeID &&
        data.getString("taskId")==proof.getString("taskId") && data.getString("action")==proof.getString("action"))
    val expected=JSONObject().put("taskId",proof.getString("taskId")).put("action",proof.getString("action"))
        .put("employeeId",command.employeeID).put("session",body.getString("tableSessionId"))
        .put("taskType",body.getString("taskType")).put("expectedStatus",body.getString("expectedStatus"))
        .put("expectedPriority",body.getString("expectedPriority")).put("expectedAssigned",body.get("expectedAssignedEmployeeId"))
        .put("note",body.getString("note").trim()).put("assigned",if(proof.getString("action")=="assign")body.getString("assignedEmployeeId") else JSONObject.NULL)
        .put("priority",if(proof.getString("action")=="priority")body.getString("priority") else JSONObject.NULL)
    expected.keys().forEach { require(original.has(it) && original.get(it)==expected.get(it)) { "原请求内容不一致，请保留原记录" } }
    return when(data.getString("disposition")) {
        "committed" -> {
            validateServiceReply(JSONObject().put("data",data.getJSONObject("receipt")).put("meta",JSONObject().put("replayed",true)).toString(),step)
            "原服务操作已完成，已核对服务器回执；未重复执行"
        }
        "withdrawn" -> {
            val resolution=data.getJSONObject("resolution")
            for(key in listOf("originalKey","taskId","action","employeeId"))require(resolution.getString(key)==data.getString(key))
            require(resolution.getString("disposition")=="withdrawn" && resolution.getString("supervisorId")!=command.employeeID && data.isNull("receipt"))
            UUID.fromString(resolution.getString("supervisorId"));serverInstant(resolution.getString("resolvedAt"))
            "原请求已封存，未执行该请求；任务本身未取消，请刷新后处理"
        }
        else -> error("服务器未确认原请求，已保留本机记录")
    }
}
