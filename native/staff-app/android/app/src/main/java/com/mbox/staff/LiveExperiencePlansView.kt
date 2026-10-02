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
@Composable fun LiveExperiencePlansView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var history by remember{mutableStateOf(false)};val today=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).toString();var from by remember{mutableStateOf(today)};var to by remember{mutableStateOf(today)};var selected by remember{mutableStateOf<JSONObject?>(null)};var action by remember{mutableStateOf("")};var cue by remember{mutableStateOf<JSONObject?>(null)};var reason by remember{mutableStateOf("")};var minutes by remember{mutableStateOf("")};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadExperiencePlans()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun query(){try{if(history){val a=java.time.LocalDate.parse(from);val b=java.time.LocalDate.parse(to);require(!a.isAfter(b)&&java.time.temporal.ChronoUnit.DAYS.between(a,b)<=60){"日期范围须在60天内"}};selected=null;action="";error="";m.loadExperiencePlans(if(history)"?history=true&from=$from&to=$to" else "")}catch(e:Exception){error="请填写有效营业日期，范围不超过60天"}}
 fun choose(a:String,row:JSONObject,c:JSONObject?=null){selected=row;action=a;cue=c;minutes=c?.textOrNull("trigger_offset_minutes")?:"";reason="";error=""}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("桌边体验计划",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.experiencePlansState);Row{FilterChip(!history,{history=false},label={Text("未结束")});FilterChip(history,{history=true},label={Text("按营业日")})};if(history){CustodyField("开始营业日 YYYY-MM-DD",from,10){from=it};CustodyField("结束营业日 YYYY-MM-DD",to,10){to=it}};SecondaryAction(onClick={query()},enabled=!m.busy){Text("查询 / 刷新")};if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
 val board=m.experiencePlansBoard
 if(board!=null&&m.experiencePlanRows.isEmpty())item{Text("当前权限和查询范围内没有体验计划。")}
 if(selected==null)items(m.experiencePlanRows,key={it.getString("id")}){row->Panel{
  Text("${row.getString("table_code")} · ${experiencePlanStates[row.getString("plan_state")]?:"待核对"}",style=MaterialTheme.typography.titleMedium);Text("${row.getString("business_date")} · ${row.getInt("party_size")}人");Text(row.getString("promise_summary"));if(row.textOrNull("activated_at")!=null)Text("激活：${row.getString("activated_at")}",style=MaterialTheme.typography.bodySmall)
  for(c in row.getJSONArray("cues").objects().sortedBy{it.getInt("sequence_no")}){
   HorizontalDivider();Text("${c.getInt("sequence_no")}. ${experienceActions[c.getString("action_kind")]?:"服务节点"} · ${experienceCueStates[c.getString("status")]?:"待核对"}");c.getJSONObject("action_payload").textOrNull("title")?.let{Text(it)};c.textOrNull("due_at")?.let{Text("计划时间：$it",style=MaterialTheme.typography.bodySmall)}
   if(m.canUseExperiencePlans&&row.getString("plan_state") in listOf("active","paused")&&c.getString("trigger_kind")=="elapsed"&&c.getString("status") in listOf("pending","ready")&&c.isNull("service_task_id"))TextButton(onClick={choose("reschedule",row,c)}){Text("调整此节点时间")}
  }
  if(m.canUseExperiencePlans&&row.getString("session_status") in listOf("open","closing")){Row{if(row.getString("plan_state")=="active"&&row.getJSONArray("tasks").objects().none{it.getString("status") in listOf("pending","acknowledged","in_progress")})TextButton(onClick={choose("pause",row)}){Text("暂停")};if(row.getString("plan_state")=="paused")TextButton(onClick={choose("resume",row)}){Text("恢复")};if(row.getString("plan_state") in listOf("active","paused"))TextButton(onClick={choose("cancel",row)}){Text("中止计划",color=MaterialTheme.colorScheme.error)}}}
 }}
 if(selected==null&&board?.next!=null)item{SecondaryAction(onClick={m.loadMoreExperiencePlans()},enabled=!m.busy){Text("加载更多计划")}}
 if(selected!=null&&board!=null)item{Panel{Text(when(action){"cancel"->"主管中止计划";"pause"->"暂停未派出计划";"resume"->"恢复计划";else->"调整未派出节点"},style=MaterialTheme.typography.titleMedium);Text("桌号：${selected!!.getString("table_code")}");if(action=="cancel")Text("请先确认现场服务已停止。此操作不会退款、撤单或删除已完成记录。");if(action=="reschedule")CustodyField("激活后分钟数 0—240",minutes,3){minutes=it};CustodyField("现场原因及处理结果",reason,500){reason=it};PrimaryAction(onClick={try{val combined=JSONObject(board.data.toString()).put("rows",org.json.JSONArray(m.experiencePlanRows));proposed=experiencePlanCommand(m.identity!!,ExperiencePlansBoard(combined),selected!!,action,reason,cue,if(action=="reschedule")minutes.toIntOrNull()else null);error=""}catch(e:Exception){error=e.message?:"请核对内容"}},enabled=m.canUseExperiencePlans){Text("核对操作")};TextButton(onClick={selected=null}){Text("返回")}}}
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认现场处理")},text={Text(c.steps[0].experiencePlanProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;selected=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
