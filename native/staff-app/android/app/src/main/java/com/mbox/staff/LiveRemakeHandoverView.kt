package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
@Composable
fun LiveRemakeHandoverView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var notice by remember{mutableStateOf("")};var itemId by remember{mutableStateOf<String?>(null)}
 LaunchedEffect(Unit){m.loadRemakeHandover(null)};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("离店重做实物交接",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.remakeHandoverState);Text("原桌次已结束或原单已取消。核对原批次实物，登记未开封退回或实际耗用；原收退款单独处理。");LivePendingView(m);if(notice.isNotBlank())Text(notice);SecondaryAction(onClick={m.loadRemakeHandover(null)},enabled=!m.busy){Text("刷新待处理实物")}}
  val board=m.remakeHandoverBoard
  if(board?.rows?.isEmpty()==true)item{Text("当前没有离店重做实物待办")}
  for(row in board?.rows.orEmpty())item{key(row.getString("batchId"),row.getJSONArray("unitIds").toString()){
   var quantity by remember{mutableStateOf("1")};var reason by remember{mutableStateOf("")};var received by remember{mutableStateOf(false)};var checked by remember{mutableStateOf(false)}
   val units=row.getJSONArray("unitIds");val count=quantity.toIntOrNull()?:0;val valid=count in 1..minOf(999,units.length());val selected=if(valid)(0 until count).map{units.getString(it)}else emptyList();val eligibility=row.getJSONObject("returnEligibility");val canReturn=valid&&selected.all{eligibility.optJSONObject(it)?.optBoolean("canReturn")==true}
   fun submit(disposition:String){try{require(checked){"请先核对本批实物"};proposed=remakeHandoverCommand(m.identity!!,row,count,disposition,received,reason);notice=""}catch(e:Exception){notice=e.message?:"请核对实物"}}
   Panel{Text("${row.getString("tableCode")} · ${row.getString("productName")}",style=MaterialTheme.typography.titleMedium);Text("原订单 ${row.getString("orderPublicId")}\n待处理 ${row.getInt("pendingQuantity")}份 · ${assignmentTime(row.getString("createdAt"))}")
    CustodyField("本次实际份数",quantity,3){quantity=it;received=false;checked=false};CustodyField("实际处理说明",reason,500){reason=it};Row{Checkbox(checked=checked,onCheckedChange={checked=it});Text("已核对本批实物与所填份数")}
    if(row.getBoolean("canReceive")){
     if(!canReturn)Text(selected.firstNotNullOfOrNull{eligibility.optJSONObject(it)?.takeIf{e->!e.optBoolean("canReturn") }?.textOrNull("reason")}?:"请填写份数并核对原包装证据；不能为了清待办而登记损耗。")
     Row{Checkbox(checked=received,onCheckedChange={received=it},enabled=canReturn);Text("实物已收回且未开封")}
     PrimaryAction(onClick={submit("returned_unopened")},enabled=m.canUseRemakeHandover&&checked&&canReturn&&received){Text("登记本批实物退回")}
    }
    if(row.getBoolean("canRecordUsed"))SecondaryAction(onClick={submit("used_loss")},enabled=m.canUseRemakeHandover&&valid&&checked,danger=true){Text("登记实际耗用或损耗")}
    TextButton(onClick={itemId=row.getString("itemId")}){Text("查看原商品与售后")}
   }
  }}
  board?.data?.optJSONObject("nextCursor")?.let{cursor->item{TextButton(onClick={m.loadRemakeHandover(cursor)},enabled=!m.busy){Text("下一页离店实物")}}}
 }}}
 itemId?.let{LiveAfterSalesView(m,it){itemId=null;m.loadRemakeHandover(null)}}
 proposed?.let{cmd->AlertDialog(onDismissRequest={proposed=null},title={Text(cmd.title)},text={Text(cmd.steps[0].remakeHandoverProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(cmd)},enabled=m.canUseRemakeHandover){Text("确认实际处理")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
