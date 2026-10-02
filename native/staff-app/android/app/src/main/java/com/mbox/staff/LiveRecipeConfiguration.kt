package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
import java.math.BigDecimal
class RecipeConfigurationBoard(val data:JSONObject){val actor=data.getString("currentEmployeeId");val product=data.getJSONObject("product");val recipe=data.optJSONObject("recipe");val items=data.getJSONArray("items").objects();val enabled=data.getInt("nativeRecipeProtocol")==1;val version=data.getString("expectedVersion")}
fun recipeConfigurationCommand(actor:StaffIdentity,b:RecipeConfigurationBoard,outputQuantity:Int,notes:String,lines:List<JSONObject>):LiveCommand{
 require(b.enabled&&b.actor==actor.employeeId&&actor.allows("inventory.manage"));require(b.product.getString("product_kind")=="single"){"套餐请管理组成商品"};require(outputQuantity in 1..1000){"一次配方产出须为1至1000份"};require(lines.size in 1..100&&lines.map{it.getString("inventoryItemId")}.distinct().size==lines.size){"须选择1至100种不重复物料"};require(notes.length<=2000)
 for(l in lines){require(b.items.any{it.getString("id")==l.getString("inventoryItemId")}){"原物料已停用或不存在"};for(k in listOf("quantity","expectedWasteQuantity")){val v=l.getString(k);require(Regex("^[0-9]+(?:\\.[0-9]{1,6})?$").matches(v)&&v.length<=24){"数量最多6位小数"};require(BigDecimal(v)>=BigDecimal.ZERO&&(k!="quantity"||BigDecimal(v)>BigDecimal.ZERO)){"用量须大于0，预计损耗不能小于0"}}}
 val id=UUID.randomUUID().toString();val instructions=JSONObject((b.recipe?.optJSONObject("instructionsSnapshot")?:JSONObject()).toString()).put("notes",notes.trim());val payload=JSONObject().put("expectedVersion",b.version).put("yieldQuantity",outputQuantity).put("instructionsSnapshot",instructions).put("components",JSONArray(lines));val confirmation="更新 ${b.product.getString("name")} 配方\n每批产出${outputQuantity}份\n"+lines.joinToString("\n"){l->val i=b.items.first{it.getString("id")==l.getString("inventoryItemId")};"${i.getString("name")}：用量${l.getString("quantity")} ${i.getString("baseUnit")}，预计损耗${l.getString("expectedWasteQuantity")} ${i.getString("baseUnit")}"}+"\n配方保存会按当前库存成本重算，缺失成本继续标记待核对；不改写原订单耗料。"
 val proof=JSONObject().put("productId",b.product.getString("id")).put("originalVersion",b.recipe?.getInt("version")?:0).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,"核对配方与耗料","inventory.manage",listOf(LiveStep("/api/native/inventory/products/${b.product.getString("id")}/recipe",payload.toString(),"idempotency-key","native-recipe-$id",JSONObject().put("recipeConfiguration",proof).toString())))
}
val LiveStep.recipeConfigurationProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("recipeConfiguration")}
fun validateRecipeConfigurationReply(text:String,step:LiveStep){val root=JSONObject(text);val d=root.getJSONObject("data");require(root.getJSONObject("meta").get("replayed") is Boolean);UUID.fromString(d.getString("id"));require(d.getInt("version")>step.recipeConfigurationProof!!.getInt("originalVersion")){"原配方回执版本不匹配"}}
