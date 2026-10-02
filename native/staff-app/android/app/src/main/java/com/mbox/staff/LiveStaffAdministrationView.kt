package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
import org.json.JSONArray
import java.time.OffsetDateTime

@Composable fun LiveStaffAdministrationView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var tab by remember{mutableStateOf("employees")};var search by remember{mutableStateOf("")};var selected by remember{mutableStateOf<JSONObject?>(null)};var action by remember{mutableStateOf("")};var notice by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 ClearSecretsOnBackground { proposed=null;action="";selected=null }
 LaunchedEffect(Unit){m.loadStaffAdministration()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun propose(work:()->LiveCommand){try{proposed=work();notice=""}catch(e:Exception){notice=e.message.orEmpty()}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("员工与岗位权限",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.staffAdministrationState);if(notice.isNotBlank())Text(notice,color=MaterialTheme.colorScheme.error)
   AssignmentChoice("管理项目",tab,listOf("employees" to "员工账号","roles" to "岗位权限","credential" to "门店口令")){tab=it;action="";selected=null};CustodyField("搜索姓名、账号或岗位",search,100){search=it};TextButton(onClick={action="";selected=null;m.loadStaffAdministration()},enabled=!m.busy){Text("刷新原配置")}}
  m.staffAdministrationBoard?.let{board->
   if(tab=="employees"){
    item{SecondaryAction(onClick={action="create";selected=null},enabled=m.canUseStaffAdministration){Text("新建员工")}}
    for(row in board.employees.filter{search.isBlank()||it.getString("displayName").contains(search,true)||it.getString("code").contains(search,true)})item{Panel{Text("${row.getString("displayName")} · ${row.getString("code")}");Text("${if(row.getString("status")=="active")"在职可登录" else "已暂停"} · ${row.getJSONArray("roleCodes").strings().joinToString()}");Row{TextButton(onClick={selected=row;action="status"},enabled=m.canUseStaffAdministration){Text("启停账号")};TextButton(onClick={selected=row;action="pin"},enabled=m.canUseStaffAdministration){Text("重置PIN")};TextButton(onClick={selected=row;action="override"},enabled=m.canUseStaffAdministration){Text("个人权限")}}}}
   }else if(tab=="roles")for(row in board.roles.filter{search.isBlank()||it.getString("name").contains(search,true)||it.getString("code").contains(search,true)})item{Panel{Text("${row.getString("name")} · ${row.getInt("memberCount")}名员工");SecondaryAction(onClick={selected=row;action="policy"},enabled=m.canUseStaffAdministration){Text("权限、额度、数据范围与入口")}}}
   else item{Text("口令变更后，使用旧口令验证的设备需要重新验证。口令不显示在历史回执中。");for(c in board.data.getJSONArray("credentials").objects())Text("有效期 ${c.getString("validFrom")} 至 ${c.getString("validUntil")}");SecondaryAction(onClick={selected=null;action="credential"},enabled=m.canUseStaffAdministration){Text("更换门店口令")}}
   if(action.isNotBlank())item{key(action,selected?.getString("id"),board.version){if(action=="policy"||action=="override")StaffPolicyEditor(m,board,selected!!,action=="override",::propose) else StaffAccountEditor(m,board,selected,action,::propose)}}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text("核对人员与权限修改")},text={Text(command.steps[0].staffAdministrationProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;selected=null;action="";m.executeLive(command)},enabled=m.canExecuteLive(command)){Text("确认提交")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回修改")}})}
}
@Composable private fun SecretField(label:String,value:String,change:(String)->Unit){OutlinedTextField(value=value,onValueChange=change,label={Text(label)},visualTransformation=PasswordVisualTransformation(),singleLine=true,modifier=Modifier.fillMaxWidth())}
@Composable private fun StaffAccountEditor(m:AppModel,b:StaffAdministrationBoard,row:JSONObject?,action:String,propose:(()->LiveCommand)->Unit){
 var code by remember{mutableStateOf("")};var name by remember{mutableStateOf("")};var secret by remember{mutableStateOf("")};var repeat by remember{mutableStateOf("")};var role by remember{mutableStateOf("")};var state by remember{mutableStateOf(row?.getString("status")?:"active")};var reason by remember{mutableStateOf("")};var from by remember{mutableStateOf(OffsetDateTime.now().withNano(0).toString())};var until by remember{mutableStateOf(OffsetDateTime.now().plusDays(1).withNano(0).toString())}
 Panel{Text(when(action){"create"->"建立员工账号";"status"->"调整账号状态";"pin"->"重置员工PIN";else->"更换门店口令"},style=MaterialTheme.typography.titleMedium);row?.let{Text("${it.getString("displayName")} · ${it.getString("code")}")}
  if(action=="create"){CustodyField("员工账号",code,64){code=it};CustodyField("姓名",name,64){name=it};AssignmentChoice("岗位",role,listOf("" to "请选择")+b.roles.filter{it.getString("status")=="active"}.map{it.getString("id") to it.getString("name")}){role=it}}
  if(action=="status")AssignmentChoice("状态",state,listOf("active" to "启用","suspended" to "暂停并禁止登录")){state=it}
  else{SecretField(if(action=="credential")"新门店口令" else "4位数字PIN",secret){secret=it};SecretField("再次输入",repeat){repeat=it}}
  if(action=="pin")Text("重置后该员工的已有登录全部失效，需要用新PIN重新登录。")
  if(action=="credential"){CustodyField("生效时间（含时区，如2026-10-01T09:00:00+08:00）",from,40){from=it};CustodyField("失效时间（含时区）",until,40){until=it}}
  CustodyField("修改原因",reason,200){reason=it};PrimaryAction(onClick={propose{require(action=="status"||secret==repeat){"两次输入不一致"};val body=JSONObject().put("reason",reason.trim());when(action){"create"->body.put("employeeCode",code.trim()).put("displayName",name.trim()).put("roleId",role).put("pin",secret);"status"->body.put("employeeId",row!!.getString("id")).put("status",state);"pin"->body.put("employeeId",row!!.getString("id")).put("pin",secret);"credential"->body.put("credential",secret).put("validFrom",staffCredentialTime(from)).put("validUntil",staffCredentialTime(until))};staffAdministrationCommand(m.identity!!,b,action,body,when(action){"create"->"建立员工：$name（$code）\n岗位：${b.roles.find{it.getString("id")==role}?.getString("name")}";"status"->"${row!!.getString("displayName")}：${if(state=="active")"启用" else "暂停"}";"pin"->"重置 ${row!!.getString("displayName")} 的PIN，已有登录全部失效";else->"更换门店口令\n$from 至 $until\n旧口令设备须重新验证"}+"\n原因：$reason")}},enabled=m.canUseStaffAdministration){Text("核对修改")}
 }
}
