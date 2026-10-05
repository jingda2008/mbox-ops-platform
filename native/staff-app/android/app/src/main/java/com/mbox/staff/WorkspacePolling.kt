package com.mbox.staff

import androidx.compose.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive

data class WorkspaceReadIdentity(
    val employee: String?,
    val session: String?,
    val access: String,
    val workspace: Int,
)

fun AppModel.workspaceReadIdentity() =
    WorkspaceReadIdentity(identity?.employeeId, identity?.sessionId, priorityAccessKey, workspaceVersion)

/** A completed read from an old login must never refill a cleared or different employee's screen. */
suspend fun <T> readCurrentWorkspace(
    expected: WorkspaceReadIdentity,
    current: () -> WorkspaceReadIdentity,
    read: suspend () -> T,
): T {
    if (expected != current()) throw CancellationException("工作岗位已变化，取消旧队列读取")
    val result = read()
    currentCoroutineContext().ensureActive()
    if (expected != current()) throw CancellationException("工作岗位已变化，忽略旧队列返回")
    return result
}

/** Immediate first read, then bounded foreground reads; writes keep their existing exclusive lock. */
suspend fun pollVisibleWorkspace(
    visible: () -> Boolean,
    canRead: () -> Boolean,
    refresh: () -> Unit,
    pause: suspend () -> Unit = { delay(5_000) },
) {
    while (currentCoroutineContext().isActive && visible()) {
        if (canRead()) refresh()
        pause()
    }
}

@Composable
fun LiveWorkspacePolling(m: AppModel, key: String, active: Boolean = true, refresh: () -> Unit) {
    val latestRefresh by rememberUpdatedState(refresh)
    LaunchedEffect(m.foreground, m.workspaceVersion, m.priorityAccessKey, key, active) {
        if (m.foreground && active) {
            pollVisibleWorkspace(
                visible = { m.foreground && m.live && m.identity != null },
                canRead = { !m.busy },
                refresh = { latestRefresh() },
            )
        }
    }
}
