package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
fun staffCredentialTime(value:String):String=java.time.OffsetDateTime.parse(value.trim()).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
const val staffAdminRoot="/api/staff/native-administration"
class StaffAdministrationBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getInt("protocol")==1&&data.getBoolean("durableCommands");val overview=data.getJSONObject("overview");val version=overview.getString("configurationVersion");val employees=overview.getJSONArray("employees").objects();val roles=overview.getJSONArray("roles").objects()}
fun staffAdministrationCommand(actor:StaffIdentity,board:StaffAdministrationBoard,action:String,body:JSONObject,confirmation:String):LiveCommand{
 require(board.enabled&&board.employee==actor.employeeId&&actor.allows("staff.access.configure"));require(action in setOf("create","status","pin","credential","deploy"));require(body.getString("reason").trim().length in 2..200){"请填写2至200字原因"}
 if(action in setOf("pin","create"))require(Regex("^\\d{4}$").matches(body.getString("pin"))){"PIN须为4位数字"}
 if(action in setOf("status","pin"))require(board.employees.any{it.getString("id")==body.getString("employeeId")}){"原员工不存在，请刷新"}
 if(action=="create"){require(Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").matches(body.getString("employeeCode"))){"账号使用字母、数字、下划线或短横线"};require(body.getString("displayName").trim().length in 1..64);require(board.roles.any{it.getString("id")==body.getString("roleId")&&it.getString("status")=="active"}){"请选择启用岗位"}}
 if(action=="credential"){require(body.getString("credential").length in 6..128){"门店口令须为6至128位"};require(serverInstant(body.getString("validUntil"))>serverInstant(body.getString("validFrom"))){"结束时间须晚于开始时间"};body.put("credentialVersion",board.data.getString("credentialVersion"))}
 if(action=="deploy")require(body.getJSONArray("changes").length() in 1..100){"每次发布1至100项修改"}
 body.put("expectedVersion",board.version);val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,"人员与权限：$confirmation".lineSequence().first(),"staff.access.configure",listOf(LiveStep("$staffAdminRoot/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("staffAdministration",proof).toString())))
}
val LiveStep.staffAdministrationProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("staffAdministration")}
fun secureStaffAdministrationCommand(command:LiveCommand,store:(String,String)->Unit):LiveCommand{
 val step=command.steps.firstOrNull()?:return command;val p=step.staffAdministrationProof?:return command;require(command.steps.size==1);if(p.has("payloadKey"))return command
 store(command.id,step.body);p.remove("confirmation");return command.copy(title="待核对人员与权限原请求",steps=listOf(step.copy(body="{}",recoveryBody=JSONObject().put("staffAdministration",p.put("payloadKey",command.id)).toString())))
}
fun validateStaffAdministrationReply(text:String,step:LiveStep,body:JSONObject){val root=JSONObject(text);val d=root.getJSONObject("data");val p=step.staffAdministrationProof!!;val action=p.getString("action");val r=d.getJSONObject("result");require(root.getJSONObject("meta").getInt("protocol")==1&&root.getJSONObject("meta").get("replayed") is Boolean);require(d.getString("employeeId")==p.getString("employeeId")&&d.getString("action")==action&&d.getString("requestKey")==step.key)
 when(action){"create"->UUID.fromString(r.getString("employeeId"));"status"->{require(r.getString("employeeId")==body.getString("employeeId")&&r.getString("status")==body.getString("status"))};"pin"->{require(r.getString("employeeId")==body.getString("employeeId")&&r.getBoolean("pinConfigured")&&r.getInt("revokedSessionCount")>=0)};"credential"->{UUID.fromString(r.getString("credentialId"));require(serverInstant(r.getString("validFrom"))==serverInstant(body.getString("validFrom"))&&serverInstant(r.getString("validUntil"))==serverInstant(body.getString("validUntil")))};"deploy"->require(r.getString("status")=="verified"&&r.getJSONArray("changes").length()==body.getJSONArray("changes").length())}
}

fun LiveCommand.isStaffPermissionReceiptRecovery():Boolean=steps.size==1&&steps[0].staffAdministrationProof?.optString("action")=="deploy"
