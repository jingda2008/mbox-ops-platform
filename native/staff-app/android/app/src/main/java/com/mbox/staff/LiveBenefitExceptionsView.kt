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
fun LiveBenefitExceptionsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion}
 var selected by remember{mutableStateOf<JSONObject?>(null)};var action by remember{mutableStateOf("retry")};var reason by remember{mutableStateOf("")};var reference by remember{mutableStateOf("")};var notice by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadBenefitExceptions(0)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){selected=null;proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("礼遇出品异常",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.benefitExceptionsState);Text("先核对厨房和现场实物。只有自动重试已停止的原零元礼遇，才能取消或登记已有线下补偿；不能重复发货。");if(notice.isNotBlank())Text(notice);LivePendingView(m);SecondaryAction(onClick={m.loadBenefitExceptions()},enabled=!m.busy){Text("刷新原任务")}}
  selected?.let{row->item{Panel{
   Text("${row.getString("tableCode")}桌 · ${row.getString("orderPublicId")}",style=MaterialTheme.typography.titleMedium)
   AssignmentChoice("处理方式",action,benefitExceptionActions.filterKeys{it=="retry"||row.getString("status")=="failed"}.toList()){action=it}
   CustodyField("实际处理依据",reason,500){reason=it};if(action=="external_compensation")CustodyField("已完成线下补偿的凭证编号",reference,200){reference=it}
   PrimaryAction(onClick={try{proposed=benefitExceptionCommand(m.identity!!,action,row,reason,reference);notice=""}catch(e:Exception){notice=e.message?:"请核对原礼遇"}},enabled=m.canUseBenefitExceptions){Text("核对后处理")};TextButton(onClick={selected=null}){Text("收起")}
  }}}
  val board=m.benefitExceptionsBoard
  if(board!=null){
   if(board.rows.isEmpty())item{Text("当前页没有待处理礼遇出品异常")}
   for(row in board.rows)item{Panel{
    Text("${row.getString("tableCode")}桌 · ${row.textOrNull("title")?:"原礼遇"}",style=MaterialTheme.typography.titleMedium);Text(row.getString("orderPublicId"));Text("${if(row.getString("status")=="failed")"自动重试已停止" else "等待系统重试"} · 已尝试 ${row.getInt("attemptCount")}次")
    Text("最后异常 ${row.textOrNull("lastErrorAt")?.let(::assignmentTime)?:"时间未知"}");row.textOrNull("memberNo")?.let{Text("会员 $it")};row.textOrNull("lastErrorCode")?.let{Text("原因代码 $it")}
    SecondaryAction(onClick={selected=row;action="retry";reason="";reference=""},enabled=m.canUseBenefitExceptions){Text("核对与处理")}
   }}
   item{val page=board.data.getInt("page");Text("第${page+1}页，每页最多100条");if(page>0)TextButton(onClick={selected=null;m.loadBenefitExceptions(page-1)},enabled=!m.busy){Text("上一页")};if(board.data.getBoolean("hasMore"))TextButton(onClick={selected=null;m.loadBenefitExceptions(page+1)},enabled=!m.busy){Text("下一页")}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("确认原礼遇处理")},text={Text(command.steps[0].benefitExceptionProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;selected=null;m.executeLive(command)},enabled=m.canUseBenefitExceptions){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
