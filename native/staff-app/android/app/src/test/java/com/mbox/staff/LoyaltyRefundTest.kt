package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class LoyaltyRefundTest {
 private fun actor()=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("reconciliation.view","reconciliation.manage","loyalty.accrual.exception.view","loyalty.accrual.request","loyalty.accrual.approve"),emptySet())
 @Test fun allocationMustMatchActualGoodsAndNeverIncludeExcess(){
  val id=UUID.randomUUID().toString();val row=JSONObject().put("salesRefundAmountMinor",3000).put("excessAmountMinor",5000).put("items",JSONArray().put(JSONObject().put("orderItemId",id).put("productName","原商品").put("maxSalesReturnAmountMinor",6000)))
  assertEquals(3000,loyaltyRefundAllocations(row,mapOf(id to "30"),"").getJSONObject(0).getInt("salesRefundAmountMinor"))
  assertThrows(IllegalArgumentException::class.java){loyaltyRefundAllocations(row,mapOf(id to "80"),"")};assertThrows(IllegalArgumentException::class.java){loyaltyRefundAllocations(row,emptyMap(),"")};assertThrows(IllegalArgumentException::class.java){loyaltyRefundAllocations(row,mapOf(id to "20"),"")}
 }
 @Test fun approvalReceiptCannotChangeRefundAndDualPermissionsApply(){
  val refund=UUID.randomUUID().toString();val body=JSONObject().put("requestId",UUID.randomUUID().toString()).put("basisVersion","a".repeat(64)).put("decision","approve").put("reason","独立核对实际商品")
  val command=loyaltyRefundCommand(actor(),"decision",body,refund,"复核申请");assertEquals(command,LiveCommand.parse(command.json()))
  val result=JSONObject().put("requestId",body.getString("requestId")).put("refundId",refund).put("status","approved").put("pointsDelta",-30).put("growthDelta",-30)
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action","decision").put("employeeId","e").put("requestKey",command.steps[0].key).put("result",result))
  validateLoyaltyRefundReply(reply.toString(),command.steps[0]);result.put("refundId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateLoyaltyRefundReply(reply.toString(),command.steps[0])}
  assertThrows(IllegalArgumentException::class.java){loyaltyRefundCommand(actor().copy(denied=setOf("reconciliation.manage")),"decision",body,refund,"越权")}
 }

 private fun reply(action:String,decision:String="approve"):Pair<LiveStep,JSONObject>{
  val refund=UUID.randomUUID().toString();val request=UUID.randomUUID().toString()
  val body=JSONObject().put("basisVersion","a".repeat(64)).put("reason","独立核对实际商品")
  if(action=="request")body.put("refundId",refund)else body.put("requestId",request).put("decision",decision)
  val step=loyaltyRefundCommand(actor(),action,body,refund,"核对退款原账").steps.single()
  val result=JSONObject().put("requestId",request).put("refundId",refund).put("status",if(action=="request")"requested"else if(decision=="approve")"approved"else "rejected").put("pointsDelta",0).put("growthDelta",0)
  return step to JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action",action).put("employeeId","e").put("requestKey",step.key).put("result",result))
 }

 @Test fun independentRefundApprovalOnlyAllowsNonpositiveExactDeltas(){
  val(step,response)=reply("decision");val result=response.getJSONObject("data").getJSONObject("result")
  for((points,growth)in listOf(-30 to -50,-30 to 0,0 to -50,0 to 0)){
   result.put("pointsDelta",points).put("growthDelta",growth)
   validateLoyaltyRefundReply(response.toString(),step)
  }
  for(field in listOf("pointsDelta","growthDelta")){
   result.put("pointsDelta",0).put("growthDelta",0).put(field,1)
   assertThrows(IllegalArgumentException::class.java){validateLoyaltyRefundReply(response.toString(),step)}
  }
 }

 @Test fun independentRefundRequestAndRejectionRequireZeroWithoutCoercingFractions(){
  for((action,decision)in listOf("request" to "approve","decision" to "reject")){
   val(step,response)=reply(action,decision);val result=response.getJSONObject("data").getJSONObject("result")
   validateLoyaltyRefundReply(response.toString(),step)
   for(field in listOf("pointsDelta","growthDelta"))for(value in listOf<Any>(-1,1,-0.5,0.5,"0",JSONObject.NULL,true)){
    result.put("pointsDelta",0).put("growthDelta",0).put(field,value)
    assertThrows(IllegalArgumentException::class.java){validateLoyaltyRefundReply(response.toString(),step)}
   }
  }
 }

 @Test fun independentRefundCannotAcknowledgeUnsafeOrMissingDelta(){
  for(field in listOf("pointsDelta","growthDelta")){
   val(step,response)=reply("decision");val result=response.getJSONObject("data").getJSONObject("result")
   for(value in listOf<Any>(-9007199254740992L,-0.5,"-30",JSONObject.NULL,true)){
    result.put(field,value)
    assertThrows(IllegalArgumentException::class.java){validateLoyaltyRefundReply(response.toString(),step)}
   }
   result.remove(field)
   assertThrows(org.json.JSONException::class.java){validateLoyaltyRefundReply(response.toString(),step)}
  }
 }
}
