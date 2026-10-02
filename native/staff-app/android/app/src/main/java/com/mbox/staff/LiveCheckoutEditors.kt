package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable fun CheckoutRuleEditor(m:AppModel,code:String,row:JSONObject?,back:()->Unit,submit:(JSONObject)->Unit){
 val q=row?.optJSONObject("qualification");var f by remember(row){mutableStateOf(JSONObject().apply{for(k in listOf("name","sourceProductId","targetProductId","promptTitle","promptBody","callToAction"))put(k,row?.textOrNull(k)?:"");for((k,default)in listOf("minimumPartySize" to 1,"maximumPartySize" to 8,"priority" to 100,"offerValidMinutes" to 10))put(k,row?.getInt(k)?.toString()?:default.toString());put("margin",row?.getInt("minimumGrossMarginBasisPoints")?.let(::checkoutDecimal)?:"");for(k in listOf("occasionTags","alcoholPreferenceTags"))put(k,row?.getJSONArray(k)?:JSONArray());for(k in listOf("maximumAddMinor","minimumContributionMinor","minimumIncrementalContributionMinor"))put(k,q?.getLong(k)?.let(::checkoutDecimal)?:"");put("relative",if(q==null||q.isNull("maximumAddBasisPoints"))""else checkoutDecimal(q.getInt("maximumAddBasisPoints")));put("positiveFitReason",q?.getString("positiveFitReason")?:"");put("maximumQuantitiesPerPerson",q?.getJSONArray("maximumQuantitiesPerPerson")?:JSONArray());put("excludedProductIds",q?.getJSONArray("excludedProductIds")?:JSONArray())})};var names by remember{mutableStateOf<Map<String,String>>(emptyMap())};var picker by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")}
 fun change(k:String,v:Any){f=JSONObject(f.toString()).put(k,v)}
 fun name(id:String)=names[id]?:m.checkoutManagementProducts[id]?.getString("name")?:if(row?.textOrNull("sourceProductId")==id)row.getString("sourceProductName")else if(row?.textOrNull("targetProductId")==id)row.getString("targetProductName")else "原商品（${id.take(8)}）"
 Panel{
  Text("$code · 新版升级规则",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回")};CustodyField("规则名称",f.getString("name"),80){change("name",it)}
  for((k,label)in listOf("sourceProductId" to "原酒水","targetProductId" to "目标套餐")){Text("$label：${f.getString(k).takeIf{it.isNotBlank()}?.let(::name)?:"未选择"}");TextButton(onClick={picker=k}){Text("选择$label")}}
  for((k,label)in listOf("minimumPartySize" to "最少人数（1至200）","maximumPartySize" to "最多人数（1至200）"))CustodyField(label,f.getString(k),3){change(k,it)}
  for((k,label,options)in listOf(Triple("occasionTags","适配场景（不选表示不限）",checkoutOccasions),Triple("alcoholPreferenceTags","酒水偏好（不选表示不限）",checkoutAlcohol))){Text(label);for((v,l)in options){val selected=f.getJSONArray(k).strings();Row{Checkbox(v in selected,{checked->change(k,JSONArray(if(checked)selected+v else selected-v))});Text(l)}}}
  for((k,label,max)in listOf(Triple("promptTitle","顾客提示标题",60),Triple("promptBody","顾客提示内容",240),Triple("callToAction","顾客按键文字",30)))OutlinedTextField(f.getString(k),{change(k,it.take(max))},label={Text(label)},minLines=if(k=="promptBody")3 else 1,modifier=Modifier.fillMaxWidth())
  for((k,label,max)in listOf(Triple("priority","优先级（0至10000）",5),Triple("offerValidMinutes","报价有效分钟（2至30）",2),Triple("margin","最低毛利率（%，最多两位小数）",7)))CustodyField(label,f.getString(k),max){change(k,it)}
  Text("明确的匹配与价格准入条件",style=MaterialTheme.typography.titleMedium)
  for((k,label)in listOf("maximumAddMinor" to "最多加价（元）","minimumContributionMinor" to "最低贡献额（元）","minimumIncrementalContributionMinor" to "最低新增贡献额（元）","relative" to "最多相对加价（%，留空不限）"))CustodyField(label,f.getString(k),20){change(k,it)}
  OutlinedTextField(f.getString("positiveFitReason"),{change("positiveFitReason",it.take(500))},label={Text("正向匹配依据，不能只填优先级")},minLines=3,modifier=Modifier.fillMaxWidth())
  Text("新增商品人均份量上限（至少一项）")
  for((index,p)in f.getJSONArray("maximumQuantitiesPerPerson").objects().withIndex())Row{Column(Modifier.weight(1f)){Text(name(p.getString("productId")));CustodyField("每人最多份数（1至100）",p.optString("quantity"),3){v->val all=f.getJSONArray("maximumQuantitiesPerPerson").objects().mapIndexed{i,r->if(i==index)JSONObject(r.toString()).put("quantity",v)else r};change("maximumQuantitiesPerPerson",JSONArray(all))}};TextButton(onClick={change("maximumQuantitiesPerPerson",JSONArray(f.getJSONArray("maximumQuantitiesPerPerson").objects().filterIndexed{i,_->i!=index}))}){Text("移除")}}
  TextButton(onClick={picker="portion"},enabled=f.getJSONArray("maximumQuantitiesPerPerson").length()<100){Text("添加份量上限商品")}
  Text("排除商品")
  for(id in f.getJSONArray("excludedProductIds").strings())Row{Text(name(id),Modifier.weight(1f));TextButton(onClick={change("excludedProductIds",JSONArray(f.getJSONArray("excludedProductIds").strings()-id))}){Text("移除")}}
  TextButton(onClick={picker="excluded"},enabled=f.getJSONArray("excludedProductIds").length()<100){Text("添加排除商品")};CustodyField("建立本版本的依据",reason,240){reason=it};Text(error,color=MaterialTheme.colorScheme.error)
  TextButton(onClick={try{val b=JSONObject().put("code",code).put("reason",reason);for(k in listOf("name","sourceProductId","targetProductId","promptTitle","promptBody","callToAction","occasionTags","alcoholPreferenceTags"))b.put(k,f.get(k));for(k in listOf("minimumPartySize","maximumPartySize","priority","offerValidMinutes"))b.put(k,f.getString(k).toInt());b.put("minimumGrossMarginBasisPoints",checkoutMoney(f.getString("margin")));val limits=JSONObject();for(k in listOf("maximumAddMinor","minimumContributionMinor","minimumIncrementalContributionMinor"))limits.put(k,checkoutMoney(f.getString(k)));limits.put("maximumAddBasisPoints",if(f.getString("relative").isBlank())JSONObject.NULL else checkoutMoney(f.getString("relative")));limits.put("positiveFitReason",f.getString("positiveFitReason")).put("excludedProductIds",f.getJSONArray("excludedProductIds")).put("maximumQuantitiesPerPerson",JSONArray(f.getJSONArray("maximumQuantitiesPerPerson").objects().map{JSONObject().put("productId",it.getString("productId")).put("quantity",it.get("quantity").toString().toInt())}));b.put("qualification",limits);submit(b)}catch(e:Exception){error=e.message?:"请核对金额、人数与份量上限"}},enabled=m.canUseCheckoutManagement){Text("核对新版草稿")}
 }
 if(picker.isNotBlank())CheckoutProductPicker(m,picker=="targetProductId",{picker=""}){p->val id=p.getString("id");names=names+(id to p.getString("name"));when(picker){"portion"->{val old=f.getJSONArray("maximumQuantitiesPerPerson").objects();if(old.none{it.getString("productId")==id})change("maximumQuantitiesPerPerson",JSONArray(old+JSONObject().put("productId",id).put("quantity",1)))};"excluded"->change("excludedProductIds",JSONArray((f.getJSONArray("excludedProductIds").strings()+id).distinct()));else->change(picker,id)};picker=""}
}
@Composable private fun CheckoutProductPicker(m:AppModel,bundlesOnly:Boolean,close:()->Unit,select:(JSONObject)->Unit){
 val scope=rememberCoroutineScope();var search by remember{mutableStateOf("")};var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")}
 fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.checkoutProductOptions(search,if(more)next else null);rows=if(more)rows+b.rows else b.rows;next=b.next;error=""}catch(e:Exception){error=e.message?:"读取失败"}finally{loading=false}}};LaunchedEffect(Unit){load()}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp)){
  item{Text(if(bundlesOnly)"选择目标套餐"else "选择商品",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};CustodyField("名称或商品编码（部分文字）",search,80){if(!loading){search=it;rows=emptyList();next=null}};TextButton(onClick={load()},enabled=!loading){Text("查找")};Text(error)}
  items(rows.filter{!bundlesOnly||it.getString("kind")=="bundle"},key={it.getString("id")}){p->TextButton(onClick={select(p)},enabled=!loading){Text("${p.getString("name")} · ${p.getString("code")}")}}
  if(next!=null)item{TextButton(onClick={load(true)},enabled=!loading){Text("加载更多商品")}}
 }}}
}
@Composable fun CheckoutCapacityEditor(back:()->Unit,submit:(JSONObject)->Unit){
 var station by remember{mutableStateOf("bar")};var windows by remember{mutableStateOf(listOf(JSONObject().put("startsAt","").put("endsAt","").put("capacityLimitUnits","")))};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")}
 Panel{Text("新建产能时间窗",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回")};AssignmentChoice("站点",station,checkoutStations){station=it};Text("时间均为北京时间；最多96个窗口，同一策略不能重叠。产能单位沿用原后台计算方式。",style=MaterialTheme.typography.bodySmall)
  for((index,w)in windows.withIndex()){Text("窗口 ${index+1}");for((k,label,max)in listOf(Triple("startsAt","开始（YYYY-MM-DD HH:mm）",29),Triple("endsAt","结束（YYYY-MM-DD HH:mm）",29),Triple("capacityLimitUnits","产能单位上限（1至1000000）",7)))CustodyField(label,w.getString(k),max){v->windows=windows.mapIndexed{i,r->if(i==index)JSONObject(r.toString()).put(k,v)else r}};if(windows.size>1)TextButton(onClick={windows=windows.filterIndexed{i,_->i!=index}}){Text("移除此窗口")}}
  TextButton(onClick={windows=windows+JSONObject().put("startsAt","").put("endsAt","").put("capacityLimitUnits","")},enabled=windows.size<96){Text("添加时间窗")};CustodyField("配置依据",reason,240){reason=it};Text(error,color=MaterialTheme.colorScheme.error);TextButton(onClick={try{submit(JSONObject().put("stationCode",station).put("reason",reason).put("windows",JSONArray(windows.map{JSONObject().put("startsAt",performanceTime(it.getString("startsAt"))).put("endsAt",performanceTime(it.getString("endsAt"))).put("capacityLimitUnits",it.getString("capacityLimitUnits").toInt())})))}catch(e:Exception){error=e.message?:"请核对窗口时间和产能"}}){Text("核对产能草稿")}
 }
}
