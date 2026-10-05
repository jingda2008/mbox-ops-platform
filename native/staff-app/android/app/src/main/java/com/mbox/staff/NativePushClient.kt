package com.mbox.staff

import java.time.Instant
import java.util.Base64
import org.json.JSONObject

private const val nativePushRoot = "/api/native/push"
private const val maxPushRevision = 9_007_199_254_740_991L
private val pushUuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
private val pushRequestKey = Regex("^native-push-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
private val pushPermissions = setOf("service.view", "service.execute", "service.manage", "complaint.handle")

data class NativePushOwner(val employeeId: String, val staffSessionId: String) {
    init { require(pushUuid.matches(employeeId) && pushUuid.matches(staffSessionId)) { "通知身份标识无效" } }
    companion object { fun from(actor: StaffIdentity) = NativePushOwner(actor.employeeId, actor.sessionId) }
}

data class NativePushBinding(val installationId: String, val revision: Long) {
    init { require(pushUuid.matches(installationId) && revision in 1..maxPushRevision) { "通知安装版本无效" } }
}

data class NativePushNotificationReference(val deliveryId: String) {
    init { require(pushUuid.matches(deliveryId)) { "通知投递标识无效" } }
}

/** Parses only the frozen mbox object, never a URL, task identifier, identity, or authorization. */
fun parseNativePushNotification(data: JSONObject): NativePushNotificationReference? = runCatching {
    data.pushKeys("protocol", "kind", "deliveryId")
    require(data.pushInteger("protocol") == 1L && data.pushString("kind") == "service_task")
    NativePushNotificationReference(data.pushString("deliveryId"))
}.getOrNull()

data class NativePushCapabilities(val owner: NativePushOwner, val enabled: Boolean, val reasonCode: String?) {
    // Contract v1 deliberately has no Android provider. iOS capability never enables Android.
    val androidAvailable: Boolean get() = false
    val androidReasonCode: String get() = "PROVIDER_NOT_SELECTED"
}

enum class NativePushInstallationStatus { ACTIVE, REVOKED, INVALID_TOKEN, EXPIRED }
data class NativePushInstallation(
    val owner: NativePushOwner,
    val binding: NativePushBinding,
    val status: NativePushInstallationStatus,
    val boundToCurrentSession: Boolean,
    val expiresAt: Instant,
    val lastRequestKey: String?,
)

data class NativePushTarget(
    val owner: NativePushOwner,
    val binding: NativePushBinding,
    val deliveryId: String,
    val taskId: String,
    val tableSessionId: String,
)

enum class NativePushObservationKind(val wireValue: String) { RECEIVED("received"), OPENED("opened") }

/** The caller persists this exact request before sending; retries must retain its owner and key. */
data class NativePushObservationRequest(
    val owner: NativePushOwner,
    val binding: NativePushBinding,
    val deliveryId: String,
    val kind: NativePushObservationKind,
    val requestKey: String,
) {
    init { require(pushUuid.matches(deliveryId) && pushRequestKey.matches(requestKey)) { "通知回报原请求无效" } }
    val path: String get() = "$nativePushRoot/deliveries/$deliveryId/observations"
    val body: String get() = JSONObject().put("kind", kind.wireValue).toString()
}

data class NativePushObservationReceipt(
    val owner: NativePushOwner,
    val deliveryId: String,
    val kind: NativePushObservationKind,
    val requestKey: String,
    val clientReportedReceivedAt: Instant?,
    val clientReportedOpenedAt: Instant?,
    val replayed: Boolean,
)

data class NativePushRevokeRequest(val owner: NativePushOwner, val binding: NativePushBinding, val requestKey: String) {
    init { require(pushRequestKey.matches(requestKey)) { "通知撤销原请求编号无效" } }
    val path: String get() = "$nativePushRoot/installations/${binding.installationId}/revoke"
    val body: String get() = JSONObject().put("expectedRevision", binding.revision).toString()
}

data class NativePushRevokeReceipt(val installation: NativePushInstallation, val requestKey: String, val replayed: Boolean)

/** Contains a secret: keep only in notification secure storage and never use default data-class logging. */
class NativePushCapabilityRevocation(val binding: NativePushBinding, val revocationSecret: String) {
    init {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(revocationSecret)) { "通知撤销凭据格式无效" }
        val decoded = Base64.getUrlDecoder().decode(revocationSecret)
        require(decoded.size == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == revocationSecret) { "通知撤销凭据格式无效" }
    }
    val path: String get() = "$nativePushRoot/installations/${binding.installationId}/revoke-capability"
    val body: String get() = JSONObject().put("revision", binding.revision).put("revocationSecret", revocationSecret).toString()
    override fun toString() = "NativePushCapabilityRevocation(redacted)"
}

