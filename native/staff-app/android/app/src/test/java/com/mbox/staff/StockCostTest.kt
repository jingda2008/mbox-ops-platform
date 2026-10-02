package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class StockCostTest {
 @Test fun fractionalUnitCostPreservesMinorPrecisionAndOriginalCost(){
  val actor=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("inventory.cost.correct","inventory.cost.view"),emptySet())
  val item=JSONObject().put("id",UUID.randomUUID().toString()).put("name","测试酒液").put("baseUnit","ml").put("weightedUnitCostMinor",JSONObject.NULL)
  val board=StockBoard(JSONObject().put("currentEmployeeId","e").put("nativeCommands",true).put("nativeCostCorrections",true).put("inventoryObservedAt","2026-10-01 00:00:00+08").put("items",JSONArray().put(item)).put("receipts",JSONArray()).put("visibility",JSONObject().put("costs",true)))
  val command=stockCostCommand(actor,board,item,"0.00123456","核对原凭证");val body=JSONObject(command.steps[0].body);assertEquals("0.123456",body.getString("weightedUnitCostMinor"));assertTrue(body.isNull("expectedWeightedUnitCostMinor"))
  val result=JSONObject().put("id",UUID.randomUUID().toString()).put("inventoryItemId",item.getString("id")).put("previousWeightedUnitCostMinor",JSONObject.NULL).put("weightedUnitCostMinor","0.123456")
  val reply=JSONObject().put("meta",JSONObject().put("replayed",true)).put("data",result);validateStockCostReply(reply.toString(),command.steps[0]);result.put("previousWeightedUnitCostMinor","0");assertThrows(IllegalArgumentException::class.java){validateStockCostReply(reply.toString(),command.steps[0])}
  assertThrows(IllegalArgumentException::class.java){stockCostCommand(actor,board,item,"0.000000001","不能丢精度")}
 }
}
