package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

fun printStatus(v: String) =
    mapOf(
        "pending" to "等待打印",
        "printing" to "正在打印",
        "printed" to "打印机已回报成功",
        "failed" to "打印失败",
        "dead" to "任务已停止，核对出纸",
        "cancelled" to "已取消",
        "retry" to "生成失败待恢复",
        "skipped" to "按规则跳过",
    )[v] ?: v

@Composable
fun LivePrintingView(
    m: AppModel,
    orderID: String? = null,
    sessionID: String? = null,
    close: () -> Unit,
) {
    var date by remember {
        mutableStateOf(m.cashier?.date ?: m.financeSummary?.optString("businessDate") ?: "")
    }
    var filter by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    fun propose(kind: String, target: String, reason: String = "", confirmed: Boolean = false) {
        try {
            proposed = m.preparePrint(kind, target, reason, confirmed)
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新票据"
        }
    }
    LaunchedEffect(Unit) { m.loadPrinting() }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.safeDrawingPadding().imePadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    TextButton(onClick = close) { Text("返回") }
                    Text("票据与打印", style = MaterialTheme.typography.titleLarge)
                    LivePendingView(m)
                    Text(m.printState, fontSize = 12.sp)
                    Primary("刷新票据状态", enabled = !m.busy) { m.loadPrinting() }
                }
                item {
                    if (orderID != null)
                        Primary("打印此原订单账单", enabled = m.canUsePrinting) {
                            propose("order", orderID)
                        }
                    if (sessionID != null)
                        Primary("打印整个原桌次账单", enabled = m.canUsePrinting) {
                            propose("table", sessionID)
                        }
                    if (
                        m.identity?.allows("order.bill.print") == true &&
                            m.identity?.allows("reconciliation.view") == true
                    ) {
                        OutlinedTextField(date, { date = it }, label = { Text("营业日 YYYY-MM-DD") })
                        Primary("打印该营业日汇总与明细", enabled = m.canUsePrinting) {
                            propose("report", date)
                        }
                    }
                    if (m.ownPrintJobs.isNotEmpty())
                        Text("最近一次本人打印请求", style = MaterialTheme.typography.titleMedium)
                    m.ownPrintJobs.forEach {
                        Text(
                            "${it.getString("stationCode")} · ${printStatus(it.getString("status"))} · ${it.textOrNull("failureCode") ?: ""}",
                            fontSize = 12.sp,
                        )
                    }
                    OutlinedTextField(
                        filter,
                        { filter = it },
                        label = { Text("筛选已加载小票：订单号、设备、状态") },
                    )
                }
                items(
                    m.printJobs.filter {
                        filter.isBlank() ||
                            listOf(
                                    it.textOrNull("sourceReference") ?: "",
                                    it.textOrNull("printerName") ?: "",
                                    printStatus(it.getString("status")),
                                )
                                .joinToString(" ")
                                .contains(filter, true)
                    },
                    key = { it.getString("id") },
                ) { job ->
                    var reason by remember { mutableStateOf("") }
                    Foldout(
                        "${printStatus(job.getString("status"))} · ${job.optString("sourceReference")}"
                    ) {
                        Text(
                            "${job.optString("printerName")} · ${job.getString("stationCode")} · ${job.optString("connectivityStatus")}",
                            fontSize = 12.sp,
                        )
                        Text("任务 ${job.getString("id")}", fontSize = 12.sp)
                        job.textOrNull("failureCode")?.let {
                            Text("失败信息：$it。检查缺纸、连接和是否已出纸，再选择恢复。", fontSize = 12.sp)
                        }
                        job.textOrNull("printedAt")?.let { Text("回报时间：$it", fontSize = 12.sp) }
                        job.textOrNull("reprintOfJobId")?.let {
                            Text("补打原任务：$it", fontSize = 12.sp)
                        }
                        OutlinedTextField(
                            reason,
                            { reason = it },
                            label = { Text("现场核对及恢复原因（至少3字）") },
                        )
                        if (canRetryPrint(job))
                            Primary("已核对失败 · 重试原任务", enabled = m.canUsePrinting) {
                                propose("retry", job.getString("id"), reason, true)
                            }
                        if (job.getString("status") in listOf("printed", "failed", "dead"))
                            Primary("已现场核对 · 按原小票补打", enabled = m.canUsePrinting) {
                                propose("reprint", job.getString("id"), reason, true)
                            }
                    }
                }
                items(m.printSources, key = { "source-" + it.getString("id") }) { source ->
                    var reason by remember { mutableStateOf("") }
                    Foldout(
                        "票据生成 · ${source.getString("ticketKind")} · ${printStatus(source.getString("status"))}"
                    ) {
                        Text(
                            "${source.getString("createdAt")} · ${source.textOrNull("lastErrorCode") ?: "等待生成"}",
                            fontSize = 12.sp,
                        )
                        if (source.getString("status") in listOf("retry", "dead")) {
                            OutlinedTextField(
                                reason,
                                { reason = it },
                                label = { Text("已修复问题和恢复原因") },
                            )
                            Primary("恢复原票据生成", enabled = m.canUsePrinting) {
                                propose("source-retry", source.getString("id"), reason)
                            }
                        }
                    }
                }
                item {
                    if (m.printJobs.isEmpty() && m.ownPrintJobs.isEmpty())
                        Text("当前权限下没有已加载的打印任务；不代表订单没有收退款。", fontSize = 12.sp)
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = {
                Text(
                    command.steps[0].printProof!!.getString("confirmation"),
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    },
                    enabled = m.canExecuteLive(command),
                ) {
                    Text("确认以上打印操作")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } },
        )
    }
}
