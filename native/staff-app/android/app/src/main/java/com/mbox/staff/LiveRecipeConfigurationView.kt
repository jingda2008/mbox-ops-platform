package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
@Composable fun LiveRecipeConfigurationView(m:AppModel,productId:String,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var notice by remember{mutableStateOf("")}
 LaunchedEffect(productId){m.loadRecipeConfiguration(productId)};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("配方与耗料",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.recipeConfigurationState);m.recipeCostPreview?.let{cost->Text("当前已保存配方成本："+(cost.textOrNull("costAmountMinor")?.let{java.math.BigDecimal(it).movePointLeft(2).toPlainString()+"元/份"}?:"待核对（有物料成本缺失）"));for(c in cost.getJSONArray("components").objects())Text("${c.getString("itemName")} · ${c.getString("componentQuantity")} ${c.getString("baseUnit")} · "+(c.textOrNull("componentCostMinor")?.let{java.math.BigDecimal(it).movePointLeft(2).toPlainString()+"元"}?:"成本待核对"))};TextButton(onClick={m.loadRecipeConfiguration(productId)},enabled=!m.busy){Text("重新读取原配方")};Text(notice,color=MaterialTheme.colorScheme.error)}
  m.recipeConfigurationBoard?.takeIf{it.product.getString("id")==productId}?.let{b->item{key(b.version){RecipeConfigurationFields(m,b){outputQuantity,notes,lines->try{proposed=recipeConfigurationCommand(m.identity!!,b,outputQuantity,notes,lines);notice=""}catch(e:Exception){notice=e.message.orEmpty()}}}}}
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text(c.title)},text={Text(c.steps[0].recipeConfigurationProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认保存配方")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回修改")}})}
}
@Composable private fun RecipeConfigurationFields(m:AppModel,b:RecipeConfigurationBoard,submit:(Int,String,List<JSONObject>)->Unit){
 var outputQuantity by remember{mutableStateOf((b.recipe?.getInt("yieldQuantity")?:1).toString())};var notes by remember{mutableStateOf(b.recipe?.optJSONObject("instructionsSnapshot")?.optString("notes")?:"")};var lines by remember{mutableStateOf<List<JSONObject>>(b.recipe?.getJSONArray("components")?.objects()?.map{JSONObject().put("inventoryItemId",it.getString("inventoryItemId")).put("quantity",it.getString("quantity")).put("expectedWasteQuantity",it.getString("expectedWasteQuantity"))}?:emptyList())};var search by remember{mutableStateOf("")};var itemId by remember{mutableStateOf("")}
 Panel{Text(b.product.getString("name"),style=MaterialTheme.typography.titleMedium);Text(b.recipe?.let{"当前配方版本${it.getInt("version")}"}?:"尚未配置配方");CustodyField("每批产出份数",outputQuantity,4){outputQuantity=it};CustodyField("制作说明",notes,2000){notes=it};Text("各物料用基础单位填写；瓶、箱等包装量不能直接当作毫升或件数。已有库存预留按原订单快照处理。")
 for((index,line) in lines.withIndex()){val item=b.items.find{it.getString("id")==line.getString("inventoryItemId")};Text(item?.let{"${it.getString("name")} · ${it.getString("baseUnit")}"}?:"原物料已停用，请移除并替换");CustodyField("每批实际用量",line.getString("quantity"),24){v->lines=lines.mapIndexed{i,l->if(i==index)JSONObject(l.toString()).put("quantity",v) else l}};CustodyField("每批预计损耗",line.getString("expectedWasteQuantity"),24){v->lines=lines.mapIndexed{i,l->if(i==index)JSONObject(l.toString()).put("expectedWasteQuantity",v) else l}};TextButton(onClick={lines=lines.filterIndexed{i,_->i!=index}}){Text("移除此物料")}}
 CustodyField("搜索物料名称或编号",search,100){search=it};AssignmentChoice("添加物料",itemId,listOf("" to "请选择原库存物料")+b.items.filter{i->lines.none{it.getString("inventoryItemId")==i.getString("id")}&&(search.isBlank()||i.getString("name").contains(search,true)||i.getString("sku").contains(search,true))}.map{it.getString("id") to "${it.getString("name")} · ${it.getString("baseUnit")}"}){itemId=it};SecondaryAction(onClick={if(b.items.any{it.getString("id")==itemId}&&lines.none{it.getString("inventoryItemId")==itemId}){lines=lines+JSONObject().put("inventoryItemId",itemId).put("quantity","1").put("expectedWasteQuantity","0");itemId=""}},enabled=itemId.isNotBlank()){Text("加入配方")};PrimaryAction(onClick={submit(outputQuantity.toIntOrNull()?:0,notes,lines)},enabled=m.canUseRecipeConfiguration){Text("核对配方")}
 }
}
