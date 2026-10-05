package com.mbox.staff

import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Original revoke request and its independent capability. Never log the secret. */
class NativePushRevocationSlot(
    val request: NativePushRevokeRequest,
    private val secret: String?,
) {
    val capability: NativePushCapabilityRevocation? get() = secret?.let { NativePushCapabilityRevocation(request.binding, it) }
    init { if (secret != null) NativePushCapabilityRevocation(request.binding, secret) }
    internal fun same(other: NativePushRevocationSlot) = request == other.request && secret == other.secret
    internal fun savedSecret() = secret
    override fun toString() = "NativePushRevocationSlot(redacted)"
}

data class NativePushRemoteOpen(
    val owner: NativePushOwner,
    val binding: NativePushBinding,
    val deliveryId: String,
    val requestKey: String,
) {
    init { NativePushObservationRequest(owner, binding, deliveryId, NativePushObservationKind.OPENED, requestKey) }
}

/**
 * Independent secure push state. Instantiate with NotificationStorePurpose.REGISTRATION.
 * No SDK, token synthesis, registration PUT, business writes, or caller authentication is performed.
 * Android v1 is always locally disabled, even when an old active binding is recovered.
 */
class NativePushLifecycle(
    private val store: NotificationStateStore,
    private val now: () -> Instant = { Instant.now() },
) {
    private class SavedBinding(val installation: NativePushInstallation, val secret: String?) {
        init { if (secret != null) NativePushCapabilityRevocation(installation.binding, secret) }
        override fun toString() = "SavedBinding(redacted)"
    }
    private data class State(
        val installationId: String,
        val generation: Long = 0,
        val owner: NativePushOwner? = null,
        val binding: SavedBinding? = null,
        val revocations: List<NativePushRevocationSlot> = emptyList(),
        val remoteOpen: NativePushRemoteOpen? = null,
        val observations: List<NativePushObservationRequest> = emptyList(),
        val pendingRegistration: NativePushRegistrationRequest? = null,
        val queuedToken: NativePushSdkToken? = null,
        val registrationAttempted: Boolean = false,
        val registeredToken: NativePushSdkToken? = null,
        val consumedOpens: List<NativePushRemoteOpen> = emptyList(),
    )
    @Volatile private var state = store.read()?.let(::decode) ?: State(UUID.randomUUID().toString()).also { store.write(encode(it)) }
    private var dirty = false
    // A failed newer click must not expose an older persisted destination in this process.
    // It cannot prove the newer click survived process death when the disk write failed.
    @Volatile private var openWriteBlocked = false
    private var openedSavePending = false

    val installationId get() = state.installationId
    val generation get() = state.generation
    val owner get() = state.owner
    val currentBinding get() = state.binding?.installation?.binding
    val remoteEnabled: Boolean get() = false
    val pendingRemoteOpen get() = state.let { saved -> saved.remoteOpen.takeIf { !openWriteBlocked && saved.binding?.installation?.isActive(now()) == true } }
    val pendingObservationCount get() = state.observations.size
    val pendingRevocationCount get() = state.revocations.size

    fun registerAndroid(): Nothing = throw NativePushUnsupportedException()
    fun rotateAndroidToken(): Nothing = throw NativePushUnsupportedException()

    @Synchronized fun pendingRegistration(): NativePushRegistrationRequest? {
        ensureDurable(); return state.pendingRegistration
    }

    @Synchronized fun queuedToken(): NativePushSdkToken? {
        ensureDurable(); return state.queuedToken
    }

    @Synchronized fun registrationAttempted(): Boolean {
        ensureDurable(); return state.registrationAttempted
    }

    /** Save before handing the original request to transport; uncertainty survives a restart. */
    @Synchronized fun markRegistrationAttempt(request: NativePushRegistrationRequest): Boolean {
        if (!registrationOwnerMatches(request) || state.pendingRegistration?.same(request) != true) return false
        if (state.registrationAttempted) { ensureDurable(); return true }
        commit(state.copy(registrationAttempted = true)); return true
    }

    /** An SDK callback updates only the latest token; it never rewrites an uncertain request. */
    @Synchronized fun stageToken(context: NativePushTokenContext, token: NativePushSdkToken): Boolean {
        if (context.owner != state.owner || context.generation != state.generation) return false
        if (state.pendingRegistration == null && state.binding?.installation?.isActive(now()) == true &&
            state.registeredToken?.same(token) == true) {
            if (state.queuedToken != null) commit(state.copy(queuedToken = null)) else ensureDurable()
            return true
        }
        if (state.queuedToken?.same(token) == true) { ensureDurable(); return true }
        commit(state.copy(queuedToken = token)); return true
    }

    /** This state transition does not grant permission to call an Android provider or HTTP PUT. */
    @Synchronized fun stageRegistration(request: NativePushRegistrationRequest): Boolean {
        if (!registrationOwnerMatches(request)) return false
        state.pendingRegistration?.let { original ->
            if (!original.same(request)) return false
            ensureDurable(); return true
        }
        if (state.binding?.installation?.binding?.revision?.let { it > request.expectedRevision } == true) return false
        if (state.queuedToken?.let { !it.matches(request) } == true) return false
        // A rotation may need two independent revocations: the confirmed version and the
        // new version whose response was lost. Reserve both before accepting any request.
        check(state.revocations.size + 1 + (if (state.binding == null) 0 else 1) <= LIMIT) {
            "通知撤销记录已满，请先重试原撤销请求"
        }
        require(state.binding?.secret != request.revocationSecret &&
            state.revocations.none { it.savedSecret() == request.revocationSecret }) {
            "新的通知绑定不能沿用旧撤销凭据"
        }
        commit(state.copy(pendingRegistration = request, registrationAttempted = false)); return true
    }

    @Synchronized fun acceptRegistration(request: NativePushRegistrationRequest,
        installation: NativePushInstallation): Boolean {
        if (!registrationOwnerMatches(request) || state.pendingRegistration?.same(request) != true ||
            installation.owner != request.owner || installation.binding != request.targetBinding ||
            installation.lastRequestKey != request.requestKey || !installation.boundToCurrentSession ||
            !installation.isActive(now())) return false
        val remainingToken = state.queuedToken?.takeUnless { it.matches(request) }
        commit(state.copy(binding = SavedBinding(installation, request.revocationSecret),
            pendingRegistration = null, queuedToken = remainingToken, remoteOpen = null,
            observations = emptyList(), registrationAttempted = false,
            registeredToken = NativePushSdkToken(request.contractId, request.provider, request.token), consumedOpens = emptyList()))
        openWriteBlocked = false
        openedSavePending = false
        return true
    }

    /** Caller may invoke only after an independently verified not_committed refusal. */
    @Synchronized fun rejectRegistration(request: NativePushRegistrationRequest): Boolean {
        if (!registrationOwnerMatches(request) || state.pendingRegistration?.same(request) != true) return false
        commit(state.copy(pendingRegistration = null, registrationAttempted = false)); return true
    }

    private fun registrationOwnerMatches(request: NativePushRegistrationRequest) =
        state.owner == request.owner && state.generation == request.generation && state.installationId == request.installationId

    private fun NativePushSdkToken.matches(request: NativePushRegistrationRequest) =
        contractId == request.contractId && provider == request.provider && value == request.token

    /** Call with null on logout or loss of service access, and with the actual new owner on login. */
    @Synchronized fun reconcileOwner(owner: NativePushOwner?) {
        if (state.owner == owner) { ensureDurable(); return }
        retire(owner)
    }

    /** Local stop precedes persistence or network; a failed write never re-enables remote activity. */
    @Synchronized fun disable() { retire(null) }

    private fun retire(nextOwner: NativePushOwner?) {
        val old = state.binding
        val revocations = state.revocations.toMutableList()
        fun retain(owner: NativePushOwner, binding: NativePushBinding, secret: String?) {
            if (revocations.any { it.request.owner == owner && it.request.binding == binding && it.savedSecret() == secret }) return
            check(revocations.size < LIMIT) { "通知撤销记录已满，原绑定仍保留，请先重试撤销" }
            revocations += NativePushRevocationSlot(NativePushRevokeRequest(owner, binding, newKey()), secret)
        }
        if (old != null) retain(old.installation.owner, old.installation.binding, old.secret)
        state.pendingRegistration?.let { retain(it.owner, it.targetBinding, it.revocationSecret) }
        val stopped = state.copy(generation = Math.addExact(state.generation, 1), owner = nextOwner,
            binding = null, revocations = revocations, remoteOpen = null, observations = emptyList(),
            pendingRegistration = null, queuedToken = null, registrationAttempted = false, registeredToken = null, consumedOpens = emptyList())
        // Keep the safe in-memory state even if storage is temporarily locked. pendingRevocations()
        // refuses network handoff until the exact queue has subsequently been saved successfully.
        state = stopped
        openWriteBlocked = false
        openedSavePending = false
        dirty = true
        ensureDurable()
    }

    /** Remember only an independently verified GET/receipt. This never enables Android delivery. */
    @Synchronized fun recordVerifiedInstallation(installation: NativePushInstallation,
        expectedGeneration: Long, revocationSecret: String? = null): Boolean {
        if (expectedGeneration != state.generation || installation.owner != state.owner || state.pendingRegistration != null) return false
        require(installation.boundToCurrentSession && installation.binding.installationId == state.installationId)
        require(installation.lastRequestKey != null)
        NativePushRevokeRequest(installation.owner, installation.binding, installation.lastRequestKey)
        val previous = state.binding
        // Reserve space for retiring this binding. A full revoke queue never blocks logout.
        check(previous != null || state.revocations.size < LIMIT) { "通知撤销记录已满，请先重试原撤销请求" }
        if (previous != null && previous.installation.binding.revision > installation.binding.revision) return false
        if (previous != null && previous.installation.binding == installation.binding &&
            previous.installation.status != NativePushInstallationStatus.ACTIVE &&
            installation.status == NativePushInstallationStatus.ACTIVE) return false
        if (previous != null && previous.installation.binding == installation.binding &&
            revocationSecret != null && previous.secret != null) require(previous.secret == revocationSecret)
        val secret = revocationSecret ?: previous?.takeIf { it.installation.binding == installation.binding }?.secret
        val changedBinding = previous?.installation?.binding != installation.binding
        val invalidateRemoteReferences = changedBinding || !installation.isActive(now())
        commit(state.copy(binding = SavedBinding(installation, secret),
            remoteOpen = state.remoteOpen.takeUnless { invalidateRemoteReferences },
            observations = if (invalidateRemoteReferences) emptyList() else state.observations,
            registeredToken = state.registeredToken.takeUnless { invalidateRemoteReferences },
            consumedOpens = if (invalidateRemoteReferences) emptyList() else state.consumedOpens))
        if (invalidateRemoteReferences) openWriteBlocked = false
        return true
    }

    @Synchronized internal fun captureCallbackContext(): NativePushCallbackContext? {
        ensureDurable()
        val snapshot = state
        val owner = snapshot.owner ?: return null
        val installation = snapshot.binding?.installation ?: return null
        if (installation.owner != owner || !installation.isActive(now())) return null
        return NativePushCallbackContext(owner, installation.binding, snapshot.generation)
    }

    @Synchronized fun capturePendingOpen(): NativePushPendingOpen? {
        ensureDurable()
        check(!openWriteBlocked) { "最新通知打开记录尚未保存，请重试或关闭" }
        val open = state.remoteOpen ?: return null
        if (!current(open.owner, open.binding, state.generation)) return null
        return NativePushPendingOpen(open, state.generation)
    }

    @Synchronized fun isCurrentOpen(open: NativePushRemoteOpen, expectedGeneration: Long): Boolean =
        !dirty && !openWriteBlocked && state.remoteOpen == open && current(open.owner, open.binding, expectedGeneration)

    @Synchronized fun isCurrentObservation(request: NativePushObservationRequest, expectedGeneration: Long): Boolean =
        !dirty && request in state.observations && current(request.owner, request.binding, expectedGeneration)

    /** An invalid newer click can block an old destination only within its captured context. */
    @Synchronized fun blockRemoteOpen(owner: NativePushOwner, binding: NativePushBinding,
        expectedGeneration: Long): Boolean {
        if (!current(owner, binding, expectedGeneration)) return false
        openWriteBlocked = true; openedSavePending = false
        if (state.remoteOpen != null) { state = state.copy(remoteOpen = null); dirty = true }
        ensureDurable()
        return true
    }

    /** A verified terminal GET may retire this exact report; it is not a delivery receipt. */
    @Synchronized fun discardObservation(request: NativePushObservationRequest, expectedGeneration: Long): Boolean {
        if (!isCurrentObservation(request, expectedGeneration)) return false
        commit(state.copy(observations = state.observations - request)); return true
    }

    /** Store the observation and an opened reference together, before dispatch or navigation. */
    @Synchronized fun stageCallback(owner: NativePushOwner, binding: NativePushBinding,
        deliveryId: String, kind: NativePushObservationKind, expectedGeneration: Long): NativePushObservationRequest? {
        if (!current(owner, binding, expectedGeneration)) return null
        NativePushNotificationReference(deliveryId) // Invalid/stale callbacks cannot disturb a valid pending open.
        if (kind == NativePushObservationKind.OPENED) { openWriteBlocked = true; openedSavePending = false }
        if (kind == NativePushObservationKind.OPENED) {
            state.consumedOpens.firstOrNull { it.owner == owner && it.binding == binding && it.deliveryId == deliveryId }?.let { consumed ->
                saveOpened(state.copy(remoteOpen = null))
                return NativePushObservationRequest(owner, binding, deliveryId, kind, consumed.requestKey)
            }
            check(state.consumedOpens.size < CONSUMED_LIMIT) { "通知打开记录已满，请重新核对通知绑定" }
        }
        val original = state.observations.firstOrNull {
            it.owner == owner && it.binding == binding && it.deliveryId == deliveryId && it.kind == kind
        }
        val open = state.remoteOpen?.takeIf { it.owner == owner && it.binding == binding && it.deliveryId == deliveryId }
        if (original == null) check(state.observations.size < LIMIT) { "通知回报记录已满，请先核对原请求" }
        val request = original ?: NativePushObservationRequest(owner, binding, deliveryId, kind,
            if (kind == NativePushObservationKind.OPENED) open?.requestKey ?: newKey() else newKey())
        require(state.observations.none { it.requestKey == request.requestKey && it != request }) {
            "通知回报原请求编号已用于其他记录"
        }
        val nextOpen = if (kind == NativePushObservationKind.OPENED)
            NativePushRemoteOpen(owner, binding, deliveryId, request.requestKey) else state.remoteOpen
        if (original != null && nextOpen == state.remoteOpen && kind != NativePushObservationKind.OPENED) { ensureDurable(); return original }
        val next = state.copy(observations = if (original == null) state.observations + request else state.observations,
            remoteOpen = nextOpen)
        if (kind == NativePushObservationKind.OPENED) saveOpened(next) else commit(next)
        return request
    }

    /** Durable original references only. They cannot authorize registration or UI navigation. */
    @Synchronized fun stageRemoteOpen(owner: NativePushOwner, binding: NativePushBinding,
        deliveryId: String, expectedGeneration: Long): NativePushRemoteOpen? {
        if (!current(owner, binding, expectedGeneration)) return null
        NativePushNotificationReference(deliveryId)
        openWriteBlocked = true; openedSavePending = false
        if (state.consumedOpens.any { it.owner == owner && it.binding == binding && it.deliveryId == deliveryId }) {
            saveOpened(state.copy(remoteOpen = null)); return null
        }
        check(state.consumedOpens.size < CONSUMED_LIMIT) { "通知打开记录已满，请重新核对通知绑定" }
        state.remoteOpen?.takeIf { it.owner == owner && it.binding == binding && it.deliveryId == deliveryId }?.let {
            saveOpened(state); return it
        }
        val open = NativePushRemoteOpen(owner, binding, deliveryId, newKey())
        saveOpened(state.copy(remoteOpen = open))
        return open
    }

    @Synchronized fun stageObservation(request: NativePushObservationRequest,
        expectedGeneration: Long): NativePushObservationRequest? {
        if (!current(request.owner, request.binding, expectedGeneration)) return null
        state.observations.firstOrNull { it.owner == request.owner && it.binding == request.binding &&
            it.deliveryId == request.deliveryId && it.kind == request.kind }?.let { ensureDurable(); return it }
        require(state.observations.none { it.requestKey == request.requestKey }) { "通知回报原请求编号已用于其他记录" }
        check(state.observations.size < LIMIT) { "通知回报记录已满，请先核对原请求" }
        commit(state.copy(observations = state.observations + request))
        return request
    }

    @Synchronized fun pendingObservations(): List<NativePushObservationRequest> {
        ensureDurable()
        return if (state.binding?.installation?.isActive(now()) == true) state.observations.toList() else emptyList()
    }

    @Synchronized fun acceptObservation(request: NativePushObservationRequest, receipt: NativePushObservationReceipt): Boolean {
        if (request !in state.observations || receipt.owner != request.owner || receipt.deliveryId != request.deliveryId ||
            receipt.kind != request.kind || receipt.requestKey != request.requestKey ||
            (if (request.kind == NativePushObservationKind.RECEIVED) receipt.clientReportedReceivedAt == null else receipt.clientReportedOpenedAt == null)) return false
        commit(state.copy(observations = state.observations - request))
        return true
    }

    @Synchronized fun clearRemoteOpen(open: NativePushRemoteOpen): Boolean {
        if (state.remoteOpen != open) return false
        commit(state.copy(remoteOpen = null)); openWriteBlocked = false; openedSavePending = false; return true
    }

    /** Only a verified successful UI consume records durable duplicate suppression. */
    @Synchronized fun acknowledgeRemoteOpen(open: NativePushRemoteOpen, expectedGeneration: Long): Boolean {
        if (!isCurrentOpen(open, expectedGeneration)) return false
        check(state.consumedOpens.size < CONSUMED_LIMIT) { "通知打开记录已满，请重新核对通知绑定" }
        require(state.consumedOpens.none { it.deliveryId == open.deliveryId || it.requestKey == open.requestKey })
        commit(state.copy(remoteOpen = null, consumedOpens = state.consumedOpens + open))
        openWriteBlocked = false; openedSavePending = false; return true
    }

    @Synchronized fun pendingRevocations(): List<NativePushRevocationSlot> {
        ensureDurable(); return state.revocations.toList()
    }

    @Synchronized fun acceptRevoke(slot: NativePushRevocationSlot, receipt: NativePushRevokeReceipt): Boolean {
        val installation = receipt.installation
        if (receipt.requestKey != slot.request.requestKey || installation.owner != slot.request.owner ||
            installation.binding != slot.request.binding || installation.status != NativePushInstallationStatus.REVOKED ||
            !installation.boundToCurrentSession || installation.lastRequestKey != slot.request.requestKey) return false
        return removeExact(slot)
    }

    @Synchronized fun acceptCapability(slot: NativePushRevocationSlot, acceptance: NativePushCapabilityAcceptance): Boolean {
        if (slot.capability == null || acceptance != NativePushCapabilityAcceptance.ACCEPTED_UNVERIFIED) return false
        // The server accepted a permanent revocation tombstone. This is not proof that any
        // installation exists or is revoked; do not change currentBinding or report that claim.
        return removeExact(slot)
    }

    private fun removeExact(slot: NativePushRevocationSlot): Boolean {
        if (state.revocations.none { it.same(slot) }) return false
        commit(state.copy(revocations = state.revocations.filterNot { it.same(slot) }))
        return true
    }
    private fun current(owner: NativePushOwner, binding: NativePushBinding, expectedGeneration: Long) =
        expectedGeneration == state.generation && state.owner == owner && state.binding?.installation?.let {
            it.binding == binding && it.isActive(now())
        } == true
    private fun NativePushInstallation.isActive(at: Instant) = status == NativePushInstallationStatus.ACTIVE && at.isBefore(expiresAt)
    private fun saved() {
        dirty = false
        if (openedSavePending) { openedSavePending = false; openWriteBlocked = false }
    }
    private fun commit(next: State) { store.write(encode(next)); state = next; saved() }
    private fun ensureDurable() { if (dirty) { store.write(encode(state)); saved() } }
    private fun saveOpened(next: State) {
        state = next; dirty = true; openWriteBlocked = true; openedSavePending = true
        ensureDurable()
    }

    private fun encode(value: State): String = JSONObject().put("version", 2).put("remoteEnabled", false)
        .put("installationId", value.installationId).put("generation", value.generation)
        .put("owner", value.owner?.let(::ownerJson) ?: JSONObject.NULL)
        .put("binding", value.binding?.let { saved -> JSONObject().put("owner", ownerJson(saved.installation.owner))
            .put("binding", bindingJson(saved.installation.binding)).put("status", saved.installation.status.name)
            .put("expiresAt", saved.installation.expiresAt.toString()).put("lastRequestKey", saved.installation.lastRequestKey ?: JSONObject.NULL)
            .put("secret", saved.secret ?: JSONObject.NULL) } ?: JSONObject.NULL)
        .put("revocations", JSONArray(value.revocations.map { slot -> requestJson(slot.request.owner, slot.request.binding, slot.request.requestKey)
            .put("body", slot.request.body).put("secret", slot.savedSecret() ?: JSONObject.NULL) }))
        .put("remoteOpen", value.remoteOpen?.let { requestJson(it.owner, it.binding, it.requestKey).put("deliveryId", it.deliveryId) } ?: JSONObject.NULL)
        .put("observations", JSONArray(value.observations.map { requestJson(it.owner, it.binding, it.requestKey)
            .put("deliveryId", it.deliveryId).put("kind", it.kind.name).put("body", it.body) }))
        .put("pendingRegistration", value.pendingRegistration?.toJson() ?: JSONObject.NULL)
        .put("queuedToken", value.queuedToken?.toJson() ?: JSONObject.NULL)
        .put("registrationAttempted", value.registrationAttempted)
        .put("registeredToken", value.registeredToken?.toJson() ?: JSONObject.NULL)
        // Every consumed entry shares the enclosing verified owner/binding. Avoid repeating
        // those UUIDs 256 times so the bounded history fits the 64 KiB encrypted state budget.
        .put("consumedOpens", JSONArray(value.consumedOpens.map {
            JSONObject().put("deliveryId", it.deliveryId).put("requestKey", it.requestKey)
        })).toString()

    private fun decode(raw: String): State = try {
        decodeState(raw)
    } catch (_: Exception) {
        // JSON parser errors can include source text; do not expose a stored capability secret.
        throw IllegalStateException("通知注册恢复记录无法核对，原记录已保留")
    }

    private fun decodeState(raw: String): State {
        val json = JSONObject(raw)
        val version = json.integer("version")
        require(version == 1L || version == 2L)
        val commonKeys = arrayOf("version", "remoteEnabled", "installationId", "generation", "owner", "binding", "revocations", "remoteOpen", "observations")
        if (version == 1L) json.exact(*commonKeys) else json.exact(*commonKeys, "pendingRegistration", "queuedToken", "registrationAttempted", "registeredToken", "consumedOpens")
        require(json.get("remoteEnabled") is Boolean)
        val id = json.string("installationId").also { require(UUID_PATTERN.matches(it)) }
        val generation = json.integer("generation")
        val owner = json.optionalObject("owner")?.let(::parseOwner)
        val binding = json.optionalObject("binding")?.let {
            it.exact("owner", "binding", "status", "expiresAt", "lastRequestKey", "secret")
            val installation = NativePushInstallation(parseOwner(it.getJSONObject("owner")), parseBinding(it.getJSONObject("binding")),
                NativePushInstallationStatus.valueOf(it.string("status")), true, Instant.parse(it.string("expiresAt")), it.nullableString("lastRequestKey"))
            require(installation.owner == owner && installation.binding.installationId == id)
            require(installation.lastRequestKey != null)
            NativePushRevokeRequest(installation.owner, installation.binding, installation.lastRequestKey)
            SavedBinding(installation, it.nullableString("secret"))
        }
        val revocations = json.array("revocations").map {
            it.exact("owner", "binding", "requestKey", "body", "secret")
            val request = NativePushRevokeRequest(parseOwner(it.getJSONObject("owner")), parseBinding(it.getJSONObject("binding")), it.string("requestKey"))
            require(request.binding.installationId == id && request.body == it.string("body"))
            NativePushRevocationSlot(request, it.nullableString("secret"))
        }
        require(revocations.map { it.request.requestKey }.distinct().size == revocations.size)
        val registration = if (version == 1L) null else json.optionalObject("pendingRegistration")?.let { NativePushRegistrationRequest.fromJson(it) }
        val token = if (version == 1L) null else json.optionalObject("queuedToken")?.let { NativePushSdkToken.fromJson(it) }
        val attempted = if (version == 1L) false else json.get("registrationAttempted").let { require(it is Boolean); it }
        val registeredToken = if (version == 1L) null else json.optionalObject("registeredToken")?.let { NativePushSdkToken.fromJson(it) }
        require(token == null || owner != null)
        require(!attempted || registration != null)
        require(registeredToken == null || binding != null && binding.installation.status == NativePushInstallationStatus.ACTIVE)
        if (registration != null) {
            require(registration.owner == owner && registration.generation == generation && registration.installationId == id)
            require(binding == null || binding.installation.binding.revision <= registration.expectedRevision)
            require(binding?.secret != registration.revocationSecret && revocations.none { it.savedSecret() == registration.revocationSecret })
        }
        require(revocations.size + (if (binding == null) 0 else 1) + (if (registration == null) 0 else 1) <= LIMIT)
        val open = json.optionalObject("remoteOpen")?.let {
            it.exact("owner", "binding", "requestKey", "deliveryId")
            NativePushRemoteOpen(parseOwner(it.getJSONObject("owner")), parseBinding(it.getJSONObject("binding")), it.string("deliveryId"), it.string("requestKey"))
        }
        val observations = json.array("observations").map {
            it.exact("owner", "binding", "requestKey", "deliveryId", "kind", "body")
            NativePushObservationRequest(parseOwner(it.getJSONObject("owner")), parseBinding(it.getJSONObject("binding")), it.string("deliveryId"),
                NativePushObservationKind.valueOf(it.string("kind")), it.string("requestKey")).also { request -> require(request.body == it.string("body")) }
        }
        require(observations.map { it.requestKey }.distinct().size == observations.size)
        require(observations.map { it.deliveryId to it.kind }.distinct().size == observations.size)
        require(open == null || open.owner == owner && open.binding == binding?.installation?.binding)
        require(observations.all { it.owner == owner && it.binding == binding?.installation?.binding })
        val consumed = if (version == 1L) emptyList() else json.getJSONArray("consumedOpens").let { array ->
            require(array.length() <= CONSUMED_LIMIT)
            (0 until array.length()).map { index -> array.getJSONObject(index).let {
                it.exact("requestKey", "deliveryId")
                NativePushRemoteOpen(owner ?: error("通知打开身份缺失"), binding?.installation?.binding ?: error("通知打开绑定缺失"),
                    it.string("deliveryId"), it.string("requestKey"))
            } }
        }
        require(consumed.all { it.owner == owner && it.binding == binding?.installation?.binding })
        require(consumed.map { it.deliveryId }.distinct().size == consumed.size && consumed.map { it.requestKey }.distinct().size == consumed.size)
        require(open == null || consumed.none { it.deliveryId == open.deliveryId })
        return State(id, generation, owner, binding, revocations, open, observations, registration, token, attempted, registeredToken, consumed)
    }

    private fun ownerJson(owner: NativePushOwner) = JSONObject().put("employeeId", owner.employeeId).put("staffSessionId", owner.staffSessionId)
    private fun bindingJson(binding: NativePushBinding) = JSONObject().put("installationId", binding.installationId).put("revision", binding.revision)
    private fun requestJson(owner: NativePushOwner, binding: NativePushBinding, key: String) = JSONObject()
        .put("owner", ownerJson(owner)).put("binding", bindingJson(binding)).put("requestKey", key)
    private fun parseOwner(json: JSONObject): NativePushOwner { json.exact("employeeId", "staffSessionId"); return NativePushOwner(json.string("employeeId"), json.string("staffSessionId")) }
    private fun parseBinding(json: JSONObject): NativePushBinding { json.exact("installationId", "revision"); return NativePushBinding(json.string("installationId"), json.integer("revision")) }
    private fun JSONObject.exact(vararg keys: String) { require(keys().asSequence().toSet() == keys.toSet()) { "通知注册恢复字段不兼容" } }
    private fun JSONObject.string(key: String): String = get(key).let { require(it is String && it.length in 1..1024); it }
    private fun JSONObject.nullableString(key: String): String? = if (get(key) == JSONObject.NULL) null else string(key)
    private fun JSONObject.optionalObject(key: String): JSONObject? = if (get(key) == JSONObject.NULL) null else getJSONObject(key)
    private fun JSONObject.integer(key: String): Long = get(key).let { require(it is Int || it is Long); (it as Number).toLong().also { value -> require(value in 0..9_007_199_254_740_991L) } }
    private fun JSONObject.array(key: String): List<JSONObject> { val array = getJSONArray(key); require(array.length() <= LIMIT); return (0 until array.length()).map(array::getJSONObject) }
    private fun newKey() = "native-push-${UUID.randomUUID()}"
    companion object {
        private const val LIMIT = 32
        private const val CONSUMED_LIMIT = 256
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }
}
