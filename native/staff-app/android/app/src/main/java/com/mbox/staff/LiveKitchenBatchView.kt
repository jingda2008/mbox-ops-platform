package com.mbox.staff

import android.os.SystemClock
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

@Composable
fun LiveKitchenBatchView(m: AppModel, sourceID: String, close: () -> Unit) {
    var selected by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }
    var equipment by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var seconds by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val board = m.kitchenBoard
    val first = board?.pending?.find { it.id == sourceID }
    val rows =
        board?.pending.orEmpty().filter {
            it.compatibility == first?.compatibility && it.canPrepare && it.unmade > 0
        }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    fun propose(action: String) {
        try {
            require(selected.isNotEmpty()) { "请至少选择一项原订单商品" }
            proposed =
                m.prepareKitchen(
                    action,
                    sourceID,
                    equipment = equipment,
                    seconds = seconds.toIntOrNull(),
                    selections = selected,
                )
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请刷新后核对"
        }
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("同品跨桌合批", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("返回") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    Text(first?.name ?: "商品已变化，请返回刷新", fontSize = 18.sp)
                    Text("只列出商品、规格、商品备注及整单备注完全相同的品项。逐桌核对份数后合批，仍分别保留原订单和桌次。", fontSize = 12.sp)
                    for (row in rows) Panel {
                        Row {
                            Checkbox(
                                selected.containsKey(row.id),
                                {
                                    selected =
                                        if (it) selected + (row.id to 1) else selected - row.id
                                },
                            )
                            Text(row.tableCode + " · " + row.source.getString("orderPublicId"))
                        }
                        selected[row.id]?.let { count ->
                            Row {
                                TextButton(
                                    onClick = { selected = selected + (row.id to count - 1) },
                                    enabled = count > 1,
                                ) {
                                    Text("−")
                                }
                                Text("$count / 待制作${row.unmade}份")
                                TextButton(
                                    onClick = { selected = selected + (row.id to count + 1) },
                                    enabled = count < minOf(999, row.unmade),
                                ) {
                                    Text("＋")
                                }
                            }
                        }
                        if (row.specification.isNotEmpty())
                            Text(row.specification, fontSize = 12.sp)
                        if (row.itemNote.isNotEmpty())
                            Text("商品备注：" + row.itemNote, fontSize = 12.sp)
                        if (row.orderNote.isNotEmpty())
                            Text("整单备注：" + row.orderNote, fontSize = 12.sp)
                    }
                    Box {
                        SecondaryAction(onClick = { menu = true }) {
                            Text("设备：" + equipment.ifEmpty { "无需设备" })
                        }
                        DropdownMenu(menu, { menu = false }) {
                            for (item in listOf("") + board?.equipment.orEmpty()) DropdownMenuItem(
                                text = { Text(item.ifEmpty { "无需设备" }) },
                                onClick = {
                                    equipment = item
                                    menu = false
                                },
                            )
                        }
                    }
                    OutlinedTextField(
                        seconds,
                        { seconds = it },
                        label = { Text("预计秒数（可不填，1—36000）") },
                        singleLine = true,
                    )
                    Text("已选${selected.size}个品项 · ${selected.values.sum()}份", fontSize = 18.sp)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Primary(
                        "核对并开始同品合批",
                        m.canAct("kds.prepare") &&
                            selected.isNotEmpty() &&
                            (seconds.isEmpty() || seconds.toIntOrNull() in 1..36000),
                    ) {
                        propose("start")
                    }
                    SecondaryAction(
                        onClick = { propose("quick-ready") },
                        enabled = m.canAct("kds.prepare") && selected.isNotEmpty(),
                    ) {
                        Text("所选商品无需制作 · 已实际备齐")
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text("核对合批") },
            text = { Text(command.title) },
            confirmButton = {
                TextButton(
                    enabled = m.canExecuteLive(command),
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                        close()
                    },
                ) {
                    Text("已核对各桌实物份数，确认")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}

@Composable
fun KitchenTimerView(batch: KitchenBatch, generatedAt: String) {
    val server = assignmentDate(generatedAt)
    val started = batch.source.textOrNull("startedAt")?.let(::assignmentDate)
    var elapsed by remember(batch.id, generatedAt) { mutableStateOf(0L) }
    LaunchedEffect(batch.id, generatedAt) {
        val baseline = SystemClock.elapsedRealtime()
        while (true) {
            elapsed =
                if (server != null && started != null)
                    maxOf(
                        0,
                        java.time.Duration.between(started, server).seconds +
                            (SystemClock.elapsedRealtime() - baseline) / 1000,
                    )
                else 0
            delay(1000)
        }
    }
    if (started != null && batch.units.any { it.state == "started" && !it.stopped }) {
        fun clock(value: Long) = "${value/60}:" + (value % 60).toString().padStart(2, '0')
        val expected =
            if (batch.source.isNull("expectedSeconds")) null
            else batch.source.getInt("expectedSeconds")
        Text(
            "已制作 " +
                clock(elapsed) +
                (expected?.let { limit ->
                    " · " +
                        (if (elapsed < limit) "预计剩余 " else "已超预计 ") +
                        clock(kotlin.math.abs(limit - elapsed))
                } ?: "") +
                "（参考）",
            fontSize = 12.sp,
            color = Ink,
        )
    }
}
