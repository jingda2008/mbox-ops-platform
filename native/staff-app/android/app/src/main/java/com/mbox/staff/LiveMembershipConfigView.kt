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
fun LiveMembershipConfigView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var createDomain by remember{mutableStateOf<String?>(null)};var notice by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var filter by remember{mutableStateOf("")}
 LaunchedEffect(Unit){m.loadMembershipConfig(if(m.identity?.allows("loyalty.configuration.view")==true)"rules" else "controls",null)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun propose(make:()->LiveCommand){try{proposed=make();notice=""}catch(e:Exception){notice=e.message?:"请核对规则内容"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("会员规则与运行控制",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.membershipConfigState);if(notice.isNotBlank())Text(notice);LivePendingView(m)
   val sections=listOf("rules" to "规则版本","controls" to "运行控制").filter{m.identity?.allows(if(it.first=="rules")"loyalty.configuration.view" else "loyalty.operations.view")==true}
   AssignmentChoice("查看",m.membershipConfigBoard?.data?.getString("section")?:sections.firstOrNull()?.first.orEmpty(),sections){createDomain=null;m.loadMembershipConfig(it,null)}
   SecondaryAction(onClick={m.loadMembershipConfig()},enabled=!m.busy){Text("刷新规则与状态")}
  }
  val board=m.membershipConfigBoard
  if(board?.data?.getString("section")=="rules"){
   item{Text("编辑者不能审批；发布人须与所有编辑者及审批人不同。已发布版本只读；调整时新建草稿，再预览、审批和发布。");CustodyField("筛选规则名称",filter,100){filter=it}
    val choices=membershipDomainNames.filter{it.key!="wechat_notifications"&&m.identity?.allows(membershipPermission("create",it.key))==true}.map{it.key to it.value}
    if(choices.isNotEmpty())AssignmentChoice("新建规则草稿",createDomain.orEmpty(),listOf("" to "选择规则类型")+choices){createDomain=it.takeIf{it.isNotBlank()}}
   }
   if(createDomain!=null)item{key("new-$createDomain"){MembershipRuleEditor(m,createDomain!!,null,null,null,{createDomain=null},::propose)}}
   m.membershipConfigDetail?.let{detail->item{key(detail.getJSONObject("draft").getString("publicId"),detail.getJSONObject("draft").getInt("revision"),detail.getJSONObject("draft").getString("status")){
    val draft=detail.getJSONObject("draft");val summary=board.rows.firstOrNull{it.getString("configurationId")==draft.getString("publicId")}
    MembershipRuleEditor(m,draft.getString("domain"),draft,detail.optJSONObject("preview"),summary,{m.clearMembershipConfigDetail()},::propose)
   }}}
   for(row in board.rows.filter{filter.isBlank()||it.getString("title").contains(filter,true)||membershipDomainNames[it.getString("domain")]?.contains(filter)==true})item{Panel{
    Text("${membershipDomainNames[row.getString("domain")]} · 第${row.getInt("version")}版",style=MaterialTheme.typography.titleMedium);Text(row.getString("title"));Text(membershipConfigStatus[row.getString("status")]?:"状态待核对");row.textOrNull("effectiveFrom")?.let{Text("生效 ${assignmentTime(it)}")};row.textOrNull("effectiveUntil")?.let{Text("结束 ${assignmentTime(it)}")}
    SecondaryAction(onClick={createDomain=null;m.loadMembershipConfig("rules",row.getString("domain")+"/"+row.getString("configurationId"))},enabled=!m.busy){Text("查看与处理此版本")}
   }}
   if(board.rows.isEmpty())item{Text("尚无规则版本")}
  }else if(board!=null){
   item{Text("暂停只针对选定能力。不会撤回既有积分、权益或支付；恢复积分累积后仍须核对待处理原订单。复核时间用于提醒管理，不会自动恢复。")}
   for(row in board.rows)item{key(row.getString("capability"),row.getInt("version")){MembershipControl(m,row,::propose)}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("确认会员规则操作")},text={Text(command.steps[0].membershipConfigProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;createDomain=null;m.executeLive(command)},enabled=m.canUseMembershipConfig){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}

@Composable
private fun MembershipRuleEditor(m:AppModel,domain:String,draft:JSONObject?,preview:JSONObject?,summary:JSONObject?,close:()->Unit,propose:(()->LiveCommand)->Unit){
 var editing by remember{mutableStateOf(membershipEditingContent(draft?.getJSONObject("content")?:newMembershipContent(domain)))};var reason by remember{mutableStateOf("")};var from by remember{mutableStateOf("")};var until by remember{mutableStateOf("")};var copying by remember{mutableStateOf(false)}
 val actor=m.identity?:return;val create=draft==null||copying;val status=if(create)"draft" else draft!!.getString("status");val editable=status=="draft"&&actor.allows(membershipPermission(if(create)"create" else "edit",domain));val refs=m.membershipConfigBoard?.references.orEmpty()
 fun target(action:String)=JSONObject().put("action",action).put("domain",domain).put("configurationId",draft!!.getString("publicId")).put("expectedRevision",draft.getInt("revision"))
 fun command(body:JSONObject,heading:String):LiveCommand=membershipConfigCommand(actor,body,"$heading\n${membershipDomainNames[domain]} · ${if(create)"新草稿" else "第${summary?.optInt("version")}版 / 修订${draft!!.getInt("revision")}"}\n${body.optString("reason","")}\n${if(body.getString("action")=="publish")"北京时间 $from 生效${if(until.isBlank())"，由后续版本替代" else "，$until 结束"}。将影响之后适用的会员业务。" else "以服务器原规则及独立审批结果为准。"}")
 Panel{
  Text("${membershipDomainNames[domain]} · ${if(create)"新草稿" else membershipConfigStatus[status]}",style=MaterialTheme.typography.titleMedium)
  if(create)Text("默认值仅作起草起点，请逐项填写门店实际规则。保存草稿不立即生效。")
  MembershipFields(editing,refs,editable){editing=it}
  if(status=="draft"||status=="approved")CustodyField("修改、审批或发布依据",reason,500){reason=it}
  if(editable)PrimaryAction(onClick={propose{val body=if(create)JSONObject().put("action","create") else target("edit");body.put("content",membershipNormalizeContent(editing)).put("reason",reason.trim());command(body,"保存规则草稿")}},enabled=m.canUseMembershipConfig){Text("核对并保存草稿")}
  val unchanged=!create&&membershipEditingContent(draft!!.getJSONObject("content")).toString()==editing.toString()
  if(!create&&status=="draft"){
   if(!unchanged)Text("表单有未保存修改，请先保存再查看影响与审批。")
   if(actor.allows("loyalty.configuration.preview"))SecondaryAction(onClick={propose{command(target("preview"),"生成服务器影响预览")}},enabled=m.canUseMembershipConfig&&unchanged){Text("生成影响预览")}
   preview?.let{p->MembershipImpactView(p);val makers=draft!!.getJSONArray("makerEmployeeIds");val independent=(0 until makers.length()).none{makers.getString(it)==actor.employeeId};val fresh=runCatching{serverInstant(p.getString("expiresAt")).isAfter(java.time.Instant.now())}.getOrDefault(false)
    if(actor.allows("loyalty.configuration.approve"))PrimaryAction(onClick={propose{command(target("approve").put("impactPreviewPublicId",p.getString("publicId")).put("reason",reason.trim()),"独立审批原规则")}},enabled=m.canUseMembershipConfig&&unchanged&&independent&&fresh){Text(if(!independent)"等待其他员工审批" else if(!fresh)"预览已过期，请重新生成" else "核对影响后独立审批")}
   }
  }
  if(!create&&status=="approved"&&actor.allows(membershipPermission("publish",domain))){
   CustodyField("生效时间（北京时间 YYYY-MM-DD HH:mm）",from,19){from=it};if(domain!="membership_terms")CustodyField("结束时间（可留空，北京时间）",until,19){until=it}
   val makers=draft!!.getJSONArray("makerEmployeeIds");val separate=(0 until makers.length()).none{makers.getString(it)==actor.employeeId}&&summary!=null&&summary.textOrNull("approvedByEmployeeId")!=actor.employeeId
   PrimaryAction(onClick={propose{val effective=membershipDate(from);require(serverInstant(effective).isAfter(java.time.Instant.now())){"生效时间必须晚于当前时间"};val end=if(until.isBlank())null else membershipDate(until);require(end==null||serverInstant(end).isAfter(serverInstant(effective))){"结束时间须晚于生效时间"};command(target("publish").put("reason",reason.trim()).put("effectiveFrom",effective).put("effectiveUntil",end?:JSONObject.NULL),"正式发布规则")}},enabled=m.canUseMembershipConfig&&separate){Text(if(separate)"核对后正式发布" else "须由第三位授权员工发布")}
  }
  if(!create&&domain!="wechat_notifications"&&actor.allows(membershipPermission("create",domain)))SecondaryAction(onClick={copying=true;reason="";val source=JSONObject(draft!!.getJSONObject("content").toString());if(domain=="redemption_catalog")for(row in source.getJSONArray("items").objects())row.put("publicId","RDI-"+java.util.UUID.randomUUID()).put("status","active");editing=membershipEditingContent(source)},enabled=m.canUseMembershipConfig){Text("以此内容起草新版本")}
  TextButton(onClick=close){Text("收起详情")}
 }
}
@Composable private fun MembershipImpactView(p:JSONObject){
 Text("服务器影响预览 · ${assignmentTime(p.getString("expiresAt"))}前有效",style=MaterialTheme.typography.titleMedium)
 Text("现有会员 ${p.getJSONObject("historicalMembership").getInt("activeMembers")} · 受影响 ${p.getInt("affectedExistingMembers")}\n预计积分 ${p.getLong("estimatedPointsIssued")}\n预计积分成本 ${loyaltyRefundMoney(p.getLong("estimatedPointsCostAmountMinor"))}\n预计权益成本 ${loyaltyRefundMoney(p.getLong("estimatedBenefitCostAmountMinor"))}\n预计兑换成本 ${loyaltyRefundMoney(p.getLong("estimatedRedemptionCostAmountMinor"))}")
 Text("这是按当前原账推算的影响，不是已发生费用。数据时点 ${assignmentTime(p.getString("generatedAt"))}；审批时服务器会再次核对。")
 for(f in p.getJSONArray("fulfillment").objects())Text("${f.getString("referenceCode")}：预计需求 ${f.getInt("expectedDemand")}，暂留后可用 ${f.textOrNull("availableAfterReservations")?:"未知"}，缺口 ${f.getInt("shortage")}，未完任务 ${f.getInt("openFulfillmentTasks")}")
 val warnings=mapOf("inventory_shortage" to "库存可能不足","fulfillment_capacity_review" to "须复核现场履约人力","points_cost_review" to "须复核积分成本","benefit_cost_review" to "须复核权益成本","redemption_cost_review" to "须复核兑换成本","terms_reacceptance_not_forced" to "不强迫既有会员重新同意条款");val list=p.getJSONArray("warnings");for(i in 0 until list.length())Text(warnings[list.getString(i)]?:"有一项影响待核对")
}
@Composable private fun MembershipControl(m:AppModel,row:JSONObject,propose:(()->LiveCommand)->Unit){
 var reason by remember{mutableStateOf("")};var reviewAt by remember{mutableStateOf("")};val capability=row.getString("capability");val paused=row.getString("state")=="paused"
 Panel{Text(membershipControls[capability]?:"未知能力",style=MaterialTheme.typography.titleMedium);Text(if(paused)"已暂停" else "运行中");row.textOrNull("reason")?.let{Text("原说明：$it")};row.textOrNull("reviewAt")?.let{Text("计划复核 ${assignmentTime(it)}")};Text("待核原积分订单 ${row.getInt("pendingAccrualCount")}")
 if(m.identity?.allows("loyalty.operations.control")==true){CustodyField("实际处理原因",reason,500){reason=it};if(!paused)CustodyField("计划复核时间（可留空，北京时间）",reviewAt,19){reviewAt=it}
 PrimaryAction(onClick={propose{val review=if(paused||reviewAt.isBlank())null else membershipDate(reviewAt);require(review==null||serverInstant(review).isAfter(java.time.Instant.now())){"复核时间须在未来"};membershipConfigCommand(m.identity!!,JSONObject().put("action","control").put("capability",capability).put("operation",if(paused)"resume" else "pause").put("expectedVersion",row.getInt("version")).put("reviewAt",review?:JSONObject.NULL).put("reason",reason.trim()),"${if(paused)"恢复" else "暂停"}${membershipControls[capability]}\n原因：${reason.trim()}\n不会自动撤回积分、权益或支付，其他能力保持原状态。")}},enabled=m.canUseMembershipConfig){Text(if(paused)"核对后恢复" else "暂停此项能力")}
 }}
}
