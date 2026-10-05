package com.mbox.staff

import java.util.concurrent.CancellationException

/** Accepted counts durable removal of exact slots, not proof of physical delivery or revocation. */
data class NativePushRevocationResult(
    val remaining: Int,
    val accepted: Int,
    val rateLimited: Boolean,
    val retryAfterSeconds: Long? = null,
)

/**
 * Bounded synchronous recovery; the caller owns IO dispatch, single-flight and retry scheduling.
 * Authentication is never restored here. NativePushClient rechecks the current owner on ordinary
 * calls and uses an independent anonymous transport for the original revocation capability.
 */
class NativePushRevocationRecovery(
    private val lifecycle: NativePushLifecycle,
    private val client: NativePushClient,
) {
    fun run(currentOwner: () -> NativePushOwner? = { null }): NativePushRevocationResult {
        var accepted = 0
        var attemptedSlots = 0
        var rateLimited = false
        var retryAfterSeconds: Long? = null
        val slots = try {
            checkInterrupted()
            lifecycle.pendingRevocations()
        } catch (error: Exception) {
            preserveInterruption(error)
            return NativePushRevocationResult(lifecycle.pendingRevocationCount, 0, false)
        }
        for (slot in slots) {
            if (attemptedSlots >= MAX_SLOTS_PER_RUN) break
            checkInterrupted()
            val sameOwner = try { currentOwner() == slot.request.owner } catch (error: Exception) {
                preserveInterruption(error)
                false
            }
            val capability = slot.capability
            // An old record with no usable capability must not starve later recoverable slots.
            if (!sameOwner && capability == null) continue
            attemptedSlots++
            if (sameOwner) {
                val receipt = try { client.revoke(slot.request) } catch (error: Exception) {
                    preserveInterruption(error)
                    if (error.isRateLimited()) {
                        rateLimited = true; retryAfterSeconds = (error as StaffAPIError).retryAfterSeconds; break
                    }
                    null
                }
                if (receipt != null) {
                    try {
                        if (lifecycle.acceptRevoke(slot, receipt)) accepted++
                    } catch (error: Exception) {
                        preserveInterruption(error)
                        // A valid response with an unconfirmed local save remains pending.
                        // Stop instead of sending further requests that cannot be acknowledged.
                        break
                    }
                    continue
                }
            }
            if (capability == null) continue
            checkInterrupted()
            val acceptance = try { client.revokeCapability(capability) } catch (error: Exception) {
                preserveInterruption(error)
                if (error.isRateLimited()) {
                    rateLimited = true; retryAfterSeconds = (error as StaffAPIError).retryAfterSeconds; break
                }
                continue
            }
            try {
                if (lifecycle.acceptCapability(slot, acceptance)) accepted++
            } catch (error: Exception) {
                preserveInterruption(error)
                break
            }
        }
        return NativePushRevocationResult(lifecycle.pendingRevocationCount, accepted, rateLimited, retryAfterSeconds)
    }

    private fun Exception.isRateLimited() = this is StaffAPIError && (status == 429 || code == "PUSH_RATE_LIMITED")
    private fun checkInterrupted() {
        if (Thread.currentThread().isInterrupted) throw InterruptedException("通知撤销恢复已中断")
    }
    private fun preserveInterruption(error: Exception) {
        if (error is CancellationException || error is InterruptedException || Thread.currentThread().isInterrupted) throw error
    }

    companion object { private const val MAX_SLOTS_PER_RUN = 4 }
}
