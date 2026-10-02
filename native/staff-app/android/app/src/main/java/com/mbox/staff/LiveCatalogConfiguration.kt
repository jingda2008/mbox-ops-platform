package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray
val ProductManagementBoard.configurable get()=data.optInt("configurationProtocol")==1
val ProductManagementBoard.categories get()=data.optJSONArray("categories")?.objects()?:emptyList()
fun productConfigurationCommand(actor:StaffIdentity,board:ProductManagementBoard,p:JSONObject,patch:JSONObject,confirmation:String):LiveCommand{
 require(board.configurable&&board.durable&&board.employee==actor.employeeId&&actor.allows("catalog.product.manage"));require(p.getString("id")=="new"||board.products.any{it.getString("id")==p.getString("id")&&it.getString("nativeVersion")==p.getString("nativeVersion")}){"请刷新原商品"};require(patch.length()>0)
 patch.textOrNull("categoryCode")?.let{value->require(board.categories.any{it.getString("code")==value&&it.textOrNull("parentCode")!=null}){"请选择二级菜单分类"}}
 if(patch.has("name"))require(patch.getString("name").trim().length in 1..160)
 if(patch.has("maxOrderQuantity"))require(patch.getInt("maxOrderQuantity") in 1..9999)
 if(patch.optString("productKind")=="bundle"){require(patch.getString("fulfillmentStation")=="none"){"套餐由组成单品分别出品，请选择无需制作"};require(patch.optJSONArray("bundleComponents")?.length()!=0||patch.optJSONArray("bundleChoiceGroups")?.length()!=0){"套餐至少有一个固定单品或自选组"}}
 if(patch.has("bundleComponents")){val rows=patch.getJSONArray("bundleComponents").objects();require(rows.size<=50&&rows.map{it.getString("productId")}.distinct().size==rows.size);for(r in rows)require(r.getInt("quantity") in 1..999&&r.getString("productId")!=p.getString("id"))}
 patch.optJSONArray("bundleChoiceGroups")?.objects()?.let{groups->require(groups.size<=20&&groups.map{it.getString("code")}.distinct().size==groups.size);for(g in groups){val options=g.getJSONArray("options").objects();require(options.size in 1..100&&options.map{it.getString("productId")}.distinct().size==options.size);require(g.getInt("selectionCount") in 1..minOf(20,options.size));for(o in options)require(o.getInt("quantity") in 1..999&&o.getString("productId")!=p.getString("id"))}}
 val creating=p.getString("id")=="new";if(creating){require(Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$").matches(patch.getString("code"))){"商品编号格式不正确"};require(patch.getString("status")=="inactive"){"新建商品先保存为下架，核对配方及售价后再上架"}}
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("creating",creating).put("id",p.getString("id")).put("expected",patch).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,"核对商品配置","catalog.product.manage",listOf(LiveStep("/api/native/catalog/products"+(if(creating)"" else "/${p.getString("id")}"),(if(creating)patch else JSONObject().put("expectedVersion",p.getString("nativeVersion")).put("patch",patch)).toString(),"idempotency-key","native-product-$id",JSONObject().put("productManagement",proof).toString())))
}
fun categoryConfigurationCommand(actor:StaffIdentity,b:ProductManagementBoard,row:JSONObject?,body:JSONObject):LiveCommand{
 require(b.configurable&&b.employee==actor.employeeId&&actor.allows("catalog.product.manage"));require(body.getString("displayName").trim().length in 1..32);require(body.getInt("sortOrder") in 0..100000)
 val code=row?.getString("code")?:body.getString("code");require(Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$").matches(code)){"分类编码格式不正确"};body.textOrNull("parentCode")?.let{parent->require(b.categories.any{it.getString("code")==parent&&it.textOrNull("parentCode")==null&&parent!=code}){"只能选择一级分类作为父分类"}}
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("code",code).put("expected",body).put("confirmation","${if(row==null)"新增" else "修改"}分类：${body.getString("displayName")}\n编号：$code\n上级：${body.textOrNull("parentCode")?.let{c->b.categories.find{it.getString("code")==c}?.getString("displayName")}?:"一级分类"}\n排序：${body.getInt("sortOrder")}\n${if(body.getBoolean("guestVisible"))"客人菜单显示" else "客人菜单隐藏"}\n已有订单内容不变；仍有商品的分类层级调整由后台检查。")
 return LiveCommand(id,actor.employeeId,"核对菜单分类","catalog.product.manage",listOf(LiveStep("/api/native/catalog/menu-categories"+(row?.let{"/${LiveCommand.part(code)}"}?:""),(if(row==null)body else JSONObject().put("expectedUpdatedAt",row.getString("updatedAt")).put("patch",body)).toString(),"idempotency-key","native-category-$id",JSONObject().put("categoryConfiguration",proof).toString())))
}
val LiveStep.categoryConfigurationProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("categoryConfiguration")}
fun validateCategoryConfigurationReply(text:String,step:LiveStep){val root=JSONObject(text);val d=root.getJSONObject("data");val p=step.categoryConfigurationProof!!;require(root.getJSONObject("meta").get("replayed") is Boolean);UUID.fromString(d.getString("id"));require(d.getString("code")==p.getString("code"));val expected=p.getJSONObject("expected");for(k in listOf("displayName","parentCode","guestVisible","sortOrder"))require(d.get(k)==expected.get(k)){"分类回执不匹配"}}
fun comparableBundleComponents(a:JSONArray)=a.objects().map{listOf(it.getString("productId"),it.getInt("quantity"),it.optInt("sortOrder"),it.textOrNull("note"))}.sortedBy{it[0].toString()}
fun comparableBundleChoices(a:JSONArray)=a.objects().map{g->listOf(g.getString("code"),g.getString("name"),g.getInt("selectionCount"),g.optInt("sortOrder"),g.getJSONArray("options").objects().map{listOf(it.getString("productId"),it.getInt("quantity"),it.optInt("sortOrder"))}.sortedBy{it[0].toString()})}.sortedBy{it[0].toString()}
