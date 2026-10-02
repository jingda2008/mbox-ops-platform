package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject

@Composable
fun LiveFulfillmentView(m: AppModel, close: () -> Unit) {
    var historyVisible by remember { mutableStateOf(false) }
    if(historyVisible) LiveFulfillmentHistoryView(m,"prepared"){historyVisible=false}
    var batchVisible by remember { mutableStateOf(false) }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var itemID by remember { mutableStateOf<String?>(null) }
    var kitchen by remember { mutableStateOf(false) }
    var pickup by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf("all") }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(Unit) { m.loadFulfillment() }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text(
                        "出品任务与异常",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    TextButton(onClick = { m.loadFulfillment() }, enabled = !m.busy) { Text("刷新") }
                    TextButton(onClick = close) { Text("关闭") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("all" to "全部", "failed" to "异常", "carryover" to "跨日").forEach {
                        (id, title) ->
                        FilterChip(
                            selected = filter == id,
                            onClick = { filter = id },
                            label = { Text(title) },
                        )
                    }
                }
                if(canReadFulfillmentHistory(m.identity))TextButton(onClick={historyVisible=true}){Text("制作与送达历史")}
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.fulfillmentState.isNotEmpty())
                            Text(m.fulfillmentState, fontSize = 12.sp)
                    }
                    val board =
                        m.fulfillmentBoard?.takeIf { it.employeeID == m.identity?.employeeId }
                    if (board != null) {
                        val rows =
                            board.rows.filter {
                                filter == "all" ||
                                    if (filter == "failed") it.getString("kdsStatus") == "failed"
                                    else it.getBoolean("carryover")
                            }
                        item { Text("${rows.size}项任务 · 按原订单记录制作与取送", fontSize = 12.sp) }
                        if(m.identity?.allows("kds.exception.manage")==true&&board.rows.any{it.optBoolean("carryover")&&it.optBoolean("canManagerCancel")&&it.optJSONObject("quantities")==null})item{TextButton(onClick={batchVisible=true},enabled=m.canUseFulfillment){Text("选择跨日旧任务逐项结案")}}
                        if (rows.isEmpty()) item { Text("当前范围没有待处理任务") }
                        items(rows, key = { it.getString("taskId") }) { row ->
                            FulfillmentTaskCard(
                                m,
                                board,
                                row,
                                { proposed = it },
                                { itemID = row.getJSONObject("item").getString("id") },
                                { kitchen = true },
                                { pickup = true },
                            )
                        }
                    }
                }
            }
        }
    }
    if(batchVisible) FulfillmentBatchCancellation(m,{batchVisible=false}){proposed=it;batchVisible=false}
    if (kitchen)
        LiveKitchenView(m) {
            kitchen = false
            m.loadFulfillment()
        }
    if (pickup)
        LivePickupView(m) {
            pickup = false
            m.loadFulfillment()
        }
    itemID?.let { id ->
        LiveAfterSalesView(m, id) {
            itemID = null
            m.loadFulfillment()
        }
    }
    proposed?.let { command ->
        Dialog(onDismissRequest = { proposed = null }) {
            Surface(shape = MaterialTheme.shapes.large, color = Paper) {
                Column(
                    Modifier.verticalScroll(rememberScrollState()).padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(command.title, style = MaterialTheme.typography.titleLarge)
                    if(command.steps.size>1)Text("按下面清单逐项执行。中途失败或回执未知会停止，已成功事项保留；不自动退款、免收或恢复库存。")
                    for((index,step)in command.steps.withIndex()){if(command.steps.size>1)Text("第${index+1}项");Text(step.fulfillmentProof!!.getString("confirmation"))}
                    Primary(
                        "确认以上实际操作",
                        enabled = m.canExecuteLive(command),
                        action = {
                            proposed = null
                            m.executeLive(command)
                        },
                    )
                    TextButton(onClick = { proposed = null }) { Text("返回修改") }
                }
            }
        }
    }
}

