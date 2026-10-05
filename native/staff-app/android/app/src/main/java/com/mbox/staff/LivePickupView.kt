package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LivePickupView(m: AppModel, close: () -> Unit) {
    val originalAccess = remember { m.priorityAccessKey }
    val originalWorkspace = remember { m.workspaceVersion }
    LaunchedEffect(m.priorityAccessKey, m.workspaceVersion) {
        if (m.priorityAccessKey != originalAccess || m.workspaceVersion != originalWorkspace) close()
    }
    var historyVisible by remember { mutableStateOf(false) }
    if(historyVisible) LiveFulfillmentHistoryView(m,"delivered"){historyVisible=false}
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var error by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    fun propose(
        action: String,
        target: String = "",
        units: Set<String> = emptySet(),
        enabled: Boolean = true,
    ) {
        try {
            proposed = m.preparePickup(action, target, units, label, enabled)
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请刷新后核对"
        }
    }
    LiveWorkspacePolling(
        m, "pickup",
        active = proposed == null && !historyVisible && label == (m.pickupBoard?.device?.optString("label") ?: ""),
    ) { m.loadPickup(automatic = true) }
    LaunchedEffect(m.pickupBoard?.device?.optString("label")) {
        label = m.pickupBoard?.device?.optString("label") ?: ""
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("取餐台", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { m.loadPickup() }, enabled = !m.busy) { Text("刷新") }
                    TextButton(onClick = close) { Text("关闭") }
                }
                if(canReadFulfillmentHistory(m.identity))TextButton(onClick={historyVisible=true}){Text("制作与送达历史")}
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.pickupState.isNotEmpty()) Text(m.pickupState)
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    }
                    val board = m.pickupBoard
                    if (board != null) {
                        item {
                            Text(
                                board.device?.let { "取餐设备 · " + it.getString("label") }
                                    ?: "本设备尚未授权取餐"
                            )
                            if (!board.setup.getBoolean("enabled"))
                                Text("新增设备准入已暂停；现有设备以当前操作权限为准。", fontSize = 12.sp)
                            board.attention.forEach {
                                Text(it.getString("message"), fontSize = 12.sp)
                            }
                            Text(
                                "待取餐 · ${board.tables.size}桌",
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        items(board.tables, key = { it.id }) { table ->
                            PickupTableCard(
                                table,
                                m.canAct("kds.deliver") && board.actor.getBoolean("canPickup"),
                            ) {
                                propose("take", table.id, it)
                            }
                        }
                        if (board.tables.isEmpty()) item { Text("当前没有待取餐商品") }
                        item {
                            Foldout("领取记录 · ${board.history.size}笔") {
                                board.history.forEach { receipt ->
                                    Panel {
                                        Text(
                                            "${receipt.code} · ${receipt.quantity}份",
                                            style = MaterialTheme.typography.titleMedium,
                                        )
                                        Text(receipt.source.getString("takenAt"), fontSize = 12.sp)
                                        receipt.units.forEach {
                                            Text(
                                                it.name +
                                                    (if (it.source.getString("kind") == "remake")
                                                        " · 重做"
                                                    else "") +
                                                    " · " +
                                                    it.source.getString("specification")
                                            )
                                        }
                                        if (receipt.undone) Text("已撤回领取")
                                        else if (receipt.canUndo)
                                            SecondaryAction(
                                                onClick = { propose("undo", receipt.id) },
                                                enabled =
                                                    m.canAct("kds.deliver") &&
                                                        board.actor.getBoolean("canUndo"),
                                                icon = Icons.Outlined.Undo,
                                            ) {
                                                Text("实物仍在取餐区 · 撤回本笔全部领取")
                                            }
                                        else
                                            Text(
                                                receipt.source.optString(
                                                    "undoBlockedReason",
                                                    "当前不可撤回",
                                                ),
                                                fontSize = 12.sp,
                                            )
                                    }
                                }
                            }
                        }
                        if (board.actor.getBoolean("canConfigure"))
                            item {
                                Foldout("管理本取餐设备") {
                                    OutlinedTextField(
                                        label,
                                        { label = it },
                                        label = { Text("设备名称（1—40字）") },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    Primary(
                                        "授权为共享取餐屏",
                                        enabled =
                                            m.canAct("staff.access.configure") &&
                                                board.setup.getBoolean("enabled"),
                                        icon = Icons.Outlined.DesktopWindows,
                                    ) {
                                        propose("device")
                                    }
                                    if (board.setup.getBoolean("configured"))
                                        SecondaryAction(
                                            onClick = { propose("device", enabled = false) },
                                            enabled = m.canAct("staff.access.configure"),
                                            icon = Icons.Outlined.PauseCircle,
                                        ) {
                                            Text("停用本设备取餐功能")
                                        }
                                }
                            }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text("取走确认会登记取送完成；撤回会撤销本笔全部领取，必须确认实物仍在取餐区。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    }
                ) {
                    Text(
                        if (
                            org.json.JSONObject(command.steps[0].body).optString("action") == "undo"
                        )
                            "确认全部实物仍在取餐区，撤回领取"
                        else "核对后确认"
                    )
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun PickupTableCard(table: PickupTable, enabled: Boolean, take: (Set<String>) -> Unit) {
    var selected by remember(table.id) { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(table.units.map { it.id }) {
        selected = selected.intersect(table.units.map { it.id }.toSet())
    }
    Panel {
        Text("${table.code} · ${table.units.size}份待取", style = MaterialTheme.typography.titleMedium)
        table.units.forEachIndexed { index, unit ->
            Row {
                Checkbox(
                    unit.id in selected,
                    { checked ->
                        selected = if (checked) selected + unit.id else selected - unit.id
                    },
                    enabled = enabled,
                )
                Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                    Text(
                        "${index + 1}. ${unit.name}" +
                            if (unit.source.getString("kind") == "remake") " · 重做" else ""
                    )
                    listOf(
                            "specification" to "",
                            "itemNote" to "商品备注：",
                            "orderNote" to "整单备注：",
                            "pickupLocation" to "",
                        )
                        .forEach { (key, prefix) ->
                            if (unit.source.getString(key).isNotEmpty())
                                Text(prefix + unit.source.getString(key), fontSize = 12.sp)
                        }
                }
            }
        }
        Primary(
            "确认取走所选 ${selected.size}份",
            enabled = enabled && selected.isNotEmpty(),
            icon = Icons.Outlined.ShoppingBag,
        ) {
            take(selected)
        }
    }
}