/** A constant-shape receipt proves acceptance only, never existence or actual revocation. */
enum class NativePushCapabilityAcceptance { ACCEPTED_UNVERIFIED }
class NativePushUnsupportedException : UnsupportedOperationException("当前 Android 尚未选择推送提供方，不能注册或轮换通知令牌")
class NativePushInvalidResponse(cause: Exception) : IllegalStateException("通知服务回执无法核对，原请求已保留", cause)

/**
 * Contract-v1 client with a gated future registration boundary. No SDK or production Android adapter.
 * Ordinary calls share the caller's serialized StaffAPI. Capability revocation uses a fresh client.
 */
class NativePushClient(
    private val api: StaffAPI,
    private val capabilityTransport: ((APIRequest) -> APIResponse)? = null,
    private val registrationContract: NativePushRegistrationContract? = null,
) {
    fun registerAndroid(): Nothing = throw NativePushUnsupportedException()
    fun rotateAndroidToken(): Nothing = throw NativePushUnsupportedException()

    val registrationAvailable: Boolean get() = registrationContract != null

    fun supportsRegistration(token: NativePushSdkToken): Boolean = registrationContract?.let {
        it.id == token.contractId && it.accepts(token)
    } == true

    /** No production adapter is supplied. Tests exercise this boundary through StaffAPI transport. */
    fun registerAndroid(request: NativePushRegistrationRequest): NativePushRegistrationReceipt {
        if (!supportsRegistration(NativePushSdkToken(request.contractId, request.provider, request.token)))
            throw NativePushUnsupportedException()
        ensureOwner(request.owner)
        val response = api.raw(request.path, JSONObject(request.bodyText), mapOf("Idempotency-Key" to request.requestKey), method = "PUT")
        ensureOwner(request.owner)
        return verified {
            require(response.status in setOf(200, 201))
            val root = JSONObject(response.text).apply { pushKeys("data", "meta") }
            val data = root.pushObject("data").apply { pushKeys("protocol", "employeeId", "staffSessionId", "requestKey", "installation") }
            checkOwner(data, request.owner)
            require(data.pushString("requestKey") == request.requestKey)
            val installation = parseInstallation(data.pushObject("installation"), request.owner)
            require(installation.binding == request.targetBinding && installation.boundToCurrentSession &&
                installation.lastRequestKey == request.requestKey && installation.status == NativePushInstallationStatus.ACTIVE)
            val replayed = root.pushReplayed()
            require(response.status == if (request.expectedRevision == 0L && !replayed) 201 else 200)
            NativePushRegistrationReceipt(installation, request.requestKey, replayed)
        }
    }

    fun rotateAndroidToken(request: NativePushRegistrationRequest): NativePushRegistrationReceipt {
        require(request.expectedRevision > 0) { "通知令牌轮换须先核对原安装版本" }
        return registerAndroid(request)
    }

    private fun ensureOwner(owner: NativePushOwner) {
        val current = api.identity
        require(current != null && current.employeeId == owner.employeeId && current.sessionId == owner.staffSessionId &&
            pushPermissions.any(current::allows)) { "通知账号或权限已变化，请重新核对" }
    }

    private fun ordinary(owner: NativePushOwner, path: String, body: String? = null, key: String? = null): JSONObject {
        ensureOwner(owner)
        val response = api.raw(path, body?.let(::JSONObject), key?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap())
        ensureOwner(owner)
        return verified {
            require(response.status == 200)
            val root = JSONObject(response.text)
            require(root.keys().asSequence().all { it in setOf("data", "meta") })
            checkOwner(root.pushObject("data"), owner)
            root
        }
    }

    fun capabilities(owner: NativePushOwner): NativePushCapabilities {
        val root = ordinary(owner, "$nativePushRoot/capabilities")
        return verified {
            val data = root.pushObject("data")
            data.pushKeys("protocol", "employeeId", "staffSessionId", "enabled", "reasonCode", "platforms")
            val enabled = data.pushBoolean("enabled")
            val reason = data.pushNullableString("reasonCode")
            require(if (enabled) reason == null else !reason.isNullOrBlank())
            val platforms = data.pushObject("platforms").apply { pushKeys("ios", "android") }
            val ios = platforms.pushObject("ios").apply { pushKeys("provider", "configured", "environment") }
            require(ios.pushString("provider") == "apns")
            val iosConfigured = ios.pushBoolean("configured")
            val environment = ios.pushNullableString("environment")
            require(if (iosConfigured) environment in setOf("sandbox", "production") else environment == null)
            require(!enabled || iosConfigured)
            val android = platforms.pushObject("android").apply { pushKeys("provider", "configured", "reasonCode") }
            require(android.has("provider") && android.get("provider") == JSONObject.NULL &&
                !android.pushBoolean("configured") && android.pushString("reasonCode") == "PROVIDER_NOT_SELECTED")
            NativePushCapabilities(owner, enabled, reason)
        }
    }

    fun installation(owner: NativePushOwner, installationId: String): NativePushInstallation {
        require(pushUuid.matches(installationId)) { "通知安装标识无效" }
        val root = ordinary(owner, "$nativePushRoot/installations/$installationId")
        return verified {
            val data = root.pushObject("data").apply { pushKeys("protocol", "employeeId", "staffSessionId", "installation") }
            parseInstallation(data.pushObject("installation"), owner).also { require(it.binding.installationId == installationId) }
        }
    }

    fun target(owner: NativePushOwner, deliveryId: String, expectedBinding: NativePushBinding): NativePushTarget {
        require(pushUuid.matches(deliveryId)) { "通知投递标识无效" }
        val root = ordinary(owner, "$nativePushRoot/deliveries/$deliveryId/target")
        return verified {
            val data = root.pushObject("data").apply {
                pushKeys("protocol", "employeeId", "staffSessionId", "deliveryId", "installationId", "revision", "kind", "taskId", "tableSessionId")
            }
            require(data.pushString("deliveryId") == deliveryId && data.pushString("kind") == "service_task")
            require(data.pushString("installationId") == expectedBinding.installationId && data.pushInteger("revision") == expectedBinding.revision)
            val taskId = data.pushString("taskId"); val tableSessionId = data.pushString("tableSessionId")
            require(pushUuid.matches(taskId) && pushUuid.matches(tableSessionId))
            NativePushTarget(owner, expectedBinding, deliveryId, taskId, tableSessionId)
        }
    }

    fun observe(request: NativePushObservationRequest, beforePost: () -> Boolean = { true }): NativePushObservationReceipt {
        // The observation receipt has no installation/revision fields in v1. Re-resolve
        // before sending; the POST also reauthorizes this original delivery server-side.
        target(request.owner, request.deliveryId, request.binding)
        check(beforePost()) { "通知回报上下文已变化，原记录仍需核对" }
        val root = ordinary(request.owner, request.path, request.body, request.requestKey)
        return verified {
            val data = root.pushObject("data").apply {
                pushKeys("protocol", "employeeId", "staffSessionId", "requestKey", "deliveryId", "kind", "clientReportedReceivedAt", "clientReportedOpenedAt")
            }
            require(data.pushString("requestKey") == request.requestKey && data.pushString("deliveryId") == request.deliveryId &&
                data.pushString("kind") == request.kind.wireValue)
            val received = data.pushNullableInstant("clientReportedReceivedAt")
            val opened = data.pushNullableInstant("clientReportedOpenedAt")
            require(if (request.kind == NativePushObservationKind.RECEIVED) received != null else opened != null)
            NativePushObservationReceipt(request.owner, request.deliveryId, request.kind, request.requestKey, received, opened, root.pushReplayed())
        }
    }

    fun revoke(request: NativePushRevokeRequest): NativePushRevokeReceipt {
        val root = ordinary(request.owner, request.path, request.body, request.requestKey)
        return verified {
            val data = root.pushObject("data").apply { pushKeys("protocol", "employeeId", "staffSessionId", "requestKey", "installation") }
            require(data.pushString("requestKey") == request.requestKey)
            val installation = parseInstallation(data.pushObject("installation"), request.owner)
            require(installation.binding == request.binding && installation.boundToCurrentSession &&
                installation.status == NativePushInstallationStatus.REVOKED && installation.lastRequestKey == request.requestKey)
            NativePushRevokeReceipt(installation, request.requestKey, root.pushReplayed())
        }
    }

    fun revokeCapability(request: NativePushCapabilityRevocation): NativePushCapabilityAcceptance {
        // No credential store, copied cookie, restoreSession(), owner headers, or old PIN.
        val anonymous = StaffAPI(transport = capabilityTransport)
        val response = anonymous.raw(request.path, JSONObject(request.body))
        return verified {
            require(response.status == 200)
            val root = JSONObject(response.text).apply { pushKeys("data") }
            val data = root.pushObject("data").apply { pushKeys("protocol", "accepted") }
            require(data.pushInteger("protocol") == 1L && data.pushBoolean("accepted"))
            NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED
        }
    }
}

