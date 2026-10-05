package com.mbox.staff

fun AppModel.updateInstallBlocked() = updateInstallBlocked(
    requestInFlight = businessRequestInFlight,
    pendingTraining = pending != null,
    pendingOperation = livePending != null,
    pendingOrder = liveOrderPending != null,
    operationStorageDamaged = liveStorageDamaged,
    draftStorageDamaged = draftStorageDamaged,
)

/** Re-evaluated before verification and before opening the system installer. */
fun updateInstallBlocked(
    requestInFlight: Boolean,
    pendingTraining: Boolean,
    pendingOperation: Boolean,
    pendingOrder: Boolean,
    operationStorageDamaged: Boolean,
    draftStorageDamaged: Boolean,
): Boolean =
    requestInFlight || pendingTraining || pendingOperation || pendingOrder ||
        operationStorageDamaged || draftStorageDamaged
