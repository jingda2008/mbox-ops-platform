package com.mbox.staff

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveFinanceView(m: AppModel, close: () -> Unit) {
    var date by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var cashierQuery by remember { mutableStateOf<String?>(null) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    LaunchedEffect(Unit) { m.loadFinance(FinanceQuery()) }
    LaunchedEffect(cashierQuery) { if (cashierQuery == null) m.loadFinance() }
    fun propose(row: String? = null, resolve: Boolean = false, closeDay: Boolean = false) {
        try {
            proposed = m.prepareFinance(row, note, resolve, closeDay)
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请刷新核对"
        }
    }
    fun openCashier(value: String) {
        if (value.length > 64) error = "原凭证超过查询长度，请复制完整凭证并在收银按桌号核对" else cashierQuery = value
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("日结与对账", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { m.loadFinance() }, enabled = !m.busy) { Text("刷新") }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                        if (m.financeState.isNotEmpty()) Text(m.financeState)
                    }
                    if (m.identity?.allows("reconciliation.view") == true) {
                        item {
                            OutlinedTextField(
                                date,
                                { date = it },
                                label = { Text("营业日 YYYY-MM-DD，留空为当前") },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Row(Modifier.horizontalScroll(rememberScrollState())) {
                                listOf(
                                        "" to "全部",
                                        "payment" to "收款",
                                        "refund" to "退款",
                                        "fee" to "费用",
                                        "adjustment" to "调整",
                                    )
                                    .forEach { (code, label) ->
                                        FilterChip(
                                            selected = type == code,
                                            onClick = { type = code },
                                            label = { Text(label) },
                                        )
                                    }
                            }
                            SecondaryAction(
                                onClick = { m.loadFinance(FinanceQuery(date, type)) },
                                enabled = !m.busy,
                                icon = Icons.Outlined.Search,
                            ) {
                                Text("查询此营业日流水")
                            }
                        }
                        if (
                            m.financeUpdated != null &&
                                (type != m.financeQuery.type ||
                                    (date.isNotEmpty() && date != m.financeQuery.date))
                        )
                            item { Text("筛选已更改，请点击查询更新结果。", fontSize = 12.sp) }
                        val summary = m.financeSummary
                        if (summary != null && summary.opt("financialSummaryVisible") != false)
                            item {
                                Card {
                                    Column(
                                        Modifier.padding(14.dp),
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        val receipts = financeRows(summary, "receipts")
                                        Text(
                                            "营业日 " + summary.getString("businessDate"),
                                            style = MaterialTheme.typography.titleMedium,
                                        )
                                        Text(
                                            "净收 " +
                                                historyMoney(
                                                    receipts.sumOf { it.getLong("netMinor") }
                                                ),
                                            style = MaterialTheme.typography.headlineSmall,
                                        )
                                        Text(
                                            "收款 " +
                                                historyMoney(
                                                    receipts.sumOf { it.getLong("receivedMinor") }
                                                ) +
                                                " · 退款 " +
                                                historyMoney(
                                                    receipts.sumOf { it.getLong("refundedMinor") }
                                                )
                                        )
                                        summary.optJSONObject("summary")?.let { totals ->
                                            Text(
                                                "待收 " +
                                                    (totals
                                                        .optString("outstandingMinor")
                                                        .toLongOrNull()
                                                        ?.let(::historyMoney) ?: "待核对") +
                                                    " · 未结 ${totals.getInt("unsettledCount")}单"
                                            )
                                            Text(
                                                "待定付款 ${totals.getInt("pendingPaymentCount")} · 待处理退款 ${totals.getInt("pendingRefundCount")}",
                                                fontSize = 12.sp,
                                            )
                                        }
                                        receipts.forEach {
                                            Text(
                                                cashierProvider(it.getString("provider")) +
                                                    " · 收 " +
                                                    historyMoney(it.getLong("receivedMinor")) +
                                                    " / 退 " +
                                                    historyMoney(it.getLong("refundedMinor")),
                                                fontSize = 12.sp,
                                            )
                                        }
                                        Text(
                                            "06:00划分营业日。销售按订单营业日，收退款按资金入账营业日；未知支付不算到账。",
                                            fontSize = 12.sp,
                                        )
                                    }
                                }
                            }
                        item {
                            Text(
                                "已入账流水 · 当前已读${m.financeEntries.size}条",
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        items(m.financeEntries, key = { it.getString("id") }) { row ->
                            Column {
                                Text(
                                    (mapOf(
                                        "payment" to "收款 ",
                                        "refund" to "退款 ",
                                        "fee" to "费用 ",
                                        "adjustment" to "调整 ",
                                    )[row.getString("entryType")] ?: "未知类型 ") +
                                        if (row.getString("currency") == "CNY")
                                            historyMoney(row.getLong("amountMinor"))
                                        else
                                            row.getString("currency") +
                                                " ${row.getLong("amountMinor")}分"
                                )
                                Text(
                                    cashierProvider(row.getString("provider")) +
                                        " · " +
                                        assignmentTime(row.getString("occurredAt")),
                                    fontSize = 12.sp,
                                )
                                Text(row.getString("providerReference"), fontSize = 12.sp)
                                TextButton(
                                    onClick = { openCashier(row.getString("providerReference")) }
                                ) {
                                    Text("按原凭证核对")
                                }
                            }
                        }
                        if (m.financeNext != null)
                            item {
                                SecondaryAction(
                                    onClick = {
                                        m.loadFinance(
                                            reviewPage = m.financeReviewPage,
                                            moreEntries = true,
                                        )
                                    },
                                    enabled = !m.busy,
                                ) {
                                    Text("读取下一页流水")
                                }
                            }
                        item {
                            Text(
                                "财务异常跟进 · 第${m.financeReviewPage + 1}页",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text("包含跨营业日待核对款项，不受上方日期筛选限制。", fontSize = 12.sp)
                            if (m.financeReviews.isEmpty()) Text("当前没有待跟进记录", fontSize = 12.sp)
                        }
                        items(m.financeReviews, key = { it.getString("id") }) { row ->
                            val id = row.getString("id")
                            Card {
                                Column(
                                    Modifier.padding(14.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        (row.textOrNull("tableCode") ?: "待核对桌号") +
                                            " · " +
                                            cashierStatus(row.getString("status")),
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Text(row.getString("publicId"), fontSize = 12.sp)
                                    Text(
                                        "原付款金额 " +
                                            (row.getString("amountMinor")
                                                .toLongOrNull()
                                                ?.let(::historyMoney) ?: "待核对") +
                                            " · 不代表已到账",
                                        fontSize = 12.sp,
                                    )
                                    Text(
                                        "负责人：" +
                                            (row.textOrNull("ownerName") ?: "待接手") +
                                            "\n" +
                                            (row.textOrNull("note") ?: "尚无核对记录")
                                    )
                                    if ((row.optJSONArray("financialSignals")?.length() ?: 0) > 0)
                                        Text("有财务异常信号，需核对原款与退款后处理。", fontSize = 12.sp)
                                    SecondaryAction(
                                        onClick = {
                                            openCashier(
                                                row.textOrNull("orderPublicId")
                                                    ?: row.getString("publicId")
                                            )
                                        },
                                        icon = Icons.Outlined.Search,
                                    ) {
                                        Text("打开原订单收银核对")
                                    }
                                    if (m.identity?.allows("reconciliation.manage") == true) {
                                        if (editing == id) {
                                            OutlinedTextField(
                                                note,
                                                { note = it },
                                                label = { Text("核对记录（3—1000字）") },
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                            Primary(
                                                "本人接手并保存进展",
                                                enabled = m.canAct("reconciliation.manage"),
                                                icon = Icons.Outlined.Edit,
                                            ) {
                                                propose(id)
                                            }
                                            if (financeCanResolve(row))
                                                SecondaryAction(
                                                    onClick = { propose(id, resolve = true) },
                                                    enabled = m.canAct("reconciliation.manage"),
                                                ) {
                                                    Text("核对完成，结案")
                                                }
                                            TextButton(
                                                onClick = {
                                                    editing = null
                                                    note = ""
                                                }
                                            ) {
                                                Text("取消编辑")
                                            }
                                        } else
                                            SecondaryAction(
                                                onClick = {
                                                    editing = id
                                                    note = row.textOrNull("note") ?: ""
                                                }
                                            ) {
                                                Text("记录核对进展")
                                            }
                                    }
                                }
                            }
                        }
                        item {
                            Row {
                                TextButton(
                                    onClick = {
                                        m.loadFinance(reviewPage = m.financeReviewPage - 1)
                                    },
                                    enabled = !m.busy && m.financeReviewPage > 0,
                                ) {
                                    Text("上一页")
                                }
                                Spacer(Modifier.weight(1f))
                                TextButton(
                                    onClick = {
                                        m.loadFinance(reviewPage = m.financeReviewPage + 1)
                                    },
                                    enabled = !m.busy && m.financeMoreReviews,
                                ) {
                                    Text("下一页")
                                }
                            }
                        }
                    }
                    if (m.identity?.allows("business_day.close") == true)
                        item {
                            Primary(
                                "检查并结束上一营业日",
                                enabled = m.canAct("business_day.close"),
                                icon = Icons.Outlined.EventAvailable,
                            ) {
                                propose(closeDay = true)
                            }
                        }
                    val receipt =
                        m.financeReceipt?.takeIf {
                            it.getString("employeeID") == m.identity?.employeeId
                        }
                    if (receipt != null && receipt.getString("kind") == "close-day") {
                        val result = receipt.getJSONObject("response").getJSONObject("data")
                        item {
                            Text(
                                "结束处理回执 · 已关${result.getInt("closedBusinessDayCount")}日 / ${result.getInt("closedTableSessionCount")}桌，待处理${result.getInt("blockedTableSessionCount")}桌"
                            )
                        }
                        financeRows(result, "businessDays").forEach { day ->
                            item {
                                Text(
                                    day.getString("businessDate") +
                                        if (day.getString("status") == "closed") " · 已结束"
                                        else " · 仍有未完成事项"
                                )
                            }
                            items(financeRows(day, "blockers")) { blocker ->
                                Foldout(
                                    blocker.getString("tableCode") +
                                        " · " +
                                        blocker.getString("label") +
                                        " ${blocker.getInt("count")}项"
                                ) {
                                    Text(blocker.getString("resolution"), fontSize = 12.sp)
                                    financeRows(blocker, "facts").forEach { fact ->
                                        Text(
                                            fact.getString("title") +
                                                " · " +
                                                fact.getString("statusLabel")
                                        )
                                        Text(fact.getString("reference"), fontSize = 12.sp)
                                        if (!fact.isNull("amountMinor"))
                                            Text(historyMoney(fact.getLong("amountMinor")))
                                        fact.textOrNull("orderPublicId")?.let { order ->
                                            TextButton(onClick = { openCashier(order) }) {
                                                Text("核对原订单")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else if (receipt != null)
                        item { Text("财务核对记录已保存，已回读当前处理列表。", fontSize = 12.sp) }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = {
                Text(
                    command.steps[0].financeProof!!.getString("confirmation"),
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    },
                    enabled = m.canAct(command.permission),
                ) {
                    Text("确认提交")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } },
        )
    }
    cashierQuery?.let { query ->
        Dialog(
            onDismissRequest = { cashierQuery = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                Column(Modifier.safeDrawingPadding()) {
                    TextButton(onClick = { cashierQuery = null }) { Text("返回对账") }
                    LiveCashierView(m, initialQuery = query)
                }
            }
        }
    }
}
