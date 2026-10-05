package com.mbox.staff

import androidx.compose.foundation.horizontalScroll
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
import java.time.format.DateTimeFormatter

@Composable
fun LiveReservationsView(m: AppModel, close: () -> Unit) {
    var creating by remember { mutableStateOf(false) }
    var receptionID by remember { mutableStateOf<String?>(null) }
    var range by remember { mutableStateOf("current") }
    var from by remember { mutableStateOf(ReservationQuery.day()) }
    var to by remember { mutableStateOf(ReservationQuery.day()) }
    var search by remember { mutableStateOf("") }
    var queue by remember { mutableStateOf(false) }
    var finished by remember { mutableStateOf(false) }
    var selectedID by remember { mutableStateOf("") }
    var action by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var override by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    if (creating) ReservationCreateView(m) { creating = false }
    receptionID?.let { id ->
        ReservationReceptionView(m, id, close = { receptionID = null },
            leaveReservations = { receptionID = null; close() })
    }
    val query = ReservationQuery(range, from, to)
    val actionable = m.canUseReservations && query == m.reservationQuery
    val receptionSupported = m.reservationCapabilities?.opt("admissionCreateV1") == true &&
        m.reservationCapabilities?.opt("receptionSeatV1") == true
    val version = remember { m.workspaceVersion }
    fun choose(id: String, a: String) {
        selectedID = id
        action = a
        reason = ""
        override = false
        error = ""
        editing = true
    }
    LaunchedEffect(Unit) { m.loadReservations(query) }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("预约与排队", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("关闭") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    ReceptionPendingRetryView(m)
                    Text(m.reservationState, fontSize = 12.sp)
                    if (m.identity?.allows("reservation.manage") == true) {
                        Primary(
                            "新建预约",
                            !m.busy && !m.liveStorageDamaged && m.livePending == null &&
                                m.liveOrderPending == null && receptionSupported,
                        ) {
                            creating = true
                        }
                        if (!m.busy && !receptionSupported)
                            Text("后台尚未确认新版预约接待能力，请刷新；仍未启用时需由管理员升级后台。原有未决请求仍可核对。",
                                fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = !queue,
                            onClick = { queue = false },
                            label = { Text("预约") },
                        )
                        FilterChip(
                            selected = queue,
                            onClick = { queue = true },
                            label = { Text("优先安排") },
                        )
                    }
                    if (!queue)
                        Row(
                            Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            for ((key, label) in
                                listOf(
                                    "current" to "当前",
                                    "carryover" to "跨日待办",
                                    "history" to "历史",
                                )) FilterChip(
                                selected = range == key,
                                onClick = { range = key },
                                label = { Text(label) },
                            )
                        }
                    if (queue || range == "history")
                        Panel {
                            OutlinedTextField(
                                from,
                                { from = it },
                                label = { Text("开始日期 YYYY-MM-DD") },
                                singleLine = true,
                            )
                            OutlinedTextField(
                                to,
                                { to = it },
                                label = { Text("结束日期 YYYY-MM-DD") },
                                singleLine = true,
                            )
                            Text("按上海自然日查询，最多31天。", fontSize = 12.sp)
                        }
                    SecondaryAction(onClick = { m.loadReservations(query) }, enabled = !m.busy) {
                        Text("读取所选范围")
                    }
                    OutlinedTextField(
                        search,
                        { search = it },
                        label = { Text("姓名、桌号或预约编号") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row {
                        Checkbox(finished, { finished = it })
                        Text("显示已完成 / 已取消")
                    }
                    if (queue) {
                        val rows =
                            m.reservationIntake.filter {
                                (finished || it.active) &&
                                    (search.isBlank() ||
                                        (it.name +
                                                it.source.getJSONArray("tableCodes").toString() +
                                                it.publicId)
                                            .contains(search, true))
                            }
                        if (rows.isEmpty()) Text("此范围没有符合条件的安排")
                        for (row in rows) Panel {
                            Text(
                                row.name + " · " + if (row.kind == "waitlist") "候位" else "预约",
                                fontSize = 18.sp,
                            )
                            Text("${row.count}人 · " + reservationTime(row.arrival))
                            Text(row.source.getString("maskedContact"), fontSize = 12.sp)
                            Text(
                                if (row.source.optJSONObject("priorityBooking") == null) "普通安排"
                                else "会员优先安排",
                                color = Ink,
                            )
                            row.source.optJSONObject("queueOverride")?.let {
                                Text(
                                    (ReservationCommands.labels[it.getString("mode")] ?: "已调整") +
                                        " · " +
                                        it.getString("reason"),
                                    fontSize = 12.sp,
                                )
                            }
                            if (row.kind == "waitlist") Text("候位状态：" + (mapOf("waiting" to "等待中", "notified" to "已联系", "arrived" to "已到店", "seated" to "已入座", "cancelled" to "已取消", "expired" to "已过期")[row.status] ?: row.status))
                            if (row.kind == "waitlist" && m.reservationCapabilities?.optBoolean("durableWaitlist") == true && m.identity?.allows("reservation.manage") == true) {
                                for (next in ReservationCommands.waitlistActions(row.status)) SecondaryAction(onClick = { choose(row.id, "waitlist:$next") }, enabled = actionable) {
                                    Text(ReservationCommands.waitlistLabels[next]!!)
                                }
                            }
                            if (row.active && m.identity?.allows("reservation.manage") == true)
                                for (mode in listOf("promote", "demote", "clear")) SecondaryAction(
                                    onClick = { choose(row.id, mode) },
                                    enabled = actionable,
                                ) {
                                    Text(ReservationCommands.labels[mode]!!)
                                }
                        }
                    } else {
                        val rows =
                            m.reservations.filter {
                                (finished || range == "history" || it.actions.isNotEmpty()) &&
                                    (search.isBlank() ||
                                        (it.name + it.tables + it.publicId).contains(search, true))
                            }
                        if (rows.isEmpty()) Text("此范围没有符合条件的预约")
                        for (row in rows) Panel {
                            Text(row.name + " · " + row.statusLabel, fontSize = 18.sp)
                            Text("${row.count}人 · " + if (row.receptionProtocol == 1) {
                                if (row.status in listOf("seated", "completed")) "已关联实际桌次"
                                else if (row.status in listOf("pending", "confirmed", "arrived")) "到店后核对实际桌位"
                                else "预约不预绑桌台"
                            } else row.tables)
                            Text(
                                reservationTime(row.arrival) +
                                    " — " +
                                    reservationTime(row.source.getString("expectedEndAt")),
                                fontSize = 12.sp,
                            )
                            Text(
                                row.source.textOrNull("maskedContact")
                                    ?: if (row.source.getBoolean("contactAvailable")) "联系方式已保护"
                                    else "未留联系方式",
                                fontSize = 12.sp,
                            )
                            Text(
                                mapOf(
                                    "no_preference" to "无位置偏好",
                                    "stage_atmosphere" to "舞台氛围",
                                    "quiet_chat" to "安静聊天",
                                    "comfortable_booth" to "舒适卡座",
                                    "outdoor_view" to "户外景观",
                                )[row.source.getString("seatPreference")] ?: "位置偏好待确认",
                                fontSize = 12.sp,
                            )
                            row.source.textOrNull("note")?.let { Text(it, fontSize = 12.sp) }
                            if (m.identity?.allows("reservation.view") == true)
                                SecondaryAction(onClick = { receptionID = row.id }, enabled = !m.busy) {
                                    Text(if (row.receptionProtocol == 1 && row.status == "arrived") "核对已开桌次 · 确认入座" else "查看接待详情")
                                }
                            if (m.identity?.allows("reservation.manage") == true)
                                for (a in row.actions) SecondaryAction(
                                    onClick = { choose(row.id, a) },
                                    enabled = actionable,
                                    danger = a == "cancel",
                                ) {
                                    Text(ReservationCommands.labels[a]!!)
                                }
                        }
                    }
                }
            }
        }
    }
    if (editing)
        AlertDialog(
            onDismissRequest = { editing = false },
            title = { Text(ReservationCommands.waitlistLabels[action.substringAfter(':', "")] ?: ReservationCommands.labels[action] ?: "处理预约") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(reason, { reason = it }, label = { Text("处理说明（候位、取消、排序必填）") })
                    if (action == "cancel") {
                        Text("取消后释放预约占用；已开桌台和已有收款仍须按各自流程处理，不会自动关台或退款。", fontSize = 12.sp)
                        if (m.identity?.allows("reservation.cancel.override") == true)
                            Row {
                                Checkbox(override, { override = it })
                                Text("主管例外取消")
                            }
                    }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                }
            },
            confirmButton = {
                TextButton(
                    enabled = actionable,
                    onClick = {
                        try {
                            proposed =
                                if (action.startsWith("waitlist:")) m.prepareWaitlist(selectedID, action.substringAfter(':'), reason)
                                else if (queue) m.prepareReservationPriority(selectedID, action, reason)
                                else m.prepareReservation(selectedID, action, reason, override)
                            editing = false
                        } catch (e: Exception) {
                            error = e.message ?: "请刷新后重试"
                        }
                    },
                ) {
                    Text("下一步 · 核对操作")
                }
            },
            dismissButton = { TextButton(onClick = { editing = false }) { Text("返回") } },
        )
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text(command.steps[0].reservationProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    enabled = m.canExecuteLive(command),
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    },
                ) {
                    Text("确认执行")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}

fun reservationTime(value: String): String =
    assignmentDate(value)
        ?.atZone(ReservationQuery.zone)
        ?.format(DateTimeFormatter.ofPattern("MM-dd HH:mm")) ?: "时间待核对"
