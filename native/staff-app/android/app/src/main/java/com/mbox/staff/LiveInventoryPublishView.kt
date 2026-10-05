package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun LiveInventoryPublishView(m: AppModel, receiptId: String, close: () -> Unit) {
    val access = remember { m.priorityAccessKey }; val workspace = remember { m.workspaceVersion }
    var productId by remember { mutableStateOf("") }; var confirmed by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }; var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    LaunchedEffect(receiptId) { m.loadInventoryPublish(receiptId) }
    LaunchedEffect(m.priorityAccessKey, m.workspaceVersion) { if (access != m.priorityAccessKey || workspace != m.workspaceVersion) close() }
    LaunchedEffect(productId, m.inventoryPublishPreview?.version) { confirmed = false }
    if (access != m.priorityAccessKey || workspace != m.workspaceVersion) return
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row { Text("整单收货并发布", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge); TextButton(onClick = close) { Text("关闭") } }
                    LivePendingView(m); Text(m.inventoryPublishState)
                    TextButton(onClick = { confirmed = false; m.loadInventoryPublish(receiptId) }, enabled = !m.busy) { Text("重新读取采购单") }
                    if (notice.isNotEmpty()) Text(notice, color = MaterialTheme.colorScheme.error)
                }
                m.inventoryPublishBoard?.takeIf { it.receipt.getString("id") == receiptId }?.let { board ->
                    item {
                        Panel {
                            Text("采购单 ${board.receipt.getString("publicId")}", style = MaterialTheme.typography.titleMedium)
                            Text(if (board.receipt.getString("status") == "received") "原单已收货；此次不会重复增加库存。" else "此操作会将整张采购单的全部物料入库，并发布下方选择的商品。")
                            board.receipt.getJSONArray("lines").objects().forEach { line ->
                                Text("${line.getString("itemName")} · ${line.getString("quantity")} ${line.getString("baseUnit")}" + (line.textOrNull("batchCode")?.let { " · 批次 $it" } ?: ""))
                            }
                            if (board.products.isEmpty()) Text("本单尚无关联库存配方的商品。请先在商品管理中完成商品和配方，再重新读取。")
                            AssignmentChoice("本次发布商品", productId, listOf("" to "请选择关联商品") + board.products.map { it.getString("id") to it.getString("name") }) { productId = it }
                            PrimaryAction(onClick = { confirmed = false; m.loadInventoryPublishPreview(receiptId, productId) }, enabled = m.canUseInventoryPublish && board.products.any { it.getString("id") == productId }) { Text("读取收货成本与上架预览") }
                        }
                    }
                    m.inventoryPublishPreview?.takeIf { it.receiptId == receiptId && it.productId == productId }?.let { preview ->
                        item {
                            val quote = preview.source
                            Panel {
                                Text(quote.getString("productName"), style = MaterialTheme.typography.titleMedium)
                                Text("售价 ${money(quote.getInt("standardPriceMinor"))} · 每份成本 ${money(quote.getInt("costAmountMinor"))}")
                                Text("每份毛利 ${money(quote.getInt("grossProfitMinor"))} · 毛利率 ${quote.getInt("marginBasisPoints") / 100.0}%")
                                Text("收货后可售 ${quote.getInt("sellableServings")} 份 · 配方版本 ${quote.getInt("recipeVersion")}")
                                quote.getJSONArray("components").objects().forEach { component ->
                                    fun decimal(key: String) = component.getString(key).toBigDecimal().stripTrailingZeros().toPlainString()
                                    Text("${component.getString("itemName")}：可用 ${decimal("totalAvailableAfterReceipt")} ${component.getString("baseUnit")} · 每份扣减 ${decimal("perServingDeduction")}")
                                }
                                Text(if (preview.ready) "顾客扫码与员工点单渠道已具备发布条件。" else "暂不能发布：请核对顾客菜单可见、扫码与员工点单渠道，并确保至少可制作1份。", color = if (preview.ready) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error)
                                Row { Checkbox(confirmed, { confirmed = it }, enabled = m.canUseInventoryPublish && preview.ready); Text("已逐项核实整张采购单的物料、数量、批次与实物验收；同意整单入库。", Modifier.weight(1f)) }
                                PrimaryAction(onClick = {
                                    try { proposed = inventoryPublishCommand(requireNotNull(m.identity), board, preview, confirmed); notice = "" }
                                    catch (e: Exception) { notice = e.message ?: "请重新核对整单收货" }
                                }, enabled = confirmed && m.canUseInventoryPublish && preview.ready) { Text("核对整单收货并发布") }
                            }
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command -> AlertDialog(onDismissRequest = { proposed = null }, title = { Text(command.title) },
        text = { Text(command.steps.single().inventoryPublishProof!!.getString("confirmation"), Modifier.verticalScroll(rememberScrollState())) },
        confirmButton = { TextButton(onClick = { proposed = null; confirmed = false; m.executeLive(command) }, enabled = m.canExecuteLive(command)) { Text("确认整单收货并发布") } },
        dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回核对") } }) }
}
