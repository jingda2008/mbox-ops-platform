package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun LivePendingView(m: AppModel) {
    var supervisorCommand by remember { mutableStateOf<LiveCommand?>(null) }
    supervisorCommand?.let { LiveServiceRecoveryView(m,it) { supervisorCommand=null } }
    if (m.liveStorageDamaged)
        Text("未决操作记录异常，真实操作已锁定，请联系管理员", color = MaterialTheme.colorScheme.error)
    m.liveOrderPending?.let { order ->
        Panel {
            Text(
                order.tableCode + if (order.rejectedCode == null) " · 订单结果待确认" else " · 下单被拒绝",
                style = MaterialTheme.typography.titleMedium,
            )
            androidx.compose.foundation.text.selection.SelectionContainer {
                Text(order.publicId, fontSize = 12.sp)
                order.replacement?.let { Text(it.explanation, fontSize = 12.sp) }
            }
            Text(
                if (order.rejectedCode == null) "原请求已保存。核对前不能重新下单、换员工或操作其他真实业务。"
                else "服务器明确拒绝本次下单，原清单已保留。",
                fontSize = 12.sp,
            )
            SecondaryAction(
                onClick = {
                    if (order.rejectedCode == null) m.recoverLiveOrder()
                    else m.dismissRejectedOrder()
                },
                enabled = !m.busy && m.identity?.employeeId == order.employeeID,
                icon = Icons.Outlined.Refresh,
            ) {
                Text(if (order.rejectedCode == null) "核对原订单" else "返回修改清单")
            }
        }
    }
    m.livePending?.let { command ->
        Panel {
            Text(command.title + if (command.rejected) " · 未完成" else " · 结果待确认")
            Text("原请求已保留，请由原员工核对。", fontSize = 12.sp)
            if(command.steps.size>1){Text("已确认 ${command.completedSteps}/${command.steps.size} 步；中途停止保留已确认结果。",fontSize=12.sp);if(command.rejected)Text("清除仅移除本机失败请求，不撤销此前已成功步骤；未执行步骤须刷新后重新核对。",fontSize=12.sp)}
            SecondaryAction(
                onClick = { if (command.rejected) m.dismissRejectedLive() else m.recoverLive() },
                enabled = !m.busy && command.employeeID == m.identity?.employeeId,
                icon = Icons.Outlined.Refresh,
            ) {
                Text(if (command.rejected) "已知晓，清除失败请求" else "核对原操作结果")
            }
            if(runCatching { serviceRecoveryStep(command) }.isSuccess)
                TextButton(onClick={supervisorCommand=command},enabled=!m.busy&&!m.liveStorageDamaged) { Text("原员工无法处理？主管核对") }
        }
    }
}

