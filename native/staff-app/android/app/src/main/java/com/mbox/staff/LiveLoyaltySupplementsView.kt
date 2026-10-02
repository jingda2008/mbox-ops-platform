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
@Composable
fun LiveLoyaltySupplementsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion}
 var selected by remember{mutableStateOf<JSONObject?>(null)};var action by remember{mutableStateOf("request")};var reason by remember{mutableStateOf("")};var notice by remember{mutableStateOf("")};var query by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadLoyaltySupplements("reconciliation",0)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){selected=null;proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("积分对账与补发",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.loyaltySupplementsState);Text("依据原订单、实际收退款和原积分规则核算。申请人不能审核自己的申请；有退款归属待核时须先完成退款复核。");if(notice.isNotBlank())Text(notice);LivePendingView(m);AssignmentChoice("查看",m.loyaltySupplementsBoard?.data?.getString("section")?:"reconciliation",listOf("reconciliation" to "原订单对账","requests" to "申请与审核历史")){selected=null;m.loadLoyaltySupplements(it,0)};SecondaryAction(onClick={m.loadLoyaltySupplements()},enabled=!m.busy){Text("刷新原账")};CustodyField("筛选本页订单或会员号",query,100){query=it}}
  selected?.let{row->item{Panel{Text("${row.getString("orderPublicId")} · ${row.getString("memberNo")}",style=MaterialTheme.typography.titleMedium);Text(when(action){"request"->"申请核对漏积分";"approve"->"独立审核并补发";else->"驳回原申请"});CustodyField("实际核对依据",reason,500){reason=it};PrimaryAction(onClick={try{proposed=loyaltySupplementCommand(m.identity!!,action,row,reason);notice=""}catch(e:Exception){notice=e.message?:"请核对原账"}},enabled=m.canUseLoyaltySupplements){Text("核对后提交")};TextButton(onClick={selected=null}){Text("收起")}}}}
  val board=m.loyaltySupplementsBoard
  if(board!=null){
   val rows=board.rows.filter{it.getString("orderPublicId").contains(query,true)||it.getString("memberNo").contains(query,true)}
   if(rows.isEmpty())item{Text("本页没有符合条件的记录")}
   for(row in rows)item{Panel{
    Text(row.getString("orderPublicId"),style=MaterialTheme.typography.titleMedium);Text("${row.getString("memberNo")} · ${supplementStatusNames[row.getString("status")]?:"请核对状态"}")
    if(board.data.getString("section")=="reconciliation"){
     Text("符合积分条件的原货款 ${loyaltyRefundMoney(row.getLong("eligibleAmountMinor"))}");Text("原规则积分 ${row.getInt("expectedPoints")} / 已记积分 ${row.getInt("existingPoints")}\n原规则成长 ${row.getInt("expectedGrowth")} / 已记成长 ${row.getInt("existingGrowth")}")
     val refunds=row.optJSONArray("reviewRefundPublicIds");if(refunds!=null&&refunds.length()>0)Text("待核退款："+(0 until refunds.length()).joinToString("、"){refunds.getString(it)})
     if(row.getString("status") in setOf("missing","mismatch")&&m.identity?.allows("loyalty.accrual.request")==true)SecondaryAction(onClick={selected=row;action="request";reason=""},enabled=m.canUseLoyaltySupplements){Text("申请原积分核对")}
    }else{
     Text("申请 ${row.getString("publicId")}\n申请人 ${row.getString("requestedByName")} · ${assignmentTime(row.getString("createdAt"))}");Text("申请补积分 ${row.getInt("requestedPoints")} · 成长 ${row.getInt("requestedGrowth")}");Text(row.getString("reason"));row.textOrNull("decisionReason")?.let{Text("审核：${row.textOrNull("approvedByName")?:"原审核人"} · $it")}
     if(row.getString("status")=="requested"&&m.identity?.allows("loyalty.accrual.approve")==true){
      val independent=row.getString("requestedByEmployeeId")!=m.identity?.employeeId
      SecondaryAction(onClick={selected=row;action="approve";reason=""},enabled=m.canUseLoyaltySupplements&&independent){Text(if(independent)"核对后同意补发" else "等待其他员工独立审核")};TextButton(onClick={selected=row;action="reject";reason=""},enabled=m.canUseLoyaltySupplements&&independent){Text("驳回申请")}
     }
    }
   }}
   item{val page=board.data.getInt("page");Text("第${page+1}页，每页最多100条");if(page>0)TextButton(onClick={selected=null;m.loadLoyaltySupplements(board.data.getString("section"),page-1)},enabled=!m.busy){Text("上一页")};if(board.data.getBoolean("hasMore"))TextButton(onClick={selected=null;m.loadLoyaltySupplements(board.data.getString("section"),page+1)},enabled=!m.busy){Text("下一页")}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("确认原积分核对")},text={Text(command.steps[0].loyaltySupplementProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;selected=null;m.executeLive(command)},enabled=m.canUseLoyaltySupplements){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
