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
}
