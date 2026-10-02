package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Test
import org.junit.Assert.*

class CheckoutManagementTest {
 private val source="10000000-0000-4000-8000-000000000001"
 private val target="10000000-0000-4000-8000-000000000002"
 private fun actor()=StaffIdentity("s","e","manager","主管","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("checkout.upgrade.rule.draft","checkout.upgrade.rule.approve","checkout.upgrade.rule.publish","fulfillment.capacity.draft","fulfillment.capacity.approve","fulfillment.capacity.publish"),emptySet())
 private fun board(rows:List<JSONObject> = emptyList())=CouponCalendarsBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("rows",JSONArray(rows)).put("next",JSONObject.NULL).put("code","UPGRADE").put("latest",3))
 private fun draft()=JSONObject().put("code","UPGRADE").put("name","聚会套餐升级").put("sourceProductId",source).put("targetProductId",target).put("sourceProductName","原饮品").put("targetProductName","套餐").put("minimumPartySize",2).put("maximumPartySize",6).put("occasionTags",JSONArray(listOf("friends"))).put("alcoholPreferenceTags",JSONArray(listOf("mixed"))).put("promptTitle","聚会套餐").put("promptBody","核对价格和份量后选择").put("callToAction","查看套餐").put("priority",100).put("offerValidMinutes",10).put("minimumGrossMarginBasisPoints",1500).put("reason","原料与份量已核对").put("qualification",JSONObject().put("maximumAddMinor",3000).put("maximumAddBasisPoints",3000).put("minimumContributionMinor",1000).put("minimumIncrementalContributionMinor",100).put("positiveFitReason","符合聚会人数和已选偏好").put("maximumQuantitiesPerPerson",JSONArray().put(JSONObject().put("productId",target).put("quantity",1))).put("excludedProductIds",JSONArray()))
 private fun receipt(c:LiveCommand,row:JSONObject)=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId",c.employeeID).put("requestKey",c.steps[0].key).put("action",c.steps[0].checkoutManagementProof!!.getString("action")).put("accepted",JSONObject(c.steps[0].body)).put("row",row)).toString()
 @Test fun qualificationAndAmountsMustMatchOriginalReceipt(){
  val c=checkoutManagementCommand(actor(),board(),"rule-draft",null,draft());assertEquals(c,LiveCommand.parse(c.json()))
  val row=draft().put("id",source).put("revision",4).put("status","draft").put("draftedByEmployeeId","e").put("nativeVersion","a".repeat(64))
  validateCheckoutManagementReply(receipt(c,row),c.steps[0]);row.getJSONObject("qualification").put("maximumAddMinor",3001)
  assertThrows(IllegalArgumentException::class.java){validateCheckoutManagementReply(receipt(c,row),c.steps[0])}
  assertEquals(123L,checkoutMoney("1.23"));assertThrows(ArithmeticException::class.java){checkoutMoney("1.234")};assertThrows(IllegalArgumentException::class.java){checkoutMoney("-1")}
 }
 @Test fun independentReviewAndSelectedVersionAreRequired(){
  val row=draft().put("id",source).put("revision",3).put("status","draft").put("draftedByEmployeeId","e").put("nativeVersion","a".repeat(64))
  assertThrows(IllegalArgumentException::class.java){checkoutManagementCommand(actor(),board(listOf(row)),"rule-approve",row,JSONObject().put("reason","自己不能审批"))}
  row.put("draftedByEmployeeId","maker").put("approvedByEmployeeId","e").put("status","approved")
  assertThrows(IllegalArgumentException::class.java){checkoutManagementCommand(actor(),board(listOf(row)),"rule-publish",row,JSONObject().put("reason","审批不能兼发布"))}
  assertThrows(IllegalArgumentException::class.java){checkoutManagementCommand(actor(),board(),"rule-rollback",row,JSONObject().put("reason","已失去原版本"))}
 }
 @Test fun capacityWindowsRejectOverlapButAcceptAdjacentAndPostgresTime(){
  fun window(start:String,end:String)=JSONObject().put("startsAt",start).put("endsAt",end).put("capacityLimitUnits",20)
  val b=JSONObject().put("stationCode","bar").put("reason","根据当班人员配置").put("windows",JSONArray().put(window("2037-01-01T10:00:00+08:00","2037-01-01T11:00:00+08:00")).put(window("2037-01-01T11:00:00+08:00","2037-01-01T12:00:00+08:00")))
  val c=checkoutManagementCommand(actor(),board(),"capacity-draft",null,b)
  val row=JSONObject(b.toString()).put("status","draft").put("draftedByEmployeeId","e").put("nativeVersion","b".repeat(64))
  row.getJSONArray("windows").getJSONObject(0).put("startsAt","2037-01-01 10:00:00+08").put("usedUnits",0)
  validateCheckoutManagementReply(receipt(c,row),c.steps[0])
  row.getJSONArray("windows").getJSONObject(0).put("capacityLimitUnits",21)
  assertThrows(IllegalArgumentException::class.java){validateCheckoutManagementReply(receipt(c,row),c.steps[0])}
  b.getJSONArray("windows").getJSONObject(1).put("startsAt","2037-01-01T10:59:59+08:00")
  assertThrows(IllegalArgumentException::class.java){checkoutManagementCommand(actor(),board(),"capacity-draft",null,b)}
 }
 @Test fun rollbackMustRemainANewDraftAndPreserveQualification(){
  val before=draft().put("id",source).put("revision",2).put("status","active").put("draftedByEmployeeId","old").put("nativeVersion","a".repeat(64))
  val c=checkoutManagementCommand(actor(),board(listOf(before)),"rule-rollback",before,JSONObject().put("reason","复制历史配置重新复核"))
  val row=JSONObject(before.toString()).put("id",target).put("revision",4).put("status","draft").put("draftedByEmployeeId","e")
  validateCheckoutManagementReply(receipt(c,row),c.steps[0]);row.put("status","active")
  assertThrows(IllegalArgumentException::class.java){validateCheckoutManagementReply(receipt(c,row),c.steps[0])}
 }
}
