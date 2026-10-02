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
@Composable fun LiveFulfillmentHistoryView(m:AppModel,initial:String="prepared",close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};val scope=rememberCoroutineScope();var kind by remember{mutableStateOf(initial)};var date by remember{mutableStateOf("")};var table by remember{mutableStateOf("")};var data by remember{mutableStateOf<LiveHistory?>(null)};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};var itemID by remember{mutableStateOf<String?>(null)};var generation by remember{mutableIntStateOf(0)}
 fun reset(){generation++;data=null;error="";loading=false}
 fun load(page:Int=0){if(loading)return;val expected=++generation;val requestedKind=kind;val requestedDate=date;val requestedTable=table;loading=true;data=null;error="";scope.launch{try{val r=m.readFulfillmentHistory(requestedKind,requestedDate,requestedTable,page);if(expected==generation){data=r;date=r.date}}catch(e:Exception){if(expected==generation)error=e.message?:"历史读取失败，请重试"}finally{if(expected==generation)loading=false}}}
 LaunchedEffect(Unit){load()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("制作与送达历史",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};AssignmentChoice("记录类型",kind,listOf("prepared" to "本人制作","delivered" to "送达记录")){if(kind!=it){reset();kind=it;load()}};CustodyField("营业日（YYYY-MM-DD，空为当前）",date,10){if(!loading){reset();date=it}};CustodyField("桌号（可部分文字）",table,80){if(!loading){reset();table=it}};TextButton(onClick={load()},enabled=!loading){Text("查询 / 刷新")};if(loading)Text("正在读取历史");if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error);Text("本人记录只显示服务端核定的完成数量。共用取餐屏记录按可见桌台显示，不计入个人送达数量。",style=MaterialTheme.typography.bodySmall)}
 data?.let{h->
 val shared=h.source.optJSONArray("sharedDeliveries")?.objects()?:emptyList()
 if(kind=="delivered"){item{Text("共用取餐屏送达",style=MaterialTheme.typography.titleMedium);if(shared.isEmpty())Text("本页没有共用取餐屏送达记录")};items(shared,key={"shared:"+it.getString("receiptId")}){r->Panel{Text(r.getString("tableCode")+" · "+calendarLocal(r.getString("deliveredAt")));if(r.getString("pickupTableCode")!=r.getString("tableCode"))Text("取走时桌号："+r.getString("pickupTableCode"));for(i in r.getJSONArray("items").objects()){Text("${i.getString("name")} · 已送达 ${i.getInt("quantity")} 份"+if(i.getString("kind")=="remake")" · 重做"else "");for(k in listOf("specification","itemNote","orderNote"))i.getString(k).takeIf{it.isNotBlank()}?.let{Text(it)};if(m.canReadAfterSales)TextButton(onClick={itemID=i.getString("itemId")},enabled=!m.busy){Text("查看原商品处理")}}}}}
 item{Text(if(kind=="prepared")"本人制作记录"else "本人送达记录",style=MaterialTheme.typography.titleMedium);if(h.orders.isEmpty())Text("本页没有本人完成记录")}
 items(h.orders,key={"personal:"+it.getString("id")}){o->Panel{Text(o.getString("tableCode")+" · "+o.getString("publicId"));for(i in o.getJSONArray("items").objects()){val label=if(kind=="prepared")"制作"else "送达";Text(i.getString("name")+" · "+if(i.has("workQuantity"))"本人$label ${i.getInt("workQuantity")} 份"else "原单 ${i.getInt("quantity")} 份（本人数量未留存）");i.textOrNull("note")?.takeIf{it.isNotBlank()}?.let{Text("备注：$it")};i.textOrNull("fulfillmentClosureNote")?.let{Text(it)};Text((i.textOrNull(if(kind=="prepared")"preparedBy"else "deliveredBy")?:"员工信息未留存")+" · "+(i.textOrNull(if(kind=="prepared")"preparedAt"else "deliveredAt")?.let(::calendarLocal)?:"完成时间未留存"));if(m.canReadAfterSales)TextButton(onClick={itemID=i.getString("id")},enabled=!m.busy){Text("查看原商品处理")}}}}
 item{Row{TextButton(onClick={load(h.page-1)},enabled=!loading&&h.page>0){Text("上一页")};Text("第${h.page+1}页",Modifier.weight(1f));TextButton(onClick={load(h.page+1)},enabled=!loading&&h.hasMore&&h.page<2000){Text("下一页")}};Text("读取时间："+calendarLocal(h.source.getString("generatedAt")),style=MaterialTheme.typography.bodySmall)}
 }
 }}}
 itemID?.let{id->LiveAfterSalesView(m,id){itemID=null;load(data?.page?:0)}}
}
