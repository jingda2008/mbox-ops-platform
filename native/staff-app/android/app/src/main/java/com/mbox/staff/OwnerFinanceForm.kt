package com.mbox.staff

import androidx.compose.material3.*
import androidx.compose.runtime.*
import org.json.JSONObject
import org.json.JSONArray
import java.math.BigDecimal

@Composable
fun OwnerForm(m:AppModel,board:OwnerBoard,edit:OwnerEditor,close:()->Unit,propose:(()->LiveCommand)->Unit) {
    val op=edit.operation;val row=edit.row;val line=edit.line;val day=board.data.getString("businessDate")
    var fields by remember { mutableStateOf(buildMap<String,String> {
        put("name",row?.textOrNull("name").orEmpty());put("displayName",row?.textOrNull("name").orEmpty())
        put("categoryDefinitionId",row?.textOrNull("categoryDefinitionId") ?: board.rows("categories").firstOrNull()?.getString("id").orEmpty());put("costCenterId",row?.textOrNull("costCenterId") ?: board.rows("costCenters").firstOrNull()?.getString("id").orEmpty())
        put("systemCategory","miscellaneous");put("recognitionState",row?.textOrNull("recognitionState") ?: "actual");put("allocationPeriod",row?.textOrNull("allocationPeriod") ?: "month");put("recurrence","month")
        put("sourceType",row?.textOrNull("sourceType") ?: "manual");put("serviceStartDate",row?.textOrNull("serviceStartDate") ?: day);put("serviceEndDate",row?.textOrNull("serviceEndDate") ?: day);put("cashPaidOn",row?.textOrNull("cashPaidOn").orEmpty())
        put("startsOn",day);put("effectiveFrom",day);put("periodStart",row?.textOrNull("periodStart") ?: day.substring(0,7)+"-01");put("periodEnd",row?.textOrNull("periodEnd") ?: java.time.LocalDate.parse(day).withDayOfMonth(java.time.LocalDate.parse(day).lengthOfMonth()).toString());put("throughDate",day)
        put("employeeId",line?.textOrNull("employeeId").orEmpty());put("compensationRuleId",line?.textOrNull("compensationRuleId").orEmpty());put("payBasis","monthly");put("units",line?.textOrNull("units") ?: "1")
        for(key in listOf("netAmountMinor","taxAmountMinor","baseRateMinor","overtimeMinor","bonusMinor","commissionMinor","allowanceMinor","deductionMinor","employerContributionMinor"))put(key,if((line?:row)?.has(key)==true)ownerAmount((line?:row)!!,key) else "0")
        put("counterparty",row?.textOrNull("counterparty").orEmpty());put("note",line?.textOrNull("note") ?: row?.textOrNull("note").orEmpty());put("status",if(row?.optString("status")=="paused")"active" else "paused")
    }) }
    fun value(key:String)=fields[key].orEmpty()
    @Composable fun field(key:String,label:String,max:Int=1000) { CustodyField(label,value(key),max){fields=fields+(key to it)} }
    @Composable fun choice(key:String,label:String,values:List<Pair<String,String>>) { AssignmentChoice(label,value(key),values){fields=fields+(key to it)} }
    fun putText(body:JSONObject,vararg keys:String) { keys.forEach {body.put(it,value(it).trim().takeIf(String::isNotBlank) ?: JSONObject.NULL)} }
    fun required(body:JSONObject,vararg keys:String) { keys.forEach {require(value(it).isNotBlank()){ "请填写完整必填信息" };body.put(it,value(it).trim())} }
    fun dates(body:JSONObject,vararg keys:String) {keys.forEach{val v=value(it).trim();if(v.isBlank())body.put(it,JSONObject.NULL) else body.put(it,java.time.LocalDate.parse(v).toString())}}
    fun money(body:JSONObject,vararg keys:String) {keys.forEach{body.put(it,ownerMoney(value(it)))}}
    Panel {
        Text(when(op){"cost.create"->"登记费用";"cost.correct"->"更正原费用，保留原记录";"recurring-cost.create"->"创建周期费用";"recurring-cost.materialize"->"生成周期费用";"recurring-cost.status"->"变更周期规则";"cost-category.create"->"新增费用分类";"cost-center.create"->"新增成本中心";"compensation-rule.create"->"新增薪资标准";"payroll-run.create"->if(line!=null)"编辑工资明细" else "新增工资明细";"payroll-run.approve"->"确认整张工资单";"payroll-run.void"->"作废工资单";else->"工资入账"},style=MaterialTheme.typography.titleLarge)
        if(op in listOf("cost.create","cost.correct","recurring-cost.create")) {
            field(if(op=="recurring-cost.create")"name" else "displayName","费用名称",128)
            AssignmentChoice("费用分类",value("categoryDefinitionId"),board.rows("categories").map{it.getString("id") to it.getString("name")}){ val cat=board.rows("categories").first{r->r.getString("id")==it}.getString("systemCategory");fields=fields+("categoryDefinitionId" to it)+("sourceType" to when(cat){"rent"->"lease";"band","performer"->"performance";"utilities"->"utility_bill";else->"manual"}) };choice("costCenterId","成本中心",board.rows("costCenters").map{it.getString("id") to it.getString("name")})
            choice("recognitionState","确认状态",listOf("actual" to "实际","accrual" to "应计","known" to "已知"));choice("allocationPeriod","分摊周期",ownerPeriods.toList())
            if(op=="recurring-cost.create"){choice("recurrence","发生周期",ownerPeriods.toList());field("startsOn","开始日期 YYYY-MM-DD",10);field("endsOn","结束日期（可留空）",10)} else {field("serviceStartDate","服务开始日期 YYYY-MM-DD",10);field("serviceEndDate","服务结束日期 YYYY-MM-DD",10);field("cashPaidOn","实际付款日期（未付留空）",10)}
            field("netAmountMinor","未税金额（元）",14);field("taxAmountMinor","税额（元）",14);choice("sourceType","凭证来源",ownerSources.toList());field("counterparty","收款方（可选）",128);field("note","备注（可选）")
            Text("费用只登记账务，不发起扣款；货品采购须经采购入库，不在此重复记成本。")
            if(op=="cost.correct")field("correctionReason","更正原因（必填）")
        }
        if(op=="recurring-cost.materialize") {field("throughDate","生成截止日期 YYYY-MM-DD",10);Text("将按现有启用规则生成尚未登记的各期费用。请先核对规则金额与有效期。")}
        if(op=="recurring-cost.status"){choice("status","新状态",if(row!!.getString("status")=="active")listOf("paused" to "暂停","ended" to "永久结束") else listOf("active" to "恢复","ended" to "永久结束"));field("reason","变更原因")}
        if(op in listOf("cost-category.create","cost-center.create")){field("code","编码（字母数字与下划线）",64);field("name","名称",64);if(op=="cost-category.create")choice("systemCategory","会计分类",costCategories.toList())}
        if(op=="compensation-rule.create") {
            choice("employeeId","员工",board.rows("employees").filter{it.getString("status")=="active"}.map{it.getString("id") to "${it.getString("displayName")} · ${it.getString("employeeCode")}"})
            board.rows("compensationRules").firstOrNull{it.getString("employeeId")==value("employeeId")&&it.getString("status")=="active"}?.let{Text("当前：${payBasisNames[it.getString("payBasis")]} ${ownerAmount(it,"baseRateMinor")} 元，${it.getString("effectiveFrom")} 生效")}
            choice("costCenterId","成本中心",board.rows("costCenters").map{it.getString("id") to it.getString("name")});choice("payBasis","计薪方式",payBasisNames.toList());field("baseRateMinor","工资标准（元）",14);field("effectiveFrom","生效日 YYYY-MM-DD",10);field("effectiveUntil","失效日（可选）",10);field("reason","调整原因")
            Text("新标准会替代该员工当前标准，并保留历史；生效日必须晚于当前标准。")
        }
        if(op=="payroll-run.create") {
            if(row==null){field("periodStart","工资周期开始 YYYY-MM-DD",10);field("periodEnd","工资周期结束 YYYY-MM-DD",10)} else Text("周期 ${value("periodStart")} — ${value("periodEnd")}")
            if(line==null)AssignmentChoice("员工",value("employeeId"),board.rows("employees").filter{it.getString("status")=="active"}.map{it.getString("id") to "${it.getString("displayName")} · ${it.getString("employeeCode")}"}){fields=fields+("employeeId" to it)+("compensationRuleId" to "")} else Text(line.getString("employeeName"))
            choice("compensationRuleId","适用薪资标准",board.rows("compensationRules").filter{it.getString("employeeId")==value("employeeId")}.map{it.getString("id") to "${payBasisNames[it.getString("payBasis")]} ${ownerAmount(it,"baseRateMinor")} 元 · ${it.getString("effectiveFrom")}"})
            field("units","计薪数量（月薪填1，日/时/班填实际数量）",10)
            for((key,label) in listOf("overtimeMinor" to "加班","bonusMinor" to "奖金","commissionMinor" to "提成","allowanceMinor" to "补贴","deductionMinor" to "扣款","employerContributionMinor" to "雇主承担"))field(key,"$label（元）",14)
            field("note","明细备注（可选）")
            Text("基本工资由服务器按原薪资标准与数量计算；草稿保存后须查看整单明细再确认。")
        }
        if(op in listOf("payroll-run.approve","payroll-run.void","payroll-run.post")) {Text("${row!!.getString("periodStart")} — ${row.getString("periodEnd")} · ${row.getInt("lineCount")} 人");Text("应发 ${ownerAmount(row,"grossPayMinor")} 元 · 实发 ${ownerAmount(row,"netPayMinor")} 元 · 雇主费用 ${ownerAmount(row,"employerCostMinor")} 元");field("reason","确认说明（必填）");if(op.endsWith("post"))Text("入账后不能作废。此处不执行银行转账。")}
        PrimaryAction(onClick={propose {
            val body=JSONObject();var target=row;var compensation:String?=null
            when(op) {
                "cost.create","cost.correct","recurring-cost.create"->{
                    required(body,"categoryDefinitionId","costCenterId","recognitionState","allocationPeriod","sourceType");money(body,"netAmountMinor","taxAmountMinor");putText(body,"counterparty","note")
                    if(op=="recurring-cost.create"){required(body,"name","recurrence");dates(body,"startsOn","endsOn");require(!body.isNull("startsOn"))}else{required(body,"displayName");dates(body,"serviceStartDate","serviceEndDate","cashPaidOn");require(!body.isNull("serviceStartDate")&&!body.isNull("serviceEndDate"));require(java.time.LocalDate.parse(value("serviceStartDate"))<=java.time.LocalDate.parse(value("serviceEndDate")));body.put("category",board.rows("categories").first{it.getString("id")==value("categoryDefinitionId")}.getString("systemCategory")).put("currency","CNY");if(op=="cost.correct")required(body,"correctionReason")}
                }
                "recurring-cost.materialize"->{dates(body,"throughDate");require(!body.isNull("throughDate"))}
                "recurring-cost.status"->required(body,"status","reason")
                "cost-category.create"->{required(body,"code","name","systemCategory")}
                "cost-center.create"->{required(body,"code","name")}
                "compensation-rule.create"->{required(body,"employeeId","costCenterId","payBasis","reason");money(body,"baseRateMinor");dates(body,"effectiveFrom","effectiveUntil");require(!body.isNull("effectiveFrom"));compensation=board.rows("compensationRules").firstOrNull{it.getString("employeeId")==value("employeeId")&&it.getString("status")=="active"}?.getString("id") ?: "none"}
                "payroll-run.create"->{
                    dates(body,"periodStart","periodEnd");if(row!=null)body.put("draftRunId",row.getString("id")).put("expectedVersion",row.getInt("version"))
                    val detail=JSONObject();required(detail,"employeeId","compensationRuleId","units");val rule=board.rows("compensationRules").first{it.getString("id")==value("compensationRuleId")};val quantity=BigDecimal(value("units"));require(quantity>BigDecimal.ZERO&&quantity.scale()<=2){"数量须为正数，最多两位小数"};if(rule.getString("payBasis")=="monthly")require(quantity.compareTo(BigDecimal.ONE)==0){"月薪数量必须为1"}
                    detail.put("basePayMinor",BigDecimal(rule.get("baseRateMinor").toString()).multiply(quantity).setScale(0,java.math.RoundingMode.HALF_UP).longValueExact());money(detail,"overtimeMinor","bonusMinor","commissionMinor","allowanceMinor","deductionMinor","employerContributionMinor");putText(detail,"note");body.put("lines",JSONArray().put(detail));if(line!=null)body.put("replaceEmployeeLine",true)
                }
                else->required(body,"reason")
            }
            val title=when(op){"cost.create"->"登记经营费用";"cost.correct"->"更正原费用";"recurring-cost.create"->"创建周期费用";"recurring-cost.materialize"->"生成周期费用";"recurring-cost.status"->"变更周期规则";"compensation-rule.create"->"调整薪资标准";"payroll-run.create"->"保存工资草稿明细";"payroll-run.approve"->"确认工资单";"payroll-run.void"->"作废工资单";"payroll-run.post"->"工资记入经营费用";else->"保存经营分类配置"}
            val summary=ownerConfirmation(title,body,board,row)
            ownerCommand(m.identity!!,op,body,summary,target,compensation)
        }},enabled=m.canUseOwner){Text("核对并提交")};TextButton(onClick=close){Text("取消编辑")}
    }
}