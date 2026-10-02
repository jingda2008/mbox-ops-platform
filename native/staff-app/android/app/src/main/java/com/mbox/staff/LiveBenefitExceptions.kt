package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val benefitExceptionsRoot="/api/staff/native-benefit-exceptions"
val benefitExceptionActions=mapOf("retry" to "重试原礼遇出品","cancel_release" to "取消并释放占用","external_compensation" to "登记已有线下补偿")
class BenefitExceptionsBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1;val rows=data.getJSONArray("items").objects()}
fun benefitExceptionCommand(actor:StaffIdentity,action:String,row:JSONObject,reason:String,reference:String):LiveCommand{
 require(actor.allows("loyalty.redemption.exception")&&benefitExceptionActions.containsKey(action));require(reason.trim().length in 2..500){"请填写实际处理依据"};require(row.getString("status") in if(action=="retry")listOf("failed","retry") else listOf("failed")){"自动重试尚未停止，只能核对原出品状态"}
 if(action=="external_compensation")require(reference.trim().length in 2..200){"请填写已经完成的线下补偿凭证"}
 val expected=JSONObject();for(key in listOf("orderId","benefitId","tableSessionId")){UUID.fromString(row.getString(key));expected.put(key,row.getString(key))};expected.put("updatedAt",row.getString("updatedAt")).put("attemptCount",row.getInt("attemptCount"))
 val body=JSONObject().put("intentId",row.getString("id")).put("expected",expected).put("reason",reason.trim()).put("compensationReference",if(action=="external_compensation")reference.trim() else JSONObject.NULL)
 val id=UUID.randomUUID().toString();val confirmation="${benefitExceptionActions[action]}\n${row.getString("tableCode")}桌 · ${row.getString("orderPublicId")}\n${row.textOrNull("title")?:"原礼遇"}\n依据：${reason.trim()}"+if(action=="external_compensation")"\n原补偿凭证：${reference.trim()}\n只记录已有补偿，不自动支付、发券或加积分。" else if(action=="cancel_release")"\n取消原零元礼遇出品并释放未消耗占用，不自动恢复已使用权益。" else "\n仅重试原履约任务，不新发一份礼遇。"
 val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,benefitExceptionActions[action]!!,"loyalty.redemption.exception",listOf(LiveStep("$benefitExceptionsRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("benefitException",proof).toString())))
}
val LiveStep.benefitExceptionProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("benefitException")}
fun validateBenefitExceptionReply(text:String,step:LiveStep){
 val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val proof=step.benefitExceptionProof!!;val body=JSONObject(step.body);val expected=body.getJSONObject("expected");val action=proof.getString("action");val data=root.getJSONObject("data")
 require(data.getString("action")==action&&data.getString("employeeId")==proof.getString("employeeId")&&data.getString("requestKey")==step.key)
 val r=data.getJSONObject("result");require(r.getString("intentId")==body.getString("intentId")&&r.getString("orderId")==expected.getString("orderId")&&r.getString("benefitId")==expected.getString("benefitId"));require(r.getString("status")==mapOf("retry" to "pending","cancel_release" to "cancelled","external_compensation" to "compensated")[action])
 if(action!="retry"){
  require(r.getString("action")==action&&r.getString("resolvedByEmployeeId")==proof.getString("employeeId")&&r.getString("reason")==body.getString("reason"));require(r.textOrNull("compensationReference")==body.textOrNull("compensationReference"))
  for(key in listOf("releasedInventoryReservationCount","releasedCapacityReservationCount","cancelledKdsTaskCount","cancelledOrderItemCount"))require(r.getInt(key)>=0)
 }
}
