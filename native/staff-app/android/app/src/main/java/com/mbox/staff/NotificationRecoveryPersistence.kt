package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/** Only intentions and navigation receipts are persisted; server authorization is always re-read. */
class NotificationRecoveryPersistence(private val store: NotificationStateStore) {
    private val policy = NotificationTaskRecoveryPolicy(maxConsumed = 24)

    fun read(): NotificationTaskRecovery {
        val raw = store.read() ?: return NotificationTaskRecovery.empty(policy)
        val json = JSONObject(raw)
        exact(json, "version", "pending", "consumed")
        require(json.get("version") == 1) { "通知恢复记录版本不兼容" }
        val pending = if (json.isNull("pending")) null else json.getJSONObject("pending").let {
            exact(it, "target", "requestedAt")
            PendingNotificationTask(target(it.getJSONObject("target")), date(it, "requestedAt"))
        }
        val consumed = json.getJSONArray("consumed").objects().map {
            exact(it, "target", "openedAt")
            ConsumedNotificationTask(target(it.getJSONObject("target")), date(it, "openedAt"))
        }
        return NotificationTaskRecovery.restore(pending, consumed, policy)
    }

    fun write(state: NotificationTaskRecovery) {
        NotificationTaskRecovery.restore(state.pending, state.consumed, policy)
        val json = JSONObject().put("version", 1).put("pending", state.pending?.let {
            JSONObject().put("target", json(it.target)).put("requestedAt", it.requestedAt.toString())
        } ?: JSONObject.NULL).put("consumed", JSONArray(state.consumed.map {
            JSONObject().put("target", json(it.target)).put("openedAt", it.openedAt.toString())
        }))
        store.write(json.toString())
    }

    private fun text(json: JSONObject, key: String): String {
        val value = json.get(key)
        require(value is String && value.length in 1..256) { "通知恢复记录字段无效" }
        return value
    }
    private fun date(json: JSONObject, key: String) = Instant.parse(text(json, key))
    private fun exact(json: JSONObject, vararg fields: String) {
        require(json.keys().asSequence().toSet() == fields.toSet()) { "通知恢复记录字段不完整" }
    }
    private fun target(json: JSONObject): NotificationTaskTarget {
        exact(json, "notificationId", "employeeId", "staffSessionId", "taskId", "tableSessionId", "issuedAt", "expiresAt")
        return NotificationTaskTarget(
        text(json, "notificationId"), text(json, "employeeId"), text(json, "staffSessionId"),
        text(json, "taskId"), text(json, "tableSessionId"), date(json, "issuedAt"), date(json, "expiresAt"),
        )
    }
    private fun json(target: NotificationTaskTarget) = JSONObject()
        .put("notificationId", target.notificationId).put("employeeId", target.employeeId)
        .put("staffSessionId", target.staffSessionId).put("taskId", target.taskId)
        .put("tableSessionId", target.tableSessionId).put("issuedAt", target.issuedAt.toString())
        .put("expiresAt", target.expiresAt.toString())
}
