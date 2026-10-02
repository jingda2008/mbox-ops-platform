package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val tableConfigRoot="/api/table-management/native-configuration"
class TableConfigurationBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getInt("protocol")==1&&data.getBoolean("durableCommands");val areas=data.getJSONArray("areas").objects();val tables=data.getJSONArray("tables").objects()}
val areaTypes=linkedMapOf("indoor" to "室内","outdoor" to "室外","bar" to "吧台","stage" to "舞台","vip" to "包间","other" to "其他")
val areaStates=linkedMapOf("active" to "使用中","paused" to "暂停","retired" to "停用")
val tableStates=linkedMapOf("available" to "可使用","paused" to "暂停","retired" to "停用")
fun tableConfigurationCommand(actor:StaffIdentity,board:TableConfigurationBoard,action:String,body:JSONObject,confirmation:String):LiveCommand{
 require(action in setOf("area-create","area-update","table-create","table-update"));require(board.enabled&&board.employee==actor.employeeId&&actor.allows("table.manage"))
 require(body.getString(if(action.startsWith("table"))"displayName" else "name").trim().length in 1..120){"名称须为1至120字"}
 require(body.getString("reason").trim().length in 2..500){"请填写2至500字修改原因"}
 if(action.startsWith("area"))require(body.getInt("sortOrder") in -100000..100000){"区域排序须为-100000至100000的整数"}
 if(action.startsWith("table")){
  require(body.getInt("capacity") in 1..200){"容量须为1至200人"};require(board.areas.any{it.getString("id")==body.getString("areaId")}){"请选择原门店区域"};if(!body.isNull("minimumSpendMinor"))require(body.getLong("minimumSpendMinor") in 0..100000000)
 }
 if(body.has("code"))require(Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$").matches(body.getString("code"))){"编号使用英文字母、数字、下划线或短横线"}
 if(action.endsWith("update")){
  val table=action.startsWith("table");val row=(if(table)board.tables else board.areas).find{it.getString("id")==body.getString(if(table)"tableId" else "areaId")}?:error("原配置不存在，请刷新")
  require(row.getString("updatedAt")==body.getString("expectedUpdatedAt")){"原版本已变化"}
  if(table)require(row.textOrNull("activeSessionId")==null){"营业中桌台请在原桌次结束后再改配置"}
  else if(body.getString("status")!="active")require(board.tables.none{it.getString("areaId")==row.getString("id")&&it.textOrNull("activeSessionId")!=null}){"区域内仍有营业中桌台"}
 }
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),"table.manage",listOf(LiveStep("$tableConfigRoot/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("tableConfiguration",proof).toString())))
}
val LiveStep.tableConfigurationProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("tableConfiguration")}
fun validateTableConfigurationReply(text:String,step:LiveStep){val root=JSONObject(text);val d=root.getJSONObject("data");val p=step.tableConfigurationProof!!;val b=JSONObject(step.body);val action=p.getString("action");val row=d.getJSONObject("result");require(root.getJSONObject("meta").getInt("protocol")==1&&root.getJSONObject("meta").get("replayed") is Boolean);require(d.getString("employeeId")==p.getString("employeeId")&&d.getString("action")==action&&d.getString("requestKey")==step.key);UUID.fromString(row.getString("id"));require(row.getString("status")==b.getString("status"));if(action.endsWith("update"))require(row.getString("id")==b.getString(if(action.startsWith("table"))"tableId" else "areaId"));if(b.has("code"))require(row.getString("code")==b.getString("code"));if(action.startsWith("table"))require(row.getInt("capacity")==b.getInt("capacity")&&row.getString("areaId")==b.getString("areaId"))}
