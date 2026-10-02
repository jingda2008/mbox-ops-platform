package com.mbox.staff

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.time.Instant
import java.time.ZoneId

@Composable
fun AssignmentChoice(
    label: String,
    value: String,
    rows: List<Pair<String, String>>,
    choose: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        SecondaryAction(onClick = { expanded = true }, icon = Icons.Outlined.ExpandMore) {
            Text("$label · ${rows.find { it.first == value }?.second ?: "请选择"}")
        }
        DropdownMenu(expanded, { expanded = false }) {
            rows.forEach { row ->
                DropdownMenuItem(
                    text = { Text(row.second) },
                    onClick = {
                        choose(row.first)
                        expanded = false
                    },
                )
            }
        }
    }
}

@Composable
fun AssignmentDatePicker(label: String, value: Instant, choose: (Instant) -> Unit) {
    val context = LocalContext.current
    SecondaryAction(
        onClick = {
            val date = value.atZone(ZoneId.of("Asia/Shanghai"))
            DatePickerDialog(
                    context,
                    { _, year, month, day ->
                        TimePickerDialog(
                                context,
                                { _, hour, minute ->
                                    choose(
                                        java.time.LocalDateTime.of(
                                                year,
                                                month + 1,
                                                day,
                                                hour,
                                                minute,
                                            )
                                            .atZone(ZoneId.of("Asia/Shanghai"))
                                            .toInstant()
                                    )
                                },
                                date.hour,
                                date.minute,
                                true,
                            )
                            .show()
                    },
                    date.year,
                    date.monthValue - 1,
                    date.dayOfMonth,
                )
                .show()
        },
        icon = Icons.Outlined.Schedule,
    ) {
        Text("$label · ${assignmentTime(value.toString())}（上海时间）")
    }
}

