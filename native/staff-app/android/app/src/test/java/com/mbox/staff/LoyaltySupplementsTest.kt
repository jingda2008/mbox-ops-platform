package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.util.UUID
class LoyaltySupplementsTest{
 private val actor=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("loyalty.accrual.request","loyalty.accrual.approve"),emptySet())
 @Test fun noSelfApprovalAndNoArbitraryAmounts(){
  val row=JSONObject().put("publicId","LSP-"+UUID.randomUUID()).put("orderPublicId","ORDER-123").put("memberNo","MEMBER-123").put("status","requested").put("requestedByEmployeeId","e")
  assertThrows(IllegalArgumentException::class.java){loyaltySupplementCommand(actor,"approve",row,"原款核对通过")}
  row.put("requestedByEmployeeId","another");val command=loyaltySupplementCommand(actor,"approve",row,"原款核对通过");assertEquals(command,LiveCommand.parse(command.json()));assertEquals(setOf("publicId","reason"),JSONObject(command.steps[0].body).keys().asSequence().toSet())
  val result=JSONObject().put("publicId",row.getString("publicId")).put("status","executed").put("pointsDelta",20).put("growthDelta",20)
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action","approve").put("employeeId","e").put("requestKey",command.steps[0].key).put("sourcePublicId",row.getString("publicId")).put("result",result))
  validateLoyaltySupplementReply(reply.toString(),command.steps[0]);result.put("publicId","LSP-"+UUID.randomUUID());assertThrows(IllegalArgumentException::class.java){validateLoyaltySupplementReply(reply.toString(),command.steps[0])}
 }

 private fun decisionReply(action:String,status:String,points:Any,growth:Any):Pair<LiveStep,JSONObject>{
  val row=JSONObject().put("publicId","LSP-"+UUID.randomUUID()).put("orderPublicId","ORDER-123").put("memberNo","MEMBER-123").put("status","requested").put("requestedByEmployeeId","another")
  val step=loyaltySupplementCommand(actor,action,row,"原收退款核对通过").steps.single()
  val result=JSONObject().put("publicId",row.getString("publicId")).put("status",status).put("pointsDelta",points).put("growthDelta",growth)
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",false)).put("data",JSONObject().put("action",action).put("employeeId",actor.employeeId).put("requestKey",step.key).put("sourcePublicId",row.getString("publicId")).put("result",result))
  return step to reply
 }

 @Test fun approvedSupplementAcknowledgesFinalSignedAccountDeltaAfterHistoricalRefunds(){
  for(status in listOf("executed","not_required"))for((points,growth)in listOf(-30 to -50,-30 to 0,0 to -50,20 to -50,-30 to 20,0 to 0,20 to 30)){
   val(step,reply)=decisionReply("approve",status,points,growth)
   validateLoyaltySupplementReply(reply.toString(),step)
   assertEquals(points,reply.getJSONObject("data").getJSONObject("result").getInt("pointsDelta"))
   assertEquals(growth,reply.getJSONObject("data").getJSONObject("result").getInt("growthDelta"))
  }
 }

 @Test fun rejectionStillRequiresExactlyZeroForBothDeltas(){
  val(step,reply)=decisionReply("reject","rejected",0,0)
  validateLoyaltySupplementReply(reply.toString(),step)
  for(field in listOf("pointsDelta","growthDelta"))for(delta in listOf(-1,1)){
   val invalid=JSONObject(reply.toString());invalid.getJSONObject("data").getJSONObject("result").put(field,delta)
   assertThrows(IllegalArgumentException::class.java){validateLoyaltySupplementReply(invalid.toString(),step)}
  }
 }

 @Test fun deltasMustBeExactSafeJsonIntegersInsteadOfCoercedStringsFractionsOrOverflow(){
  for(field in listOf("pointsDelta","growthDelta"))for(invalid in listOf<Any>("0",true,JSONObject.NULL,0.5,-0.5,9007199254740992L,-9007199254740992L)){
   val(step,reply)=decisionReply("approve","executed",0,0)
   reply.getJSONObject("data").getJSONObject("result").put(field,invalid)
   assertThrows("$field=$invalid",IllegalArgumentException::class.java){validateLoyaltySupplementReply(reply.toString(),step)}
  }
 }

 @Test fun requestReceiptNeedsNonnegativeIntegerRewardsAndAtLeastOnePositive(){
  val row=JSONObject().put("orderPublicId","ORDER-123").put("memberNo","MEMBER-123").put("status","missing")
  val step=loyaltySupplementCommand(actor,"request",row,"核对原账缺失").steps.single()
  val result=JSONObject().put("publicId","LSP-"+UUID.randomUUID()).put("status","requested")
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",false)).put("data",JSONObject().put("action","request").put("employeeId",actor.employeeId).put("requestKey",step.key).put("sourcePublicId","ORDER-123").put("result",result))
  for((points,growth)in listOf(0 to 1,1 to 0,20 to 30)){
   result.put("requestedPoints",points).put("requestedGrowth",growth)
   validateLoyaltySupplementReply(reply.toString(),step)
  }
  for((points,growth)in listOf(0 to 0,-1 to 2,2 to -1)){
   result.put("requestedPoints",points).put("requestedGrowth",growth)
   assertThrows(IllegalArgumentException::class.java){validateLoyaltySupplementReply(reply.toString(),step)}
  }
  for(field in listOf("requestedPoints","requestedGrowth"))for(value in listOf<Any>("1",0.5,JSONObject.NULL,true,9007199254740992L)){
   result.put("requestedPoints",1).put("requestedGrowth",1).put(field,value)
   assertThrows(IllegalArgumentException::class.java){validateLoyaltySupplementReply(reply.toString(),step)}
  }
 }
}
