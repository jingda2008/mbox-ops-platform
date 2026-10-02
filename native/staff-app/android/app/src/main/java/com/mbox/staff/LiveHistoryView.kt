package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun LiveHistoryView(m: AppModel) {
    var query by remember { mutableStateOf(m.historyQuery) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exportBytes by remember { mutableStateOf<ByteArray?>(null) }
    val exportFile =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri
            ->
            val bytes = exportBytes
            exportBytes = null
            if (uri != null && bytes != null)
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                                ?: error("无法打开所选文件")
                        }
                        m.message = "明细已保存"
                    } catch (e: Exception) {
                        m.message = "导出未完成：" + (e.message ?: "请重试")
                    }
                }
        }
    var statusMenu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (m.history == null) m.loadHistory() }
    LaunchedEffect(m.historyQuery) { query = m.historyQuery }
    Brand("订单", "门店 · 营业日查询")
    Body {
        if (!m.canReadHistory) Text("当前岗位没有订单历史查询权限")
        else {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(
                    selected = query.workKind == "",
                    onClick = { query = query.copy(workKind = "") },
                    label = { Text("全部订单") },
                )
                if (m.identity?.allows("kds.prepare") == true)
                    FilterChip(
                        selected = query.workKind == "prepared",
                        onClick = { query = query.copy(workKind = "prepared") },
                        label = { Text("我的已制作") },
                    )
                if (m.identity?.allows("kds.deliver") == true)
                    FilterChip(
                        selected = query.workKind == "delivered",
                        onClick = { query = query.copy(workKind = "delivered") },
                        label = { Text("已送达") },
                    )
            }
            OutlinedTextField(
                query.search,
                { query = query.copy(search = it) },
                label = { Text("桌号、订单号或金额") },
                enabled = !m.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            Foldout("日期与更多筛选") {
                Text("营业日以门店06:00分界，默认日期由服务器提供。", fontSize = 12.sp)
                OutlinedTextField(
                    query.date,
                    { query = query.copy(date = it) },
                    label = { Text("开始营业日 yyyy-MM-dd") },
                    enabled = !m.busy,
                )
                OutlinedTextField(
                    query.endDate,
                    { query = query.copy(endDate = it) },
                    label = { Text("结束营业日 yyyy-MM-dd") },
                    enabled = !m.busy,
                )
                OutlinedTextField(
                    query.table,
                    { query = query.copy(table = it) },
                    label = { Text("桌号（支持模糊查询）") },
                    enabled = !m.busy,
                )
                OutlinedTextField(
                    query.employee,
                    { query = query.copy(employee = it) },
                    label = { Text("下单员工，留空含顾客自助") },
                    enabled = !m.busy,
                )
                OutlinedTextField(
                    query.area,
                    { query = query.copy(area = it) },
                    label = { Text("区域") },
                    enabled = !m.busy,
                )
                Box {
                    TextButton(onClick = { statusMenu = true }, enabled = !m.busy) {
                        Text(
                            if (query.paymentStatus.isEmpty()) "全部支付状态"
                            else historyStatus(query.paymentStatus)
                        )
                    }
                    DropdownMenu(statusMenu, { statusMenu = false }) {
                        HistoryQuery.statuses.forEach { status ->
                            DropdownMenuItem(
                                text = {
                                    Text(if (status.isEmpty()) "全部状态" else historyStatus(status))
                                },
                                onClick = {
                                    query = query.copy(paymentStatus = status)
                                    statusMenu = false
                                },
                            )
                        }
                    }
                }
            }
            Primary("查询", enabled = !m.busy, icon = Icons.Outlined.Search) { m.loadHistory(query) }
            SecondaryAction(
                onClick = {
                    query = HistoryQuery()
                    m.loadHistory()
                },
                enabled = !m.busy,
                icon = Icons.Outlined.CalendarToday,
            ) {
                Text("当前营业日")
            }
            if (m.historyState.isNotEmpty()) Text(m.historyState)
            m.history?.let { data ->
                Text("${data.date} 至 ${data.endDate} · 第${data.page+1}页")
                if (query != m.historyQuery) Text("筛选已修改；下方仍为上次查询结果，请点击查询。", fontSize = 12.sp)
                if (data.source.optBoolean("financialSummaryVisible", true))
                    Foldout("所选营业日 · 全店已入账资金") {
                        Text("资金流水不受桌号、员工筛选影响；待确认支付不计入收款。", fontSize = 12.sp)
                        data.source
                            .textOrNull("financialStartDate")
                            ?.takeIf { it != data.date }
                            ?.let { Text("岗位资金可见范围自 $it 起", fontSize = 12.sp) }
                        data.source.optJSONObject("summary")?.let { summary ->
                            Text(
                                "期间销售 ${historyMoney(summary.getString("orderAmountMinor").toLongOrNull())} · 当前尚待收款 ${historyMoney(summary.getString("outstandingMinor").toLongOrNull())}"
                            )
                            Text(
                                "未结${summary.getInt("unsettledCount")}单 · 待确认支付${summary.getInt("pendingPaymentCount")}笔 · 待处理退款${summary.getInt("pendingRefundCount")}笔",
                                fontSize = 12.sp,
                            )
                        }
                        data.receipts.forEach { row ->
                            Text(
                                "${row.getString("provider")} · 收款 ${historyMoney(row.getLong("receivedMinor"))} · 退款 ${historyMoney(row.getLong("refundedMinor"))} · 净收 ${historyMoney(row.getLong("netMinor"))}"
                            )
                        }
                        if (data.receipts.isEmpty())
                            Text("所选期间没有已入账收退款流水；不代表没有待核对款项。", fontSize = 12.sp)
                    }
                Row {
                    TextButton(
                        onClick = {
                            m.exportHistory(false) { bytes ->
                                if (bytes != null) {
                                    exportBytes = bytes
                                    exportFile.launch("营业明细-${data.date}-第${data.page+1}页.csv")
                                }
                            }
                        },
                        enabled = !m.busy && query == m.historyQuery && data.orders.isNotEmpty(),
                    ) {
                        Text("导出本页")
                    }
                    TextButton(
                        onClick = {
                            m.exportHistory(true) { bytes ->
                                if (bytes != null) {
                                    exportBytes = bytes
                                    exportFile.launch("营业明细-${data.date}-全部.csv")
                                }
                            }
                        },
                        enabled = !m.busy && query == m.historyQuery && data.orders.isNotEmpty(),
                    ) {
                        Text("导出全部筛选结果")
                    }
                }
                Text("导出前重新读取同一筛选范围，最多5000单；请在系统保存窗口选择位置。", fontSize = 12.sp)
                data.orders.forEach { order ->
                    key(order.getString("id")) { HistoryOrderCard(order) }
                }
                if (data.orders.isEmpty()) Text("没有符合筛选条件的订单")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(
                        onClick = { m.loadHistory(m.historyQuery, data.page - 1) },
                        enabled = !m.busy && data.page > 0 && query == m.historyQuery,
                    ) {
                        Text("上一页")
                    }
                    Text("第${data.page+1}页")
                    TextButton(
                        onClick = { m.loadHistory(m.historyQuery, data.page + 1) },
                        enabled = !m.busy && data.hasMore && query == m.historyQuery,
                    ) {
                        Text("下一页")
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryOrderCard(order: org.json.JSONObject) {
    Foldout(
        "${order.getString("tableCode")} · ${historyMoney(order.longOrNull("effectiveAmountMinor") ?: order.getLong("totalMinor"))} · ${historyStatus(order.getString("paymentStatus"))}"
    ) {
        Text(order.getString("publicId"))
        Text(
            "桌次：${order.textOrNull("sessionPublicId") ?: order.textOrNull("tableSessionId") ?: "未留存"} · ${order.textOrNull("areaName") ?: ""}",
            fontSize = 12.sp,
        )
        Text(
            "${order.getString("submittedAt")} · ${order.textOrNull("employeeName") ?: "顾客自助"} · ${historyStatus(order.getString("status"))}",
            fontSize = 12.sp,
        )
        order
            .longOrNull("receivableIncreaseMinor")
            ?.takeIf { it > 0 }
            ?.let {
                Text("原应付 ${historyMoney(order.getLong("totalMinor"))} · 套餐补差 ${historyMoney(it)}")
            }
        order
            .longOrNull("stoppedAmountMinor")
            ?.takeIf { it > 0 }
            ?.let { Text("退菜减额 ${historyMoney(it)}") }
        order.getJSONArray("items").objects().forEach { item ->
            Column(
                Modifier.padding(vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(
                    "${item.getString("name")} ×${item.getInt("quantity")}",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    if (item.optBoolean("includedInBundle", false)) "套餐内商品，不另收费"
                    else
                        "成交单价 ${historyMoney(item.getLong("unitPriceMinor"))} · 小计 ${historyMoney(item.getLong("totalMinor"))}"
                )
                Text(
                    item.textOrNull("fulfillmentClosureNote")
                        ?: historyStatus(item.getString("status"))
                )
                item.optJSONObject("quantities")?.let { q ->
                    Text(
                        "暂停${q.getInt("held")} · 停止${q.getInt("stopped")} · 备齐${q.getInt("ready")} · 送达${q.getInt("delivered")} · 恢复库存${item.optInt("returnedQuantity",0)} · 已耗不回库${q.getInt("usedLoss")}",
                        fontSize = 12.sp,
                    )
                }
                item.textOrNull("note")?.takeIf { it.isNotEmpty() }?.let { Text("商品备注：$it") }
                item.textOrNull("preparedAt")?.let {
                    Text("制作完成：${item.textOrNull("preparedBy") ?: "员工未留存"} · $it", fontSize = 12.sp)
                }
                if (item.getString("status") == "delivered")
                    Text(
                        item.textOrNull("deliveredAt")?.let {
                            "送达：${item.textOrNull("deliveredBy") ?: "员工未留存"} · $it"
                        } ?: "历史送达凭据未留存",
                        fontSize = 12.sp,
                    )
            }
        }
    }
}
