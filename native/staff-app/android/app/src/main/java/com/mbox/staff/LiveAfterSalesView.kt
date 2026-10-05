package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
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
fun AfterSalesCenterView(m: AppModel, close: () -> Unit) {
    var itemID by remember { mutableStateOf<String?>(null) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(Unit) { m.loadAfterSalesPending() }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().padding(16.dp)) {
                Row {
                    Text("商品售后待办", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { m.loadAfterSalesPending() }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        Text("跨营业日待办；资金和实物分别处理，打印完成不等于岗位已知悉。", fontSize = 12.sp)
                        if (m.afterSalesState.isNotEmpty()) Text(m.afterSalesState)
                    }
                    items(m.afterSalesPendingRows, key = { it.getString("caseId") }) { row ->
                        Card {
                            Text(row.getString("tableCode") + " · " + row.getString("productName"))
                            Text(
                                row.getString("businessDate") +
                                    " · " +
                                    cashierStatus(row.getString("status")),
                                fontSize = 12.sp,
                            )
                            Text(
                                "资金${if(row.getBoolean("moneyComplete")) "已处理" else "待处理"} · 实物${if(row.getBoolean("physicalComplete")) "已处理" else "待处理"}"
                            )
                            SecondaryAction(onClick = { itemID = row.getString("orderItemId") }) {
                                Text("处理原商品")
                            }
                        }
                    }
                    if (m.afterSalesCursor != null)
                        item {
                            SecondaryAction(
                                onClick = { m.loadAfterSalesPending(true) },
                                enabled = !m.busy,
                            ) {
                                Text("读取更多原售后")
                            }
                        }
                }
            }
        }
    }
    itemID?.let { id ->
        LiveAfterSalesView(m, id) {
            itemID = null
            m.loadAfterSalesPending()
        }
    }
}

