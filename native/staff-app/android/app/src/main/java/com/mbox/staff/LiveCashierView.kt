package com.mbox.staff

import androidx.compose.foundation.layout.*
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

fun cashierStatus(v: String) =
    mapOf(
        "created" to "已创建，未确认到账",
        "pending" to "款项待确认",
        "succeeded" to "已成功",
        "failed" to "失败",
        "closed" to "本地已关闭",
        "partially_refunded" to "部分退款",
        "refunded" to "已退款",
        "requested" to "待复核",
        "approved" to "已复核",
        "rejected" to "已驳回",
        "processing" to "处理中",
        "cancelled" to "已取消",
    )[v] ?: historyStatus(v)

fun cashierProvider(v: String) =
    mapOf(
        "cash" to "现金",
        "physical_pos" to "实体POS",
        "external_manual" to "其他线下",
        "postar" to "星驿",
        "wechat" to "微信",
        "simulation" to "模拟通道",
    )[v] ?: v

@Composable
fun LiveCashierView(m: AppModel, initialQuery: String? = null) {
    var showCashHandover by remember { mutableStateOf(false) }
    if (showCashHandover) LiveCashHandoverView(m) { showCashHandover = false }
    var showVouchers by remember { mutableStateOf(false) }
    var voucherOrder by remember { mutableStateOf<CashierOrder?>(null) }
    if (showVouchers) LiveVouchersView(m, close = { showVouchers = false })
    voucherOrder?.let { order ->
        LiveVouchersView(m, order.id, order.source.textOrNull("tableSessionId")) {
            voucherOrder = null
        }
    }
    var showPrinting by remember { mutableStateOf(false) }
    var printingOrder by remember { mutableStateOf<CashierOrder?>(null) }
    if (showPrinting) LivePrintingView(m, close = { showPrinting = false })
    printingOrder?.let { order ->
        LivePrintingView(m, order.id, order.source.textOrNull("tableSessionId")) {
            printingOrder = null
        }
    }
    var afterSalesVisible by remember { mutableStateOf(false) }
    var afterSalesItem by remember { mutableStateOf<String?>(null) }
    if (afterSalesVisible)
        AfterSalesCenterView(m) {
            afterSalesVisible = false
            m.loadCashier(m.cashierQuery)
        }
    afterSalesItem?.let {
        LiveAfterSalesView(m, it) {
            afterSalesItem = null
            m.loadCashier(m.cashierQuery)
        }
    }
    var financeVisible by remember { mutableStateOf(false) }
    if (financeVisible)
        LiveFinanceView(m) {
            financeVisible = false
            m.loadCashier(m.cashierQuery)
        }
    var query by remember { mutableStateOf(initialQuery ?: m.cashierQuery) }
    var collection by remember { mutableStateOf<CashierOrder?>(null) }
    var historical by remember { mutableStateOf<CashierOrder?>(null) }
    historical?.let { order ->
        HistoricalCollectionView(m, order) {
            historical = null
            m.loadCashier(m.cashierQuery)
        }
    }
    collection?.let { order ->
        order.source.textOrNull("tableSessionId")?.let { session ->
            LiveCollectionView(m, session, order.code) {
                collection = null
                m.loadCashier(m.cashierQuery)
            }
        }
    }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    LaunchedEffect(Unit) { m.loadCashier(query) }
    Brand("收银", "门店 · 原款与退款")
    Body {
        LivePendingView(m)
        if (m.canReadVouchers || m.canReadPrinting || m.canReadAfterSales || m.canReadFinance) {
            Foldout("收银工具 · 售后 / 团购 / 交接 / 票据") {
                if (m.canReadFinance)
                    SecondaryAction(
                        onClick = { showCashHandover = true },
                        icon = Icons.Outlined.AccountBalanceWallet,
                    ) {
                        Text("现金盘点与双人交接")
                    }
                if (m.canReadVouchers)
                    SecondaryAction(
                        onClick = { showVouchers = true },
                        icon = Icons.Outlined.ConfirmationNumber,
                    ) {
                        Text("团购券核销与原事项恢复")
                    }
                if (m.canReadPrinting)
                    SecondaryAction(
                        onClick = { showPrinting = true },
                        icon = Icons.Outlined.Print,
                    ) {
                        Text("票据与打印")
                    }
                if (m.canReadAfterSales)
                    SecondaryAction(
                        onClick = { afterSalesVisible = true },
                        icon = Icons.Outlined.Inventory,
                    ) {
                        Text("商品售后 · 跨日待办")
                    }
                if (m.canReadFinance)
                    SecondaryAction(
                        onClick = { financeVisible = true },
                        icon = Icons.Outlined.Assessment,
                    ) {
                        Text("日结与对账 · 财务跟进")
                    }
            }
        }
        if (!m.canReadCashier) Text("当前岗位没有收银工作台权限")
        else {
            OutlinedTextField(
                query,
                { query = it },
                label = { Text("桌号或订单号，最多64字") },
                enabled = !m.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            Primary("查询", enabled = !m.busy, icon = Icons.Outlined.Search) { m.loadCashier(query) }
            if (m.cashierState.isNotEmpty()) Text(m.cashierState)
            m.cashier?.let { board ->
                Text("营业日 ${board.date} · 本次返回 ${board.orders.size}单")
                Text("最多显示100单，未结款与退款优先；更多历史请在订单页查询。", fontSize = 12.sp)
                if (query.trim() != m.cashierQuery) Text("筛选已更改，请点击查询更新结果。", fontSize = 12.sp)
                if (board.orders.isEmpty()) Text("当前查询没有收银记录")
                if (
                    board.actions.optBoolean("canUseActivityCashier") &&
                        board.activities.isNotEmpty()
                )
                    Foldout("活动收银 · ${board.activities.size}笔原报名") {
                        board.activities.forEach { r ->
                            key(r.id) { ActivityCashierCard(m, r) { proposed = it } }
                        }
                    }
                board.orders.forEach { order ->
                    key(order.id) {
                        Foldout("${order.code} · 应收 ${historyMoney(order.due)}") {
                            Text(order.publicId)
                            Text(
                                "原营业日：${order.source.textOrNull("businessDate") ?: board.date} · 桌次：${order.source.textOrNull("tableSessionId") ?: "未留存"}",
                                fontSize = 12.sp,
                            )
                            Text(
                                "当前订单应付 ${historyMoney(order.amount)} · ${historyStatus(order.paymentStatus)}"
                            )
                            if (order.over > 0) Text("已确认多收 ${historyMoney(order.over)}，请核对原付款退款")
                            if (
                                order.source.textOrNull("tableSessionId") != null &&
                                    order.source.textOrNull("tableSessionStatus") in
                                        listOf("open", "closing") &&
                                    LivePaymentOrder.permissions.any {
                                        m.identity?.allows(it) == true
                                    }
                            )
                                SecondaryAction(
                                    onClick = { collection = order },
                                    enabled = !m.busy,
                                    icon = Icons.Outlined.CreditCard,
                                ) {
                                    Text("查看本桌应收 · 登记收款")
                                }
                            if (order.recovery?.optString("status") == "available") {
                                if (board.actions.optBoolean("supportsGuardedClosedDebtCollection"))
                                    SecondaryAction(
                                        onClick = { historical = order },
                                        enabled =
                                            LiveCashier.collectionMethods.keys.any {
                                                m.canCollectHistorical(it)
                                            },
                                        icon = Icons.Outlined.CreditCard,
                                    ) {
                                        Text("登记历史欠款已收到")
                                    }
                                else Text("历史补收需要服务器升级后开放，暂请使用网页原单处理。", fontSize = 12.sp)
                            }
                            if (m.canReadAfterSales)
                                financeRows(order.source, "items").forEach { item ->
                                    SecondaryAction(
                                        onClick = { afterSalesItem = item.getString("id") },
                                        icon = Icons.Outlined.Inventory,
                                    ) {
                                        Text("处理原商品 · " + item.getString("productName"))
                                    }
                                }
                            if (m.canReadVouchers)
                                SecondaryAction(
                                    onClick = { voucherOrder = order },
                                    icon = Icons.Outlined.ConfirmationNumber,
                                ) {
                                    Text("关联原单核销团购券")
                                }
                            if (m.identity?.allows("order.bill.print") == true)
                                SecondaryAction(
                                    onClick = { printingOrder = order },
                                    icon = Icons.Outlined.Print,
                                ) {
                                    Text("账单与打印状态")
                                }
                            UnpaidOrderControls(m, order) { proposed = it }
                            CashierRecoveryControls(m, order) { proposed = it }
                            order.payments.forEach { payment ->
                                key(payment.id) {
                                    CashierPaymentCard(m, order, payment) { proposed = it }
                                }
                            }
                            if (order.payments.isEmpty()) Text("尚无付款记录，不代表订单已结清。", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = {
                Text(
                    command.steps.first().activityProof?.textOrNull("confirmation")
                        ?: command.steps.first().cashierProof?.textOrNull("confirmation")
                        ?: "申请不代表已退款。复核通过可能触发线上原路退款；线下结果只能按实际退付登记。未知结果必须核对原请求。",
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    }
                ) {
                    Text("确认以上原交易操作")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun CashierPaymentCard(
    m: AppModel,
    order: CashierOrder,
    payment: CashierPayment,
    propose: (LiveCommand) -> Unit,
) {
    var closeReason by remember { mutableStateOf("") }
    var drafting by remember { mutableStateOf(false) }
    fun act(
        action: String,
        refundID: String = "",
        reason: String = "",
        reference: String = "",
        succeeded: Boolean = true,
    ) {
        try {
            propose(
                m.prepareCashier(
                    order.id,
                    payment.id,
                    action,
                    refundID,
                    reason = reason,
                    reference = reference,
                    succeeded = succeeded,
                )
            )
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新核对"
        }
    }
    HorizontalDivider()
    Text(
        "${cashierProvider(payment.provider)} · ${cashierStatus(payment.status)}",
        style = MaterialTheme.typography.titleSmall,
    )
    Text(payment.publicId, fontSize = 12.sp)
    Text(
        "本单分摊 ${historyMoney(payment.amount)} · 剩余可退 ${historyMoney(payment.remaining)} · 在途占用 ${historyMoney(payment.reserved)}"
    )
    payment.source.textOrNull("retryReleaseReason")?.let { Text("原款保留待核对：$it", fontSize = 12.sp) }
    if (
        payment.provider == "postar" &&
            m.cashier?.actions?.optBoolean("canQueryOnlinePayment") == true
    )
        SecondaryAction(
            onClick = { act("payment-query") },
            enabled = m.canAct("reconciliation.view"),
            icon = Icons.Outlined.Refresh,
        ) {
            Text("查询原付款渠道结果")
        }
    if (
        payment.provider == "postar" &&
            payment.status in listOf("created", "pending") &&
            m.cashier?.actions?.optBoolean("supportsProviderClose") == true
    ) {
        OutlinedTextField(closeReason, { closeReason = it }, label = { Text("渠道关单原因（4—500字）") })
        SecondaryAction(
            onClick = { act("payment-close", reason = closeReason) },
            enabled = m.canAct("reconciliation.view"),
            icon = Icons.Outlined.Cancel,
        ) {
            Text("核对渠道并关闭原付款")
        }
    }
    if (payment.remaining > 0 && m.cashier?.actions?.optBoolean("canRequestRefund") == true)
        SecondaryAction(
            onClick = { drafting = true },
            enabled = m.canAct("refund.request"),
            icon = Icons.Outlined.Undo,
        ) {
            Text(
                if (payment.refunds.any { it.status in listOf("failed", "rejected", "cancelled") })
                    "重新核对原商品 · 申请退款"
                else "选择原商品 · 申请退款"
            )
        }
    payment.refunds.forEach { refund ->
        key(refund.id) {
            CashierRefundCard(m, payment, refund) { action, reason, reference, succeeded ->
                act(action, refund.id, reason, reference, succeeded)
            }
        }
    }
    if (drafting) CashierRefundDraft(m, order, payment) { drafting = false }
}

@Composable
fun CashierRefundCard(
    m: AppModel,
    payment: CashierPayment,
    refund: CashierRefund,
    act: (String, String, String, Boolean) -> Unit,
) {
    var decision by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    Foldout("退款 ${historyMoney(refund.amount)} · ${cashierStatus(refund.status)}") {
        Text(refund.publicId, fontSize = 12.sp)
        Text("${refund.requesterName} 发起 · ${refund.reason}")
        refund.source.textOrNull("purpose")?.let {
            Text(refundPurposes[it] ?: it, fontSize = 12.sp)
        }
        refund.source.textOrNull("decisionReason")?.let { Text("复核说明：$it") }
        refund.source.textOrNull("receiptReference")?.let { Text("退款凭证：$it") }
        if (refund.status in listOf("failed", "rejected", "cancelled"))
            Text("该次退款未成功，原记录保留。刷新剩余可退金额后，从原付款重新申请并重新复核；在途退款不能这样重开。", fontSize = 12.sp)
        if (refund.afterSales != null) Text("此笔关联商品售后，请打开本单“处理原商品”核对资金与实物进度。", fontSize = 12.sp)
        else {
            if (refund.status == "requested") {
                if (refund.requester == m.identity?.employeeId)
                    Text("请交给另一名有退款复核权限和额度的员工。", fontSize = 12.sp)
                else if (m.cashier?.actions?.optBoolean("canApproveRefund") == true) {
                    OutlinedTextField(
                        decision,
                        { decision = it },
                        label = { Text("复核说明（2—1000字）") },
                    )
                    Primary("复核通过", enabled = m.canAct("refund.approve")) {
                        act("approve", decision, "", true)
                    }
                    SecondaryAction(
                        onClick = { act("reject", decision, "", true) },
                        enabled = m.canAct("refund.approve"),
                    ) {
                        Text("驳回申请")
                    }
                }
            }
            if (
                refund.status == "approved" ||
                    (!payment.manual &&
                        refund.status == "processing" &&
                        refund.submission == "not_started")
            )
                Primary(
                    if (payment.manual) "开始人工退款" else "提交原路退款",
                    enabled = m.canAct("refund.execute"),
                ) {
                    act("execute", "", "", true)
                }
            if (payment.manual && refund.status == "processing") {
                Text("先实际退付再登记；本操作不会自动转账。", fontSize = 12.sp)
                if (payment.provider != "cash")
                    OutlinedTextField(reference, { reference = it }, label = { Text("独立退款凭证号") })
                Primary("款项已实际退给客人 · 登记成功", enabled = m.canAct("refund.execute")) {
                    act("manual-result", "", reference, true)
                }
                SecondaryAction(
                    onClick = { act("manual-result", "", reference, false) },
                    enabled = m.canAct("refund.execute"),
                ) {
                    Text("本次未退付成功 · 登记失败")
                }
            }
        }
        if (
            payment.provider == "postar" &&
                refund.status == "processing" &&
                refund.submission != "not_started"
        ) {
            Text("线上退款等待渠道确认，不能手工标为成功。", fontSize = 12.sp)
            SecondaryAction(
                onClick = { act("refund-query", "", "", true) },
                enabled = m.canAct("refund.execute"),
                icon = Icons.Outlined.Refresh,
            ) {
                Text("查询原退款结果")
            }
        }
    }
}

@Composable
private fun CashierRefundDraft(
    m: AppModel,
    order: CashierOrder,
    payment: CashierPayment,
    close: () -> Unit,
) {
    var amounts by remember { mutableStateOf(emptyMap<String, String>()) }
    var reason by remember { mutableStateOf("") }
    var purpose by remember { mutableStateOf("price_adjustment") }
    var menu by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(
                Modifier.safeDrawingPadding()
                    .imePadding()
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row {
                    Text("申请退款", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text("取消") }
                }
                Text(
                    "${order.code} · ${payment.publicId} · 剩余可退 ${historyMoney(payment.remaining)}"
                )
                Text("本操作提交退款申请，不自动停止出品或恢复库存。", fontSize = 12.sp)
                Box {
                    TextButton(onClick = { menu = true }) { Text(refundPurposes[purpose]!!) }
                    DropdownMenu(menu, { menu = false }) {
                        refundPurposes.forEach { (key, label) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    purpose = key
                                    menu = false
                                },
                            )
                        }
                    }
                }
                payment.items.forEach { item ->
                    Text("${item.name} · 可退 ${historyMoney(item.remaining)}")
                    if (item.fundsOnly) Text("仅资金处理，不作为商品退货", fontSize = 12.sp)
                    OutlinedTextField(
                        amounts[item.id] ?: "",
                        { amounts = amounts + (item.id to it) },
                        label = { Text("本次退款金额，留空不选") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    )
                }
                OutlinedTextField(
                    reason,
                    { reason = it },
                    label = { Text("退款原因（2—1000字）") },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                Primary("核对退款申请", enabled = m.canAct("refund.request")) {
                    try {
                        val values =
                            amounts
                                .filterValues { it.trim().isNotEmpty() }
                                .mapValues { (_, value) ->
                                    val amount = parseMoney(value)
                                    require(amount != null && amount > 0) { "退款金额必须为有效金额，最多两位小数" }
                                    amount.toLong()
                                }
                        proposed =
                            m.prepareCashier(
                                order.id,
                                payment.id,
                                "request",
                                amounts = values,
                                reason = reason,
                                purpose = purpose,
                            )
                    } catch (e: Exception) {
                        error = e.message ?: "请核对金额和原因"
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text("用途：${refundPurposes[purpose]}\n原因：$reason\n由另一名员工复核后才进入退款流程。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                        close()
                    }
                ) {
                    Text("确认原商品、金额与用途，提交申请")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun CashierRecoveryControls(
    m: AppModel,
    order: CashierOrder,
    propose: (LiveCommand) -> Unit,
) {
    var reason by remember { mutableStateOf("") }
    fun act(action: String, paymentID: String = "") {
        try {
            propose(m.prepareCashier(order.id, paymentID, action, reason = reason))
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新核对原单"
        }
    }
    order.authorization?.let {
        Text(
            "本单重新收款授权：${historyMoney(it.getLong("amountMinor"))} · 到期 ${it.getString("expiresAt")}",
            fontSize = 12.sp,
        )
        Text("授权不代表已收款；使用前由服务器重新核对余额及有效期。", fontSize = 12.sp)
    }
    order.recovery?.let {
        val status = it.getString("status")
        Text(
            "历史桌次 · " +
                (mapOf(
                    "available" to "允许补收原欠款",
                    "authorization_required" to "需重新收款授权",
                    "pending_payment" to "原付款尚待核对",
                    "permission_required" to "需要历史欠款权限",
                    "ineligible" to "暂不满足补收条件",
                    "settled" to "已结清",
                )[status] ?: "请刷新核对"),
            fontSize = 12.sp,
        )
    }
    val scopes =
        order.recovery?.optJSONArray("closableUnpresentedPayments")?.objects() ?: emptyList()
    if (order.needsRecollection || scopes.isNotEmpty()) {
        if (m.cashier?.actions?.optBoolean("canAuthorizeRecollection") == true) {
            OutlinedTextField(
                reason,
                { reason = it },
                label = { Text("授权或关闭原因（4—500字）") },
                modifier = Modifier.fillMaxWidth(),
            )
            if (order.needsRecollection)
                SecondaryAction(
                    onClick = { act("recollect") },
                    enabled = m.canAct("payment.recollect.authorize"),
                    icon = Icons.Outlined.CheckCircle,
                ) {
                    Text("客人同意再次支付 · 核对授权")
                }
            if (order.recovery?.optString("status") == "pending_payment")
                scopes.forEach { scope ->
                    val ids =
                        scope.getJSONArray("orderPublicIds").let { a ->
                            (0 until a.length()).map { a.getString(it) }
                        }
                    Text(
                        "整笔 ${historyMoney(scope.getLong("totalAmountMinor"))} · ${ids.joinToString("、")}",
                        fontSize = 12.sp,
                    )
                    SecondaryAction(
                        onClick = { act("close-history", scope.getString("paymentId")) },
                        enabled =
                            m.canAct("payment.recollect.authorize") &&
                                listOf(
                                        "payment.initiate.staff",
                                        "reconciliation.view",
                                        "payment.collect.all_tables",
                                    )
                                    .all { m.identity?.allows(it) == true },
                        icon = Icons.Outlined.Close,
                    ) {
                        Text("核对并关闭历史未外送付款")
                    }
                }
        } else Text("请交由具有重新收款授权权限的员工处理。", fontSize = 12.sp)
    }
}

@Composable
private fun HistoricalCollectionView(m: AppModel, order: CashierOrder, close: () -> Unit) {
    var provider by remember {
        mutableStateOf(
            listOf("cash", "physical_pos", "external_manual").firstOrNull {
                m.canCollectHistorical(it)
            } ?: "cash"
        )
    }
    var tender by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var terminal by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("bank_transfer") }
    var note by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var menu by remember { mutableStateOf(false) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(
                Modifier.safeDrawingPadding()
                    .imePadding()
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row {
                    Text("历史欠款补收", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text("关闭") }
                }
                LivePendingView(m)
                Text("${order.code} · ${order.publicId}")
                Text("原营业日：${order.recovery?.optString("originalBusinessDate")}")
                Text(
                    "本次全额补收 ${historyMoney(order.due)}",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text("只登记已实际收到的款项；保持原桌次关闭，不新增出品。本入口暂不支持部分补收。", fontSize = 12.sp)
                Row {
                    listOf("cash", "physical_pos", "external_manual")
                        .filter {
                            m.identity?.allows(LiveCashier.collectionMethods[it]!![0]) == true
                        }
                        .forEach { key ->
                            FilterChip(
                                selected = provider == key,
                                onClick = { provider = key },
                                label = { Text(LiveCashier.collectionMethods[key]!![3]) },
                            )
                        }
                }
                if (provider == "cash") {
                    OutlinedTextField(
                        tender,
                        { tender = it },
                        label = { Text("实际收到现金") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    )
                    parseMoney(tender)?.toLong()?.let {
                        if (it >= order.due) Text("找零 ${historyMoney(it - order.due)}")
                    }
                } else {
                    OutlinedTextField(reference, { reference = it }, label = { Text("原收款凭证号") })
                    OutlinedTextField(terminal, { terminal = it }, label = { Text("终端编号（如有）") })
                }
                if (provider == "external_manual") {
                    val methods =
                        linkedMapOf(
                            "bank_transfer" to "银行转账",
                            "mobile_wallet" to "移动支付",
                            "stored_value_voucher" to "储值凭证",
                            "corporate_account" to "公司账户",
                            "other" to "其他",
                        )
                    Box {
                        TextButton(onClick = { menu = true }) { Text(methods[method]!!) }
                        DropdownMenu(menu, { menu = false }) {
                            methods.forEach { (key, name) ->
                                DropdownMenuItem(
                                    text = { Text(name) },
                                    onClick = {
                                        method = key
                                        menu = false
                                    },
                                )
                            }
                        }
                    }
                    OutlinedTextField(note, { note = it }, label = { Text("收款说明") })
                }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                Primary("核对原单与实际到账", enabled = m.canCollectHistorical(provider)) {
                    try {
                        proposed =
                            m.prepareHistoricalCollection(
                                order,
                                provider,
                                parseMoney(tender)?.toLong(),
                                reference,
                                if (provider == "cash") "" else terminal,
                                method,
                                note,
                            )
                        error = ""
                    } catch (e: Exception) {
                        error = e.message ?: "请刷新核对原单"
                    }
                }
                Text("资料超过60秒或发生变化时，请关闭表单并重新查询原单；不要重复收取客人款项。", fontSize = 12.sp)
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text(command.steps.first().cashierProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                        close()
                    }
                ) {
                    Text("确认以上款项已收到，登记原单")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun UnpaidOrderControls(m: AppModel, order: CashierOrder, propose: (LiveCommand) -> Unit) {
    var editing by remember(order.id) { mutableStateOf(false) }
    var reasonCode by remember(order.id) { mutableStateOf("") }
    var note by remember(order.id) { mutableStateOf("") }
    val settle = order.source.getString("status") == "cancelled"
    val permission = if (settle) "order.settle_exception" else "order.cancel_unpaid"
    val settlement = order.source.optJSONObject("settlementException")
    settlement?.let {
        Text("已异常结清 ${historyMoney(it.getLong("settledAmountMinor"))} · 未生成实际收款", fontSize = 12.sp)
    }
    val delivered =
        order.source.getJSONArray("items").let { a ->
            (0 until a.length()).any { a.getJSONObject(it).getString("status") == "delivered" }
        }
    if (
        order.paymentStatus == "unpaid" &&
            m.identity?.allows(permission) == true &&
            (!settle || order.due > 0 && settlement == null && delivered)
    ) {
        if (editing) {
            val reasons =
                if (settle)
                    linkedMapOf("manager_comp" to "店长确认免单", "uncollectible" to "确认无法收回").also {
                        if (m.identity?.roles?.contains("OWNER") == true)
                            it["test_cleanup"] = "测试数据清理（老板）"
                    }
                else
                    linkedMapOf(
                        "guest_left" to "客人离店未付款",
                        "duplicate_order" to "重复订单",
                        "test_cleanup" to "测试或跨日清理",
                        "other" to "其他",
                    )
            reasons.forEach { (key, label) ->
                Row {
                    RadioButton(selected = reasonCode == key, onClick = { reasonCode = key })
                    Text(label, modifier = Modifier.padding(top = 12.dp))
                }
            }
            OutlinedTextField(
                note,
                { note = it },
                label = { Text("现场核对说明（4—500字）") },
                modifier = Modifier.fillMaxWidth(),
            )
            Text("不生成实际收款；已送达商品、库存和原营业日记录保留。在途款项必须先核对。", fontSize = 12.sp)
            Primary("核对原单并继续", enabled = m.canAct(permission), icon = Icons.Outlined.Warning) {
                runCatching { m.prepareUnpaid(order.id, settle, reasonCode, note) }
                    .onSuccess(propose)
                    .onFailure { m.message = it.message ?: "请刷新原单核对" }
            }
            TextButton(
                onClick = {
                    editing = false
                    note = ""
                }
            ) {
                Text("取消编辑")
            }
        } else
            SecondaryAction(
                onClick = {
                    reasonCode = if (settle) "manager_comp" else "guest_left"
                    editing = true
                },
                enabled = m.canAct(permission),
                icon = Icons.Outlined.Warning,
            ) {
                Text(if (settle) "异常结清已送达未付款金额" else "处理未付款原订单")
            }
    }
}
