package com.mbox.staff

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import java.util.concurrent.TimeUnit

object ServiceReminders {
    const val channel="staff-service-reminders"
    private const val work="staff-service-reminders-v1"
    private const val notificationID=1999
    private val lock=Any()
    @Volatile var foreground=false
    private fun prefs(c:Context)=c.getSharedPreferences(work,Context.MODE_PRIVATE)
    fun enabled(c:Context,actor:StaffIdentity?)=actor!=null&&prefs(c).getString("employee",null)==actor.employeeId&&prefs(c).getString("session",null)==actor.sessionId
    fun allowed(c:Context):Boolean {
        val manager=NotificationManagerCompat.from(c)
        return (Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(c,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED) && manager.areNotificationsEnabled() && (c.getSystemService(NotificationManager::class.java).getNotificationChannel(channel)?.importance ?: NotificationManager.IMPORTANCE_DEFAULT)>0
    }
    fun createChannel(c:Context) { c.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(channel,"服务待办检查",NotificationManager.IMPORTANCE_DEFAULT).apply { description="后台定期检查服务待办，可能延迟；紧急事项请使用前台工作台";lockscreenVisibility=android.app.Notification.VISIBILITY_SECRET }) }
    fun enable(c:Context,actor:StaffIdentity) = synchronized(lock) {
        createChannel(c);require(allowed(c)){"请先允许系统通知"}
        require(listOf("service.view","service.execute","service.manage","complaint.handle").any(actor::allows)){"当前员工没有服务查看权限"}
        require(reminderSessionMatches(KeystoreStaffSessionStore(c).read(),actor.employeeId,actor.sessionId)){"请先在员工账号中开启并成功保存“记住本机登录”"}
        check(prefs(c).edit().clear().putString("employee",actor.employeeId).putString("session",actor.sessionId).putString("status","等待系统首次检查").commit()){"提醒设置保存失败"}
        val request=PeriodicWorkRequestBuilder<ServiceReminderWorker>(15,TimeUnit.MINUTES).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(work,ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE,request)
    }
    fun disable(c:Context) = synchronized(lock) {
        check(prefs(c).edit().clear().commit()) { "提醒设置未清除，请重试" }
        WorkManager.getInstance(c).cancelUniqueWork(work)
        clearNotice(c)
    }
    fun clearNotice(c:Context) { NotificationManagerCompat.from(c).cancel(notificationID) }
    fun status(c:Context)=prefs(c).getString("status",null) ?: "未启用后台待办检查"
    fun owner(c:Context):Pair<String,String>?=synchronized(lock){val p=prefs(c);val e=p.getString("employee",null);val s=p.getString("session",null);if(e==null||s==null)null else e to s}
    fun record(c:Context,owner:Pair<String,String>,status:String,snapshot:ReminderSnapshot?=null) = synchronized(lock) {
        if(owner(c)!=owner)return@synchronized
        val saved=runCatching{KeystoreStaffSessionStore(c).read()}
        if(saved.isFailure){prefs(c).edit().putString("status","安全登录暂不可读取，请解锁手机后检查").apply();return@synchronized}
        if(!reminderSessionMatches(saved.getOrNull(),owner.first,owner.second)) { disable(c);return@synchronized }
        val p=prefs(c)
        if(snapshot!=null && snapshot.count>0 && !foreground && allowed(c) && p.getString("fingerprint",null)!=snapshot.fingerprint) {
            val issuedAt = java.time.Instant.now()
            val taskId = snapshot.firstTaskId ?: return@synchronized
            val tableSessionId = snapshot.firstTableSessionId ?: return@synchronized
            val target = NotificationTaskTarget(
                java.util.UUID.randomUUID().toString(), owner.first, owner.second,
                taskId, tableSessionId, issuedAt, issuedAt.plusSeconds(30 * 60),
            )
            val intent = NotificationIntents.create(c, target)
            val pending=PendingIntent.getActivity(c,notificationID,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notice=NotificationCompat.Builder(c,channel).setSmallIcon(R.drawable.ic_service_notification).setContentTitle("M-BOX 服务待办")
                .setContentText("有待处理事项，请打开工作台核对最新状态")
                .setVisibility(NotificationCompat.VISIBILITY_SECRET).setContentIntent(pending).setAutoCancel(true).setTimeoutAfter(TimeUnit.MINUTES.toMillis(30)).build()
            // Recheck immediately before posting; a permission revoked by Settings is harmless.
            try { NotificationManagerCompat.from(c).notify(notificationID,notice) } catch (_:SecurityException) { return@synchronized }
        }
        if(snapshot?.count==0)clearNotice(c)
        val editor=p.edit().putString("status",status)
        if(snapshot!=null)editor.putString("fingerprint",snapshot.fingerprint)
        editor.apply()
    }
    fun stopOwner(c:Context,owner:Pair<String,String>) = synchronized(lock) { if(owner(c)==owner)disable(c) }
}
class ServiceReminderWorker(context:Context,parameters:WorkerParameters):Worker(context,parameters) {
    override fun doWork():Result {
        val c=applicationContext;val owner=ServiceReminders.owner(c) ?: return Result.success()
        if(ServiceReminders.foreground)return Result.success()
        if(!ServiceReminders.allowed(c)){ServiceReminders.record(c,owner,"系统通知已关闭，请回到 App 检查设置");return Result.success()}
        return try {
            val saved=KeystoreStaffSessionStore(c).read()
            if(!reminderSessionMatches(saved,owner.first,owner.second)){ServiceReminders.stopOwner(c,owner);return Result.success()}
            val api=StaffAPI(ReadOnlySessionSnapshot(saved!!));val snapshot=readServiceReminder(api,owner.first,owner.second)
            if(isStopped)return Result.success()
            ServiceReminders.record(c,owner,"最近成功检查：${java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))}",snapshot)
            Result.success()
        } catch(e:Exception) {
            if((e as? StaffAPIError)?.status in listOf(401,403) || e is IllegalArgumentException) {
                ServiceReminders.stopOwner(c,owner);Result.success()
            } else {
                ServiceReminders.record(c,owner,"后台检查未成功，请打开工作台刷新")
                if(runAttemptCount<2)Result.retry() else Result.success()
            }
        }
    }
}
