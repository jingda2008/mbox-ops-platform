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
@Composable fun LiveMemberNumberView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var draft by remember{mutableStateOf<JSONObject?>(null)};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadMemberNumber()};LaunchedEffect(m.memberNumberBoard){draft=m.memberNumberBoard?.getJSONObject("row")?.getJSONObject("policy")?.let{JSONObject(it.toString())};reason=""};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("会员号规则",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.memberNumberState);TextButton(onClick={m.loadMemberNumber()},enabled=!m.busy){Text("刷新配置，放弃未保存修改")};Text("数字用尽后按字母前缀继续发号，原会员号保持不变。候选号可能已被占用，实际发号时自动跳过。",style=MaterialTheme.typography.bodySmall)}
 draft?.let{p->item{Panel{
  for((k,label,max)in listOf(Triple("width","总位数（4至12）",2),Triple("startNumber","起始数字",12),Triple("maximumPrefixLength","最长字母前缀（0至4）",1),Triple("alphabet","字母顺序（大写A至Z，不重复）",26)))CustodyField(label,p.get(k).toString(),max){draft=JSONObject(p.toString()).put(k,if(k=="alphabet")it.uppercase(java.util.Locale.ROOT)else it)}
  Row{Checkbox(p.getBoolean("padZero"),{draft=JSONObject(p.toString()).put("padZero",it)});Text("不足位数补零")};Text("已保存规则的下一个候选号：${m.memberNumberBoard?.getJSONObject("row")?.textOrNull("nextCandidate")?:"号段已用尽，需调整配置"}");CustodyField("变更原因",reason,300){reason=it};Text(error,color=MaterialTheme.colorScheme.error)
  PrimaryAction(onClick={try{val normalized=JSONObject(p.toString());for(k in listOf("width","startNumber","maximumPrefixLength"))normalized.put(k,p.get(k).toString().toLong());proposed=memberNumberCommand(m.identity!!,m.memberNumberBoard!!,normalized,reason);error=""}catch(e:Exception){error=e.message?:"请核对号段参数"}},enabled=m.canUseMemberNumber){Text("核对会员号规则")}
 }}}
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text(c.title)},text={Text(c.steps[0].memberNumberProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认保存")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回")}})}
}
