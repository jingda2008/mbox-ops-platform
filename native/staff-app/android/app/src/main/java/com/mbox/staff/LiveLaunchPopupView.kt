package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable fun LiveLaunchPopupView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var draft by remember{mutableStateOf<JSONObject?>(null)};var reason by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)};var error by remember{mutableStateOf("")};var names by remember{mutableStateOf<Map<String,String>>(emptyMap())};var search by remember{mutableStateOf("")};var options by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var generation by remember{mutableStateOf(0)};val scope=rememberCoroutineScope()
 LaunchedEffect(Unit){m.loadLaunchPopup()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return;LaunchedEffect(m.launchPopupBoard){draft=m.launchPopupBoard?.row?.let{JSONObject(it.toString())};names=m.launchPopupBoard?.row?.getJSONArray("products")?.objects()?.associate{it.getString("id") to it.getString("name")}?:emptyMap()}
 fun change(k:String,v:Any){draft=JSONObject(draft!!.toString()).put(k,v)}
 fun load(more:Boolean=false){if(loading)return;val ticket=generation;loading=true;scope.launch{try{val b=m.launchPopupOptions(search,if(more)next else null);if(ticket==generation){options=(if(more)options+b.rows else b.rows).distinctBy{it.getString("id")};next=b.next;names=names+b.rows.associate{it.getString("id") to it.getString("name")};error=""}}catch(e:Exception){if(ticket==generation)error=e.message?:"商品查询失败"}finally{loading=false}}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("小程序打开弹窗",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.launchPopupState);TextButton(onClick={m.loadLaunchPopup()},enabled=!m.busy&&!loading){Text("重新读取，放弃本页未保存修改")};if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
 draft?.let{f->item{Panel{Row{Checkbox(f.getBoolean("enabled"),{change("enabled",it)});Text("启用打开弹窗")};CustodyField("标题",f.getString("title"),80){change("title",it)};OutlinedTextField(f.getString("content"),{change("content",it.take(1000))},label={Text("展示内容")},modifier=Modifier.fillMaxWidth(),minLines=3,maxLines=8);AssignmentChoice("展示频次",f.getString("frequency"),listOf("daily" to "每天首次打开","session" to "本次启动首次","always" to "每次回到小程序")){change("frequency",it)};Text("最多8款公共在售商品，按下列顺序展示；专属卡商品不在公共弹窗中出现。");val ids=f.getJSONArray("productIds").strings();for((i,id)in ids.withIndex())Row{Text("${i+1}. ${names[id]?:"已选商品，需核对"}",Modifier.weight(1f));TextButton(onClick={val list=ids.toMutableList();val x=list[i-1];list[i-1]=id;list[i]=x;change("productIds",JSONArray(list))},enabled=i>0){Text("上移")};TextButton(onClick={change("productIds",JSONArray(ids-id))}){Text("移除")}};CustodyField("调整原因",reason,500){reason=it};PrimaryAction(onClick={try{proposed=launchPopupCommand(m.identity!!,m.launchPopupBoard!!,f,reason);error=""}catch(e:Exception){error=e.message?:"请核对内容"}},enabled=m.canUseLaunchPopup&&!loading){Text("核对并保存弹窗")}}}
 item{Panel{CustodyField("查询公共商品名称或编号",search,80){search=it;generation++;options=emptyList();next=null};TextButton(onClick={load()},enabled=!loading&&!m.busy){Text(if(loading)"查询中"else "查询商品")};for(p in options){val ids=f.getJSONArray("productIds").strings();TextButton(onClick={change("productIds",JSONArray(ids+p.getString("id")))},enabled=ids.size<8&&p.getString("id") !in ids){Text(p.getString("name")+" · "+p.getString("code"))}};if(next!=null)TextButton(onClick={load(true)},enabled=!loading&&!m.busy){Text("加载更多商品")}}}
 }
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认顾客弹窗内容")},text={Text(c.steps[0].launchPopupProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认保存")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
