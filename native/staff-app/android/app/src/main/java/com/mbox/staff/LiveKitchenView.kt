package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveKitchenView(m: AppModel, close: () -> Unit) {
    val originalAccess = remember { m.priorityAccessKey }
    val originalWorkspace = remember { m.workspaceVersion }
    LaunchedEffect(m.priorityAccessKey, m.workspaceVersion) {
        if (m.priorityAccessKey != originalAccess || m.workspaceVersion != originalWorkspace) close()
    }
    var station by remember { mutableStateOf("kitchen") }
    var showTasks by remember { mutableStateOf(false) }
    var handoff by remember { mutableStateOf<LiveKitchenHandoff?>(null) }
    var historyVisible by remember { mutableStateOf(false) }
    if(historyVisible) LiveFulfillmentHistoryView(m,"prepared"){historyVisible=false}
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var bulkID by remember { mutableStateOf<String?>(null) }
    bulkID?.let { LiveKitchenBatchView(m, it) { bulkID = null } }
    var error by remember { mutableStateOf("") }
    fun propose(
        action: String,
        id: String,
        quantity: Int = 1,
        equipment: String = "",
        seconds: Int? = null,
        units: Set<String> = emptySet(),
    ) {
        try {
            proposed = m.prepareKitchen(action, id, quantity, equipment, seconds, units)
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请刷新后核对"
        }
    }
    LiveWorkspacePolling(
        m, "kitchen-$station",
        active = proposed == null && handoff == null && !showTasks && !historyVisible && bulkID == null,
    ) { m.loadKitchen(station, automatic = true) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("出品工作台", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { m.loadKitchen(station) }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                Row {
                    FilterChip(
                        station == "kitchen",
                        { station = "kitchen" },
                        enabled = !m.busy,
                        label = { Text("厨房") },
                    )
                    Spacer(Modifier.width(8.dp))
                    FilterChip(
                        station == "bar",
                        { station = "bar" },
                        enabled = !m.busy,
                        label = { Text("吧台") },
                    )
                }
                if(canReadFulfillmentHistory(m.identity))TextButton(onClick={historyVisible=true}){Text("制作与送达历史")}
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.kitchenState.isNotEmpty()) Text(m.kitchenState)
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    }
                    val board = m.kitchenBoard
                    if (board != null && board.station == station) {
                        item {
                            if (!board.canStart) Text("当前暂停新增制作，已有批次可按权限继续处理。", fontSize = 12.sp)
                            if (board.legacy.isNotEmpty())
                                SecondaryAction(onClick = { showTasks = true }) {
                                    Text("旧任务 / 重做 · ${board.legacy.size}项")
                                }
                            Text(
                                "待制作 · ${board.pending.size} 项",
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        items(board.pending, key = { it.id }) { row ->
                            if (
                                board.pending.count {
                                    it.compatibility == row.compatibility && it.canPrepare
                                } > 1
                            )
                                SecondaryAction(
                                    onClick = { bulkID = row.id },
                                    enabled = m.canAct("kds.prepare") && board.canStart,
                                ) {
                                    Text("同品跨桌合批 · " + row.name)
                                }
                            KitchenStartCard(
                                row,
                                board.equipment,
                                m.canAct("kds.prepare") && board.canStart && row.canPrepare,
                            ) { action, quantity, equipment, seconds ->
                                propose(action, row.id, quantity, equipment, seconds)
                            }
                        }
                        item {
                            Text(
                                "制作批次 · ${board.batches.size} 批",
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        items(board.batches, key = { it.id }) { batch ->
                            KitchenTimerView(batch, board.source.getString("generatedAt"))
                            KitchenBatchCard(
                                batch,
                                m.canAct("kds.prepare") &&
                                    batch.employeeID == m.identity?.employeeId,
                            ) { action, units ->
                                propose(action, batch.id, units = units)
                            }
                            if (
                                board.canHandoff &&
                                    batch.employeeID != m.identity?.employeeId &&
                                    m.identity?.allows("kds.exception.manage") == true
                            ) {
                                SecondaryAction(
                                    onClick = { m.loadKitchenHandoff(batch.id) { handoff = it } },
                                    enabled = m.canAct("kds.prepare"),
                                    icon = Icons.Outlined.People,
                                ) {
                                    Text("预览接班范围 · " + batch.name)
                                }
                            }
                        }
                        if (board.pending.isEmpty() && board.batches.isEmpty())
                            item { Text("当前没有制作任务") }
                    }
                }
            }
        }
    }
    if (showTasks)
        LiveFulfillmentView(m) {
            showTasks = false
            m.loadKitchen(station)
        }
    handoff?.let { preview -> LiveKitchenHandoffView(m, preview) { handoff = null } }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text("请按实际制作或备齐份数确认。释放设备不等于商品已完成或已取走。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    }
                ) {
                    Text("核对实物后确认")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun KitchenStartCard(
    row: KitchenPending,
    equipmentLabels: List<String>,
    enabled: Boolean,
    action: (String, Int, String, Int?) -> Unit,
) {
    var quantity by remember(row.id) { mutableIntStateOf(1) }
    var equipment by remember(row.id) { mutableStateOf("") }
    var seconds by remember(row.id) { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    Panel {
        Row {
            Text(row.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text(row.tableCode, color = Ink)
        }
        if (row.specification.isNotEmpty()) Text(row.specification)
        if (row.itemNote.isNotEmpty()) Text("商品备注：${row.itemNote}")
        if (row.orderNote.isNotEmpty()) Text("整单备注：${row.orderNote}")
        Row {
            Text("本次 $quantity / 待制作 ${row.unmade} 份", Modifier.weight(1f))
            TactileIconButton(onClick = { quantity-- }, enabled = quantity > 1) {
                Icon(Icons.Outlined.Remove, "减少")
            }
            TactileIconButton(
                onClick = { quantity++ },
                enabled = quantity < minOf(999, row.unmade),
                prominent = true,
            ) {
                Icon(Icons.Outlined.Add, "增加")
            }
        }
        Box {
            TextButton(onClick = { expanded = true }) {
                Text(if (equipment.isEmpty()) "无需设备" else equipment)
            }
            DropdownMenu(expanded, { expanded = false }) {
                (listOf("") + equipmentLabels).forEach { item ->
                    DropdownMenuItem(
                        text = { Text(if (item.isEmpty()) "无需设备" else item) },
                        onClick = {
                            equipment = item
                            expanded = false
                        },
                    )
                }
            }
        }
        OutlinedTextField(
            seconds,
            { seconds = it },
            label = { Text("预计秒数（可不填，最长36000）") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Primary("开始制作", enabled && (seconds.isEmpty() || seconds.toIntOrNull() in 1..36000)) {
            action("start", quantity, equipment, seconds.toIntOrNull())
        }
        SecondaryAction(
            onClick = { action("quick-ready", quantity, "", null) },
            enabled = enabled,
            icon = Icons.Outlined.CheckCircle,
        ) {
            Text("无需制作 · 已实际备齐")
        }
    }
}

@Composable
private fun KitchenBatchCard(
    batch: KitchenBatch,
    enabled: Boolean,
    action: (String, Set<String>) -> Unit,
) {
    var selected by remember(batch.id) { mutableStateOf<Set<String>>(emptySet()) }
    val selectableUnits = batch.units.filter { it.canReady }.map { it.id }.toSet()
    LaunchedEffect(selectableUnits) { selected = selected.intersect(selectableUnits) }
    Panel {
        Text(batch.name, style = MaterialTheme.typography.titleMedium)
        Text(
            "负责人：${batch.employeeName} · ${batch.equipment ?: "无需设备"}" +
                if (batch.released) " · 已释放" else "",
            fontSize = 12.sp,
        )
        listOf("specification", "itemNote", "orderNote").forEach { key ->
            batch.source.optString(key).takeIf { it.isNotEmpty() }?.let { Text(it) }
        }
        batch.units.forEachIndexed { index, unit ->
            Row {
                Checkbox(
                    unit.id in selected,
                    { checked ->
                        selected = if (checked) selected + unit.id else selected - unit.id
                    },
                    enabled = enabled && unit.canReady,
                )
                Text(
                    "${unit.tableCode} · 第${index + 1}份 · " +
                        if (unit.stopped) "已停止"
                        else if (unit.held) "已暂停"
                        else
                            mapOf(
                                    "unmade" to "待制作",
                                    "started" to "制作中",
                                    "ready" to "已备齐",
                                    "delivered" to "已取送",
                                )[unit.state]
                                .orEmpty(),
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        Primary("确认所选 ${selected.size} 份已实际备齐", enabled && selected.isNotEmpty()) {
            action("ready", selected)
        }
        SecondaryAction(
            onClick = { action("release", emptySet()) },
            enabled = enabled && !batch.released,
            icon = Icons.Outlined.Outbox,
        ) {
            Text("实物已移出 · 释放设备")
        }
    }
}

@Composable
private fun LiveKitchenHandoffView(m: AppModel, preview: LiveKitchenHandoff, close: () -> Unit) {
    var checked by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("接班确认", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text("取消") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        Text(
                            "共 ${preview.batches.size} 批制作、${preview.tasks.size} 项任务，将交给当前员工：${m.staffName}"
                        )
                    }
                    items(preview.lines) { row ->
                        Panel {
                            Text(
                                row.getString("productName") + " · 剩余${row.getInt("remaining")}份",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(row.getJSONArray("tableCodes").strings().joinToString("、"))
                            listOf("specification", "itemNote", "orderNote").forEach { key ->
                                row.getString(key).takeIf { it.isNotEmpty() }?.let { Text(it) }
                            }
                            Text(
                                (if (row.isNull("equipment")) "无需设备"
                                else row.getString("equipment")) +
                                    if (row.getBoolean("released")) " · 已释放" else " · 占用中",
                                fontSize = 12.sp,
                            )
                        }
                    }
                    item {
                        Row {
                            Checkbox(checked, { checked = it })
                            Text("已逐项核对以上实物与制作进度", modifier = Modifier.padding(top = 12.dp))
                        }
                        OutlinedTextField(
                            reason,
                            { reason = it },
                            label = { Text("接班原因（2—1000字）") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                        Primary(
                            "确认按以上完整范围接班",
                            checked && !m.busy && reason.trim().length in 2..1000,
                        ) {
                            try {
                                check(m.canAct("kds.prepare")) { "请返回刷新后重新预览" }
                                val command =
                                    preview.command(m.identity!!, m.kitchenBoard!!, reason, checked)
                                m.executeLive(command)
                                close()
                            } catch (e: Exception) {
                                error = e.message ?: "请重新核对交接范围"
                            }
                        }
                    }
                }
            }
        }
    }
}
