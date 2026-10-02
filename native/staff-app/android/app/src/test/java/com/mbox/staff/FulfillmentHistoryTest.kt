package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
class FulfillmentHistoryTest{
 private fun history()=JSONObject().put("businessDate","2026-10-01").put("generatedAt","2026-10-01 06:00:00+08").put("page",0).put("hasMore",false).put("orders",JSONArray()).put("receipts",JSONArray())
 private fun receipt()=JSONObject().put("receiptId","shared-1").put("tableCode","A01").put("pickupTableCode","A02").put("source","shared_pickup_device").put("deliveredAt","2026-10-01T00:00:00Z").put("items",JSONArray(listOf(JSONObject().put("itemId","i").put("name","茶水").put("quantity",2).put("kind","remake").put("specification","").put("itemNote","不加冰").put("orderNote",""))))
 @Test fun keepsWorkKindSeparateAndEscapesTableFilters(){val p=fulfillmentHistoryPath("delivered","2026-10-01","A&employee=other",1);assertTrue(p.contains("workKind=delivered"));assertFalse(p.contains("&employee="));assertThrows(IllegalArgumentException::class.java){fulfillmentHistoryPath("all","","",0)};assertThrows(java.time.DateTimeException::class.java){fulfillmentHistoryPath("prepared","2026-02-30","",0)}}
 @Test fun validatesSharedReceiptsWithoutInventingPersonalWork(){val h=LiveHistory(history().put("sharedDeliveries",JSONArray(listOf(receipt()))));validateFulfillmentHistory(h,0);assertTrue(h.orders.isEmpty());assertEquals(2,h.source.getJSONArray("sharedDeliveries").getJSONObject(0).getJSONArray("items").getJSONObject(0).getInt("quantity"));assertThrows(IllegalArgumentException::class.java){validateFulfillmentHistory(LiveHistory(history().put("sharedDeliveries",JSONArray(listOf(receipt(),receipt())))),0)}}
 @Test fun refusesMisclassifiedSharedOriginAndNegativeWork(){assertThrows(IllegalArgumentException::class.java){validateFulfillmentHistory(LiveHistory(history().put("sharedDeliveries",JSONArray(listOf(receipt().put("source","employee"))))),0)};assertThrows(IllegalArgumentException::class.java){validateFulfillmentHistory(LiveHistory(history().put("sharedDeliveries",JSONArray(listOf(receipt().also{it.getJSONArray("items").getJSONObject(0).put("quantity",-1)})))),0)}}
}
