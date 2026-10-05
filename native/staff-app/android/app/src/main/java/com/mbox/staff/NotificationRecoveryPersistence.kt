package com.mbox.staff

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/** Only intentions and navigation receipts are persisted; server authorization is always re-read. */
class NotificationRecoveryPersistence(private val store: NotificationStateStore) {
    private val policy = NotificationTaskRecoveryPolicy(maxConsumed = 24)
    private val remoteRequestKey = Regex("^native-push-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private data class Saved(val recovery: NotificationTaskRecovery, val suppressedRemoteRequestKey: String?)

    fun read(): NotificationTaskRecovery = readSaved().recovery

    /** This marker denies an older remote intention; it never grants navigation authority. */
    fun suppressedRemoteRequestKey(): String? = readSaved().suppressedRemoteRequestKey

    private fun readSaved(): Saved {
        val raw = store.read() ?: return Saved(NotificationTaskRecovery.empty(policy), null)
        val json = JSONObject(raw)
        val version = json.get("version")
        require(version is Int && version in 1..2) { "通知恢复记录版本不兼容" }
        val suppressed = if (version == 1) {
            exact(json, "version", "pending", "consumed")
            null
        } else {
            exact(json, "version", "pending", "consumed", "suppressedRemoteRequestKey")
            json.get("suppressedRemoteRequestKey").let {
                if (it == JSONObject.NULL) null else {
                    require(it is String && (it == "*" || remoteRequestKey.matches(it))) { "通知抑制记录字段无效" }
                    it
                }
            }
        }
        val pending = if (json.isNull("pending")) null else json.getJSONObject("pending").let {
            exact(it, "target", "requestedAt")
            PendingNotificationTask(target(it.getJSONObject("target")), date(it, "requestedAt"))
        }
        val consumed = json.getJSONArray("consumed").objects().map {
            exact(it, "target", "openedAt")
            ConsumedNotificationTask(target(it.getJSONObject("target")), date(it, "openedAt"))
        }
        return Saved(NotificationTaskRecovery.restore(pending, consumed, policy), suppressed)
    }

    fun write(state: NotificationTaskRecovery, suppressedRemoteRequestKey: String? = this.suppressedRemoteRequestKey()) {
        NotificationTaskRecovery.restore(state.pending, state.consumed, policy)
        require(suppressedRemoteRequestKey == null || suppressedRemoteRequestKey == "*" || remoteRequestKey.matches(suppressedRemoteRequestKey)) { "通知抑制记录字段无效" }
        val json = JSONObject().put("version", if (suppressedRemoteRequestKey == null) 1 else 2).put("pending", state.pending?.let {
            JSONObject().put("target", json(it.target)).put("requestedAt", it.requestedAt.toString())
        } ?: JSONObject.NULL).put("consumed", JSONArray(state.consumed.map {
            JSONObject().put("target", json(it.target)).put("openedAt", it.openedAt.toString())
        }))
        if (suppressedRemoteRequestKey != null) json.put("suppressedRemoteRequestKey", suppressedRemoteRequestKey)
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
