package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val memberCardsRoot="/api/staff/native-member-cards"
val memberCardPermissions=setOf("member.card.manage","member.card.review","loyalty.policy.publish")
val cardStateNames=mapOf("draft" to "草稿","open" to "开放申请","paused" to "暂停申请","closed" to "已关闭","pending" to "待审核","approved" to "已通过","rejected" to "已拒绝","active" to "有效","suspended" to "暂停使用","withdrawn" to "已退出","revoked" to "已撤销")
class MemberCardsBoard(val data:JSONObject){
 val employee=data.getString("employeeId");val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1
 val section=data.getString("section");val rows=data.getJSONArray("items").objects();val next=data.textOrNull("nextCursor")
}
fun memberCardPermission(action:String,body:JSONObject)=when{action=="review"->"member.card.review";action=="state"&&body.getString("state")=="open"->"loyalty.policy.publish";else->"member.card.manage"}
fun memberCardCommand(actor:StaffIdentity,action:String,body:JSONObject,confirmation:String):LiveCommand {
 require(action in setOf("create","state","review","holding","social","menu","menu-remove"))
 val permission=memberCardPermission(action,body);require(actor.allows(permission)){"当前岗位没有此项会员卡权限"}
 for(key in listOf("projectId","applicationId","cardId","productId"))if(body.has(key))UUID.fromString(body.getString(key))
 if(action in setOf("state","holding","social"))require(body.getString("expectedUpdatedAt").isNotBlank())
 if(action in setOf("state","review","holding"))require(body.getString("reason").trim().length in 2..300){"请填写2至300字实际原因"}
 if(action=="create"){
  require(Regex("^[A-Z][A-Z0-9_]{1,39}$").matches(body.getString("code"))){"编号须以大写字母开头，可含数字和下划线，2至40位"}
  require(body.getString("name").trim().length in 2..60&&body.getString("terms").trim().length in 2..6000)
  require(serverInstant(body.getString("availableUntil"))>serverInstant(body.getString("availableFrom"))){"结束时间必须晚于开始时间"}
  if(body.getString("kind")=="cobrand")require(body.textOrNull("cooperationReference")?.trim()?.length in 2..500){"联名卡必须记录合作依据"}
 }
 if(action in setOf("menu","menu-remove"))require(Regex("^[a-f0-9]{64}$").matches(body.getString("expectedMenu")))
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),permission,listOf(LiveStep("$memberCardsRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("memberCard",proof).toString())))
}
val LiveStep.memberCardProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("memberCard")}
fun validateMemberCardReply(text:String,step:LiveStep){
 val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val data=root.getJSONObject("data");val proof=step.memberCardProof!!;val body=JSONObject(step.body);val action=proof.getString("action")
 require(data.getString("employeeId")==proof.getString("employeeId")&&data.getString("requestKey")==step.key&&data.getString("action")==action)
 val result=data.getJSONObject("result")
 when(action){
  "create"->{UUID.fromString(result.getString("projectId"));require(result.getString("status")=="draft")}
  "state"->require(result.getString("projectId")==body.getString("projectId")&&result.getString("status")==body.getString("state"))
  "review"->{require(result.getString("applicationId")==body.getString("applicationId")&&result.getString("status")==if(body.getString("decision")=="approve")"approved" else "rejected");if(body.getString("decision")=="approve")UUID.fromString(result.getString("cardId"))}
  "holding"->require(result.getString("cardId")==body.getString("cardId")&&result.getString("status")==mapOf("suspend" to "suspended","resume" to "active","revoke" to "revoked")[body.getString("action")])
  "social"->require(result.getString("projectId")==body.getString("projectId")&&result.getBoolean("configured"))
  "menu","menu-remove"->require(result.getString("projectId")==body.getString("projectId")&&result.getString("productId")==body.getString("productId")&&result.getBoolean(if(action=="menu")"saved" else "removed"))
 }
}