@Composable
fun LiveTableActions(m: AppModel, tableID: String) {
    val table = m.liveOperations?.tables?.find { it.display.id == tableID } ?: return
    val t = table.display
    var observationSession by remember { mutableStateOf<String?>(null) }
    observationSession?.let { session ->
        LiveObservationView(m, session, t.code) { observationSession = null }
    }
    var showParticipants by remember { mutableStateOf(false) }
    if (showParticipants) LiveParticipantsView(m, tableID) { showParticipants = false }
    var people by remember(tableID) { mutableIntStateOf(1) }
    var target by remember(tableID) { mutableStateOf("") }
    var targetsExpanded by remember { mutableStateOf(false) }
    var reason by remember(tableID) { mutableStateOf("") }
    var turnoverReason by remember(tableID) { mutableStateOf("") }
    var capacityReason by remember(tableID) { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var ordersVisible by remember { mutableStateOf(false) }
    var menuDestination by remember { mutableStateOf<MenuDestination?>(null) }
    var assignmentsVisible by remember { mutableStateOf(false) }
    if (assignmentsVisible)
        LiveAssignmentsView(m, initialTableID = tableID) { assignmentsVisible = false }
    var collectionVisible by remember { mutableStateOf(false) }
    if (collectionVisible && t.session != null)
        LiveCollectionView(m, t.session, t.code) { collectionVisible = false }
    menuDestination?.let { destination ->
        LiveCatalogView(m, destination.session, destination.tableCode) { menuDestination = null }
    }
    LaunchedEffect(t.session) {
        if (menuDestination != null && menuDestination?.session != t.session) menuDestination = null
    }
    fun propose(kind: String, taskID: String? = null, frozen: Boolean = false) {
        try {
            proposed =
                m.prepareLive(
                    kind,
                    tableID,
                    people,
                    target,
                    taskID,
                    frozen,
                    if (kind == "turnover") turnoverReason
                    else if (kind in listOf("open", "transfer")) capacityReason else reason,
                )
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新后重试"
        }
    }
    LivePendingView(m)
    if (
        t.session != null &&
            table.sessionStatus == "open" &&
            m.identity?.allows("order.create") == true
    ) {
        Primary("点菜 / 加菜 · 已选 ${m.liveDraft(t.session).size} 份", !m.busy) {
            menuDestination = MenuDestination(t.session, t.code)
        }
    }
    if (
        t.session != null &&
            table.sessionStatus in listOf("open", "closing") &&
            (m.identity?.allows("observation.record") == true ||
                m.identity?.allows("recommendation.staff.modify") == true)
    ) {
        SecondaryAction(onClick = { observationSession = t.session }, enabled = !m.busy) {
            Text("桌台观察 · 推荐调整")
        }
    }
    if (table.sessionStatus == "open" && m.identity?.allows(ParticipantInput.permission) == true) {
        SecondaryAction(onClick = { showParticipants = true }, enabled = !m.busy) {
            Text("人员拆桌 / 并桌")
        }
    }
    SecondaryAction(
        onClick = { assignmentsVisible = true },
        enabled = !m.busy,
        icon = Icons.Outlined.People,
    ) {
        Text("人员与责任桌")
    }
    if (table.status == "paused") Text("此桌台已停用，不能开台")
    if (t.session == null) {
        if (m.identity?.allows("table.open") == true) {
            Row {
                Text("用餐人数：$people", Modifier.weight(1f))
                TactileIconButton(onClick = { people-- }, enabled = people > 1) {
                    Icon(Icons.Outlined.Remove, "减少人数")
                }
                TactileIconButton(
                    onClick = { people++ },
                    enabled = people < 200,
                    prominent = true,
                ) {
                    Icon(Icons.Outlined.Add, "增加人数")
                }
            }
            Text("常规容量 ${t.capacity}人", fontSize = 12.sp)
            if (people > t.capacity)
                OutlinedTextField(
                    capacityReason,
                    { capacityReason = it },
                    label = { Text("现场加座说明（2—1000字）") },
                    modifier = Modifier.fillMaxWidth(),
                )
            Primary("确认开台", m.canAct("table.open") && table.status == "available") {
                propose("open")
            }
        }
    } else {
        if (LivePaymentOrder.permissions.any { m.identity?.allows(it) == true }) {
            SecondaryAction(
                onClick = { collectionVisible = true },
                enabled = !m.busy,
                icon = Icons.Outlined.CreditCard,
            ) {
                Text("查看应收 · 登记收款")
            }
        }
        SecondaryAction(
            onClick = {
                ordersVisible = true
                m.loadLiveOrders(t.session)
            },
            enabled = !m.busy,
            icon = Icons.Outlined.ReceiptLong,
        ) {
            Text("查看本桌订单")
        }
        m.liveOperations
            ?.tasks
            ?.filter { it.session == t.session }
            ?.forEach { task ->
                Panel {
                    Text(task.title)
                    if (task.detail.isNotBlank()) Text(task.detail, fontSize = 13.sp)
                    if (
                        task.mode == "quick_complete" &&
                            m.identity?.allows("service.execute") == true
                    )
                        SecondaryAction(
                            onClick = { propose("service", task.id) },
                            enabled = m.canAct("service.execute"),
                            icon = Icons.Outlined.CheckCircle,
                        ) {
                            Text("完成服务")
                        }
                    else Text("请由主管处理此任务", fontSize = 12.sp)
                }
            }
        if (m.identity?.allows("table.transfer") == true)
            Panel {
                Box {
                    TextButton(onClick = { targetsExpanded = true }) {
                        Text(
                            m.liveOperations
                                ?.tables
                                ?.find { it.display.id == target }
                                ?.display
                                ?.code ?: "选择空闲桌"
                        )
                    }
                    DropdownMenu(
                        expanded = targetsExpanded,
                        onDismissRequest = { targetsExpanded = false },
                    ) {
                        m.liveOperations
                            ?.tables
                            ?.filter {
                                it.display.id != tableID &&
                                    it.status == "available" &&
                                    it.display.session == null
                            }
                            ?.forEach { option ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            option.display.code + " · ${option.display.capacity}人桌"
                                        )
                                    },
                                    onClick = {
                                        target = option.display.id
                                        targetsExpanded = false
                                    },
                                )
                            }
                    }
                }
                val destination = m.liveOperations?.tables?.find { it.display.id == target }
                if (destination != null && t.people > destination.display.capacity)
                    OutlinedTextField(
                        capacityReason,
                        { capacityReason = it },
                        label = { Text("现场加座说明（2—1000字）") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                SecondaryAction(
                    onClick = { propose("transfer") },
                    enabled = target.isNotEmpty() && m.canAct("table.transfer"),
                    icon = Icons.Outlined.SwapHoriz,
                ) {
                    Text("转台")
                }
            }
        if (m.identity?.allows("guest.cart.freeze") == true)
            Panel {
                if (!table.frozen)
                    OutlinedTextField(
                        reason,
                        { reason = it },
                        label = { Text("暂停客人加购的原因") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                SecondaryAction(
                    onClick = { propose("freeze", frozen = !table.frozen) },
                    enabled =
                        m.canAct("guest.cart.freeze") &&
                            (table.frozen || reason.trim().length in 2..500),
                    icon =
                        if (table.frozen) Icons.Outlined.PlayCircle else Icons.Outlined.PauseCircle,
                ) {
                    Text(if (table.frozen) "恢复客人加购" else "暂停客人加购")
                }
            }
        if (
            m.identity?.allows("table.turnover_unsettled") == true &&
                m.identity?.allows("table.close") == true
        ) {
            Foldout("顾客已离店 · 特殊翻台") {
                Text("仅在顾客确已离店时使用。原订单、欠款及退款继续保留，不代表结清或免单。", fontSize = 12.sp)
                OutlinedTextField(
                    turnoverReason,
                    { turnoverReason = it },
                    label = { Text("填写实际离店与翻台原因") },
                )
                SecondaryAction(
                    onClick = { propose("turnover") },
                    enabled =
                        m.canAct("table.turnover_unsettled") &&
                            turnoverReason.trim().length in 2..500,
                    danger = true,
                    icon = Icons.Outlined.Logout,
                ) {
                    Text("确认已离店，保留原账翻台")
                }
            }
        }
        if (m.identity?.allows("table.close") == true) {
            SecondaryAction(
                onClick = { propose("close") },
                enabled = m.canAct("table.close"),
                danger = true,
                icon = Icons.Outlined.Logout,
            ) {
                Text(if (table.sessionStatus == "closing") "继续结束用餐" else "结束用餐 · 释放桌台")
            }
            Text("门店系统将核对未收款、退款与未完成服务，未满足条件不会释放桌台。", fontSize = 12.sp)
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = {
                Text(
                    org.json
                        .JSONObject(command.steps[0].body)
                        .optString("capacityOverrideReason")
                        .takeIf { it.isNotEmpty() }
                        ?.let { "加座说明：$it\n请确认现场安排和原桌号。" } ?: "将更新门店真实数据，请核对桌号和操作内容。"
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    }
                ) {
                    Text("确认操作")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
    if (ordersVisible)
        AlertDialog(
            onDismissRequest = { ordersVisible = false },
            title = { Text("本桌订单") },
            text = {
                Column(
                    Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (m.orderDetailState.isNotEmpty()) Text(m.orderDetailState)
                    m.liveOrders.forEach { order ->
                        Text("${order.id} · ${money(order.amount)}")
                        order.items.forEach {
                            Text(
                                "${it.name} ×${it.quantity}\n${it.stateLabel} · ${money(it.amount)}",
                                fontSize = 13.sp,
                            )
                        }
                        HorizontalDivider()
                    }
                }
            },
            confirmButton = { TextButton(onClick = { ordersVisible = false }) { Text("关闭") } },
            dismissButton = {
                TextButton(
                    onClick = { t.session?.let { m.loadLiveOrders(it) } },
                    enabled = !m.busy,
                ) {
                    Text("刷新")
                }
            },
        )
}
