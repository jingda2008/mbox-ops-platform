package com.mbox.staff

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveServiceView(
    m: AppModel,
    focusedTask: String? = null,
    focusedSession: String? = null,
    close: () -> Unit,
) {
    var plansVisible by remember { mutableStateOf(false) }
    if(plansVisible) LiveExperiencePlansView(m){plansVisible=false;m.loadService()}
    var showAll by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("all") }
    var selected by remember { mutableStateOf<LiveServiceTask?>(null) }
    var action by remember { mutableStateOf("complete") }
    var note by remember { mutableStateOf("") }
    var employee by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("high") }
    var checked by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var itemID by remember { mutableStateOf<String?>(null) }
    val version = remember { m.workspaceVersion }
    val originalAccess = remember { m.priorityAccessKey }
    LiveWorkspacePolling(
        m, "service",
        active = selected == null && proposed == null && !plansVisible && itemID == null,
    ) { m.loadService(automatic = true) }
    LaunchedEffect(m.workspaceVersion, m.priorityAccessKey) {
        if (version != m.workspaceVersion || originalAccess != m.priorityAccessKey) close()
    }
    itemID?.let {
        LiveAfterSalesView(m, it) {
            itemID = null
            m.loadService()
        }
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("服务任务中心", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = { m.loadService() }, enabled = !m.busy) { Text("刷新") }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LivePendingView(m)
                Text(m.serviceState, fontSize = 12.sp)
                if(m.identity?.allows("customer.experience.manage")==true) TextButton(onClick={plansVisible=true}){Text("桌边体验计划与主管处理")}
                if (focusedTask != null && !showAll) {
                    Text("正在核对提醒对应的原桌次任务", fontSize = 12.sp)
                    TextButton(onClick = { showAll = true }) { Text("查看全部服务任务") }
                }
                OutlinedTextField(
                    search,
                    { search = it },
                    label = { Text("桌号、任务或处理说明") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for ((key, label) in
                        listOf(
                            "all" to "全部",
                            "mine" to "我负责",
                            "urgent" to "紧急",
                            "manager" to "主管",
                        )) FilterChip(filter == key, { filter = key }, label = { Text(label) })
                }
                val rows =
                    m.serviceBoard?.tasks.orEmpty().filter {
                        (showAll ||
                            focusedTask == null ||
                            it.id == focusedTask && it.session == focusedSession) &&
                            (search.isBlank() ||
                                (it.table + it.title + it.source.textOrNull("detail").orEmpty())
                                    .contains(search, true)) &&
                            (filter == "all" ||
                                filter == "mine" && it.source.getBoolean("assignedToActor") ||
                                filter == "urgent" && it.priority in listOf("urgent", "high") ||
                                filter == "manager" && it.type == "guest.complaint")
                    }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (rows.isEmpty())
                        item {
                            Text(
                                if (focusedTask != null && !showAll) "原任务已完成、已转交或当前不可见；请刷新核对。"
                                else "没有符合条件的未完成任务"
                            )
                        }
                    items(rows, key = { it.id }) { row ->
                        Panel {
                            Text(row.table + " · " + row.title, fontSize = 18.sp)
                            Text(
                                LiveServiceBoard.priorities[row.priority] ?: "待核对",
                                color =
                                    if (row.priority == "urgent") MaterialTheme.colorScheme.error
                                    else Ink,
                                fontSize = 12.sp,
                            )
                            row.source.textOrNull("detail")?.let { Text(it) }
                            Text(
                                mapOf(
                                    "pending" to "待处理",
                                    "acknowledged" to "已接收",
                                    "in_progress" to "处理中",
                                )[row.status] ?: "待核对",
                                fontSize = 12.sp,
                            )
                            Text(
                                "提出时间：" +
                                    reservationTime(row.source.getString("createdAt")) +
                                    (row.source.textOrNull("dueAt")?.let {
                                        " · 应于 " + reservationTime(it)
                                    } ?: ""),
                                fontSize = 12.sp,
                            )
                            if (row.experience)
                                Text("体验服务：完成时同步原计划节点；中止计划须由主管在体验管理中处理。", fontSize = 12.sp)
                            if (row.specialized) {
                                val id = row.source.textOrNull("originalOrderItemId")
                                if (id != null && m.identity?.allows("refund.request") == true)
                                    SecondaryAction(onClick = { itemID = id }) {
                                        Text("核对原商品与补送份数")
                                    }
                                else Text("请在原商品或体验计划中处理，保留份数与原计划记录。", fontSize = 12.sp)
                            } else
                                SecondaryAction(
                                    onClick = {
                                        selected = row
                                        action = "complete"
                                        note = ""
                                        employee = ""
                                        priority = row.priority
                                        checked = false
                                        error = ""
                                    },
                                    enabled =
                                        m.canUseService &&
                                            (!row.experience ||
                                                m.serviceBoard?.durableExperience == true) &&
                                            (row.type != "guest.complaint" ||
                                                m.identity?.allows("service.manage") == true),
                                ) {
                                    Text(
                                        if (row.type == "guest.complaint") "主管处理 · 留下处理结果"
                                        else "处理此服务任务"
                                    )
                                }
                        }
                    }
                }
            }
        }
    }
    selected?.let { row ->
        Dialog(
            onDismissRequest = { selected = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                Column(
                    Modifier.safeDrawingPadding()
                        .imePadding()
                        .verticalScroll(rememberScrollState())
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(row.table + " · " + row.title, fontSize = 20.sp)
                    val manager = m.identity?.allows("service.manage") == true
                    for (a in
                        row.actions.filter { it != "cancel" || manager } +
                            (if (manager) listOf("assign", "priority") else emptyList())) Row {
                        RadioButton(action == a, { action = a })
                        Text(LiveServiceBoard.labels[a]!!)
                    }
                    if (action == "assign")
                        for (person in
                            m.serviceBoard?.employees.orEmpty().filter {
                                row.type != "guest.complaint" || it.getBoolean("canManage")
                            }) Row {
                            RadioButton(
                                employee == person.getString("id"),
                                { employee = person.getString("id") },
                            )
                            Text(person.getString("name"))
                        }
                    if (action == "priority")
                        for ((key, label) in LiveServiceBoard.priorities) Row {
                            RadioButton(priority == key, { priority = key })
                            Text(label)
                        }
                    OutlinedTextField(
                        note,
                        { note = it },
                        label = { Text("处理原因与结果；投诉至少4个字") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row {
                        Checkbox(checked, { checked = it })
                        Text("已核对原任务和现场情况")
                    }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Primary("下一步 · 核对处理结果", m.canUseService && checked) {
                        try {
                            proposed = m.prepareService(row.id, action, note, employee, priority)
                            selected = null
                        } catch (e: Exception) {
                            error = e.message ?: "请刷新"
                        }
                    }
                    TextButton(onClick = { selected = null }) { Text("返回") }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text(command.steps[0].serviceProof!!.getString("confirmation")) },
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