@Composable
fun LiveAfterSalesView(m: AppModel, itemID: String, close: () -> Unit) {
    var replacement by remember { mutableStateOf<LiveReplacement?>(null) }
    var replacementError by remember { mutableStateOf("") }
    var showFulfillment by remember { mutableStateOf(false) }
    var quantity by remember { mutableStateOf("1") }
    var reason by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(itemID) { m.loadAfterSales(itemID) }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    if (showFulfillment)
        LiveFulfillmentView(m) {
            showFulfillment = false
            m.loadAfterSales(itemID)
        }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text(
                        "商品售后与补救",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    TextButton(onClick = { m.loadAfterSales(itemID) }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.afterSalesState.isNotEmpty()) Text(m.afterSalesState)
                        if (replacementError.isNotEmpty())
                            Text(replacementError, color = MaterialTheme.colorScheme.error)
                    }
                    val board =
                        m.afterSales?.takeIf {
                            it.id == itemID && m.afterSalesActor == m.identity?.employeeId
                        }
                    if (board != null) {
                        item {
                            if (board.remakes.isNotEmpty() && m.canReadFulfillment)
                                SecondaryAction(onClick = { showFulfillment = true }) {
                                    Text("到出品任务继续制作与取送")
                                }
                            if (board.source.optBoolean("supportsNativePhysicalRecovery"))
                                RemediationCards(m, board) { proposed = it }
                            else Text("服务器尚未启用安全补送与重做，请使用原网页流程。", fontSize = 12.sp)
                        }
                        item {
                            Text(
                                board.item.getString("tableCode") +
                                    " · " +
                                    board.item.getString("name"),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(board.item.getString("orderPublicId"), fontSize = 12.sp)
                            Text(
                                "原商品${board.item.getInt("quantity")}份 · 原成交 ${historyMoney(board.item.getLong("originalAmountMinor"))}"
                            )
                            board.source.textOrNull("quantityEntryUnavailableReason")?.let {
                                Text(it)
                            }
                            if (board.source.getBoolean("canRequest"))
                                Foldout("申请暂停 / 退菜 · 可选${board.available}份") {
                                    OutlinedTextField(
                                        quantity,
                                        { quantity = it },
                                        label = { Text("实际份数") },
                                        keyboardOptions =
                                            KeyboardOptions(keyboardType = KeyboardType.Number),
                                    )
                                    OutlinedTextField(
                                        reason,
                                        { reason = it },
                                        label = { Text("实际原因（2—1000字）") },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    Text("提交后按份暂停；退款、免收或待核价由原成交与原款事实决定。", fontSize = 12.sp)
                                    Primary(
                                        "核对份数并申请",
                                        enabled = m.canUseAfterSales,
                                        icon = Icons.Outlined.PauseCircle,
                                    ) {
                                        runCatching {
                                                m.prepareAfterSales(
                                                    "request",
                                                    quantity = quantity.toIntOrNull() ?: 0,
                                                    reason = reason,
                                                )
                                            }
                                            .onSuccess { proposed = it }
                                            .onFailure { m.message = it.message ?: "请刷新核对" }
                                    }
                                }
                        }
                        val links =
                            board.source.optJSONArray("replacementOrders")?.objects().orEmpty()
                        if (links.isNotEmpty())
                            item {
                                Foldout("换品新单记录 · ${links.size}笔") {
                                    links.forEach { link ->
                                        Text(
                                            link.getString("publicId") +
                                                " · " +
                                                if (link.getString("status") == "cancelled") "已取消"
                                                else cashierStatus(link.getString("status")),
                                            fontSize = 12.sp,
                                        )
                                    }
                                    Text("包括取消后再次换品的旧记录。新单与原退款分别核对。", fontSize = 12.sp)
                                }
                            }
                        items(board.cases, key = { it.getString("caseId") }) { row ->
                            AfterSalesCaseCard(
                                m,
                                board,
                                row,
                                replace = {
                                    runCatching {
                                            check(m.canUseAfterSales) { "请刷新原商品和权限" }
                                            LiveReplacement.make(
                                                board,
                                                row.getString("caseId"),
                                                m.identity ?: error("请先登录"),
                                            )
                                        }
                                        .onSuccess {
                                            replacement = it
                                            replacementError = ""
                                        }
                                        .onFailure { replacementError = it.message ?: "请刷新原商品" }
                                },
                            ) {
                                proposed = it
                            }
                        }
                        if (board.cases.isEmpty()) item { Text("暂无原售后申请") }
                    }
                }
            }
        }
    }
    replacement?.let { source ->
        LiveCatalogView(m, source.session, source.tableCode, source) {
            replacement = null
            m.loadAfterSales(itemID)
        }
    }
    proposed?.let { command ->
        Dialog(
            onDismissRequest = { proposed = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                Column(
                    Modifier.safeDrawingPadding()
                        .padding(20.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(command.title, style = MaterialTheme.typography.titleLarge)
                    Text(command.steps[0].afterSalesProof!!.getString("confirmation"))
                    Primary(
                        "确认以上实际处理",
                        enabled = m.canExecuteLive(command),
                        icon = Icons.Outlined.VerifiedUser,
                    ) {
                        proposed = null
                        m.executeLive(command)
                    }
                    TextButton(onClick = { proposed = null }) { Text("返回修改") }
                }
            }
        }
    }
}

