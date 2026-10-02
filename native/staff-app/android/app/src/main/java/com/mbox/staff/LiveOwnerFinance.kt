package com.mbox.staff

import java.math.BigDecimal
import java.util.UUID
import org.json.JSONObject

const val ownerRoot = "/api/native/commercial-ops"
val ownerPermissions = setOf("commercial.cost.view","commercial.cost.manage","commercial.payroll.view","commercial.payroll.manage","commercial.payroll.post")
val costCategories = linkedMapOf("beverage_purchase" to "酒水采购","personnel" to "人工","performer" to "演出人员","band" to "乐队","rent" to "租金","utilities" to "水电","miscellaneous" to "杂项")
val ownerPeriods = linkedMapOf("day" to "日","week" to "周","month" to "月","quarter" to "季度","year" to "年")
val ownerSources = linkedMapOf("manual" to "手工凭证","lease" to "租赁合同","payroll" to "工资","performance" to "演出结算","utility_bill" to "水电账单")
val ownerStates = mapOf("draft" to "草稿","approved" to "已确认","posted" to "已入账","voided" to "已作废","active" to "启用","paused" to "暂停","ended" to "结束","superseded" to "已替代","actual" to "实际","known" to "已知","accrual" to "应计")
class OwnerBoard(val data:JSONObject,val capability:JSONObject) {
    val employee=capability.getString("employeeId")
    val enabled=capability.getBoolean("durableCommands") && capability.getInt("protocol")==1
    fun rows(key:String)=data.getJSONArray(key).objects()
}
fun ownerMoney(value:String):Long {
    require(Regex("^(?:0|[1-9][0-9]{0,9})(?:\\.[0-9]{1,2})?$").matches(value)) { "金额须为非负数字，最多两位小数" }
    return BigDecimal(value).movePointRight(2).longValueExact()
}
fun ownerAmount(row:JSONObject,key:String):String = if(row.isNull(key)) "" else BigDecimal(row.get(key).toString()).movePointLeft(2).toPlainString()
fun ownerPermission(operation:String)=when {
    operation.startsWith("cost") || operation.startsWith("recurring-cost") -> "commercial.cost.manage"
    operation == "payroll-run.post" -> "commercial.payroll.post"
    else -> "commercial.payroll.manage"
}
fun ownerCommand(actor:StaffIdentity,operation:String,body:JSONObject,confirmation:String,target:JSONObject?=null,currentCompensation:String?=null):LiveCommand {
    val permission=ownerPermission(operation);require(actor.allows(permission)) { "没有此项费用或工资权限" }
    val path=when(operation) {
        "cost.create" -> "/costs"
        "cost.correct" -> "/costs/${target!!.getString("id")}/corrections"
        "cost-category.create" -> "/cost-categories"
        "cost-center.create" -> "/cost-centers"
        "recurring-cost.create" -> "/recurring-costs"
        "recurring-cost.materialize" -> "/recurring-costs/materialize"
        "recurring-cost.status" -> "/recurring-costs/${target!!.getString("id")}/status"
        "compensation-rule.create" -> "/compensation-rules"
        "payroll-run.create" -> "/payroll-runs"
        "payroll-run.approve","payroll-run.void","payroll-run.post" -> "/payroll-runs/${target!!.getString("id")}/${operation.substringAfter('.') }"
        else -> error("不支持的经营财务操作")
    }
    val id=UUID.randomUUID().toString();val proof=JSONObject().put("operation","commercial.$operation").put("employeeId",actor.employeeId).put("confirmation",confirmation)
    if(target!=null) { UUID.fromString(target.getString("id"));proof.put("target",target.getString("id"));if(target.has("version"))proof.put("version",target.getInt("version")) }
    if(operation=="compensation-rule.create") proof.put("compensation",currentCompensation ?: "none")
    if(operation=="payroll-run.create") {
        val start=java.time.LocalDate.parse(body.getString("periodStart")); require(java.time.LocalDate.parse(body.getString("periodEnd"))>=start)
        if(body.textOrNull("draftRunId")!=null)require(body.getInt("expectedVersion")>0)
        val lines=body.getJSONArray("lines").objects();require(lines.size<=200 && (lines.isNotEmpty() || body.textOrNull("removeEmployeeId")!=null));require(lines.map { it.getString("employeeId") }.distinct().size==lines.size)
        for(line in lines) require(BigDecimal(line.get("units").toString())>BigDecimal.ZERO)
    }
    return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),permission,listOf(LiveStep(ownerRoot+path,body.toString(),"idempotency-key","native-business-$id",JSONObject().put("ownerFinance",proof).toString())))
}
val LiveStep.ownerProof:JSONObject? get()=recoveryBody?.let { JSONObject(it).optJSONObject("ownerFinance") }
fun secureOwnerCommand(command:LiveCommand,store:(String,String)->Unit):LiveCommand {
    val step=command.steps.firstOrNull()?:return command;val proof=step.ownerProof?:return command
    require(command.steps.size==1);if(proof.has("payloadKey"))return command
    store(command.id,step.body)
    proof.remove("confirmation")
    return command.copy(title="待核对费用或工资原请求",steps=listOf(step.copy(body="{}",recoveryBody=JSONObject().put("ownerFinance",JSONObject(proof.toString()).put("payloadKey",command.id)).toString())))
}
fun ownerHeaders(step:LiveStep):Map<String,String> {
    val p=step.ownerProof!!;return buildMap { put(step.keyHeader,step.key);if(p.has("version"))put("x-owner-version",p.getInt("version").toString());p.textOrNull("compensation")?.let { put("x-owner-compensation",it) } }
}
fun validateOwnerReply(text:String,step:LiveStep,body:JSONObject):JSONObject {
    val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1 && meta.get("replayed") is Boolean)
    val data=root.getJSONObject("data");val p=step.ownerProof!!;val op=p.getString("operation")
    require(data.getString("operation")==op && data.getString("employeeId")==p.getString("employeeId") && data.getString("requestKey")==step.key)
    val r=data.getJSONObject("result");UUID.fromString(r.getString("id"));require(r.getString("publicId").isNotBlank() && r.getInt("aggregateVersion")>0)
    val status=when(op.substringAfter("commercial.")) { "payroll-run.create"->"draft";"payroll-run.approve"->"approved";"payroll-run.post"->"posted";"payroll-run.void"->"voided";"recurring-cost.materialize"->"completed";"recurring-cost.status"->body.getString("status");"cost.create","cost.correct"->"recorded";else->"active" }
    require(r.getString("status")==status)
    if(op in listOf("commercial.payroll-run.approve","commercial.payroll-run.post","commercial.payroll-run.void","commercial.recurring-cost.status"))require(r.getString("id")==p.getString("target") && r.getInt("aggregateVersion")>p.getInt("version"))
    if(op=="commercial.payroll-run.create" && body.textOrNull("draftRunId")!=null) require(r.getString("id")==body.getString("draftRunId") && r.getInt("aggregateVersion")>body.getInt("expectedVersion"))
    if(op in listOf("commercial.cost.create","commercial.cost.correct")) { require(r.getLong("netAmountMinor")==body.getLong("netAmountMinor") && r.getLong("taxAmountMinor")==body.getLong("taxAmountMinor"));if(op.endsWith("correct"))require(r.getString("correctsCostEntryId")==p.getString("target")) }
    return r
}

