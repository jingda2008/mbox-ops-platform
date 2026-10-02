package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun LiveOrderCheckout(
    m: AppModel,
    session: String,
    tableCode: String,
    replacement: LiveReplacement? = null,
) {
    var gift by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var settlement by remember { mutableStateOf("table_tab") }
    var proposedIDs by remember { mutableStateOf<List<String>?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LivePendingView(m)
        if (m.message.isNotEmpty()) Text(m.message, fontSize = 12.sp)
        if (replacement == null && m.identity?.allows("order.gift") == true)
            Row {
                Text("整单赠送", Modifier.weight(1f))
                Switch(gift, { gift = it })
            }
        if (gift) OutlinedTextField(reason, { reason = it }, label = { Text("赠送原因（2—200字）") })
        else {
            Row {
                FilterChip(
                    settlement == "table_tab",
                    { settlement = "table_tab" },
                    label = { Text("挂本桌账单") },
                )
                Spacer(Modifier.width(8.dp))
                FilterChip(
                    settlement == "immediate_payment",
                    { settlement = "immediate_payment" },
                    label = { Text("先付款后出品") },
                )
            }
            Text(
                if (settlement == "table_tab") "订单计入本桌，按门店规则进入出品。" else "订单创建后需在原订单收款；未支付不会进入出品。",
                fontSize = 12.sp,
            )
        }
        OutlinedTextField(
            note,
            { note = it },
            label = { Text("整单出品备注（最多500字）") },
            modifier = Modifier.fillMaxWidth(),
        )
        Text("最终商品状态、价格和赠送额度由门店系统再次核对。", fontSize = 12.sp)
        Primary(
            if (replacement != null) "确认换品，建立新单" else if (gift) "确认赠送下单" else "提交订单",
            !m.busy &&
                m.livePending == null &&
                m.liveOrderPending == null &&
                !m.liveStorageDamaged &&
                !m.draftStorageDamaged &&
                m.liveDraft(session, replacement).isNotEmpty() &&
                note.length <= 500 &&
                (!gift || reason.trim().length in 2..200),
        ) {
            proposedIDs = m.liveDraft(session, replacement).map { it.id }
        }
    }
    proposedIDs?.let { ids ->
        AlertDialog(
            onDismissRequest = { proposedIDs = null },
            title = { Text("确认提交 $tableCode 的订单？") },
            text = {
                Text((replacement?.explanation ?: "") + "本次共 ${ids.size} 份，将提交到门店。结果未确认前请勿重复操作。")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposedIDs = null
                        m.submitLiveOrder(
                            session,
                            tableCode,
                            ids,
                            gift,
                            reason,
                            note,
                            settlement,
                            replacement,
                        )
                    }
                ) {
                    Text(if (gift) "确认赠送" else "确认下单")
                }
            },
            dismissButton = { TextButton(onClick = { proposedIDs = null }) { Text("取消") } },
        )
    }
}
