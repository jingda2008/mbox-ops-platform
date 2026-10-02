package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject

fun voucherStatus(v: String) =
    mapOf(
        "dispatching" to "平台处理中，待核对",
        "unknown" to "平台结果未知，禁止重复核销",
        "provider_succeeded" to "平台已核销，待完成本地登记",
        "recorded" to "已登记核销，未记作结算款",
        "not_consumed" to "双人已核对未核销",
    )[v] ?: v

@Composable
fun LiveVouchersView(
    m: AppModel,
    orderID: String? = null,
    sessionID: String? = null,
    close: () -> Unit,
) {
    var associate by remember { mutableStateOf(true) }
    var platform by remember { mutableStateOf("meituan") }
    var code by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var day by remember { mutableStateOf(m.cashier?.date ?: "") }
    LaunchedEffect(Unit) { m.loadVouchers() }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) {
        if (m.workspaceVersion != version) {
            code = ""
            close()
        }
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.safeDrawingPadding().imePadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    TextButton(onClick = close) { Text("返回") }
                    Text("团购券核销", style = MaterialTheme.typography.titleLarge)
                    LivePendingView(m)
                    Text(m.voucherState, fontSize = 12.sp)
                    Primary("刷新原核销事项", enabled = !m.busy) { m.loadVouchers() }
                }
                item {
                    Foldout("查询券码与确认核销") {
                        m.voucherPlatforms.forEach { p ->
                            FilterChip(
                                selected = platform == p.getString("code"),
                                onClick = { platform = p.getString("code") },
                                label = {
                                    Text(
                                        p.getString("label") +
                                            (if (
                                                p.getBoolean("enabled") &&
                                                    p.getString("mode") == "production"
                                            )
                                                ""
                                            else " · 未开放正式核销")
                                    )
                                },
                            )
                        }
                        OutlinedTextField(code, { code = it }, label = { Text("原券码") })
                        if (orderID != null && sessionID != null) {
                            Row {
                                Checkbox(associate, { associate = it })
                                Text("关联此原订单 $orderID")
                            }
                        } else Text("从收银原订单进入可关联桌次；这里默认不关联桌单。", fontSize = 12.sp)
                        Primary("查询原券，暂不核销", enabled = m.canUseVouchers) {
                            m.prepareVoucherPreview(platform, code)
                        }
                        m.voucherPreview?.let { p ->
                            Text("${p.getString("platformLabel")} · ${p.getString("campaignName")}")
                            Text(
                                "${p.getString("voucherCodeMasked")} · ${p.getInt("quantity")}份 · ${p.getString("statusLabel")}"
                            )
                            Text(
                                "面额 ${historyMoney(p.getLong("faceValueMinor"))} · 平台结算额 ${historyMoney(p.getLong("settlementAmountMinor"))}",
                                fontSize = 12.sp,
                            )
                            Text("券有效期：${p.getString("expiresAt")}", fontSize = 12.sp)
                            Primary(
                                "核对后确认核销此券",
                                enabled = m.canUseVouchers && platform == p.getString("platform"),
                            ) {
                                try {
                                    proposed =
                                        m.prepareVoucher(
                                            code,
                                            if (associate) orderID else null,
                                            if (associate) sessionID else null,
                                        )
                                } catch (e: Exception) {
                                    m.message = e.message ?: "请核对原券"
                                }
                            }
                        }
                    }
                }
                item {
                    OutlinedTextField(search, { search = it }, label = { Text("筛选原事项：活动、脱敏券码或编号") })
                }
                item {
                    Foldout("查询历史核销与结算状态") {
                        OutlinedTextField(day, { day = it }, label = { Text("原营业日 YYYY-MM-DD") })
                        Primary("查询该营业日原核销记录", enabled = !m.busy) { m.loadVoucherHistory(day) }
                        Text(m.voucherHistoryState, fontSize = 12.sp)
                        m.voucherHistory.forEach { r ->
                            Text("${r.getString("platform")} · ${r.getString("campaignName")}")
                            Text(
                                "${r.getString("voucherCodeMasked")} · ${r.getString("publicId")}",
                                fontSize = 12.sp,
                            )
                            Text(
                                "面额 ${historyMoney(r.getLong("faceValueMinor"))} · 平台结算额 ${historyMoney(r.getLong("settlementAmountMinor"))}\n${if(r.getBoolean("isSettled"))"已关联服务器结算流水" else "尚未关联结算流水"}",
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
                items(
                    m.voucherOperations.filter {
                        search.isBlank() ||
                            listOf(
                                    it.getString("campaignName"),
                                    it.getString("voucherCodeMasked"),
                                    it.getString("publicId"),
                                )
                                .joinToString(" ")
                                .contains(search, true)
                    },
                    key = { it.getString("id") },
                ) { row ->
                    VoucherOperationCard(m, row) { proposed = it }
                }
                item {
                    if (m.voucherOperations.isEmpty())
                        Text("当前没有已加载的核销事项。旧核销记录仍保留在服务器；未返回不能当作未核销。", fontSize = 12.sp)
                }
            }
        }
    }
    proposed?.let { c ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(c.title) },
            text = {
                Text(
                    c.steps[0].voucherProof!!.getString("confirmation"),
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(c)
                        code = ""
                    },
                    enabled = m.canExecuteLive(c),
                ) {
                    Text("确认以上原券操作")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } },
        )
    }
}

