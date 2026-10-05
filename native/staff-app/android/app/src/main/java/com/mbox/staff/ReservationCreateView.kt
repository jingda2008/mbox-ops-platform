package com.mbox.staff

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.horizontalScroll
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
import java.time.temporal.ChronoUnit

internal val reservationSeatPreferences = linkedMapOf(
    "no_preference" to "无位置偏好",
    "stage_atmosphere" to "舞台氛围",
    "quiet_chat" to "安静聊天",
    "comfortable_booth" to "舒适卡座",
    "outdoor_view" to "户外景观",
)

@Composable
fun ReservationCreateView(m: AppModel, close: () -> Unit) {
    // Contact stays in this in-memory form until the secured original command is submitted.
    var draft by remember {
        val arrival = Instant.now().plusSeconds(3600).truncatedTo(ChronoUnit.MINUTES)
        mutableStateOf(ReservationReceptionDraft(arrival, arrival.plusSeconds(7200)))
    }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var seatMenu by remember { mutableStateOf(false) }
    val version = remember { m.workspaceVersion }
    val supported = m.reservationCapabilities?.opt("admissionCreateV1") == true &&
        m.reservationCapabilities?.opt("receptionSeatV1") == true
    val editable = !m.busy && m.livePending == null && m.liveOrderPending == null
    val options = m.receptionOptions?.takeIf { it.arrival == draft.arrival && it.end == draft.end }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(Unit) { if (supported) m.loadReceptionOptions(draft.arrival, draft.end) }
    val context = LocalContext.current
    fun pick(at: Instant, update: (Instant) -> Unit) {
        val d = at.atZone(ReservationQuery.zone)
        DatePickerDialog(
            context,
            { _, year, month, day ->
                TimePickerDialog(
                    context,
                    { _, hour, minute ->
                        update(LocalDateTime.of(year, month + 1, day, hour, minute)
                            .atZone(ReservationQuery.zone).toInstant())
                        error = ""
                    },
                    d.hour, d.minute, true,
                ).show()
            },
            d.year, d.monthValue - 1, d.dayOfMonth,
        ).show()
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("新建预约", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("返回") }
                }
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("先登记人数、时段和位置偏好；到店后核对实际桌位。预约不预占具体桌台。", fontSize = 12.sp)
                    if (!supported) {
                        Text("后台尚未启用新版预约，请联系管理员升级后刷新。", color = MaterialTheme.colorScheme.error)
                        Text("当前不能新建预约；原有未决请求仍可在预约列表核对。", fontSize = 12.sp)
                    }
                    OutlinedTextField(draft.name, { draft = draft.copy(name = it) },
                        label = { Text("顾客姓名") }, singleLine = true, enabled = editable && supported,
                        modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(draft.contact, { draft = draft.copy(contact = it) },
                        label = { Text("联系方式") }, singleLine = true, enabled = editable && supported,
                        supportingText = { Text("提交后加密保存，列表仅显示受保护的联系方式。") },
                        modifier = Modifier.fillMaxWidth())
                    Row {
                        Text("到店人数 ${draft.people} 人", Modifier.weight(1f))
                        TextButton(onClick = { draft = draft.copy(people = draft.people - 1) },
                            enabled = editable && supported && draft.people > 1) { Text("−") }
                        TextButton(onClick = { draft = draft.copy(people = draft.people + 1) },
                            enabled = editable && supported && draft.people < 200) { Text("＋") }
                    }
                    SecondaryAction(onClick = { pick(draft.arrival) { draft = draft.copy(arrival = it) } },
                        enabled = editable && supported) { Text("到店时间 · " + reservationDraftTime(draft.arrival)) }
                    SecondaryAction(onClick = { pick(draft.end) { draft = draft.copy(end = it) } },
                        enabled = editable && supported) { Text("预计结束 · " + reservationDraftTime(draft.end)) }
                    Text("请核对到店和结束时间，均按上海时区填写。", fontSize = 12.sp)
                    SecondaryAction(onClick = { error = ""; m.loadReceptionOptions(draft.arrival, draft.end) },
                        enabled = editable && supported) { Text(if (options == null) "查询所选时段容量" else "重新核对时段容量") }
                    if (m.receptionState.isNotBlank()) Text(m.receptionState, fontSize = 12.sp)
                    if (options == null) {
                        Text("提交前须读取与所选时段一致的预约政策和容量。", fontSize = 12.sp)
                    } else {
                        Panel {
                            Text("可预约 ${options.remainingGuests} 人 / 总容量 ${options.totalGuests} 人",
                                style = MaterialTheme.typography.titleMedium)
                            Text("此时段已预约 ${options.committedGuests} 人", fontSize = 12.sp)
                            Text("最多提前 ${options.maxAdvanceDays} 天 · 默认时长 ${options.defaultDurationMinutes} 分钟 · 到店宽限 ${options.arrivalGraceMinutes} 分钟",
                                fontSize = 12.sp)
                            Text("容量会变化，以提交后的服务器确认结果为准。", fontSize = 12.sp)
                            if (draft.people > options.remainingGuests)
                                Text("所选时段余量不足，请调整人数或时段后重新查询。", color = MaterialTheme.colorScheme.error)
                        }
                    }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((id, label) in listOf("phone" to "电话预约", "employee" to "员工代订"))
                            FilterChip(draft.source == id, { draft = draft.copy(source = id) },
                                enabled = editable && supported, label = { Text(label) })
                    }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((id, label) in listOf("confirmed" to "确认预约", "pending" to "暂留待确认"))
                            FilterChip(draft.initial == id, { draft = draft.copy(initial = id) },
                                enabled = editable && supported, label = { Text(label) })
                    }
                    Box {
                        SecondaryAction(onClick = { seatMenu = true }, enabled = editable && supported) {
                            Text("位置偏好 · " + reservationSeatPreferences[draft.seat])
                        }
                        DropdownMenu(seatMenu, { seatMenu = false }) {
                            for ((id, label) in reservationSeatPreferences) DropdownMenuItem(
                                text = { Text(label) }, onClick = { draft = draft.copy(seat = id); seatMenu = false })
                        }
                    }
                    Text("位置偏好供接待参考，不保证具体桌位。", fontSize = 12.sp)
                    OutlinedTextField(draft.note, { draft = draft.copy(note = it) },
                        label = { Text("备注（选填）") }, enabled = editable && supported,
                        modifier = Modifier.fillMaxWidth())
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Primary("下一步 · 核对预约", m.canCreateReception && options != null &&
                        draft.people <= options.remainingGuests) {
                        try {
                            proposed = m.prepareReceptionCreate(draft)
                            error = ""
                        } catch (e: Exception) { error = e.message ?: "请重新读取时段后核对预约" }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(onDismissRequest = { proposed = null }, title = { Text("核对预约") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${draft.name} · ${draft.people} 人")
                    Text(reservationDraftTime(draft.arrival) + " — " + reservationDraftTime(draft.end))
                    Text(reservationSeatPreferences[draft.seat] ?: "位置偏好待确认")
                    Text(if (draft.initial == "confirmed") "确认预约" else "暂留待确认")
                    Text("不预绑桌台；结果未确认时保留原请求，不能重复新建。", fontSize = 12.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = { proposed = null; m.executeLive(command); close() },
                    enabled = m.canExecuteLive(command)) { Text("确认创建预约") }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } })
    }
}