@Composable
private fun FulfillmentTaskCard(
    m: AppModel,
    board: LiveFulfillment,
    row: JSONObject,
    propose: (LiveCommand) -> Unit,
    openItem: () -> Unit,
    openKitchen: () -> Unit,
    openPickup: () -> Unit,
) {
    var quantity by remember { mutableStateOf("1") }
    var reason by remember { mutableStateOf("") }
    var checked by remember { mutableStateOf(false) }
    var validationError by remember { mutableStateOf("") }
    fun submit(action: String) {
        try {
            propose(
                m.prepareFulfillment(
                    row.getString("taskId"),
                    action,
                    quantity.toIntOrNull() ?: 0,
                    reason,
                    checked,
                )
            )
            validationError = ""
            checked = false
        } catch (e: Exception) {
            validationError = e.message ?: "请核对原任务"
        }
    }
    val q = row.optJSONObject("quantities")
    val item = row.getJSONObject("item")
    val order = row.getJSONObject("order")
    val prepare = row.getBoolean("canPrepare") && row.textOrNull("productionScreen") == null
    val deliver = row.getBoolean("canDeliver") && !board.usesPickup
    val remake = row.getBoolean("canRemake") && q == null
    val cancel = row.optBoolean("canManagerCancel") && q == null
    Card {
        Text(
            row.getJSONObject("table").getString("code") + " · " + item.getString("productName"),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            "${if(row.getString("stationCode") == "bar") "吧台" else "后厨"} · ${row.getString("businessDate")}${if(row.getBoolean("carryover")) " · 前营业日遗留" else ""}",
            fontSize = 12.sp,
        )
        Text(order.getString("publicId"), fontSize = 12.sp)
        if (q != null)
            Text(
                "未制作${q.getInt("unmade")} · 制作中${q.getInt("started")} · 已备齐${q.getInt("ready")} · 已送${q.getInt("delivered")} · 暂停${q.getInt("held")} · 停止${q.getInt("stopped")}",
                fontSize = 12.sp,
            )
        item.textOrNull("note")?.let { Text("商品备注：$it") }
        order.textOrNull("note")?.let { Text("整单备注：$it") }
        row.textOrNull("failureReason")?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        val notes = row.getJSONArray("attentionMessages")
        for (index in 0 until notes.length()) Text(notes.getString(index), fontSize = 12.sp)
        if (m.canReadAfterSales) SecondaryAction(onClick = openItem) { Text("商品售后 · 补送 / 重做") }
        if (row.textOrNull("productionScreen") != null)
            SecondaryAction(onClick = openKitchen) { Text("到对应制作批次处理") }
        if (row.getBoolean("canDeliver") && board.usesPickup)
            SecondaryAction(onClick = openPickup) { Text("到取餐台核对实物") }
        if (prepare || remake || deliver || cancel)
            Foldout("处理此任务") {
                if (q != null)
                    OutlinedTextField(
                        quantity,
                        { quantity = it },
                        label = { Text("本次实际份数") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                else Text("旧流程按原任务整批 ${item.getInt("quantity")}份确认。", fontSize = 12.sp)
                OutlinedTextField(
                    reason,
                    { reason = it },
                    label = { Text("异常或主管处理原因（2—500字）") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row {
                    Checkbox(checked, { checked = it })
                    Text("已核对本桌、原商品、实际进度及本次操作", Modifier.weight(1f))
                }
                if (validationError.isNotEmpty())
                    Text(validationError, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                if (prepare) {
                    if (
                        fulfillmentMaximum(row, "start") > 0 &&
                            (q != null ||
                                row.getString("kdsStatus") in listOf("pending", "accepted"))
                    )
                        Primary(
                            "开始实际制作",
                            enabled = m.canUseFulfillment && checked,
                            action = { submit("start") },
                        )
                    Primary(
                        "所填份数已实际备齐",
                        enabled = m.canUseFulfillment && checked,
                        action = { submit("complete") },
                    )
                    if (q == null)
                        SecondaryAction(
                            onClick = { submit("fail") },
                            enabled = m.canUseFulfillment && checked,
                            danger = true,
                        ) {
                            Text("登记制作异常")
                        }
                }
                if (remake) {
                    Primary(
                        "按原异常重新制作",
                        enabled = m.canUseFulfillment && checked,
                        action = { submit("remake") },
                    )
                }
                if(cancel){
                    Text("结束原制作任务不自动退款，也不把已耗用原料退库；财务与实物须按原记录复核。",fontSize=12.sp)
                    SecondaryAction(
                        onClick = { submit("manager-cancel") },
                        enabled = m.canUseFulfillment && checked,
                        danger = true,
                    ) {
                        Text("主管结束原制作任务")
                    }
                }
                if (deliver)
                    Primary(
                        "确认已实际送达客桌",
                        enabled = m.canUseFulfillment && checked,
                        action = { submit("deliver") },
                    )
            }
    }
}

@Composable private fun FulfillmentBatchCancellation(m:AppModel,close:()->Unit,propose:(LiveCommand)->Unit){
 var selected by remember{mutableStateOf<Set<String>>(emptySet())};var reason by remember{mutableStateOf("")};var confirmed by remember{mutableStateOf(false)};var error by remember{mutableStateOf("")};val rows=m.fulfillmentBoard?.rows?.filter{it.optBoolean("carryover")&&it.optBoolean("canManagerCancel")&&it.optJSONObject("quantities")==null&&it.getString("kdsStatus") in listOf("pending","accepted","preparing","failed")}?:emptyList()
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 item{Text("跨日旧任务逐项结案",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("返回")};Text("只处理勾选的旧任务，最多50项。按份商品仍须逐项核对商品和实物。");Text("已选择 ${selected.size} 项")}
 items(rows,key={it.getString("taskId")}){r->val id=r.getString("taskId");Row{Checkbox(id in selected,{checked->selected=if(checked)selected+id else selected-id},enabled=id in selected||selected.size<50);Column(Modifier.weight(1f)){Text(r.getJSONObject("table").getString("code")+" · "+r.getJSONObject("item").getString("productName"));Text(r.getJSONObject("order").getString("publicId"));Text("原 ${r.getJSONObject("item").getInt("quantity")} 份")}}}
 item{CustodyField("共同处理原因（逐项留痕）",reason,500){reason=it};Row{Checkbox(confirmed,{confirmed=it});Text("已逐项核对，无需继续出品；资金和实物另行处理",Modifier.weight(1f))};Text(error,color=MaterialTheme.colorScheme.error);PrimaryAction(onClick={try{require(m.canUseFulfillment);propose(batchFulfillmentCancellation(m.fulfillmentBoard!!,m.identity!!,selected.toList(),reason,confirmed))}catch(e:Exception){error=e.message?:"请刷新核对原任务"}},enabled=m.canUseFulfillment&&selected.isNotEmpty()&&confirmed){Text("核对逐项结案清单")}}
 }}}
}
