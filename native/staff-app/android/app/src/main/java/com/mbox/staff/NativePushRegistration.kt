package com.mbox.staff

import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import org.json.JSONObject

private const val MAX_REVISION = 9_007_199_254_740_991L
private val registrationKey = Regex("^native-push-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

data class NativePushTokenContext(val owner: NativePushOwner, val generation: Long) {
    init { require(generation in 0..MAX_REVISION) { "通知本机代次无效" } }
}

/** Opaque SDK value: bounded for storage, never normalized using another provider's token rules. */
class NativePushSdkToken(val contractId: String, val provider: String, val value: String) {
    init {
        require(contractId.safeText(128) && provider.safeText(64) && value.safeText(4096)) { "通知令牌格式无效" }
    }
    fun same(other: NativePushSdkToken) = contractId == other.contractId && provider == other.provider && value == other.value
    fun toJson(): JSONObject = JSONObject().put("contractId", contractId).put("provider", provider).put("value", value)
    override fun toString() = "NativePushSdkToken(redacted)"
    companion object {
        fun fromJson(value: JSONObject): NativePushSdkToken {
            value.exactKeys("contractId", "provider", "value")
            return NativePushSdkToken(value.string("contractId"), value.string("provider"), value.string("value"))
        }
    }
}

/**
 * The future Android adapter must explicitly validate its frozen contract. No implementation or
 * configuration switch is installed in production. The v1 server only supports iOS/APNs.
 */
interface NativePushRegistrationContract {
    val id: String
    fun accepts(token: NativePushSdkToken): Boolean
}

/** Exact immutable original intent. Keep it only in the independent encrypted REGISTRATION store. */
class NativePushRegistrationRequest(
    val owner: NativePushOwner,
    val generation: Long,
    val installationId: String,
    val expectedRevision: Long,
    val contractId: String,
    val provider: String,
    val token: String,
    val appVersion: String,
    val requestKey: String,
    val revocationSecret: String,
    val permission: String = "authorized",
    originalBody: String? = null,
) {
    val targetBinding: NativePushBinding
    val bodyText: String
    val path get() = "/api/native/push/installations/$installationId"
    init {
        require(expectedRevision in 0 until MAX_REVISION && generation in 0..MAX_REVISION) { "通知安装版本无效" }
        targetBinding = NativePushBinding(installationId, expectedRevision + 1)
        NativePushSdkToken(contractId, provider, token)
        NativePushCapabilityRevocation(targetBinding, revocationSecret)
        require(registrationKey.matches(requestKey) && appVersion.safeText(64) && permission == "authorized") { "通知注册原请求无效" }
        val body = JSONObject().put("expectedRevision", expectedRevision).put("platform", "android")
            .put("provider", provider).put("token", token).put("permission", permission)
            .put("appVersion", appVersion).put("revocationSecret", revocationSecret)
        bodyText = originalBody ?: body.toString()
        require(bodyText.length <= 32768) { "通知原请求过大" }
        val saved = JSONObject(bodyText)
        saved.exactKeys("expectedRevision", "platform", "provider", "token", "permission", "appVersion", "revocationSecret")
        require(saved.integer("expectedRevision") == expectedRevision && saved.string("platform") == "android" &&
            saved.string("provider") == provider && saved.string("token") == token && saved.string("permission") == permission &&
            saved.string("appVersion") == appVersion && saved.string("revocationSecret") == revocationSecret) { "通知原请求不一致" }
    }
    fun same(other: NativePushRegistrationRequest) = owner == other.owner && generation == other.generation &&
        installationId == other.installationId && contractId == other.contractId && requestKey == other.requestKey && bodyText == other.bodyText
    fun toJson(): JSONObject = JSONObject().put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
        .put("generation", generation).put("installationId", installationId).put("contractId", contractId)
        .put("requestKey", requestKey).put("body", bodyText)
    override fun toString() = "NativePushRegistrationRequest(redacted)"
    companion object {
        fun fromJson(value: JSONObject): NativePushRegistrationRequest {
            try {
                value.exactKeys("employeeId", "staffSessionId", "generation", "installationId", "contractId", "requestKey", "body")
                val text = value.string("body")
                require(text.length <= 32768)
                val body = JSONObject(text)
                return NativePushRegistrationRequest(NativePushOwner(value.string("employeeId"), value.string("staffSessionId")),
                    value.integer("generation"), value.string("installationId"), body.integer("expectedRevision"),
                    value.string("contractId"), body.string("provider"), body.string("token"), body.string("appVersion"),
                    value.string("requestKey"), body.string("revocationSecret"), body.string("permission"), text)
            } catch (_: Exception) { throw IllegalStateException("通知注册原记录暂不可读取，原记录已保留") }
        }
        fun prepare(context: NativePushTokenContext, installationId: String, expectedRevision: Long,
            token: NativePushSdkToken, appVersion: String): NativePushRegistrationRequest {
            val secret = ByteArray(32).also { SecureRandom().nextBytes(it) }
            return NativePushRegistrationRequest(context.owner, context.generation, installationId, expectedRevision,
                token.contractId, token.provider, token.value, appVersion, "native-push-${UUID.randomUUID()}",
                Base64.getUrlEncoder().withoutPadding().encodeToString(secret))
        }
    }
}

data class NativePushRegistrationReceipt(val installation: NativePushInstallation, val requestKey: String, val replayed: Boolean)

private fun String.safeText(max: Int) = isNotBlank() && length <= max && none { it.code < 32 || it.code == 127 } &&
    toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == this
private fun JSONObject.exactKeys(vararg expected: String) { require(keys().asSequence().toSet() == expected.toSet()) }
private fun JSONObject.string(key: String): String = get(key).let { require(it is String); it }
private fun JSONObject.integer(key: String): Long = get(key).let { require(it is Long || it is Int); (it as Number).toLong() }
