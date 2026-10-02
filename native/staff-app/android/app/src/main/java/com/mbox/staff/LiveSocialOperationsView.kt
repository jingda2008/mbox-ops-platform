package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
@Composable fun LiveSocialOperationsView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var area by remember{mutableStateOf(if(m.identity?.allows("member.card.manage")==true)"accounts"else "broadcasts")};var action by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadSocial(area)};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 val lifecycle=LocalLifecycleOwner.current
 DisposableEffect(lifecycle){val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_STOP){proposed=null;action="";selected=null}};lifecycle.lifecycle.addObserver(observer);onDispose{lifecycle.lifecycle.removeObserver(observer)}}
 fun propose(b:JSONObject){try{val board=m.socialBoard?:error("请读取原账号或任务");proposed=socialCommand(m.identity!!,CouponCalendarsBoard(JSONObject(board.data.toString()).put("rows",JSONArray(m.socialRows))),action,selected,b);error=""}catch(e:Exception){error=e.message?:"请核对配置与任务"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){
  Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
   item{Row{Text("微信账号与活动群发",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.socialState);if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
   when(action){
    "account"->item{SocialAccountForm(selected,{action=""},::propose)}
    "broadcast"->item{SocialBroadcastForm(m,{action=""},::propose)}
    "retry","transition"->item{SocialActionForm(action,selected!!,{action=""},::propose)}
    else->{
     item{AssignmentChoice("工作区",area,(if(m.identity?.allows("member.card.manage")==true)listOf("accounts" to "服务号 / 企业微信","events" to "平台回调")else emptyList())+(if(m.identity?.allows("community.activity.manage")==true)listOf("broadcasts" to "活动群发")else emptyList())){if(m.loadSocial(it)){area=it}};TextButton(onClick={m.loadSocial(area)},enabled=!m.busy){Text("刷新记录")};if(area in listOf("accounts","broadcasts"))TextButton(onClick={selected=null;action=if(area=="accounts")"account"else "broadcast"},enabled=m.canUseSocial){Text(if(area=="accounts")"新增账号"else "新建群发草稿")}}
     items(if(m.socialBoard?.data?.textOrNull("area")==area)m.socialRows else emptyList(),key={it.getString("id")}){r->Panel{
      when(area){
       "accounts"->{Text(r.getString("name"),style=MaterialTheme.typography.titleMedium);Text("${socialKinds.toMap()[r.getString("kind")]} · ${if(r.getBoolean("enabled"))"启用"else "停用"}");Text(r.getString("appId"));Text("回调地址：在本站正式域名后加 /api/social-accounts/${r.getString("id")}/callback",style=MaterialTheme.typography.bodySmall);Text("取酒验证码模板：${r.textOrNull("codeTemplateId")?:"未配置"}\n存酒到期提醒模板：${r.textOrNull("reminderTemplateId")?:"未配置"}");TextButton(onClick={selected=r;action="account"},enabled=m.canUseSocial){Text("编辑配置 / 更换密钥")}}
       "events"->{Text(r.getString("accountName"),style=MaterialTheme.typography.titleMedium);Text("${r.getString("eventType")} · ${socialStates[r.getString("status")]?:r.getString("status")}");Text(calendarLocal(r.getString("receivedAt")));r.textOrNull("errorCode")?.let{Text("处理错误：$it")};if(r.getString("status")=="failed")TextButton(onClick={selected=r;action="retry"},enabled=m.canUseSocial){Text("核对后重试处理")}}
       "broadcasts"->{Text(r.getString("title"),style=MaterialTheme.typography.titleMedium);Text(r.getString("accountName"));Text(socialStates[r.getString("status")]?:r.getString("status"));Text(r.getString("content"));Text("安排时间：${calendarLocal(r.getString("scheduledAt"))}");r.textOrNull("providerReference")?.let{Text("渠道凭证：$it",style=MaterialTheme.typography.bodySmall)};r.textOrNull("errorCode")?.let{Text("渠道状态：$it")};if(r.getString("status") in listOf("draft","scheduled"))TextButton(onClick={selected=r;action="transition"},enabled=m.canUseSocial){Text(if(r.getString("status")=="draft")"核对安排 / 取消"else "取消未发送任务")}}
      }
     }}
     if(m.socialBoard?.next!=null)item{TextButton(onClick={m.loadSocial(area,true)},enabled=!m.busy){Text("加载更多")}}
    }
   }
  }}
 }
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认微信运营操作")},text={Text(c.steps[0].socialOperationsProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;action="";selected=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
@Composable private fun SocialAccountForm(row:JSONObject?,back:()->Unit,submit:(JSONObject)->Unit){
 var f by remember(row){mutableStateOf(row?.let{JSONObject(it.toString())}?:JSONObject().put("kind","service_account").put("name","").put("appId","").put("enabled",false).put("codeTemplateId",JSONObject.NULL).put("codeDataKey","number1").put("reminderTemplateId",JSONObject.NULL).put("reminderDataKey","thing1"))};var secret by remember{mutableStateOf("")};var token by remember{mutableStateOf("")};var aes by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")};fun change(k:String,v:Any){f=JSONObject(f.toString()).put(k,v)}
 Panel{
  Text(if(row==null)"新增微信账号"else "编辑 ${row.getString("name")}",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回")}
  if(row==null){AssignmentChoice("账号类型",f.getString("kind"),socialKinds){change("kind",it)};CustodyField("服务号 AppID / 企微 CorpID",f.getString("appId"),128){change("appId",it)}}else Text("${socialKinds.toMap()[f.getString("kind")]} · ${f.getString("appId")}")
  CustodyField("显示名称",f.getString("name"),80){change("name",it)};Row{Switch(f.getBoolean("enabled"),{change("enabled",it)});Text("启用账号")};Text("已有密钥不回显；三项全部留空保留原密钥。更换时须填写完整三项。",style=MaterialTheme.typography.bodySmall)
  for((label,value,update)in listOf(Triple("AppSecret / 企微 Secret",secret,{v:String->secret=v}),Triple("回调 Token",token,{v:String->token=v}),Triple("EncodingAESKey（43位）",aes,{v:String->aes=v}))){OutlinedTextField(value,update,label={Text(label)},visualTransformation=PasswordVisualTransformation(),singleLine=true,modifier=Modifier.fillMaxWidth())}
  Text("服务号取酒验证码与存酒到期提醒使用一次性订阅模板。保存后仍须核验真实平台配置。",style=MaterialTheme.typography.bodySmall)
  for((k,label)in listOf("codeTemplateId" to "取酒验证码订阅模板ID（可空）","codeDataKey" to "验证码数据字段，如 number1","reminderTemplateId" to "存酒到期提醒订阅模板ID（可空）","reminderDataKey" to "提醒数据字段，如 thing1"))CustodyField(label,f.textOrNull(k)?:"",128){change(k,if(it.isBlank()&&k.endsWith("TemplateId"))JSONObject.NULL else it)}
  CustodyField("配置依据",reason,500){reason=it};Text(error,color=MaterialTheme.colorScheme.error);TextButton(onClick={try{val b=JSONObject();for(k in listOf("kind","name","appId","enabled","codeTemplateId","codeDataKey","reminderTemplateId","reminderDataKey"))b.put(k,f.get(k));b.put("reason",reason);if(secret.isNotEmpty()||token.isNotEmpty()||aes.isNotEmpty())b.put("credentials",JSONObject().put("secret",secret).put("token",token).put("encodingAesKey",aes));submit(b)}catch(e:Exception){error=e.message?:"请核对完整配置"}}){Text("继续核对")}
 }
}
@Composable private fun SocialActionForm(action:String,row:JSONObject,back:()->Unit,submit:(JSONObject)->Unit){
 var decision by remember{mutableStateOf(if(row.getString("status")=="draft")"schedule"else "cancel")};var confirmed by remember{mutableStateOf(false)};var reason by remember{mutableStateOf("")}
 Panel{Text(if(action=="retry")"重新处理原回调"else "核对原群发",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回")};Text(row.getString("accountName"));if(action=="transition"){Text(row.getString("title"));Text(row.getString("content"));Text(calendarLocal(row.getString("scheduledAt")));AssignmentChoice("操作",decision,(if(row.getString("status")=="draft")listOf("schedule" to "安排发送")else emptyList())+listOf("cancel" to "取消未发送任务")){decision=it;confirmed=false};if(decision=="schedule")Row{Checkbox(confirmed,{confirmed=it});Text("已核对内容，并确认面向该服务号全部关注者")}}else Text("只重试此条失败的回调处理，不伪造平台事实。");CustodyField("操作依据",reason,500){reason=it};TextButton(onClick={submit(JSONObject().put("reason",reason).apply{if(action=="transition")put("action",decision).put("audienceConfirmed",confirmed)})}){Text("继续核对")}}
}
@Composable private fun SocialBroadcastForm(m:AppModel,back:()->Unit,submit:(JSONObject)->Unit){
 val scope=rememberCoroutineScope();var accounts by remember{mutableStateOf<List<JSONObject>>(emptyList())};var next by remember{mutableStateOf<String?>(null)};var account by remember{mutableStateOf<JSONObject?>(null)};var search by remember{mutableStateOf("")};var loading by remember{mutableStateOf(false)};var title by remember{mutableStateOf("")};var content by remember{mutableStateOf("")};var time by remember{mutableStateOf("")};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")}
 fun load(more:Boolean=false){if(loading)return;loading=true;scope.launch{try{val b=m.socialAccountOptions(search,if(more)next else null);accounts=if(more)accounts+b.rows else b.rows;next=b.next;error=""}catch(e:Exception){error=e.message?:"读取失败"}finally{loading=false}}};LaunchedEffect(Unit){load()}
 Panel{Text("新建群发草稿",style=MaterialTheme.typography.titleMedium);TextButton(onClick=back){Text("返回")};Text(account?.let{"已选择：${it.getString("name")}"}?:"请选择本店服务号");CustodyField("按账号名称查找",search,80){if(!loading){search=it;accounts=emptyList();next=null}};TextButton(onClick={load()},enabled=!loading){Text("查询账号")};for(a in accounts)TextButton(onClick={account=a},enabled=!loading){Text("${a.getString("name")} · ${if(a.getBoolean("enabled"))"启用"else "停用，需启用才能发送"}")};if(next!=null)TextButton(onClick={load(true)},enabled=!loading){Text("更多账号")};CustodyField("内部标题",title,80){title=it};OutlinedTextField(content,{content=it.take(600)},label={Text("向关注者发送的内容，最多600字")},minLines=3,modifier=Modifier.fillMaxWidth());CustodyField("安排时间（北京时间 YYYY-MM-DD HH:mm）",time,29){time=it};CustodyField("建立草稿的依据",reason,500){reason=it};Text("保存草稿不会发送。安排群发时还须核对全部关注者范围。",style=MaterialTheme.typography.bodySmall);Text(error,color=MaterialTheme.colorScheme.error);TextButton(onClick={try{submit(JSONObject().put("accountId",account!!.getString("id")).put("title",title).put("content",content).put("scheduledAt",performanceTime(time)).put("reason",reason))}catch(e:Exception){error=e.message?:"请核对发送时间"}},enabled=account!=null){Text("核对草稿")}}
}
