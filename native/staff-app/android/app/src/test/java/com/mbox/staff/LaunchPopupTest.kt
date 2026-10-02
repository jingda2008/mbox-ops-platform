package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Test
import org.junit.Assert.*
import java.util.UUID
class LaunchPopupTest{
 private val actor=StaffIdentity("s","e","manager","主管","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("community.activity.manage"),emptySet())
 private fun row()=JSONObject().put("version",0).put("enabled",true).put("title","本周推荐").put("content","已核对的公开商品").put("frequency","daily").put("productIds",JSONArray(listOf(UUID.randomUUID().toString(),UUID.randomUUID().toString())))
 private fun board(r:JSONObject)=LaunchPopupBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("row",r))
 @Test fun receiptMustKeepExactProductOrderAndOriginalContent(){val r=row();val c=launchPopupCommand(actor,board(r),r,"已核对商品排序");assertEquals(c,LiveCommand.parse(c.json()));val saved=JSONObject(r.toString()).put("version",2);val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("requestKey",c.steps[0].key).put("row",saved));validateLaunchPopupReply(reply.toString(),c.steps[0]);saved.put("productIds",JSONArray(r.getJSONArray("productIds").strings().reversed()));assertThrows(IllegalArgumentException::class.java){validateLaunchPopupReply(reply.toString(),c.steps[0])}}
 @Test fun rejectsDuplicateProductsAndCapsPublicCarousel(){val r=row();r.put("productIds",JSONArray(List(9){UUID.randomUUID().toString()}));assertThrows(IllegalArgumentException::class.java){launchPopupCommand(actor,board(r),r,"核对公开商品")};val id=UUID.randomUUID().toString();r.put("productIds",JSONArray(listOf(id,id)));assertThrows(IllegalArgumentException::class.java){launchPopupCommand(actor,board(r),r,"核对重复商品")};r.put("productIds",JSONArray());assertTrue(JSONObject(launchPopupCommand(actor,board(r),r,"不展示商品推荐").steps[0].body).getJSONArray("productIds").length()==0)}
}
