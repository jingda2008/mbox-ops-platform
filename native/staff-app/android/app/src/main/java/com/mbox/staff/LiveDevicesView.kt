package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject

@Composable
fun DeviceChoice(label: String, value: String, options: Map<String,String>, onChange: (String)->Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick={ expanded=true },modifier=Modifier.fillMaxWidth()) { Text("$label：${options[value] ?: if(value.isBlank()) "未选择" else value}") }
        DropdownMenu(expanded,onDismissRequest={expanded=false}) { options.forEach { (key,text)->
            DropdownMenuItem(text={Text(text)},onClick={expanded=false;onChange(key)})
        } }
    }
}
private fun deviceDraft(row: JSONObject?): JSONObject {
    val form=JSONObject().put("code",row?.getString("code") ?: "").put("name",row?.getString("name") ?: "")
        .put("stationCode",row?.textOrNull("stationCode") ?: "cashier").put("status",row?.getString("status") ?: "active")
    for(key in listOf("printBridgeId","windowsQueueName","printProfile"))form.put(key,row?.opt(key) ?: JSONObject.NULL)
    return JSONObject().put("kind",if(row==null) "device-create" else "device-update").put("device",form).put("reason","").apply {
        if(row!=null)put("id",row.getString("id")).put("expected",row.getString("configurationFingerprint"))
    }
}
private fun routeDraft(row: JSONObject?): JSONObject {
    val form=JSONObject().put("code",row?.getString("code") ?: "").put("name",row?.getString("name") ?: "")
        .put("stationCode",row?.getString("stationCode") ?: "cashier").put("status",row?.getString("status") ?: "active")
        .put("printerDeviceId",row?.getString("printerDeviceId") ?: "").put("copies",row?.getInt("copies") ?: 1)
        .put("priority",row?.getInt("priority") ?: 100).put("productCategoryCode",row?.opt("productCategoryCode") ?: JSONObject.NULL)
    return JSONObject().put("kind","route-save").put("route",form).put("reason","").put("expected",row?.getString("configurationFingerprint") ?: JSONObject.NULL)
}
@Composable
fun LiveDevicesView(m: AppModel, close: ()->Unit) {
    val access=remember { m.priorityAccessKey }; val workspace=remember { m.workspaceVersion }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var error by remember { mutableStateOf("") }
    var editingTitle by remember { mutableStateOf("") }
    var pairingReason by remember { mutableStateOf("") }
    var pairingConfirm by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { m.clearBridgePairing() } }
    LaunchedEffect(m.bridgePairing?.optString("id")) {
        m.bridgePairing?.let { pairing ->
            val expires = assignmentDate(pairing.getString("expiresAt"))
            val millis = expires?.let { java.time.Duration.between(java.time.Instant.now(), it).toMillis().coerceIn(1,600_000) } ?: 1
            kotlinx.coroutines.delay(millis)
            if(m.bridgePairing?.optString("id") == pairing.getString("id")) m.clearBridgePairing()
        }
    }
    var section by remember { mutableStateOf("devices") }
    LaunchedEffect(m.priorityAccessKey,m.workspaceVersion) { if(access!=m.priorityAccessKey || workspace!=m.workspaceVersion)close() }
    LaunchedEffect(Unit) { m.loadDevices() }
    fun edit(value: JSONObject,title: String="") { editing=value;editingTitle=title;error="" }
    Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize(),color=Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                item {
                    Row { Text("打印设备",Modifier.weight(1f),fontSize=22.sp);TextButton(onClick=close){Text("关闭")} }
                    Text(m.deviceState,fontSize=12.sp)
                    PrimaryAction(onClick={m.loadDevices()},enabled=!m.busy){Text("刷新设备和执行结果")}
                    LivePendingView(m)
                    DeviceChoice("查看",section,linkedMapOf("devices" to "打印机","routes" to "打印路由","policies" to "票据策略","bridges" to "打印桥接器","commands" to "设备操作记录")){section=it}
                    if(section=="devices")SecondaryAction(onClick={edit(deviceDraft(null))},enabled=m.canUseDevices){Text("添加打印机")}
                    if(section=="routes")SecondaryAction(onClick={edit(routeDraft(null))},enabled=m.canUseDevices){Text("添加打印路由")}
                    if(section=="bridges") {
                        Text("在门店Windows打印电脑的M-BOX桥接程序中输入配对码，完成后刷新本页并绑定队列。",fontSize=12.sp)
                        OutlinedTextField(pairingReason,{pairingReason=it},label={Text("配对说明，例如更换收银电脑")})
                        SecondaryAction(enabled=m.canUseDevices && pairingReason.trim().length in 3..500,onClick={pairingConfirm=true}){Text("生成10分钟配对码")}
                        m.bridgePairing?.let { pairing ->
                            Panel {
                                androidx.compose.foundation.text.selection.SelectionContainer { Text(pairing.getString("pairingCode"),fontSize=20.sp) }
                                Text("到期 ${reservationTime(pairing.getString("expiresAt"))}；只在门店打印电脑输入，关闭此页会隐藏。",fontSize=12.sp)
                                TextButton(onClick={m.clearBridgePairing()}){Text("隐藏配对码")}
                            }
                        }
                    }
                }
                val board=m.deviceBoard
                if(section=="devices") items(board?.devices.orEmpty(),key={it.getString("id")}) { row->Panel {
                    Text(row.getString("name"),fontSize=18.sp)
                    Text("${row.getString("code")} · ${DeviceCommands.stations[row.textOrNull("stationCode")] ?: "未分配岗位"} · ${DeviceCommands.statuses[row.getString("status")]}")
                    Text("连接："+(mapOf("unknown" to "未确认","online" to "在线","offline" to "离线","degraded" to "异常")[row.getString("connectivityStatus")] ?: "待核对"))
                    Text("队列：${row.textOrNull("windowsQueueName") ?: "未绑定"}",fontSize=12.sp)
                    row.textOrNull("lastSeenAt")?.let { Text("最近上报 ${reservationTime(it)}",fontSize=12.sp) }
                    SecondaryAction(onClick={edit(deviceDraft(row))},enabled=m.canUseDevices){Text("编辑配置")}
                    if(row.getString("status")!="retired")for((command,label) in listOf("test_print" to "测试打印","ping" to "检测连接","reconnect" to "重新连接"))
                        TextButton(enabled=m.canUseDevices,onClick={edit(JSONObject().put("kind","device-test").put("id",row.getString("id")).put("expected",row.getString("configurationFingerprint")).put("command",command).put("reason",label+" · "+row.getString("name")))}){Text(label)}
                } }
                if(section=="routes") items(board?.routes.orEmpty(),key={it.getString("id")}) { row->Panel {
                    Text(row.getString("name"),fontSize=18.sp)
                    Text("${DeviceCommands.stations[row.getString("stationCode")]} · ${row.getInt("copies")}份 · ${DeviceCommands.statuses[row.getString("status")]}")
                    Text("打印机："+(board?.devices?.find{it.getString("id")==row.getString("printerDeviceId")}?.getString("name") ?: "设备待核对"))
                    Text("商品分类：${row.textOrNull("productCategoryCode") ?: "该岗位全部分类"}")
                    SecondaryAction(enabled=m.canUseDevices,onClick={edit(routeDraft(row))}){Text("编辑路由")}
                } }
                if(section=="policies") items(board?.policies.orEmpty()) { row->Panel {
                    Text(DeviceCommands.tickets[row.getString("ticketKind")] ?: row.getString("ticketKind"),fontSize=18.sp)
                    Text((if(row.getBoolean("enabled")) "自动打印开启" else "自动打印关闭")+" · "+(if(row.isNull("copies")) "份数跟随路由" else "${row.getInt("copies")}份"))
                    Text("影响后续自动票据；已有任务和手动打印分别处理。",fontSize=12.sp)
                    SecondaryAction(enabled=m.canUseDevices,onClick={edit(JSONObject().put("kind","policy-save").put("expected",row.getString("configurationFingerprint")).put("reason","")
                        .put("policy",JSONObject().put("ticketKind",row.getString("ticketKind")).put("enabled",row.getBoolean("enabled")).put("copies",if(row.isNull("copies")) 1 else row.getInt("copies"))))}){Text("调整策略")}
                } }
                if(section=="bridges") items(m.printBridges,key={it.getString("id")}) { row->Panel {
                    Text(row.getString("name"),fontSize=18.sp)
                    Text("${row.getString("hostname")} · ${if(row.getString("status")=="revoked") "已撤销" else if(row.getBoolean("online")) "在线" else "离线"}")
                    Text("桥接器版本 ${row.getString("softwareVersion")}")
                    val queues=row.getJSONArray("queues");for(i in 0 until queues.length())Text(queues.getString(i),fontSize=12.sp)
                    if(row.getString("status")=="active")SecondaryAction(enabled=m.canUseDevices && m.bridgeRevocationEnabled,onClick={
                        edit(JSONObject().put("kind","bridge-revoke").put("id",row.getString("id")).put("reason",""),"撤销 ${row.getString("name")} · ${row.getString("hostname")}\n该电脑将停止接收打印任务，已排队票据不会自动改投；需要重新配对或绑定其他桥接器。")
                    }){Text("撤销此桥接器")}
                    if(!m.bridgeRevocationEnabled)Text("后台未开放安全撤销，当前仅可查看。",fontSize=12.sp)
                } }
                if(section=="commands") items(board?.commands.orEmpty(),key={it.getString("id")}) { row->Panel {
                    Text(row.getString("deviceName"),fontSize=18.sp)
                    Text((mapOf("test_print" to "测试打印","ping" to "检测连接","reconnect" to "重新连接")[row.getString("commandType")] ?: row.getString("commandType"))+" · "+(mapOf("requested" to "等待设备","executing" to "执行中","succeeded" to "设备回报成功","failed" to "执行失败","cancelled" to "已取消")[row.getString("status")] ?: "待核对"))
                    Text(reservationTime(row.getString("createdAt")),fontSize=12.sp)
                    row.textOrNull("errorCode")?.let{Text(it,color=MaterialTheme.colorScheme.error)}
                } }
            }
        }
    }
    editing?.let { body->
        val kind=body.getString("kind");val part=when {kind.startsWith("device-") && kind!="device-test"->"device";kind=="route-save"->"route";kind=="policy-save"->"policy";else->null}
        val form=part?.let{body.getJSONObject(it)}
        fun change(key:String,value:Any?) { editing=JSONObject(body.toString()).apply { (part?.let{getJSONObject(it)} ?: this).put(key,value ?: JSONObject.NULL) } }
        fun changeReason(value:String){editing=JSONObject(body.toString()).put("reason",value)}
        AlertDialog(onDismissRequest={editing=null},title={Text(if(kind=="device-test") "核对设备操作" else "打印配置")},text={
            LazyColumn(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                if(part=="device"||part=="route") {
                    item { OutlinedTextField(form!!.getString("code"),{change("code",it.trim())},label={Text("编码")},enabled=kind=="device-create"||kind=="route-save"&&body.isNull("expected"),singleLine=true) }
                    item { OutlinedTextField(form!!.getString("name"),{change("name",it)},label={Text("名称")},singleLine=true) }
                    item { DeviceChoice("岗位",form!!.getString("stationCode"),if(part=="route") DeviceCommands.stations.filterKeys{it!="service"} else DeviceCommands.stations){change("stationCode",it)} }
                    if(kind!="device-create")item { DeviceChoice("状态",form!!.getString("status"),DeviceCommands.statuses){change("status",it)};if(part=="device" && form.getString("status")=="retired")Text("退役后不能重新启用，请核对现场设备。",color=MaterialTheme.colorScheme.error) }
                }
                if(part=="device") {
                    item { DeviceChoice("桥接器",form!!.textOrNull("printBridgeId") ?: "",linkedMapOf("" to "暂不绑定")+m.printBridges.filter{it.getString("status")=="active"}.associate{it.getString("id") to it.getString("name")}){
                        editing=JSONObject(body.toString()).apply {getJSONObject("device").put("printBridgeId",it.ifBlank{null} ?: JSONObject.NULL).put("windowsQueueName",JSONObject.NULL)}
                    } }
                    val bridge=m.printBridges.find{it.getString("id")==form!!.textOrNull("printBridgeId")}
                    val queues=bridge?.getJSONArray("queues")?.let{q->(0 until q.length()).map{q.getString(it)}}.orEmpty()
                    item { DeviceChoice("打印队列",form!!.textOrNull("windowsQueueName") ?: "",linkedMapOf("" to "未选择")+queues.associateWith{it}){change("windowsQueueName",it.ifBlank{null})} }
                    item { DeviceChoice("驱动格式",form!!.textOrNull("printProfile") ?: "",linkedMapOf("" to "未选择")+DeviceCommands.profiles){change("printProfile",it.ifBlank{null})} }
                }
                if(part=="route") {
                    item { DeviceChoice("打印机",form!!.getString("printerDeviceId"),m.deviceBoard?.devices.orEmpty().filter{it.getString("status")!="retired"}.associate{it.getString("id") to it.getString("name")}){change("printerDeviceId",it)} }
                    item { OutlinedTextField(form!!.textOrNull("productCategoryCode") ?: "",{change("productCategoryCode",it.trim().ifBlank{null})},label={Text("分类编码，空为岗位全部分类")}) }
                    item { OutlinedTextField(form!!.getInt("priority").toString(),{it.toIntOrNull()?.takeIf{n->n in 0..1000}?.let{n->change("priority",n)}},label={Text("优先级 0—1000")}) }
                }
                if(part=="route"||part=="policy") item { DeviceChoice("份数",form!!.getInt("copies").toString(),(1..5).associate{it.toString() to "$it 份"}){change("copies",it.toInt())} }
                if(part=="policy") item { Row { Text("自动打印",Modifier.weight(1f));Switch(form!!.getBoolean("enabled"),{change("enabled",it)}) } }
                item { OutlinedTextField(body.getString("reason"),::changeReason,label={Text("处理说明（至少3字）")});if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error) }
            }
        },confirmButton={TextButton(enabled=m.canUseDevices,onClick={try{
            val normalized=JSONObject(body.toString());part?.let { p->if(p!="policy")normalized.getJSONObject(p).optString("name").takeIf{it.isNotBlank()}?.let{normalized.getJSONObject(p).put("name",it.trim())} }
            val detail=when(part){"device"->"打印机 ${form!!.getString("name")} · ${DeviceCommands.stations[form.getString("stationCode")]}\n${DeviceCommands.statuses[form.getString("status")]}\n队列 ${form.textOrNull("windowsQueueName") ?: "未绑定"}";"route"->"路由 ${form!!.getString("name")} · ${DeviceCommands.stations[form.getString("stationCode")]} · ${form.getInt("copies")}份\n打印机：${m.deviceBoard?.devices?.find { it.getString("id")==form.getString("printerDeviceId") }?.getString("name") ?: "待核对"}\n分类：${form.textOrNull("productCategoryCode") ?: "岗位全部分类"} · ${DeviceCommands.statuses[form.getString("status")]}";"policy"->"${DeviceCommands.tickets[form!!.getString("ticketKind")]} · ${if(form.getBoolean("enabled")) "开启" else "关闭"} · ${form.getInt("copies")}份";else->editingTitle.ifBlank { body.getString("reason") }}
            proposed=m.prepareDevice(normalized,detail);editing=null
        }catch(e:Exception){error=e.message ?: "请核对输入"}}){Text("下一步 · 核对")}},dismissButton={TextButton(onClick={editing=null}){Text("返回")}})
    }
    if(pairingConfirm)AlertDialog(onDismissRequest={pairingConfirm=false},title={Text("授权门店打印电脑配对")},text={Text("配对码可让门店电脑接收打印任务，请只在认可的M-BOX打印桥程序中使用。\n说明：$pairingReason\n有效期10分钟，失去响应不会自动重试。")},confirmButton={TextButton(enabled=m.canUseDevices,onClick={pairingConfirm=false;m.createBridgePairing(pairingReason)}){Text("生成配对码")}},dismissButton={TextButton(onClick={pairingConfirm=false}){Text("取消")}})
    proposed?.let{command->AlertDialog(onDismissRequest={proposed=null},title={Text(command.title)},text={Text(command.steps.single().deviceProof!!.getString("confirmation"))},confirmButton={TextButton(enabled=m.canExecuteLive(command),onClick={proposed=null;m.executeLive(command)}){Text("确认执行")}},dismissButton={TextButton(onClick={proposed=null}){Text("返回")}})}
}
