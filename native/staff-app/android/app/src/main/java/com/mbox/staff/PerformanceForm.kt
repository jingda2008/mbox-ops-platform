package com.mbox.staff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray

@Composable
fun PerformanceForm(m:AppModel,board:PerformanceBoard,edit:PerformanceEditor,close:()->Unit,propose:(()->LiveCommand)->Unit) {
 val action=edit.action;val row=edit.row;val scope=rememberCoroutineScope()
 var reason by remember{mutableStateOf("")};var start by remember{mutableStateOf(row?.textOrNull("startsAt")?.let(::performanceLocal) ?: board.data.getString("month")+"-01 20:00")};var end by remember{mutableStateOf(row?.textOrNull("endsAt")?.let(::performanceLocal) ?: board.data.getString("month")+"-01 22:00")}
 var replacementMonth by remember{mutableStateOf(board.data.getString("month"))};var replacements by remember{mutableStateOf(board.rows("schedules"))}
 var kind by remember{mutableStateOf("rescheduled")};var replacement by remember{mutableStateOf("")};var phase by remember{mutableStateOf("band_live")};var sort by remember{mutableStateOf(row?.optInt("sortOrder")?.toString() ?: "0")}
 var name by remember{mutableStateOf(row?.textOrNull("stageName").orEmpty())};var code by remember{mutableStateOf("")};var status by remember{mutableStateOf(row?.textOrNull("status") ?: "active")};var genres by remember{mutableStateOf(row?.optJSONObject("profileSnapshot")?.optJSONArray("genres")?.let{(0 until it.length()).joinToString("，"){i->it.getString(i)}}.orEmpty())}
 var performer by remember{mutableStateOf("")};var slots by remember{mutableStateOf(emptyList<JSONObject>())};var preview by remember{mutableStateOf<JSONObject?>(null)};var previewInput by remember{mutableStateOf("")};var notice by remember{mutableStateOf("")}
 if(action=="songs"){PerformanceSongs(m,row!!,close,propose);return}
 Panel {
  Text(when(action){"publish"->"编排演出";"revision"->"修订原场次";"phase-start"->"启动现场阶段";"phase-end"->"结束现场阶段";"phase-cancel"->"取消现场阶段";"performer-create"->"新增演员";"performer-update"->"编辑演员";else->"展示顺序"},style=MaterialTheme.typography.titleLarge)
  if(notice.isNotBlank())Text(notice)
  when(action){
   "publish"->{
    Text("发布月份：${board.data.getString("month")}；时间均为上海时间，可逐场添加，最多155场。")
    AssignmentChoice("演员",performer,board.rows("performers").filter{it.getString("status")=="active"}.map{it.getString("id") to it.getString("stageName")}){performer=it}
    CustodyField("开始 YYYY-MM-DD HH:mm",start,16){start=it};CustodyField("结束 YYYY-MM-DD HH:mm",end,16){end=it}
    SecondaryAction(onClick={try{require(slots.size<155);val selected=board.rows("performers").first{it.getString("id")==performer};val slot=JSONObject().put("performerId",performer).put("startsAt",performanceTime(start)).put("endsAt",performanceTime(end));require(serverInstant(slot.getString("endsAt"))>serverInstant(slot.getString("startsAt")));slots=slots+slot;preview=null;notice="已加入 ${selected.getString("stageName")}"}catch(e:Exception){notice="请选择演员并填写正确起止时间"}},enabled=!m.busy){Text("加入本次发布清单")}
    for((i,slot)in slots.withIndex()){Text("${i+1}. ${board.rows("performers").find{it.getString("id")==slot.getString("performerId")}?.getString("stageName")} · ${performanceLocal(slot.getString("startsAt"))} — ${performanceLocal(slot.getString("endsAt"))}");TextButton(onClick={slots=slots.filterIndexed{index,_->index!=i};preview=null},enabled=!m.busy){Text("移除第${i+1}场")}}
    val payload=JSONObject().put("month",board.data.getString("month")).put("slots",JSONArray(slots)).toString()
    SecondaryAction(onClick={val original=payload;scope.launch{try{preview=m.previewPerformances(JSONObject(original));previewInput=original;notice="已按服务器现有排班核对"}catch(e:Exception){preview=null;notice=e.message?:"预检失败"}}},enabled=!m.busy&&slots.isNotEmpty()){Text("预检重叠与演员状态")}
    preview?.getJSONArray("slots")?.objects()?.forEach{slot->Text("${slot.getString("performerName")} · ${performanceLocal(slot.getString("startsAt"))} · ${if(slot.getJSONArray("reasons").length()>0)(0 until slot.getJSONArray("reasons").length()).joinToString("；"){slot.getJSONArray("reasons").getString(it)} else if(slot.textOrNull("existingId")!=null)"已存在，将保留原场" else "可新增"}")}
    PrimaryAction(onClick={propose{require(previewInput==payload);require(preview!!.getJSONArray("slots").objects().all{it.getJSONArray("reasons").length()==0});val details=preview!!.getJSONArray("slots").objects().joinToString("\n"){"${it.getString("performerName")} · ${performanceLocal(it.getString("startsAt"))} — ${performanceLocal(it.getString("endsAt"))}"};performanceCommand(m.identity!!,"publish",JSONObject(payload),"发布${board.data.getString("month")}演出排班\n$details\n已有完全相同场次保留原记录；不取消其他排班。")}},enabled=m.canUsePerformances&&preview!=null&&previewInput==payload&&preview!!.getJSONArray("slots").objects().all{it.getJSONArray("reasons").length()==0}){Text("核对并发布清单")}
   }
   "revision"->{Text("原场：${row!!.getString("performerStageName")} · ${performanceLocal(row.getString("startsAt"))}");AssignmentChoice("调整类型",kind,listOf("rescheduled" to "改期","cancelled" to "取消","replaced" to "替换为已有场次")){kind=it};if(kind=="rescheduled"){CustodyField("新开始 YYYY-MM-DD HH:mm",start,16){start=it};CustodyField("新结束 YYYY-MM-DD HH:mm",end,16){end=it}};if(kind=="replaced"){CustodyField("替代场次月份 YYYY-MM",replacementMonth,7){replacementMonth=it};SecondaryAction(onClick={scope.launch{try{java.time.YearMonth.parse(replacementMonth);replacements=m.readPerformanceExtra("?month=$replacementMonth").getJSONArray("schedules").objects();replacement=""}catch(e:Exception){notice=e.message?:"替代排班读取失败"}}},enabled=!m.busy){Text("读取替代月份")};AssignmentChoice("替代场次",replacement,replacements.filter{it.getString("id")!=row.getString("id")&&it.getString("status")=="scheduled"}.map{it.getString("id") to "${it.getString("performerStageName")} · ${performanceLocal(it.getString("startsAt"))}"}){replacement=it}};Text("原预约不会被当作自动接受新场次，提交后请查看预约影响。")}
   "phase-start"->AssignmentChoice("现场阶段",phase,phaseNames.toList()){phase=it}
   "schedule-sort"->CustodyField("展示顺序（0至100000）",sort,6){sort=it}
   "performer-create","performer-update"->{if(action=="performer-create")CustodyField("演员编码（大写字母、数字、下划线）",code,64){code=it};CustodyField("艺名",name,120){name=it};CustodyField("风格标签，用逗号分隔",genres,1000){genres=it};AssignmentChoice("状态",status,listOf("active" to "启用","inactive" to "停用")){status=it}}
  }
  if(action=="revision"||action.startsWith("phase-"))CustodyField("操作原因（2至240字）",reason,240){reason=it}
  if(action!="publish")PrimaryAction(onClick={propose {
   val body=JSONObject();var summary=""
   when(action){
    "revision"->{require(reason.trim().length>=2);if(kind=="replaced")require(replacement.isNotBlank());val from=if(kind=="rescheduled")performanceTime(start) else null;val to=if(kind=="rescheduled")performanceTime(end) else null;if(from!=null)require(serverInstant(to!!)>serverInstant(from));body.put("scheduleId",row!!.getString("id")).put("expected",row.getString("configurationFingerprint")).put("kind",kind).put("startsAt",from ?: JSONObject.NULL).put("endsAt",to ?: JSONObject.NULL).put("replacementScheduleId",if(kind=="replaced")replacement else JSONObject.NULL).put("replacementExpected",if(kind=="replaced")replacements.first{it.getString("id")==replacement}.getString("configurationFingerprint") else JSONObject.NULL).put("reason",reason.trim());summary="修订演出：${mapOf("rescheduled" to "改期","cancelled" to "取消","replaced" to "换场")[kind]}\n${row.getString("performerStageName")} · 原定 ${performanceLocal(row.getString("startsAt"))}\n${if(kind=="rescheduled")"新时间 $start — $end" else if(kind=="replaced")replacements.first{it.getString("id")==replacement}.let{"替代 ${it.getString("performerStageName")} · ${performanceLocal(it.getString("startsAt"))}"} else "取消原场次"}\n原因：$reason\n提交后请到修订记录核对受影响预约。"}
    "phase-start"->{require(reason.trim().length>=2);body.put("scheduleId",row!!.getString("id")).put("expected",row.getString("configurationFingerprint")).put("phaseCode",phase).put("reason",reason.trim());summary="启动现场阶段\n${row.getString("performerStageName")} · ${phaseNames[phase]}\n原因：$reason"}
    "phase-end","phase-cancel"->{require(reason.trim().length>=2);body.put("publicId",row!!.getString("publicId")).put("reason",reason.trim());summary="${if(action=="phase-end")"结束" else "取消"}现场阶段\n${row.getString("performerStageName")} · ${phaseNames[row.getString("phaseCode")]}\n原因：$reason"}
    "schedule-sort"->{require(sort.toInt() in 0..100000);body.put("scheduleId",row!!.getString("id")).put("expected",row.getString("configurationFingerprint")).put("sortOrder",sort.toInt());summary="调整演出展示顺序\n${row.getString("performerStageName")} · 顺序 $sort"}
    "performer-create","performer-update"->{require(name.isNotBlank());val profile=JSONObject(row?.optJSONObject("profileSnapshot")?.toString() ?: "{}").put("genres",JSONArray(genres.split(',','，').map{it.trim()}.filter{it.isNotBlank()}));body.put("stageName",name.trim()).put("status",status).put("profileSnapshot",profile);if(row==null)body.put("code",code.trim()) else body.put("performerId",row.getString("id")).put("expected",row.getString("configurationFingerprint"));summary="保存演员资料\n艺名 $name · ${if(status=="active")"启用" else "停用"}\n风格 $genres"}
   };performanceCommand(m.identity!!,action,body,summary)
  }},enabled=m.canUsePerformances){Text("核对并提交")}
  TextButton(onClick=close){Text("关闭编辑")}
 }
}
