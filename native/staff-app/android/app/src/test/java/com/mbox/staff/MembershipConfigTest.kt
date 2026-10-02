package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class MembershipConfigTest{
 private val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("loyalty.configuration.edit","loyalty.configuration.approve","loyalty.operations.control"),emptySet())
 @Test fun keepsExactMoneyNullInventoryAndTimestampWhenEditing(){
  val item=newMembershipItem("redemption_catalog").put("costAmountMinor",12345).put("availableFrom","2026-09-30 01:06:06.09+08").put("dailyInventory",0)
  val original=JSONObject().put("domain","redemption_catalog").put("items",JSONArray().put(item));val editing=membershipEditingContent(original);val row=editing.getJSONArray("items").getJSONObject(0)
  assertEquals("123.45",row.getString("costAmountMinor"));assertEquals("2026-09-30 01:06:06.09",row.getString("availableFrom"))
  val result=membershipNormalizeContent(editing).getJSONArray("items").getJSONObject(0);assertEquals(12345,result.getInt("costAmountMinor"));assertTrue(result.isNull("totalInventory"));assertEquals(0,result.getInt("dailyInventory"));assertEquals(serverInstant(item.getString("availableFrom")),serverInstant(result.getString("availableFrom")))
  row.put("costAmountMinor","1.001");assertThrows(IllegalStateException::class.java){membershipNormalizeContent(editing)}
  row.put("costAmountMinor","10").put("dailyInventory","-1");assertThrows(IllegalStateException::class.java){membershipNormalizeContent(editing)}
  assertThrows(java.time.format.DateTimeParseException::class.java){membershipDate("2026-02-30 12:00")}
 }
 @Test fun savedRequestCannotBeSatisfiedByAnotherConfigurationOrRevision(){
  val id=UUID.randomUUID().toString();val body=JSONObject().put("action","edit").put("domain","base_points").put("configurationId",id).put("expectedRevision",4).put("content",newMembershipContent("base_points")).put("reason","修改原规则")
  val command=membershipConfigCommand(actor,body,"保存规则草稿");assertEquals(command,LiveCommand.parse(command.json()));val step=command.steps[0]
  val result=JSONObject().put("publicId",id).put("domain","base_points").put("status","draft").put("revision",5)
  val data=JSONObject().put("action","edit").put("domain","base_points").put("employeeId","e").put("requestKey",step.key).put("configurationId",id).put("result",result)
  val reply=JSONObject().put("data",data).put("meta",JSONObject().put("protocol",1).put("replayed",true));validateMembershipConfigReply(reply.toString(),step)
  result.put("revision",6);assertThrows(IllegalArgumentException::class.java){validateMembershipConfigReply(reply.toString(),step)}
  result.put("revision",5).put("publicId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateMembershipConfigReply(reply.toString(),step)}
  val publish=JSONObject(body.toString()).put("action","publish");assertThrows(IllegalArgumentException::class.java){membershipConfigCommand(actor,publish,"越权发布")}
 }
 @Test fun controlReceiptMustMatchTheSelectedCapabilityVersionAndTarget(){
  val body=JSONObject().put("action","control").put("capability","points_redemption").put("operation","pause").put("expectedVersion",3).put("reason","核对兑换库存").put("reviewAt",JSONObject.NULL)
  val step=membershipConfigCommand(actor,body,"暂停兑换").steps[0];val result=JSONObject().put("capability","points_redemption").put("version",4).put("state","paused")
  val data=JSONObject().put("action","control").put("domain","").put("employeeId","e").put("requestKey",step.key).put("configurationId",JSONObject.NULL).put("result",result);val reply=JSONObject().put("data",data).put("meta",JSONObject().put("protocol",1).put("replayed",false))
  validateMembershipConfigReply(reply.toString(),step);result.put("capability","points_accrual");assertThrows(IllegalArgumentException::class.java){validateMembershipConfigReply(reply.toString(),step)}
 }
}
