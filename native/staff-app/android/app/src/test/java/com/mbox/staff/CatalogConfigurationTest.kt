package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class CatalogConfigurationTest{
 @Test fun bundlesFreezeOriginalConstituentsAndRejectWrongReceiptOrExcessSelections(){
  val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("catalog.product.manage"),emptySet());val id=UUID.randomUUID().toString();val single=UUID.randomUUID().toString();val product=JSONObject().put("id",id).put("nativeVersion","v1")
  val b=ProductManagementBoard(JSONObject().put("currentEmployeeId","e").put("durableProducts",true).put("canPrice",false).put("configurationProtocol",1).put("offset",0).put("limit",50).put("categories",JSONArray().put(JSONObject().put("code","food").put("parentCode","menu"))).put("products",JSONArray().put(product)))
  val components=JSONArray().put(JSONObject().put("productId",single).put("quantity",2).put("sortOrder",10).put("note",JSONObject.NULL));val options=JSONArray().put(JSONObject().put("productId",single).put("quantity",1).put("sortOrder",10));val groups=JSONArray().put(JSONObject().put("code","choice").put("name","选一份").put("selectionCount",1).put("sortOrder",10).put("options",options))
  val patch=JSONObject().put("productKind","bundle").put("fulfillmentStation","none").put("categoryCode","food").put("bundleComponents",components).put("bundleChoiceGroups",groups)
  val command=productConfigurationCommand(actor,b,product,patch,"调整原套餐");assertEquals(command,LiveCommand.parse(command.json()));components.getJSONObject(0).put("quantity",3);assertEquals(2,JSONObject(command.steps[0].body).getJSONObject("patch").getJSONArray("bundleComponents").getJSONObject(0).getInt("quantity"))
  val data=JSONObject(JSONObject(command.steps[0].body).getJSONObject("patch").toString()).put("id",id);val reply=JSONObject().put("data",data).put("meta",JSONObject().put("replayed",true));validateProductManagementReply(reply.toString(),command.steps[0]);data.getJSONArray("bundleComponents").getJSONObject(0).put("quantity",3);assertThrows(IllegalArgumentException::class.java){validateProductManagementReply(reply.toString(),command.steps[0])}
  groups.getJSONObject(0).put("selectionCount",2);assertThrows(IllegalArgumentException::class.java){productConfigurationCommand(actor,b,product,patch,"非法自选组")}
  val newProduct=JSONObject().put("id","new");val create=JSONObject().put("code","NEW-1").put("name","新商品").put("status","inactive");val c=productConfigurationCommand(actor,b,newProduct,create,"新增未上架商品");assertEquals("/api/native/catalog/products",c.steps[0].path);create.put("status","active");assertThrows(IllegalArgumentException::class.java){productConfigurationCommand(actor,b,newProduct,create,"不允许默认上架")}
 }
 @Test fun categoryKeepsOriginalVersionAndExplicitRootLabel(){
  val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("catalog.product.manage"),emptySet());val row=JSONObject().put("id",UUID.randomUUID().toString()).put("code","root").put("updatedAt","2026-10-01T00:00:00Z")
  val b=ProductManagementBoard(JSONObject().put("currentEmployeeId","e").put("durableProducts",true).put("canPrice",false).put("configurationProtocol",1).put("offset",0).put("limit",50).put("categories",JSONArray()).put("products",JSONArray()));val body=JSONObject().put("displayName","主分类").put("parentCode",JSONObject.NULL).put("sortOrder",100).put("guestVisible",true);val command=categoryConfigurationCommand(actor,b,row,body)
  assertEquals(row.getString("updatedAt"),JSONObject(command.steps[0].body).getString("expectedUpdatedAt"));assertTrue(command.steps[0].categoryConfigurationProof!!.getString("confirmation").contains("上级：一级分类"));val data=JSONObject(body.toString()).put("id",row.getString("id")).put("code","root");val reply=JSONObject().put("data",data).put("meta",JSONObject().put("replayed",true));validateCategoryConfigurationReply(reply.toString(),command.steps[0]);data.put("sortOrder",200);assertThrows(IllegalArgumentException::class.java){validateCategoryConfigurationReply(reply.toString(),command.steps[0])}
 }
}