fun ownerConfirmation(title:String,body:JSONObject,board:OwnerBoard,row:JSONObject?):String=buildString {
    append(title);row?.textOrNull("publicId")?.let{append("\n原记录：$it")}
    val names=mapOf("displayName" to "名称","name" to "名称","code" to "编码","serviceStartDate" to "服务开始","serviceEndDate" to "服务结束","cashPaidOn" to "实际付款日","startsOn" to "起始日","endsOn" to "终止日","throughDate" to "生成截止日","effectiveFrom" to "生效日","effectiveUntil" to "失效日","periodStart" to "周期开始","periodEnd" to "周期结束","reason" to "说明","correctionReason" to "更正原因","counterparty" to "收款方","note" to "备注")
    for((key,label) in names)body.textOrNull(key)?.let{append("\n$label：$it")}
    val enums=mapOf("recognitionState" to ("确认状态" to ownerStates),"allocationPeriod" to ("分摊周期" to ownerPeriods),"recurrence" to ("发生周期" to ownerPeriods),"sourceType" to ("凭证来源" to ownerSources),"payBasis" to ("计薪方式" to payBasisNames),"status" to ("状态" to ownerStates),"systemCategory" to ("会计分类" to costCategories))
    for((key,config)in enums)body.textOrNull(key)?.let{append("\n${config.first}：${config.second[it] ?: it}")}
    for((key,rows,label)in listOf(Triple("categoryDefinitionId","categories","分类"),Triple("costCenterId","costCenters","成本中心"),Triple("employeeId","employees","员工")))body.textOrNull(key)?.let{id->val selected=board.rows(rows).firstOrNull{it.getString("id")==id};require(selected!=null){"所选${label}已变化，请刷新"};append("\n$label：${selected.optString(if(rows=="employees")"displayName" else "name")}")}
    for((key,label)in listOf("netAmountMinor" to "未税金额","taxAmountMinor" to "税额","baseRateMinor" to "薪资标准"))if(body.has(key))append("\n$label：${ownerAmount(body,key)} 元")
    if(body.has("netAmountMinor"))append("\n含税合计：${BigDecimal(body.getLong("netAmountMinor")+body.getLong("taxAmountMinor")).movePointLeft(2).toPlainString()} 元")
    body.optJSONArray("lines")?.objects()?.forEach {line->
        append("\n员工：${board.rows("employees").first{it.getString("id")==line.getString("employeeId")}.getString("displayName")} · 数量 ${line.getString("units")}")
        for((key,label)in listOf("basePayMinor" to "基本工资","overtimeMinor" to "加班","bonusMinor" to "奖金","commissionMinor" to "提成","allowanceMinor" to "补贴","deductionMinor" to "扣款","employerContributionMinor" to "雇主承担"))append("\n$label：${ownerAmount(line,key)} 元")
    }
    if(row?.has("employerCostMinor")==true)append("\n整单实发：${ownerAmount(row,"netPayMinor")} 元 · 雇主费用：${ownerAmount(row,"employerCostMinor")} 元")
    append("\n本操作只登记账务，不执行转账或扣款。")
}
