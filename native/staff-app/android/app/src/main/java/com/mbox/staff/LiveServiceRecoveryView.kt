package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable fun LiveServiceRecoveryView(m: AppModel, command: LiveCommand, close: () -> Unit) {
    var code by remember { mutableStateOf("") }; var pin by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }; var confirmed by remember { mutableStateOf(false) }
    val lifecycle=LocalLifecycleOwner.current
    DisposableEffect(lifecycle) {
        val observer=LifecycleEventObserver { _, event -> if(event==Lifecycle.Event.ON_STOP){ code="";pin="";reason="";confirmed=false;close() } }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(m.livePending) { if(m.livePending != command) close() }
    Dialog(onDismissRequest={if(!m.busy)close()},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize(),color=Paper) {
            Column(Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                Row { Text("主管核对原服务请求",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close,enabled=!m.busy){Text("关闭")} }
                Panel { Text(command.title,style=MaterialTheme.typography.titleMedium);Text("原员工编号：${command.employeeID}",style=MaterialTheme.typography.bodySmall);Text("原请求：${command.steps.single().key}",style=MaterialTheme.typography.bodySmall) }
                Text("服务器已有回执时只核对结果；原请求尚未提交时将永久封存该请求，防止旧设备重试。任务本身仍需刷新后处理。")
                Text("此入口仅处理这一项服务请求。主管使用自己的账号与 PIN，不接管原员工登录。",style=MaterialTheme.typography.bodySmall)
                OutlinedTextField(code,{code=it},label={Text("主管员工账号")},singleLine=true,enabled=!m.busy,isError=code.length>64,modifier=Modifier.fillMaxWidth())
                OutlinedTextField(pin,{pin=it},label={Text("主管4位数字 PIN")},singleLine=true,enabled=!m.busy,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.NumberPassword),modifier=Modifier.fillMaxWidth())
                OutlinedTextField(reason,{reason=it},label={Text("核对依据（至少4个字）")},minLines=3,enabled=!m.busy,isError=reason.length>1000,modifier=Modifier.fillMaxWidth())
                Row { Checkbox(confirmed,{confirmed=it},enabled=!m.busy);Text("已核对现场情况，同意核对原回执或封存尚未执行的原请求",Modifier.weight(1f)) }
                PrimaryAction(onClick={ val enteredPin=pin;pin="";m.resolveServicePending(code,enteredPin,reason) },enabled=!m.busy&&code.trim().length in 1..64&&Regex("[0-9]{4}").matches(pin)&&reason.trim().length in 4..1000&&confirmed) { Text(if(m.busy)"正在核对原请求…"else "登录主管并核对") }
                m.message?.let { Text(it,color=MaterialTheme.colorScheme.primary) }
            }
        }
    }
}
