package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable
fun LiveMembersView(m: AppModel, close: () -> Unit) {
    var rewards by remember { mutableStateOf(m.identity?.allows("loyalty.account.view") != true) }
    var code by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("pending") }
    var error by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var physical by remember { mutableStateOf(false) }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(Unit) { if (rewards) m.loadMemberRewards() }
    fun propose(work: () -> LiveCommand) {
        try {
            proposed = work()
            physical = false
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请核对会员操作"
        }
    }
    val scan =
        rememberLauncherForActivityResult(ScanContract()) { result ->
            result.contents?.let {
                try {
                    require(it.startsWith("MBOX_MEMBER_V1:", true)) { "请扫描顾客小程序中的会员码" }
                    code = MemberCommands.code(it)
                } catch (e: Exception) {
                    error = e.message ?: "会员码无效"
                }
            }
        }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("会员服务", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("关闭") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    if (
                        m.identity?.allows("loyalty.account.view") == true &&
                            m.identity?.allows("loyalty.configuration.view") == true
                    )
                        Row {
                            FilterChip(!rewards, { rewards = false }, label = { Text("会员与签到") })
                            FilterChip(rewards, { rewards = true }, label = { Text("奖励审批") })
                        }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    if (rewards) {
                        Text(m.memberRewardState, fontSize = 12.sp)
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            TextButton(onClick = { menu = true }) {
                                Text(
                                    "状态 · " +
                                        if (filter == "all") "全部" else memberRewardLabel(filter)
                                )
                            }
                            DropdownMenu(menu, { menu = false }) {
                                for (id in
                                    listOf(
                                        "pending",
                                        "issued",
                                        "rejected",
                                        "invalid",
                                        "all",
                                    )) DropdownMenuItem(
                                    text = {
                                        Text(if (id == "all") "全部" else memberRewardLabel(id))
                                    },
                                    onClick = {
                                        filter = id
                                        menu = false
                                        selected = emptySet()
                                    },
                                )
                            }
                        }
                        SecondaryAction(
                            onClick = {
                                selected = emptySet()
                                m.loadMemberRewards(filter)
                            },
                            enabled = !m.busy,
                        ) {
                            Text("读取奖励记录")
                        }
                        m.memberRewards?.let { board ->
                            Foldout("签到奖励规则") {
                                for (rule in board.source.getJSONArray("rules").objects()) {
                                    Text(
                                        "${rule.getString("name")} · 每${rule.getInt("required_visits")}个营业日到店 / ${rule.getInt("quantity")}份"
                                    )
                                    Text(
                                        (rule.textOrNull("products") ?: "商品待核对") +
                                            " · " +
                                            if (rule.getString("status") == "active") "生效中"
                                            else "已停用",
                                        fontSize = 12.sp,
                                    )
                                }
                            }
                            for (row in board.rows) Panel {
                                Text(
                                    row.getString("member_no") +
                                        " · " +
                                        memberRewardLabel(row.getString("status"))
                                )
                                Text("${row.getString("name")} · ${row.getInt("quantity")}份")
                                Text(row.textOrNull("products") ?: "商品待核对", fontSize = 12.sp)
                                val dates = row.getJSONArray("visit_dates")
                                Text(
                                    "签到日：" +
                                        (0 until dates.length()).joinToString("、") {
                                            dates.getString(it)
                                        },
                                    fontSize = 12.sp,
                                )
                                Text(
                                    "已领取 ${row.getInt("quantity_redeemed")}份 · 撤回签到 ${row.getInt("cancelled_sources")}次",
                                    fontSize = 12.sp,
                                )
                                row.textOrNull("decision_reason")?.let {
                                    Text(it, fontSize = 12.sp)
                                }
                                if (
                                    row.getString("status") == "pending" &&
                                        m.identity?.allows("loyalty.configuration.approve") == true
                                )
                                    Row {
                                        val id = row.getString("id")
                                        Checkbox(
                                            id in selected,
                                            { selected = if (it) selected + id else selected - id },
                                        )
                                        Text("选择本条")
                                    }
                            }
                            if (board.rows.isEmpty()) Text("当前范围没有奖励记录")
                            if (board.next != null)
                                SecondaryAction(
                                    onClick = { m.loadMemberRewards(filter, true) },
                                    enabled = !m.busy && filter == m.memberRewardFilter,
                                ) {
                                    Text("继续读取下一页")
                                }
                            if (m.identity?.allows("loyalty.configuration.approve") == true) {
                                OutlinedTextField(
                                    reason,
                                    { reason = it },
                                    label = { Text("审批 / 驳回说明（2—300字）") },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Primary(
                                    "批准发券 · ${selected.size}条",
                                    m.canUseMemberRewards &&
                                        filter == m.memberRewardFilter &&
                                        selected.isNotEmpty(),
                                ) {
                                    propose { board.command(selected, true, reason, m.identity!!) }
                                }
                                SecondaryAction(
                                    onClick = {
                                        propose {
                                            board.command(selected, false, reason, m.identity!!)
                                        }
                                    },
                                    enabled =
                                        m.canUseMemberRewards &&
                                            filter == m.memberRewardFilter &&
                                            selected.isNotEmpty(),
                                ) {
                                    Text("驳回所选奖励")
                                }
                            }
                        }
                    } else {
                        OutlinedTextField(
                            code,
                            { code = it },
                            label = { Text("输入完整会员号") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SecondaryAction(
                                onClick = {
                                    scan.launch(
                                        ScanOptions()
                                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                            .setPrompt("扫描顾客小程序中的会员码")
                                            .setBeepEnabled(false)
                                    )
                                },
                                enabled = !m.busy,
                            ) {
                                Text("扫描会员码")
                            }
                            Primary("查询会员", !m.busy) { m.loadMember(code) }
                        }
                        Text(m.memberState, fontSize = 12.sp)
                        val account = m.memberAccount
                        val part = m.memberParticipation
                        val visit = m.memberVisit
                        if (account != null && part != null && visit != null) {
                            Panel {
                                Text(part.textOrNull("displayName") ?: "会员", fontSize = 20.sp)
                                Text(visit.memberNo)
                                Text(
                                    "等级 · " +
                                        (mapOf("member" to "普卡","silver" to "银卡","gold" to "金卡")[account.getString("tier")] ?: "待核对") +
                                        " · " +
                                        if (account.getString("membershipStatus") == "active")
                                            "有效会员"
                                        else "会员状态需核对"
                                )
                                Text(
                                    "可用积分 ${account.getLong("availablePoints")} · 待追回 ${account.getLong("pendingRecoveryPoints")}"
                                )
                                Text(
                                    "资格成长 ${account.getLong("qualificationGrowth")} · 累计成长 ${account.getLong("lifetimeGrowth")}",
                                    fontSize = 12.sp,
                                )
                                account.textOrNull("tierPeriodEndsAt")?.let {
                                    Text("等级周期结束 · " + reservationTime(it), fontSize = 12.sp)
                                }
                            }
                            Panel {
                                Text("到店签到 · " + visit.date)
                                visit.visit?.let { v ->
                                    Text(
                                        if (v.getString("status") == "checked_in") "已签到" else "已撤销"
                                    )
                                    Text(
                                        v.getString("employeeName") +
                                            " · " +
                                            reservationTime(v.getString("checkedInAt")),
                                        fontSize = 12.sp,
                                    )
                                } ?: Text("本营业日尚未签到")
                                val ready =
                                    m.canUseMember &&
                                        runCatching { MemberCommands.code(code) }.getOrNull() ==
                                            visit.memberNo
                                if (visit.visit?.getString("status") == "checked_in") {
                                    OutlinedTextField(
                                        reason,
                                        { reason = it },
                                        label = { Text("撤销原因") },
                                    )
                                    SecondaryAction(
                                        onClick = {
                                            propose { visit.command(true, reason, m.identity!!) }
                                        },
                                        enabled = ready,
                                    ) {
                                        Text("撤销这次签到")
                                    }
                                } else
                                    Primary("确认会员本人已到店", ready) {
                                        propose { visit.command(false, "", m.identity!!) }
                                    }
                                for (p in
                                    visit.source.optJSONArray("rewards")?.objects().orEmpty()) Text(
                                    "${p.getString("name")}：还需${p.getInt("remainingVisits")}次；待审批${p.getInt("pending")}轮 / 已发券${p.getInt("issued")}轮",
                                    fontSize = 12.sp,
                                )
                            }
                            Foldout("当前权益") {
                                for (b in part.getJSONArray("benefits").objects()) {
                                    Text("${b.getString("title")} · ${b.getInt("quantity")}份")
                                    Text(b.getString("guidance"), fontSize = 12.sp)
                                    b.textOrNull("validUntil")?.let {
                                        Text("有效至 " + reservationTime(it), fontSize = 12.sp)
                                    }
                                }
                            }
                            if (part.getBoolean("activitiesVisible"))
                                Foldout("活动与报名") {
                                    for (a in part.getJSONArray("registrations").objects()) {
                                        Text("${a.getString("title")} · ${a.getInt("partySize")}人")
                                        Text(a.getString("guidance"), fontSize = 12.sp)
                                    }
                                    for (a in part.getJSONArray("activities").objects()) {
                                        Text(a.getString("title"))
                                        Text(a.getString("guidance"), fontSize = 12.sp)
                                    }
                                }
                            for ((key, label) in
                                listOf(
                                    "pointEntries" to "最近20条积分流水",
                                    "growthEntries" to "最近20条成长流水",
                                )) Foldout(label) {
                                for (e in account.getJSONArray(key).objects()) {
                                    Text("${e.getLong("delta")} · 余额${e.getLong("balanceAfter")}")
                                    Text(
                                        e.getString("reason") +
                                            " · " +
                                            reservationTime(e.getString("occurredAt")),
                                        fontSize = 12.sp,
                                    )
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
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(command.steps[0].memberProof!!.getString("confirmation"))
                    Row {
                        Checkbox(physical, { physical = it })
                        Text("已核对会员、现场事实及处理范围")
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        selected = emptySet()
                        m.executeLive(command)
                    },
                    enabled = physical && m.canExecuteLive(command),
                ) {
                    Text("确认执行")
                }
            },
            dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回") } },
        )
    }
}

fun memberRewardLabel(value: String) =
    mapOf("pending" to "待审批", "issued" to "已发券", "rejected" to "已驳回", "invalid" to "已失效")[value]
        ?: "待核对"
