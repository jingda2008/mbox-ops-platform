package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable fun LiveMembershipRecoveryView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var history by remember{mutableStateOf(false)};var action by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var candidate by remember{mutableStateOf<JSONObject?>(null)};var picker by remember{mutableStateOf(false)};var member by remember{mutableStateOf("")};var phone by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var checked by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadMembershipRecovery()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 val lifecycle=LocalLifecycleOwner.current;DisposableEffect(lifecycle){val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_STOP){phone="";member="";reason="";proposed=null;action="";selected=null;candidate=null;picker=false}};lifecycle.lifecycle.addObserver(observer);onDispose{lifecycle.lifecycle.removeObserver(observer)}}
 fun choose(a:String,r:JSONObject?){action=a;selected=r;candidate=null;reason="";checked=false;error=""}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("历史会员找回与合并",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.membershipRecoveryState);Text("先核验本人和原会员凭据，再由另一位授权员工复核。保留来源账户和权益历史，不由此开启营销许可。",style=MaterialTheme.typography.bodySmall);if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
  if(action.isNotBlank())item{Panel{
   TextButton(onClick={action="";phone="";member="";reason=""}){Text("返回列表")}
   if(action=="contact"){CustodyField("完整会员号",member,64){member=it};OutlinedTextField(phone,{phone=it},label={Text("已核验手机号，带国家代码（+86）")},singleLine=true,visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth());Text("请使用原始会员登记或现场核验凭据，不按猜测填写。")}
   else{val row=selected!!;Text("申请 ${row.getString("casePublicId")}\n${row.textOrNull("maskedPhone")?:"联系方式待核对"}\n${row.textOrNull("maskedMemberNo")?:"尚未选择会员候选"}");if(action=="select"){TextButton(onClick={picker=true}){Text("读取并选择原候选")};candidate?.let{Text("选中 ${it.getString("maskedMemberNo")} · ${it.getString("maskedPhone")}\n入会 ${it.getString("joinedDate")}")}}}
   CustodyField(if(action=="reject")"驳回依据"else "实际核验和复核依据",reason,500){reason=it}
   Row{Checkbox(checked,{checked=it});Text(if(action=="contact")"已核对本人身份、原会员凭据和手机号"else if(action=="approve")"已独立核对所选会员，确认进行合并"else "已核对原申请及上述处理依据")}
   PrimaryAction(onClick={try{val body=JSONObject().put("reason",reason);if(action=="contact")body.put("memberNo",member).put("phone",phone.trim());if(action=="select")body.put("candidatePublicId",candidate?.getString("candidatePublicId")?:error("请先选择原候选"));val board=m.membershipRecoveryBoard?:error("请刷新原申请");proposed=membershipRecoveryCommand(m.identity!!,CouponCalendarsBoard(JSONObject(board.data.toString()).put("rows",JSONArray(m.membershipRecoveryRows))),action,selected,body);error=""}catch(e:Exception){error=e.message?:"请核对会员和依据"}},enabled=checked&&m.canUseMembershipRecovery){Text("继续核对")}
  }}else{
   item{AssignmentChoice("查看",history.toString(),listOf("false" to "待处理","true" to "全部历史")){val h=it.toBoolean();if(m.loadMembershipRecovery(h))history=h};TextButton(onClick={m.loadMembershipRecovery(history)},enabled=!m.busy){Text("刷新原申请")};if(m.identity?.allows(membershipRecoveryPermissions[0])==true)SecondaryAction(onClick={choose("contact",null)},enabled=m.canUseMembershipRecovery){Text("登记人工核验的历史联系方式")}}
   val rows=if(m.membershipRecoveryBoard?.data?.optBoolean("history")==history)m.membershipRecoveryRows else emptyList()
   if(rows.isEmpty()&&!m.busy)item{Text("当前没有符合条件的找回申请")}
   items(rows,key={it.getString("casePublicId")}){row->Panel{Text(membershipRecoveryStatuses[row.getString("status")]?:"状态待核对",style=MaterialTheme.typography.titleMedium);Text("${row.getString("casePublicId")}\n${row.textOrNull("maskedPhone")?:"联系方式待核对"} · ${row.getInt("candidateCount")} 个候选");row.textOrNull("maskedMemberNo")?.let{Text("已选会员 $it")};Text(calendarLocal(row.getString("createdAt")),style=MaterialTheme.typography.bodySmall)
    if(row.getString("status")=="manual_review"&&m.identity?.allows(membershipRecoveryPermissions[0])==true)TextButton(onClick={choose("select",row)},enabled=m.canUseMembershipRecovery){Text("核验会员候选")}
    if(row.getString("status")=="pending_review"&&m.identity?.allows(membershipRecoveryPermissions[1])==true)TextButton(onClick={choose("approve",row)},enabled=m.canUseMembershipRecovery&&row.textOrNull("selectedByEmployeeId")!=m.identity?.employeeId){Text("独立复核并合并")}
    if(row.getString("status") in listOf("manual_review","pending_review")&&m.identity?.allows(membershipRecoveryPermissions[1])==true)TextButton(onClick={choose("reject",row)},enabled=m.canUseMembershipRecovery){Text("驳回申请并留存依据")}
   }}
   if(m.membershipRecoveryBoard?.next!=null)item{TextButton(onClick={m.loadMembershipRecovery(history,true)},enabled=!m.busy){Text("加载更多记录")}}
  }
 }}}
 if(picker&&selected!=null)MembershipRecoveryPicker(m,selected!!,{picker=false}){candidate=it;picker=false}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text(c.title)},text={Text(c.steps[0].membershipRecoveryProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;action="";phone="";member="";reason="";m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
@Composable private fun MembershipRecoveryPicker(m:AppModel,row:JSONObject,close:()->Unit,select:(JSONObject)->Unit){
 val scope=rememberCoroutineScope();var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var state by remember{mutableStateOf("")}
 fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.membershipRecoveryCandidates(row,if(more)next else null);rows=if(more)rows+b.rows else b.rows;next=b.next;state="仅展示掩码，结合原始凭据确认候选。"}catch(e:Exception){rows=emptyList();next=null;state=e.message?:"候选读取失败"}finally{loading=false}}};LaunchedEffect(Unit){load()}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Text("选择原会员候选",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};Text(state);TextButton(onClick={load()},enabled=!loading){Text("重新读取候选")}}
 items(rows,key={it.getString("candidatePublicId")}){r->Panel{Text("${r.getString("maskedMemberNo")} · ${r.getString("maskedPhone")}\n入会日期 ${r.getString("joinedDate")}");TextButton(onClick={select(r)},enabled=!loading){Text("选择此会员")}}}
 if(next!=null)item{TextButton(onClick={load(true)},enabled=!loading){Text("加载更多候选")}}
 }}}
}
