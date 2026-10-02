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
import org.json.JSONArray

@Composable
fun LivePerformanceView(m:AppModel,close:()->Unit) {
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};val scope=rememberCoroutineScope()
 var month by remember{mutableStateOf(java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).toString().take(7))};var section by remember{mutableStateOf("schedules")};var query by remember{mutableStateOf("")}
 var edit by remember{mutableStateOf<PerformanceEditor?>(null)};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var notice by remember{mutableStateOf("")};var impacts by remember{mutableStateOf<JSONObject?>(null)}
 LaunchedEffect(Unit){m.loadPerformances(month)}
 LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){impacts=null;edit=null;proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun propose(make:()->LiveCommand){try{proposed=make();notice=""}catch(e:Exception){notice=e.message?:"请核对场次与输入"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("演出与曲库",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(m.performanceState);if(notice.isNotBlank())Text(notice);LivePendingView(m)}
  item{CustodyField("月份 YYYY-MM",month,7){month=it};SecondaryAction(onClick={try{java.time.YearMonth.parse(month);m.loadPerformances(month);edit=null;impacts=null}catch(e:Exception){notice="请填写有效月份"}},enabled=!m.busy){Text("读取月排班")};AssignmentChoice("查看",section,listOf("schedules" to "排班与现场阶段","performers" to "演员与曲库","revisions" to "改期与预约影响")){section=it;edit=null};CustodyField("筛选艺名或场次",query,100){query=it}}
  val board=m.performanceBoard
  if(board!=null){val actor=m.identity!!
   edit?.let{item{key(it){PerformanceForm(m,board,it,{edit=null}){make->propose(make)}}}}
   when(section){
    "schedules"->{
     if(actor.allows("song.manage"))item{PrimaryAction(onClick={edit=PerformanceEditor("publish")},enabled=m.canUsePerformances){Text("新增单场或月度排班")}}
     for(phase in board.rows("phases"))item{Panel{Text("当前阶段：${phaseNames[phase.getString("phaseCode")]}",style=MaterialTheme.typography.titleMedium);Text("${phase.getString("performerStageName")} · ${assignmentTime(phase.getString("startedAt"))}");if(actor.allows("performance.phase.manage")){SecondaryAction(onClick={edit=PerformanceEditor("phase-end",phase)},enabled=m.canUsePerformances){Text("结束此阶段")};TextButton(onClick={edit=PerformanceEditor("phase-cancel",phase)},enabled=m.canUsePerformances){Text("取消误启动的阶段")}}}}
     for(row in board.rows("schedules").filter{it.toString().contains(query,true)})item{Panel{
      Text(row.getString("performerStageName"),style=MaterialTheme.typography.titleMedium);Text("${performanceLocal(row.getString("startsAt"))} — ${performanceLocal(row.getString("endsAt"))}");Text(showStatuses[row.getString("status")]?:"状态待核对")
      if(actor.allows("song.manage")&&row.getString("status") in listOf("scheduled","performing"))SecondaryAction(onClick={val target=if(row.getString("status")=="scheduled")"performing" else "completed";propose{performanceCommand(actor,"schedule-status",JSONObject().put("scheduleId",row.getString("id")).put("expected",row.getString("configurationFingerprint")).put("targetStatus",target),"${if(target=="performing")"开始" else "结束"}演出\n${row.getString("performerStageName")} · ${performanceLocal(row.getString("startsAt"))}")}},enabled=m.canUsePerformances&&(row.getString("status")=="scheduled"||board.rows("phases").none{it.getString("scheduleId")==row.getString("id")})){Text(if(row.getString("status")=="scheduled")"确认开始演出" else if(board.rows("phases").any{it.getString("scheduleId")==row.getString("id")})"请先结束现场阶段" else "确认结束演出")}
      if(actor.allows("performance.phase.manage")&&row.getString("status")=="performing")SecondaryAction(onClick={edit=PerformanceEditor("phase-start",row)},enabled=m.canUsePerformances&&board.rows("phases").isEmpty()){Text("启动现场阶段")}
      if(actor.allows("performance.schedule.revise")&&row.getString("status")=="scheduled")SecondaryAction(onClick={edit=PerformanceEditor("revision",row)},enabled=m.canUsePerformances){Text("改期、取消或替换场次")}
      if(actor.allows("song.manage")&&row.getString("status")=="scheduled")TextButton(onClick={edit=PerformanceEditor("schedule-sort",row)},enabled=m.canUsePerformances){Text("调整展示顺序")}
     }}
    }
    "performers"->{
     if(actor.allows("song.manage"))item{PrimaryAction(onClick={edit=PerformanceEditor("performer-create")},enabled=m.canUsePerformances){Text("新增演员")}}
     for(row in board.rows("performers").filter{it.toString().contains(query,true)})item{Panel{Text(row.getString("stageName"),style=MaterialTheme.typography.titleMedium);Text("${row.getString("code")} · ${if(row.getString("status")=="active")"启用" else "停用"}");if(actor.allows("song.manage"))SecondaryAction(onClick={edit=PerformanceEditor("performer-update",row)},enabled=m.canUsePerformances){Text("编辑艺名、风格与状态")};if(actor.allows("song.view")||actor.allows("song.manage"))SecondaryAction(onClick={edit=PerformanceEditor("songs",row)},enabled=!m.busy){Text("查看与管理曲库")}}}
    }
    "revisions"->{
     item{Text("演出调整会保留原场次与受影响预约；顾客是否接受变更，必须以原预约的确认状态为准。")}
     for(row in board.rows("revisions"))item{Panel{Text("${mapOf("rescheduled" to "改期","cancelled" to "取消","replaced" to "换场")[row.getString("kind")]} · 第${row.getInt("revisionNumber")}次修订");Text(row.getString("reason"));Text(assignmentTime(row.getString("createdAt")));if(actor.allows("reservation.view"))SecondaryAction(onClick={scope.launch{try{impacts=m.readPerformanceExtra("/revisions/${LiveCommand.part(row.getString("publicId"))}/impacts")}catch(e:Exception){notice=e.message?:"预约影响读取失败"}}},enabled=!m.busy){Text("查看受影响预约")}}}
     impacts?.let{item{Panel{Text("受影响预约",style=MaterialTheme.typography.titleMedium);if(it.getJSONArray("impacts").length()==0)Text("此修订没有关联预约");for(impact in it.getJSONArray("impacts").objects()){Text("${impact.getString("reservationPublicId")} · ${assignmentTime(impact.getString("arrivalAt"))}");val acknowledgement=impact.optJSONObject("acknowledgement")?.let{ack->mapOf("keep" to "保留选择","reselect" to "已重新选场","clear" to "取消演出偏好")[ack.getString("decision")]} ?: "等待顾客确认";Text("预约状态 ${impact.getString("reservationStatus")} · $acknowledgement")}}}}
    }
   }
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("核对演出操作")},text={Text(command.steps[0].performanceProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;edit=null;m.executeLive(command)},enabled=m.canUsePerformances){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
data class PerformanceEditor(val action:String,val row:JSONObject?=null)
