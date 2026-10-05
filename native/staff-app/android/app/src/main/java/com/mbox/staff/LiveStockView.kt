package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun LiveStockView(m: AppModel, close: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var quantity by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var supplier by remember { mutableStateOf(m.stockSupplierName) }
    var batch by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var receiptSearch by remember { mutableStateOf("") };var receiptFrom by remember { mutableStateOf("") };var receiptTo by remember { mutableStateOf("") };var receiptStatus by remember { mutableStateOf("") }
    var costItem by remember { mutableStateOf<JSONObject?>(null) };var costValue by remember { mutableStateOf("") };var costReason by remember { mutableStateOf("") }
    fun receiptQuery(page:Int):String {if(receiptFrom.isNotBlank())java.time.LocalDate.parse(receiptFrom);if(receiptTo.isNotBlank())java.time.LocalDate.parse(receiptTo);require(receiptFrom.isBlank()||receiptTo.isBlank()||receiptFrom<=receiptTo);return custodyQuery(mapOf("receiptsPage" to page.toString(),"receiptStatus" to receiptStatus,"receiptSearch" to receiptSearch,"receiptFrom" to receiptFrom,"receiptTo" to receiptTo))}
    var appliedReceiptQuery by remember { mutableStateOf("") }
    fun pageQuery(page:Int)=appliedReceiptQuery.replace(Regex("receiptsPage=[0-9]+"),"receiptsPage=$page").ifBlank{receiptQuery(page)}
    var receipts by remember { mutableStateOf(false) }
    var lowOnly by remember { mutableStateOf(false) }
    var looking by remember { mutableStateOf(false) }
    var selectedID by remember { mutableStateOf<String?>(null) }
    var scan by remember { mutableStateOf<JSONObject?>(null) }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var setupVisible by remember { mutableStateOf(false) }
    var publishReceiptId by remember { mutableStateOf<String?>(null) }
    val listState=rememberLazyListState()
    LaunchedEffect(selectedID){if(selectedID!=null)listState.animateScrollToItem(0)}
    val scope = rememberCoroutineScope()
    val version = remember { m.workspaceVersion }
    val originalAccess = remember { m.priorityAccessKey }
    LaunchedEffect(m.stockSupplierName) { supplier = m.stockSupplierName }
    LaunchedEffect(m.priorityAccessKey) { if(m.priorityAccessKey != originalAccess)close() }
    var scanActor by remember { mutableStateOf<String?>(null) }
    fun lookup(value: String) {
        looking = true
        scope.launch {
            try {
                val result = m.lookupStockCode(value)
                scan = result
                selectedID = result.getString("inventoryItemId")
                quantity = "1"
                amount = ""
                batch = ""
                error = ""
            } catch (e: Exception) {
                error = e.message ?: "识别失败"
                scan = null
                selectedID = null
            } finally {
                looking = false
            }
        }
    }
    val scanLauncher =
        rememberLauncherForActivityResult(ScanContract()) { result ->
            if (
                result.contents != null &&
                    scanActor == m.identity?.employeeId &&
                    m.workspaceVersion == version
            ) {
                code = result.contents
                lookup(code)
            }
        }
    LaunchedEffect(Unit) { m.loadStock() }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(m.stockReceipt?.optString("commandID")) {
        if (m.stockReceipt != null) receipts = true
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("库存与收货", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = { m.loadStock() }, enabled = !m.busy && !looking) {
                        Text("刷新")
                    }
                    TextButton(onClick = close) { Text("关闭") }
                }
                LivePendingView(m)
                Text(m.stockState, fontSize = 12.sp)
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                if (m.identity?.allows("inventory.manage") == true)
                    TextButton(onClick = { setupVisible = true }, enabled = m.canUseStock && !looking) {
                        Text("新增物料、编辑资料与包装条码")
                    }
                Row {
                    FilterChip(!receipts, { receipts = false }, { Text("库存与收货") })
                    Spacer(Modifier.width(8.dp))
                    FilterChip(receipts, { receipts = true }, { Text("采购验收") })
                }
                val board = m.stockBoard
                if (board != null)
                    LazyColumn(state=listState,verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (!receipts) {
                            if (m.identity?.allows("inventory.receive") == true) {
                                item {
                                    Panel {
                                        OutlinedTextField(
                                            supplier,
                                            { supplier = it },
                                            label = { Text("本单供应商（选填）") },
                                            singleLine = true,
                                            isError = supplier.trim().length > 200,
                                            supportingText = { Text("加入清单或核对建单时保存，最多200字。") },
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        Row {
                                            OutlinedTextField(
                                                code,
                                                { code = it },
                                                label = { Text("物料条码") },
                                                singleLine = true,
                                                modifier = Modifier.weight(1f),
                                            )
                                            TextButton(
                                                onClick = { lookup(code.trim()) },
                                                enabled = m.canUseStock && !looking,
                                            ) {
                                                Text("识别")
                                            }
                                        }
                                        PrimaryAction(
                                            onClick = {
                                                scanActor = m.identity?.employeeId
                                                scanLauncher.launch(
                                                    ScanOptions()
                                                        .setDesiredBarcodeFormats(
                                                            ScanOptions.ALL_CODE_TYPES
                                                        )
                                                        .setPrompt("扫描物料条码，核对包装数量后建立采购单")
                                                        .setBeepEnabled(false)
                                                        .setBarcodeImageEnabled(false)
                                                        .setOrientationLocked(false)
                                                )
                                            },
                                            enabled = m.canUseStock && !looking,
                                        ) {
                                            Text("相机扫描物料条码")
                                        }
                                        val selected =
                                            board.items.firstOrNull {
                                                it.getString("id") == selectedID
                                            }
                                        if (selected != null) {
                                            Text(selected.getString("name"), fontSize = 18.sp)
                                            Text(
                                                scan?.let {
                                                    "按包录入，每包" +
                                                        it.getString("packageQuantity") +
                                                        selected.getString("baseUnit")
                                                } ?: "按实际数量录入，单位：" + selected.getString("baseUnit"),
                                                fontSize = 12.sp,
                                            )
                                            OutlinedTextField(
                                                quantity,
                                                { quantity = it },
                                                label = {
                                                    Text(if (scan == null) "实际数量" else "包装数量")
                                                },
                                                keyboardOptions =
                                                    KeyboardOptions(
                                                        keyboardType = KeyboardType.Decimal
                                                    ),
                                            )
                                            OutlinedTextField(
                                                amount,
                                                { amount = it },
                                                label = { Text("本批总金额（元）") },
                                                keyboardOptions =
                                                    KeyboardOptions(
                                                        keyboardType = KeyboardType.Decimal
                                                    ),
                                            )
                                            OutlinedTextField(
                                                batch,
                                                { batch = it },
                                                label = { Text("此物料批次号（选填）") },
                                                singleLine = true,
                                                isError = batch.trim().length > 128,
                                                supportingText = { Text("最多128字；留空由系统生成，不同批次请分行。") },
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                            PrimaryAction(
                                                onClick = {
                                                    try {
                                                        val line =
                                                            StockLine.make(
                                                                selected,
                                                                quantity,
                                                                amount,
                                                                scan,
                                                                batch,
                                                            )
                                                        require(
                                                            m.stockDraft.none { it.id == line.id }
                                                        ) {
                                                            "清单已有此物料同条码同批次，请移除旧行后合并数量"
                                                        }
                                                        m.saveStockDraft(m.stockDraft + line, supplier)
                                                        selectedID = null
                                                        scan = null
                                                        quantity = ""
                                                        amount = ""
                                                        batch = ""
                                                        error = ""
                                                    } catch (e: Exception) {
                                                        error = e.message ?: "请核对"
                                                    }
                                                },
                                                enabled = m.canUseStock && !looking,
                                            ) {
                                                Text("加入待验收清单")
                                            }
                                        }
                                    }
                                }
                                if (m.stockDraft.isNotEmpty())
                                    item {
                                        Panel {
                                            Text(
                                                "本员工采购草稿 · ${m.stockDraft.size}项",
                                                fontSize = 18.sp,
                                            )
                                            m.stockDraft.forEach { line ->
                                                Row {
                                                    Text(
                                                        line.summary,
                                                        Modifier.weight(1f),
                                                        fontSize = 12.sp,
                                                    )
                                                    TextButton(
                                                        onClick = {
                                                            try {
                                                                m.saveStockDraft(
                                                                    m.stockDraft.filter {
                                                                        it.id != line.id
                                                                    },
                                                                    supplier,
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
                                                onClick = {
                                                    try {
                                                        m.saveStockDraft(m.stockDraft, supplier)
                                                        proposed =
                                                            stockCommand(
                                                                m.identity!!,
                                                                board,
                                                                m.stockDraft,
                                                                supplierName = m.stockSupplierName,
                                                            )
                                                    } catch (e: Exception) {
                                                        error = e.message ?: "请刷新"
                                                    }
                                                },
                                                enabled = m.canUseStock,
                                            ) {
                                                Text("核对并建立待验收单")
                                            }
                                        }
                                    }
                            }
                            item {
                                OutlinedTextField(
                                    query,
                                    { query = it },
                                    label = { Text("搜索物料名称或编码") },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Row {
                                    Checkbox(lowOnly, { lowOnly = it })
                                    Text("只看低库存")
                                }
                            }
                            val rows =
                                board.items.filter {
                                    (!lowOnly || it.getBoolean("lowStock")) &&
                                        (query.isBlank() ||
                                            (it.getString("name") + " " + it.getString("sku"))
                                                .contains(query, true))
                                }
                            if (rows.isEmpty()) item { Text("没有匹配物料") }
                            items(rows, key = { it.getString("id") }) { item ->
                                Panel {
                                    Text(item.getString("name"), fontSize = 18.sp)
                                    Text(
                                        item.getString("sku") +
                                            " · 可用 " +
                                            item.getString("availableQuantity") +
                                            item.getString("baseUnit"),
                                        color =
                                            if (item.getBoolean("lowStock"))
                                                MaterialTheme.colorScheme.error
                                            else Ink,
                                    )
                                    Text(
                                        "在库 " +
                                            item.getString("onHandQuantity") +
                                            " · 已占用 " +
                                            item.getString("reservedQuantity"),
                                        fontSize = 12.sp,
                                    )
                                    if (item.getBoolean("lowStock"))
                                        Text("已到低库存阈值；请核对实物及补货安排", fontSize = 12.sp)
                                    if(board.costs) Text("单位成本："+(item.textOrNull("weightedUnitCostMinor")?.let{java.math.BigDecimal(it).movePointLeft(2).toPlainString()+" 元/"+item.getString("baseUnit")} ?: "待核实"))
                                    if(board.source.optBoolean("nativeCostCorrections")&&board.costs&&m.identity?.allows("inventory.cost.correct")==true)TextButton(onClick={costItem=item;costValue=item.textOrNull("weightedUnitCostMinor")?.let{java.math.BigDecimal(it).movePointLeft(2).toPlainString()}.orEmpty();costReason=""},enabled=m.canUseStock){Text("更正单位成本")}

                                    if (m.identity?.allows("inventory.receive") == true)
                                        TextButton(
                                            onClick = {
                                                selectedID = item.getString("id")
                                                scan = null
                                                quantity = ""
                                                amount = ""
                                                batch = ""
                                            },
                                            enabled = m.canUseStock,
                                        ) {
                                            Text("按此物料收货")
                                        }
                                }
                            }
                        } else {
                            item { Foldout("采购历史筛选") { CustodyField("单号、物料名称或编码",receiptSearch,120){receiptSearch=it};CustodyField("创建日期从 YYYY-MM-DD",receiptFrom,10){receiptFrom=it};CustodyField("创建日期至 YYYY-MM-DD",receiptTo,10){receiptTo=it};AssignmentChoice("采购状态",receiptStatus,listOf("" to "全部","draft" to "待验收","received" to "已入库","cancelled" to "已取消")){receiptStatus=it};SecondaryAction(onClick={try{val query=receiptQuery(0);appliedReceiptQuery=query;m.loadStock(query)}catch(e:Exception){error="请核对查询日期"}},enabled=!m.busy){Text("查询完整采购历史")} } }
                            board.source.optJSONObject("receiptsPage")?.let{page->item { Text("第${page.getInt("page")+1}页，每页最多100单");if(page.getInt("page")>0)SecondaryAction(onClick={try{m.loadStock(pageQuery(page.getInt("page")-1))}catch(e:Exception){error="请核对筛选"}},enabled=!m.busy){Text("上一页采购")};if(page.getBoolean("hasMore"))SecondaryAction(onClick={try{m.loadStock(pageQuery(page.getInt("page")+1))}catch(e:Exception){error="请核对筛选"}},enabled=!m.busy){Text("下一页采购")} } }
                            if (board.receipts.isEmpty()) item { Text("当前筛选没有采购单") }
                            items(board.receipts, key = { it.getString("id") }) { r ->
                                Panel {
                                    Text(r.getString("publicId"), fontSize = 18.sp)
                                    r.optJSONObject("supplier")?.textOrNull("name")?.let { Text("供应商：$it", fontSize = 12.sp) }
                                    Text(
                                        mapOf(
                                            "draft" to "待实物验收",
                                            "received" to "已入库",
                                            "cancelled" to "已取消",
                                        )[r.getString("status")] ?: "状态待核对",
                                        color = Ink,
                                    )
                                    r.getJSONArray("lines").objects().forEach { line ->
                                        Text(
                                            line.getString("itemName") +
                                                " ×" +
                                                line.getString("quantity") +
                                                line.getString("baseUnit")
                                        )
                                        line.textOrNull("batchCode")?.let { Text("批次：$it", fontSize = 12.sp) }
                                    }
                                    if (board.costs)
                                        r.textOrNull("invoiceTotalMinor")?.toLongOrNull()?.let {
                                            Text("本批总额 " + historyMoney(it))
                                        }
                                    if (
                                        r.getString("status") == "draft" &&
                                            m.identity?.allows("inventory.receive") == true
                                    )
                                        PrimaryAction(
                                            onClick = {
                                                try {
                                                    proposed =
                                                        stockCommand(
                                                            m.identity!!,
                                                            board,
                                                            receiptID = r.getString("id"),
                                                        )
                                                } catch (e: Exception) {
                                                    error = e.message ?: "请刷新"
                                                }
                                            },
                                            enabled = m.canUseStock,
                                        ) {
                                            Text("已核对实物，确认入库")
                                        }
                                    if (r.getString("status") == "draft" &&
                                        inventoryPublishPermissions.all { m.identity?.allows(it) == true })
                                        SecondaryAction(
                                            onClick = { publishReceiptId = r.getString("id") },
                                            enabled = m.canUseStock && !looking,
                                        ) { Text("验收入库并发布商品") }
                                }
                            }
                        }
                    }
            }
        }
    }
    if (setupVisible) LiveInventorySetupView(m) { setupVisible = false }
    publishReceiptId?.let { receiptId ->
        LiveInventoryPublishView(m, receiptId) { publishReceiptId = null }
    }
    costItem?.let { item->AlertDialog(onDismissRequest={costItem=null},title={Text("更正 ${item.getString("name")} 成本")},text={Column {Text("单位：每${item.getString("baseUnit")}，请按实际凭证核对。");CustodyField("新单位成本（元）",costValue,20){costValue=it};CustodyField("更正依据",costReason,500){costReason=it}}},confirmButton={TextButton(onClick={try{proposed=stockCostCommand(m.identity!!,m.stockBoard!!,item,costValue,costReason);costItem=null}catch(e:Exception){error=e.message?:"请核对成本"}},enabled=m.canUseStock){Text("下一步核对")}},dismissButton={TextButton(onClick={costItem=null}){Text("取消")}}) }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text((command.steps[0].stockProof ?: command.steps[0].stockCostProof!!).getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
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
