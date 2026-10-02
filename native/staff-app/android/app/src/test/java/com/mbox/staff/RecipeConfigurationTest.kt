package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class RecipeConfigurationTest{
 @Test fun recipePreservesExactDecimalUnitsAndPriorInstructions(){
  val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("inventory.manage"),emptySet());val productId=UUID.randomUUID().toString();val itemId=UUID.randomUUID().toString()
  val b=RecipeConfigurationBoard(JSONObject().put("currentEmployeeId","e").put("nativeRecipeProtocol",1).put("expectedVersion","a".repeat(64)).put("product",JSONObject().put("id",productId).put("name","原商品").put("product_kind","single")).put("recipe",JSONObject().put("version",7).put("instructionsSnapshot",JSONObject().put("legacyPreparation","保留原制作说明"))).put("items",JSONArray().put(JSONObject().put("id",itemId).put("name","原料").put("baseUnit","ml"))))
  val line=JSONObject().put("inventoryItemId",itemId).put("quantity","12.123456").put("expectedWasteQuantity","0.005");val c=recipeConfigurationCommand(actor,b,2,"新说明",listOf(line));val body=JSONObject(c.steps[0].body);assertEquals("12.123456",body.getJSONArray("components").getJSONObject(0).getString("quantity"));assertEquals("保留原制作说明",body.getJSONObject("instructionsSnapshot").getString("legacyPreparation"));assertEquals(c,LiveCommand.parse(c.json()))
  line.put("quantity","0");assertThrows(IllegalArgumentException::class.java){recipeConfigurationCommand(actor,b,2,"",listOf(line))};line.put("quantity","12.1234567");assertThrows(IllegalArgumentException::class.java){recipeConfigurationCommand(actor,b,2,"",listOf(line))};line.put("quantity","1");assertThrows(IllegalArgumentException::class.java){recipeConfigurationCommand(actor,b,2,"",listOf(line,line))}
  val reply=JSONObject().put("data",JSONObject().put("id",UUID.randomUUID().toString()).put("version",8)).put("meta",JSONObject().put("replayed",true));validateRecipeConfigurationReply(reply.toString(),c.steps[0]);reply.getJSONObject("data").put("version",7);assertThrows(IllegalArgumentException::class.java){validateRecipeConfigurationReply(reply.toString(),c.steps[0])}
 }
}