@Composable
private fun VoucherOperationCard(m: AppModel, row: JSONObject, propose: (LiveCommand) -> Unit) {
    var outcome by remember { mutableStateOf("consumed") }
    var certificate by remember { mutableStateOf("") }
    var verify by remember { mutableStateOf("") }
    var evidence by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    fun act(action: String) {
        try {
            propose(
                m.prepareVoucherAction(
                    row.getString("id"),
                    action,
                    outcome,
                    certificate,
                    verify,
                    evidence,
                    reason,
                    action != "recover",
                )
            )
        } catch (e: Exception) {
            m.message = e.message ?: "请刷新原事项"
        }
    }
    Foldout("${row.getString("campaignName")} · ${voucherStatus(row.getString("status"))}") {
        Text(
            "${row.getString("voucherCodeMasked")} · ${row.getString("publicId")}",
            fontSize = 12.sp,
        )
        Text(
            "原营业日 ${row.getString("businessDate")} · 面额 ${historyMoney(row.getLong("faceValueMinor"))} · 结算额 ${historyMoney(row.getLong("settlementAmountMinor"))}",
            fontSize = 12.sp,
        )
        row.textOrNull("orderId")?.let { Text("关联原订单 $it，不自动抵减其应收。", fontSize = 12.sp) }
        if (row.getString("status") !in listOf("recorded", "not_consumed"))
            Primary("恢复原记录 · 不再次消耗券", enabled = m.canUseVouchers) { act("recover") }
        val review = row.optJSONObject("review")
        if (review != null) {
            Text(
                "人工平台核对：${if(review.getString("outcome")=="consumed") "已核销" else "已证实未核销"}\n证书 ${review.getString("certificateId")}\n核销号 ${review.getString("verifyId")}\n依据 ${review.getString("evidenceReference")}\n${review.getString("reason")}",
                fontSize = 12.sp,
            )
            if (
                review.textOrNull("approvedBy") == null &&
                    review.getString("employeeId") != m.identity?.employeeId &&
                    m.identity?.allows("reconciliation.manage") == true
            ) {
                OutlinedTextField(reason, { reason = it }, label = { Text("驳回原因，至少4字") })
                Primary("证据不符，驳回重新核对", enabled = m.canUseVouchers) { act("reject") }
                Primary("另一人已独立核对 · 确认结果", enabled = m.canUseVouchers) { act("approve") }
            } else if (review.textOrNull("approvedBy") == null)
                Text("等待另一名财务复核人员独立核对，不可自己审批。", fontSize = 12.sp)
        } else if (row.getString("status") in listOf("unknown", "dispatching")) {
            Text("仅在平台查询原核销凭证后填写。至少两分钟后可提交，不能用再次消费券来测试结果。", fontSize = 12.sp)
            FilterChip(
                selected = outcome == "consumed",
                onClick = { outcome = "consumed" },
                label = { Text("平台已核销") },
            )
            FilterChip(
                selected = outcome == "not_consumed",
                onClick = { outcome = "not_consumed" },
                label = { Text("已证实未核销") },
            )
            OutlinedTextField(certificate, { certificate = it }, label = { Text("平台券证书编号") })
            OutlinedTextField(verify, { verify = it }, label = { Text("平台核销凭证号") })
            OutlinedTextField(evidence, { evidence = it }, label = { Text("平台查询依据／工单号") })
            OutlinedTextField(reason, { reason = it }, label = { Text("实际核对过程与原因") })
            Primary("提交实际核对证据，等待另一人复核", enabled = m.canUseVouchers) { act("review") }
        }
    }
}
