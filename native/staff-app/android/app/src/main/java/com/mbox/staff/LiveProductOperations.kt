package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
val productSpecificationOptions=linkedMapOf("whole_bottle" to "整瓶","glass" to "单杯","shot" to "小杯 Shot","cocktail" to "鸡尾酒","custom" to "自定义")
val productTagOptions=linkedMapOf(
 "recommendationSceneTags" to linkedMapOf("date" to "约会","brothers" to "兄弟聚会","besties" to "闺蜜聚会","friends" to "朋友聚会","business" to "商务","celebration" to "庆祝","unsure" to "未确定"),
 "recommendationIntentTags" to linkedMapOf("relaxed" to "放松","energetic" to "热闹","ritual" to "仪式感","unsure" to "未确定"),
 "recommendationTasteTags" to linkedMapOf("refreshing" to "清爽","layered" to "层次丰富","strong" to "浓烈","any" to "不限"),
 "recommendationDwellTags" to linkedMapOf("one_set" to "一轮演出","stay_longer" to "多坐一会","no_rush" to "不赶时间"))
val productNumberBounds=linkedMapOf("recommendationMinGuests" to (1..200),"recommendationMaxGuests" to (1..200),"recommendationPriority" to (0..1000),"recommendationExpectedPrepMinutes" to (0..240),"recommendationHoldMinutes" to (0..240),"kdsPriority" to (0..1000))
fun productOperationsPatch(p:JSONObject,form:JSONObject,actor:StaffIdentity):JSONObject{
 val patch=JSONObject(form.toString());for((k,r)in productNumberBounds)require(patch.getInt(k) in r){"人数、优先级或分钟数超出范围"};require(patch.getInt("recommendationMinGuests")<=patch.getInt("recommendationMaxGuests")){"最小人数不能超过最大人数"}
 for((k,options)in productTagOptions){val tags=patch.getJSONArray(k).strings();require(tags.distinct().size==tags.size&&tags.all{it in options}){"推荐标签无效"}}
 if(!patch.isNull("fulfillmentSlaSeconds"))require(patch.getInt("fulfillmentSlaSeconds") in 30..14400){"出品时限须为30至14400秒，空白采用岗位默认"};patch.textOrNull("recommendationUpgradeProductId")?.let{java.util.UUID.fromString(it);require(it!=p.getString("id")){"不能推荐升级到本商品"}}
 require(patch.getString("searchText").length<=2000);val snapshot=patch.getJSONObject("productSnapshot");require(snapshot.getString("salesSpecificationType") in productSpecificationOptions);for(k in listOf("acidity","sweetness")){val v=snapshot.getJSONObject("tasteProfile");require(v.isNull(k)||v.getInt(k) in 0..5){"口味须为0至5级，未评价留空"}}
 if(patch.has("costAmountMinor")){require(actor.allows("inventory.cost.view")&&p.getString("inventoryControlMode")=="not_managed"&&p.getString("productKind")=="single"){"只有非库存单品可填写成本，配方与套餐成本由后台计算"};if(!patch.isNull("costAmountMinor"))require(patch.getLong("costAmountMinor") in 0..100000000);require(patch.getString("costChangeReason").trim().length in 2..500){"请填写成本变化原因"}}
 return patch
}
fun companionProductDraft(p:JSONObject):JSONObject{
 require(p.getString("productKind")=="single"&&p.getString("inventoryControlMode")=="tracked"){"仅适用于按配方扣库的单品"}
 val old=p.getJSONObject("productSnapshot").getString("salesSpecificationType");require(old in listOf("whole_bottle","glass"));val target=if(old=="whole_bottle")"glass" else "whole_bottle";val suffix=if(target=="glass")"_GLASS" else "_BOTTLE"
 return JSONObject(p.toString()).put("id","new").put("nativeVersion","").put("code","").put("suggestedCode",p.getString("code").take(64-suffix.length)+suffix).put("name",p.getString("name")+" · "+productSpecificationOptions[target]).put("status","inactive").put("standardPrice",JSONObject.NULL).put("costAmountMinor",JSONObject.NULL).put("productSnapshot",JSONObject(p.getJSONObject("productSnapshot").toString()).put("salesSpecificationType",target))
}
