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
fun LiveProductManagementView(m: AppModel, close: () -> Unit) {
    var phaseProduct by remember { mutableStateOf<JSONObject?>(null) }
    phaseProduct?.let{LiveProductPhasesView(m,it.getString("id"),it.getString("name")){phaseProduct=null}}
    var operationsProduct by remember { mutableStateOf<JSONObject?>(null) }
    operationsProduct?.let{LiveProductOperationsView(m,it){operationsProduct=null}}
    var recipeProduct by remember { mutableStateOf<String?>(null) }
    var categories by remember { mutableStateOf(false) }
    var configuration by remember { mutableStateOf<JSONObject?>(null) }
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    val version = remember { m.workspaceVersion }
    val originalAccess = remember { m.priorityAccessKey }
    LaunchedEffect(m.priorityAccessKey) { if(m.priorityAccessKey != originalAccess)close() }
    LaunchedEffect(Unit) { m.loadProducts() }
    LaunchedEffect(m.workspaceVersion) { if (m.workspaceVersion != version) close() }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Row {
                        Text("商品管理", Modifier.weight(1f), fontSize = 22.sp)
                        TextButton(
                            onClick = { m.loadProducts(query, m.productBoard?.offset ?: 0) },
                            enabled = !m.busy,
                        ) {
                            Text("刷新")
                        }
                        TextButton(onClick = close) { Text("关闭") }
                    }
                    if(m.productBoard?.configurable==true){SecondaryAction(onClick={categories=true}) {Text("管理菜单分类")};SecondaryAction(onClick={configuration=JSONObject().put("id","new").put("nativeVersion","").put("code","").put("name","").put("categoryCode","").put("productKind","single").put("fulfillmentStation","kitchen").put("inventoryControlMode","not_managed").put("maxOrderQuantity",50).put("allowedChannels",org.json.JSONArray(listOf("guest_qr","staff_assisted","cashier"))).put("bundleComponents",org.json.JSONArray()).put("bundleChoiceGroups",org.json.JSONArray())},enabled=m.canUseProducts){Text("新增商品或套餐")}}
                    LivePendingView(m)
                    Text(m.productState, fontSize = 12.sp)
                    Row {
                        OutlinedTextField(
                            query,
                            { query = it },
                            label = { Text("名称或编码") },
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { m.loadProducts(query) }, enabled = !m.busy) {
                            Text("查询")
                        }
                    }
                }
                m.productBoard?.let { board ->
                    if (board.products.isEmpty()) item { Text("没有匹配商品") }
                    items(board.products, key = { it.getString("id") }) { p ->
                        Panel {
                            Text(p.getString("name"), fontSize = 18.sp)
                            Text(
                                p.getString("code") +
                                    " · " +
                                    (if (p.getString("productKind") == "bundle") "套餐" else "单品"),
                                fontSize = 12.sp,
                            )
                            Text(
                                (mapOf("active" to "在售", "sold_out" to "售罄", "inactive" to "下架")[
                                    p.getString("status")] ?: "待核对") +
                                    (if (p.getBoolean("guestVisible")) " · 客人可见" else " · 客人不可见")
                            )
                            Text(
                                productPriceText(p).let { if (it.isEmpty()) "未配置标准价" else "¥$it" } +
                                    " · 排序 ${p.getInt("menuSortOrder")}"
                            )
                            if(board.configurable&&p.getString("productKind")=="single"&&p.getString("inventoryControlMode")=="tracked"&&p.optJSONObject("productSnapshot")?.optString("salesSpecificationType") in listOf("whole_bottle","glass")) SecondaryAction(onClick={configuration=companionProductDraft(p)},enabled=m.canUseProducts){Text(if(p.getJSONObject("productSnapshot").getString("salesSpecificationType")=="whole_bottle")"新建共用原料的单杯商品" else "新建共用原料的整瓶商品")}
                            if(board.configurable&&p.getString("productKind")=="single"&&m.identity?.allows("inventory.manage")==true) SecondaryAction(onClick={recipeProduct=p.getString("id")},enabled=m.canUseProducts){Text("配方与耗料")}
                            if(m.identity?.allows("recommendation.phase.configure")==true) SecondaryAction(onClick={phaseProduct=p},enabled=m.canUseProducts){Text("适用演出阶段")}
                            if(board.data.optInt("operationalProtocol")==1) SecondaryAction(onClick={operationsProduct=p},enabled=m.canUseProducts){Text("规格、推荐与出品规则")}
                            if(board.configurable) SecondaryAction(onClick={configuration=p},enabled=m.canUseProducts){Text("分类、套餐与供应配置")}
                            PrimaryAction(onClick = { editing = p }, enabled = m.canUseProducts) {
                                Text("状态与价格")
                            }
                        }
                    }
                    item {
                        Row {
                            TextButton(
                                onClick = {
                                    m.loadProducts(
                                        query,
                                        (board.offset - board.limit).coerceAtLeast(0),
                                    )
                                },
                                enabled = !m.busy && board.offset > 0,
                            ) {
                                Text("上一页")
                            }
                            Text("第${board.offset/board.limit+1}页")
                            TextButton(
                                onClick = { m.loadProducts(query, board.offset + board.limit) },
                                enabled = !m.busy && board.products.size == board.limit,
                            ) {
                                Text("下一页")
                            }
                        }
                    }
                }
            }
        }
    }
    recipeProduct?.let{LiveRecipeConfigurationView(m,it){recipeProduct=null}}
    if(categories) LiveCategoryConfigurationView(m){categories=false}
    configuration?.let{p->key(p.getString("id"),p.getString("nativeVersion")){LiveProductConfigurationView(m,p){configuration=null}}}
    editing?.let { p ->
        key(p.getString("id")) { ProductManagementEditor(m, p) { editing = null } }
    }
}

