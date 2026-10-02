package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
import java.util.Locale

@Composable
fun LiveCollectionView(m: AppModel, session: String, tableCode: String, close: () -> Unit) {
    var onlineVisible by remember { mutableStateOf(false) }
    if (onlineVisible)
        LiveOnlinePaymentView(m, session, tableCode) {
            onlineVisible = false
            m.loadPaymentOrders(session)
        }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    val providers =
        listOf(
            Triple("cash", "现金", "payment.manual.cash.record"),
            Triple("physical_pos", "实体POS", "payment.manual.pos.record"),
            Triple("external_manual", "外部收款", "payment.manual.external.record"),
        )
    var provider by remember {
        mutableStateOf(
            providers.firstOrNull { m.identity?.allows(it.third) == true }?.first ?: "cash"
        )
    }
    var amount by remember { mutableStateOf("") }
    var tender by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var terminal by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("bank_transfer") }
    var note by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val total = m.paymentOrders.filter { it.id in selected }.sumOf { it.amount.toLong() }
    LaunchedEffect(session) { m.loadPaymentOrders(session) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text(
                        "$tableCode · 收款",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    TextButton(onClick = { m.loadPaymentOrders(session) }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        if (m.paymentState.isNotBlank()) Text(m.paymentState)
                        LivePendingView(m)
                        if (m.identity?.allows("payment.initiate.staff") == true)
                            Primary("扫码 / 展示付款码 · 线上收款", icon = Icons.Outlined.QrCode) {
                                onlineVisible = true
                            }
                    }
                    items(m.paymentOrders, key = { it.id }) { order ->
                        Panel {
                            Row {
                                Checkbox(
                                    order.id in selected,
                                    { checked ->
                                        selected =
                                            if (checked) selected + order.id
                                            else selected - order.id
                                        amount =
                                            String.format(
                                                Locale.CHINA,
                                                "%.2f",
                                                m.paymentOrders
                                                    .filter { it.id in selected }
                                                    .sumOf { it.amount.toLong() } / 100.0,
                                            )
                                    },
                                    enabled =
                                        order.selectable &&
                                            !m.busy &&
                                            m.livePending == null &&
                                            m.liveOrderPending == null,
                                )
                                Column(Modifier.weight(1f)) {
                                    Text(order.publicId, fontSize = 13.sp)
                                    Text(
                                        "应收 " +
                                            if (order.currency == "CNY") money(order.amount)
                                            else order.currency + " · 请到收银台处理"
                                    )
                                    if (order.pending || order.pendingId != null)
                                        Text("原线上付款待确认，暂不能重复收款", fontSize = 12.sp)
                                    else if (order.amount == 0) Text("当前无应收", fontSize = 12.sp)
                                }
                            }
                        }
                    }
                    if (selected.isNotEmpty())
                        item {
                            Panel {
                                Text(
                                    "已选 ${selected.size} 笔 · 应收 ¥" +
                                        String.format(Locale.CHINA, "%.2f", total / 100.0),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                providers
                                    .filter { m.identity?.allows(it.third) == true }
                                    .forEach { type ->
                                        FilterChip(
                                            provider == type.first,
                                            { provider = type.first },
                                            label = { Text(type.second) },
                                        )
                                    }
                                OutlinedTextField(
                                    amount,
                                    { amount = it },
                                    label = { Text("本次登记金额，可部分收款") },
                                    keyboardOptions =
                                        KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                )
                                if (provider == "cash") {
                                    OutlinedTextField(
                                        tender,
                                        { tender = it },
                                        label = { Text("实际收到现金") },
                                        keyboardOptions =
                                            KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    )
                                    val cash = parseMoney(tender)
                                    val value = parseMoney(amount)
                                    if (cash != null && value != null && cash >= value)
                                        Text("找零 " + money(cash - value))
                                    Text("只有本次登记金额计入已收；找零不计入收款。", fontSize = 12.sp)
                                } else {
                                    OutlinedTextField(
                                        reference,
                                        { reference = it },
                                        label = { Text("原收款凭证号") },
                                    )
                                    OutlinedTextField(
                                        terminal,
                                        { terminal = it },
                                        label = { Text("终端编号（如有）") },
                                    )
                                }
                                if (provider == "external_manual") {
                                    listOf(
                                            "bank_transfer" to "银行转账",
                                            "mobile_wallet" to "移动支付",
                                            "stored_value_voucher" to "储值凭证",
                                            "corporate_account" to "公司账户",
                                            "other" to "其他",
                                        )
                                        .forEach { type ->
                                            FilterChip(
                                                method == type.first,
                                                { method = type.first },
                                                label = { Text(type.second) },
                                            )
                                        }
                                    OutlinedTextField(note, { note = it }, label = { Text("收款说明") })
                                }
                                if (error.isNotBlank())
                                    Text(error, color = MaterialTheme.colorScheme.error)
                                Primary(
                                    "核对并登记已收款",
                                    !m.busy &&
                                        m.paymentUpdated != null &&
                                        m.livePending == null &&
                                        m.liveOrderPending == null,
                                ) {
                                    try {
                                        val value = parseMoney(amount)
                                        require(value != null && value > 0) { "请输入正确的收款金额" }
                                        if (provider == "cash")
                                            require(
                                                parseMoney(tender)?.let { it >= value } == true
                                            ) {
                                                "实际收到现金不能少于本次登记金额"
                                            }
                                        proposed =
                                            m.prepareCollection(
                                                session,
                                                selected,
                                                value,
                                                provider,
                                                reference,
                                                terminal,
                                                method,
                                                note,
                                            )
                                        error = ""
                                    } catch (e: Exception) {
                                        error = e.message ?: "请刷新后重新核对"
                                    }
                                }
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
            text = { Text("请核对实际到账与原凭证。此操作登记真实收款，不会代替POS或银行扣款。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                    }
                ) {
                    Text("确认款项已收到，登记")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("取消") } },
        )
    }
}
