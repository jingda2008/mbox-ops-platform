package com.mbox.staff

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.time.Instant
import java.time.LocalDateTime

@Composable
fun ReservationCreateView(m: AppModel, close: () -> Unit) {
    var draft by remember { mutableStateOf(ReservationDraft()) }
    var search by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    val context = LocalContext.current
    fun pick(at: Instant, update: (Instant) -> Unit) {
        val d = at.atZone(ReservationQuery.zone)
        DatePickerDialog(
                context,
                { _, year, month, day ->
                    TimePickerDialog(
                            context,
                            { _, h, min ->
                                update(
                                    LocalDateTime.of(year, month + 1, day, h, min)
                                        .atZone(ReservationQuery.zone)
                                        .toInstant()
                                )
                            },
                            d.hour,
                            d.minute,
                            true,
                        )
                        .show()
                },
                d.year,
                d.monthValue - 1,
                d.dayOfMonth,
            )
            .show()
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("新建预约", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("返回") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("员工代订，负责人为当前员工。提交后核对占位结果；已有开台情况不代表未来可订。", fontSize = 12.sp)
                    OutlinedTextField(
                        draft.name,
                        { draft = draft.copy(name = it) },
                        label = { Text("顾客姓名") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        draft.contact,
                        { draft = draft.copy(contact = it) },
                        label = { Text("联系方式") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row {
                        Text("到店人数 ${draft.people}", Modifier.weight(1f))
                        TextButton(
                            onClick = { draft = draft.copy(people = draft.people - 1) },
                            enabled = draft.people > 1,
                        ) {
                            Text("−")
                        }
                        TextButton(
                            onClick = { draft = draft.copy(people = draft.people + 1) },
                            enabled = draft.people < 200,
                        ) {
                            Text("＋")
                        }
                    }
                    SecondaryAction(
                        onClick = { pick(draft.arrival) { draft = draft.copy(arrival = it) } },
                        enabled = true,
                    ) {
                        Text("到店时间 · " + reservationDraftTime(draft.arrival))
                    }
                    SecondaryAction(
                        onClick = { pick(draft.end) { draft = draft.copy(end = it) } },
                        enabled = true,
                    ) {
                        Text("预计结束 · " + reservationDraftTime(draft.end))
                    }
                    Text("时间按上海时区填写", fontSize = 12.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((id, label) in
                            listOf("phone" to "电话预约", "employee" to "员工代订")) FilterChip(
                            draft.source == id,
                            { draft = draft.copy(source = id) },
                            label = { Text(label) },
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((id, label) in
                            listOf("confirmed" to "确认预约", "pending" to "暂留待确认")) FilterChip(
                            draft.initial == id,
                            { draft = draft.copy(initial = id) },
                            label = { Text(label) },
                        )
                    }
                    var seatMenu by remember { mutableStateOf(false) }
                    val seats =
                        mapOf(
                            "no_preference" to "无偏好",
                            "stage_atmosphere" to "舞台氛围",
                            "quiet_chat" to "安静聊天",
                            "comfortable_booth" to "舒适卡座",
                            "outdoor_view" to "户外景观",
                        )
                    Box {
                        TextButton(onClick = { seatMenu = true }) {
                            Text("位置偏好 · " + seats[draft.seat])
                        }
                        DropdownMenu(seatMenu, { seatMenu = false }) {
                            for ((id, label) in seats) DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    draft = draft.copy(seat = id)
                                    seatMenu = false
                                },
                            )
                        }
                    }
                    OutlinedTextField(
                        draft.note,
                        { draft = draft.copy(note = it) },
                        label = { Text("备注") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("选择桌台 · 已选 ${draft.tables.size} 张")
                    OutlinedTextField(
                        search,
                        { search = it },
                        label = { Text("模糊搜索桌号 / 区域") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("提交时检查同一时段预约冲突；人数超出总容量时请重新选桌。", fontSize = 12.sp)
                    for (t in
                        m.reservationTables.filter {
                            search.isBlank() || (it.code + " " + it.areaName).contains(search, true)
                        }) Panel {
                        Row {
                            Checkbox(
                                t.id in draft.tables,
                                {
                                    draft =
                                        draft.copy(
                                            tables =
                                                if (it) draft.tables + t.id else draft.tables - t.id
                                        )
                                },
                            )
                            Text("${t.code} · ${t.areaName} · ${t.capacity}人")
                        }
                    }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Primary(
                        "下一步 · 核对预约",
                        m.canUseReservations &&
                            m.reservationCapabilities?.optBoolean("durableCreate") == true,
                    ) {
                        try {
                            proposed =
                                draft.command(m.identity ?: error("请重新登录"), m.reservationTables)
                        } catch (e: Exception) {
                            error = e.message ?: "请核对预约"
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text("核对预约") },
            text = { Text(command.steps[0].reservationProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        close()
                        m.executeLive(command)
                    },
                    enabled = m.canExecuteLive(command),
                ) {
                    Text("确认创建预约")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}
