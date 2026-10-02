package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.util.Locale

@Composable
fun LiveCatalogView(
    m: AppModel,
    session: String,
    tableCode: String,
    replacement: LiveReplacement? = null,
    close: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<LiveProduct?>(null) }
    var showingDraft by remember { mutableStateOf(false) }
    var receipt by remember { mutableStateOf<LiveOrderReceipt?>(null) }
    var showCollection by remember { mutableStateOf(false) }
    val previousReceipt = remember { m.lastOrderReceipt?.publicId }
    LaunchedEffect(m.lastOrderReceipt?.publicId) {
        if (m.lastOrderReceipt?.publicId != previousReceipt) receipt = m.lastOrderReceipt
    }
    val lines = m.liveDraft(session, replacement)
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    LaunchedEffect(session, replacement) { m.loadLiveCatalog(replacement) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(
                Modifier.safeDrawingPadding().imePadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row {
                    Text(
                        tableCode + if (replacement == null) " · 菜单" else " · 换品菜单",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    TextButton(onClick = { m.loadLiveCatalog(replacement) }, enabled = !m.busy) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("返回桌台") }
                }
                replacement?.let { Text(it.explanation, fontSize = 12.sp) }
                if (m.catalogState.isNotBlank()) Text(m.catalogState)
                if (m.draftStorageDamaged)
                    Text("草稿存储异常，暂时不能加菜，请联系管理员", color = MaterialTheme.colorScheme.error)
                if (!showingDraft) {
                    MenuFilters(
                        query,
                        { query = it },
                        category,
                        { category = it },
                        m.liveProducts
                            .distinctBy { it.categoryCode }
                            .map { it.categoryCode to it.categoryName },
                    )
                }
                LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    receipt?.let { confirmed ->
                        item {
                            Panel {
                                Text(if (confirmed.recovered) "原订单已找回" else "订单已建立", color = Ink)
                                Text(confirmed.publicId, fontSize = 12.sp)
                                Text(
                                    confirmed.amount?.let { "新单金额 " + historyMoney(it) }
                                        ?: "原单已找回，金额和状态请在账单核对"
                                )
                                if (replacement != null)
                                    Text("原商品退款与实物处理仍按原申请继续。", fontSize = 12.sp)
                                if (
                                    LivePaymentOrder.permissions.any {
                                        m.identity?.allows(it) == true
                                    }
                                ) {
                                    Primary("查看本桌待收账单", enabled = !m.busy) { showCollection = true }
                                }
                                if (replacement != null)
                                    SecondaryAction(onClick = close) { Text("返回原商品核对售后") }
                            }
                        }
                    }
                    if (showingDraft) {
                        if (lines.isEmpty()) item { Text("还没有选择商品") }
                        items(lines, key = { it.id }) { line ->
                            Panel {
                                Text(
                                    line.product.name + " · " + money(line.product.price),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                if (line.selectionLabel.isNotBlank()) Text(line.selectionLabel)
                                if (line.note.isNotBlank())
                                    Text("备注：${line.note}", fontSize = 13.sp)
                                SecondaryAction(
                                    onClick = { m.removeLiveLine(line.id, session, replacement) },
                                    enabled = !m.busy,
                                    icon = Icons.Outlined.RemoveCircleOutline,
                                ) {
                                    Text("移除这一份")
                                }
                            }
                        }
                        item {
                            if (lines.isNotEmpty())
                                LiveOrderCheckout(m, session, tableCode, replacement)
                            else LivePendingView(m)
                        }
                    } else {
                        val products =
                            m.liveProducts.filter {
                                it.matches(query) &&
                                    (category.isEmpty() || it.categoryCode == category)
                            }
                        if (products.isEmpty() && m.catalogUpdated != null) item { Text("没有匹配的商品") }
                        items(products, key = { it.id }) { product ->
                            Panel {
                                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    MenuThumbnail(product.imageURL)
                                    Text(
                                        product.name,
                                        Modifier.weight(1f),
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Text(money(product.price), color = Ink)
                                }
                                Text(product.categoryName, fontSize = 12.sp)
                                if (product.specification.isNotBlank())
                                    Text(product.specification, fontSize = 12.sp)
                                val quantity = lines.count { it.product.id == product.id }
                                if (quantity > 0)
                                    Text("已选 $quantity 份", fontSize = 12.sp, color = Ink)
                                product.unavailable?.let { Text(it, fontSize = 12.sp) }
                                SecondaryAction(
                                    onClick = { selected = product },
                                    enabled =
                                        product.unavailable == null &&
                                            !m.busy &&
                                            !m.draftStorageDamaged,
                                    icon = Icons.Outlined.Add,
                                ) {
                                    Text(if (product.groups.isEmpty()) "选规格 / 加入" else "选择套餐内容")
                                }
                            }
                        }
                    }
                }
                val total = lines.sumOf { (it.product.price ?: 0).toLong() }
                Primary(
                    (if (showingDraft) "返回菜单继续加菜" else "查看已选 ${lines.size} 份") +
                        " · 预估 ¥" +
                        String.format(Locale.CHINA, "%.2f", total / 100.0),
                    true,
                ) {
                    showingDraft = !showingDraft
                }
            }
        }
    }
    if (showCollection) LiveCollectionView(m, session, tableCode) { showCollection = false }
    selected?.let { product ->
        LiveProductPicker(m, product, session, replacement) { selected = null }
    }
}

@Composable
private fun LiveProductPicker(
    m: AppModel,
    product: LiveProduct,
    session: String,
    replacement: LiveReplacement? = null,
    close: () -> Unit,
) {
    var choices by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var note by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    val complete =
        product.groups.all { choices[it.id].orEmpty().size == it.count } && note.length <= 300
    AlertDialog(
        onDismissRequest = close,
        title = { Text(product.name) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MenuThumbnail(product.imageURL)
                Text(money(product.price), style = MaterialTheme.typography.titleMedium)
                if (product.description.isNotBlank()) Text(product.description)
                if (product.specification.isNotBlank()) Text(product.specification)
                product.components.forEach { Text("${it.name} ×${it.quantity}") }
                product.groups.forEach { group ->
                    Text(
                        "${group.name} · 选${group.count}款",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    group.options.forEach { option ->
                        val checked = choices[group.id]?.contains(option.id) == true
                        Row {
                            Checkbox(
                                checked,
                                onCheckedChange = { on ->
                                    choices =
                                        choices +
                                            (group.id to
                                                (if (on) choices[group.id].orEmpty() + option.id
                                                else choices[group.id].orEmpty() - option.id))
                                },
                                enabled =
                                    option.available &&
                                        (checked || choices[group.id].orEmpty().size < group.count),
                            )
                            Column(Modifier.weight(1f).padding(top = 10.dp)) {
                                Text("${option.name} ×${option.quantity}")
                                if (!option.available)
                                    Text(option.reason ?: "当前不可选", fontSize = 12.sp)
                            }
                        }
                    }
                }
                OutlinedTextField(note, { note = it }, label = { Text("商品备注（同商品共用，最多300字）") })
                if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    try {
                        m.addLiveProduct(product, choices, note, session, replacement)
                        close()
                    } catch (e: Exception) {
                        error = e.message ?: "无法加入清单"
                    }
                },
                enabled = complete && !m.busy,
            ) {
                Text("加入一份 · " + money(product.price))
            }
        },
        dismissButton = { TextButton(onClick = close) { Text("取消") } },
    )
}
