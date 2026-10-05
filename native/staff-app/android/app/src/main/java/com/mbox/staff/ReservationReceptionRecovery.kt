package com.mbox.staff

import android.content.Context
import org.json.JSONObject

interface ReservationReceptionSecretStore {
    fun store(kind: String, key: String, value: String)
    fun read(kind: String, key: String): String
    fun remove(kind: String, key: String)
}

class KeystoreReservationReceptionSecrets(context: Context) : ReservationReceptionSecretStore {
    private val stores = listOf("create", "seat", "legacy-create").associateWith {
        PaymentSecrets(context, "reservation-$it")
    }
    private fun slot(kind: String) = stores[kind] ?: error("预约安全槽无效")
    override fun store(kind: String, key: String, value: String) = slot(kind).store(key, value)
    override fun read(kind: String, key: String) = slot(kind).read(key)
    override fun remove(kind: String, key: String) = slot(kind).remove(key)
}

private fun LiveStep.receptionRecoveryProof(): JSONObject? =
    receptionProof ?: reservationProof?.takeIf { it.optString("kind") == "create" }

private val LiveStep.isReceptionRequest: Boolean
    get() = receptionProof != null || receptionPayloadKey != null || path == reservationReceptionRoot ||
        path.startsWith("$reservationReceptionRoot/") || path == "/api/staff/native-reservations"

val LiveStep.receptionPayloadKey: String?
    get() = receptionRecoveryProof()?.textOrNull("payloadKey")

fun validateReservationReceptionPending(command: LiveCommand) {
    if (command.steps.none { it.isReceptionRequest }) return
    require(command.permission == "reservation.manage" && command.steps.size == 1) { "预约原请求权限或步骤不一致" }
    val step = command.steps.single()
    val proof = requireNotNull(step.receptionRecoveryProof())
    require(proof.getString("employeeId") == command.employeeID && proof.getString("payloadKey") == command.id) {
        "预约原员工或安全槽不一致，未发送"
    }
    val kind = when(proof.getString("kind")) {
        "reception-create" -> "create"
        "reception-seat" -> "seat"
        "create" -> "legacy-create"
        else -> error("预约原请求类型无效")
    }
    require(proof.getString("secureKind") == kind && step.body == "{}") { "预约安全槽类型不一致" }
}

fun secureReservationReceptionCommand(
    command: LiveCommand,
    store: ReservationReceptionSecretStore,
): LiveCommand {
    val step = command.steps.singleOrNull() ?: return command
    val proof = step.receptionRecoveryProof() ?: run {
        require(!step.isReceptionRequest) { "预约原请求证明缺失" }
        return command
    }
    if (step.receptionPayloadKey != null) { validateReservationReceptionPending(command); return command }
    require(command.permission == "reservation.manage") { "预约请求权限无效" }
    if (step.receptionProof != null) {
        require(proof.getString("employeeId") == command.employeeID) { "预约原员工不一致" }
        validateReservationReceptionRequest(step)
    } else validateLegacyReservationCreateRequest(step)
    val kind = when (proof.getString("kind")) {
        "reception-create" -> "create"
        "reception-seat" -> "seat"
        "create" -> "legacy-create"
        else -> error("预约原请求类型无效")
    }
    val saved = JSONObject().put("commandId", command.id).put("employeeId", command.employeeID)
        .put("path", step.path).put("keyHeader", step.keyHeader).put("key", step.key)
        .put("body", step.body)
    store.store(kind, command.id, saved.toString())
    val safeProof = JSONObject(proof.toString()).apply {
        remove("confirmation")
        put("payloadKey", command.id)
        put("secureKind", kind)
        put("employeeId", command.employeeID)
    }
    val envelope = JSONObject().put(if (step.receptionProof != null) "reception" else "reservation", safeProof)
    return command.copy(
        title = if (kind == "seat") "确认预约整组入座" else "创建预约 · 原请求待核对",
        steps = listOf(step.copy(body = "{}", recoveryBody = envelope.toString())),
    )
}

fun restoreReservationReceptionStep(step: LiveStep, store: ReservationReceptionSecretStore): LiveStep {
    val proof = step.receptionRecoveryProof() ?: error("预约原请求记录缺失")
    val key = proof.getString("payloadKey")
    val value = JSONObject(store.read(proof.getString("secureKind"), key))
    require(value.getString("commandId") == key && value.getString("employeeId") == proof.getString("employeeId") &&
        value.getString("path") == step.path && value.getString("keyHeader") == step.keyHeader &&
        value.getString("key") == step.key) { "预约安全记录与原请求不一致，请核对原请求" }
    return step.copy(body = value.getString("body"))
}

fun performReservationReceptionStep(
    step: LiveStep,
    store: ReservationReceptionSecretStore,
    read: (String) -> String,
    send: (LiveStep) -> String,
    readOnly: Boolean = false,
): String {
    val original = restoreReservationReceptionStep(step, store)
    if (original.receptionProof != null) validateReservationReceptionRequest(original)
    else validateLegacyReservationCreateRequest(original)
    val create = original.receptionProof?.optString("kind") == "reception-create"
    require(!readOnly || create) { "此原请求需按原内容核对" }
    val result = if (readOnly) read(reservationReceptionCreateRecoveryPath(original)) else send(original)
    if (original.receptionProof != null) validateReservationReceptionReply(result, original)
    else validateReservationReply(result, original)
    return result
}

fun removeReservationReceptionPayload(step: LiveStep?, store: ReservationReceptionSecretStore) {
    val proof = step?.receptionRecoveryProof() ?: return
    val key = proof.textOrNull("payloadKey") ?: return
    store.remove(proof.getString("secureKind"), key)
}

fun reservationReceptionDefinitivelyRejected(error: Exception): Boolean =
    error is StaffAPIError && error.commitDisposition == "not_committed" &&
        ((error.status == 409 && error.code in setOf("RESERVATION_POLICY_CHANGED", "RESERVATION_CAPACITY_UNAVAILABLE",
            "RESERVATION_RECEPTION_CHANGED", "RESERVATION_RECEPTION_REQUIRED")) ||
            (error.status == 503 && error.code == "RESERVATION_RECEPTION_UNAVAILABLE"))

/** Checks historical intent without reinterpreting its dates, table availability or original bytes. */
fun validateLegacyReservationCreateRequest(step: LiveStep) {
    val proof = requireNotNull(step.reservationProof)
    require(proof.getString("kind") == "create" && step.path == "/api/staff/native-reservations" &&
        step.keyHeader == "idempotency-key" && step.key.length in 8..160) { "旧预约原请求路径或类型不一致" }
    val body = JSONObject(step.body)
    require(body.get("publicId") is String && body.getString("publicId") == proof.getString("publicId"))
    require(body.get("customerName") is String && body.getString("customerName").trim().length in 1..120)
    require(body.get("contactToken") is String && body.getString("contactToken").trim().length in 1..256)
    receptionInteger(body, "guestCount", 1, 200)
    require(serverInstant(body.getString("expectedEndAt")).isAfter(serverInstant(body.getString("arrivalAt"))))
    require(body.getString("source") in listOf("phone", "employee") && body.getString("initialStatus") in listOf("pending", "confirmed"))
    require(body.getString("seatPreference") in reservationReceptionSeatPreferences)
    require(body.get("note") is String && body.getString("note").length <= 2000)
    val tables = body.getJSONArray("tableIds")
    require(tables.length() in 1..20)
    val ids = (0 until tables.length()).map { require(tables.get(it) is String); tables.getString(it).also { id -> require(id.isNotBlank()) } }
    require(ids.toSet().size == ids.size)
}