private fun parseInstallation(data: JSONObject, owner: NativePushOwner): NativePushInstallation {
    data.pushKeys("installationId", "revision", "status", "boundToCurrentSession", "expiresAt", "lastRequestKey")
    val binding = NativePushBinding(data.pushString("installationId"), data.pushInteger("revision"))
    val status = when (data.pushString("status")) {
        "active" -> NativePushInstallationStatus.ACTIVE
        "revoked" -> NativePushInstallationStatus.REVOKED
        "invalid_token" -> NativePushInstallationStatus.INVALID_TOKEN
        "expired" -> NativePushInstallationStatus.EXPIRED
        else -> error("未知通知安装状态")
    }
    val bound = data.pushBoolean("boundToCurrentSession")
    val lastKey = data.pushNullableString("lastRequestKey")
    require(if (bound) lastKey != null && pushRequestKey.matches(lastKey) else lastKey == null)
    return NativePushInstallation(owner, binding, status, bound, Instant.parse(data.pushString("expiresAt")), lastKey)
}

private fun checkOwner(data: JSONObject, owner: NativePushOwner) {
    require(data.pushInteger("protocol") == 1L && data.pushString("employeeId") == owner.employeeId &&
        data.pushString("staffSessionId") == owner.staffSessionId)
}
private inline fun <T> verified(block: () -> T): T = try { block() } catch (e: Exception) { throw NativePushInvalidResponse(e) }
private fun JSONObject.pushKeys(vararg keys: String) { require(this.keys().asSequence().toSet() == keys.toSet()) }
private fun JSONObject.pushObject(key: String) = get(key).let { require(it is JSONObject); it }
private fun JSONObject.pushString(key: String) = get(key).let { require(it is String); it }
private fun JSONObject.pushNullableString(key: String): String? = get(key).let { if (it == JSONObject.NULL) null else { require(it is String); it } }
private fun JSONObject.pushBoolean(key: String) = get(key).let { require(it is Boolean); it }
private fun JSONObject.pushInteger(key: String): Long = get(key).let {
    require(it is Int || it is Long)
    (it as Number).toLong().also { value -> require(value in 0..maxPushRevision) }
}
private fun JSONObject.pushNullableInstant(key: String) = pushNullableString(key)?.let(Instant::parse)
private fun JSONObject.pushReplayed() = pushObject("meta").apply { pushKeys("replayed") }.pushBoolean("replayed")
