package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.util.UUID
class BenefitExceptionsTest {
 private val actor=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("loyalty.redemption.exception"),emptySet())
 private fun row()=JSONObject().put("id",UUID.randomUUID().toString()).put("orderId",UUID.randomUUID().toString()).put("benefitId",UUID.randomUUID().toString()).put("tableSessionId",UUID.randomUUID().toString()).put("status","failed").put("updatedAt","2026-10-01 01:06:06.09+08").put("attemptCount",10).put("tableCode","A01").put("orderPublicId","ORIGINAL-GIFT")
 @Test fun compensationRequiresEvidenceAndTerminalFailure(){
  val row=row();assertThrows(IllegalArgumentException::class.java){benefitExceptionCommand(actor,"external_compensation",row,"核对原礼遇","")}
  val command=benefitExceptionCommand(actor,"external_compensation",row,"核对原礼遇","真实凭证");assertEquals(command,LiveCommand.parse(command.json()));assertEquals("真实凭证",JSONObject(command.steps[0].body).getString("compensationReference"))
  row.put("status","retry");assertThrows(IllegalArgumentException::class.java){benefitExceptionCommand(actor,"cancel_release",row,"核对未出品","")};benefitExceptionCommand(actor,"retry",row,"重试原礼遇","")
 }
 @Test fun originalRetryReplyCannotBeAnotherGift(){
  val row=row();val command=benefitExceptionCommand(actor,"retry",row,"重试原礼遇","");val result=JSONObject().put("intentId",row.getString("id")).put("orderId",row.getString("orderId")).put("benefitId",row.getString("benefitId")).put("status","pending")
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action","retry").put("employeeId","e").put("requestKey",command.steps[0].key).put("result",result))
  validateBenefitExceptionReply(reply.toString(),command.steps[0]);result.put("benefitId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateBenefitExceptionReply(reply.toString(),command.steps[0])}
 }
}