@Composable
fun LiveAssignmentsView(m: AppModel, initialTableID: String? = null, close: () -> Unit) {
    var selected by remember {
        mutableStateOf(initialTableID?.let { setOf(it) } ?: emptySet<String>())
    }
    var query by remember { mutableStateOf("") }
    var employee by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("primary") }
    var immediate by remember { mutableStateOf(true) }
    var start by remember { mutableStateOf(Instant.now()) }
    var hasEnd by remember { mutableStateOf(false) }
    var end by remember { mutableStateOf(Instant.now().plusSeconds(28800)) }
    var reason by remember { mutableStateOf("") }
    var ending by remember { mutableStateOf<String?>(null) }
    var endReason by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var error by remember { mutableStateOf("") }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    LaunchedEffect(Unit) { m.loadAssignments() }
    LaunchedEffect(m.assignmentReceipt) {
        if (m.assignmentReceipt.isNotEmpty()) {
            selected = emptySet()
            reason = ""
            ending = null
            endReason = ""
        }
    }
    fun propose(make: () -> LiveCommand) {
        try {
            proposed = make()
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
                    Text("人员与责任桌", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { m.loadAssignments() }, enabled = !m.busy) { Text("刷新") }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.assignmentsState.isNotEmpty()) Text(m.assignmentsState)
                        if (m.assignmentReceipt.isNotEmpty()) Text(m.assignmentReceipt)
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    }
                    val board = m.assignmentsBoard
                    val manager = m.identity?.allows(LiveAssignments.permission) == true
                    if (board != null) {
                        if (manager)
                            item {
                                Foldout("安排责任桌 · 已选${selected.size}桌") {
                                    AssignmentChoice(
                                        "员工",
                                        employee,
                                        board.employees.map {
                                            it.getString("id") to
                                                (it.getString("displayName") +
                                                    " · " +
                                                    it.getString("code"))
                                        },
                                    ) {
                                        employee = it
                                    }
                                    AssignmentChoice(
                                        "责任岗位",
                                        role,
                                        board.roles.map {
                                            it.getString("id") to it.getString("name")
                                        },
                                    ) {
                                        role = it
                                    }
                                    AssignmentChoice("责任类型", kind, assignmentKinds.toList()) {
                                        kind = it
                                    }
                                    OutlinedTextField(
                                        query,
                                        { query = it },
                                        label = { Text("搜索部分桌号或区域") },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    Text(
                                        "已开台优先 · ${board.visibleTables(query).size}桌",
                                        fontSize = 12.sp,
                                    )
                                    Row {
                                        TextButton(
                                            onClick = {
                                                val next =
                                                    selected +
                                                        board.visibleTables(query).map {
                                                            it.getString("id")
                                                        }
                                                if (next.size > 80) error = "一次最多选择80桌"
                                                else selected = next
                                            }
                                        ) {
                                            Text("选择筛选结果")
                                        }
                                        TextButton(onClick = { selected = emptySet() }) {
                                            Text("清空")
                                        }
                                    }
                                    Text(
                                        "已选：" +
                                            board.tables
                                                .filter { it.getString("id") in selected }
                                                .joinToString("、") { it.getString("code") },
                                        fontSize = 12.sp,
                                    )
                                    board.visibleTables(query).forEach { row ->
                                        val id = row.getString("id")
                                        SecondaryAction(
                                            onClick = {
                                                if (id in selected) selected = selected - id
                                                else if (selected.size < 80)
                                                    selected = selected + id
                                                else error = "一次最多选择80桌"
                                            },
                                            icon =
                                                if (id in selected) Icons.Outlined.CheckCircle
                                                else Icons.Outlined.RadioButtonUnchecked,
                                        ) {
                                            Text(
                                                row.getString("code") +
                                                    " · " +
                                                    row.getString("areaName") +
                                                    if (row.isNull("activeSessionId")) " · 空台"
                                                    else " · 营业中"
                                            )
                                        }
                                    }
                                    Row {
                                        Text("立即生效", Modifier.weight(1f))
                                        Switch(immediate, { immediate = it })
                                    }
                                    if (!immediate) AssignmentDatePicker("开始", start) { start = it }
                                    Row {
                                        Text("设置结束时间", Modifier.weight(1f))
                                        Switch(hasEnd, { hasEnd = it })
                                    }
                                    if (hasEnd) AssignmentDatePicker("结束", end) { end = it }
                                    OutlinedTextField(
                                        reason,
                                        { reason = it },
                                        label = { Text("安排原因（2—1000字）") },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    Text(
                                        "主服务员冲突时整批拒绝；换人前先核对并结束原责任。岗位仅记录分工，不更改账号权限。",
                                        fontSize = 12.sp,
                                    )
                                    Primary(
                                        "核对并安排 ${selected.size}桌",
                                        enabled =
                                            m.canAct(LiveAssignments.permission) &&
                                                selected.isNotEmpty() &&
                                                employee.isNotEmpty() &&
                                                role.isNotEmpty(),
                                        icon = Icons.Outlined.People,
                                    ) {
                                        propose {
                                            m.prepareAssignment(
                                                selected,
                                                employee,
                                                role,
                                                kind,
                                                if (immediate) Instant.now() else start,
                                                if (hasEnd) end else null,
                                                reason,
                                            )
                                        }
                                    }
                                    if (!m.canAct(LiveAssignments.permission))
                                        Text("提交前请刷新，确认最新权限与责任分工。", fontSize = 12.sp)
                                }
                            }
                        item {
                            Text(
                                "当前生效 · ${board.assignments.size}项",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text("仅显示当前账号可见的生效责任。", fontSize = 12.sp)
                            if (board.assignments.isEmpty()) Text("当前没有生效的责任安排")
                        }
                        if (manager) item { AssignmentScheduleSection(m) { proposed = it } }
                        items(board.assignments, key = { it.getString("id") }) { row ->
                            val id = row.getString("id")
                            Card {
                                Column(
                                    Modifier.padding(14.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        row.getString("tableCode") +
                                            " · " +
                                            assignmentKinds[row.getString("assignmentType")],
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Text(
                                        row.getString("employeeName") +
                                            " · " +
                                            row.getString("roleCode")
                                    )
                                    Text(
                                        assignmentTime(row.getString("startsAt")) +
                                            " → " +
                                            if (row.isNull("endsAt")) "持续有效 · 上海时间"
                                            else
                                                assignmentTime(row.getString("endsAt")) + " · 上海时间",
                                        fontSize = 12.sp,
                                    )
                                    Text(row.getString("reason"), fontSize = 12.sp)
                                    if (manager) {
                                        if (ending == id) {
                                            OutlinedTextField(
                                                endReason,
                                                { endReason = it },
                                                label = { Text("结束原因（2—1000字）") },
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                            SecondaryAction(
                                                onClick = {
                                                    propose {
                                                        m.prepareAssignmentEnd(id, endReason)
                                                    }
                                                },
                                                enabled = m.canAct(LiveAssignments.permission),
                                                danger = true,
                                            ) {
                                                Text("核对并结束此责任")
                                            }
                                            TextButton(
                                                onClick = {
                                                    ending = null
                                                    endReason = ""
                                                }
                                            ) {
                                                Text("取消结束")
                                            }
                                        } else
                                            SecondaryAction(
                                                onClick = {
                                                    ending = id
                                                    endReason = ""
                                                },
                                                enabled = m.canAct(LiveAssignments.permission),
                                            ) {
                                                Text("结束责任")
                                            }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        Dialog(
            onDismissRequest = { proposed = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                LazyColumn(
                    Modifier.safeDrawingPadding().padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    item { Text("确认责任安排", style = MaterialTheme.typography.titleLarge) }
                    item { Text(command.steps.first().assignmentProof!!.getString("confirmation")) }
                    item {
                        Primary(
                            "核对无误，提交",
                            enabled = m.canAct(LiveAssignments.permission),
                            icon = Icons.Outlined.CheckCircle,
                        ) {
                            proposed = null
                            m.executeLive(command)
                        }
                    }
                    item { SecondaryAction(onClick = { proposed = null }) { Text("返回修改") } }
                }
            }
        }
    }
}
