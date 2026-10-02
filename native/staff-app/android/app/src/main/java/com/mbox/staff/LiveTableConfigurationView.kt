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

@Composable fun LiveTableConfigurationView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var tab by remember{mutableStateOf("tables")};var search by remember{mutableStateOf("")};var editing by remember{mutableStateOf<JSONObject?>(null)};var create by remember{mutableStateOf(false)};var notice by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadTableConfiguration()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion){proposed=null;close()}}
 if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 fun propose(work:()->LiveCommand){try{proposed=work();notice=""}catch(e:Exception){notice=e.message.orEmpty()}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("区域与桌台配置",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.tableConfigurationState);if(notice.isNotBlank())Text(notice,color=MaterialTheme.colorScheme.error)
   AssignmentChoice("配置对象",tab,listOf("tables" to "桌台","areas" to "区域")){tab=it;editing=null;create=false};CustodyField("搜索编号或名称",search,100){search=it}
   Row{TextButton(onClick={editing=null;create=false;m.loadTableConfiguration()},enabled=!m.busy){Text("刷新原配置")};TextButton(onClick={editing=null;create=true},enabled=m.canUseTableConfiguration){Text(if(tab=="tables")"新增桌台" else "新增区域")}}
   Text("营业中桌台需结束原桌次后再调整配置。修改保留原桌台身份、位置布局和二维码绑定；更改桌号后，须同步更换现场桌牌并核对扫码显示。")
  }
  m.tableConfigurationBoard?.let{board->
   if(create||editing!=null)item{key(tab,editing?.getString("id")?:"new",editing?.getString("updatedAt")){TableConfigurationEditor(m,board,tab=="tables",editing,{editing=null;create=false},::propose)}}
   val rows=(if(tab=="tables")board.tables else board.areas).filter{search.isBlank()||it.getString("code").contains(search,true)||(it.textOrNull(if(tab=="tables")"displayName" else "name")?:"").contains(search,true)}
   for(row in rows)item{Panel{Text("${row.getString("code")} · ${row.getString(if(tab=="tables")"displayName" else "name")}",style=MaterialTheme.typography.titleMedium)
    if(tab=="tables"){Text("${row.getString("areaName")} · 容量${row.getInt("capacity")}人 · ${tableStates[row.getString("status")]}");Text(if(row.textOrNull("activeSessionId")!=null)"正在营业 · ${row.getInt("activeGuestCount")}人" else "当前未开台");row.textOrNull("minimumSpendMinor")?.toLong()?.let{Text("最低消费参考 ${loyaltyRefundMoney(it)}")}}
    else Text("${areaTypes[row.getString("areaType")]} · ${areaStates[row.getString("status")]} · 排序${row.getInt("sortOrder")}")
    SecondaryAction(onClick={create=false;editing=JSONObject(row.toString())},enabled=m.canUseTableConfiguration){Text("查看与修改")}
   }}
   if(rows.isEmpty())item{Text("没有符合条件的记录")}
  }
 }}}
 proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text(command.title)},text={Text(command.steps[0].tableConfigurationProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;editing=null;create=false;m.executeLive(command)},enabled=m.canExecuteLive(command)){Text("确认保存")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回")}})}
}
@Composable private fun TableConfigurationEditor(m:AppModel,board:TableConfigurationBoard,table:Boolean,row:JSONObject?,close:()->Unit,propose:(()->LiveCommand)->Unit){
 var code by remember{mutableStateOf(row?.getString("code")?:"")};var name by remember{mutableStateOf(row?.getString(if(table)"displayName" else "name")?:"")};var area by remember{mutableStateOf(row?.textOrNull("areaId")?:"")};var type by remember{mutableStateOf(row?.textOrNull("areaType")?:"indoor")};var capacity by remember{mutableStateOf(row?.optInt("capacity")?.toString()?:"4")};var minimum by remember{mutableStateOf(row?.let{if(table)ownerAmount(it,"minimumSpendMinor") else ""}?:"")};var sort by remember{mutableStateOf(row?.optInt("sortOrder")?.toString()?:"0")};var state by remember{mutableStateOf(row?.getString("status")?:if(table)"available" else "active")};var reason by remember{mutableStateOf("")}
 Panel{Text(if(row==null)"新增${if(table)"桌台" else "区域"}" else "修改 ${row.getString("code")}",style=MaterialTheme.typography.titleMedium)
  if(table||row==null)CustodyField("编号",code,32){code=it};CustodyField("显示名称",name,120){name=it}
  if(table){AssignmentChoice("所在区域",area,listOf("" to "请选择区域")+board.areas.map{it.getString("id") to (it.getString("name")+" · "+areaStates[it.getString("status")])}){area=it};CustodyField("容量（人）",capacity,3){capacity=it};CustodyField("最低消费参考（元，可留空）",minimum,12){minimum=it}}
  else{AssignmentChoice("区域类型",type,areaTypes.toList()){type=it};CustodyField("排序",sort,7){sort=it}}
  AssignmentChoice("状态",state,(if(table)tableStates else areaStates).toList()){state=it};CustodyField("修改原因",reason,500){reason=it}
  PrimaryAction(onClick={propose{val action=(if(table)"table" else "area")+if(row==null)"-create" else "-update";val body=JSONObject().put("reason",reason.trim()).put("status",state).put(if(table)"displayName" else "name",name.trim());if(table||row==null)body.put("code",code.trim());if(row!=null)body.put(if(table)"tableId" else "areaId",row.getString("id")).put("expectedUpdatedAt",row.getString("updatedAt"));if(table)body.put("areaId",area).put("capacity",capacity.toIntOrNull()?:error("容量须为整数")).put("minimumSpendMinor",if(minimum.isBlank())JSONObject.NULL else ownerMoney(minimum)) else body.put("areaType",type).put("sortOrder",sort.toIntOrNull()?:error("排序须为整数"));tableConfigurationCommand(m.identity!!,board,action,body,"保存${if(table)"桌台" else "区域"}配置\n${code.trim()} · ${name.trim()}\n状态 ${(if(table)tableStates else areaStates)[state]}${if(table)" · 容量${capacity}人" else ""}\n${reason.trim()}\n不转移历史账单、在用桌次或二维码归属。")}},enabled=m.canUseTableConfiguration){Text("核对后保存")};TextButton(onClick=close){Text("收起表单")}
 }
}
