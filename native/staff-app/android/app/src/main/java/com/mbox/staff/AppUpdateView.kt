package com.mbox.staff

import android.os.Build
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun AppUpdateView(m: AppModel) {
    val updater = m.updater
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf(false) }
    fun blocked() =
        m.busy ||
            m.pending != null ||
            m.livePending != null ||
            m.liveOrderPending != null ||
            m.liveStorageDamaged
    Text("当前版本 ${updater.currentVersion}（${updater.currentBuild}）")
    Text(if (updater.checking) "正在检查更新…" else updater.status, fontSize = 12.sp)
    SecondaryAction(
        onClick = { scope.launch { updater.check(true) } },
        enabled = !updater.checking && !updater.downloading && !updater.installing,
        icon = Icons.Outlined.Refresh,
    ) {
        Text("检查更新")
    }
    updater.release?.let { release ->
        Text("${if (release.priority == "urgent") "建议尽快更新" else "新版本"} · ${release.version}")
        Text(release.notes)
        if (Build.VERSION.SDK_INT < release.minimumOS)
            Text("此版本需要 Android API ${release.minimumOS} 或以上，请先升级系统。")
        else {
            if (updater.downloading) Text("下载进度 ${updater.percent}%")
            if (blocked()) Text("请先完成当前操作并核对未决结果，再安装更新。", fontSize = 12.sp)
            Primary(
                if (updater.ready) "安装更新" else "下载更新",
                enabled =
                    !updater.downloading && !updater.checking && !updater.installing && !blocked(),
                icon = Icons.Outlined.SystemUpdate,
            ) {
                confirm = true
            }
        }
    }
    Text("由系统确认安装，无需卸载旧版。取消或下载失败可重试，原业务记录保留。", fontSize = 12.sp)
    if (confirm)
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(if (updater.ready) "安装新版本？" else "下载新版本？") },
            text = { Text("请先完成当前业务。下载会使用网络流量；安装可能关闭应用，请勿卸载旧版。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        if (!blocked())
                            scope.launch {
                                if (updater.ready) updater.install(::blocked)
                                else updater.download()
                            }
                    }
                ) {
                    Text("继续")
                }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("取消") } },
        )
}
