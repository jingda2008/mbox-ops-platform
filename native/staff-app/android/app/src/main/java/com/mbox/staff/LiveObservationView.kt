package com.mbox.staff

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
import org.json.JSONObject

@Composable
private fun ObservationSelect(
    label: String,
    value: String,
    options: Map<String, String>,
    empty: String = "请选择",
    change: (String) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { menu = true }) { Text(label + " · " + (options[value] ?: empty)) }
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem(
                text = { Text(empty) },
                onClick = {
                    change("")
                    menu = false
                },
            )
            for ((id, text) in options) DropdownMenuItem(
                text = { Text(text) },
                onClick = {
                    change(id)
                    menu = false
                },
            )
        }
    }
}

@Composable
fun LiveObservationView(m: AppModel, session: String, tableCode: String, close: () -> Unit) {
    var recommendation by remember {
        mutableStateOf(m.identity?.allows("observation.record") != true)
    }
    var raw by remember { mutableStateOf("") }
    var inputKind by remember { mutableStateOf("text") }
    var immediate by remember { mutableStateOf(false) }
    var candidate by remember { mutableStateOf("") }
    var expression by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("") }
    var degree by remember { mutableStateOf("") }
    var excerpt by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    var target by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var correctionReason by remember { mutableStateOf("") }
    var correctionPublicId by remember { mutableStateOf("") }
    var correction by remember { mutableStateOf<JSONObject?>(null) }
    var proposed by remember { mutableStateOf<LiveCommand?>(null) }
    var physical by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val version = remember { m.workspaceVersion }
    LaunchedEffect(m.workspaceVersion) { if (version != m.workspaceVersion) close() }
    LaunchedEffect(session) { m.loadObservation(session) }
    LaunchedEffect(m.observationBoard?.draft?.optString("publicId")) {
        candidate = ""
        expression = ""
        type = ""
        degree = ""
        excerpt = (m.observationBoard?.draft?.getString("rawContent") ?: "").take(1000)
    }
    fun propose(work: () -> LiveCommand) {
        try {
            proposed = work()
            physical = false
            error = ""
        } catch (e: Exception) {
            error = e.message ?: "请核对原记录"
        }
    }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(16.dp)) {
                Row {
                    Text("$tableCode · 现场服务", Modifier.weight(1f), fontSize = 20.sp)
                    TextButton(onClick = close) { Text("关闭") }
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    LivePendingView(m)
                    Text(m.observationState, fontSize = 12.sp)
                    SecondaryAction(onClick = { m.loadObservation(session) }, enabled = !m.busy) {
                        Text("刷新本桌记录")
                    }
                    if (
                        m.identity?.allows("observation.record") == true &&
                            m.identity?.allows("recommendation.staff.modify") == true
                    )
                        Row {
                            FilterChip(
                                !recommendation,
                                { recommendation = false },
                                label = { Text("桌台观察") },
                            )
                            FilterChip(
                                recommendation,
                                { recommendation = true },
                                label = { Text("推荐调整") },
                            )
                        }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    if (recommendation) {
                        m.recommendationBoard
                            ?.takeIf { it.session == session }
                            ?.let { board ->
                                val snapshot = board.snapshot
                                if (snapshot == null) Text("本桌暂无可调整的推荐快照")
                                else
                                    Panel {
                                        Text(
                                            "本桌推荐 · " +
                                                reservationTime(snapshot.getString("createdAt"))
                                        )
                                        Text("仅记录推荐调整，不修改订单、价格或收款。", fontSize = 12.sp)
                                        val options =
                                            snapshot.getJSONArray("options").objects().associate {
                                                it.getString("productId") to
                                                    (it.getString("productName") +
                                                        " · ¥" +
                                                        "%.2f"
                                                            .format(
                                                                java.util.Locale.ROOT,
                                                                it.getLong("amountMinor") / 100.0,
                                                            ))
                                            }
                                        ObservationSelect("原推荐", source, options) { source = it }
                                        ObservationSelect("调整为", target, options) { target = it }
                                        ObservationSelect("调整原因", reason, recommendationReasons) {
                                            reason = it
                                        }
                                        Primary("核对推荐调整", enabled = m.canUseObservation) {
                                            propose {
                                                board.command(source, target, reason, m.identity!!)
                                            }
                                        }
                                    }
                            }
                    } else {
                        m.observationBoard
                            ?.takeIf { it.session == session }
                            ?.let { board ->
                                val draft = board.draft
                                if (draft != null && correction == null)
                                    Panel {
                                        Text("待确认观察")
                                        Text(draft.getString("rawContent"))
                                        draft.textOrNull("clarificationPrompt")?.let {
                                            Text(it, fontSize = 12.sp)
                                        }
                                        if (draft.getBoolean("needsImmediateAction"))
                                            Text("确认后生成现场服务任务", fontSize = 12.sp)
                                        val options =
                                            draft.getJSONArray("candidates").objects().associate {
                                                it.getString("id") to
                                                    (it.getString("productName") +
                                                        " · " +
                                                        it.getString("rawMention"))
                                            }
                                        ObservationSelect(
                                            "关联本桌真实订单商品",
                                            candidate,
                                            options,
                                            "不关联具体商品",
                                        ) {
                                            candidate = it
                                        }
                                        ObservationSelect(
                                            "表达性质",
                                            expression,
                                            observationExpressions,
                                        ) {
                                            expression = it
                                        }
                                        ObservationSelect("观察类型", type, observationTypes) {
                                            type = it
                                        }
                                        ObservationSelect(
                                            "程度",
                                            degree,
                                            observationDegrees,
                                            "不适用 / 未记录",
                                        ) {
                                            degree = it
                                        }
                                        OutlinedTextField(
                                            excerpt,
                                            { excerpt = it },
                                            label = { Text("原文片段（最多1000字）") },
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        Primary(
                                            "核对并确认观察",
                                            enabled =
                                                m.canUseObservation &&
                                                    m.identity?.allows("observation.confirm") ==
                                                        true,
                                        ) {
                                            propose {
                                                board.confirm(
                                                    candidate,
                                                    expression,
                                                    type,
                                                    degree,
                                                    excerpt,
                                                    m.identity!!,
                                                )
                                            }
                                        }
                                    }
                                if (draft == null)
                                    Foldout("记录新观察") {
                                        VoiceInputButton("${m.workspaceVersion}:$session", enabled = m.canUseObservation) {
                                            raw = it
                                            inputKind = "voice_transcript"
                                        }
                                        OutlinedTextField(
                                            raw,
                                            { raw = it },
                                            label = { Text("现场事实、客人原话或员工判断") },
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        Row {
                                            Checkbox(immediate, { immediate = it })
                                            Text("需要立即跟进")
                                        }
                                        Text("仅按本桌真实订单识别商品，识别后仍需员工确认。", fontSize = 12.sp)
                                        Primary("识别并核对", enabled = m.canUseObservation) {
                                            propose { board.parse(raw, immediate, m.identity!!, inputKind) }
                                        }
                                    }
                                correction?.let { old ->
                                    Panel {
                                        Text("修订观察 · 第${old.getInt("revision")}版")
                                        Text(old.textOrNull("rawExcerpt") ?: "")
                                        ObservationSelect(
                                            "表达性质",
                                            expression,
                                            observationExpressions,
                                        ) {
                                            expression = it
                                        }
                                        ObservationSelect("观察类型", type, observationTypes) {
                                            type = it
                                        }
                                        ObservationSelect(
                                            "程度",
                                            degree,
                                            observationDegrees,
                                            "不适用 / 未记录",
                                        ) {
                                            degree = it
                                        }
                                        OutlinedTextField(
                                            correctionReason,
                                            { correctionReason = it },
                                            label = { Text("修订原因（2—500字）") },
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        Primary("核对修订", enabled = m.canUseObservation) {
                                            propose {
                                                board.revise(
                                                    correctionPublicId,
                                                    old.getString("id"),
                                                    expression,
                                                    type,
                                                    degree,
                                                    correctionReason,
                                                    m.identity!!,
                                                )
                                            }
                                        }
                                        TextButton(
                                            onClick = {
                                                correction = null
                                                expression = ""
                                                type = ""
                                                degree = ""
                                            }
                                        ) {
                                            Text("取消修订")
                                        }
                                    }
                                }
                                Text("最近5条已确认观察")
                                if (board.items.isEmpty()) Text("本次开台暂无已确认观察")
                                for (row in board.items) Panel {
                                    Text(
                                        reservationTime(row.getString("confirmedAt")) +
                                            " · " +
                                            row.getString("confirmedBy"),
                                        fontSize = 12.sp,
                                    )
                                    Text(row.textOrNull("rawContent") ?: "原文受岗位权限保护")
                                    for (e in row.getJSONArray("events").objects()) {
                                        Text(
                                            (observationExpressions[e.getString("expressionKind")]
                                                ?: "待核对") +
                                                " · " +
                                                (observationTypes[e.getString("eventType")]
                                                    ?: "待核对")
                                        )
                                        Text(
                                            (e.textOrNull("productName") ?: "桌台情况") +
                                                " · 第${e.getInt("revision")}版",
                                            fontSize = 12.sp,
                                        )
                                        e.textOrNull("degree")?.let {
                                            Text(observationDegrees[it] ?: "待核对", fontSize = 12.sp)
                                        }
                                        if (
                                            board.history
                                                .getJSONObject("permissions")
                                                .getBoolean("canCorrect") &&
                                                board.history
                                                    .getJSONObject("permissions")
                                                    .getBoolean("canViewRaw")
                                        )
                                            TextButton(
                                                onClick = {
                                                    correctionPublicId = row.getString("publicId")
                                                    correction = e
                                                    expression = e.getString("expressionKind")
                                                    type = e.getString("eventType")
                                                    degree = e.textOrNull("degree") ?: ""
                                                    correctionReason = ""
                                                },
                                                enabled = m.canUseObservation,
                                            ) {
                                                Text("修订此条")
                                            }
                                    }
                                    if (row.textOrNull("serviceTaskId") != null)
                                        Text(
                                            "现场任务：" +
                                                (mapOf(
                                                    "requested" to "待接单",
                                                    "acknowledged" to "已接单",
                                                    "in_progress" to "处理中",
                                                    "completed" to "已完成",
                                                    "cancelled" to "已取消",
                                                )[row.textOrNull("serviceTaskStatus")] ?: "待核对") +
                                                " · 在服务任务中心处理",
                                            fontSize = 12.sp,
                                        )
                                    for (revision in row.getJSONArray("revisions").objects()) Text(
                                        "修订：" +
                                            revision.getString("reason") +
                                            " · " +
                                            revision.getString("correctedBy"),
                                        fontSize = 12.sp,
                                    )
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
                    Text("$tableCode · 本次开台")
                    Text(command.steps[0].observationProof!!.getString("confirmation"))
                    Row {
                        Checkbox(physical, { physical = it })
                        Text("已核对本桌、原文与现场事实")
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        proposed = null
                        correction = null
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
