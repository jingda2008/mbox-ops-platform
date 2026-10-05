package com.mbox.staff

import java.util.concurrent.CancellationException
import org.json.JSONObject

/** Captured from the verified local binding, never reconstructed from a provider payload. */
data class NativePushCallbackContext(
    val owner: NativePushOwner,
    val binding: NativePushBinding,
    val generation: Long,
) {
    init { require(generation >= 0) { "通知生命周期代次无效" } }
}

/** STAGED confirms durable callback recovery only, not delivery, navigation or task completion. */
enum class NativePushCallbackOutcome { STAGED, STALE, INVALID, STORAGE_UNAVAILABLE }

/**
 * Vendor-independent SDK seam. It installs no SDK or Android component, performs no network
 * request for notification callbacks, and never treats a payload as task authorization.
 * The adapter must retain its captured context: refreshing it to rescue a late callback would
 * incorrectly attach an old event to a new login or installation revision.
 */
class NativePushCallbackBridge(
    private val lifecycle: NativePushLifecycle,
    private val coordinator: NativePushRegistrationCoordinator? = null,
) {
    /** A missing or unreadable binding cannot be replaced with payload-supplied identity. */
    fun captureContext(): NativePushCallbackContext? = try {
        lifecycle.captureCallbackContext()
    } catch (error: Exception) {
        preserveInterruption(error)
        null
    }

    fun onReceived(context: NativePushCallbackContext, mbox: JSONObject): NativePushCallbackOutcome =
        stage(context, mbox, NativePushObservationKind.RECEIVED)

    fun onOpened(context: NativePushCallbackContext, mbox: JSONObject): NativePushCallbackOutcome =
        stage(context, mbox, NativePushObservationKind.OPENED)

    /** Both first acquisition and SDK rotation use the same guarded registration coordinator. */
    fun onTokenAvailable(context: NativePushTokenContext, token: NativePushSdkToken): NativePushRegistrationOutcome =
        coordinator?.tokenAvailable(context, token) ?: NativePushRegistrationOutcome.UNSUPPORTED

    private fun stage(context: NativePushCallbackContext, mbox: JSONObject,
        kind: NativePushObservationKind): NativePushCallbackOutcome {
        return try {
            val reference = parseNativePushNotification(mbox) ?: run {
                if (kind == NativePushObservationKind.OPENED)
                    lifecycle.blockRemoteOpen(context.owner, context.binding, context.generation)
                return NativePushCallbackOutcome.INVALID
            }
            val staged = lifecycle.stageCallback(context.owner, context.binding, reference.deliveryId,
                kind, context.generation)
            if (staged == null) NativePushCallbackOutcome.STALE else NativePushCallbackOutcome.STAGED
        } catch (error: Exception) {
            preserveInterruption(error)
            // Do not expose exception text: a storage implementation can include saved secrets.
            NativePushCallbackOutcome.STORAGE_UNAVAILABLE
        }
    }

    private fun preserveInterruption(error: Exception) {
        if (error is CancellationException || error is InterruptedException || Thread.currentThread().isInterrupted) throw error
    }
}
