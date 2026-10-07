package com.mbox.staff

import android.Manifest
import android.content.Intent
import android.os.Bundle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

val Ink = Color(0xFF234031)
val Paper = Color(0xFFF7F4EF)
val Gold = Color(0xFFC69A68)
val TextInk = Color(0xFF29251F)

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel

    override fun onStart() {
        super.onStart()
        model.foreground = true
        ServiceReminders.foreground = true
        ServiceReminders.clearNotice(this)
        model.resumeNotificationOpen()
        model.resumeNativePushRecovery()
    }

    override fun onStop() {
        model.foreground = false
        model.suspendNotificationOpen()
        ServiceReminders.foreground = false
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[AppModel::class.java]
        receiveNotificationIntent(intent)
        setContent {
            MaterialTheme(
                colorScheme =
                    lightColorScheme(
                        primary = Ink,
                        onPrimary = Color.White,
                        primaryContainer = Color(0xFFE4ECE6),
                        onPrimaryContainer = Ink,
                        secondary = Ink,
                        onSecondary = Color.White,
                        secondaryContainer = Color(0xFFE4ECE6),
                        onSecondaryContainer = Ink,
                        tertiary = Gold,
                        onTertiary = TextInk,
                        tertiaryContainer = Color(0xFFF3E8DA),
                        onTertiaryContainer = TextInk,
                        outline = Color(0xFF8A918A),
                        outlineVariant = Color(0xFFD5DAD3),
                        surfaceVariant = Color(0xFFEEEBE5),
                        onSurfaceVariant = Color(0xFF565D56),
                        background = Paper,
                        surface = Color(0xFFFFFDFA),
                        onSurface = TextInk,
                    )
            ) {
                StaffApp(model)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveNotificationIntent(intent)
    }

    private fun receiveNotificationIntent(incoming: Intent?) {
        if (incoming?.action == GetuiPush.action) {
            GetuiPush.payload(incoming)?.let { model.receiveGetuiPayload(org.json.JSONObject().put("mbox", it).toString(), true) }
            return
        }
        val consumed = when (val result = NotificationIntents.parse(incoming)) {
            is NotificationIntentResult.Target -> model.receiveNotificationTarget(result.target)
            NotificationIntentResult.Invalid -> {
                model.dismissNotificationOpen()
                model.message = "提醒内容无法验证，请从服务工作台查看当前任务"
                true
            }
            NotificationIntentResult.Ignored -> false
        }
        // Only discard the launch reference after durable storage or an explicit rejection.
        if (consumed) setIntent(Intent(this, MainActivity::class.java))
    }
}

@Composable
fun Brand(title: String, subtitle: String, summary: String? = null) {
    Box(
        Modifier.fillMaxWidth()
            .background(Brush.linearGradient(listOf(Color(0xFF0D1712), Ink, Color(0xFF101512))))
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawCircle(
                Brush.radialGradient(
                    listOf(Gold.copy(alpha = .26f), Color.Transparent),
                    center = Offset(size.width * .9f, 0f),
                    radius = size.width * .7f,
                ),
                radius = size.width,
                center = Offset(size.width * .9f, 0f),
            )
            drawCircle(
                Gold.copy(alpha = .22f),
                radius = size.width * .34f,
                center = Offset(size.width * .95f, size.height * 1.05f),
                style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()),
            )
        }
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .padding(horizontal = 17.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            if (summary != null)
                Text(summary, color = Color.White.copy(alpha = .9f), fontSize = 13.sp)
            Text(
                subtitle,
                color = Gold,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                modifier =
                    if (summary == null) Modifier
                    else
                        Modifier.background(
                                Color.White.copy(alpha = .08f),
                                RoundedCornerShape(20.dp),
                            )
                            .padding(horizontal = 7.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .background(Color(0xFFFFFDFA), RoundedCornerShape(16.dp))
            .border(1.dp, Color(0xFFE6DED2), RoundedCornerShape(16.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
fun Pending(m: AppModel) {
    if (m.pending != null)
        TextButton(onClick = { m.recover() }, enabled = !m.busy) {
            Text("原操作结果待确认 · 点击核对", color = Color(0xFF795934))
        }
}

@Composable
fun StaffApp(m: AppModel) {
    var tab by remember { mutableIntStateOf(0) }
    var serviceTarget by remember { mutableStateOf<ServiceAttention.Entry?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var menuSession by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<Command?>(null) }
    val tabs = if (m.live) staffTabs(m.identity) else listOf(0, 1, 2, 3)
    var scanContext by remember { mutableStateOf<String?>(null) }
    var scanTarget by remember { mutableStateOf<String?>(null) }
    val currentContext = "${m.identity?.sessionId}:${m.workspaceVersion}"
    val tableScanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        if (result.contents != null && scanContext == currentContext && m.identity?.canReadTables == true) {
            try { scanTarget = resolveScannedTable(result.contents, m.world.tables).id }
            catch (e: Exception) { m.message = e.message ?: "无法识别桌号，请手动搜索" }
        }
        scanContext = null
    }
    val scanTable: () -> Unit = {
        scanContext = currentContext
        tableScanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("扫描 M-BOX 桌码；识别后核对桌号").setBeepEnabled(false))
    }
    LaunchedEffect(tabs) {
        if (tab !in tabs) tab = tabs.first()
        if (0 !in tabs) { selected = null; menuSession = null; scanTarget = null }
    }
    LaunchedEffect(Unit) { m.restoreRememberedSession() }
    LaunchedEffect(m.foreground) { if (m.foreground) m.updater.check() }
    LaunchedEffect(m.live, m.foreground) {
        if (m.live && m.foreground)
            while (isActive) {
                m.heartbeat()
                delay(45000)
            }
    }
    LaunchedEffect(m.workspaceVersion) {
        if (m.identity != null) tab = tabs.first()
        scanTarget = null
        selected = null
        menuSession = null
        confirm = null
        serviceTarget = null
    }
    LaunchedEffect(m.notificationOpenTarget, m.foreground, m.businessRequestInFlight, m.identity?.canOpenServiceTasks()) {
        if (m.notificationOpenTarget != null && m.foreground) {
            m.consumeNotificationNavigation { serviceTarget = it }
        }
    }
    if (m.live && m.identity == null) {
        StaffLoginScreen(m)
        StaffMessage(m)
        return
    }
    BackHandler(selected != null) {
        if (menuSession != null) menuSession = null else selected = null
    }
    serviceTarget?.let { entry ->
        LiveServiceView(m, focusedTask = entry.id, focusedSession = entry.session) {
            serviceTarget = null
        }
    }
    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = Color(0xFFFFFDFA)) {
                val entries = mapOf(
                    0 to ("桌台" to Icons.Outlined.GridView),
                    1 to ("订单" to Icons.Outlined.ReceiptLong),
                    2 to ("收银" to Icons.Outlined.Payments),
                    3 to ("更多" to Icons.Outlined.Menu),
                    4 to ("制作" to Icons.Outlined.LocalFireDepartment),
                    5 to ("取餐" to Icons.Outlined.ShoppingBag),
                    6 to ("服务" to Icons.Outlined.Notifications),
                )
                tabs.forEach { i ->
                    val (label, icon) = entries.getValue(i)
                        NavigationBarItem(
                            selected = tab == i,
                            onClick = {
                                tab = i
                                selected = null
                                menuSession = null
                            },
                            icon = { Icon(icon, label) },
                            label = { Text(label) },
                            colors =
                                NavigationBarItemDefaults.colors(
                                    selectedIconColor = Ink,
                                    selectedTextColor = Ink,
                                    indicatorColor = Gold.copy(alpha = .16f),
                                ),
                        )
                    }
            }
        }
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().background(Paper)) {
            if (m.notificationOpenStatus.isNotBlank()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 17.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(m.notificationOpenStatus, Modifier.weight(1f), fontSize = 12.sp)
                    if (m.hasPendingNotification) TextButton(
                        onClick = { m.resumeNotificationOpen() }, enabled = !m.busy,
                    ) { Text("重新核对") }
                    TextButton(onClick = { m.dismissNotificationOpen() }, enabled = !m.busy) { Text("关闭") }
                }
            }
            if (m.live)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 17.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(m.connection, Modifier.weight(1f), fontSize = 12.sp)
                    val entry =
                        m.serviceAttention.firstUnread ?: m.serviceAttention.entries.firstOrNull()
                    if (m.identity?.canOpenServiceTasks() == true && entry != null) {
                        TextButton(
                            onClick = {
                                if (m.identity?.canOpenServiceTasks() == true) {
                                    serviceTarget = entry
                                    m.serviceAttention = m.serviceAttention.viewed(entry)
                                }
                            }
                        ) {
                            Text(
                                "服务 ${m.serviceAttention.entries.size}" +
                                    if (m.serviceAttention.unread.isEmpty()) ""
                                    else " · 新${m.serviceAttention.unread.size}"
                            )
                        }
                    }
                    TextButton(
                        onClick = { if (m.identity == null) tab = 3 else m.refresh() },
                        enabled = !m.busy,
                    ) {
                        Text(if (m.identity == null) "登录" else "刷新")
                    }
                }
            m.updater.release?.let { release ->
                TextButton(
                    onClick = {
                        selected = null
                        menuSession = null
                        tab = 3
                    }
                ) {
                    Text("新版本 ${release.version} · 查看更新")
                }
            }
            if (selected != null)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = {
                            if (menuSession != null) menuSession = null else selected = null
                        }
                    ) {
                        Icon(Icons.Outlined.ArrowBack, "返回")
                    }
                    Text(
                        if (menuSession != null)
                            "点单 · ${m.world.tables.find { it.id == selected }?.code ?: ""}"
                        else m.world.tables.find { it.id == selected }?.code ?: "桌台",
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            Column(
                Modifier.verticalScroll(rememberScrollState()).weight(1f),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val table = m.world.tables.find { it.id == selected }
                if (table != null) {
                    Detail(m, table, { menuSession = table.session }, { confirm = it })
                } else
                    when (tab) {
                        0 ->
                            Tables(
                                m,
                                { selected = it },
                                scanTable,
                            )
                        1 -> {
                            if (m.live) key(m.workspaceVersion) { LiveHistoryView(m) }
                            else {
                                Brand(
                                    "订单",
                                    if (m.live) "接口待接入" else "演练",
                                    "${m.world.orders.size} 笔",
                                )
                                Body {
                                    if (m.world.orders.isEmpty()) Text("暂无订单，从桌台进入点单后显示在这里。")
                                    m.world.orders.reversed().forEach { o ->
                                        Foldout(
                                            "${o.tableCode} · ${if(o.delivered)"已送达"else"待送达"} · ${money(o.amount)}"
                                        ) {
                                            o.lines.forEach {
                                                Text(
                                                    "${it.name} · ${it.variant} ×${it.quantity} · ${money(it.amount)}"
                                                )
                                            }
                                            val active =
                                                m.world.tables.find { it.session == o.session }
                                            if (active != null)
                                                TextButton(onClick = { selected = active.id }) {
                                                    Text("查看桌台")
                                                }
                                            else Text("此桌次已结束", fontSize = 12.sp)
                                        }
                                    }
                                }
                            }
                        }
                        2 -> {
                            if (m.live) key(m.workspaceVersion) { LiveCashierView(m) }
                            else {
                                Brand(
                                    "收银",
                                    if (m.live) "门店" else "演练",
                                    "${m.world.tables.count{it.session!=null}} 桌在座",
                                )
                                Body {
                                    m.world
                                        .ordered()
                                        .filter { it.session != null }
                                        .forEach { t ->
                                            Panel(
                                                Modifier.clickable(
                                                    role = androidx.compose.ui.semantics.Role.Button
                                                ) {
                                                    selected = t.id
                                                }
                                            ) {
                                                Row(
                                                    Modifier.fillMaxWidth(),
                                                    horizontalArrangement = Arrangement.SpaceBetween,
                                                ) {
                                                    Text(t.code, fontSize = 24.sp)
                                                    Text(money(t.due), fontWeight = FontWeight.Bold)
                                                }
                                                Text(t.status)
                                            }
                                        }
                                }
                            }
                        }
                        4 -> key(m.workspaceVersion) { LiveKitchenView(m) { tab = 3 } }
                        5 -> key(m.workspaceVersion) { LivePickupView(m) { tab = 3 } }
                        6 -> key(m.workspaceVersion) { LiveServiceView(m) { tab = 3 } }
                        else -> key(m.workspaceVersion) { More(m, scanTable) }
                    }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
    scanTarget?.let { id ->
        val target = m.world.tables.find { it.id == id }
        AlertDialog(onDismissRequest = { scanTarget = null }, title = { Text("核对桌号") },
            text = { Text(target?.let { "${it.code} · ${it.status}\n仅打开桌台，不会自动开台或下单。" } ?: "该桌台已不可见，请刷新后重扫") },
            confirmButton = { TextButton(enabled = target != null && m.identity?.canReadTables == true, onClick = {
                selected = id; menuSession = null; tab = 0; scanTarget = null
            }) { Text("查看桌台") } },
            dismissButton = { TextButton(onClick = { scanTarget = null }) { Text("取消") } })
    }
    val menuTable = m.world.tables.find { it.id == selected }
    val originalSession = menuSession
    if (menuTable != null && originalSession != null) {
        MenuScreen(m, menuTable.id, originalSession) { menuSession = null }
    }
    StaffMessage(m)
    confirm?.let { c ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("确认本次操作？") },
            text = {
                Text(if (c.kind == "cash") "现金 ${money(c.given)}，请确认已收到后记录。" else "将更新当前演练桌台状态。")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        m.execute(c)
                        confirm = null
                    }
                ) {
                    Text("确认")
                }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("取消") } },
        )
    }
}

