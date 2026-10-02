package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class RemakeHandoverTest{
 private val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("refund.request","inventory.receive","inventory.waste"),emptySet())
 @Test fun exactUnitsAndPackagingProofSurviveRecovery(){
  val units=listOf(UUID.randomUUID().toString(),UUID.randomUUID().toString());val eligibility=JSONObject().put(units[0],JSONObject().put("canReturn",true)).put(units[1],JSONObject().put("canReturn",false))
  val row=JSONObject().put("batchId",UUID.randomUUID().toString()).put("itemId",UUID.randomUUID().toString()).put("unitIds",JSONArray(units)).put("returnEligibility",eligibility).put("canReceive",true).put("canRecordUsed",true).put("tableCode","A01").put("productName","原商品").put("orderPublicId","原订单")
  assertThrows(IllegalArgumentException::class.java){remakeHandoverCommand(actor,row,2,"returned_unopened",true,"实物核对退回")};assertThrows(IllegalArgumentException::class.java){remakeHandoverCommand(actor,row,1,"returned_unopened",false,"实物核对退回")}
  val command=remakeHandoverCommand(actor,row,1,"returned_unopened",true,"实物核对退回");assertEquals(command,LiveCommand.parse(command.json()));val step=command.steps[0];assertEquals(units[0],JSONObject(step.body).getJSONArray("unitIds").getString(0))
  row.put("unitIds",JSONArray(units.reversed()));assertEquals(units[0],JSONObject(step.body).getJSONArray("unitIds").getString(0))
  val data=JSONObject().put("batchId",row.getString("batchId")).put("itemId",row.getString("itemId")).put("employeeId","e").put("requestKey",step.key).put("remainingQuantity",1);val reply=JSONObject().put("data",data).put("protocol",1).put("replayed",true)
  validateRemakeHandoverReply(reply.toString(),step);data.put("batchId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateRemakeHandoverReply(reply.toString(),step)}
  assertEquals("inventory.waste",remakeHandoverCommand(actor,row,2,"used_loss",false,"已核对实际耗用").permission)
 }
}
