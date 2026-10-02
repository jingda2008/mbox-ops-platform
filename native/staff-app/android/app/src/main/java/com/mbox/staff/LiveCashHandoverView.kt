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

fun cashHandoverStatus(s: String) =
    mapOf("open" to "待盘点", "count_submitted" to "待另一人交接", "closed" to "已双人交接")[s] ?: s

@Composable
fun LiveCashHandoverView(m: AppModel, close: () -> Unit) {
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var direction by remember { mutableStateOf("in") }
    val quantities = remember { mutableStateMapOf<String, String>() }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    fun propose(action: String) {
        try {
            val denominations =
                quantities.filterValues { it.isNotBlank() }.mapValues { it.value.toInt() }
            val parsed = amount.takeIf { it.isNotBlank() }?.let(::parseMoney)
            require(action !in listOf("open", "movement", "approve") || parsed != null) {
                "请输入实际金额，最多两位小数"
            }
            proposed =
                m.prepareCashHandover(
                    action,
                    parsed?.toLong(),
                    direction,
                    reference,
                    reason,
                    denominations,
                )
        } catch (e: Exception) {
            m.message = e.message ?: "请核对实际盘点"
        }
    }
    LaunchedEffect(Unit) { m.loadCashHandover() }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
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
                    Text("现金盘点与交接", style = MaterialTheme.typography.titleLarge)
                    LivePendingView(m)
                    Text(m.cashHandoverState, fontSize = 12.sp)
                    Primary("刷新门店现金交接", enabled = !m.busy) { m.loadCashHandover() }
                    Text("覆盖门店所有收银点的现金合计。盘点交接时暂停现金收退，现金取存不计作营业收入。", fontSize = 12.sp)
                }
                m.cashHandover?.let { board ->
                    val rows = board.getJSONArray("handovers").objects()
                    val row = rows.firstOrNull { it.getString("status") != "closed" }
                    item {
                        OutlinedTextField(
                            reason,
                            { reason = it },
                            label = { Text("实际说明／差异原因，至少4字") },
                        )
                        if (row == null) {
                            OutlinedTextField(
                                amount,
                                { amount = it },
                                label = { Text("门店实际期初现金（元）") },
                                keyboardOptions =
                                    KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            )
                            Primary("核对期初现金，开始本次交接", enabled = m.canUseCashHandover) {
                                propose("open")
                            }
                        } else {
                            Text(
                                "${row.getString("businessDate")} · ${cashHandoverStatus(row.getString("status"))}"
                            )
                            Text(
                                "期初 ${historyMoney(row.getLong("openingMinor"))} · 取存净额 ${historyMoney(row.getLong("movementMinor"))}\n当前账面 ${historyMoney(row.getLong("expectedMinor"))}"
                            )
                            if (
                                !row.isNull("openingDifferenceMinor") &&
                                    row.getLong("openingDifferenceMinor") != 0L
                            )
                                Text(
                                    "期初衔接差异 ${historyMoney(row.getLong("openingDifferenceMinor"))}，请核对前次交接与期间现金流水。"
                                )
                            if (row.getString("status") == "open") {
                                Foldout("按面额实点现金") {
                                    cashDenominations.forEach { d ->
                                        OutlinedTextField(
                                            quantities[d.toString()] ?: "",
                                            { quantities[d.toString()] = it },
                                            label = { Text("${historyMoney(d)} · 张／枚数") },
                                            keyboardOptions =
                                                KeyboardOptions(keyboardType = KeyboardType.Number),
                                        )
                                    }
                                    Text("未填写的面额按0计；请先确认所有收银点均已汇总。", fontSize = 12.sp)
                                    Primary("提交实点，等待另一人交接", enabled = m.canUseCashHandover) {
                                        propose("count")
                                    }
                                }
                                if (board.getBoolean("canManage"))
                                    Foldout("登记实际非营业存入／取出") {
                                        FilterChip(
                                            selected = direction == "in",
                                            onClick = { direction = "in" },
                                            label = { Text("存入备用金") },
                                        )
                                        FilterChip(
                                            selected = direction == "out",
                                            onClick = { direction = "out" },
                                            label = { Text("取出交存") },
                                        )
                                        OutlinedTextField(
                                            amount,
                                            { amount = it },
                                            label = { Text("实际取存金额（元）") },
                                            keyboardOptions =
                                                KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                        )
                                        OutlinedTextField(
                                            reference,
                                            { reference = it },
                                            label = { Text("独立凭证／交存单号") },
                                        )
                                        Primary("确认实际取存已完成", enabled = m.canUseCashHandover) {
                                            propose("movement")
                                        }
                                    }
                            }
                            row.optJSONObject("count")?.let { count ->
                                Text(
                                    "原实点 ${historyMoney(count.getLong("countedMinor"))} · 差异 ${historyMoney(count.getLong("differenceMinor"))}\n${count.getString("reason")}"
                                )
                                if (count.getString("employeeId") == m.identity?.employeeId)
                                    Primary("撤回原盘点并重新实点", enabled = m.canUseCashHandover) {
                                        propose("withdraw")
                                    }
                                else if (board.getBoolean("canManage")) {
                                    OutlinedTextField(
                                        amount,
                                        { amount = it },
                                        label = { Text("另一人独立实点金额（元）") },
                                        keyboardOptions =
                                            KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    )
                                    Primary("独立核对完成，确认交接", enabled = m.canUseCashHandover) {
                                        propose("approve")
                                    }
                                } else Text("等待另一名财务人员实点确认。", fontSize = 12.sp)
                            }
                        }
                    }
                    items(
                        rows.filter { it.getString("status") == "closed" },
                        key = { it.getString("id") },
                    ) { r ->
                        val c = r.getJSONObject("count")
                        Foldout(
                            "${r.getString("businessDate")} · 已交接 · ${historyMoney(c.getLong("countedMinor"))}"
                        ) {
                            Text("原记录 ${r.getString("id")}", fontSize = 12.sp)
                            Text(
                                "账面 ${historyMoney(c.getLong("expectedMinor"))} · 差异 ${historyMoney(c.getLong("differenceMinor"))}"
                            )
                            Text(
                                "${c.getString("reason")}\n盘点人 ${c.getString("employeeId")}\n接收人 ${r.optString("closedBy")}\n${r.optString("closedAt")}",
                                fontSize = 12.sp,
                            )
                        }
                    }
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
                    c.steps[0].cashHandoverProof!!.getString("confirmation"),
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(c)
                    },
                    enabled = m.canExecuteLive(c),
                ) {
                    Text("确认以上实际记录")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } },
        )
    }
}
