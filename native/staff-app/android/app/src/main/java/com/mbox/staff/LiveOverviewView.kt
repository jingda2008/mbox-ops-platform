package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveOverviewView(m: AppModel, close: () -> Unit) {
    var period by remember { mutableStateOf("day") }
    var anchor by remember { mutableStateOf("") }
    val version = remember { m.workspaceVersion }
    val originalAccess = remember { m.priorityAccessKey }
    LaunchedEffect(m.priorityAccessKey) { if(m.priorityAccessKey != originalAccess)close() }
    LaunchedEffect(Unit) { m.loadOverview() }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row {
                        Text("经营概览", Modifier.weight(1f), fontSize = 22.sp)
                        TextButton(onClick = close) { Text("关闭") }
                    }
                    Text(m.overviewState, fontSize = 12.sp)
                    Row {
                        listOf(
                                "day" to "日",
                                "week" to "周",
                                "month" to "月",
                                "quarter" to "季",
                                "year" to "年",
                            )
                            .forEach { (key, label) ->
                                FilterChip(
                                    selected = period == key,
                                    onClick = { period = key },
                                    label = { Text(label) },
                                )
                            }
                    }
                    OutlinedTextField(
                        anchor,
                        { anchor = it },
                        label = { Text("营业日 YYYY-MM-DD，留空为当前") },
                    )
                    PrimaryAction(onClick = { m.loadOverview(period, anchor) }, enabled = !m.busy) {
                        Text("查询经营概览")
                    }
                    if (period != m.overviewPeriod || anchor != m.overviewAnchor)
                        Text("筛选已改变，请查询更新结果", fontSize = 12.sp)
                }
                m.overview?.let { r ->
                    item {
                        Text(
                            r.getJSONObject("range").getString("startDate") +
                                " 至 " +
                                r.getJSONObject("range").getString("endDate"),
                            fontSize = 18.sp,
                        )
                        Text(
                            if (r.getString("status") == "provisional") "数据暂估：仍有未对账或缺失成本"
                            else "系统已记录数据已完成当前核算"
                        )
                    }
                    item {
                        Panel {
                            Text("收款与退款", fontSize = 18.sp)
                            val cash = r.getJSONObject("revenue").getJSONObject("cash")
                            OverviewMetric("收款流水", cash.getLong("paymentReceiptsMinor"))
                            OverviewMetric("退款流水", cash.getLong("refundsMinor"))
                            OverviewMetric("净收款", cash.getLong("netReceiptsMinor"))
                            Text("净收款不等于营业收入或利润；渠道费和调整以账本口径为准。", fontSize = 12.sp)
                        }
                    }
                    item {
                        Panel {
                            Text("成本与经营利润", fontSize = 18.sp)
                            val c = r.getJSONObject("costs")
                            OverviewMetric("销售商品成本", c.getLong("goodsCostMinor"))
                            OverviewMetric("库存损耗", c.getLong("inventoryLossMinor"))
                            OverviewMetric("经营费用", c.getLong("operatingExpenseMinor"))
                            OverviewMetric(
                                "经营利润（已记录）",
                                r.getJSONObject("profit").getLong("operatingProfitMinor"),
                            )
                        }
                    }
                    item {
                        Panel {
                            Text("待核对数据", fontSize = 18.sp)
                            val g = r.getJSONObject("gaps")
                            OverviewMetric("已收未对账", g.getLong("unreconciledCapturedPaymentsMinor"))
                            OverviewMetric("券待结算", g.getLong("unsettledVoucherSettlementMinor"))
                            OverviewMetric("应计费用待实化", g.getLong("unactualizedAccrualMinor"))
                            OverviewMetric("缺付款日期成本", g.getLong("costsMissingCashDateMinor"))
                            Text(
                                "缺成本商品行 ${g.getInt("orderItemsMissingCostCount")} · 缺成本损耗 ${g.getInt("inventoryLossesMissingCostCount")}",
                                fontSize = 12.sp,
                            )
                        }
                    }
                    item {
                        val caveats = r.getJSONArray("caveats")
                        for (i in 0 until caveats.length()) Text(
                            caveats.getString(i),
                            fontSize = 12.sp,
                        )
                        Text("数据读取时间：" + r.getString("asOf"), fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun OverviewMetric(label: String, value: Long) {
    Row {
        Text(label, Modifier.weight(1f))
        Text(historyMoney(value))
    }
}
