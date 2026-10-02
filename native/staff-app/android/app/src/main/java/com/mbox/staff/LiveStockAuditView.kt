package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
fun LiveStockAuditView(m: AppModel, close: () -> Unit) {
    var page by remember { mutableStateOf("count") }
    var filter by remember { mutableStateOf("submitted") }
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    var observed by remember { mutableStateOf("") }
    var quantity by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var wasteType by remember { mutableStateOf("other") }
    val reviewReasons = remember { mutableStateMapOf<String, String>() }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    val version = remember { m.workspaceVersion }
    val originalAccess = remember { m.priorityAccessKey }
    LaunchedEffect(m.priorityAccessKey) { if(m.priorityAccessKey != originalAccess)close() }
    fun propose(kind: String, count: JSONObject? = null, waste: JSONObject? = null) {
        try {
            proposed =
                stockAuditCommand(
                    m.identity!!,
                    m.stockBoard!!,
                    kind,
                    m.stockCountDraft,
                    selected?.getString("id"),
                    quantity,
                    (count?.getString("id") ?: waste?.getString("id"))?.let {
                        reviewReasons[it] ?: ""
                    } ?: reason,
                    wasteType,
                    count,
                    waste,
                )
        } catch (e: Exception) {
            error = e.message ?: "请刷新库存"
        }
    }
    LaunchedEffect(Unit) { m.loadStockAudit() }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row {
                        Text("盘点与报损", Modifier.weight(1f), fontSize = 22.sp)
                        TextButton(
                            onClick = {
                                selected = null
                                quantity = ""
                                m.loadStockAudit(
                                    filter,
                                    m.stockCounts?.page ?: 0,
                                    m.stockWaste?.page ?: 1,
                                )
                            },
                            enabled = !m.busy,
                        ) {
                            Text("刷新")
                        }
                        TextButton(onClick = close) { Text("关闭") }
                    }
                    LivePendingView(m)
                    Text(m.stockAuditState, fontSize = 12.sp)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    m.stockReceipt
                        ?.optString("text")
                        ?.takeIf { it.isNotBlank() }
                        ?.let { saved ->
                            val status = JSONObject(saved).getJSONObject("data").optString("status")
                            Text(
                                "最近库存回执：" +
                                    (mapOf(
                                        "submitted" to "盘点已提交待审",
                                        "approved" to "已批准",
                                        "rejected" to "已驳回",
                                        "pending" to "报损待审核",
                                        "recorded" to "报损已记账",
                                        "draft" to "采购待验收",
                                        "received" to "采购已入库",
                                    )[status] ?: "请核对原单"),
                                fontSize = 12.sp,
                            )
                        }
                    Row {
                        listOf("count" to "盘点", "waste" to "报损").forEach { (key, label) ->
                            FilterChip(
                                selected = page == key,
                                onClick = {
                                    page = key
                                    selected = null
                                    quantity = ""
                                    reason = ""
                                },
                                label = { Text(label) },
                            )
                        }
                    }
                }
                m.stockBoard?.let { board ->
                    if (
                        m.identity?.allows(
                            if (page == "count") "inventory.count" else "inventory.waste"
                        ) == true
                    ) {
                        item {
                            Panel {
                                Text(if (page == "count") "录入实物盘点" else "登记报损", fontSize = 18.sp)
                                selected?.let { item ->
                                    Text(
                                        item.getString("name") +
                                            " · 当前账面 " +
                                            item.getString("onHandQuantity") +
                                            item.getString("baseUnit")
                                    )
                                    OutlinedTextField(
                                        quantity,
                                        { quantity = it },
                                        label = {
                                            Text(if (page == "count") "实点数量，可为0" else "报损数量")
                                        },
                                        keyboardOptions =
                                            KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    )
                                    OutlinedTextField(
                                        reason,
                                        { reason = it },
                                        label = {
                                            Text(if (page == "count") "盘点说明或差异原因" else "报损原因")
                                        },
                                    )
                                    if (page == "waste")
                                        Column {
                                            listOf(
                                                    "mixing_failure" to "调酒失败",
                                                    "discarded" to "报废",
                                                    "expired" to "过期",
                                                    "tasting" to "试饮",
                                                    "complimentary" to "赠送",
                                                    "other" to "其他",
                                                )
                                                .chunked(3)
                                                .forEach { row ->
                                                    Row {
                                                        row.forEach { (key, label) ->
                                                            FilterChip(
                                                                selected = wasteType == key,
                                                                onClick = { wasteType = key },
                                                                label = { Text(label) },
                                                            )
                                                        }
                                                    }
                                                }
                                        }
                                    PrimaryAction(
                                        onClick = {
                                            if (page == "waste") propose("waste")
                                            else
                                                try {
                                                    val q = stockQuantity(quantity, item, true)
                                                    require(
                                                        reason.isNotBlank() &&
                                                            reason.length <= 500 &&
                                                            observed.isNotBlank() &&
                                                            m.stockCountDraft.none {
                                                                it.getString("inventoryItemId") ==
                                                                    item.getString("id")
                                                            }
                                                    ) {
                                                        "请填写原因；已有物料请移除后重新清点"
                                                    }
                                                    val line =
                                                        JSONObject()
                                                            .put(
                                                                "inventoryItemId",
                                                                item.getString("id"),
                                                            )
                                                            .put("name", item.getString("name"))
                                                            .put(
                                                                "baseUnit",
                                                                item.getString("baseUnit"),
                                                            )
                                                            .put("countedQuantity", q)
                                                            .put("reason", reason)
                                                            .put(
                                                                "expectedOnHandQuantity",
                                                                item.getString("onHandQuantity"),
                                                            )
                                                            .put("observedAt", observed)
                                                    m.saveCountDraft(m.stockCountDraft + line)
                                                    selected = null
                                                    quantity = ""
                                                    reason = ""
                                                } catch (e: Exception) {
                                                    error = e.message ?: "请核对"
                                                }
                                        },
                                        enabled = m.canUseStockAudit,
                                    ) {
                                        Text(if (page == "count") "加入本员工盘点草稿" else "核对报损")
                                    }
                                    TextButton(onClick = { selected = null }) { Text("重新选择物料") }
                                }
                                    ?: run {
                                        OutlinedTextField(
                                            query,
                                            { query = it },
                                            label = { Text("搜索物料名称或编码") },
                                        )
                                        Text("选择物料后录入实际数量；刷新不会替换草稿的原库存基准。", fontSize = 12.sp)
                                    }
                            }
                        }
                        if (selected == null && query.isNotBlank())
                            items(
                                board.items.filter {
                                    (it.getString("name") + " " + it.getString("sku")).contains(
                                        query,
                                        true,
                                    )
                                },
                                key = { "item-" + it.getString("id") },
                            ) { item ->
                                TextButton(
                                    onClick = {
                                        selected = item
                                        observed = board.source.optString("inventoryObservedAt")
                                        quantity = ""
                                        reason = ""
                                    },
                                    enabled = m.canUseStockAudit,
                                ) {
                                    Text(item.getString("name") + " · " + item.getString("sku"))
                                }
                            }
                    }
                    if (page == "count") {
                        if (m.stockCountDraft.isNotEmpty())
                            item {
                                Panel {
                                    Text("本员工盘点草稿 · ${m.stockCountDraft.size}项", fontSize = 18.sp)
                                    m.stockCountDraft.forEach { line ->
                                        Row {
                                            Text(
                                                line.getString("name") +
                                                    " 实点 " +
                                                    line.getString("countedQuantity") +
                                                    line.getString("baseUnit"),
                                                Modifier.weight(1f),
                                            )
                                            TextButton(
                                                onClick = {
                                                    try {
                                                        m.saveCountDraft(
                                                            m.stockCountDraft.filter {
                                                                it.getString("inventoryItemId") !=
                                                                    line.getString(
                                                                        "inventoryItemId"
                                                                    )
                                                            }
                                                        )
                                                    } catch (e: Exception) {
                                                        error = e.message ?: "保存失败"
                                                    }
                                                },
                                                enabled = m.canUseStock,
                                            ) {
                                                Text("移除")
                                            }
                                        }
                                    }
                                    PrimaryAction(
                                        onClick = { propose("count") },
                                        enabled = m.canUseStockAudit,
                                    ) {
                                        Text("核对并提交盘点")
                                    }
                                }
                            }
                        item {
                            Row {
                                listOf("submitted" to "待审", "processed" to "已处理").forEach {
                                    (value, label) ->
                                    FilterChip(
                                        selected = filter == value,
                                        onClick = {
                                            filter = value
                                            selected = null
                                            m.loadStockAudit(filter)
                                        },
                                        label = { Text(label) },
                                        enabled = !m.busy,
                                    )
                                }
                            }
                        }
                        m.stockCounts?.let { counts ->
                            if (counts.counts.isEmpty()) item { Text("本页没有盘点单") }
                            items(counts.counts, key = { "count-" + it.getString("id") }) { c ->
                                Panel {
                                    Text(c.getString("publicId"), fontSize = 18.sp)
                                    Text(
                                        c.getString("createdByName") +
                                            " · " +
                                            (mapOf(
                                                "submitted" to "待审",
                                                "approved" to "已批准",
                                                "rejected" to "已驳回",
                                            )[c.getString("status")] ?: "待核对")
                                    )
                                    val lines = c.getJSONArray("lines").objects()
                                    lines.forEach { l ->
                                        Text(
                                            l.getString("itemName") +
                                                " 账面 " +
                                                l.getString("systemQuantity") +
                                                " / 实点 " +
                                                l.getString("countedQuantity") +
                                                " / 差异 " +
                                                l.getString("varianceQuantity"),
                                            fontSize = 12.sp,
                                        )
                                        if (l.getBoolean("stale"))
                                            Text(
                                                "库存已有变动，请驳回后重新清点",
                                                color = MaterialTheme.colorScheme.error,
                                            )
                                    }
                                    if (c.getBoolean("canReview")) {
                                        val id = c.getString("id")
                                        OutlinedTextField(
                                            reviewReasons[id] ?: "",
                                            { reviewReasons[id] = it },
                                            label = { Text("驳回原因") },
                                        )
                                        Row {
                                            TextButton(
                                                onClick = { propose("countApprove", count = c) },
                                                enabled =
                                                    m.canUseStockAudit &&
                                                        lines.none { it.getBoolean("stale") },
                                            ) {
                                                Text("批准差异")
                                            }
                                            TextButton(
                                                onClick = { propose("countReject", count = c) },
                                                enabled = m.canUseStockAudit,
                                            ) {
                                                Text("驳回")
                                            }
                                        }
                                    }
                                }
                            }
                            item {
                                Row {
                                    TextButton(
                                        onClick = { m.loadStockAudit(filter, counts.page - 1) },
                                        enabled = !m.busy && counts.page > 0,
                                    ) {
                                        Text("上一页")
                                    }
                                    TextButton(
                                        onClick = { m.loadStockAudit(filter, counts.page + 1) },
                                        enabled = !m.busy && counts.more,
                                    ) {
                                        Text("下一页")
                                    }
                                }
                            }
                        }
                    } else
                        m.stockWaste?.let { waste ->
                            if (waste.items.isEmpty()) item { Text("本页没有报损申请；直接记账以原回执为准") }
                            items(waste.items, key = { "waste-" + it.getString("id") }) { r ->
                                Panel {
                                    Text(
                                        r.getString("itemName") +
                                            " ×" +
                                            r.getString("quantity") +
                                            r.getString("baseUnit"),
                                        fontSize = 18.sp,
                                    )
                                    Text(
                                        r.getString("requestedByName") +
                                            " · " +
                                            (mapOf(
                                                "pending" to "待审",
                                                "approved" to "已批准",
                                                "rejected" to "已驳回",
                                            )[r.getString("status")] ?: "待核对")
                                    )
                                    Text(r.getString("reason"))
                                    if (r.getBoolean("canReview")) {
                                        val id = r.getString("id")
                                        OutlinedTextField(
                                            reviewReasons[id] ?: "",
                                            { reviewReasons[id] = it },
                                            label = { Text("审核原因") },
                                        )
                                        Row {
                                            TextButton(
                                                onClick = { propose("wasteApprove", waste = r) },
                                                enabled = m.canUseStockAudit,
                                            ) {
                                                Text("批准报损")
                                            }
                                            TextButton(
                                                onClick = { propose("wasteReject", waste = r) },
                                                enabled = m.canUseStockAudit,
                                            ) {
                                                Text("驳回")
                                            }
                                        }
                                    }
                                }
                            }
                            item {
                                Row {
                                    TextButton(
                                        onClick = { m.loadStockAudit(wastePage = waste.page - 1) },
                                        enabled = !m.busy && waste.page > 1,
                                    ) {
                                        Text("上一页")
                                    }
                                    TextButton(
                                        onClick = { m.loadStockAudit(wastePage = waste.page + 1) },
                                        enabled = !m.busy && waste.more,
                                    ) {
                                        Text("下一页")
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
            text = { Text(command.steps[0].stockAuditProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                        selected = null
                        quantity = ""
                        reason = ""
                    },
                    enabled = m.canExecuteLive(command),
                ) {
                    Text("确认执行")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回核对") } },
        )
    }
}
