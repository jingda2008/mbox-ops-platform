package com.mbox.staff

import org.json.JSONObject
import java.security.MessageDigest

/** Background refresh must never resurrect a session removed by logout or overwrite a newer login. */
class ReadOnlySessionSnapshot(private val value: String) : StaffSessionStore {
    override fun read() = value
    override fun write(value: String) {}
    override fun remove() {}
}
data class ReminderSnapshot(val employee: String, val session: String, val count: Int, val fingerprint: String)
fun readServiceReminder(api: StaffAPI, employee: String, session: String): ReminderSnapshot {
    val actor=api.restoreSession() ?: error("没有保存的员工登录")
    require(actor.employeeId==employee && actor.sessionId==session) { "原员工登录已变化" }
    require(listOf("service.view","service.execute","service.manage","complaint.handle").any(actor::allows)) { "当前员工没有服务查看权限" }
    val data=api.data("/api/native-service-center")
    require(data.getString("currentEmployeeId")==employee)
    val tasks=data.getJSONArray("tasks").objects().filter { it.getString("status") in listOf("pending","acknowledged","in_progress") }
    val ids=tasks.map { it.getString("id")+":"+it.getString("tableSessionId")+":"+it.getString("priority") }.distinct().sorted()
    val digest=MessageDigest.getInstance("SHA-256").digest(ids.joinToString("\n").toByteArray()).joinToString(""){"%02x".format(it)}
    return ReminderSnapshot(employee,session,ids.size,digest)
}
fun reminderSessionMatches(value: String?, employee: String, session: String): Boolean = runCatching {
    val original=JSONObject(value ?: return false).getJSONObject("identity").getJSONObject("session")
    original.getString("employeeId")==employee && original.getString("id")==session
}.getOrDefault(false)
