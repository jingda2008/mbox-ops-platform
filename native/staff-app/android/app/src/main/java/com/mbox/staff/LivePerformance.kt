package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray
import java.time.*
const val performanceRoot="/api/staff/native-performances"
val performancePermissions=setOf("song.view","song.manage","performance.phase.manage","performance.schedule.revise")
val showStatuses=mapOf("scheduled" to "待演出","performing" to "演出中","completed" to "已结束","cancelled" to "已取消")
val phaseNames=linkedMapOf("before_show" to "开场前","acoustic" to "不插电","band_live" to "乐队现场","intermission" to "中场休息","after_show" to "演出后")
class PerformanceBoard(val data:JSONObject) {
    val employee=data.getString("employeeId")
    val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1
    fun rows(key:String)=data.getJSONArray(key).objects()
}
fun performanceTime(value:String):String = LocalDateTime.parse(value.trim().replace(' ','T')).atZone(ZoneId.of("Asia/Shanghai")).toInstant().toString()
fun performanceLocal(value:String):String = serverInstant(value).atZone(ZoneId.of("Asia/Shanghai")).toLocalDateTime().toString().take(16).replace('T',' ')
fun performancePermission(action:String)=when {action=="revision"->"performance.schedule.revise";action.startsWith("phase-")->"performance.phase.manage";else->"song.manage"}
fun performanceCommand(actor:StaffIdentity,action:String,body:JSONObject,confirmation:String):LiveCommand {
    require(action in setOf("publish","schedule-status","schedule-sort","revision","phase-start","phase-end","phase-cancel","performer-create","performer-update","songs-import","song-update"))
    val permission=performancePermission(action);require(actor.allows(permission)){"没有此项演出操作权限"}
    if(body.has("scheduleId"))UUID.fromString(body.getString("scheduleId"))
    if(action in setOf("schedule-status","schedule-sort","revision","phase-start","performer-update","songs-import","song-update"))require(Regex("^[a-f0-9]{64}$").matches(body.getString("expected")))
    if(action=="publish") {val slots=body.getJSONArray("slots").objects();require(slots.size in 1..155);for(slot in slots){val start=serverInstant(slot.getString("startsAt"));val end=serverInstant(slot.getString("endsAt"));require(end>start&&Duration.between(start,end).toMillis()<=86400000);require(start.atZone(ZoneId.of("Asia/Shanghai")).toLocalDate().toString().startsWith(body.getString("month")))}}
    val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
    return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),permission,listOf(LiveStep("$performanceRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("performance",proof).toString())))
}
val LiveStep.performanceProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("performance")}
fun validatePerformanceReply(text:String,step:LiveStep):JSONObject {
    val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
    val data=root.getJSONObject("data");val p=step.performanceProof!!;val action=p.getString("action");val body=JSONObject(step.body)
    require(data.getString("action")==action&&data.getString("employeeId")==p.getString("employeeId")&&data.getString("requestKey")==step.key)
    val r=data.getJSONObject("result")
    when(action){
        "publish"->{require(r.getString("month")==body.getString("month"));val ids=r.getJSONArray("scheduleIds");require(ids.length()==body.getJSONArray("slots").length()&&r.getInt("createdCount")+r.getInt("existingCount")==ids.length());for(i in 0 until ids.length())UUID.fromString(ids.getString(i))}
        "schedule-status"->{require(r.getString("id")==body.getString("scheduleId")&&r.getString("status")==body.getString("targetStatus"))}
        "schedule-sort"->{require(r.getString("id")==body.getString("scheduleId")&&r.getInt("sortOrder")==body.getInt("sortOrder"))}
        "revision"->{require(r.getString("scheduleId")==body.getString("scheduleId")&&r.getString("kind")==body.getString("kind")&&r.getString("createdByEmployeeId")==p.getString("employeeId")&&r.getInt("revisionNumber")>0&&r.getInt("affectedReservations")>=0)}
        "phase-start"->require(r.getString("scheduleId")==body.getString("scheduleId")&&r.getString("phaseCode")==body.getString("phaseCode")&&r.getString("status")=="active")
        "phase-end","phase-cancel"->require(r.getString("publicId")==body.getString("publicId")&&r.getString("status")==if(action=="phase-end")"ended" else "cancelled")
        "performer-create","performer-update"->{UUID.fromString(r.getString("id"));if(body.has("performerId"))require(r.getString("id")==body.getString("performerId"));require(r.getString("stageName")==body.getString("stageName")&&r.getString("status")==body.getString("status"))}
        "songs-import"->require(r.getString("performerId")==body.getString("performerId")&&r.getString("mode")==body.getString("mode")&&r.getInt("importedCount")==body.getJSONArray("songs").length()&&r.getInt("rejectedCount")==0)
        "song-update"->require(r.getString("id")==body.getString("songId")&&r.getString("title")==body.getJSONObject("changes").getString("title")&&r.getString("status")==body.getJSONObject("changes").getString("status"))
    };return r
}
fun parseNativeSongRows(text:String):JSONArray {
    val rows=text.lineSequence().map{it.trim()}.filter{it.isNotBlank()}.toList();require(rows.size<=5000){"每次最多5000首"}
    val songs=JSONArray();val seen=mutableSetOf<String>()
    for((index,row)in rows.withIndex()) {val columns=row.split('|');require(columns.size in 1..3){"第${index+1}行格式不正确"};val code=if(columns.size==1)"" else columns[0].trim();val title=if(columns.size==1)columns[0].trim() else columns[1].trim();require(title.isNotBlank()&&title.length<=240&&code.length<=64){"第${index+1}行歌名或编号不正确"};val key=if(code.isBlank())title.lowercase() else code.lowercase();require(seen.add(key)){"第${index+1}行编号或歌名重复"};val aliases=columns.getOrNull(2).orEmpty().split(',','，').map{it.trim()}.filter{it.isNotBlank()};require(aliases.size<=100&&aliases.all{it.length<=240});songs.put(JSONObject().put("code",code.takeIf{it.isNotBlank()} ?: JSONObject.NULL).put("title",title).put("aliases",JSONArray(aliases)).put("status","active"))};return songs
}
