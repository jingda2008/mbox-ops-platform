package com.mbox.staff

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveSongsView(m: AppModel, close: () -> Unit) {
    val original = remember { m.priorityAccessKey }
    val workspace = remember { m.workspaceVersion }
    var filter by remember { mutableStateOf(m.songFilter) }
    var selected by remember { mutableStateOf<LiveSong?>(null) }
    var action by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var evidence by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    LaunchedEffect(m.priorityAccessKey, m.workspaceVersion) { if(original != m.priorityAccessKey || workspace != m.workspaceVersion) close() }
    LaunchedEffect(Unit) { m.loadSongs() }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row { Text("演出与点歌", Modifier.weight(1f), fontSize = 22.sp); TextButton(onClick = close) { Text("关闭") } }
                    Text(m.songState, fontSize = 12.sp)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SongCommands.statuses.forEach { (key, label) -> FilterChip(filter == key, { filter = key }, label = { Text(label) }) }
                    }
                    PrimaryAction(enabled = !m.busy, onClick = { m.loadSongs(filter) }) { Text("读取点歌队列") }
                    if(filter != m.songFilter) Text("筛选已改变，请读取新队列", color = MaterialTheme.colorScheme.error)
                    LivePendingView(m)
                    m.performances?.let { daily ->
                        Foldout("今日演出 · ${daily.optString("localDate")}") {
                            daily.getJSONArray("schedules").objects().forEach { s ->
                                Text(s.getString("performerStageName") + " · " + (mapOf("scheduled" to "待演出", "performing" to "演出中", "completed" to "已完成", "cancelled" to "已取消")[s.getString("status")] ?: "状态待核对"))
                                Text(reservationTime(s.getString("startsAt")) + " — " + reservationTime(s.getString("endsAt")), fontSize = 12.sp)
                            }
                            if(daily.getJSONArray("schedules").length() == 0) Text("今日暂无演出安排")
                        }
                    }
                    if(m.songs.isEmpty() && !m.busy) Text("当前查询没有点歌记录")
                }
                items(m.songs, key = { it.id }) { row ->
                    Panel {
                        Text(row.title, fontSize = 19.sp)
                        val table = m.world.tables.firstOrNull { it.session == row.session }
                        Text("${table?.code?.let { "$it 桌" } ?: "历史桌次 ${row.session.takeLast(8)}"} · ${row.statusLabel}")
                        if(row.amount != null) Text("报价 ${historyMoney(row.amount)}")
                        row.source.optString("note", "").takeIf { it.isNotBlank() && it != "null" }?.let { Text(it) }
                        Text("提交 ${reservationTime(row.source.getString("createdAt"))}", fontSize = 12.sp)
                        m.identity?.let { actor -> row.actions(actor).forEach { next ->
                            SecondaryAction(enabled = m.canUseSongs && filter == m.songFilter, onClick = {
                                selected = row; action = next; reason = ""; amount = ""; evidence = null; error = ""
                                if(next == "paid") m.loadSongEvidence(row.id)
                            }) { Text(SongCommands.labels.getValue(next)) }
                        } }
                    }
                }
            }
        }
    }
    selected?.let { row ->
        AlertDialog(onDismissRequest = { selected = null }, title = { Text("${SongCommands.labels[action]} · ${row.title}") }, text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if(action == "confirm") item { OutlinedTextField(amount, { amount = it }, label = { Text("报价（元），免费填0") }, singleLine = true) }
                if(action == "paid") {
                    item { Text("选择本桌次已收妥、金额与报价相同的付款；必须核对确实用于这首点歌。此处不发起扣款。") }
                    items(if(m.songEvidenceID == row.id) m.songEvidence else emptyList()) { payment ->
                        val key = payment.getString("reconciliationEntryId")
                        FilterChip(evidence == key, { evidence = key }, label = { Text(payment.getString("publicId") + " · " + historyMoney(payment.getLong("amountMinor"))) })
                        Text(reservationTime(payment.getString("createdAt")) + " · " + payment.getString("provider"), fontSize = 12.sp)
                    }
                    item {
                        if(!m.busy && m.songEvidenceID == row.id && m.songEvidence.isEmpty()) Text("没有符合条件的原付款。请在收银工作台核对实际收款及对账状态后刷新。")
                        TextButton(onClick = { m.loadSongEvidence(row.id) }, enabled = m.canUseSongs) { Text("重新读取凭证") }
                    }
                }
                item { OutlinedTextField(reason, { reason = it }, label = { Text("处理说明") }); if(error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error) }
            }
        }, confirmButton = {
            TextButton(enabled = m.canUseSongs, onClick = {
                try { proposed = m.prepareSong(row.id, action, reason, amount, evidence); selected = null }
                catch(e: Exception) { error = e.message ?: "请重新核对" }
            }) { Text("下一步 · 核对") }
        }, dismissButton = { TextButton(onClick = { selected = null }) { Text("返回") } })
    }
    proposed?.let { command ->
        AlertDialog(onDismissRequest = { proposed = null }, title = { Text(command.title) }, text = { Text(command.steps.single().songProof!!.getString("confirmation")) },
            confirmButton = { TextButton(enabled = m.canExecuteLive(command), onClick = { proposed = null; m.executeLive(command) }) { Text("确认执行") } },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } })
    }
}
