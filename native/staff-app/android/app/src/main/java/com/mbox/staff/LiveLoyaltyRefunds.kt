package com.mbox.staff
import java.util.UUID
import java.math.BigDecimal
import org.json.JSONObject
import org.json.JSONArray
const val loyaltyRefundRoot="/api/staff/native-loyalty-refunds"
fun canReadLoyaltyRefunds(actor:StaffIdentity?)=actor?.allows("reconciliation.view")==true&&actor.allows("loyalty.accrual.exception.view")
fun canWriteLoyaltyRefunds(actor:StaffIdentity?,action:String)=actor?.allows("reconciliation.manage")==true&&actor.allows(if(action=="request")"loyalty.accrual.request" else "loyalty.accrual.approve")
fun loyaltyRefundMoney(minor:Long)="¥"+BigDecimal.valueOf(minor,2).toPlainString()
class LoyaltyRefundBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1;val rows=data.getJSONArray("items").objects()}
fun loyaltyRefundAllocations(row:JSONObject,values:Map<String,String>,prefix:String):JSONArray {
 val lines=JSONArray();var total=0L
 for(item in row.getJSONArray("items").objects()){
  val text=values[prefix+item.getString("orderItemId")].orEmpty();require(text.isNotBlank()){ "请逐项填写实际退回货款，未涉及填0" }
  val amount=ownerMoney(text);require(amount<=item.getLong("maxSalesReturnAmountMinor")){"${item.getString("productName")} 超过可分配原货款"}
  total=Math.addExact(total,amount);if(amount>0)lines.put(JSONObject().put("orderItemId",item.getString("orderItemId")).put("salesRefundAmountMinor",amount))
 }
 require(total==row.getLong("salesRefundAmountMinor")){"分配合计必须等于原货款退款 ${loyaltyRefundMoney(row.getLong("salesRefundAmountMinor"))}，不能包含溢收退款"};return lines
}
fun loyaltyRefundCommand(actor:StaffIdentity,action:String,body:JSONObject,refundId:String,confirmation:String):LiveCommand {
 require(action in setOf("request","decision")&&canWriteLoyaltyRefunds(actor,action)){"当前岗位没有财务与积分复核的双重权限"}
 UUID.fromString(refundId);require(body.getString("reason").trim().length in 3..1000);require(Regex("^[a-f0-9]{64}$").matches(body.getString("basisVersion")))
 if(action=="request")require(body.getString("refundId")==refundId) else UUID.fromString(body.getString("requestId"))
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("refundId",refundId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),if(action=="request")"loyalty.accrual.request" else "loyalty.accrual.approve",listOf(LiveStep("$loyaltyRefundRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("loyaltyRefund",proof).toString())))
}
val LiveStep.loyaltyRefundProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("loyaltyRefund")}
fun validateLoyaltyRefundReply(text:String,step:LiveStep){
 val root=JSONObject(text);val proof=step.loyaltyRefundProof!!;val body=JSONObject(step.body);val action=proof.getString("action");val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val data=root.getJSONObject("data");require(data.getString("action")==action&&data.getString("employeeId")==proof.getString("employeeId")&&data.getString("requestKey")==step.key)
 val r=data.getJSONObject("result");UUID.fromString(r.getString("requestId"));require(r.getString("refundId")==proof.getString("refundId"))
 require(r.getString("status")==if(action=="request")"requested" else if(body.getString("decision")=="approve")"approved" else "rejected")
 if(action=="decision")require(r.getString("requestId")==body.getString("requestId"))
 require(r.get("pointsDelta") is Number&&r.get("growthDelta") is Number)
 if(action=="request"||body.optString("decision")=="reject")require(r.getLong("pointsDelta")==0L&&r.getLong("growthDelta")==0L)
}