@Composable
fun Body(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.padding(horizontal = 17.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

@Composable
fun Tables(m: AppModel, select: (String) -> Unit, camera: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("全部") }
    Brand(
        "桌台",
        if (m.live) "门店" else "演练",
        "营业 ${m.world.tables.count{it.session!=null}} · 待办 ${m.world.tables.count{it.service}}",
    )
    Body {
        Pending(m)
        LivePendingView(m)
        OutlinedTextField(
            query,
            { query = it },
            placeholder = { Text("搜索桌号，如 A、5、A5") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            trailingIcon = {
                TactileIconButton(onClick = camera) { Icon(Icons.Outlined.QrCodeScanner, "扫描桌码") }
            },
            shape = RoundedCornerShape(12.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("全部", "营业中", "空闲").forEach {
                FilterChip(selected = filter == it, onClick = { filter = it }, label = { Text(it) })
            }
        }
        if (m.live) TextButton(onClick = { m.refresh() }, enabled = !m.busy) { Text("刷新桌台") }
        val tables = m.world.ordered(query, filter)
        if (tables.isEmpty()) Text("没有匹配的桌台，试试部分桌号或切换筛选。")
        tables.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { t ->
                    val paused =
                        m.liveOperations?.tables?.find { it.display.id == t.id }?.status == "paused"
                    Column(
                        Modifier.weight(1f)
                            .heightIn(min = 132.dp)
                            .background(Color(0xFFFFFDFA), RoundedCornerShape(15.dp))
                            .border(
                                1.dp,
                                if (t.session != null) Ink.copy(alpha = .27f)
                                else Color(0xFFE6DED2),
                                RoundedCornerShape(15.dp),
                            )
                            .clickable { select(t.id) }
                            .padding(15.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(t.code, fontSize = 27.sp, fontWeight = FontWeight.SemiBold)
                            if (t.service) Icon(Icons.Outlined.Notifications, "待服务", tint = Gold)
                        }
                        Text(
                            if (paused && t.session == null) "已停用" else t.status,
                            fontSize = 12.sp,
                            color = if (t.unknown) Color(0xFF9A621E) else Ink,
                        )
                        Text(
                            if (t.session == null)
                                "${t.capacity} 人桌 · ${if(paused) "暂停开台" else "开台"}"
                            else "${t.people} 人在座 · ${money(t.due)}",
                            fontSize = 14.sp,
                        )
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
fun Detail(m: AppModel, t: StaffTable, menu: () -> Unit, ask: (Command) -> Unit) {
    var people by remember(t.id) { mutableIntStateOf(2) }
    var cash by remember(t.session) { mutableStateOf("") }
    var target by remember { mutableStateOf("") }
    val enabled = !m.busy && m.pending == null
    Body {
        Pending(m)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(t.status, color = if (t.unknown) Color(0xFF9A621E) else Ink)
            Text(if (m.live) "门店" else "演练", fontSize = 12.sp)
        }
        if (t.session != null)
            Panel {
                Text("当前待收", fontSize = 12.sp)
                Text(money(t.due), fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
                Text("账单 ${money(t.total)}    已收 ${money(t.paid)}")
            }
        if (m.live) LiveTableActions(m, t.id)
        else if (t.session == null) {
            Panel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("用餐人数：$people", Modifier.weight(1f))
                    TactileIconButton(
                        onClick = { people = maxOf(1, people - 1) },
                        enabled = people > 1,
                    ) {
                        Icon(Icons.Outlined.Remove, "减少人数")
                    }
                    TactileIconButton(
                        onClick = { people = minOf(t.capacity, people + 1) },
                        enabled = people < t.capacity,
                        prominent = true,
                    ) {
                        Icon(Icons.Outlined.Add, "增加人数")
                    }
                }
            }
            Primary("确认开台", enabled) { ask(Command("open", t.id, null, people = people)) }
        } else {
            Primary("点菜 / 加菜", enabled) { menu() }
            if (t.unknown)
                Panel {
                    Text("原款结果待确认，暂不可再次收款", color = Color(0xFF9A621E))
                    Text("当前为异常状态样例；真实通道查询尚未接入。", fontSize = 12.sp)
                }
            if (t.service)
                SecondaryAction(
                    onClick = { ask(Command("service", t.id, t.session)) },
                    icon = Icons.Outlined.TaskAlt,
                    enabled = enabled,
                ) {
                    Text("完成本桌服务任务")
                }
            if ((t.due ?: 0) > 0 && !t.unknown)
                Panel {
                    Text("现金收款 · 演练", fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        cash,
                        { cash = it },
                        label = { Text("顾客交付现金") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    parseMoney(cash)?.let {
                        Text(
                            "本次记账 ${money(minOf(it,t.due!!))} · 找零 ${money(maxOf(0,it-t.due!!))}",
                            fontSize = 12.sp,
                        )
                    }
                    Primary("核对并记录现金", enabled && parseMoney(cash) != null) {
                        ask(Command("cash", t.id, t.session, given = parseMoney(cash) ?: 0))
                    }
                }
            m.world.orders
                .filter { it.session == t.session }
                .forEach { o ->
                    Panel {
                        Text(if (o.delivered) "已送达" else "待送商品", fontWeight = FontWeight.Bold)
                        o.lines.forEach { Text("${it.name} · ${it.variant} ×${it.quantity}") }
                        if (!o.delivered)
                            SecondaryAction(
                                onClick = {
                                    ask(Command("deliver", t.id, t.session, orderID = o.id))
                                },
                                enabled = enabled,
                                icon = Icons.Outlined.CheckCircle,
                            ) {
                                Text("确认送达")
                            }
                    }
                }
            Panel {
                Text("转到空闲桌")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    m.world.tables
                        .filter { it.session == null && it.capacity >= t.people }
                        .forEach {
                            FilterChip(
                                selected = target == it.id,
                                onClick = { target = it.id },
                                label = { Text(it.code) },
                            )
                        }
                }
                SecondaryAction(
                    onClick = { ask(Command("transfer", t.id, t.session, targetID = target)) },
                    icon = Icons.Outlined.SwapHoriz,
                    enabled = enabled && target.isNotEmpty(),
                ) {
                    Text("转台")
                }
                HorizontalDivider()
                SecondaryAction(
                    onClick = { ask(Command("close", t.id, t.session)) },
                    danger = true,
                    icon = Icons.Outlined.Logout,
                    enabled = enabled,
                ) {
                    Text("结束用餐 · 释放桌台")
                }
                Text("结清后仍保留在座；结束用餐才释放桌台。", fontSize = 12.sp)
            }
        }
    }
}

@Composable
fun MenuScreen(m: AppModel, tableID: String, session: String, close: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    var showingDraft by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    var submitted by remember { mutableStateOf(false) }
    val previousOrders = remember { m.world.orders.size }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(m.world.orders.size) {
        if (
            m.world.orders.size > previousOrders && m.world.orders.lastOrNull()?.session == session
        ) {
            submitted = true
            showingDraft = false
        }
    }
    val lines = m.draft(session)
    androidx.compose.ui.window.Dialog(
        onDismissRequest = close,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(
                Modifier.safeDrawingPadding().imePadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = close) { Text("返回桌台") }
                    Text(
                        "菜单 · ${m.world.tables.find{it.id==tableID}?.code.orEmpty()}",
                        style = MaterialTheme.typography.titleLarge,
                    )
                }
                Text("演练菜单 · 样例商品；营业菜单请在“更多”登录门店", fontSize = 12.sp)
                if (submitted) Text("本桌演练订单已提交，可继续加菜", color = Ink)
                if (!showingDraft)
                    MenuFilters(
                        query,
                        { query = it },
                        category,
                        { category = it },
                        m.world.products.map { it.category }.distinct().sorted().map { it to it },
                    )
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Pending(m)
                    if (showingDraft) {
                        if (lines.isEmpty()) Text("还没有选择商品，返回菜单添加")
                        lines.forEach { line ->
                            Panel {
                                Text(line.name, style = MaterialTheme.typography.titleMedium)
                                Text("${line.variant} · ${line.quantity}份 · ${money(line.amount)}")
                                SecondaryAction(
                                    onClick = {
                                        m.world.products
                                            .find { it.id == line.productID }
                                            ?.let { m.change(it, line.variant, session, -1) }
                                    },
                                    enabled = !m.busy && m.pending == null,
                                ) {
                                    Text("减少一份")
                                }
                            }
                        }
                    } else {
                        val products =
                            m.world.products.filter {
                                (category.isEmpty() || it.category == category) &&
                                    "${it.name} ${it.category}".contains(query.trim(), true)
                            }
                        if (products.isEmpty()) Text("没有匹配的菜品，可切换全部菜单或清除搜索")
                        products.forEach { p ->
                            key(p.id) {
                                var choice by remember { mutableStateOf(p.choices[0]) }
                                Panel {
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        MenuThumbnail()
                                        Column(
                                            Modifier.weight(1f),
                                            verticalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            Text(
                                                p.name,
                                                style = MaterialTheme.typography.titleMedium,
                                            )
                                            Text(
                                                if (p.available) p.category else "已售罄",
                                                fontSize = 12.sp,
                                            )
                                            Text(
                                                money(p.price),
                                                style = MaterialTheme.typography.titleLarge,
                                                color = Ink,
                                            )
                                        }
                                    }
                                    if (p.choices.size > 1)
                                        Row(
                                            Modifier.horizontalScroll(rememberScrollState()),
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            p.choices.forEach {
                                                FilterChip(
                                                    selected = choice == it,
                                                    onClick = { choice = it },
                                                    label = { Text(it) },
                                                )
                                            }
                                        }
                                    val quantity =
                                        lines
                                            .find { it.productID == p.id && it.variant == choice }
                                            ?.quantity ?: 0
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            if (quantity > 0) "已选 $quantity 份" else "选择份数",
                                            Modifier.weight(1f),
                                            fontSize = 12.sp,
                                        )
                                        TactileIconButton(
                                            onClick = { m.change(p, choice, session, -1) },
                                            enabled = quantity > 0 && !m.busy && m.pending == null,
                                        ) {
                                            Icon(Icons.Outlined.Remove, "减少 ${p.name}")
                                        }
                                        Text("$quantity")
                                        TactileIconButton(
                                            onClick = { m.change(p, choice, session, 1) },
                                            prominent = true,
                                            enabled = p.available && !m.busy && m.pending == null,
                                        ) {
                                            Icon(Icons.Outlined.Add, "添加 ${p.name}")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Primary(
                    if (showingDraft) "返回菜单继续加菜"
                    else "查看已选 ${lines.sumOf{it.quantity}}份 · ${money(lines.sumOf{it.amount})}",
                    true,
                ) {
                    showingDraft = !showingDraft
                }
                if (showingDraft)
                    Primary("核对无误，提交演练订单", lines.isNotEmpty() && !m.busy && m.pending == null) {
                        confirm = true
                    }
            }
        }
    }
    if (confirm)
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("确认当前桌号、商品及规格") },
            text = { Text("仅提交本桌演练订单，不写入营业数据。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        m.execute(Command("order", tableID, session, lines = lines))
                    }
                ) {
                    Text("确认提交")
                }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("返回") } },
        )
}

@Composable
fun Foldout(title: String, content: @Composable ColumnScope.() -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Panel {
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth()) {
            Text(title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                if (expanded) "收起" else "展开",
            )
        }
        if (expanded) content()
    }
}

@Composable
fun More(m: AppModel, camera: () -> Unit) {
    var fulfillmentHistoryVisible by remember { mutableStateOf(false) }
    if(fulfillmentHistoryVisible) LiveFulfillmentHistoryView(m){fulfillmentHistoryVisible=false}
    var annualPolicyVisible by remember { mutableStateOf(false) }
    if(annualPolicyVisible) LiveAnnualPoliciesView(m){annualPolicyVisible=false}
    var membershipRecoveryVisible by remember { mutableStateOf(false) }
    if(membershipRecoveryVisible) LiveMembershipRecoveryView(m){membershipRecoveryVisible=false}
    var memberNumberVisible by remember { mutableStateOf(false) }
    if(memberNumberVisible) LiveMemberNumberView(m){memberNumberVisible=false}
    var printingVisible by remember { mutableStateOf(false) }
    if(printingVisible) LivePrintingView(m){printingVisible=false}
    var vouchersVisible by remember { mutableStateOf(false) }
    if(vouchersVisible) LiveVouchersView(m, close = { vouchersVisible=false })
    var membershipOverviewVisible by remember { mutableStateOf(false) }
    if(membershipOverviewVisible) LiveMembershipOverviewView(m){membershipOverviewVisible=false}
    var devicesVisible by remember { mutableStateOf(false) }
    if(devicesVisible) LiveDevicesView(m) { devicesVisible = false }
    var songsVisible by remember { mutableStateOf(false) }
    if (songsVisible) LiveSongsView(m) { songsVisible = false }
    var benefitsVisible by remember { mutableStateOf(false) }
    if (benefitsVisible) LiveBenefitsView(m) { benefitsVisible = false }
    var couponRefundsVisible by remember { mutableStateOf(false) }
    var checkoutManagementVisible by remember { mutableStateOf(false) }
    var socialVisible by remember { mutableStateOf(false) }
    var contactGovernanceVisible by remember { mutableStateOf(false) }
    var marketingVisible by remember { mutableStateOf(false) }
    var recommendationPoliciesVisible by remember { mutableStateOf(false) }
    var activityOperationsVisible by remember { mutableStateOf(false) }
    var homeContentVisible by remember { mutableStateOf(false) }
    var launchPopupVisible by remember { mutableStateOf(false) }
    var commercePolicyVisible by remember { mutableStateOf(false) }
    var memberGiftsVisible by remember { mutableStateOf(false) }
    var stackingPoliciesVisible by remember { mutableStateOf(false) }
    var couponCalendarsVisible by remember { mutableStateOf(false) }
    if(couponRefundsVisible) LiveCouponRefundsView(m){couponRefundsVisible=false}
    if(checkoutManagementVisible) LiveCheckoutManagementView(m){checkoutManagementVisible=false}
    if(socialVisible) LiveSocialOperationsView(m){socialVisible=false}
    if(contactGovernanceVisible) LiveContactGovernanceView(m){contactGovernanceVisible=false}
    if(marketingVisible) LiveMarketingView(m){marketingVisible=false}
    if(recommendationPoliciesVisible) LiveRecommendationPoliciesView(m){recommendationPoliciesVisible=false}
    if(activityOperationsVisible) LiveActivityOperationsView(m){activityOperationsVisible=false}
    if(homeContentVisible) LiveHomeContentView(m){homeContentVisible=false}
    if(launchPopupVisible) LiveLaunchPopupView(m){launchPopupVisible=false}
    if(commercePolicyVisible) LiveCommercePolicyView(m){commercePolicyVisible=false}
    if(memberGiftsVisible) LiveMemberGiftsView(m){memberGiftsVisible=false}
    if(stackingPoliciesVisible) LiveStackingPoliciesView(m){stackingPoliciesVisible=false}
    if(couponCalendarsVisible) LiveCouponCalendarsView(m){couponCalendarsVisible=false}
    var publicationVisible by remember { mutableStateOf(false) }
    if(publicationVisible) LivePublicationView(m){publicationVisible=false}
    var staffAdministrationVisible by remember { mutableStateOf(false) }
    if(staffAdministrationVisible) LiveStaffAdministrationView(m) {staffAdministrationVisible=false}
    var tableConfigurationVisible by remember { mutableStateOf(false) }
    if(tableConfigurationVisible) LiveTableConfigurationView(m) {tableConfigurationVisible=false}
    var benefitWalletVisible by remember { mutableStateOf(false) }
    if(benefitWalletVisible) LiveBenefitWalletView(m) {benefitWalletVisible=false}
    var remakeHandoverVisible by remember { mutableStateOf(false) }
    if(remakeHandoverVisible) LiveRemakeHandoverView(m) {remakeHandoverVisible=false}
    var membershipConfigVisible by remember { mutableStateOf(false) }
    if(membershipConfigVisible) LiveMembershipConfigView(m) {membershipConfigVisible=false}
    var loyaltySupplementsVisible by remember { mutableStateOf(false) }
    if(loyaltySupplementsVisible) LiveLoyaltySupplementsView(m) {loyaltySupplementsVisible=false}
    var benefitExceptionsVisible by remember { mutableStateOf(false) }
    if(benefitExceptionsVisible) LiveBenefitExceptionsView(m) {benefitExceptionsVisible=false}
    var loyaltyRefundVisible by remember { mutableStateOf(false) }
    if(loyaltyRefundVisible) LiveLoyaltyRefundsView(m) {loyaltyRefundVisible=false}
    var memberCardsVisible by remember { mutableStateOf(false) }
    if(memberCardsVisible) LiveMemberCardsView(m) {memberCardsVisible=false}
    var performanceVisible by remember { mutableStateOf(false) }
    if(performanceVisible) LivePerformanceView(m) {performanceVisible=false}
    var ownerVisible by remember { mutableStateOf(false) }
    if(ownerVisible) LiveOwnerFinanceView(m) { ownerVisible=false }
    var custodyVisible by remember { mutableStateOf(false) }
    if (custodyVisible) LiveCustodyView(m) { custodyVisible = false }
    var membersVisible by remember { mutableStateOf(false) }
    if (membersVisible) LiveMembersView(m) { membersVisible = false }

    var productsVisible by remember { mutableStateOf(false) }
    if (productsVisible) LiveProductManagementView(m) { productsVisible = false }
    var stockAuditVisible by remember { mutableStateOf(false) }
    if (stockAuditVisible) LiveStockAuditView(m) { stockAuditVisible = false }
    var businessReportsVisible by remember { mutableStateOf(false) }
    if (businessReportsVisible) LiveBusinessReportsView(m) { businessReportsVisible = false }
    var overviewVisible by remember { mutableStateOf(false) }
    if (overviewVisible) LiveOverviewView(m) { overviewVisible = false }
    var stockVisible by remember { mutableStateOf(false) }
    var serviceVisible by remember { mutableStateOf(false) }
    if (stockVisible) LiveStockView(m) { stockVisible = false }
    if (serviceVisible) LiveServiceView(m) { serviceVisible = false }
    var reservationsVisible by remember { mutableStateOf(false) }
    if (reservationsVisible) LiveReservationsView(m) { reservationsVisible = false }
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var reset by remember { mutableStateOf(false) }
    var pickupVisible by remember { mutableStateOf(false) }
    if (pickupVisible) LivePickupView(m) { pickupVisible = false }
    var assignmentsVisible by remember { mutableStateOf(false) }
    if (assignmentsVisible) LiveAssignmentsView(m) { assignmentsVisible = false }
    var fulfillmentVisible by remember { mutableStateOf(false) }
    if (fulfillmentVisible) LiveFulfillmentView(m) { fulfillmentVisible = false }
    var kitchenVisible by remember { mutableStateOf(false) }
    if (kitchenVisible) LiveKitchenView(m) { kitchenVisible = false }
    Brand("更多", if (m.live) "${m.staffName} · 门店" else "演练")
    Body {
        Pending(m)
        LivePendingView(m)
        Foldout(if (m.identity == null) "门店登录" else "员工账号") { LiveAccountView(m) }
        if(m.live) StaffToolMenu(m.identity){ id ->
            when(id){
                "fulfillmentHistory" -> fulfillmentHistoryVisible=true
                "annualPolicies" -> annualPolicyVisible=true
                "membershipRecovery" -> membershipRecoveryVisible=true
                "memberNumber" -> memberNumberVisible=true
                "printing" -> printingVisible=true
                "vouchers" -> vouchersVisible=true
                "devices" -> devicesVisible=true
                "songs" -> songsVisible=true
                "benefits" -> benefitsVisible=true
                "couponRefunds" -> couponRefundsVisible=true
                "checkoutManagement" -> checkoutManagementVisible=true
                "social" -> socialVisible=true
                "contactGovernance" -> contactGovernanceVisible=true
                "marketing" -> marketingVisible=true
                "recommendationPolicies" -> recommendationPoliciesVisible=true
                "activityOperations" -> activityOperationsVisible=true
                "homeContent" -> homeContentVisible=true
                "launchPopup" -> launchPopupVisible=true
                "commercePolicy" -> commercePolicyVisible=true
                "memberGifts" -> memberGiftsVisible=true
                "stackingPolicies" -> stackingPoliciesVisible=true
                "couponCalendars" -> couponCalendarsVisible=true
                "publication" -> publicationVisible=true
                "staffAdministration" -> staffAdministrationVisible=true
                "tableConfiguration" -> tableConfigurationVisible=true
                "benefitWallet" -> benefitWalletVisible=true
                "remakeHandover" -> remakeHandoverVisible=true
                "membershipConfig" -> membershipConfigVisible=true
                "loyaltySupplements" -> loyaltySupplementsVisible=true
                "benefitExceptions" -> benefitExceptionsVisible=true
                "loyaltyRefund" -> loyaltyRefundVisible=true
                "memberCards" -> memberCardsVisible=true
                "performance" -> performanceVisible=true
                "owner" -> ownerVisible=true
                "custody" -> custodyVisible=true
                "members" -> membersVisible=true
                "products" -> productsVisible=true
                "stockAudit" -> stockAuditVisible=true
                "businessReports" -> businessReportsVisible=true
                "overview" -> overviewVisible=true
                "stock" -> stockVisible=true
                "service" -> serviceVisible=true
                "reservations" -> reservationsVisible=true
                "pickup" -> pickupVisible=true
                "assignments" -> assignmentsVisible=true
                "fulfillment" -> fulfillmentVisible=true
                "kitchen" -> kitchenVisible=true
                "membershipOverview" -> membershipOverviewVisible=true
            }
        }
        Foldout(if (m.updater.release == null) "版本与更新" else "版本与更新 · 有新版本") { AppUpdateView(m) }
        Foldout("通知与后台待办") { ServiceReminderView(m) }
        Foldout("设备权限") {
            SecondaryAction(onClick = camera, enabled = m.identity?.allows("dashboard.view") == true, icon = Icons.Outlined.CameraAlt) {
                Text("扫描桌码")
            }
            Text("桌台支持扫码定位；付款码、会员码和库存码请从对应业务入口扫描。语音输入位于桌台现场服务记录，识别后需核对文字。", fontSize = 12.sp)
        }
        if (!m.live)
            Foldout("异常场景演练") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("下一次操作模拟回执中断", Modifier.weight(1f))
                    Switch(
                        m.simulateTimeout,
                        { m.simulateTimeout = it },
                        enabled = !m.busy && m.pending == null,
                    )
                }
                Pending(m)
                SecondaryAction(
                    onClick = { reset = true },
                    enabled = !m.busy && m.pending == null,
                    danger = true,
                    icon = Icons.Outlined.RestartAlt,
                ) {
                    Text("重置演练数据")
                }
            }
        Text("版本 ${BuildConfig.VERSION_NAME} · ${m.staffName}\n功能按岗位权限开放，通道及打印设备连接状态以业务页面为准。", fontSize = 12.sp)
    }
    if (reset)
        AlertDialog(
            onDismissRequest = { reset = false },
            title = { Text("重置演练数据？") },
            text = { Text("清空本机演练订单及草稿。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        m.reset()
                        reset = false
                    }
                ) {
                    Text("重置")
                }
            },
            dismissButton = { TextButton(onClick = { reset = false }) { Text("取消") } },
        )
}

@Composable
fun StaffMessage(m: AppModel) {
    if (m.message.isNotEmpty())
        AlertDialog(
            onDismissRequest = { m.message = "" },
            title = { Text("M-BOX") },
            text = { Text(m.message) },
            confirmButton = { TextButton(onClick = { m.message = "" }) { Text("知道了") } },
        )
}
