package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
@Composable fun LiveCommercePolicyView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};var reason by remember{mutableStateOf("")};var minutes by remember{mutableStateOf("")};var error by remember{mutableStateOf("")};var proposed by remember{mutableStateOf<LiveCommand?>(null)}
 LaunchedEffect(Unit){m.loadCommercePolicy()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)close()};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return;LaunchedEffect(m.commercePolicyBoard){minutes=m.commercePolicyBoard?.row?.getInt("paymentReservationMinutes")?.toString()?:""}
 fun propose(action:String,value:String){try{proposed=commercePolicyCommand(m.identity!!,m.commercePolicyBoard?:error("请刷新策略"),action,value,reason);error=""}catch(e:Exception){error=e.message?:"请核对策略"}}
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Row{Text("门店支付策略",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};LivePendingView(m);Text(m.commercePolicyState);TextButton(onClick={m.loadCommercePolicy()},enabled=!m.busy){Text("刷新策略")};if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)}
 m.commercePolicyBoard?.let{b->item{Panel{val r=b.row;Text("第${r.getInt("policyVersion")}版 · "+if(r.getBoolean("onlinePaymentEnabled"))"线上支付有效开放"else "当前不能发起新线上支付",style=MaterialTheme.typography.titleMedium);Text("门店开关："+if(r.getBoolean("policyOnlinePaymentEnabled"))"开启"else "关闭");Text("渠道："+when(r.textOrNull("provider")){"postar"->"星驿支付";"simulation"->"模拟渠道，不能当作真实收款";else->"未配置"});Text(if(r.getBoolean("providerConfigured"))"后台渠道配置已加载；不代表每笔付款已成功。"else "后台渠道未就绪，门店开关不能替代渠道配置。");b.data.optJSONObject("providerDiagnostics")?.optJSONArray("reasons")?.strings()?.forEach{Text(it)};Text("关闭只阻止新线上付款，仍须继续处理在途款、查询、退款和对账。",style=MaterialTheme.typography.bodySmall);r.textOrNull("reason")?.let{Text("上次原因：$it")};r.textOrNull("updatedAt")?.let{Text("更新于 ${calendarLocal(it)}")};CustodyField("实际调整原因",reason,1000){reason=it};PrimaryAction(onClick={propose("online-payment",(!r.getBoolean("policyOnlinePaymentEnabled")).toString())},enabled=m.canUseCommercePolicy&&(r.getBoolean("policyOnlinePaymentEnabled")||r.getBoolean("providerConfigured"))){Text(if(r.getBoolean("policyOnlinePaymentEnabled"))"核对关闭新线上支付"else "核对开放新线上支付")}};Panel{Text("待付款库存保留",style=MaterialTheme.typography.titleMedium);CustodyField("新订单保留时间（2至30分钟）",minutes,2){minutes=it};Text("只改变新订单使用的时限；已有订单沿用创建时的到期时间。");SecondaryAction(onClick={propose("payment-reservation",minutes)},enabled=m.canUseCommercePolicy){Text("核对并保存时限")}}}}
 }}}
 proposed?.let{c->AlertDialog(onDismissRequest={proposed=null},title={Text("确认支付策略调整")},text={Text(c.steps[0].commercePolicyProof!!.getString("confirmation"))},confirmButton={TextButton(onClick={proposed=null;m.executeLive(c)},enabled=m.canExecuteLive(c)){Text("确认调整")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回核对")}})}
}
