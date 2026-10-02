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
import org.json.JSONObject
import org.json.JSONArray
@Composable fun LiveContactGovernanceView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion}
 var area by remember{mutableStateOf("policies")};var search by remember{mutableStateOf("")};var action by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadContactGovernance()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 fun propose(b:JSONObject){try{val board=m.contactGovernanceBoard?:error("请刷新保留记录");proposed=contactGovernanceCommand(m.identity!!,CouponCalendarsBoard(JSONObject(board.data.toString()).put("rows",JSONArray(m.contactGovernanceRows))),action,selected,b);error=""}catch(e:Exception){error=e.message?:"请核对操作依据"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){
  Surface(Modifier.fillMaxSize(),color=Paper){
   LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
    item{Row{Text("联系方式保留与清除",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.contactGovernanceState);if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error);Text("这里只显示掩码、保留策略和清除证据。保留期限和依据须由门店核实。",style=MaterialTheme.typography.bodySmall)}
    if(action.isNotBlank())item{ContactGovernanceForm(action,selected,{action=""},::propose)}
    else{
     item{AssignmentChoice("查看",area,listOf("policies" to "策略版本","holds" to "法定保留","dispositions" to "清除证据")+(if(m.identity?.allows("privacy.contact.legal_hold")==true)listOf("resources" to "选择保留对象")else emptyList())){if(m.loadContactGovernance(it)){area=it;search=""}};if(area=="resources")CustodyField("活动、掩码或版本编号（支持部分文字）",search,80){search=it};TextButton(onClick={m.loadContactGovernance(area,search)},enabled=!m.busy){Text("刷新 / 查询")};if(area=="policies"&&m.identity?.allows("privacy.contact.retention.draft")==true)TextButton(onClick={action="draft";selected=null},enabled=m.canUseContactGovernance){Text("新建保留策略草稿")}}
     items(if(m.contactGovernanceBoard?.data?.textOrNull("area")==area)m.contactGovernanceRows else emptyList(),key={it.getString(if(area=="dispositions")"resourcePublicId"else "publicId")}){r->Panel{
      Text(contactResourceKinds.toMap()[r.getString("resourceKind")]?:r.getString("resourceKind"),style=MaterialTheme.typography.titleMedium)
      when(area){
       "policies"->{Text("第${r.getInt("version")}版 · ${mapOf("draft" to "待审批","approved" to "待发布","published" to "已发布")[r.getString("status")]?:r.getString("status")}");Text("目的结束后保留 ${r.getInt("retentionDaysAfterPurposeEnd")} 天\n依据：${r.getString("legalBasisReference")}");Text("起草：${r.getString("draftedBy")} · ${r.getString("draftReason")}");r.textOrNull("approvedBy")?.let{Text("审批：$it · ${r.textOrNull("approvalReason")?:""}")};r.textOrNull("publishedBy")?.let{Text("发布：$it · ${r.textOrNull("publicationReason")?:""}")};r.textOrNull("effectiveFrom")?.let{Text("生效：${calendarLocal(it)}\n截至：${r.textOrNull("effectiveUntil")?.let{t->calendarLocal(t)}?:"尚未安排结束"}")};if(r.getString("status")=="draft"&&m.identity?.allows("privacy.contact.retention.approve")==true)TextButton(onClick={selected=r;action="approve"},enabled=m.canUseContactGovernance){Text("独立审批")};if(r.getString("status")=="approved"&&m.identity?.allows("privacy.contact.retention.publish")==true)TextButton(onClick={selected=r;action="publish"},enabled=m.canUseContactGovernance){Text("第三人发布")}}
       "holds"->{Text("${r.getString("maskedContact")} · ${if(r.getString("status")=="active")"保留中"else "已释放"}");Text(r.getString("resourcePublicId"));Text("依据：${r.getString("legalBasisReference")}\n原因：${r.getString("reason")}");Text("${r.getString("createdBy")} · ${calendarLocal(r.getString("createdAt"))}");Text("保留至：${r.textOrNull("holdUntil")?.let{calendarLocal(it)}?:"无预定截止"}");r.textOrNull("releasedAt")?.let{Text("${calendarLocal(it)} 由 ${r.textOrNull("releasedBy")?:"原员工"} 释放\n${r.textOrNull("releaseReason")?:""}")};if(r.getString("status")=="active"&&m.identity?.allows("privacy.contact.legal_hold")==true)TextButton(onClick={selected=r;action="release"},enabled=m.canUseContactGovernance){Text("核对释放保留")}}
       "resources"->{Text(r.getString("businessLabel"));Text("${r.getString("maskedContact")} · ${r.getString("publicId")}");TextButton(onClick={selected=r;action="hold"},enabled=m.canUseContactGovernance){Text("为此原版本建立保留")}}
       "dispositions"->{Text(r.getString("resourcePublicId"));Text("已清除 · 原策略第${r.getInt("policyVersion")}版");Text("目的结束：${calendarLocal(r.getString("purposeEndedAt"))}\n清除时间：${calendarLocal(r.getString("disposedAt"))}");Text("依据策略：${r.getString("policyPublicId")}")}
      }
     }}
     if(m.contactGovernanceBoard?.next!=null)item{TextButton(onClick={m.loadContactGovernance(area,search,true)},enabled=!m.busy){Text("加载更多记录")}}
    }
   }
  }
 }
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认保留与清除操作")},text={Text(c.steps[0].contactGovernanceProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;action="";m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
@Composable private fun ContactGovernanceForm(action:String,row:JSONObject?,back:()->Unit,submit:(JSONObject)->Unit){
 var kind by remember(action,row){mutableStateOf(row?.getString("resourceKind")?:"activity_registration_contact")};var days by remember(action,row){mutableStateOf("")};var basis by remember(action,row){mutableStateOf("")};var reason by remember(action,row){mutableStateOf("")};var time by remember(action,row){mutableStateOf("")};var error by remember(action,row){mutableStateOf("")}
 Panel{
  Text(mapOf("draft" to "起草保留策略","approve" to "独立审批","publish" to "安排生效时间","hold" to "建立法定保留","release" to "释放保留")[action]!!,style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回记录")}
  if(action=="draft"){AssignmentChoice("资源",kind,contactResourceKinds){kind=it};CustodyField("目的结束后保留天数（0至36500）",days,5){days=it};Text("零天表示目的结束后即可按清除任务处理。请填写门店核准的期限。",style=MaterialTheme.typography.bodySmall)}
  row?.let{Text(if(action in listOf("hold","release"))"${it.getString("maskedContact")} · ${it.getString(if(action=="hold")"publicId"else "resourcePublicId")}"else "第${it.getInt("version")}版 · 保留 ${it.getInt("retentionDaysAfterPurposeEnd")} 天\n${it.getString("legalBasisReference")}")}
  if(action in listOf("draft","hold"))CustodyField("已核实的法定或争议依据",basis,500){basis=it}
  if(action in listOf("hold","publish"))CustodyField(if(action=="hold")"可选截止（北京时间 YYYY-MM-DD HH:mm）"else "生效时间（北京时间 YYYY-MM-DD HH:mm）",time,29){time=it}
  CustodyField("操作原因 / 审核意见",reason,500){reason=it};if(action=="release")Text("释放后仅解除此保留；符合已发布期限的旧版本将由清除任务处理。",style=MaterialTheme.typography.bodySmall);Text(error,color=MaterialTheme.colorScheme.error)
  TextButton(onClick={try{val b=JSONObject().put("reason",reason);if(action in listOf("draft","hold"))b.put("resourceKind",kind).put("legalBasisReference",basis);if(action=="draft")b.put("retentionDaysAfterPurposeEnd",days.toInt());if(action=="publish")b.put("effectiveFrom",performanceTime(time));if(action=="hold")b.put("holdUntil",if(time.isBlank())JSONObject.NULL else performanceTime(time));submit(b)}catch(e:Exception){error=e.message?:"请核对期限与依据"}}){Text("继续核对")}
 }
}
