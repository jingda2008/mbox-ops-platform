package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
class MemberTest {
 fun fixture()=JSONObject(javaClass.classLoader!!.getResourceAsStream("live-members.json")!!.bufferedReader().use{it.readText()})
 fun actor()=StaffIdentity.parse(fixture().getJSONObject("auth"))
 @Test fun memberCode(){assertEquals("MBX-100000",MemberCommands.code(" mbox_member_v1:MBX-100000 "));for(s in listOf("https://bad.invalid","MBX 100","MBOX_MEMBER_V1:"))assertThrows(IllegalArgumentException::class.java){MemberCommands.code(s)}}
 @Test fun checkinAndCancelOriginal(){val source=fixture().getJSONObject("visit");val c=MemberVisitStatus(source).command(false,"",actor());assertEquals(c,LiveCommand.parse(JSONObject(c.json().toString())))
  val visit=JSONObject().put("id","visit-1").put("memberNo","MBX-100000").put("businessDate","2026-09-28").put("checkedInAt","2026-09-28T01:00:00Z").put("employeeName","员工").put("status","checked_in")
  val response=JSONObject().put("data",visit).put("meta",JSONObject().put("replayed",true));validateMemberReply(response.toString(),c.steps[0]);visit.put("memberNo","OTHER");assertThrows(Exception::class.java){validateMemberReply(response.toString(),c.steps[0])};visit.put("memberNo","MBX-100000")
  source.put("visit",visit);val checked=MemberVisitStatus(source);assertThrows(IllegalArgumentException::class.java){checked.command(false,"",actor())};assertThrows(IllegalArgumentException::class.java){checked.command(true,"",actor())}
  val cancel=checked.command(true,"误签到撤回",actor());assertEquals("visit-1",JSONObject(cancel.steps[0].body).getString("visitId"))
  source.put("durableNativeVisits",false);assertThrows(IllegalArgumentException::class.java){MemberVisitStatus(source).command(true,"误签到撤回",actor())}
 }
 @Test fun rewardWholeBatchAndAuthority(){val source=fixture().getJSONObject("reward");val board=MemberRewardBoard(source);val c=board.command(setOf("reward-1"),true,"核实到店",actor())
  val reply=JSONObject().put("data",JSONObject().put("items",JSONArray().put(JSONObject().put("id","reward-1").put("status","issued")))).put("meta",JSONObject().put("replayed",true));validateMemberReply(reply.toString(),c.steps[0]);reply.getJSONObject("data").put("items",JSONArray());assertThrows(Exception::class.java){validateMemberReply(reply.toString(),c.steps[0])}
  source.getJSONArray("items").getJSONObject(0).put("cancelled_sources",1);assertThrows(IllegalArgumentException::class.java){MemberRewardBoard(source).command(setOf("reward-1"),true,"核对",actor())};MemberRewardBoard(source).command(setOf("reward-1"),false,"签到已撤回",actor())
  val denied=fixture().getJSONObject("auth").put("deniedPermissions",JSONArray().put("loyalty.configuration.approve"));assertThrows(IllegalArgumentException::class.java){board.command(setOf("reward-1"),false,"已核对",StaffIdentity.parse(denied))}
 }

 @Test fun benefitCommandBindsOriginalAndAllowedProducts(){
  val board=BenefitFulfillmentBoard(fixture().getJSONObject("benefit"));val row=board.rows[0]
  val c=board.command(row.id,false,row.original,"",actor())
  assertEquals(c,LiveCommand.parse(JSONObject(c.json().toString())))
  assertEquals(row.session,JSONObject(c.steps[0].body).getString("tableSessionId"))
  assertThrows(IllegalArgumentException::class.java){board.command(row.id,false,"other","替换",actor())}
  assertThrows(IllegalArgumentException::class.java){board.command(row.id,false,row.products[1].getString("productId"),"",actor())}
  board.command(row.id,false,row.products[1].getString("productId"),"客人选择替代商品",actor())
  assertThrows(IllegalArgumentException::class.java){board.command(row.id,true,"","",actor())}
 }
 @Test fun benefitReceiptIsOriginalAndNeverMeansDelivered(){
  val board=BenefitFulfillmentBoard(fixture().getJSONObject("benefit"));val row=board.rows[0];val c=board.command(row.id,false,row.original,"",actor())
  val receipt=JSONObject().put("id","redemption-1").put("benefitId",row.benefitId).put("benefitReservationId",row.reservationId)
   .put("customerId",row.customerId).put("tableSessionId",row.session).put("quantity",row.quantity).put("giftOrderReference","gift-original")
   .put("redeemedAt","2026-09-28T00:00:00Z").put("authorizationSource",JSONObject().put("employeeId",actor().employeeId))
  fun reply(d:JSONObject)=JSONObject().put("data",d).put("meta",JSONObject().put("replayed",true)).toString()
  validateMemberReply(reply(receipt),c.steps[0])
  for(key in listOf("benefitId","benefitReservationId","customerId","tableSessionId","giftOrderReference")) {
   val bad=JSONObject(receipt.toString()).put(key,"");assertThrows(Exception::class.java){validateMemberReply(reply(bad),c.steps[0])}
  }
  receipt.put("quantity",2);assertThrows(Exception::class.java){validateMemberReply(reply(receipt),c.steps[0])}
  assertNotEquals(benefitStatusLabel("redeemed"),benefitStatusLabel("delivered"))
 }
 @Test fun benefitCancellationAndExpiredCapability(){
  val source=fixture().getJSONObject("benefit");val board=BenefitFulfillmentBoard(source);val row=board.rows[0]
  val c=board.command(row.id,true,"","客人取消",actor())
  val receipt=JSONObject().put("id",row.reservationId).put("benefitId",row.benefitId).put("customerId",row.customerId)
    .put("tableSessionId",row.session).put("quantity",row.quantity).put("status","cancelled").put("cancelReason","客人取消")
  validateMemberReply(JSONObject().put("data",receipt).put("meta",JSONObject().put("replayed",true)).toString(),c.steps[0])
  source.getJSONArray("gifts").getJSONObject(0).put("expiresAt","2000-01-01T00:00:00Z")
  assertThrows(IllegalArgumentException::class.java){BenefitFulfillmentBoard(source).command(row.id,false,row.original,"",actor())}
  source.put("durable",false)
  assertThrows(IllegalArgumentException::class.java){BenefitFulfillmentBoard(source).command(row.id,true,"","客人取消",actor())}
 }

 @Test fun snackOriginalClaimAndNoCancellationAfterRedemption(){
  val source=fixture().getJSONObject("benefit");val board=BenefitFulfillmentBoard(source);val row=board.rows[1]
  val c=board.command(row.id,false,"","",actor());assertEquals("DSN-ABCDEFGHIJKL",JSONObject(c.steps[0].body).getString("claimCode"))
  source.getJSONArray("snacks").getJSONObject(0).put("status","redeemed")
  for(cancel in listOf(false,true))assertThrows(IllegalArgumentException::class.java){BenefitFulfillmentBoard(source).command(row.id,cancel,"","客人取消",actor())}
  val denied=StaffIdentity.parse(fixture().getJSONObject("auth").put("deniedPermissions",JSONArray().put("loyalty.redemption.fulfill")))
  assertThrows(IllegalArgumentException::class.java){board.command(row.id,false,"","",denied)}
 }
}
