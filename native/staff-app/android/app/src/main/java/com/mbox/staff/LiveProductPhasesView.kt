package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
@Composable fun LiveProductPhasesView(m:AppModel,product:String,name:String,close:()->Unit){
 val access=remember{m.priorityAccessKey};val version=remember{m.workspaceVersion};var phases by remember{mutableStateOf(emptyList<String>())};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(product){m.loadProductPhases(product)};LaunchedEffect(m.productPhasesBoard){m.productPhasesBoard?.takeIf{it.product==product}?.let{phases=it.phases;reason=""}};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||version!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||version!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("商品演出阶段",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(name);LivePendingView(m);Text(m.productPhasesState);TextButton(onClick={m.loadProductPhases(product)},enabled=!m.busy){Text("重新读取")}}
 if(m.productPhasesBoard?.product==product)item{Panel{Text("不选择表示不限演出阶段；这不是修改演出排期。");for((code,label)in productPhaseLabels)Row{Checkbox(code in phases,{checked->phases=if(checked)(phases+code).distinct()else phases-code});Text(label)};CustodyField("变更原因",reason,240){reason=it};Text(error,color=MaterialTheme.colorScheme.error);PrimaryAction(onClick={try{proposed=productPhasesCommand(m.identity!!,m.productPhasesBoard!!,phases,reason,name);error=""}catch(e:Exception){error=e.message.orEmpty()}},enabled=m.canUseProductPhases){Text("核对阶段设置")}}}
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认适用阶段")},text={Text(c.steps[0].productPhasesProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认保存")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回")}})}
}