@Composable
private fun ProductManagementEditor(m: AppModel, p: JSONObject, close: () -> Unit) {
    var status by remember { mutableStateOf(p.getString("status")) }
    var visible by remember { mutableStateOf(p.getBoolean("guestVisible")) }
    var sort by remember { mutableStateOf(p.getInt("menuSortOrder").toString()) }
    var price by remember { mutableStateOf(productPriceText(p)) }
    var reason by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    Text(p.getString("name"), fontSize = 22.sp)
                    TextButton(onClick = close) { Text("取消") }
                }
                item {
                    Row {
                        listOf("active" to "在售", "sold_out" to "售罄", "inactive" to "下架").forEach {
                            (value, label) ->
                            FilterChip(
                                selected = status == value,
                                onClick = { status = value },
                                label = { Text(label) },
                            )
                        }
                    }
                    Row {
                        Checkbox(visible, { visible = it })
                        Text("客人菜单可见")
                    }
                    OutlinedTextField(
                        sort,
                        { sort = it },
                        label = { Text("展示顺序 0—10000") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                }
                if (m.productBoard?.canPrice == true)
                    item {
                        OutlinedTextField(
                            price,
                            { price = it },
                            label = { Text("售价（人民币元）") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        )
                        OutlinedTextField(reason, { reason = it }, label = { Text("改价原因") })
                    }
                item {
                    Text("已有账单不改价；套餐与分类通过商品配置入口维护。恢复在售仍需满足配方与库存条件。", fontSize = 12.sp)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    PrimaryAction(
                        onClick = {
                            try {
                                proposed =
                                    productManagementCommand(
                                        m.identity!!,
                                        m.productBoard!!,
                                        p,
                                        status,
                                        visible,
                                        sort,
                                        price,
                                        reason,
                                    )
                            } catch (e: Exception) {
                                error = e.message ?: "请核对"
                            }
                        },
                        enabled = m.canUseProducts,
                    ) {
                        Text("核对变更")
                    }
                }
            }
        }
    }
    proposed?.let { command ->
        AlertDialog(
            onDismissRequest = { proposed = null },
            title = { Text(command.title) },
            text = { Text(command.steps[0].productManagementProof!!.getString("confirmation")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        m.executeLive(command)
                        close()
                    },
                    enabled = m.canExecuteLive(command),
                ) {
                    Text("确认提交")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回核对") } },
        )
    }
}
