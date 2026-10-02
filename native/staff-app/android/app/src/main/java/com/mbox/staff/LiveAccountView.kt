package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.Image
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp

@Composable
fun LiveAccountView(m: AppModel) {
    var credential by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    ClearSecretsOnBackground { credential = ""; pin = "" }
    if (m.identity != null) {
        Text("${m.identity!!.displayName} · ${m.identity!!.employeeCode}")
        Text("岗位权限由门店系统提供，切换员工后重新加载。", fontSize = 12.sp)
    } else {
        OutlinedTextField(
            credential,
            { credential = it },
            label = { Text("门店口令") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        SecondaryAction(
            onClick = {
                val value = credential
                credential = ""
                m.grantDevice(value)
            },
            enabled = credential.trim().length >= 6 && !m.busy && m.pending == null,
            icon = Icons.Outlined.VerifiedUser,
        ) {
            Text(if (m.deviceReady) "重新验证设备" else "验证门店设备")
        }
        if (m.deviceReady) Text("设备已验证", color = Ink, fontSize = 12.sp)
    }
    Row {
        Checkbox(m.rememberLogin, { m.changeRememberLogin(it) }, enabled = !m.busy)
        Text("记住本机登录")
    }
    if (m.identity == null)
        SecondaryAction(onClick = { m.restoreRememberedSession(true) }, enabled = !m.busy) {
            Text("恢复已记住的登录")
        }
    OutlinedTextField(
        code,
        { code = it },
        label = { Text("员工账号") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        pin,
        { pin = it },
        label = { Text("4位数字 PIN") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth(),
    )
    Primary(
        if (m.identity == null) "登录门店" else "切换员工",
        code.isNotBlank() &&
            pin.length == 4 &&
            !m.busy &&
            m.pending == null &&
            (m.deviceReady || m.identity != null) &&
            (m.identity == null || (m.livePending == null && m.liveOrderPending == null)),
        icon = Icons.Outlined.LockOpen,
    ) {
        val value = pin
        pin = ""
        m.login(code, value)
    }
    if (m.identity != null)
        SecondaryAction(
            onClick = { m.logout() },
            enabled = !m.busy && (m.livePending == null && m.liveOrderPending == null),
            icon = Icons.Outlined.Logout,
        ) {
            Text("退出员工账号")
        }
    else if (m.live && BuildConfig.ALLOW_LOCAL_DEMO)
        SecondaryAction(
            onClick = { m.train() },
            enabled = !m.busy && (m.livePending == null && m.liveOrderPending == null),
            icon = Icons.Outlined.Undo,
        ) {
            Text("返回本机演练")
        }
    Text("口令与 PIN 不保存。勾选后使用本机安全存储记住登录；重启仍须联网核验身份和权限。共用设备请在交班时退出账号。", fontSize = 12.sp)
}

/** Staff entry is shown before any operational workspace, including after session expiry. */
@Composable
fun StaffLoginScreen(m: AppModel) {
    androidx.compose.foundation.layout.Column(
        Modifier.fillMaxSize()
            .background(Paper)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().background(Ink).padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Image(painterResource(R.drawable.mbox_brand_logo), "M-BOX 上海 1999", Modifier.size(72.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("M-BOX", color = Paper, fontSize = 25.sp, fontWeight = FontWeight.Bold)
                Text("员工登录", color = Gold, fontSize = 15.sp)
            }
        }
        Column(Modifier.padding(horizontal = 18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("登录后查看门店桌台与订单", fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
            Text("使用门店现有员工账号和 PIN；首次使用需验证门店设备。", fontSize = 14.sp)
            if (m.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Panel { LiveAccountView(m) }
            Text("门店服务器：mbox.shmbox.com", fontSize = 12.sp)
            Text("版本 ${BuildConfig.VERSION_NAME}", fontSize = 12.sp)
            Foldout(if (m.updater.release != null) "修复与更新 · 有新版本" else "检查应用更新") { AppUpdateView(m) }
            Spacer(Modifier.height(16.dp))
        }
    }
}
