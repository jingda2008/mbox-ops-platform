package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveBenefitsView(m: AppModel, close: () -> Unit) {
    var search by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var verified by remember { mutableStateOf(false) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(Unit) { m.loadBenefits() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("权益兑付", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text("返回") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    Text(m.benefitState, style = MaterialTheme.typography.bodySmall)
                    SecondaryAction(onClick = { m.loadBenefits() }, enabled = !m.busy) {
                        Text("刷新兑付队列")
                    }
                    OutlinedTextField(
                        search,
                        { search = it },
                        label = { Text("搜索桌号、会员号或权益名称") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
                    m.benefitBoard?.let { board ->
                        if (!board.enabled) Text("服务端尚未支持安全兑付，请先使用现有营业入口。")
                        if (!board.snacksEnabled) Text("每日点心服务未启用")
                        val rows =
                            board.rows
                                .filter {
                                    "${it.table} ${it.member} ${it.title}"
                                        .contains(search.trim(), true)
                                }
                                .sortedWith(
                                    compareBy<BenefitFulfillmentBoard.Row> {
                                            if (it.status == "reserved") 0 else 1
                                        }
                                        .thenBy { it.expires }
                                        .thenBy { it.id }
                                )
                        if (rows.isEmpty()) Text("当前范围没有权益兑付记录")
                        rows.forEach { row ->
                            key(row.id) {
                                BenefitFulfillmentCard(row, m.canUseBenefits) {
                                    cancel,
                                    product,
                                    reason ->
                                    try {
                                        proposed =
                                            board.command(
                                                row.id,
                                                cancel,
                                                product,
                                                reason,
                                                m.identity ?: error("请先登录"),
                                            )
                                        verified = false
                                        error = ""
                                    } catch (e: Exception) {
                                        error = e.message ?: "请核对原暂留"
                                    }
                                }
                            }
                        }
                    }
                    Text(
                        "核销成功后，仍需在出品与取送工作台完成制作、送达；已核销异常请走权益履约异常处理。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(command.steps[0].memberProof!!.getString("confirmation"))
                    Row {
                        Checkbox(verified, { verified = it })
                        Text("已当面核对会员、桌号、商品和份数")
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    },
                    enabled = verified && m.canExecuteLive(command),
                ) {
                    Text("确认执行")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}

@Composable
private fun BenefitFulfillmentCard(
    row: BenefitFulfillmentBoard.Row,
    enabled: Boolean,
    propose: (Boolean, String, String) -> Unit,
) {
    var product by
        remember(row.id) {
            mutableStateOf(
                row.products
                    .firstOrNull { it.getString("productId") == row.original }
                    ?.getString("productId") ?: ""
            )
        }
    var reason by remember(row.id) { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    Panel {
        Row {
            Text(row.table, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            Text(benefitStatusLabel(row.status))
        }
        Text("${row.title} · ${row.quantity}份", style = MaterialTheme.typography.titleMedium)
        Text(row.member)
        if (row.fulfillment.isNotBlank()) Text("出品进度：" + benefitStatusLabel(row.fulfillment))
        if (row.expires.isNotBlank())
            Text("暂留至 " + reservationTime(row.expires), style = MaterialTheme.typography.bodySmall)
        if (row.status == "reserved") {
            if (row.kind == "annual")
                Box {
                    TextButton(onClick = { menu = true }) {
                        Text(
                            "兑付商品：" +
                                (row.products
                                    .find { it.getString("productId") == product }
                                    ?.getString("name") ?: "请选择")
                        )
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        row.products.forEach { p ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        p.getString("name") +
                                            if (p.getBoolean("isOriginal")) " · 原商品" else " · 可替换"
                                    )
                                },
                                onClick = {
                                    product = p.getString("productId")
                                    menu = false
                                },
                            )
                        }
                    }
                }
            OutlinedTextField(
                reason,
                { reason = it },
                label = { Text("替换或取消原因") },
                modifier = Modifier.fillMaxWidth(),
            )
            Primary(
                "确认兑付",
                enabled && row.available && (row.kind != "annual" || product.isNotBlank()),
            ) {
                propose(false, product, reason)
            }
            SecondaryAction(
                onClick = { propose(true, "", reason) },
                enabled = enabled && reason.trim().length >= 2,
            ) {
                Text("取消未核销暂留")
            }
        }
    }
}
