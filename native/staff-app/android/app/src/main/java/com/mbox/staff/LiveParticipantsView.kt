package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveParticipantsView(m: AppModel, tableID: String, close: () -> Unit) {
    var kind by remember { mutableStateOf("participant_split") }
    var target by remember { mutableStateOf("") }
    var targetMenu by remember { mutableStateOf(false) }
    var quantity by remember { mutableStateOf("1") }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var reason by remember { mutableStateOf("") }
    var capacityReason by remember { mutableStateOf("") }
    var confirmed by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(tableID) { m.loadParticipants(tableID) }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    val source = m.liveOperations?.tables?.find { it.display.id == tableID }
    val targets =
        m.liveOperations
            ?.tables
            .orEmpty()
            .filter {
                it.display.id != tableID &&
                    if (kind == "participant_split")
                        it.status == "available" && it.display.session == null
                    else it.sessionStatus == "open"
            }
            .sortedBy { it.display.code }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("人员拆并桌", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(
                        onClick = {
                            selected = emptySet()
                            confirmed = false
                            m.loadParticipants(tableID)
                        },
                        enabled = !m.busy,
                    ) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    Text(m.participantState, fontSize = 12.sp)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    if (source != null && source.display.session != null) {
                        Text(
                            "${source.display.code} · 当前${source.display.people}人",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        val preview = m.participantPreview
                        val input = m.participantInput
                        if (preview != null && input != null) {
                            Panel {
                                Text(
                                    "${input.sourceCode} → ${input.targetCode} · ${input.quantity}人"
                                )
                                Text(
                                    preview.source.getString("accountingBoundary"),
                                    fontSize = 12.sp,
                                )
                                Text(
                                    "目标桌 ${preview.source.getInt("projectedGuestCount")} / ${preview.source.getInt("targetCapacity")}人"
                                )
                                Text("现场原因：${input.reason}")
                                if (input.capacityReason.isNotEmpty())
                                    Text("加座说明：${input.capacityReason}")
                                preview.blockers.forEach {
                                    Text(
                                        "${it.getString("label")} ${it.getInt("count")}项；${it.getString("resolution")}",
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                                preview.adjustments.forEach {
                                    Text("主联系人调整：" + it.getString("reason"), fontSize = 12.sp)
                                }
                                Row {
                                    Checkbox(confirmed, { confirmed = it })
                                    Text("已当面确认顾客、人数及目标桌，移动后让顾客重新扫码")
                                }
                                Primary(
                                    "核对并执行人员调整",
                                    enabled =
                                        m.canUseParticipants &&
                                            confirmed &&
                                            preview.blockers.isEmpty() &&
                                            preview.enabled,
                                ) {
                                    runCatching { m.prepareParticipants(confirmed) }
                                        .onSuccess {
                                            proposed = it
                                            error = ""
                                        }
                                        .onFailure { error = it.message ?: "请重新预检" }
                                }
                                SecondaryAction(
                                    onClick = {
                                        m.resetParticipantPreview()
                                        confirmed = false
                                    },
                                    enabled = !m.busy && m.livePending == null,
                                ) {
                                    Text("返回修改")
                                }
                            }
                        } else {
                            Row {
                                for ((value, label) in
                                    listOf(
                                        "participant_split" to "拆到空桌",
                                        "participant_merge" to "并入营业桌",
                                    )) {
                                    FilterChip(
                                        kind == value,
                                        {
                                            kind = value
                                            selected = emptySet()
                                            target = ""
                                            capacityReason = ""
                                            confirmed = false
                                        },
                                        label = { Text(label) },
                                    )
                                    Spacer(Modifier.width(8.dp))
                                }
                            }
                            Text("只移动所选顾客的位置；历史订单、付款、任务和观察留在原桌次。", fontSize = 12.sp)
                            if (kind == "participant_merge" && m.participants.isNotEmpty())
                                SecondaryAction(
                                    onClick = {
                                        selected = m.participants.map { it.id }.toSet()
                                        quantity = source.display.people.toString()
                                    }
                                ) {
                                    Text("选择全员 · ${source.display.people}人")
                                }
                            m.participants.forEachIndexed { index, row ->
                                Row {
                                    Checkbox(
                                        row.id in selected,
                                        {
                                            selected =
                                                if (it) selected + row.id else selected - row.id
                                        },
                                    )
                                    Column {
                                        Text(row.label + " ${index+1}")
                                        Text(row.detail, fontSize = 12.sp)
                                    }
                                }
                            }
                            OutlinedTextField(
                                quantity,
                                { quantity = it },
                                label = { Text("实际移动人数") },
                                keyboardOptions =
                                    KeyboardOptions(keyboardType = KeyboardType.Number),
                            )
                            Box {
                                SecondaryAction(onClick = { targetMenu = true }) {
                                    Text(
                                        targets.find { it.display.id == target }?.display?.code
                                            ?: "请选择目标桌"
                                    )
                                }
                                DropdownMenu(targetMenu, { targetMenu = false }) {
                                    targets.forEach { row ->
                                        DropdownMenuItem(
                                            text = {
                                                Text(
                                                    row.display.code +
                                                        if (row.display.session == null) " · 空闲"
                                                        else " · ${row.display.people}人"
                                                )
                                            },
                                            onClick = {
                                                target = row.display.id
                                                targetMenu = false
                                            },
                                        )
                                    }
                                }
                            }
                            OutlinedTextField(
                                reason,
                                { reason = it },
                                label = { Text("现场原因（2—1000字）") },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                capacityReason,
                                { capacityReason = it },
                                label = { Text("超容量时填写加座与通道确认说明") },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text("容量足够时无需填写加座说明；预检会提示实际容量。", fontSize = 12.sp)
                            Primary(
                                "下一步 · 检查未结业务",
                                enabled =
                                    !m.busy && m.livePending == null && m.liveOrderPending == null,
                            ) {
                                runCatching {
                                        ParticipantInput.make(
                                            m.identity ?: error("请先登录"),
                                            source,
                                            targets.find { it.display.id == target }
                                                ?: error("请选择目标桌"),
                                            m.participants,
                                            selected,
                                            quantity.toIntOrNull() ?: 0,
                                            kind,
                                            reason,
                                            capacityReason,
                                        )
                                    }
                                    .onSuccess {
                                        error = ""
                                        confirmed = false
                                        m.previewParticipants(it)
                                    }
                                    .onFailure { error = it.message ?: "请核对输入" }
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
            text = { Text(command.steps[0].participantProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    },
                    enabled = m.canExecuteLive(command),
                ) {
                    Text("确认执行")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}
