package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun ReservationReceptionView(m: AppModel, reservationId: String, token: Long, close: () -> Unit, leaveReservations: () -> Unit) {
    var selected by remember(token) { mutableStateOf(emptySet<String>()) }
    var search by remember(token) { mutableStateOf("") }
    var reason by remember(token) { mutableStateOf("") }
    var allGuestsChecked by remember(token) { mutableStateOf(false) }
    var showReferences by remember(token) { mutableStateOf(false) }
    var error by remember(token) { mutableStateOf("") }
    var proposed by remember(token) { mutableStateOf<LiveCommand?>(null) }
    var waitingForRead by remember(token) { mutableStateOf(m.businessRequestInFlight) }
    var active by remember(token) { mutableStateOf(true) }
    val version = remember(token) { m.workspaceVersion }
    fun viewCurrent() = active && version == m.workspaceVersion && m.isReceptionViewCurrent(token)
    fun closeView() { active = false; m.closeReceptionView(token); close() }
    fun leaveView() {
        if (!viewCurrent()) return
        active = false; m.closeReceptionView(token); leaveReservations()
    }
    DisposableEffect(m, token) { onDispose { active = false; m.closeReceptionView(token) } }
    val detail = m.receptionDetail?.takeIf { viewCurrent() && it.reservation.id == reservationId }
    val board = m.receptionSessions?.takeIf { viewCurrent() && it.reservationId == reservationId }
    val canRead = viewCurrent() && !m.businessRequestInFlight && m.identity?.allows("reservation.view") == true
    val supported = m.receptionSeatingSupported
    val canEdit = viewCurrent() && !m.businessRequestInFlight && m.livePending == null && m.liveOrderPending == null
    fun loadDetail() {
        if (!viewCurrent()) return
        error = ""; waitingForRead = false
        m.loadReceptionDetail(reservationId, viewToken = token)
    }
    fun loadSessions() {
        if (!viewCurrent()) return
        error = ""; waitingForRead = false
        m.loadReceptionSessions(reservationId, viewToken = token)
    }
    val selectedSessions = board?.sessions.orEmpty().filter { it.tableSessionId in selected }
    val selectedPeople = selectedSessions.sumOf { it.guestCount }
    val missingSelection = selected.size != selectedSessions.size
    // A refresh may change a table's location or guest count. Keep the entered reason,
    // but require a new group check before a changed board can be submitted.
    LaunchedEffect(token, board?.source?.toString()) { allGuestsChecked = false; proposed = null }
    LaunchedEffect(token, reservationId) {
        if (!viewCurrent()) return@LaunchedEffect
        if (m.businessRequestInFlight) waitingForRead = true
        else loadDetail()
    }
    LaunchedEffect(token, m.workspaceVersion) { if (version != m.workspaceVersion) closeView() }
    Dialog(onDismissRequest = ::closeView, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("预约接待", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = ::closeView) { Text("返回") }
                }
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    LivePendingView(m)
                    ReceptionPendingRetryView(m, viewToken = token, currentView = ::viewCurrent)
                    if (waitingForRead) Text(if (m.businessRequestInFlight) "等待原读取结束后刷新" else "原读取已结束，请刷新当前接待详情", fontSize = 12.sp)
                    else if (m.receptionState.isNotBlank()) Text(m.receptionState, fontSize = 12.sp)
                    SecondaryAction(onClick = ::loadDetail, enabled = canRead) {
                        Text("刷新接待详情")
                    }
                    if (detail == null) {
                        Text("读取预约详情后，才能核对到店接待情况。")
                    } else {
                        val row = detail.reservation
                        Panel {
                            Text("${row.name} · ${row.statusLabel}", style = MaterialTheme.typography.titleMedium)
                            Text("预约 ${row.count} 人")
                            Text(reservationTime(row.arrival) + " — " + reservationTime(row.source.getString("expectedEndAt")), fontSize = 12.sp)
                            Text(reservationSeatPreferences[row.source.optString("seatPreference")] ?: "位置偏好待核对", fontSize = 12.sp)
                            Text("预约编号 ${row.publicId}", fontSize = 12.sp)
                            row.source.textOrNull("note")?.let { Text(it, fontSize = 12.sp) }
                        }
                        val seating = detail.seating
                        if (seating != null) {
                            Text("已确认整组入座", style = MaterialTheme.typography.titleMedium)
                            Text("预约 ${seating.reservationGuestCount} 人 · 实际 ${seating.seatedGuestCount} 人 · ${seating.sessions.size} 桌")
                            Text("确认时间 ${reservationDraftTime(seating.seatedAt)} · 营业日 ${seating.businessDate}", fontSize = 12.sp)
                            Text("核对说明：${seating.reason}", fontSize = 12.sp)
                            for (session in seating.sessions) Panel {
                                Text("原桌 ${session.tableCodeAtSeating} → 现桌 ${session.currentTableCode}",
                                    style = MaterialTheme.typography.titleMedium)
                                Text("入座时 ${session.guestCountAtSeating} 人 · 当前${receptionSessionStatus(session.currentStatus)}", fontSize = 12.sp)
                                if (session.currentTableId != session.tableIdAtSeating || session.currentLocationVersion != session.locationVersionAtSeating)
                                    Text("桌位已有变动，原入座记录仍保留。", fontSize = 12.sp)
                                if (showReferences) SelectionContainer {
                                    Text("桌次 ${session.tableSessionId}\n原桌 ID ${session.tableIdAtSeating}\n现桌 ID ${session.currentTableId}", fontSize = 12.sp)
                                }
                            }
                            TextButton(onClick = { showReferences = !showReferences }) {
                                Text(if (showReferences) "收起关联凭证" else "查看关联凭证")
                            }
                            if (showReferences) SelectionContainer {
                                Text("预约 ID ${row.id}\n顾客 ID ${seating.customerId}\n接待批次 ${seating.batchId}\n接待员工 ${seating.seatedByEmployeeId}", fontSize = 12.sp)
                            }
                            Text("本组桌次已一次性关联，不支持在此追加或重绑；换桌沿用桌台业务流程。", fontSize = 12.sp)
                        } else if (row.receptionProtocol != 1) {
                            Text("这是历史预约，尚无新版实际桌次关联记录。请按原预约流程处理。", fontSize = 12.sp)
                        } else if (row.status != "arrived") {
                            Text(if (row.status in listOf("pending", "confirmed"))
                                "请先返回预约列表确认到店，再核对本组全部已开桌次。"
                                else "当前预约状态不能确认入座。", fontSize = 12.sp)
                        } else {
                            Text("核对整组实际桌位", style = MaterialTheme.typography.titleMedium)
                            Text("在桌台页面完成开台后，选择本组全部已开桌次，一次关联 1—20 桌；不能分批追加。", fontSize = 12.sp)
                            if (!supported) Text("门店暂未开放确认入座，请刷新或联系管理员。", color = MaterialTheme.colorScheme.error)
                            val hasPermission = m.identity?.allows("reservation.manage") == true && m.identity?.allows("table.open") == true
                            if (!hasPermission) Text("确认入座需要预约管理和开台权限，请由有权限的员工处理。", fontSize = 12.sp)
                            SecondaryAction(onClick = ::loadSessions,
                                enabled = canRead && canEdit && supported && hasPermission) { Text("读取已开桌次") }
                            if (board != null) {
                                if (board.status != "arrived") Text("预约状态已变化，请刷新详情。", color = MaterialTheme.colorScheme.error)
                                if (board.sessions.isEmpty()) {
                                    Text("没有可关联的桌次。只会显示当前营业日内、您有权查看且尚未关联预约的已开桌次。", fontSize = 12.sp)
                                    Text("返回主界面，进入「桌台」按现有流程开台，再回来刷新；此页面不会自动开台。", fontSize = 12.sp)
                                    SecondaryAction(onClick = ::leaveView, enabled = canEdit) { Text("返回主界面") }
                                } else {
                                    OutlinedTextField(search, { search = it }, label = { Text("模糊搜索桌号") },
                                        singleLine = true, modifier = Modifier.fillMaxWidth())
                                    val visible = board.sessions.filter { search.isBlank() || it.tableCode.contains(search, ignoreCase = true) }
                                    if (visible.isEmpty()) Text("没有匹配的已开桌次", fontSize = 12.sp)
                                    for (session in visible) Panel {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Checkbox(session.tableSessionId in selected, { checked ->
                                                selected = if (checked) selected + session.tableSessionId else selected - session.tableSessionId
                                                allGuestsChecked = false
                                                error = ""
                                            }, enabled = canEdit && m.canSeatReception &&
                                                (session.tableSessionId in selected || selected.size < 20))
                                            Column(Modifier.weight(1f)) {
                                                Text("${session.tableCode} · ${session.guestCount} 人", style = MaterialTheme.typography.titleMedium)
                                                Text("开台 ${reservationDraftTime(session.openedAt)}", fontSize = 12.sp)
                                                Text("营业日 ${session.businessDate}", fontSize = 12.sp)
                                            }
                                        }
                                    }
                                }
                                Panel {
                                    Text("已选 ${selected.size} 桌 · 实际 $selectedPeople 人 / 预约 ${board.guestCount} 人",
                                        style = MaterialTheme.typography.titleMedium)
                                    if (selectedSessions.isNotEmpty()) Text(selectedSessions.joinToString("、") { "${it.tableCode}（${it.guestCount}人）" }, fontSize = 12.sp)
                                    if (missingSelection) {
                                        Text("部分已选桌次已不在当前列表，请清除选择后重新核对。", color = MaterialTheme.colorScheme.error)
                                        TextButton(onClick = { selected = emptySet(); allGuestsChecked = false }, enabled = canEdit) { Text("清除原选择") }
                                    }
                                    if (selected.isNotEmpty() && selectedPeople != board.guestCount)
                                        Text("实际整组人数与预约相差 ${kotlin.math.abs(selectedPeople - board.guestCount)} 人，必须填写差异原因。", color = MaterialTheme.colorScheme.error)
                                }
                                OutlinedTextField(reason, { reason = it },
                                    label = { Text(if (selectedPeople != board.guestCount && selected.isNotEmpty()) "人数差异原因及桌位核对说明" else "整组桌位和人数核对说明") },
                                    supportingText = { Text("必填 4—1000 字；人数取自已开桌次，如有错误请先在桌台页面修正。") },
                                    enabled = canEdit, modifier = Modifier.fillMaxWidth())
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(allGuestsChecked, { allGuestsChecked = it },
                                        enabled = canEdit && selected.isNotEmpty() && !missingSelection)
                                    Text("已核对本组全部实际桌位和人数，没有遗漏桌次", Modifier.weight(1f), fontSize = 14.sp)
                                }
                                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                                Primary("下一步 · 核对整组入座", viewCurrent() && m.canSeatReception && selected.size in 1..20 &&
                                    !missingSelection && allGuestsChecked && reason.trim().length in 4..1000) {
                                    try {
                                        check(viewCurrent()) { "预约页面已变化，请在当前页面重新核对" }
                                        proposed = m.prepareReceptionSeat(reservationId, selected, reason, viewToken = token)
                                        error = ""
                                    } catch (e: Exception) { error = e.message ?: "请刷新预约和实际桌次后重新核对" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(onDismissRequest = { proposed = null }, title = { Text("确认整组入座") },
            text = { Text(command.steps.single().receptionProof!!.getString("confirmation"),
                Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = {
                TextButton(onClick = {
                    if (viewCurrent() && m.canExecuteLive(command)) {
                        proposed = null; allGuestsChecked = false; m.executeLive(command)
                    }
                }, enabled = viewCurrent() && m.canExecuteLive(command)) { Text("确认关联全部桌次") }
            }, dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回核对") } })
    }
}

private fun receptionSessionStatus(status: String): String = when (status) {
    "open" -> "营业中"
    "closing" -> "结账处理中"
    "closed" -> "已结账关台"
    "cancelled" -> "已取消"
    else -> "状态待核对"
}

/** The common pending card retains all legacy recovery. This adds only the explicit v1 retry. */
@Composable
internal fun ReceptionPendingRetryView(m: AppModel, viewToken: Long? = null, currentView: () -> Boolean = { true }) {
    val command = m.livePending ?: return
    val step = command.steps.singleOrNull() ?: return
    if (step.receptionProof?.optString("kind") != "reception-create" || command.rejected ||
        command.completedSteps >= command.steps.size) return
    var retry by remember(command.id) { mutableStateOf(false) }
    fun canRetry() = currentView() && (viewToken == null || m.isReceptionViewCurrent(viewToken)) &&
        !m.businessRequestInFlight && m.livePending == command && command.employeeID == m.identity?.employeeId
    Text("查询暂未找到原预约时，仍不能判定未创建。可继续核对，或使用已保存的同一请求重试。", fontSize = 12.sp)
    SecondaryAction(onClick = { if (canRetry()) retry = true }, enabled = canRetry()) {
        Text("重试原预约请求")
    }
    if (retry) AlertDialog(onDismissRequest = { retry = false }, title = { Text("重试原预约请求") },
        text = { Text("将使用原预约编号、原内容和原请求键重试，不会另建新预约。请先确认正在处理这笔未决预约。") },
        confirmButton = { TextButton(onClick = { if (canRetry()) { retry = false; m.recoverLive(retryReceptionOriginal = true) } },
            enabled = canRetry()) { Text("确认重试原请求") } },
        dismissButton = { TextButton(onClick = { retry = false }) { Text("继续核对结果") } })
}
