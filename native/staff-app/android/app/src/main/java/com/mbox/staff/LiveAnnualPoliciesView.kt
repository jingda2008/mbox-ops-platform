package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable fun LiveAnnualPoliciesView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var code by remember{mutableStateOf("")};var action by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var selectedRule by remember{mutableStateOf<JSONObject?>(null)};var occurrenceRule by remember{mutableStateOf<JSONObject?>(null)};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadAnnualPolicies()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 fun propose(body:JSONObject){try{val board=m.annualPolicyBoard?:error("请先读取原配置");proposed=annualPolicyCommand(m.identity!!,CouponCalendarsBoard(JSONObject(board.data.toString()).put("rows",JSONArray(m.annualPolicyRows))),action,selected,body);error=""}catch(e:Exception){error=e.message?:"请核对完整配置"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("年度权益配置",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.annualPolicyState);Text("配置经独立审批、第三人发布后按未来时间生效。生日仍需本人授权，礼遇发放和核销仍受现场及库存条件约束。",style=MaterialTheme.typography.bodySmall);if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
 if(action=="draft")item{AnnualDraftEditor(m,code,selected,{action=""},::propose)}else{
 item{CustodyField("政策编号（大写，留空查看全部）",code,64){code=it};TextButton(onClick={m.loadAnnualPolicies(code)},enabled=!m.busy){Text("读取 / 刷新")};if(m.identity?.allows("loyalty.annual-benefit.manage")==true)TextButton(onClick={selected=null;action="draft"},enabled=m.canUseAnnualPolicies&&code.isNotBlank()&&m.annualPolicyBoard?.data?.textOrNull("code")==code){Text("新建此编号下一版本")}}
 items(m.annualPolicyRows,key={it.getString("id")}){r->Panel{
 Text("${r.getString("policyCode")} · 第${r.getInt("version")}版",style=MaterialTheme.typography.titleMedium);Text(annualStatus(r.getString("status"))+" · "+r.getString("timezone"));Text(r.getString("reason"));r.textOrNull("effectiveFrom")?.let{Text("生效 ${calendarLocal(it)}\n截止 ${r.textOrNull("effectiveUntil")?.let(::calendarLocal)?:"长期"}")};var expanded by remember(r.getString("id")){mutableStateOf(false)};TextButton(onClick={expanded=!expanded}){Text(if(expanded)"收起规则"else "查看 ${r.getJSONArray("rules").length()} 条完整规则")}
 if(expanded)for(rule in r.getJSONArray("rules").objects()){HorizontalDivider();AnnualRuleDetails(rule);if(rule.getString("ruleKind")=="festival"){TextButton(onClick={occurrenceRule=rule}){Text("查看已确认节日日期")};if(rule.getBoolean("enabled")&&m.identity?.allows("loyalty.annual-benefit.occurrence.confirm")==true)TextButton(onClick={selected=r;selectedRule=rule;action="occurrence"},enabled=m.canUseAnnualPolicies){Text("确认新的年度节日日期")}}}
 if(m.identity?.allows("loyalty.annual-benefit.manage")==true)TextButton(onClick={if(m.loadAnnualPolicies(r.getString("policyCode"))){selected=r;code=r.getString("policyCode");action="draft"}},enabled=!m.busy){Text("复制完整规则为新版草稿")}
 for(kind in listOf("approve","publish"))if(r.getString("status")==if(kind=="approve")"draft"else "approved")if(m.identity?.allows("loyalty.annual-benefit.$kind")==true)TextButton(onClick={selected=r;action=kind},enabled=m.canUseAnnualPolicies){Text(if(kind=="approve")"独立审批此版本"else "第三人发布此版本")}
 }}
 if(m.annualPolicyBoard?.next!=null)item{TextButton(onClick={m.loadAnnualPolicies(m.annualPolicyBoard?.data?.textOrNull("code")?:"",true)},enabled=!m.busy){Text("加载更多版本")}}
 }
 }}}
 if(action in listOf("approve","publish","occurrence"))AnnualDecisionEditor(action,selectedRule,error,{action=""},::propose)
 occurrenceRule?.let{AnnualOccurrencesView(m,it){occurrenceRule=null}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text(c.title)},text={Text(c.steps[0].annualPolicyProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;action="";m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
private fun annualStatus(s:String)=mapOf("draft" to "待独立审批","approved" to "已审批待发布","published" to "已发布（按生效时间执行）")[s]?:s
@Composable private fun AnnualRuleDetails(r:JSONObject){
 Text(r.getString("title")+" · "+if(r.getBoolean("enabled"))"启用"else "停用",style=MaterialTheme.typography.titleMedium);Text("${r.getString("ruleCode")} · ${annualKinds.toMap()[r.getString("ruleKind")]} · ${annualTiers.toMap()[r.getString("eligibleTier")]}");Text("权益：${r.textOrNull("benefitDefinitionName")?:r.getString("benefitDefinitionId")}")
 for((k,label)in annualNumeric)Text(label.substringBefore('（')+"："+r.get(k));for((k,label)in annualBooleans)Text("$label：${if(r.getBoolean(k))"是"else "否"}")
 Text("酒水：${annualAlcohol.toMap()[r.getString("alcoholHandling")]}\n库存：${annualInventory.toMap()[r.getString("inventoryRequirement")]}\n撤销：${annualRevocation.toMap()[r.getString("revocationPolicy")]}\n叠加组：${r.getString("stackGroup")}");r.textOrNull("feb29Policy")?.let{Text("2月29日生日：${annualFeb.toMap()[it]}")};r.takeUnless{it.isNull("reservationHoldMinutes")}?.get("reservationHoldMinutes")?.toString()?.let{Text("优先订座保留 $it 分钟")};r.takeUnless{it.isNull("redemptionHoldMinutes")}?.get("redemptionHoldMinutes")?.toString()?.let{Text("每日点心暂留 $it 分钟")};for(s in r.getJSONArray("substitutes").objects())Text("替代：${s.textOrNull("productName")?:s.getString("productId")} · 顺序 ${s.getInt("priority")}\n${s.getString("reason")}")
}
@Composable private fun AnnualDecisionEditor(action:String,rule:JSONObject?,outerError:String,close:()->Unit,submit:(JSONObject)->Unit){
 var reason by remember(action,rule){mutableStateOf("")};var from by remember{mutableStateOf("")};var until by remember{mutableStateOf("")};var year by remember{mutableStateOf(java.time.LocalDate.now().year.toString())};var start by remember{mutableStateOf("")};var end by remember{mutableStateOf("")};var reference by remember{mutableStateOf("")};var error by remember{mutableStateOf("")}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Text(if(action=="occurrence")"确认 ${rule?.getString("title")} 日期"else if(action=="publish")"安排原配置生效"else "独立审批原配置",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};if(action=="publish"){Text("时间输入使用北京时间。不得追溯发放；新版本生效时衔接上一个已发布版本。");CustodyField("生效（YYYY-MM-DD HH:mm）",from,29){from=it};CustodyField("截止（可留空长期）",until,29){until=it}};if(action=="occurrence"){CustodyField("自然年（2020至2200）",year,4){year=it};CustodyField("开始（YYYY-MM-DD）",start,10){start=it};CustodyField("结束（YYYY-MM-DD）",end,10){end=it};CustodyField("日期确认依据",reference,240){reference=it};Text("仅登记已核对的节日日期，同一规则同一年只能确认一次。")} ;CustodyField("操作原因",reason,500){reason=it};Text(error.ifBlank{outerError},color=MaterialTheme.colorScheme.error);PrimaryAction(onClick={try{val b=JSONObject().put("reason",reason);if(action=="publish")b.put("effectiveFrom",performanceTime(from)).put("effectiveUntil",if(until.isBlank())JSONObject.NULL else performanceTime(until));if(action=="occurrence")b.put("ruleId",rule!!.getString("id")).put("cycleYear",year.toInt()).put("startsOn",start).put("endsOn",end).put("confirmationReference",reference);submit(b)}catch(e:Exception){error=e.message?:"请核对日期和原因"}}){Text("继续核对")}}
 }}}
}
@Composable private fun AnnualOccurrencesView(m:AppModel,rule:JSONObject,close:()->Unit){
 val scope=rememberCoroutineScope();var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.annualOccurrences(rule.getString("id"),if(more)next else null);rows=if(more)rows+b.rows else b.rows;next=b.next;error=""}catch(e:Exception){error=e.message?:"读取失败"}finally{loading=false}}};LaunchedEffect(Unit){load()}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Text(rule.getString("title")+" · 节日日期",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};TextButton(onClick={load()},enabled=!loading){Text("刷新")};Text(error);if(!loading&&rows.isEmpty()&&error.isBlank())Text("尚未确认年度节日日期")};items(rows,key={it.getString("id")}){r->Panel{Text("${r.getInt("cycleYear")} 年 · ${r.getString("startsOn")} 至 ${r.getString("endsOn")}");Text(r.getString("confirmationReference"));Text("确认时间："+calendarLocal(r.getString("confirmedAt")))}};if(next!=null)item{TextButton(onClick={load(true)},enabled=!loading){Text("加载更多")}}
 }}}
}
