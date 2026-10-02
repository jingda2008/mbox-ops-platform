package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun LiveBusinessReportsView(m: AppModel, close: () -> Unit) {
    val originalAccess = remember { m.priorityAccessKey }; val version = remember { m.workspaceVersion }
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(if(BusinessReports.allowed(m.identity,"sales")) "sales" else "experience") }
    var filters by remember { mutableStateOf(mapOf("days" to "7")) }
    var report by remember { mutableStateOf<JSONObject?>(null) }
    var applied by remember { mutableStateOf<Map<String,String>?>(null) }
    var notice by remember { mutableStateOf("请查询服务器记录") }
    var generation by remember { mutableIntStateOf(0) }
    var localQuery by remember { mutableStateOf("") }
    LaunchedEffect(m.priorityAccessKey,m.workspaceVersion) { if(originalAccess != m.priorityAccessKey || version != m.workspaceVersion) { report = null; close() } }
    if(originalAccess != m.priorityAccessKey || version != m.workspaceVersion) return
    fun load() {
        val request = ++generation; val selected = kind; val query = filters.toMap(); report = null; notice = "正在查询"
        scope.launch {
            try { val result = m.readBusinessReport(selected,query); if(request == generation && selected == kind) { report = result; applied = query; notice = "已读取服务器记录" } }
            catch(e: kotlinx.coroutines.CancellationException) { throw e }
            catch(e: Exception) { if(request == generation) notice = e.message ?: "读取失败，请重试" }
        }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(),color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Row { Text("经营分析",Modifier.weight(1f),style = MaterialTheme.typography.titleLarge); TextButton(onClick = close) { Text("关闭") } } }
                item {
                    AssignmentChoice("报表",kind,listOf("sales" to "员工销售", "experience" to "客户体验").filter { BusinessReports.allowed(m.identity,it.first) }) { kind = it; generation++; report = null; applied = null; notice = "请查询"; localQuery = "" }
                    if(kind == "sales") {
                        OutlinedTextField(filters["startDate"].orEmpty(),{ filters = filters + ("startDate" to it) },label = { Text("开始营业日 YYYY-MM-DD") },modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(filters["endDate"].orEmpty(),{ filters = filters + ("endDate" to it) },label = { Text("结束营业日 YYYY-MM-DD") },modifier = Modifier.fillMaxWidth())
                        Text("日期都留空时查询服务器当前营业日；只显示岗位授权范围。")
                    } else {
                        AssignmentChoice("观察周期",filters["days"].orEmpty(),listOf("7" to "最近7天","28" to "最近28天","84" to "最近84天")) { filters = filters + ("days" to it) }
                        Foldout("筛选商品、员工与场景") {
                            val products = report?.let { it.getJSONArray("products").objects() + it.getJSONArray("recommendation").objects() }.orEmpty().distinctBy { it.getString("productId") }
                            val staff = report?.getJSONObject("dataQuality")?.getJSONArray("staff")?.objects().orEmpty()
                            val packages = report?.getJSONArray("packageOptions")?.objects().orEmpty()
                            AssignmentChoice("商品",filters["productId"].orEmpty(),listOf("" to "全部") + products.map { it.getString("productId") to it.getString("productName") }) { filters = filters + ("productId" to it) }
                            AssignmentChoice("套餐",filters["packageProductId"].orEmpty(),listOf("" to "全部") + packages.map { it.getString("productId") to it.getString("productName") }) { filters = filters + ("packageProductId" to it) }
                            AssignmentChoice("员工",filters["employeeId"].orEmpty(),listOf("" to "全部") + staff.map { it.getString("employeeId") to it.getString("employeeName") }) { filters = filters + ("employeeId" to it) }
                            Text("可选商品和员工来自已查询的记录；清空筛选后查询可恢复列表。")
                            AssignmentChoice("场景",filters["occasion"].orEmpty(),BusinessReports.occasions.toList()) { filters = filters + ("occasion" to it) }
                            AssignmentChoice("演出阶段",filters["performancePhase"].orEmpty(),BusinessReports.phases.toList()) { filters = filters + ("performancePhase" to it) }
                            AssignmentChoice("推荐结果",filters["recommendationOutcome"] ?: "all",BusinessReports.outcomes.toList()) { filters = filters + ("recommendationOutcome" to it) }
                            OutlinedTextField(filters["tableCode"].orEmpty(),{ filters = filters + ("tableCode" to it) },label = { Text("桌号（精确统计范围）") })
                            OutlinedTextField(filters["partySize"].orEmpty(),{ filters = filters + ("partySize" to it) },label = { Text("人数，可留空") })
                            TextButton(onClick = { filters = mapOf("days" to (filters["days"] ?: "7")) }) { Text("清空筛选") }
                        }
                    }
                    PrimaryAction(onClick = { load() },enabled = !m.busy && BusinessReports.allowed(m.identity,kind)) { Text("查询") }
                    Text(notice)
                    if(report != null && filters != applied) Text("筛选已改变，以下仍为上次查询结果。")
                }
                if(kind == "sales") report?.let { data ->
                    item { OutlinedTextField(localQuery,{ localQuery = it },label = { Text("在本次结果中搜索员工或商品") },modifier = Modifier.fillMaxWidth()) }
                    val rows = data.getJSONArray("rows").objects().filter { (it.getString("employeeDisplayName") + it.getString("productName") + it.getString("employeeCode") + it.getString("productCode")).contains(localQuery.trim(),true) }
                    item { Text("${rows.size}条销售归属；贡献金额不是工资或佣金。") }
                    for(row in rows) item {
                        Panel {
                            Text(row.getString("employeeDisplayName") + " · " + row.getString("productName"),style = MaterialTheme.typography.titleMedium)
                            Text("${row.get("quantity")}份 · ${row.getString("productCode")}")
                            val currency = row.getString("currency")
                            Text("销售归属 ${BusinessReports.amount(row,"salesAmountMinor",currency)} · 退款冲回 ${BusinessReports.amount(row,"refundReversalAmountMinor",currency)}")
                            Text(if(row.getBoolean("costCoverageComplete")) "成本 ${BusinessReports.amount(row,"costAmountMinor",currency)} · 贡献 ${BusinessReports.amount(row,"contributionProfitMinor",currency)}" else "成本覆盖不完整，贡献数据不足")
                        }
                    }
                } else report?.let { data ->
                    item { Text(data.getString("decisionBoundary")); Text("生成：${assignmentTime(data.getString("generatedAt"))}") }
                    item { Foldout("数据口径与缺失") {
                        val caps = data.getJSONObject("filterCapabilities")
                        Text(caps.getJSONObject("occasion").getString("basis")); Text(caps.getJSONObject("package").getString("basis")); Text(caps.getJSONObject("customerSegment").getString("reason"))
                        val q = data.getJSONObject("dataQuality"); Text("录入 ${q.getInt("totalInputs")} · 确认 ${q.getInt("confirmedInputs")} · 未匹配 ${q.getInt("unmatchedInputs")} · 修订 ${q.getInt("correctedEvents")}")
                        val missing = q.getJSONObject("missingFacts")
                        Text("推荐缺展示 ${missing.getInt("recommendationWithoutExposureCount")} · 付款推荐缺成本 ${missing.getInt("paidRecommendationCostUnavailableCount")} · 投诉未关联订单 ${missing.getInt("complaintWithoutOrderLinkCount")}")
                    } }
                    item { Foldout("经营建议 · ${data.getJSONArray("weeklySuggestions").length()}项") {
                        val rows = data.getJSONArray("weeklySuggestions").objects(); if(rows.isEmpty()) Text("样本不足，暂无建议")
                        for(row in rows) { Text(row.getString("productName") + "：" + row.getString("recommendation")); Text("样本 ${row.getInt("sampleSize")} · 支持 ${row.getInt("supportingEvidence")} · 相反 ${row.getInt("opposingEvidence")} · 置信度 ${String.format(java.util.Locale.ROOT,"%.1f%%",row.getDouble("confidence")*100)} · ${when(row.getString("confidenceBasis")){ "strong" -> "证据较强"; "moderate" -> "中等证据"; "directional" -> "方向性参考"; else -> "证据不足" }}") }
                    } }
                    item { Text("推荐效果",style = MaterialTheme.typography.titleMedium); Text("同桌后续付款、同品复购不代表推荐促成；投诉须明确关联订单。") }
                    for(row in data.getJSONArray("recommendation").objects()) item { Panel {
                        Text(row.getString("productName")); Text("展示 ${row.getInt("exposed")} · 选择 ${row.getInt("selected")}（${BusinessReports.ratio(row.getInt("selected"),row.getInt("exposed"))}） · 下单 ${row.getInt("ordered")}")
                        Text("移除 ${row.getInt("ignored")} · 拒绝 ${row.getInt("rejected")} · 员工调整 ${row.getInt("staffModified")}")
                        Text("实付 ${BusinessReports.amount(row,"paidAmountMinor",row.getString("currency"))} · 退款 ${BusinessReports.amount(row,"refundedAmountMinor",row.getString("currency"))}")
                        Text("贡献 ${BusinessReports.amount(row,"contributionAmountMinor",row.getString("currency"))} · 投诉 ${row.getInt("complaintOrderCount")} · 后续付款 ${row.getInt("followOnPaidOrderCount")} · 复购 ${row.getInt("repeatPurchaseOrderCount")}")
                    } }
                    item { Text("商品体验",style = MaterialTheme.typography.titleMedium); Text("订单按下单周期，观察按记录日期；商品收入含关联补收。") }
                    for(row in data.getJSONArray("products").objects()) item { Panel {
                        Text("${row.getString("productName")} · ${row.get("soldQuantity")}份")
                        Text("成交 ${BusinessReports.amount(row,"paidRevenueMinor")} · 退款 ${BusinessReports.amount(row,"refundedAmountMinor")}")
                        Text("冻结成本 ${BusinessReports.amount(row,"frozenCostMinor")} · 贡献 ${BusinessReports.amount(row,"contributionAmountMinor")}")
                        Text("观察 ${row.getInt("observationCount")} · 称赞 ${row.getInt("praiseCount")} · 投诉 ${row.getInt("complaintCount")} · 剩余 ${row.getInt("remainingCount")} · 上桌晚 ${row.getInt("servedLateCount")}")
                    } }
                    item { Foldout("员工记录质量") {
                        for(row in data.getJSONObject("dataQuality").getJSONArray("staff").objects()) Text("${row.getString("employeeName")}：录入 ${row.getInt("inputCount")} · 确认 ${row.getInt("confirmedCount")} · 未匹配 ${row.getInt("unmatchedInputCount")} · 修订 ${row.getInt("correctedEventCount")} · 正/中/负 ${row.getInt("positiveEventCount")}/${row.getInt("neutralEventCount")}/${row.getInt("negativeEventCount")}")
                    } }
                    if(m.identity?.allows("observation.view.raw") == true) item { Foldout("观察原文 · 最近50条") {
                        for(row in data.getJSONArray("evidence").objects()) { Text("${row.getString("tableCode")} · ${row.getString("employeeName")} · ${assignmentTime(row.getString("occurredAt"))}"); Text(row.getString("rawExcerpt")); Text("修订 ${row.getInt("revisionNo")} · ${if(row.getBoolean("corrected")) "有修订" else "原记录"} · 置信度 ${String.format(java.util.Locale.ROOT,"%.1f%%",row.getDouble("confidence")*100)}") }
                    } }
                }
            }
        }
    }
}
