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
fun LiveLoyaltyRefundsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion}
 var edit by remember{mutableStateOf<LoyaltyRefundEditor?>(null)};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var notice by remember{mutableStateOf("")};var query by remember{mutableStateOf("")}
 LaunchedEffect(Unit){m.loadLoyaltyRefunds(0)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){edit=null;proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("退款积分复核",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text("核对已成功退款对应的原商品货款，服务端据此冲回原积分与成长值；不会再次退款。申请人不能审核自己的申请。");Text(m.loyaltyRefundState);if(notice.isNotBlank())Text(notice);LivePendingView(m);CustodyField("筛选本页订单或退款编号",query,100){query=it};SecondaryAction(onClick={m.loadLoyaltyRefunds()},enabled=!m.busy){Text("刷新原退款依据")}}
  edit?.let{editor->item{key(editor){LoyaltyRefundForm(m,editor,{edit=null}){make->try{proposed=make();notice=""}catch(e:Exception){notice=e.message?:"请核对金额分配"}}}}}
  val board=m.loyaltyRefundBoard
  if(board!=null){
   val rows=board.rows.filter{it.getString("orderPublicId").contains(query,true)||it.getString("refundPublicId").contains(query,true)}
   if(rows.isEmpty())item{Text("当前页没有符合条件的退款复核")}
   for(row in rows)item{Panel{
    Text("${row.getString("orderPublicId")} · ${if(row.getString("status")=="resolved")"已复核" else "待核对"}",style=MaterialTheme.typography.titleMedium);Text("退款 ${row.getString("refundPublicId")}")
    Text("退款总额 ${loyaltyRefundMoney(row.getLong("refundAmountMinor"))} · 其中溢收退款 ${loyaltyRefundMoney(row.getLong("excessAmountMinor"))}");Text("需分配原货款 ${loyaltyRefundMoney(row.getLong("salesRefundAmountMinor"))}")
    row.textOrNull("blockingRefundPublicId")?.let{Text("须先处理较早退款 $it")}
    for(item in row.getJSONArray("items").objects())Text("${item.getString("productName")} · 原数量 ${item.get("quantity")} · 最多归属 ${loyaltyRefundMoney(item.getLong("maxSalesReturnAmountMinor"))} · ${if(item.getBoolean("loyaltyEligible"))"参与积分" else "不参与积分"}")
    if(canWriteLoyaltyRefunds(m.identity,"request")&&row.getString("status")=="pending")PrimaryAction(onClick={edit=LoyaltyRefundEditor(row)},enabled=m.canUseLoyaltyRefunds&&row.textOrNull("blockingRefundPublicId")==null){Text("填写实际商品归属")}
    for(request in row.getJSONArray("requests").objects()){
     Text("申请人 ${request.getString("requestedByName")} · ${mapOf("requested" to "待复核","approved" to "已通过","rejected" to "已驳回","stale" to "依据已变化","superseded" to "已被新申请替代")[request.getString("status")]}");Text(request.getString("reason"));Text(assignmentTime(request.getString("createdAt")))
     request.textOrNull("decisionReason")?.let{Text("复核依据 $it")}
     TextButton(onClick={edit=LoyaltyRefundEditor(row,request)}){Text("查看分配及复核")}
    }
   }}
   item{val page=board.data.getInt("page");Text("第${page+1}页，每页最多100条");if(page>0)TextButton(onClick={edit=null;m.loadLoyaltyRefunds(page-1)},enabled=!m.busy){Text("上一页")};if(board.data.getBoolean("hasMore"))TextButton(onClick={edit=null;m.loadLoyaltyRefunds(page+1)},enabled=!m.busy){Text("下一页")}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("确认积分退款复核")},text={Text(command.steps[0].loyaltyRefundProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;edit=null;m.executeLive(command)},enabled=m.canUseLoyaltyRefunds){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
data class LoyaltyRefundEditor(val row:JSONObject,val request:JSONObject?=null)
@Composable
fun LoyaltyRefundForm(m:AppModel,edit:LoyaltyRefundEditor,close:()->Unit,propose:(()->LiveCommand)->Unit){
 val row=edit.row;val request=edit.request
 var values by remember{mutableStateOf<Map<String,String>>(emptyMap())};var reason by remember{mutableStateOf("")};var decision by remember{mutableStateOf("reject")}
 Panel{
  Text(if(request==null)"逐项填写原货款归属" else "核对已提交的分配",style=MaterialTheme.typography.titleLarge);Text("${row.getString("orderPublicId")} · ${row.getString("refundPublicId")}")
  if(request==null){
   val refunds=listOf(row)+row.getJSONArray("historicalRefunds").objects()
   for(refund in refunds){
    val prefix=refund.getString("refundId")+":"
    Text("${refund.getString("refundPublicId")} · 应分配 ${loyaltyRefundMoney(refund.getLong("salesRefundAmountMinor"))}")
    for(item in refund.getJSONArray("items").objects()){
     val key=prefix+item.getString("orderItemId");CustodyField("${item.getString("productName")} · 退回货款（元，未涉及填0）",values[key].orEmpty(),18){values=values+(key to it)}
     Text("最多 ${loyaltyRefundMoney(item.getLong("maxSalesReturnAmountMinor"))}")
    }
   }
  }else{
   fun itemName(id:String)=(listOf(row)+row.getJSONArray("historicalRefunds").objects()).flatMap{it.getJSONArray("items").objects()}.firstOrNull{it.getString("orderItemId")==id}?.getString("productName")?:id
   for(line in request.getJSONArray("allocations").objects())Text("${itemName(line.getString("orderItemId"))} · ${loyaltyRefundMoney(line.getLong("salesRefundAmountMinor"))}")
   for(history in request.getJSONArray("historicalAllocations").objects()){
    Text("历史退款 ${row.getJSONArray("historicalRefunds").objects().firstOrNull{it.getString("refundId")==history.getString("refundId")}?.getString("refundPublicId")?:history.getString("refundId")}")
    for(line in history.getJSONArray("allocations").objects())Text("${itemName(line.getString("orderItemId"))} · ${loyaltyRefundMoney(line.getLong("salesRefundAmountMinor"))}")
   }
   Text("申请依据：${request.getString("reason")}")
   if(request.getString("requestedByEmployeeId")==m.identity?.employeeId)Text("请由其他有权限的员工复核")
   AssignmentChoice("审核结论",decision,listOf("reject" to "驳回重新核对","approve" to "同意此分配")){decision=it}
  }
  CustodyField(if(request==null)"商品与退款核对依据" else "独立复核依据",reason,1000){reason=it}
  val action=if(request==null)"request" else "decision"
  PrimaryAction(onClick={propose{
   val body=JSONObject().put("reason",reason.trim());val details=StringBuilder()
   if(request==null){
    val current=loyaltyRefundAllocations(row,values,row.getString("refundId")+":");val history=JSONArray()
    for(r in row.getJSONArray("historicalRefunds").objects())history.put(JSONObject().put("refundId",r.getString("refundId")).put("allocations",loyaltyRefundAllocations(r,values,r.getString("refundId")+":")))
    body.put("refundId",row.getString("refundId")).put("basisVersion",row.getString("basisVersion")).put("allocations",current).put("historicalAllocations",history)
    for(r in listOf(row)+row.getJSONArray("historicalRefunds").objects()){details.append("\n${r.getString("refundPublicId")}");for(item in r.getJSONArray("items").objects())details.append("\n${item.getString("productName")}：${values[r.getString("refundId")+":"+item.getString("orderItemId")]}元")}
   }else{require(request.getString("requestedByEmployeeId")!=m.identity?.employeeId);body.put("requestId",request.getString("requestId")).put("basisVersion",request.getString("basisVersion")).put("decision",decision);details.append("\n申请人 ${request.getString("requestedByName")}\n${if(decision=="approve")"同意已展示分配，由服务端冲回原积分与成长值" else "驳回，积分和成长值不变"}")}
   loyaltyRefundCommand(m.identity!!,action,body,row.getString("refundId"),"${if(request==null)"提交商品归属申请" else "提交独立复核"}\n${row.getString("orderPublicId")}\n${row.getString("refundPublicId")}$details\n依据：${reason.trim()}\n不会再次执行退款。")
  }},enabled=m.canUseLoyaltyRefunds&&canWriteLoyaltyRefunds(m.identity,action)&&(request==null||request.getString("status")=="requested"&&request.getString("requestedByEmployeeId")!=m.identity?.employeeId)){Text("核对后提交")}
  TextButton(onClick=close){Text("收起")}
 }
}
