package com.mbox.staff

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier

/** Recognition fills a reviewed draft only; it never executes an operational command. */
@Composable
fun VoiceInputButton(contextKey: String, enabled: Boolean = true, accept: (String) -> Unit) {
    var candidate by remember(contextKey) { mutableStateOf<String?>(null) }
    var notice by remember(contextKey) { mutableStateOf("") }
    var launchedFor by remember { mutableStateOf<String?>(null) }
    val currentKey by rememberUpdatedState(contextKey)
    val currentEnabled by rememberUpdatedState(enabled)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val original = launchedFor
        launchedFor = null
        if (original == currentKey && currentEnabled && result.resultCode == Activity.RESULT_OK) {
            candidate = speechCandidate(result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS).orEmpty())
            if (candidate == null) notice = "没有识别到有效文字，请重试或手动输入"
        }
    }
    SecondaryAction(onClick = {
        launchedFor = contextKey
        try {
            launcher.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                putExtra(RecognizerIntent.EXTRA_PROMPT, "说完后核对文字，不会自动提交")
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            })
        } catch (_: ActivityNotFoundException) {
            launchedFor = null
            notice = "本机没有可用的语音识别服务，请使用键盘输入"
        } catch (_: SecurityException) {
            launchedFor = null
            notice = "系统未允许语音识别，请使用键盘输入或检查系统语音权限"
        }
    }, enabled = enabled && launchedFor == null, icon = Icons.Outlined.Mic) { Text("语音转文字") }
    if (notice.isNotEmpty()) Text(notice)
    candidate?.let { text ->
        AlertDialog(onDismissRequest = { candidate = null }, title = { Text("核对识别文字") },
            text = { Column { Text("可先修改，再填入当前记录；不会自动提交业务。")
                OutlinedTextField(text, { if (it.length <= 2000) candidate = it }, Modifier.fillMaxWidth()) } },
            confirmButton = { TextButton(enabled = enabled && text.trim().isNotEmpty(), onClick = {
                candidate = null
                accept(text.trim())
            }) { Text("填入记录") } },
            dismissButton = { TextButton(onClick = { candidate = null }) { Text("取消") } })
    }
}
