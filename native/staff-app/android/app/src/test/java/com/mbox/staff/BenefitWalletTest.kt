package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class BenefitWalletTest {
 private val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("benefit.issue","benefit.cancel","loyalty.redemption.fulfill"),emptySet())
 private fun id()=UUID.randomUUID().toString()
 @Test fun walletCommandsFreezeOriginalMemberTableAndDoNotTurnPricePromisesIntoGifts(){
  val customer=id();val benefit=id();val table=id();val reservation=id()
  val row=JSONObject().put("id",benefit).put("state","available").put("type","access").put("quantityAvailable",2).put("version",1).put("products",JSONArray()).put("reservations",JSONArray().put(JSONObject().put("id",reservation).put("quantity",1).put("tableSessionId",table).put("canRedeem",true)))
  val board=BenefitWalletBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("customerId",customer).put("items",JSONArray().put(row)).put("tables",JSONArray().put(JSONObject().put("id",table))).put("limits",JSONArray()))
  val body=JSONObject().put("customerId",customer).put("benefitId",benefit).put("tableSessionId",table).put("quantity",1).put("expectedVersion",1)
  val c=benefitWalletCommand(actor,board,"reserve",body,"暂留原权益");assertEquals(c,LiveCommand.parse(c.json()));body.put("quantity",2);assertEquals(1,JSONObject(c.steps[0].body).getInt("quantity"))
  row.put("pricePromise",JSONObject().put("fixedPriceMinor",100));assertThrows(IllegalArgumentException::class.java){benefitWalletCommand(actor,board,"reserve",body,"禁止直接赠送")};row.remove("pricePromise")
  row.put("snackClaim",true);assertThrows(IllegalArgumentException::class.java){benefitWalletCommand(actor,board,"reserve",body,"须走核销码")};row.remove("snackClaim")
  body.put("tableSessionId",id());assertThrows(IllegalArgumentException::class.java){benefitWalletCommand(actor,board,"reserve",body,"错误桌次")}
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action","reserve").put("employeeId","e").put("customerId",customer).put("requestKey",c.steps[0].key).put("result",JSONObject().put("id",reservation).put("benefitId",benefit).put("tableSessionId",table).put("quantity",1).put("status","reserved")))
  validateBenefitWalletReply(reply.toString(),c.steps[0]);reply.getJSONObject("data").getJSONObject("result").put("benefitId",id());assertThrows(IllegalArgumentException::class.java){validateBenefitWalletReply(reply.toString(),c.steps[0])}
 }
 @Test fun issuanceUsesExactTotalLimitAndGiftProductEvidence(){
  val customer=id();val limit=id();val board=BenefitWalletBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("customerId",customer).put("items",JSONArray()).put("tables",JSONArray()).put("limits",JSONArray().put(JSONObject().put("id",limit).put("amountMinor","1000").put("currency","CNY"))))
  val body=JSONObject().put("customerId",customer).put("title","现场赠品").put("benefitCode","CARE-01").put("benefitType","gift_product").put("quantity",2).put("valueAmountMinor",500).put("authorizationLimitId",limit).put("allowedProductIds",JSONArray().put(id())).put("validFrom","2026-10-01T10:00:00+08:00").put("validUntil",JSONObject.NULL).put("reason","顾客现场关怀")
  benefitWalletCommand(actor,board,"issue",body,"授权发放");body.put("valueAmountMinor",501);assertThrows(IllegalArgumentException::class.java){benefitWalletCommand(actor,board,"issue",body,"超过总额")};body.put("valueAmountMinor",500).put("allowedProductIds",JSONArray());assertThrows(IllegalArgumentException::class.java){benefitWalletCommand(actor,board,"issue",body,"未选择赠品")}
 }
}
