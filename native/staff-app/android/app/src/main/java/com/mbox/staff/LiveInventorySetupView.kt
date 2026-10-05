package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

@Composable
fun LiveInventorySetupView(m: AppModel, close: () -> Unit) {
    val access = remember { m.priorityAccessKey }; val workspace = remember { m.workspaceVersion }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var notice by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { m.loadInventorySetup() }
    LaunchedEffect(m.priorityAccessKey, m.workspaceVersion) { if (access != m.priorityAccessKey || workspace != m.workspaceVersion) close() }
    if (access != m.priorityAccessKey || workspace != m.workspaceVersion) return
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row { Text("物料与包装条码", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge); TextButton(onClick = close) { Text("关闭") } }
                    LivePendingView(m); Text(m.inventorySetupState)
                    TextButton(onClick = { m.loadInventorySetup() }, enabled = !m.busy) { Text("重新读取物料") }
                    if (notice.isNotEmpty()) Text(notice, color = MaterialTheme.colorScheme.error)
                }
                m.inventorySetupBoard?.let { board ->
                    item {
                        key(board.actor) {
                            InventorySetupFields(board, m.canUseInventorySetup) { selection ->
                                try { proposed = inventorySetupCommand(requireNotNull(m.identity), board, selection); notice = "" }
                                catch (e: Exception) { notice = e.message ?: "请核对物料资料" }
                            }
                        }
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(onDismissRequest = { proposed = null }, title = { Text(command.title) },
            text = { Text(command.steps.single().inventorySetupProof!!.getString("confirmation")) },
            confirmButton = { TextButton(onClick = { proposed = null; m.executeLive(command) }, enabled = m.canExecuteLive(command)) { Text("确认保存") } },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回修改") } })
    }
}

@Composable
private fun InventorySetupFields(board: InventorySetupBoard, enabled: Boolean, submit: (InventorySetupSelection) -> Unit) {
    var mode by remember { mutableStateOf("create") }; var search by remember { mutableStateOf("") }; var itemId by remember { mutableStateOf("") }
    Panel {
        AssignmentChoice("操作", mode, listOf("create" to "新建物料", "edit" to "维护已有资料", "bind" to "绑定包装条码")) { mode = it }
        if (mode != "create") {
            CustodyField("搜索物料名称、编号或条码", search, 128) { search = it }
            AssignmentChoice("选择原物料", itemId, listOf("" to "请选择") + board.items.filter { item ->
                search.isBlank() || listOf(item.getString("name"), item.getString("sku"), item.getJSONArray("barcodes").objects().joinToString(" ") { it.getString("code") }).any { it.contains(search, true) }
            }.map { it.getString("id") to "${it.getString("name")} · ${it.getString("sku")} · ${it.getString("baseUnit")}" }) { itemId = it }
        }
        val selected = board.items.firstOrNull { it.getString("id") == itemId }
        var original by remember(mode, itemId) { mutableStateOf(selected?.let { JSONObject(it.toString()) }) }
        var revision by remember(mode, itemId) { mutableIntStateOf(0) }
        val changed = mode != "create" && original?.getString("updatedAt") != selected?.getString("updatedAt")
        if (changed) {
            Text("原物料已被更新或停用。当前输入已保留，请重新核对后再提交。", color = MaterialTheme.colorScheme.error)
            TextButton(onClick = { original = selected?.let { JSONObject(it.toString()) }; revision++ }, enabled = selected != null) { Text("载入最新资料（替换当前编辑）") }
        }
        key(mode, itemId, revision) {
            if (mode == "create" || original != null) {
                if (mode == "bind") BarcodeSetupFields(requireNotNull(original), enabled && !changed) { fields -> submit(InventorySetupSelection(mode, itemId, fields)) }
                else MaterialSetupFields(if (mode == "create") null else original, enabled && !changed) { fields -> submit(InventorySetupSelection(mode, if (mode == "create") null else itemId, fields)) }
            } else Text(if (board.items.isEmpty()) "尚无物料，请先新建，再录入采购收货。" else "请选择物料后继续。")
        }
    }
}

@Composable
private fun MaterialSetupFields(item: JSONObject?, enabled: Boolean, submit: (JSONObject) -> Unit) {
    var sku by remember { mutableStateOf("") }; var name by remember { mutableStateOf(item?.getString("name") ?: "") }
    var type by remember { mutableStateOf("ingredient") }; var unit by remember { mutableStateOf("g") }
    var category by remember { mutableStateOf(item?.getString("categoryCode") ?: "uncategorized") }
    var threshold by remember { mutableStateOf(item?.textOrNull("lowStockThreshold") ?: "") }
    var volume by remember { mutableStateOf(item?.textOrNull("packageVolumeMl") ?: "") }
    var whole by remember { mutableStateOf(false) }; var waste by remember { mutableStateOf("0") }
    CustodyField("物料名称", name, 200) { name = it }
    if (item == null) {
        CustodyField("唯一物料编号", sku, 64) { sku = it }
        AssignmentChoice("物料类型", type, listOf("ingredient" to "原料", "bottle" to "酒水", "food" to "食品", "packaging" to "包装", "consumable" to "耗材", "other" to "其他")) { type = it }
        AssignmentChoice("库存基础单位", unit, listOf("ml" to "毫升 ml", "g" to "克 g", "piece" to "件 piece", "bottle" to "瓶 bottle（非酒水历史用途）", "portion" to "份 portion")) { unit = it }
        Row { Checkbox(whole, { whole = it }); Text("盘点只接受整数基础单位") }
        CustodyField("合理损耗量（基础单位）", waste, 24) { waste = it }
    } else Text("${item.getString("sku")} · ${item.getString("baseUnit")}\n编号、物料类型、基础单位保留；已有库存不会重算。")
    AssignmentChoice("常用分类", category, listOf("uncategorized" to "未分类", "spirits" to "烈酒", "wine" to "葡萄酒", "beer" to "啤酒", "mixer" to "糖浆与果汁", "snack" to "食品", "packaging" to "包装", "consumable" to "耗材") +
        if (category !in listOf("uncategorized", "spirits", "wine", "beer", "mixer", "snack", "packaging", "consumable")) listOf(category to category) else emptyList()) { category = it }
    CustodyField("分类编码（可自定义英文）", category, 64) { category = it }
    Text("酒水、啤酒、果汁和糖浆按毫升管理；每瓶净含量用于扫码收货换算，不能把1瓶填成1毫升。")
    CustodyField("每瓶净含量 ml（非液体可留空）", volume, 24) { volume = it }
    CustodyField("低库存提醒数量（留空不设置）", threshold, 24) { threshold = it }
    PrimaryAction(onClick = { submit(JSONObject().put("name", name).put("sku", sku).put("itemType", type).put("baseUnit", unit).put("categoryCode", category).put("packageVolumeMl", volume).put("lowStockThreshold", threshold).put("wholeUnitCount", whole).put("reasonableWasteQuantity", waste)) }, enabled = enabled) { Text(if (item == null) "核对新物料" else "核对资料修改") }
}

@Composable
private fun BarcodeSetupFields(item: JSONObject, enabled: Boolean, submit: (JSONObject) -> Unit) {
    var code by remember { mutableStateOf("") }; var type by remember { mutableStateOf("barcode") }
    var quantity by remember { mutableStateOf(if (item.getString("baseUnit") == "ml") item.textOrNull("packageVolumeMl") ?: "" else "1") }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { if (it.contents != null) code = it.contents }
    Text("已有条码")
    val codes = item.getJSONArray("barcodes").objects()
    if (codes.isEmpty()) Text("尚未绑定")
    codes.forEach { Text("${it.getString("code")} · 每码 ${it.getString("packageQuantity")} ${item.getString("baseUnit")}") }
    CustodyField("包装条码内容", code, 128) { code = it }
    SecondaryAction(onClick = { scanner.launch(ScanOptions().setPrompt("扫描物料包装条码").setBeepEnabled(false).setOrientationLocked(false)) }, enabled = enabled) { Text("扫描包装条码") }
    AssignmentChoice("码类型", type, listOf("barcode" to "商品条码", "qr" to "二维码", "internal" to "内部编码")) { type = it }
    CustodyField("每码代表的基础单位数量（${item.getString("baseUnit")}）", quantity, 24) { quantity = it }
    Text("例如12件/箱填写12；750毫升/瓶填写750。已有条码不覆盖绑定，冲突时须核对原物料。")
    PrimaryAction(onClick = { submit(JSONObject().put("code", code).put("codeType", type).put("packageQuantity", quantity)) }, enabled = enabled) { Text("核对包装条码") }
}
