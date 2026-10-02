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
@Composable fun AnnualDraftEditor(m:AppModel,code:String,original:JSONObject?,back:()->Unit,submit:(JSONObject)->Unit){
 var rules by remember(original){mutableStateOf(original?.getJSONArray("rules")?.objects()?.map{JSONObject(it.toString())}?:listOf(newAnnualRule()))};var timezone by remember(original){mutableStateOf(original?.getString("timezone")?:"Asia/Shanghai")};var reason by remember{mutableStateOf("")};var expanded by remember{mutableStateOf(0)};var picker by remember{mutableStateOf("")};var pickerIndex by remember{mutableStateOf(-1)};var error by remember{mutableStateOf("")}
 fun change(index:Int,k:String,v:Any){rules=rules.mapIndexed{i,r->if(i==index)JSONObject(r.toString()).put(k,v)else r}}
 Panel{
 Text("$code · 新版完整草稿",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回，放弃未保存草稿")};CustodyField("规则计算时区",timezone,64){timezone=it};Text("复制会保留全部规则，包括停用项。改变类型后请重新核对所有履约条件。",style=MaterialTheme.typography.bodySmall)
 for((index,r)in rules.withIndex()){HorizontalDivider();TextButton(onClick={expanded=if(expanded==index)-1 else index}){Text("规则 ${index+1} · ${r.getString("title").ifBlank{"待填写"}} · ${if(r.getBoolean("enabled"))"启用"else "停用"}")};if(expanded==index){
 CustodyField("规则编号（大写字母开头）",r.getString("ruleCode"),64){change(index,"ruleCode",it)};CustodyField("名称",r.getString("title"),120){change(index,"title",it)}
 AssignmentChoice("类型",r.getString("ruleKind"),annualKinds){kind->val n=JSONObject(r.toString()).put("ruleKind",kind).put("feb29Policy",if(kind=="birthday")"feb28"else JSONObject.NULL).put("reservationHoldMinutes",if(kind=="priority_seating")15 else JSONObject.NULL).put("redemptionHoldMinutes",if(kind=="daily_snack")15 else JSONObject.NULL);when(kind){"birthday","festival"->n.put("stackGroup","festival_gift");"priority_seating"->n.put("onSiteOnly",false).put("requiresTableSession",false).put("inventoryRequirement","not_applicable").put("substitutes",JSONArray()).put("stackGroup","priority_seating");"daily_snack"->n.put("onSiteOnly",true).put("requiresTableSession",true).put("alcoholHandling","not_applicable").put("validityDays",1).put("windowBeforeDays",0).put("windowAfterDays",0).put("inventoryRequirement","strict_recipe").put("stackGroup","daily_snack")};rules=rules.mapIndexed{i,old->if(i==index)n else old}}
 AssignmentChoice("适用等级",r.getString("eligibleTier"),annualTiers){change(index,"eligibleTier",it)};Text("关联权益：${r.textOrNull("benefitDefinitionName")?:r.getString("benefitDefinitionId").ifBlank{"尚未选择"}}");TextButton(onClick={pickerIndex=index;picker="definitions"}){Text("选择已启用权益定义")};Text("优先订座须选预约优先权益，每日点心须选绑定商品的赠品权益。",style=MaterialTheme.typography.bodySmall)
 for((k,label)in annualBooleans)Row{Checkbox(r.getBoolean(k),{change(index,k,it)});Text(label,Modifier.weight(1f))}
 for((k,label)in annualNumeric)CustodyField(label,r.get(k).toString(),5){change(index,k,it)}
 AssignmentChoice("酒水处理",r.getString("alcoholHandling"),annualAlcohol){change(index,"alcoholHandling",it)};AssignmentChoice("库存要求",r.getString("inventoryRequirement"),annualInventory){change(index,"inventoryRequirement",it)};AssignmentChoice("撤销规则",r.getString("revocationPolicy"),annualRevocation){change(index,"revocationPolicy",it)};CustodyField("叠加组（小写编号）",r.getString("stackGroup"),64){change(index,"stackGroup",it)}
 if(r.getString("ruleKind")=="birthday")AssignmentChoice("2月29日生日",r.getString("feb29Policy"),annualFeb){change(index,"feb29Policy",it)}
 for((kind,k,label)in listOf(Triple("priority_seating","reservationHoldMinutes","订座保留分钟（5至30）"),Triple("daily_snack","redemptionHoldMinutes","点心暂留分钟（5至30）")))if(r.getString("ruleKind")==kind)CustodyField(label,if(r.isNull(k))""else r.get(k).toString(),2){change(index,k,it)}
 Text("替代商品（最多20种，均需满足正式配方和库存条件）");val subs=r.getJSONArray("substitutes").objects();for((i,sub)in subs.withIndex()){Text(sub.textOrNull("productName")?:sub.getString("productId"));CustodyField("替代优先级（1至32767）",sub.get("priority").toString(),5){v->change(index,"substitutes",JSONArray(subs.mapIndexed{j,p->if(j==i)JSONObject(p.toString()).put("priority",v)else p}))};CustodyField("替代依据",sub.getString("reason"),240){v->change(index,"substitutes",JSONArray(subs.mapIndexed{j,p->if(j==i)JSONObject(p.toString()).put("reason",v)else p}))};TextButton(onClick={change(index,"substitutes",JSONArray(subs.filterIndexed{j,_->j!=i}))}){Text("移除此替代品")}}
 TextButton(onClick={pickerIndex=index;picker="products"},enabled=subs.size<20){Text("添加无酒精替代品")};if(rules.size>1)TextButton(onClick={rules=rules.filterIndexed{i,_->i!=index};expanded=-1}){Text("从此新草稿移除此规则")}
 }}
 TextButton(onClick={rules=rules+newAnnualRule();expanded=rules.lastIndex},enabled=rules.size<100){Text("添加规则（${rules.size}/100）")};CustodyField("起草依据",reason,500){reason=it};Text(error,color=MaterialTheme.colorScheme.error);PrimaryAction(onClick={try{submit(JSONObject().put("policyCode",code).put("timezone",timezone).put("reason",reason).put("rules",JSONArray(rules.map(::normalizeAnnualRule))))}catch(e:Exception){error=e.message?:"请核对完整权益规则"}},enabled=m.canUseAnnualPolicies&&m.annualPolicyBoard?.data?.textOrNull("code")==code){Text("核对完整草稿")}
 }
 if(picker.isNotBlank()&&pickerIndex in rules.indices)AnnualOptionPicker(m,picker,{picker=""}){p->val index=pickerIndex;val r=rules[index];if(picker=="definitions"){val n=JSONObject(r.toString()).put("benefitDefinitionId",p.getString("id")).put("benefitDefinitionName",p.getString("name"));rules=rules.mapIndexed{i,old->if(i==index)n else old}}else{val subs=r.getJSONArray("substitutes").objects();if(subs.none{it.getString("productId")==p.getString("id")})change(index,"substitutes",JSONArray(subs+JSONObject().put("productId",p.getString("id")).put("productName",p.getString("name")).put("priority",subs.size+1).put("reason","")))};picker=""}
}
@Composable private fun AnnualOptionPicker(m:AppModel,kind:String,close:()->Unit,select:(JSONObject)->Unit){
 val scope=rememberCoroutineScope();var search by remember{mutableStateOf("")};var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.annualPolicyOptions(kind,search,if(more)next else null);rows=if(more)rows+b.rows else b.rows;next=b.next;error=""}catch(e:Exception){error=e.message?:"读取失败"}finally{loading=false}}};LaunchedEffect(Unit){load()}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Text(if(kind=="definitions")"选择权益定义"else "选择无酒精替代品",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};CustodyField("名称包含",search,80){if(!loading){search=it;rows=emptyList();next=null}};TextButton(onClick={load()},enabled=!loading){Text("搜索")};Text(error);if(rows.isEmpty()&&!loading&&error.isBlank())Text("没有符合条件的记录")};items(rows,key={it.getString("id")}){p->OutlinedButton(onClick={select(p)},enabled=!loading,modifier=Modifier.fillMaxWidth()){Text(p.getString("name")+(p.textOrNull("benefitKind")?.let{" · "+(mapOf("reservation_priority" to "预约优先","gift_product" to "赠品","service_experience" to "服务体验","discount" to "折扣")[it]?:it)}?:""))}};if(next!=null)item{TextButton(onClick={load(true)},enabled=!loading){Text("加载更多")}}
 }}}
}
