package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val loyaltySupplementsRoot="/api/staff/native-loyalty-supplements"
val supplementStatusNames=mapOf("missing" to "原订单未入积分","mismatch" to "原账需核对","matched" to "原账已匹配","refund_review_required" to "先复核退款归属","requested" to "待独立审核","approved" to "已审核","rejected" to "已驳回","executed" to "已按原账补发","not_required" to "核对后无需补发")
class LoyaltySupplementsBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1;val rows=data.getJSONArray("items").objects()}
fun loyaltySupplementCommand(actor:StaffIdentity,action:String,row:JSONObject,reason:String):LiveCommand{
 require(action in setOf("request","approve","reject"));val permission=if(action=="request")"loyalty.accrual.request" else "loyalty.accrual.approve";require(actor.allows(permission));require(reason.trim().length in 2..500){"请填写2至500字核对依据"}
 if(action=="request")require(row.getString("status") in setOf("missing","mismatch")){"当前原订单无需补发，或须先核对退款"}
 else require(row.getString("status")=="requested"&&row.getString("requestedByEmployeeId")!=actor.employeeId){"须由其他有权限的员工审核待处理申请"}
 val publicId=row.getString(if(action=="request")"orderPublicId" else "publicId");val body=JSONObject().put("publicId",publicId).put("reason",reason.trim());val id=UUID.randomUUID().toString()
 val confirmation="${mapOf("request" to "提交漏积分复核","approve" to "同意原积分补发","reject" to "驳回原补发申请")[action]}\n订单 ${row.getString("orderPublicId")}\n会员 ${row.getString("memberNo")}\n依据：${reason.trim()}\n按原收退款与原规则核算，实际积分和成长值以执行后回读为准；不会手工指定奖励或执行收退款。"
 val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),permission,listOf(LiveStep("$loyaltySupplementsRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("loyaltySupplement",proof).toString())))
}
val LiveStep.loyaltySupplementProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("loyaltySupplement")}
fun validateLoyaltySupplementReply(text:String,step:LiveStep){
 val root=JSONObject(text);val proof=step.loyaltySupplementProof!!;val action=proof.getString("action");val body=JSONObject(step.body);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val data=root.getJSONObject("data");require(data.getString("action")==action&&data.getString("employeeId")==proof.getString("employeeId")&&data.getString("requestKey")==step.key&&data.getString("sourcePublicId")==body.getString("publicId"))
 val result=data.getJSONObject("result");require(Regex("^LSP-[a-f0-9-]{36}$").matches(result.getString("publicId")))
 if(action=="request")require(result.getString("status")=="requested"&&result.getInt("requestedPoints")>=0&&result.getInt("requestedGrowth")>=0)
 else {require(result.getString("publicId")==body.getString("publicId"));require(result.getString("status") in if(action=="reject")setOf("rejected") else setOf("executed","not_required"));require(result.getInt("pointsDelta")>=0&&result.getInt("growthDelta")>=0);if(result.getString("status") in setOf("rejected","not_required"))require(result.getInt("pointsDelta")==0&&result.getInt("growthDelta")==0)}
}
