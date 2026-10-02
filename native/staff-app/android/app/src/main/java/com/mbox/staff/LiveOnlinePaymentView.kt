package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun LiveOnlinePaymentView(m: AppModel, session: String, tableCode: String, close: () -> Unit) {
    var selected by remember { mutableStateOf(emptySet<String>()) }
    var amount by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var now by remember { mutableStateOf(Instant.now()) }
    val version = remember { m.workspaceVersion }
    var scanActor by remember { mutableStateOf<String?>(null) }
    val scanLauncher =
        rememberLauncherForActivityResult(ScanContract()) { result ->
            if (
                m.workspaceVersion == version &&
                    m.identity?.employeeId == scanActor &&
                    m.paymentSession == session
            ) {
                result.contents?.let { value ->
                    if (Regex("^[0-9]{16,32}$").matches(value)) code = value
                    else error = "识别的不是有效付款码，请顾客打开付款码后重试"
                }
            }
        }
    LaunchedEffect(m.workspaceVersion) {
        if (m.workspaceVersion != version) {
            code = ""
            close()
        }
    }
    LaunchedEffect(session) {
        m.loadOnline(session)
        while (isActive) {
            val receipt = m.onlineReceipts.optJSONObject(session)
            if (receipt?.getString("employeeID") == m.identity?.employeeId)
                m.pollOnline(
                    receipt.getJSONObject("response").getJSONObject("data").getString("id"),
                    session,
                )
            delay(10000)
        }
    }
    LaunchedEffect(Unit) {
        while (isActive) {
            now = Instant.now()
            delay(1000)
        }
    }
    val orders = if (m.paymentSession == session) m.paymentOrders else emptyList()
    val receipt =
        m.onlineReceipts.optJSONObject(session)?.takeIf {
            it.getString("employeeID") == m.identity?.employeeId
        }
    LaunchedEffect(receipt?.optString("commandID")) {
        if (receipt != null) {
            selected = emptySet()
            code = ""
            amount = ""
        }
    }
    fun propose(method: String) {
        try {
            proposed =
                m.prepareOnline(
                    session,
                    selected,
                    parseMoney(amount) ?: throw IllegalArgumentException("请输入正确金额"),
                    method,
                    code,
                )
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请刷新核对"
        }
    }
    val scope = rememberCoroutineScope()
    Dialog(
        onDismissRequest = {
            code = ""
            close()
        },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text(
                        "$tableCode · 线上收款",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    TextButton(onClick = { m.loadOnline(session) }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(
                        onClick = {
                            code = ""
                            close()
                        }
                    ) {
                        Text("关闭")
                    }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        LivePendingView(m)
                        if (m.onlineState.isNotEmpty()) Text(m.onlineState, fontSize = 12.sp)
                        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                        if (
                            m.onlineAccess?.optBoolean("canInitiatePayment") != true ||
                                m.onlineAccess?.textOrNull("onlinePaymentProvider") != "postar"
                        )
                            Text("线上收款未开放或尚未读取，可返回登记已收到的现金/POS款。", fontSize = 12.sp)
                    }
                    if (receipt != null)
                        item {
                            val data = receipt.getJSONObject("response").getJSONObject("data")
                            val id = data.getString("id")
                            val status = m.onlineStatuses[id] ?: "unknown"
                            Card {
                                Column(
                                    Modifier.padding(14.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        "原付款 " + historyMoney(data.longOrNull("amountMinor")),
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Text(data.getString("publicId"), fontSize = 12.sp)
                                    Text(
                                        if (status == "unknown") "付款状态待查询"
                                        else cashierStatus(status)
                                    )
                                    val qr = onlineQR(receipt, status, now)
                                    val bitmap =
                                        remember(qr) {
                                            qr?.let {
                                                runCatching {
                                                        BarcodeEncoder()
                                                            .encodeBitmap(
                                                                it,
                                                                BarcodeFormat.QR_CODE,
                                                                512,
                                                                512,
                                                            )
                                                    }
                                                    .getOrNull()
                                            }
                                        }
                                    if (bitmap != null)
                                        Image(
                                            bitmap.asImageBitmap(),
                                            "本次付款二维码，请顾客扫码",
                                            Modifier.fillMaxWidth().heightIn(max = 280.dp),
                                        )
                                    else if (status == "pending")
                                        Text("原付款待确认；二维码过期、不可用或扫码已受理时，不应重复收款。", fontSize = 12.sp)
                                    SecondaryAction(
                                        onClick = { scope.launchPoll(m, id, session) },
                                        enabled = !m.busy,
                                        icon = Icons.Outlined.Refresh,
                                    ) {
                                        Text("刷新原付款到账状态")
                                    }
                                    if (receipt.getString("kind") == "release")
                                        Text("已允许另行收款，旧款仍需核对后到结果。", fontSize = 12.sp)
                                }
                            }
                        }
                    item {
                        Foldout("本次线上收款 · 已选${selected.size}单") {
                            orders.forEach { row ->
                                SecondaryAction(
                                    onClick = {
                                        selected =
                                            if (row.id in selected) selected - row.id
                                            else selected + row.id
                                        amount =
                                            java.math.BigDecimal.valueOf(
                                                    orders
                                                        .filter { it.id in selected }
                                                        .sumOf { it.amount.toLong() },
                                                    2,
                                                )
                                                .toPlainString()
                                    },
                                    enabled = row.selectable && !m.busy && m.livePending == null,
                                    icon =
                                        if (row.id in selected) Icons.Outlined.CheckCircle
                                        else Icons.Outlined.RadioButtonUnchecked,
                                ) {
                                    Column {
                                        Text(row.publicId, fontSize = 12.sp)
                                        Text("应收 " + money(row.amount))
                                        if (!row.selectable) Text("原款未明或无可收余额", fontSize = 12.sp)
                                    }
                                }
                            }
                            OutlinedTextField(
                                amount,
                                { amount = it },
                                label = { Text("本次收款金额，可部分收款") },
                                keyboardOptions =
                                    KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Primary(
                                "核对并展示付款二维码",
                                enabled =
                                    m.canAct("payment.initiate.staff") && selected.isNotEmpty(),
                                icon = Icons.Outlined.QrCode,
                            ) {
                                propose("native_qr")
                            }
                            SecondaryAction(
                                onClick = {
                                    scanActor = m.identity?.employeeId
                                    scanLauncher.launch(
                                        ScanOptions()
                                            .setDesiredBarcodeFormats(
                                                ScanOptions.QR_CODE,
                                                ScanOptions.CODE_128,
                                            )
                                            .setPrompt("扫描顾客付款码，识别后还需核对金额")
                                            .setBeepEnabled(false)
                                            .setBarcodeImageEnabled(false)
                                            .setOrientationLocked(false)
                                    )
                                },
                                enabled = !m.busy,
                                icon = Icons.Outlined.QrCodeScanner,
                            ) {
                                Text("扫描顾客付款码")
                            }
                            OutlinedTextField(
                                code,
                                { code = it },
                                label = { Text("付款码（16—32位数字，可手动输入）") },
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions =
                                    KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text("识别后仍需核对金额并确认扣款；不要输入银行卡号或密码。", fontSize = 12.sp)
                            Primary(
                                "核对付款码并请求扣款",
                                enabled =
                                    m.canAct("payment.initiate.staff") &&
                                        code.isNotEmpty() &&
                                        selected.isNotEmpty(),
                                icon = Icons.Outlined.CreditCard,
                            ) {
                                propose("auth_code")
                            }
                        }
                    }
                    val pendingIDs = orders.mapNotNull { it.pendingId }.distinct().sorted()
                    if (pendingIDs.isNotEmpty())
                        item {
                            Foldout("原付款待核对 · ${pendingIDs.size}笔") {
                                Text(
                                    "不要因二维码过期或网络错误直接重收。先查询状态；更换付款方式前须确认旧款后到可能导致重复付款。",
                                    fontSize = 12.sp,
                                )
                                OutlinedTextField(
                                    reason,
                                    { reason = it },
                                    label = { Text("重收原因（4—500字）") },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                pendingIDs.forEach { id ->
                                    Text(id, fontSize = 12.sp)
                                    Text(
                                        cashierStatus(m.onlineStatuses[id] ?: "unknown"),
                                        fontSize = 12.sp,
                                    )
                                    SecondaryAction(
                                        onClick = { scope.launchPoll(m, id, session) },
                                        enabled = !m.busy,
                                    ) {
                                        Text("刷新此原付款状态")
                                    }
                                    SecondaryAction(
                                        onClick = {
                                            try {
                                                proposed =
                                                    m.prepareOnlineRelease(session, id, reason)
                                            } catch (e: Exception) {
                                                error = e.message ?: "请刷新核对"
                                            }
                                        },
                                        enabled = m.canAct("payment.initiate.staff"),
                                        danger = true,
                                    ) {
                                        Text("保留旧款待核对，允许重收")
                                    }
                                }
                            }
                        }
                }
            }
        }
    }
    proposed?.let { command ->
        Dialog(
            onDismissRequest = { proposed = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                LazyColumn(
                    Modifier.safeDrawingPadding().padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    item { Text(command.title, style = MaterialTheme.typography.titleLarge) }
                    item { Text(command.steps[0].onlineProof!!.getString("confirmation")) }
                    item {
                        Primary(
                            "确认提交",
                            enabled = m.canAct(command.permission),
                            icon = Icons.Outlined.CheckCircle,
                        ) {
                            proposed = null
                            code = ""
                            m.executeLive(command)
                        }
                    }
                    item { SecondaryAction(onClick = { proposed = null }) { Text("返回修改") } }
                }
            }
        }
    }
}

private fun kotlinx.coroutines.CoroutineScope.launchPoll(m: AppModel, id: String, session: String) =
    launch {
        m.pollOnline(id, session)
    }
