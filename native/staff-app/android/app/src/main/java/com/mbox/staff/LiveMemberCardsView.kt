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
fun LiveMemberCardsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion}
 var edit by remember{mutableStateOf<MemberCardEditor?>(null)};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var notice by remember{mutableStateOf("")}
 val actor=m.identity
 val sections=buildList{if(actor?.allows("member.card.manage")==true||actor?.allows("loyalty.policy.publish")==true)add("projects" to "卡项目");if(actor?.allows("member.card.review")==true)add("applications" to "申请审核");if(actor?.allows("member.card.manage")==true)add("holdings" to "持卡记录")}
 LaunchedEffect(Unit){sections.firstOrNull()?.let{m.loadMemberCards(it.first)}}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){edit=null;proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion||actor==null)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("会员卡管理",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.memberCardsState);if(notice.isNotBlank())Text(notice);LivePendingView(m);Text("持卡与会员等级独立。员工审核顾客已提交的申请，不代替顾客申请或接受条款。")}
  item{AssignmentChoice("查看",m.memberCardsBoard?.section?:sections.firstOrNull()?.first.orEmpty(),sections){edit=null;m.loadMemberCards(it)};SecondaryAction(onClick={m.loadMemberCards()},enabled=!m.busy){Text("刷新当前页")}}
  val board=m.memberCardsBoard
  if(board!=null){
   edit?.let{item{key(it){MemberCardForm(m,it,{edit=null}){make->try{proposed=make();notice=""}catch(e:Exception){notice=e.message?:"请核对输入"}}}}}
   if(board.section=="projects"&&actor.allows("member.card.manage"))item{PrimaryAction(onClick={edit=MemberCardEditor("create")},enabled=m.canUseMemberCards){Text("新建卡项目草稿")}}
   if(board.rows.isEmpty())item{Text("当前没有记录")}
   for(row in board.rows)item{Panel{
    Text(row.optString("name",row.optString("project_name","会员卡")),style=MaterialTheme.typography.titleMedium);Text(cardStateNames[row.getString("status")]?:row.getString("status"))
    if(board.section=="projects"){
     Text("${row.getString("code")} · 第${row.getInt("version")}版 · ${if(row.getString("kind")=="cobrand")"联名卡" else "兴趣卡"}")
     Text("${performanceLocal(row.getString("available_from"))} — ${performanceLocal(row.getString("available_until"))}");Text(row.getString("terms"))
     if(row.getString("status")!="closed"){
      if(actor.allows("loyalty.policy.publish")&&row.getString("status")!="open")SecondaryAction(onClick={edit=MemberCardEditor("state",row,"open")},enabled=m.canUseMemberCards&&row.getString("created_by_employee_id")!=actor.employeeId){Text(if(row.getString("created_by_employee_id")==actor.employeeId)"由其他发布人开放" else "核对后开放申请")}
      if(actor.allows("member.card.manage")){
       if(row.getString("status")=="open")SecondaryAction(onClick={edit=MemberCardEditor("state",row,"paused")},enabled=m.canUseMemberCards){Text("暂停新申请")}
       TextButton(onClick={edit=MemberCardEditor("state",row,"closed")},enabled=m.canUseMemberCards){Text("关闭卡项目")}
       if(row.getString("status")=="draft")SecondaryAction(onClick={edit=MemberCardEditor("social",row)},enabled=m.canUseMemberCards){Text("配置加入门槛与卡片")}
      }
     }
     if(actor.allows("member.card.manage"))SecondaryAction(onClick={edit=MemberCardEditor("menu",row)},enabled=m.canUseMemberCards){Text("专属菜单与价格")}
    }else{
     Text("客户 ${row.getString("customer_reference")}")
     row.textOrNull("member_no")?.let{Text("会员号 $it")}
     if(board.section=="applications"){
      Text("申请时间 ${assignmentTime(row.getString("requested_at"))}")
      SecondaryAction(onClick={edit=MemberCardEditor("review",row,"approve")},enabled=m.canUseMemberCards){Text("核对后通过")};TextButton(onClick={edit=MemberCardEditor("review",row,"reject")},enabled=m.canUseMemberCards){Text("拒绝并记录原因")}
     }else{
      Text("有效期至 ${assignmentTime(row.getString("valid_until"))}${if(row.getBoolean("expired"))" · 已到期" else ""}")
      if(row.getString("status")=="active")SecondaryAction(onClick={edit=MemberCardEditor("holding",row,"suspend")},enabled=m.canUseMemberCards){Text("暂停此卡")}
      if(row.getString("status")=="suspended"&&!row.getBoolean("expired"))SecondaryAction(onClick={edit=MemberCardEditor("holding",row,"resume")},enabled=m.canUseMemberCards){Text("核对后恢复")}
      if(row.getString("status") in listOf("active","suspended"))TextButton(onClick={edit=MemberCardEditor("holding",row,"revoke")},enabled=m.canUseMemberCards){Text("撤销此卡")}
     }
    }
   }}
   item{Row{TextButton(onClick={edit=null;m.loadMemberCards(board.section,"")},enabled=!m.busy){Text("回到第一页")};board.next?.let{cursor->TextButton(onClick={edit=null;m.loadMemberCards(board.section,cursor)},enabled=!m.busy){Text("下一页")}}};Text("每页最多50条。暂停申请不会撤销已持有的卡，撤卡也不会自动生成退款或积分变更。")}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("核对会员卡操作")},text={Text(command.steps[0].memberCardProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;edit=null;m.executeLive(command)},enabled=m.canUseMemberCards){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
data class MemberCardEditor(val action:String,val row:JSONObject?=null,val target:String="")
