package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
import org.json.JSONArray

@Composable
fun LiveOwnerFinanceView(m:AppModel,close:()->Unit) {
    val access=remember { m.priorityAccessKey };val workspace=remember { m.workspaceVersion }
    var section by remember { mutableStateOf("costs") };var editor by remember { mutableStateOf<OwnerEditor?>(null) }
    var start by remember { mutableStateOf("") };var end by remember { mutableStateOf("") };var query by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") };var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    LaunchedEffect(Unit) { m.loadOwnerFinance() }
    LaunchedEffect(m.ownerBoard) { if(m.ownerBoard?.data?.getBoolean("canViewCost")==false && section in listOf("costs","recurring")) section=if(m.ownerBoard?.data?.getBoolean("canViewPayroll")==true) "payroll" else "settings" }
    LaunchedEffect(m.priorityAccessKey,m.workspaceVersion) { if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion) { editor=null;proposed=null;close() } }
    if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
    fun propose(make:()->LiveCommand) { try { proposed=make();notice="" } catch(e:Exception) { notice=e.message ?: "请核对输入" } }
    Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)) { Surface(Modifier.fillMaxSize(),color=Paper) {
        LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            item { Row { Text("费用与工资",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")} };Text(m.ownerState);if(notice.isNotBlank())Text(notice);LivePendingView(m) }
            item { Foldout("查询日期与记录") { CustodyField("费用开始日期 YYYY-MM-DD",start,10){start=it};CustodyField("费用结束日期 YYYY-MM-DD",end,10){end=it};Text("日期都留空为当前营业月；工资按原批次周期展示。") };SecondaryAction(onClick={try { val q=if(start.isBlank()&&end.isBlank()) "" else {require(start.isNotBlank()&&end.isNotBlank());require(java.time.LocalDate.parse(start)<=java.time.LocalDate.parse(end));"startDate=$start&endDate=$end"};m.loadOwnerFinance(q) } catch(e:Exception){notice="请填写有效的起止日期"}},enabled=!m.busy){Text("刷新费用与工资")} }
            val board=m.ownerBoard
            if(board!=null) {
                val canCost=board.data.getBoolean("canViewCost");val canPayroll=board.data.getBoolean("canViewPayroll")
                val choices=buildList { if(canCost){add("costs" to "经营费用");add("recurring" to "周期费用")};if(canPayroll){add("payroll" to "工资批次");add("employees" to "薪资标准")};add("settings" to "分类与成本中心") }
                item { AssignmentChoice("工作区",section,choices){section=it;editor=null;query=""};CustodyField("筛选名称或单号",query,100){query=it} }
                if(editor!=null) item { key(editor) { OwnerForm(m,board,editor!!,{editor=null}){make->propose(make)} } }
                val actor=m.identity!!
                when(section) {
                    "costs" -> if(canCost) {
                        if(actor.allows("commercial.cost.manage"))item { PrimaryAction(onClick={editor=OwnerEditor("cost.create")},enabled=m.canUseOwner){Text("登记经营费用")} }
                        for(row in board.rows("costs").filter { it.toString().contains(query,true) })item { Panel {
                            Text(row.getString("name"),style=MaterialTheme.typography.titleMedium);Text("${ownerStates[row.getString("recognitionState")] ?: row.getString("recognitionState")} · ${ownerAmount(row,"grossAmountMinor")} 元（含税）")
                            Text("${row.getString("serviceStartDate")} — ${row.getString("serviceEndDate")} · ${row.textOrNull("costCenterName") ?: "未分配"}")
                            Text(row.getString("publicId"));row.textOrNull("note")?.let{Text(it)}
                            if(row.optBoolean("corrected"))Text("已有更正，原凭证保留")
                            if(actor.allows("commercial.cost.manage")&&!row.optBoolean("corrected"))SecondaryAction(onClick={editor=OwnerEditor("cost.correct",row)},enabled=m.canUseOwner){Text("新增更正凭证")}
                        } }
                    }
                    "recurring" -> if(canCost) {
                        if(actor.allows("commercial.cost.manage"))item { PrimaryAction(onClick={editor=OwnerEditor("recurring-cost.create")},enabled=m.canUseOwner){Text("新建周期费用")};SecondaryAction(onClick={editor=OwnerEditor("recurring-cost.materialize")},enabled=m.canUseOwner){Text("生成截至指定日的费用")} }
                        for(row in board.rows("recurringRules").filter { it.toString().contains(query,true) })item { Panel { Text(row.getString("name"),style=MaterialTheme.typography.titleMedium);Text("每${ownerPeriods[row.getString("recurrence")]} ${ownerAmount(row,"grossAmountMinor")} 元 · ${ownerStates[row.getString("status")]} ");Text("${row.getString("startsOn")} — ${row.textOrNull("endsOn") ?: "长期"}");Text(row.getString("publicId"));if(actor.allows("commercial.cost.manage")&&row.getString("status")!="ended")SecondaryAction(onClick={editor=OwnerEditor("recurring-cost.status",row)},enabled=m.canUseOwner){Text("暂停、恢复或结束")} } }
                    }
                    "employees" -> if(canPayroll) {
                        if(actor.allows("commercial.payroll.manage"))item { PrimaryAction(onClick={editor=OwnerEditor("compensation-rule.create")},enabled=m.canUseOwner){Text("新增或调整薪资标准")} }
                        for(row in board.rows("compensationRules").filter { it.toString().contains(query,true) })item { Panel { Text(row.getString("employeeName"),style=MaterialTheme.typography.titleMedium);Text("${payBasisNames[row.getString("payBasis")]} ${ownerAmount(row,"baseRateMinor")} 元 · ${ownerStates[row.getString("status")]} ");Text("${row.getString("effectiveFrom")} — ${row.textOrNull("effectiveUntil") ?: "长期"}");Text("${row.getString("costCenterName")} · ${row.getString("reason")}") } }
                    }
                    "payroll" -> if(canPayroll) {
                        item { Text("工资入账只记录雇主费用，不会向员工转账。发薪需另行核对银行记录。") }
                        if(actor.allows("commercial.payroll.manage"))item { PrimaryAction(onClick={editor=OwnerEditor("payroll-run.create")},enabled=m.canUseOwner){Text("创建工资草稿")} }
                        for(run in board.rows("payrollRuns").filter { it.toString().contains(query,true)||board.rows("payrollLines").any { line->line.getString("payrollRunId")==it.getString("id")&&line.getString("employeeName").contains(query,true) } })item { Panel {
                            Text("${run.getString("periodStart")} — ${run.getString("periodEnd")}",style=MaterialTheme.typography.titleMedium);Text("${ownerStates[run.getString("status")]} · ${run.getInt("lineCount")} 人 · 实发 ${ownerAmount(run,"netPayMinor")} 元");Text("应发 ${ownerAmount(run,"grossPayMinor")} 元 · 雇主费用 ${ownerAmount(run,"employerCostMinor")} 元");Text(run.getString("publicId"))
                            Foldout("查看工资明细") { for(line in board.rows("payrollLines").filter { it.getString("payrollRunId")==run.getString("id") }) { Text("${line.getString("employeeName")} · 基本 ${ownerAmount(line,"basePayMinor")} 元 · 数量 ${line.getString("units")}");Text("加班 ${ownerAmount(line,"overtimeMinor")} · 奖金 ${ownerAmount(line,"bonusMinor")} · 提成 ${ownerAmount(line,"commissionMinor")} · 补贴 ${ownerAmount(line,"allowanceMinor")} · 扣款 ${ownerAmount(line,"deductionMinor")} · 雇主承担 ${ownerAmount(line,"employerContributionMinor")}")
                                if(run.getString("status")=="draft"&&actor.allows("commercial.payroll.manage")) { SecondaryAction(onClick={editor=OwnerEditor("payroll-run.create",run,line)},enabled=m.canUseOwner){Text("编辑 ${line.getString("employeeName")}")};if(run.getInt("lineCount")>1)TextButton(onClick={propose{ownerCommand(actor,"payroll-run.create",JSONObject().put("draftRunId",run.getString("id")).put("expectedVersion",run.getInt("version")).put("periodStart",run.getString("periodStart")).put("periodEnd",run.getString("periodEnd")).put("removeEmployeeId",line.getString("employeeId")).put("lines",JSONArray()),"移除工资草稿中的 ${line.getString("employeeName")}\n周期 ${run.getString("periodStart")} — ${run.getString("periodEnd")}",run)}},enabled=m.canUseOwner){Text("移除此人草稿明细")} }
                            } }
                            if(run.getString("status")=="draft"&&actor.allows("commercial.payroll.manage")){SecondaryAction(onClick={editor=OwnerEditor("payroll-run.create",run)},enabled=m.canUseOwner){Text("追加员工明细")};SecondaryAction(onClick={editor=OwnerEditor("payroll-run.approve",run)},enabled=m.canUseOwner){Text("核对并确认工资单")}}
                            if(run.getString("status") in listOf("draft","approved")&&actor.allows("commercial.payroll.manage"))TextButton(onClick={editor=OwnerEditor("payroll-run.void",run)},enabled=m.canUseOwner){Text("作废未入账工资单")}
                            if(run.getString("status")=="approved"&&actor.allows("commercial.payroll.post"))PrimaryAction(onClick={editor=OwnerEditor("payroll-run.post",run)},enabled=m.canUseOwner){Text("核对并记入经营费用")}
                        } }
                    }
                    "settings" -> {
                        item { Panel { Text("费用分类",style=MaterialTheme.typography.titleMedium);board.rows("categories").forEach {Text("${it.getString("name")} · ${costCategories[it.getString("systemCategory")]}")};Text("成本中心",style=MaterialTheme.typography.titleMedium);board.rows("costCenters").forEach {Text(it.getString("name"))};if(actor.allows("commercial.cost.manage")){SecondaryAction(onClick={editor=OwnerEditor("cost-category.create")},enabled=m.canUseOwner){Text("新增费用分类")};SecondaryAction(onClick={editor=OwnerEditor("cost-center.create")},enabled=m.canUseOwner){Text("新增成本中心")}} } }
                    }
                }
            }
        }
    } }
    proposed?.let { command->AlertDialog(onDismissRequest={proposed=null},title={Text("核对经营财务操作")},text={Text(command.steps[0].ownerProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;editor=null;m.executeLive(command)},enabled=m.canUseOwner){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}}) }
}
data class OwnerEditor(val operation:String,val row:JSONObject?=null,val line:JSONObject?=null)
val payBasisNames=linkedMapOf("monthly" to "月薪","daily" to "日薪","hourly" to "时薪","per_shift" to "每班")