@Composable
private fun AfterSalesCaseCard(
    m: AppModel,
    board: LiveAfterSales,
    row: JSONObject,
    replace: () -> Unit,
    propose: (LiveCommand) -> Unit,
) {
    var reason by remember { mutableStateOf("") }
    var count by remember { mutableStateOf("1") }
    var funding by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var unitIDs by remember { mutableStateOf<Set<String>>(emptySet()) }
    var refundReferences by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val id = row.getString("caseId")
    fun action(name: String, refundID: String = "", confirmed: Boolean = false) {
        runCatching {
                val shares =
                    if (name == "approved" && row.optBoolean("requiresFundingChoice"))
                        funding
                            .filterValues { it.isNotBlank() }
                            .mapValues { parseMoney(it.value) ?: error("请输入有效的原付款退回金额") }
                    else emptyMap()
                m.prepareAfterSales(
                    name,
                    id,
                    count.toIntOrNull() ?: 0,
                    reason,
                    shares,
                    unitIDs,
                    refundID,
                    confirmed,
                    refundReferences[refundID].orEmpty(),
                )
            }
            .onSuccess(propose)
            .onFailure { m.message = it.message ?: "请刷新核对" }
    }
    Foldout(
        "${row.getString("businessDate")} · ${row.getInt("selectedQuantity")}份 · ${cashierStatus(row.getString("status"))}"
    ) {
        Text(row.getString("reason"))
        val link = row.optJSONObject("replacementOrder")
        link?.let {
            Text(
                "换品新单：" +
                    it.getString("publicId") +
                    if (it.getString("status") == "cancelled") " · 已取消" else " · 已建立，请在本桌订单处理",
                fontSize = 12.sp,
            )
            Text("原申请与新单分别结算；修改、撤回原申请不会取消新单。", fontSize = 12.sp)
        }
        if (
            row.optBoolean("canReplace") &&
                !board.source.optBoolean("supportsNativeReplacementRecovery")
        ) {
            Text("此门店尚未启用 App 换品恢复，请使用网页处理换品。", fontSize = 12.sp)
        }
        if (
            board.source.optBoolean("supportsNativeReplacementRecovery") &&
                row.optBoolean("canReplace") &&
                board.item.textOrNull("tableSessionId") != null
        ) {
            SecondaryAction(
                onClick = replace,
                enabled = m.canUseAfterSales && m.identity?.allows("order.create") == true,
            ) {
                Text(if (link == null) "换商品，另开新单" else "重新换品，另开新单")
            }
        }
        Text("原申请金额：" + (row.longOrNull("amountMinor")?.let { historyMoney(it) } ?: "待核价"))
        Text(
            "资金${if(row.getBoolean("moneyComplete")) "已处理" else "待处理"} · 已退${historyMoney(row.getLong("succeededMinor"))}\n实物暂停${row.getInt("heldQuantity")}份 · 已停止${row.getInt("stoppedQuantity")}份",
            fontSize = 12.sp,
        )
        row.optJSONObject("pricing")?.let { p ->
            Text(
                "${if(p.getString("policy")=="broken_bundle") "套餐按保留商品下单时单点价重算" else "按原实收余额"}；本次退款${historyMoney(p.getLong("refundAmountMinor"))}，处理后应收${historyMoney(p.getLong("effectiveAmountMinor"))}。不自动扣补款。",
                fontSize = 12.sp,
            )
        }
        if (row.optBoolean("paymentAllocationReview") || row.optBoolean("unpaidPaymentChanged"))
            Text("原付款或分摊有变化，保持商品暂停，请先核对原款。")
        if (row.getInt("inventoryReviewQuantity") > 0)
            Text("${row.getInt("inventoryReviewQuantity")}份库存原记录待核对，未自动回库。", fontSize = 12.sp)
        if (row.getBoolean("refundFailed") || row.getBoolean("refundNeedsReview"))
            Text("退款失败或结果待核对，不要重新申请相同退款。", fontSize = 12.sp)
        row.textOrNull("resumeUnavailableReason")?.let { Text(it, fontSize = 12.sp) }
        row.textOrNull("revisedByCaseId")?.let {
            Text("本申请已修改，新申请：$it；减少份数不会自动继续。", fontSize = 12.sp)
        }
        OutlinedTextField(
            reason,
            { reason = it },
            label = { Text("本次实际原因（2—1000字）") },
            modifier = Modifier.fillMaxWidth(),
        )
        if (row.optBoolean("requiresFundingChoice")) {
            Text("按原付款分配本次退款")
            board.funding.forEach { source ->
                val payment = source.getString("paymentId")
                Text(
                    cashierProvider(source.getString("provider")) +
                        " · 可退 " +
                        historyMoney(source.getLong("availableMinor")),
                    fontSize = 12.sp,
                )
                OutlinedTextField(
                    funding[payment] ?: "",
                    { funding = funding + (payment to it) },
                    label = { Text("此原款退回金额") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                )
            }
        }
        if (row.getBoolean("canApprove"))
            Primary(
                if (row.getString("kind") == "unpaid_stop") "确认停止并免收" else "批准原退款",
                enabled = m.canUseAfterSales,
                icon = Icons.Outlined.VerifiedUser,
            ) {
                action("approved")
            }
        listOf(
                "canReject" to ("rejected" to "拒绝原申请"),
                "canWithdraw" to ("withdrawn" to "撤回本人申请"),
                "canResume" to ("resume" to "确认继续原商品"),
                "canResolveUnpaid" to ("resolve-unpaid" to "原款确认未收，继续停止减账"),
            )
            .forEach { (flag, entry) ->
                if (row.optBoolean(flag))
                    SecondaryAction(
                        onClick = { action(entry.first) },
                        enabled = m.canUseAfterSales,
                    ) {
                        Text(entry.second)
                    }
            }
        if (row.optBoolean("canRevise")) {
            OutlinedTextField(
                count,
                { count = it },
                label = { Text("修改后份数") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            SecondaryAction(onClick = { action("revision") }, enabled = m.canUseAfterSales) {
                Text("修改份数，重新审核")
            }
        }
        val notices = financeRows(row, "notices")
        notices.forEach { n ->
            Text(
                "${if(n.getString("stationCode")=="kitchen") "后厨" else "吧台"}：${n.getString("instruction")} · ${if(n.getString("printState")=="printed") "程序报已打印，仍需岗位确认" else "待打印或打印异常"}",
                fontSize = 12.sp,
            )
        }
        if (notices.isNotEmpty() && board.source.getBoolean("canAcknowledgeNotices"))
            SecondaryAction(
                onClick = { action("notice-ack", confirmed = true) },
                enabled = m.canUseAfterSales,
            ) {
                Text("已联系所示岗位，确认知悉")
            }
        if (
            row.optBoolean("canDisposeMade", row.getString("status") == "approved") &&
                (board.source.getBoolean("canReceive") || board.source.getBoolean("canRecordUsed"))
        ) {
            board.held(row).forEach { unit ->
                val uid = unit.getString("id")
                Row {
                    Checkbox(uid in unitIDs, { unitIDs = if (it) unitIDs + uid else unitIDs - uid })
                    Text(
                        "第${unit.getInt("index")}份 · ${if(unit.getString("productionState")=="unmade") "未制作" else "已制作"}",
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
                unit.optJSONObject("returnEligibility")?.textOrNull("reason")?.let {
                    Text(it, fontSize = 12.sp)
                }
            }
            if (board.source.getBoolean("canReceive"))
                SecondaryAction(
                    onClick = { action("returned_unopened", confirmed = true) },
                    enabled = m.canUseAfterSales && unitIDs.isNotEmpty(),
                ) {
                    Text("所选实物已收回 / 未制作预留释放")
                }
            if (board.source.getBoolean("canRecordUsed"))
                SecondaryAction(
                    onClick = { action("used_loss", confirmed = true) },
                    enabled = m.canUseAfterSales && unitIDs.isNotEmpty(),
                ) {
                    Text("所选实物确已消耗，不回库")
                }
        }
        financeRows(row, "refunds").forEach { refund ->
            val rid = refund.getString("id")
            Text(
                cashierProvider(refund.getString("provider")) +
                    " · " +
                    historyMoney(refund.getLong("amountMinor")) +
                    " · " +
                    cashierStatus(refund.getString("status")),
                fontSize = 12.sp,
            )
            if (refund.optBoolean("canRetry"))
                SecondaryAction(
                    onClick = { action("refund-retry", rid) },
                    enabled = m.canUseAfterSales,
                ) {
                    Text("重试此笔已确认失败退款")
                }
            val manualProvider = refund.getString("provider")
            if (
                board.source.getBoolean("canExecuteRefund") &&
                    manualProvider in listOf("cash", "physical_pos", "external_manual") &&
                    refund.getString("status") in listOf("approved", "processing")
            ) {
                if (manualProvider != "cash") {
                    Text("先在原线下工具完成退款，再登记凭证；此操作不会替你扣款或退钱。", fontSize = 12.sp)
                    OutlinedTextField(
                        refundReferences[rid].orEmpty(),
                        { refundReferences = refundReferences + (rid to it) },
                        label = { Text("原退款凭证号（1—256字）") },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !m.busy,
                    )
                }
                Primary(
                    "${cashierProvider(manualProvider)}${historyMoney(refund.getLong("amountMinor"))}已实际退给客人",
                    enabled = m.canUseAfterSales &&
                        (manualProvider == "cash" || refundReferences[rid].orEmpty().trim().length in 1..256),
                    icon = Icons.Outlined.Payments,
                ) {
                    action(if (manualProvider == "cash") "cash-paid" else "manual-paid", rid, true)
                }
            }
        }
    }
}

@Composable
private fun RemediationCards(m: AppModel, board: LiveAfterSales, propose: (LiveCommand) -> Unit) {
    if (board.source.optBoolean("canRequestRedelivery"))
        RemediationForm(
            m,
            "补送原实物",
            "request",
            maximum = board.source.optInt("redeliveryAvailableQuantity"),
            confirmation = "原实物仍在且可以交付，无需重新制作",
            propose = propose,
        )
    board.redeliveries.forEach { row ->
        key(row.getString("id")) {
            Card {
                Text(
                    "补送 · ${row.getInt("selectedQuantity")}份",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(row.getString("reason"), fontSize = 12.sp)
                Text(
                    "已送${row.getInt("deliveredQuantity")} · 待送${row.getInt("pendingQuantity")} · 其中暂停${row.getInt("pausedQuantity")} · 已取消${row.getInt("cancelledQuantity")}",
                    fontSize = 12.sp,
                )
                val active =
                    row.getString("status") in listOf("pending", "acknowledged", "in_progress")
                val available = row.getInt("pendingQuantity") - row.getInt("pausedQuantity")
                if (active && board.source.optBoolean("canConfirmRedelivery") && available > 0)
                    RemediationForm(
                        m,
                        "登记实际补送",
                        "complete",
                        row.getString("id"),
                        available,
                        "所填份数已实际补送给客人",
                        propose,
                    )
                if (active && board.source.optBoolean("canCancelRedelivery"))
                    RemediationForm(
                        m,
                        "取消剩余补送",
                        "cancel",
                        row.getString("id"),
                        0,
                        "仅取消本次尚未完成的补送，不退菜、不退款",
                        propose,
                    )
            }
        }
    }
    if (
        board.source.optBoolean("canManageRemake") &&
            board.source.textOrNull("originalKdsTaskId") != null &&
            board.source.optInt("firstRemakeAvailableQuantity") > 0
    )
        RemediationForm(
            m,
            "按份重新制作",
            "remake",
            board.source.getString("originalKdsTaskId"),
            board.source.getInt("firstRemakeAvailableQuantity"),
            "本批原实物无法直接补送，确需重新制作",
            propose,
        )
    board.remakes.forEachIndexed { index, batch ->
        key(batch.getString("id")) {
            Card {
                Text(
                    "重做第${index + 1}批 · ${batch.getInt("total")}份",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(batch.getString("reason"), fontSize = 12.sp)
                Text(
                    "未制作${batch.getInt("unmade")} · 制作中${batch.getInt("started")} · 待送${batch.getInt("ready")} · 已送${batch.getInt("delivered")} · 已结束${batch.getInt("cancelled")} · 暂停${batch.getInt("held")}",
                    fontSize = 12.sp,
                )
                Text("制作进度在出品任务中继续，备齐后由取餐岗位确认。", fontSize = 12.sp)
                if (
                    board.source.optBoolean("canManageRemake") &&
                        batch.getInt("successorAvailableQuantity") > 0
                )
                    RemediationForm(
                        m,
                        "本批再次重做",
                        "remake",
                        batch.getString("taskId"),
                        batch.getInt("successorAvailableQuantity"),
                        "本批原实物无法直接补送，确需再次制作",
                        propose,
                    )
            }
        }
    }
}

@Composable
private fun RemediationForm(
    m: AppModel,
    title: String,
    action: String,
    target: String = "",
    maximum: Int,
    confirmation: String,
    propose: (LiveCommand) -> Unit,
) {
    var quantity by remember { mutableStateOf("1") }
    var reason by remember { mutableStateOf("") }
    var checked by remember { mutableStateOf(false) }
    var validationError by remember { mutableStateOf("") }
    Foldout(title) {
        if (action != "cancel")
            OutlinedTextField(
                quantity,
                { quantity = it },
                label = { Text("实际份数（最多${maximum}份）") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
        OutlinedTextField(
            reason,
            { reason = it },
            label = { Text("实际原因（2—${if(action == "remake") 500 else 1000}字）") },
            modifier = Modifier.fillMaxWidth(),
        )
        Row {
            Checkbox(checked, { checked = it })
            Text(confirmation, Modifier.weight(1f))
        }
        if (validationError.isNotEmpty())
            Text(validationError, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        SecondaryAction(
            onClick = {
                try {
                    propose(
                        m.prepareRemediation(
                            action,
                            target,
                            quantity.toIntOrNull() ?: 0,
                            reason,
                            checked,
                        )
                    )
                    validationError = ""
                    checked = false
                } catch (e: Exception) {
                    validationError = e.message ?: "请核对实际处理"
                }
            },
            enabled = m.canUseAfterSales && checked,
        ) {
            Text("核对并$title")
        }
    }
}
