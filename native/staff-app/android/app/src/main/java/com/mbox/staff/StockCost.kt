package com.mbox.staff
import java.math.BigDecimal
import java.util.UUID
import org.json.JSONObject
fun stockCostCommand(actor:StaffIdentity,board:StockBoard,item:JSONObject,yuan:String,reason:String):LiveCommand {
 require(board.source.optBoolean("nativeCostCorrections")&&board.costs&&actor.allows("inventory.cost.correct")&&actor.allows("inventory.cost.view")){"当前后台或岗位不支持成本更正"}
 require(board.employee==actor.employeeId&&board.items.any{it.getString("id")==item.getString("id")});require(reason.trim().length in 2..500){"请填写2至500字更正依据"}
 require(Regex("^(?:0|[1-9][0-9]{0,9})(?:\\.[0-9]{1,8})?$").matches(yuan)){"单位成本最多8位小数，且不得为负"}
 val minor=BigDecimal(yuan).movePointRight(2).stripTrailingZeros().toPlainString();val id=UUID.randomUUID().toString()
 val before=item.textOrNull("weightedUnitCostMinor");val confirmation="更正库存单位成本\n${item.getString("name")} · 每${item.getString("baseUnit")}\n原成本 ${before?.let{BigDecimal(it).movePointLeft(2).toPlainString()} ?: "未知"} 元 → $yuan 元\n依据：${reason.trim()}\n将同步重算关联配方成本，不修改销售价格或生成付款。"
 val body=JSONObject().put("weightedUnitCostMinor",minor).put("reason",reason.trim()).put("expectedObservedAt",serverInstant(board.source.getString("inventoryObservedAt")).toString()).put("expectedWeightedUnitCostMinor",before ?: JSONObject.NULL)
 val proof=JSONObject().put("inventoryItemId",item.getString("id")).put("confirmation",confirmation).put("employeeId",actor.employeeId)
 return LiveCommand(id,actor.employeeId,"更正原库存成本","inventory.cost.correct",listOf(LiveStep("/api/native/inventory/items/${item.getString("id")}/cost-corrections",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("stockCost",proof).toString())))
}
val LiveStep.stockCostProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("stockCost")}
fun validateStockCostReply(text:String,step:LiveStep){
 val root=JSONObject(text);require(root.getJSONObject("meta").get("replayed") is Boolean);val data=root.getJSONObject("data");val body=JSONObject(step.body)
 UUID.fromString(data.getString("id"));require(data.getString("inventoryItemId")==step.stockCostProof!!.getString("inventoryItemId"));require(BigDecimal(data.getString("weightedUnitCostMinor")).compareTo(BigDecimal(body.getString("weightedUnitCostMinor")))==0)
 val expected=body.textOrNull("expectedWeightedUnitCostMinor");val actual=data.textOrNull("previousWeightedUnitCostMinor");require(if(expected==null)actual==null else actual!=null&&BigDecimal(expected).compareTo(BigDecimal(actual))==0)
}
