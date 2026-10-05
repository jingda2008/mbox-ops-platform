package com.mbox.staff

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable fun ServiceReminderView(m:AppModel) {
    val context=LocalContext.current;val lifecycle=LocalLifecycleOwner.current
    var revision by remember{mutableIntStateOf(0)};var notice by remember{mutableStateOf("")}
    DisposableEffect(lifecycle){val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_RESUME)revision++};lifecycle.lifecycle.addObserver(observer);onDispose{lifecycle.lifecycle.removeObserver(observer)}}
    fun enable(){try{ServiceReminders.enable(context,m.identity?:error("请先登录"));notice="已启用定期检查，实际执行时间由手机系统决定"}catch(e:Exception){notice=e.message?:"无法启用提醒"};revision++}
    val actor=m.identity;val key=actor?.sessionId;val currentKey by rememberUpdatedState(key)
    var requestedKey by remember{mutableStateOf<String?>(null)}
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->if(granted&&requestedKey==currentKey)enable()else notice="未开启通知，可继续使用前台待办";requestedKey=null;revision++}
    LaunchedEffect(key){revision++}
    val enabled=remember(revision,key){ServiceReminders.enabled(context,m.identity)}
    Text("实时通知",style=MaterialTheme.typography.titleMedium)
    Text(m.nativePushStatus)
    TextButton(onClick={m.checkNativePushChannel()},enabled=actor!=null&&!m.busy){Text("检查实时通知通道")}
    if(m.pendingPushRevocations>0)TextButton(onClick={m.flushPushRevocations()}){Text("重试原通知绑定撤销（${m.pendingPushRevocations}）")}
    Text("后台待办检查",style=MaterialTheme.typography.titleMedium)
    Text("约每15分钟检查一次，可能因省电、断网或系统限制延迟。不是实时呼叫推送，营业值班请保持工作台前台。")
    Text("需要记住本机登录；退出、切换员工或取消记住登录后停止。通知不显示顾客、桌号、金额等信息。")
    Text(remember(revision){ServiceReminders.status(context)})
    if(enabled)SecondaryAction(onClick={try{ServiceReminders.disable(context);notice="已停止后台检查"}catch(e:Exception){notice=e.message?:"停止失败"};revision++},enabled=!m.busy){Text("停止后台检查")}
    else SecondaryAction(onClick={requestedKey=key;ServiceReminders.createChannel(context);if(Build.VERSION.SDK_INT>=33&&!ServiceReminders.allowed(context))permission.launch(Manifest.permission.POST_NOTIFICATIONS)else enable()},enabled=actor!=null&&!m.busy&&m.rememberLogin){Text("开启后台检查")}
    TextButton(onClick={try{context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,context.packageName))}catch(_:Exception){notice="无法打开系统设置，请在手机设置中找到 M-BOX 员工"}}){Text("打开系统通知设置")}
    if(notice.isNotBlank())Text(notice)
}
