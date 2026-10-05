package com.mbox.staff

import java.util.concurrent.CancellationException

data class NativePushPendingOpen(val open: NativePushRemoteOpen, val generation: Long)
data class NativePushVerifiedOpen(val open: NativePushRemoteOpen, val generation: Long, val target: NativePushTarget)
enum class NativePushOpenOutcome { NONE, RESOLVED, STALE, EXPIRED, UNAVAILABLE, UNKNOWN, STORAGE_UNAVAILABLE, RATE_LIMITED }
data class NativePushOpenResolution(
    val outcome: NativePushOpenOutcome,
    val verified: NativePushVerifiedOpen? = null,
    val retryAfterSeconds: Long? = null,
)
data class NativePushObservationFlushResult(
    val remaining: Int,
    val accepted: Int,
    val rateLimited: Boolean,
    val retryAfterSeconds: Long? = null,
    val discarded: Int = 0,
)

/**
 * Provider-independent recovery of references already stored in the notification vault.
 * No registration, SDK, navigation, task mutation, invented received event or local 24-hour
 * authorization is performed. The caller owns IO serialization and retry scheduling.
 */
class NativePushDeliveryRecovery(
    private val lifecycle: NativePushLifecycle,
    private val client: NativePushClient,
) {
    /** Each POST re-resolves its original delivery and rechecks the captured local generation. */
    fun flushObservations(currentOwner: () -> NativePushOwner? = { null }): NativePushObservationFlushResult {
        var accepted = 0
        var discarded = 0
        var limited = false
        var retryAfter: Long? = null
        val context: NativePushCallbackContext
        val requests: List<NativePushObservationRequest>
        try {
            interrupted()
            context = lifecycle.captureCallbackContext()
                ?: return NativePushObservationFlushResult(lifecycle.pendingObservationCount, 0, false)
            requests = lifecycle.pendingObservations()
        } catch (error: Exception) {
            preserveInterruption(error)
            return NativePushObservationFlushResult(lifecycle.pendingObservationCount, 0, false)
        }
        var attempted = 0
        for (request in requests) {
            if (attempted >= MAX_OBSERVATIONS_PER_RUN) break
            var postStarted = false
            fun stillCurrent() = currentOwner() == request.owner &&
                request.owner == context.owner && request.binding == context.binding &&
                lifecycle.isCurrentObservation(request, context.generation)
            try {
                interrupted()
                if (!stillCurrent()) break
                attempted++
                val receipt = client.observe(request, beforePost = {
                    interrupted(); stillCurrent().also { if (it) postStarted = true }
                })
                if (!stillCurrent()) break
                if (lifecycle.acceptObservation(request, receipt)) accepted++
            } catch (error: Exception) {
                preserveInterruption(error)
                val apiError = error as? StaffAPIError
                val terminalTarget = !postStarted && ((apiError?.status == 404 && apiError.code == "PUSH_NOT_FOUND") ||
                    (apiError?.status == 410 && apiError.code == "PUSH_TARGET_EXPIRED"))
                if (terminalTarget) {
                    try {
                        if (!stillCurrent() || !lifecycle.discardObservation(request, context.generation)) break
                        discarded++; continue
                    } catch (saveError: Exception) {
                        preserveInterruption(saveError); break
                    }
                }
                if (error.isRateLimited()) {
                    limited = true; retryAfter = (error as StaffAPIError).retryAfterSeconds
                }
                // Unknown outcome, stale authority, or failed local acknowledgement keeps the
                // original request. Do not send more work that cannot safely be acknowledged.
                break
            }
        }
        return NativePushObservationFlushResult(lifecycle.pendingObservationCount, accepted, limited, retryAfter, discarded)
    }

    /** Every invocation performs a fresh authenticated GET, including repeated clicks. */
    fun resolvePendingOpen(currentOwner: () -> NativePushOwner? = { null }): NativePushOpenResolution {
        val pending = try {
            interrupted()
            lifecycle.capturePendingOpen() ?: return NativePushOpenResolution(NativePushOpenOutcome.NONE)
        } catch (error: Exception) {
            preserveInterruption(error)
            return NativePushOpenResolution(NativePushOpenOutcome.STORAGE_UNAVAILABLE)
        }
        val open = pending.open
        fun stillCurrent() = currentOwner() == open.owner && lifecycle.isCurrentOpen(open, pending.generation)
        return try {
            if (!stillCurrent()) return NativePushOpenResolution(NativePushOpenOutcome.STALE)
            val target = client.target(open.owner, open.deliveryId, open.binding)
            interrupted()
            if (!stillCurrent()) NativePushOpenResolution(NativePushOpenOutcome.STALE)
            else NativePushOpenResolution(NativePushOpenOutcome.RESOLVED,
                NativePushVerifiedOpen(open, pending.generation, target))
        } catch (error: Exception) {
            preserveInterruption(error)
            val current = try { stillCurrent() } catch (checkError: Exception) {
                preserveInterruption(checkError); false
            }
            if (!current) return NativePushOpenResolution(NativePushOpenOutcome.STALE)
            val status = (error as? StaffAPIError)?.status
            if (status == 404 || status == 410) {
                try {
                    if (!lifecycle.clearRemoteOpen(open)) return NativePushOpenResolution(NativePushOpenOutcome.STALE)
                } catch (saveError: Exception) {
                    preserveInterruption(saveError)
                    return NativePushOpenResolution(NativePushOpenOutcome.STORAGE_UNAVAILABLE)
                }
                NativePushOpenResolution(if (status == 410) NativePushOpenOutcome.EXPIRED else NativePushOpenOutcome.UNAVAILABLE)
            } else if (error.isRateLimited()) NativePushOpenResolution(NativePushOpenOutcome.RATE_LIMITED,
                retryAfterSeconds = (error as StaffAPIError).retryAfterSeconds)
            else NativePushOpenResolution(if (status == 401 || status == 403) NativePushOpenOutcome.UNAVAILABLE else NativePushOpenOutcome.UNKNOWN)
        }
    }

    private fun Exception.isRateLimited() = this is StaffAPIError && (status == 429 || code == "PUSH_RATE_LIMITED")
    private fun interrupted() {
        if (Thread.currentThread().isInterrupted) throw InterruptedException("通知回报恢复已中断")
    }
    private fun preserveInterruption(error: Exception) {
        if (error is CancellationException || error is InterruptedException || Thread.currentThread().isInterrupted) throw error
    }

    companion object { private const val MAX_OBSERVATIONS_PER_RUN = 4 }
}
