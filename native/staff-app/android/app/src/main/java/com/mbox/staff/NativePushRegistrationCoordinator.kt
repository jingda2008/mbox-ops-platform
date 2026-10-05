package com.mbox.staff

import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

enum class NativePushRegistrationOutcome { UNSUPPORTED, STALE, PENDING, REGISTERED, NOT_COMMITTED, RETRY_LATER }

/**
 * Single-flight, bounded registration recovery. The caller serializes its StaffAPI cookie jar and
 * schedules resume on foreground/network recovery. No timers, SDK, or provider selection live here.
 * A production client has no Android contract and exits before storing a token or issuing HTTP.
 */
class NativePushRegistrationCoordinator(
    private val lifecycle: NativePushLifecycle,
    private val client: NativePushClient,
    private val appVersion: String,
    private val elapsedMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val busy = AtomicBoolean(false)
    @Volatile private var retryAt: Long = Long.MIN_VALUE

    fun tokenAvailable(context: NativePushTokenContext, token: NativePushSdkToken): NativePushRegistrationOutcome {
        return safe {
            if (!client.supportsRegistration(token)) return@safe NativePushRegistrationOutcome.UNSUPPORTED
            if (!lifecycle.stageToken(context, token)) NativePushRegistrationOutcome.STALE
            else resume()
        }
    }

    fun resume(): NativePushRegistrationOutcome = safe {
        if (!client.registrationAvailable) return@safe NativePushRegistrationOutcome.UNSUPPORTED
        if (elapsedMillis() < retryAt) return@safe NativePushRegistrationOutcome.RETRY_LATER
        if (!busy.compareAndSet(false, true)) return@safe NativePushRegistrationOutcome.PENDING
        try { recoverOne() } finally { busy.set(false) }
    }

    private fun recoverOne(): NativePushRegistrationOutcome {
        checkInterrupted()
        var request = lifecycle.pendingRegistration()
        if (request == null) {
            val token = lifecycle.queuedToken() ?: return if (lifecycle.captureCallbackContext() != null)
                NativePushRegistrationOutcome.REGISTERED else NativePushRegistrationOutcome.STALE
            if (!client.supportsRegistration(token)) return NativePushRegistrationOutcome.UNSUPPORTED
            val context = NativePushTokenContext(lifecycle.owner ?: return NativePushRegistrationOutcome.STALE, lifecycle.generation)
            val installationId = lifecycle.installationId
            val before = query(context.owner, installationId)
            if (!current(context)) return NativePushRegistrationOutcome.STALE
            request = NativePushRegistrationRequest.prepare(context, installationId, before?.binding?.revision ?: 0, token, appVersion)
            if (!lifecycle.stageRegistration(request)) return NativePushRegistrationOutcome.PENDING
        }
        if (!client.supportsRegistration(NativePushSdkToken(request.contractId, request.provider, request.token)))
            return NativePushRegistrationOutcome.UNSUPPORTED
        val context = NativePushTokenContext(request.owner, request.generation)
        if (!current(context)) return NativePushRegistrationOutcome.STALE
        // Even a 404 can hide another device or an in-flight original PUT. It never clears pending.
        val snapshot = query(request.owner, request.installationId)
        if (!current(context)) return NativePushRegistrationOutcome.STALE
        if (snapshot != null && matches(request, snapshot)) {
            return if (lifecycle.acceptRegistration(request, snapshot)) NativePushRegistrationOutcome.REGISTERED
            else NativePushRegistrationOutcome.PENDING
        }
        // A later or terminal binding is not proof this original request failed. Do not revive it
        // from a historical idempotency receipt; retain its capability for explicit retirement.
        if (snapshot != null && snapshot.binding.revision >= request.targetBinding.revision)
            return NativePushRegistrationOutcome.PENDING
        val wasAttempted = lifecycle.registrationAttempted()
        if (!lifecycle.markRegistrationAttempt(request)) return NativePushRegistrationOutcome.STALE
        checkInterrupted()
        val receipt = try { client.registerAndroid(request) } catch (error: Exception) {
            preserveInterruption(error)
            if (!wasAttempted && current(context) && error.isFirstAttemptNotCommitted() && lifecycle.rejectRegistration(request)) {
                deferRetry(60)
                return NativePushRegistrationOutcome.NOT_COMMITTED
            }
            throw error
        }
        if (!current(context)) return NativePushRegistrationOutcome.STALE
        // A PUT replay can describe a superseded installation. Confirm the current binding before
        // promoting it, even after a valid 200/201 receipt. Failure leaves the exact request intact.
        val confirmed = query(request.owner, request.installationId)
        if (!current(context)) return NativePushRegistrationOutcome.STALE
        return if (confirmed != null && matches(request, confirmed) && receipt.requestKey == request.requestKey &&
            lifecycle.acceptRegistration(request, confirmed)) NativePushRegistrationOutcome.REGISTERED
        else NativePushRegistrationOutcome.PENDING
    }

    private fun query(owner: NativePushOwner, installationId: String): NativePushInstallation? =
        try { client.installation(owner, installationId) } catch (error: StaffAPIError) {
            if (error.status == 404 && error.code == "PUSH_NOT_FOUND") null else throw error
        }

    private fun current(context: NativePushTokenContext) = lifecycle.owner == context.owner && lifecycle.generation == context.generation
    private fun matches(request: NativePushRegistrationRequest, installation: NativePushInstallation) =
        installation.owner == request.owner && installation.binding == request.targetBinding && installation.boundToCurrentSession &&
            installation.lastRequestKey == request.requestKey && installation.status == NativePushInstallationStatus.ACTIVE

    private inline fun safe(block: () -> NativePushRegistrationOutcome): NativePushRegistrationOutcome = try {
        block()
    } catch (error: Exception) {
        preserveInterruption(error)
        if (error is NativePushUnsupportedException) NativePushRegistrationOutcome.UNSUPPORTED
        else {
            val seconds = if (error is StaffAPIError && (error.status == 429 || error.code == "PUSH_RATE_LIMITED"))
                maxOf(60, error.retryAfterSeconds ?: 900) else 60L
            deferRetry(seconds)
            NativePushRegistrationOutcome.RETRY_LATER
        }
    }

    private fun deferRetry(seconds: Long) {
        val now = elapsedMillis()
        val delay = if (seconds > Long.MAX_VALUE / 1000) Long.MAX_VALUE else seconds * 1000
        retryAt = if (now > Long.MAX_VALUE - delay) Long.MAX_VALUE else now + delay
    }

    private fun Exception.isFirstAttemptNotCommitted(): Boolean {
        if (this !is StaffAPIError || commitDisposition != "not_committed") return false
        return when (code) {
            "PUSH_INVALID_REQUEST", "PUSH_PROVIDER_UNSUPPORTED" -> status == 400
            "PUSH_REVISION_CONFLICT", "PUSH_TOKEN_CONFLICT" -> status == 409
            "PUSH_NOT_CONFIGURED" -> status == 503
            else -> false
        }
    }
    private fun checkInterrupted() { if (Thread.currentThread().isInterrupted) throw InterruptedException("通知注册恢复已中断") }
    private fun preserveInterruption(error: Exception) {
        if (error is CancellationException || error is InterruptedException || Thread.currentThread().isInterrupted) throw error
    }
}
