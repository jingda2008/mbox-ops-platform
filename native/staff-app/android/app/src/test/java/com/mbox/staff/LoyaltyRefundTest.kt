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
}
