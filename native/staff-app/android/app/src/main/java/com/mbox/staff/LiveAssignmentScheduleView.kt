package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.time.Instant
import org.json.JSONObject

@Composable
fun AssignmentScheduleSection(m: AppModel, propose: (LiveCommand) -> Unit) {
    val board = m.assignmentsBoard ?: return
    var editing by remember { mutableStateOf<String?>(null) }
    var cancel by remember { mutableStateOf(false) }
    var employee by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("primary") }
    var start by remember { mutableStateOf(Instant.now()) }
    var end by remember { mutableStateOf(Instant.now().plusSeconds(3600)) }
    var hasEnd by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(board.schedule) { editing = null; reason = ""; error = "" }
    Foldout("未来排班与历史") {
        val schedule = board.schedule
        if(schedule == null) Text("配套后台尚未提供未来排班管理。已提交的安排请在原管理端核对。")
        else {
            AssignmentChoice("查询", m.assignmentScheduleMode, assignmentScheduleModes.toList()) { m.loadAssignmentSchedule(it) }
            Text("${assignmentScheduleModes[schedule.mode]} · 第${schedule.page + 1}页 · ${schedule.rows.size}项")
            Row {
                TextButton(onClick = { m.loadAssignmentSchedule(schedule.mode, schedule.page - 1) }, enabled = !m.busy && schedule.page > 0) { Text("上一页") }
                TextButton(onClick = { m.loadAssignmentSchedule(schedule.mode, schedule.page + 1) }, enabled = !m.busy && schedule.hasMore) { Text("下一页") }
            }
            if(schedule.rows.isEmpty()) Text("该页没有记录")
            for(row in schedule.rows) {
                val id = row.getString("id")
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${row.getString("tableCode")} · ${row.getString("employeeName")} · ${assignmentKinds[row.getString("assignmentType")]}")
                    Text("${assignmentTime(row.getString("startsAt"))} → ${if(row.isNull("endsAt")) "不设结束" else assignmentTime(row.getString("endsAt"))} · 上海时间")
                    Text(if(row.isNull("cancelledAt")) row.getString("reason") else "取消原因：${row.getString("cancellationReason")}")
                    if(schedule.mode == "future") {
                        Row {
                            TextButton(onClick = { editing = id; cancel = false; employee = row.getString("employeeId"); role = row.getString("roleId"); kind = row.getString("assignmentType"); start = serverInstant(row.getString("startsAt")); hasEnd = !row.isNull("endsAt"); end = if(hasEnd) serverInstant(row.getString("endsAt")) else start.plusSeconds(3600); reason = "" }, enabled = m.canAct(LiveAssignments.permission)) { Text("修改") }
                            TextButton(onClick = { editing = id; cancel = true; reason = "" }, enabled = m.canAct(LiveAssignments.permission)) { Text("取消安排") }
                        }
                        if(editing == id) {
                            if(!cancel) {
                                AssignmentChoice("员工",employee,board.employees.map { it.getString("id") to it.getString("displayName") }) { employee = it }
                                AssignmentChoice("岗位",role,board.roles.map { it.getString("id") to it.getString("name") }) { role = it }
                                AssignmentChoice("责任",kind,assignmentKinds.toList()) { kind = it }
                                AssignmentDatePicker("开始",start) { start = it }
                                Row { Text("设置结束时间",Modifier.weight(1f)); Switch(hasEnd,{ hasEnd = it }) }
                                if(hasEnd) AssignmentDatePicker("结束",end) { end = it }
                            }
                            OutlinedTextField(reason,{ reason = it },label = { Text(if(cancel) "取消原因" else "修改原因") },modifier = Modifier.fillMaxWidth())
                            SecondaryAction(onClick = {
                                try {
                                    val value = if(cancel) null else JSONObject().put("employeeId",employee).put("roleId",role).put("assignmentType",kind).put("startsAt",start.toString()).put("endsAt",if(hasEnd) end.toString() else JSONObject.NULL)
                                    val command = m.prepareSchedule(id,reason,value)
                                    if(value != null) {
                                        val p = command.steps[0].assignmentProof!!
                                        val extra = "\n新员工：${board.employees.find { it.getString("id") == employee }?.getString("displayName")} · ${assignmentKinds[kind]}\n新岗位：${board.roles.find { it.getString("id") == role }?.getString("name")}\n新时段：${assignmentTime(start.toString())} → ${if(hasEnd) assignmentTime(end.toString()) else "不设结束"} · 上海时间"
                                        val updated = command.copy(steps = listOf(command.steps[0].copy(recoveryBody = p.put("confirmation",p.getString("confirmation") + extra).toString())))
                                        propose(updated)
                                    } else propose(command)
                                    error = ""
                                } catch(e: Exception) { error = e.message ?: "请刷新核对" }
                            }, enabled = m.canAct(LiveAssignments.permission), danger = cancel) { Text(if(cancel) "核对并取消安排" else "核对修改") }
                            TextButton(onClick = { editing = null }) { Text("放弃编辑") }
                        }
                    }
                } }
            }
            if(error.isNotEmpty()) Text(error,color = MaterialTheme.colorScheme.error)
        }
    }
}
