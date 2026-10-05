package com.mbox.staff

import android.app.Application
import android.util.AtomicFile
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.*
import java.net.*
import kotlinx.coroutines.*
import org.json.JSONObject

data class Saved(val world: World, val pending: Command?) : Serializable

class AppModel @JvmOverloads constructor(
    app: Application,
    notificationStoreOverride: NotificationStateStore? = null,
    apiOverride: StaffAPI? = null,
    pushStateStoreOverride: NotificationStateStore? = null,
    receptionSecretsOverride: ReservationReceptionSecretStore? = null,
) : AndroidViewModel(app) {
    private val receptionSecrets by lazy { receptionSecretsOverride ?: KeystoreReservationReceptionSecrets(app) }
    private val notificationPersistence by lazy {
        NotificationRecoveryPersistence(notificationStoreOverride ?: KeystoreNotificationStateStore(app))
    }
    private var notificationRecovery: NotificationTaskRecovery? = null
    private var unsavedNotificationChange: NotificationTaskTransition? = null
    private var notificationIntentVersion = 0L
    private var notificationForegroundVersion = 0L
    var notificationOpenStatus by mutableStateOf("")
        private set
    var hasPendingNotification by mutableStateOf(false)
        private set
    var notificationOpenTarget by mutableStateOf<ServiceAttention.Entry?>(null)
        private set
    var nativePushStatus by mutableStateOf("实时通知尚未启用；后台定期检查可单独开启")
        private set
    private val pushLifecycle by lazy {
        NativePushLifecycle(pushStateStoreOverride ?: KeystoreNotificationStateStore(app, NotificationStorePurpose.REGISTRATION))
    }
    private var pushRevocationBusy = false
    private var nextPushRevocationAttempt = 0L
    var pendingPushRevocations by mutableStateOf(0)
        private set

    private fun synchronizePushOwner() {
        try {
            val owner = identity?.takeIf { it.canReadService() }?.let(NativePushOwner::from)
            pushLifecycle.reconcileOwner(owner)
            pendingPushRevocations = pushLifecycle.pendingRevocationCount
            if (owner == null) runCatching { ServiceReminders.disable(getApplication()) }
        } catch (_: Exception) {
            nativePushStatus = "实时通知保持关闭；安全记录暂不可读取或保存，原记录已保留"
        }
    }

    private fun disableNativePush() {
        try {
            pushLifecycle.disable()
            pendingPushRevocations = pushLifecycle.pendingRevocationCount
        } catch (_: Exception) {
            nativePushStatus = "实时通知已在本机停用；原撤销记录仍需联网核对"
        }
        runCatching { ServiceReminders.clearNotice(getApplication()) }
    }

    /** Also called after returning from system notification settings. No SDK is enabled in v1. */
    fun resumeNativePushRecovery() {
        if (!ServiceReminders.allowed(getApplication())) disableNativePush()
        flushPushRevocations()
    }

    fun flushPushRevocations() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (pushRevocationBusy || now < nextPushRevocationAttempt) return
        val state = try { pushLifecycle.also { pendingPushRevocations = it.pendingRevocationCount } }
        catch (_: Exception) {
            nativePushStatus = "实时通知保持关闭；安全记录暂不可读取，原记录已保留"
            return
        }
        if (state.pendingRevocationCount == 0) return
        pushRevocationBusy = true
        nextPushRevocationAttempt = now + 60_000
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    // This worker can outlive logout or run during a new employee's operation.
                    // Never race the foreground cookie jar; only the original revoke capability
                    // is sent by a fresh anonymous client. No old authentication is persisted.
                    NativePushRevocationRecovery(state, NativePushClient(api)).run { null }
                }
                pendingPushRevocations = result.remaining
                if (result.rateLimited) {
                    val current = android.os.SystemClock.elapsedRealtime()
                    val seconds = maxOf(60L, result.retryAfterSeconds ?: 900L)
                    nextPushRevocationAttempt = current + minOf(seconds, (Long.MAX_VALUE - current) / 1000) * 1000
                }
                nativePushStatus = if (result.remaining > 0)
                    "实时通知保持关闭；有 ${result.remaining} 条原绑定撤销记录待联网核对"
                else "实时通知保持关闭；原绑定撤销请求已受理，已在途的系统通知仍需打开时核对"
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                nativePushStatus = "实时通知保持关闭；原撤销请求已保留，可稍后重试"
            } finally {
                pushRevocationBusy = false
            }
        }
    }

    fun checkNativePushChannel() {
        if (!live || identity == null || busy || heartbeatBusy) return
        busy = true
        val expected = workspaceReadIdentity()
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                val current = workspaceReadIdentity()
                val owner = NativePushOwner.from(identity!!)
                val capabilities = readCurrentWorkspace(current, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { NativePushClient(api).capabilities(owner) }
                }
                check(!capabilities.androidAvailable)
                nativePushStatus = "安卓实时通知通道尚未接入，当前不会注册推送；下方定期检查可继续使用"
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (expected.employee == identity?.employeeId && expected.session == identity?.sessionId) {
                    nativePushStatus = if ((e as? StaffAPIError)?.status == 404)
                        "服务器暂未提供实时通知能力，当前保持关闭"
                    else "实时通知能力暂未核实，当前保持关闭，可稍后重试"
                    if ((e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                }
            } finally {
                busy = false
            }
        }
    }

    private fun notificationIdentity() = identity?.let {
        NotificationTaskIdentity(it.employeeId, it.sessionId, priorityAccessKey, it.canReadService())
    }

    private fun notificationState(): NotificationTaskRecovery = unsavedNotificationChange?.recovery ?: notificationRecovery
        ?: notificationPersistence.read().also {
            notificationRecovery = it
            hasPendingNotification = it.pending != null
        }

    private fun saveNotificationTransition(change: NotificationTaskTransition) {
        // Retain the latest click/dismissal in memory if disk is temporarily unavailable.
        // Never resume an older saved intention while a newer one is awaiting persistence.
        unsavedNotificationChange = change
        notificationPersistence.write(change.recovery)
        notificationRecovery = change.recovery
        unsavedNotificationChange = null
        hasPendingNotification = change.recovery.pending != null
        notificationOpenStatus = when (val decision = change.decision) {
            NotificationTaskDecision.Idle, NotificationTaskDecision.Opened -> ""
            NotificationTaskDecision.LoginRequired -> "请先恢复原员工登录，再核对提醒对应的任务"
            is NotificationTaskDecision.RefreshRequired -> "正在核对提醒对应的原任务"
            is NotificationTaskDecision.AwaitingVerification -> decision.reason.message
            is NotificationTaskDecision.Rejected -> decision.reason.message
            NotificationTaskDecision.Duplicate -> "这条提醒已打开或正在核对，请查看服务任务"
            is NotificationTaskDecision.Focus -> "原任务已核实，正在打开"
        }
    }

    fun receiveNotificationTarget(target: NotificationTaskTarget): Boolean = try {
        notificationIntentVersion++
        val transition = notificationState().offer(target, notificationIdentity(), java.time.Instant.now())
        notificationOpenTarget = null
        saveNotificationTransition(transition)
        if (transition.decision !is NotificationTaskDecision.Rejected) resumeNotificationOpen()
        true
    } catch (_: Exception) {
        notificationOpenStatus = "提醒记录暂不可保存，原记录已保留；请解锁后重试或从服务任务列表核对"
        message = notificationOpenStatus
        false
    }

    fun resumeNotificationOpen() {
        if (!foreground || !live || busy || heartbeatBusy || notificationOpenTarget != null) return
        try {
            unsavedNotificationChange?.let(::saveNotificationTransition)
            val retry = notificationState().retry(notificationIdentity(), java.time.Instant.now())
            if (retry.decision == NotificationTaskDecision.Idle) return
            saveNotificationTransition(retry)
            if (retry.decision !is NotificationTaskDecision.RefreshRequired) return
        } catch (_: Exception) {
            notificationOpenStatus = "提醒安全记录暂不可读取，原记录已保留，请解锁后重试"
            return
        }
        busy = true
        val original = workspaceReadIdentity()
        val intendedVersion = notificationIntentVersion
        val foregroundVersion = notificationForegroundVersion
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                if (!foreground || foregroundVersion != notificationForegroundVersion) return@launch
                // A heartbeat may remove access. Recheck before reading and before focus.
                val retry = notificationState().retry(notificationIdentity(), java.time.Instant.now())
                saveNotificationTransition(retry)
                if (retry.decision !is NotificationTaskDecision.RefreshRequired) return@launch
                val expected = workspaceReadIdentity()
                val reader = notificationIdentity()!!
                val started = java.time.Instant.now()
                val board = readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { LiveServiceBoard(api.data("/api/native-service-center")) }
                }
                require(board.employee == reader.employeeId) { "服务任务员工身份不一致" }
                val finished = java.time.Instant.now()
                if (!foreground || foregroundVersion != notificationForegroundVersion) {
                    saveNotificationTransition(notificationState().defer(notificationIdentity(), finished))
                    return@launch
                }
                val snapshot = AuthorizedNotificationTaskSnapshot(reader, started, finished,
                    board.tasks.map { NotificationTaskFact(it.id, it.session, it.status, true) }, complete = true)
                val resolved = notificationState().resolve(notificationIdentity(), snapshot, finished)
                saveNotificationTransition(resolved)
                val focus = resolved.decision as? NotificationTaskDecision.Focus ?: return@launch
                val task = board.tasks.single { it.id == focus.target.taskId && it.session == focus.target.tableSessionId }
                serviceBoard = board
                serviceUpdated = finished
                serviceState = "已核对提醒对应的原任务；查看提醒不会完成任务"
                notificationOpenTarget = ServiceAttention.Entry(task.id, task.session, task.table, task.priority)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (original.employee == identity?.employeeId && original.session == identity?.sessionId && original.workspace == workspaceVersion) {
                    if ((e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                    runCatching {
                        saveNotificationTransition(notificationState().defer(notificationIdentity(), java.time.Instant.now()))
                    }.onFailure { notificationOpenStatus = "提醒状态暂不可保存，原记录已保留，请解锁后重试" }
                }
            } finally {
                busy = false
                // Only a superseding click/foreground transition earns an automatic follow-up.
                // Ordinary network failures remain pending without a tight retry loop.
                if (foreground && (intendedVersion != notificationIntentVersion || foregroundVersion != notificationForegroundVersion)) {
                    resumeNotificationOpen()
                }
            }
        }
    }

    fun suspendNotificationOpen() {
        notificationForegroundVersion++
        notificationOpenTarget = null
        if (notificationRecovery != null || unsavedNotificationChange != null) runCatching {
            saveNotificationTransition(notificationState().defer(notificationIdentity(), java.time.Instant.now()))
        }.onFailure { notificationOpenStatus = "原提醒已保留，返回工作台后重新核对" }
    }

    fun consumeNotificationNavigation(open: (ServiceAttention.Entry) -> Unit) {
        if (!foreground || busy || heartbeatBusy) return
        val target = notificationOpenTarget ?: return
        var opened = false
        try {
            val transition = notificationState().acknowledgeOpened(notificationIdentity(), java.time.Instant.now())
            if (transition.decision == NotificationTaskDecision.Opened) {
                open(target)
                opened = true
            }
            saveNotificationTransition(transition)
        } catch (_: Exception) {
            if (!opened) runCatching {
                saveNotificationTransition(notificationState().defer(notificationIdentity(), java.time.Instant.now()))
            }
            notificationOpenStatus = if (opened) "已打开原任务，但提醒记录保存失败；原引用仍保留待核对"
                else "原任务暂未打开，原提醒已保留，请重新核对"
        } finally {
            notificationOpenTarget = null
        }
    }

    fun dismissNotificationOpen() {
        notificationIntentVersion++
        notificationOpenTarget = null
        try {
            val state = notificationState()
            saveNotificationTransition(NotificationTaskTransition(
                NotificationTaskRecovery.restore(null, state.consumed, state.policy), NotificationTaskDecision.Idle))
            notificationOpenTarget = null
        } catch (_: Exception) {
            notificationOpenStatus = "提醒记录暂不可清除，请解锁后重试"
        }
    }

    val updater = AndroidUpdater(app)
    var world by mutableStateOf(World(emptyList(), emptyList()))
        private set

    var pending by mutableStateOf<Command?>(null)
        private set

    var busy by mutableStateOf(false)
        private set

    var message by mutableStateOf("")
    var live by mutableStateOf(true)
        private set

    var simulateTimeout by mutableStateOf(false)
    var staffName by mutableStateOf("未登录")
        private set

    private var receptionAuthorityEpoch = 0L
    private fun receptionAuthority(actor: StaffIdentity?) = actor?.let {
        listOf(it.employeeId, it.sessionId, it.permissions.sorted(), it.denied.sorted(), it.roles.sorted(), it.navigationRoutes?.sorted())
    }
    private var currentIdentity by mutableStateOf<StaffIdentity?>(null)
    var identity: StaffIdentity?
        get() = currentIdentity
        private set(value) {
            val changed = receptionAuthority(currentIdentity) != receptionAuthority(value)
            currentIdentity = value
            if (changed) {
                receptionAuthorityEpoch++
                invalidateReceptionRead()
                receptionState = "身份或权限已变化，请重新读取预约"
            }
            synchronizePushOwner()
        }

    var deviceReady by mutableStateOf(false)
        private set

    var connection by mutableStateOf("请登录门店")
        private set

    var overview by mutableStateOf<JSONObject?>(null)
    var overviewState by mutableStateOf("请读取经营概览")
    var overviewPeriod by mutableStateOf("day")
    var overviewAnchor by mutableStateOf("")

    fun loadOverview(period: String = "day", anchor: String = "") {
        if (!live || busy || heartbeatBusy) return
        busy = true
        overview = null
        overviewState = "正在读取经营概览"
        viewModelScope.launch {
            try {
                val path = overviewPath(period, anchor)
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                val actor = identity ?: error("请登录")
                require(actor.allows("commercial.profit.view")) { "当前岗位没有经营利润查看权限" }
                val report = withContext(Dispatchers.IO) { api.data(path) }
                validateOverview(report, period)
                check(identity?.employeeId == actor.employeeId) { "员工已变更" }
                overview = report
                overviewPeriod = period
                overviewAnchor = anchor
                overviewState = "已读取服务器账本；仅代表系统已记录部分，未知成本不可视为0。"
            } catch (e: Exception) {
                overviewState = e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    suspend fun readBusinessReport(kind: String, filters: Map<String,String>): JSONObject {
        require(live && !busy && !heartbeatBusy) { "请等待当前操作完成" }
        val original = identity?.employeeId ?: error("请先登录")
        val version = workspaceVersion
        busy = true
        try {
            val path = BusinessReports.path(kind, filters)
            identity = withContext(Dispatchers.IO) { api.heartbeat() }
            val access = priorityAccessKey
            require(identity?.employeeId == original && BusinessReports.allowed(identity,kind)) { "当前岗位无此分析权限" }
            val rawAllowed = kind == "experience" && identity?.allows("observation.view.raw") == true
            val result = withContext(Dispatchers.IO) {
                val raw = JSONObject(api.raw(path).text)
                if(kind == "sales") JSONObject().put("rows",raw.getJSONArray("data"))
                else {
                    val result = raw.getJSONObject("data")
                    val evidence = if(rawAllowed) JSONObject(api.raw(path.replace("analytics?","analytics/observations?") + "&limit=50").text).getJSONArray("data") else org.json.JSONArray()
                    result.put("evidence",evidence)
                }
            }
            BusinessReports.validate(kind,result)
            require(version == workspaceVersion && access == priorityAccessKey) { "账号或权限已变化，请重新查询" }
            return result
        } catch(e: kotlinx.coroutines.CancellationException) { throw e }
        catch(e: Exception) { handleLiveError(e); throw e }
        finally { busy = false }
    }

    suspend fun queryMediaAssets(purpose:String,cursor:String):JSONObject{
        require(purpose in setOf("support_contact","menu","community_activity","home_content","performer"));val access=priorityAccessKey;val version=workspaceVersion;require(identity!=null)
        val root=withContext(Dispatchers.IO){JSONObject(api.raw("/api/staff/media-assets?limit=12&purpose="+LiveCommand.part(purpose)+(if(cursor.isBlank())"" else "&before="+LiveCommand.part(cursor))).text)}
        require(access==priorityAccessKey&&version==workspaceVersion);return root
    }
    suspend fun queryMediaThumbnail(id:String):ByteArray{val access=priorityAccessKey;val version=workspaceVersion;val bytes=withContext(Dispatchers.IO){api.mediaThumbnail(id)};require(access==priorityAccessKey&&version==workspaceVersion);return bytes}
    suspend fun uploadMediaAsset(purpose:String,bytes:ByteArray,mime:String):JSONObject{
        require(!busy&&!heartbeatBusy&&memberReady);require(bytes.size in 1..204800);require(purpose in setOf("support_contact","menu","community_activity","home_content","performer"));val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;busy=true
        try{val sha=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)};val key="native-media-"+java.util.UUID.randomUUID();val body=JSONObject().put("purpose",purpose).put("fileName","手机图片-"+sha.take(12)+when(mime){"image/png"->".png";"image/webp"->".webp";else->".jpg"}).put("mimeType",mime).put("base64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));val r=withContext(Dispatchers.IO){JSONObject(api.raw("/api/staff/media-assets",body,mapOf("idempotency-key" to key)).text)};val asset=r.getJSONObject("data");require(r.getJSONObject("meta").get("replayed") is Boolean&&asset.getString("purpose")==purpose&&asset.getString("sha256")==sha&&asset.getInt("byteLength")==bytes.size);require(Regex("^MA[0-9A-F]{32}$").matches(asset.getString("publicId"))&&asset.getString("publicUrl")=="/api/public/media-assets/"+asset.getString("publicId"));require(actor.employeeId==identity?.employeeId&&access==priorityAccessKey&&version==workspaceVersion);return asset}catch(e:Exception){handleLiveError(e);throw e}finally{busy=false}
    }
    var memberGiftsBoard by mutableStateOf<MemberGiftsBoard?>(null)
        private set
    var memberGiftRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var memberGiftsState by mutableStateOf("请读取会员活动")
        private set
    private var memberGiftKind="campaigns"
    val memberGiftViewKind get()=memberGiftKind
    val canUseMemberGifts get()=memberReady && memberGiftsBoard?.enabled==true && memberGiftsBoard?.actor==identity?.employeeId && identity?.allows("loyalty.configuration.view")==true
    private suspend fun fetchMemberGifts(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)memberGiftsBoard?.next?:error("没有下一页")else null;val board=withContext(Dispatchers.IO){MemberGiftsBoard(api.data(memberGiftRoot+"/"+memberGiftKind+(next?.let{"?cursor="+LiveCommand.part(it)}?:"")))};require(board.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);memberGiftRows=(if(more)memberGiftRows+board.rows else board.rows).distinctBy{it.getString("id")};memberGiftsBoard=board;memberGiftsState="已读取 ${memberGiftRows.size} 条原记录"+(if(board.next!=null)"，可继续加载"else "")}
    fun loadMemberGifts(kind:String="campaigns"):Boolean{if(!live||busy||heartbeatBusy)return false;require(kind in listOf("campaigns","jobs","refund-pending","refund-resolved"));busy=true;memberGiftKind=kind;memberGiftsBoard=null;memberGiftRows=emptyList();memberGiftsState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMemberGifts()}catch(e:Exception){memberGiftsBoard=null;memberGiftRows=emptyList();memberGiftsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生会员赠礼"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    fun loadMoreMemberGifts(){if(busy||heartbeatBusy||memberGiftsBoard?.next==null)return;busy=true;viewModelScope.launch{try{fetchMemberGifts(true)}catch(e:Exception){memberGiftsState=e.message?:"读取失败，可重试";handleLiveError(e)}finally{busy=false}}}
    suspend fun memberGiftOptions(kind:String,search:String,cursor:String?):MemberGiftsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("loyalty.configuration.view"));val board=withContext(Dispatchers.IO){MemberGiftsBoard(api.data(memberGiftRoot+"/options?kind="+LiveCommand.part(kind)+"&search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(board.actor==actor.employeeId&&board.enabled&&access==priorityAccessKey&&version==workspaceVersion);return board}
    suspend fun launchPopupOptions(search:String,cursor:String?):MemberGiftsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("community.activity.manage"));val board=withContext(Dispatchers.IO){MemberGiftsBoard(api.data(launchPopupRoot+"/product-options?search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(board.actor==actor.employeeId&&board.enabled&&access==priorityAccessKey&&version==workspaceVersion);return board}
    suspend fun couponRefundOptions(refund:String,reservation:String,cursor:String?):MemberGiftsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("loyalty.policy.publish"));val board=withContext(Dispatchers.IO){MemberGiftsBoard(api.data(memberGiftRoot+"/refund-options?refundId="+LiveCommand.part(refund)+"&reservationId="+LiveCommand.part(reservation)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(board.actor==actor.employeeId&&board.enabled&&access==priorityAccessKey&&version==workspaceVersion);return board}
    var stackingPoliciesBoard by mutableStateOf<StackingPoliciesBoard?>(null)
        private set
    var stackingPolicyRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var stackingPoliciesState by mutableStateOf("请读取叠加价格规则规则")
        private set
    private var stackingPolicySearch=""
    val canUseStackingPolicies get()=memberReady && stackingPoliciesBoard?.enabled==true && stackingPoliciesBoard?.actor==identity?.employeeId && identity?.allows("loyalty.configuration.view")==true
    private suspend fun fetchStackingPolicies(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)stackingPoliciesBoard?.next?:error("没有下一页") else null;val q="?search="+LiveCommand.part(stackingPolicySearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"");val board=withContext(Dispatchers.IO){StackingPoliciesBoard(api.data(stackingPolicyRoot+q))};require(board.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);stackingPolicyRows=(if(more)stackingPolicyRows+board.rows else board.rows).distinctBy{it.getString("id")};stackingPoliciesBoard=board;stackingPoliciesState="已读取 ${stackingPolicyRows.size} 个原规则版本"+(if(board.next!=null)"，可继续加载" else "")}
    fun loadStackingPolicies(search:String=""){if(!live||busy||heartbeatBusy)return;busy=true;stackingPoliciesBoard=null;stackingPolicyRows=emptyList();stackingPolicySearch=search;stackingPoliciesState="正在读取叠加规则";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchStackingPolicies()}catch(e:Exception){stackingPoliciesBoard=null;stackingPolicyRows=emptyList();stackingPoliciesState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生叠加价格规则管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    fun loadMoreStackingPolicies(){if(busy||heartbeatBusy||stackingPoliciesBoard?.next==null)return;busy=true;viewModelScope.launch{try{fetchStackingPolicies(true)}catch(e:Exception){stackingPoliciesState=e.message?:"加载失败，可重试";handleLiveError(e)}finally{busy=false}}}
    suspend fun previewStackingPolicy(body:JSONObject):JSONObject{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("loyalty.configuration.preview"));val result=withContext(Dispatchers.IO){JSONObject(api.raw(stackingPolicyRoot+"/preview",body).text).getJSONObject("data")};require(result.getString("employeeId")==actor.employeeId&&result.getInt("protocol")==1&&result.getBoolean("previewOnly")&&!result.getBoolean("orderAuthorization")&&access==priorityAccessKey&&version==workspaceVersion);return result}
    var recommendationPolicyBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var recommendationPolicyRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var recommendationPolicyState by mutableStateOf("请读取推荐规则")
        private set
    private var recommendationPolicySearch="DEFAULT"
    val canUseRecommendationPolicies get()=memberReady && recommendationPolicyBoard?.enabled==true && recommendationPolicyBoard?.actor==identity?.employeeId
    private suspend fun fetchRecommendationPolicies(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)recommendationPolicyBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(recommendationPolicyRoot+"?code="+LiveCommand.part(recommendationPolicySearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);recommendationPolicyRows=(if(more)recommendationPolicyRows+b.rows else b.rows).distinctBy{it.getString("publicId")};recommendationPolicyBoard=b;recommendationPolicyState="已读取 ${recommendationPolicyRows.size} 条内容"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadRecommendationPolicies(search:String="DEFAULT",more:Boolean=false){if(!live||busy||heartbeatBusy)return;if(more&&recommendationPolicyBoard?.next==null)return;busy=true;if(!more){recommendationPolicySearch=search;recommendationPolicyBoard=null;recommendationPolicyRows=emptyList()};recommendationPolicyState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchRecommendationPolicies(more)}catch(e:Exception){recommendationPolicyBoard=null;recommendationPolicyState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用推荐规则管理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var annualPolicyBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var annualPolicyRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var annualPolicyState by mutableStateOf("请读取年度权益配置")
        private set
    private var annualPolicyCode=""
    val canUseAnnualPolicies get()=memberReady&&annualPolicyBoard?.enabled==true&&annualPolicyBoard?.actor==identity?.employeeId
    private suspend fun fetchAnnualPolicies(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)annualPolicyBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(annualPolicyRoot+"?"+(if(annualPolicyCode.isNotBlank())"code="+LiveCommand.part(annualPolicyCode)else "")+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);annualPolicyRows=(if(more)annualPolicyRows+b.rows else b.rows).distinctBy{it.getString("id")};annualPolicyBoard=b;annualPolicyState="已读取 ${annualPolicyRows.size} 个原配置版本"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadAnnualPolicies(code:String="",more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;if(more&&(annualPolicyBoard?.next==null||code!=annualPolicyCode))return false;busy=true;if(!more){annualPolicyCode=code;annualPolicyBoard=null;annualPolicyRows=emptyList()};annualPolicyState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchAnnualPolicies(more)}catch(e:Exception){annualPolicyBoard=null;annualPolicyState=e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    suspend fun annualPolicyOptions(kind:String,search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(annualPolicyRoot+"/options?kind="+kind+"&search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    suspend fun annualOccurrences(ruleId:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(annualPolicyRoot+"/occurrences?ruleId="+ruleId+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&b.data.getString("ruleId")==ruleId&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var checkoutManagementBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var checkoutManagementRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var checkoutManagementProducts by mutableStateOf<Map<String,JSONObject>>(emptyMap())
        private set
    var checkoutManagementState by mutableStateOf("请读取升级与产能配置")
        private set
    private var checkoutManagementArea="rules"
    private var checkoutManagementCode=""
    val canUseCheckoutManagement get()=memberReady && checkoutManagementBoard?.enabled==true && checkoutManagementBoard?.actor==identity?.employeeId
    private suspend fun fetchCheckoutManagement(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)checkoutManagementBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(checkoutManagementRoot+"?area="+checkoutManagementArea+(if(checkoutManagementArea=="rules"&&checkoutManagementCode.isNotBlank())"&code="+LiveCommand.part(checkoutManagementCode)else "")+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);checkoutManagementRows=(if(more)checkoutManagementRows+b.rows else b.rows).distinctBy{it.getString(if(checkoutManagementArea=="outcomes")"offerPublicId"else "id")};checkoutManagementProducts=(if(more)checkoutManagementProducts else emptyMap())+b.data.getJSONArray("products").objects().associateBy{it.getString("id")};checkoutManagementBoard=b;checkoutManagementState="已读取 ${checkoutManagementRows.size} 条记录"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadCheckoutManagement(area:String="rules",code:String="",more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;require(area in listOf("rules","capacities","outcomes"));if(more&&(checkoutManagementBoard?.next==null||area!=checkoutManagementArea))return false;busy=true;if(!more){checkoutManagementArea=area;checkoutManagementCode=code;checkoutManagementBoard=null;checkoutManagementRows=emptyList();checkoutManagementProducts=emptyMap()};checkoutManagementState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchCheckoutManagement(more)}catch(e:Exception){checkoutManagementBoard=null;checkoutManagementState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生升级和产能管理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    suspend fun checkoutProductOptions(search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(checkoutManagementRoot+"/products?search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var socialBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var socialRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var socialState by mutableStateOf("请读取微信运营记录")
        private set
    private var socialArea="accounts"
    val canUseSocial get()=memberReady && socialBoard?.enabled==true && socialBoard?.actor==identity?.employeeId
    private suspend fun fetchSocial(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)socialBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(socialOperationsRoot+"?area="+socialArea+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);socialRows=(if(more)socialRows+b.rows else b.rows).distinctBy{it.getString("id")};socialBoard=b;socialState="已读取 ${socialRows.size} 条记录"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadSocial(area:String="accounts",more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;require(area in listOf("accounts","events","broadcasts"));if(more&&(socialBoard?.next==null||area!=socialArea))return false;busy=true;if(!more){socialArea=area;socialBoard=null;socialRows=emptyList()};socialState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchSocial(more)}catch(e:Exception){socialBoard=null;socialState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生微信运营"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    suspend fun socialAccountOptions(search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(socialOperationsRoot+"/account-options?search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var contactGovernanceBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var contactGovernanceRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var contactGovernanceState by mutableStateOf("请读取保留与清除记录")
        private set
    private var contactGovernanceArea="policies"
    private var contactGovernanceSearch=""
    val canUseContactGovernance get()=memberReady && contactGovernanceBoard?.enabled==true && contactGovernanceBoard?.actor==identity?.employeeId
    private suspend fun fetchContactGovernance(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)contactGovernanceBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(contactGovernanceRoot+"?area="+contactGovernanceArea+"&search="+LiveCommand.part(contactGovernanceSearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);contactGovernanceRows=(if(more)contactGovernanceRows+b.rows else b.rows).distinctBy{it.getString(if(contactGovernanceArea=="dispositions")"resourcePublicId"else "publicId")};contactGovernanceBoard=b;contactGovernanceState="已读取 ${contactGovernanceRows.size} 条记录"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadContactGovernance(area:String="policies",search:String="",more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;require(area in listOf("policies","holds","dispositions","resources"));if(more&&(contactGovernanceBoard?.next==null||area!=contactGovernanceArea))return false;busy=true;if(!more){contactGovernanceArea=area;contactGovernanceSearch=search;contactGovernanceBoard=null;contactGovernanceRows=emptyList()};contactGovernanceState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchContactGovernance(more)}catch(e:Exception){contactGovernanceBoard=null;contactGovernanceState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生保留与清除治理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    var marketingBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var marketingRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var marketingState by mutableStateOf("请选择营销工作区")
        private set
    var marketingArea by mutableStateOf("notices")
        private set
    private var marketingCode=""
    val canUseMarketing get()=memberReady && marketingBoard?.enabled==true && marketingBoard?.actor==identity?.employeeId
    private suspend fun fetchMarketing(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)marketingBoard?.next?:error("没有下一页")else null;val path=marketingRoot+"/"+marketingArea+"?"+(if(marketingArea=="notices"&&marketingCode.isNotBlank())"code="+LiveCommand.part(marketingCode)+"&" else "")+(next?.let{"cursor="+LiveCommand.part(it)}?:"");val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(path))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);marketingRows=(if(more)marketingRows+b.rows else b.rows).distinctBy{it.getString("id")};marketingBoard=b;marketingState="已读取 ${marketingRows.size} 条记录"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadMarketing(area:String="notices",code:String="",more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;require(area in listOf("notices","jobs","workspace"));if(more&&(marketingBoard?.next==null||area!=marketingArea))return false;busy=true;if(!more){marketingArea=area;marketingCode=code;marketingBoard=null;marketingRows=emptyList()};marketingState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMarketing(more)}catch(e:Exception){marketingBoard=null;marketingState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用营销工作区"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    suspend fun marketingCustomers(purpose:String,search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(marketingRoot+"/customers?purpose="+purpose+"&search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    suspend fun marketingHistory(customerId:String,reason:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(JSONObject(api.raw(marketingRoot+"/history",JSONObject().put("customerId",customerId).put("reason",reason).put("cursor",cursor?:JSONObject.NULL)).text).getJSONObject("data"))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var activityOperationsBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var activityOperationsRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var activityOperationsDetail by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var activityRegistrationRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var activityOperationsState by mutableStateOf("请读取活动")
        private set
    private var activityOperationsSearch=""
    private var activityOperationsSelection:String?=null
    private var activityRegistrationSearch=""
    val canUseActivityOperations get()=memberReady && activityOperationsBoard?.enabled==true && activityOperationsBoard?.actor==identity?.employeeId
    private suspend fun fetchActivityOperations(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)activityOperationsBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(activityOperationsRoot+"?search="+LiveCommand.part(activityOperationsSearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);activityOperationsRows=(if(more)activityOperationsRows+b.rows else b.rows).distinctBy{it.getString("publicId")};activityOperationsBoard=b;activityOperationsState="已读取 ${activityOperationsRows.size} 场活动"+(if(b.next!=null)"，可继续加载"else "")}
    private suspend fun fetchActivityOperationsDetail(more:Boolean=false){val selected=activityOperationsSelection?:return;val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)activityOperationsDetail?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(activityOperationsRoot+"/"+LiveCommand.part(selected)+"?search="+LiveCommand.part(activityRegistrationSearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion&&selected==activityOperationsSelection);activityOperationsDetail=b;activityRegistrationRows=(if(more)activityRegistrationRows+b.rows else b.rows).distinctBy{it.getString("publicId")};activityOperationsState="已读取原活动及 ${activityRegistrationRows.size} 条报名"+(if(b.next!=null)"，可加载更多报名"else "")}
    fun loadActivityOperations(search:String="",more:Boolean=false){if(!live||busy||heartbeatBusy)return;if(more&&activityOperationsBoard?.next==null)return;busy=true;if(!more){activityOperationsSearch=search;activityOperationsBoard=null;activityOperationsRows=emptyList();activityOperationsSelection=null;activityOperationsDetail=null;activityRegistrationRows=emptyList()};activityOperationsState="正在读取活动";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchActivityOperations(more)}catch(e:Exception){activityOperationsBoard=null;activityOperationsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生活动运营"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    fun selectActivityOperations(id:String,more:Boolean=false,search:String=""){if(!live||busy||heartbeatBusy)return;if(more&&(activityOperationsDetail?.next==null||activityOperationsSelection!=id))return;busy=true;if(!more){activityOperationsSelection=id;activityRegistrationSearch=search;activityOperationsDetail=null;activityRegistrationRows=emptyList()};viewModelScope.launch{try{fetchActivityOperationsDetail(more)}catch(e:Exception){activityOperationsDetail=null;activityOperationsState=e.message?:"活动读取失败";handleLiveError(e)}finally{busy=false}}}
    suspend fun activityComponentOptions(search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(activityOperationsRoot+"/components?search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    suspend fun revealActivityContact(contact:String,purpose:String):JSONObject{val actor=identity?:error("请登录");require(actor.allows("community.activity.contact.reveal"));val access=priorityAccessKey;val version=workspaceVersion;val result=withContext(Dispatchers.IO){JSONObject(api.raw("/api/staff/activity-contacts/"+LiveCommand.part(contact)+"/reveal",JSONObject().put("purpose",purpose),mapOf("idempotency-key" to "native-contact-"+java.util.UUID.randomUUID())).text).getJSONObject("data")};require(access==priorityAccessKey&&version==workspaceVersion&&actor.employeeId==identity?.employeeId);require(serverInstant(result.getString("expiresAt")).isAfter(java.time.Instant.now())){"联系方式已过显示期限，请重新查询"};return result}
    var homeContentBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var homeContentRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var homeContentState by mutableStateOf("请读取首页内容")
        private set
    private var homeContentSearch=""
    val canUseHomeContent get()=memberReady && homeContentBoard?.enabled==true && homeContentBoard?.actor==identity?.employeeId
    private suspend fun fetchHomeContent(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)homeContentBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(homeContentRoot+"?search="+LiveCommand.part(homeContentSearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);homeContentRows=(if(more)homeContentRows+b.rows else b.rows).distinctBy{it.getString("code")};homeContentBoard=b;homeContentState="已读取 ${homeContentRows.size} 条内容"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadHomeContent(search:String="",more:Boolean=false){if(!live||busy||heartbeatBusy)return;if(more&&homeContentBoard?.next==null)return;busy=true;if(!more){homeContentSearch=search;homeContentBoard=null;homeContentRows=emptyList()};homeContentState="正在读取";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchHomeContent(more)}catch(e:Exception){homeContentBoard=null;homeContentState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用首页内容管理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    suspend fun homeContentActivityOptions(search:String,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(homeContentRoot+"/activity-options?search="+LiveCommand.part(search)+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var launchPopupBoard by mutableStateOf<LaunchPopupBoard?>(null)
        private set
    var launchPopupState by mutableStateOf("请读取小程序弹窗")
        private set
    val canUseLaunchPopup get()=memberReady && launchPopupBoard?.enabled==true && launchPopupBoard?.actor==identity?.employeeId && identity?.allows("community.activity.manage")==true
    private suspend fun fetchLaunchPopup(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){LaunchPopupBoard(api.data(launchPopupRoot))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);launchPopupBoard=b;launchPopupState="已读取当前小程序弹窗"}
    fun loadLaunchPopup(){if(!live||busy||heartbeatBusy)return;busy=true;launchPopupBoard=null;launchPopupState="正在读取弹窗配置";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchLaunchPopup()}catch(e:Exception){launchPopupBoard=null;launchPopupState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生弹窗配置管理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var commercePolicyBoard by mutableStateOf<CommercePolicyBoard?>(null)
        private set
    var commercePolicyState by mutableStateOf("请读取门店支付策略")
        private set
    val canUseCommercePolicy get()=memberReady && commercePolicyBoard?.enabled==true && commercePolicyBoard?.actor==identity?.employeeId && identity?.allows("payment.policy.manage")==true
    private suspend fun fetchCommercePolicy(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val b=withContext(Dispatchers.IO){CommercePolicyBoard(api.data(commercePolicyRoot))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);commercePolicyBoard=b;commercePolicyState="已读取当前门店支付策略"}
    fun loadCommercePolicy(){if(!live||busy||heartbeatBusy)return;busy=true;commercePolicyBoard=null;commercePolicyState="正在读取支付策略";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchCommercePolicy()}catch(e:Exception){commercePolicyBoard=null;commercePolicyState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生支付策略管理"else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var couponCalendarsBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var couponCalendarRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var couponCalendarsState by mutableStateOf("请读取券日历规则")
        private set
    private var couponCalendarSearch=""
    val canUseCouponCalendars get()=memberReady && couponCalendarsBoard?.enabled==true && couponCalendarsBoard?.actor==identity?.employeeId && identity?.allows("loyalty.configuration.view")==true
    private suspend fun fetchCouponCalendars(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)couponCalendarsBoard?.next?:error("没有下一页") else null;val q="?search="+LiveCommand.part(couponCalendarSearch)+(next?.let{"&cursor="+LiveCommand.part(it)}?:"");val board=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(couponCalendarRoot+q))};require(board.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);couponCalendarRows=(if(more)couponCalendarRows+board.rows else board.rows).distinctBy{it.getString("id")};couponCalendarsBoard=board;couponCalendarsState="已读取 ${couponCalendarRows.size} 个原规则版本"+(if(board.next!=null)"，可继续加载" else "")}
    fun loadCouponCalendars(search:String=""){if(!live||busy||heartbeatBusy)return;busy=true;couponCalendarsBoard=null;couponCalendarRows=emptyList();couponCalendarSearch=search;couponCalendarsState="正在读取券规则";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchCouponCalendars()}catch(e:Exception){couponCalendarsBoard=null;couponCalendarRows=emptyList();couponCalendarsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生券日历管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    fun loadMoreCouponCalendars(){if(busy||heartbeatBusy||couponCalendarsBoard?.next==null)return;busy=true;viewModelScope.launch{try{fetchCouponCalendars(true)}catch(e:Exception){couponCalendarsState=e.message?:"加载失败，可重试";handleLiveError(e)}finally{busy=false}}}
    suspend fun previewCouponCalendar(body:JSONObject):JSONObject{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("loyalty.configuration.view"));val result=withContext(Dispatchers.IO){JSONObject(api.raw(couponCalendarRoot+"/preview",body).text).getJSONObject("data")};require(result.getString("employeeId")==actor.employeeId&&result.getInt("protocol")==1&&result.getBoolean("previewOnly")&&access==priorityAccessKey&&version==workspaceVersion);return result}
    var productPhasesBoard by mutableStateOf<ProductPhasesBoard?>(null)
        private set
    var productPhasesState by mutableStateOf("请读取商品阶段")
        private set
    val canUseProductPhases get()=memberReady && productPhasesBoard?.enabled==true && productPhasesBoard?.actor==identity?.employeeId && identity?.allows("recommendation.phase.configure")==true
    private suspend fun fetchProductPhases(product:String){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val board=withContext(Dispatchers.IO){ProductPhasesBoard(api.data("$productPhaseRoot/$product"))};require(board.actor==actor.employeeId&&board.product==product&&access==priorityAccessKey&&version==workspaceVersion);productPhasesBoard=board;productPhasesState="已读取原商品阶段与版本"}
    fun loadProductPhases(product:String){if(!live||busy||heartbeatBusy)return;busy=true;productPhasesBoard=null;productPhasesState="正在读取商品演出阶段";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchProductPhases(product)}catch(e:Exception){productPhasesBoard=null;productPhasesState=if((e as? StaffAPIError)?.status==404)"后台尚未启用原生商品阶段管理，或原商品不可见" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var membershipRecoveryBoard by mutableStateOf<CouponCalendarsBoard?>(null)
        private set
    var membershipRecoveryRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var membershipRecoveryState by mutableStateOf("请读取原找回申请")
        private set
    private var membershipRecoveryHistory=false
    val canUseMembershipRecovery get()=memberReady&&membershipRecoveryBoard?.enabled==true&&membershipRecoveryBoard?.actor==identity?.employeeId
    private suspend fun fetchMembershipRecovery(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)membershipRecoveryBoard?.next?:error("没有下一页")else null;val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(membershipRecoveryRoot+"?history="+membershipRecoveryHistory+(next?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);membershipRecoveryRows=(if(more)membershipRecoveryRows+b.rows else b.rows).distinctBy{it.getString("casePublicId")};membershipRecoveryBoard=b;membershipRecoveryState="已读取 ${membershipRecoveryRows.size} 个原申请"+(if(b.next!=null)"，可继续加载"else "")}
    fun loadMembershipRecovery(history:Boolean=false,more:Boolean=false):Boolean{if(!live||busy||heartbeatBusy)return false;if(more&&(history!=membershipRecoveryHistory||membershipRecoveryBoard?.next==null))return false;busy=true;if(!more){membershipRecoveryHistory=history;membershipRecoveryBoard=null;membershipRecoveryRows=emptyList()};membershipRecoveryState="正在读取原找回申请";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMembershipRecovery(more)}catch(e:Exception){membershipRecoveryBoard=null;membershipRecoveryRows=emptyList();membershipRecoveryState=e.message?:"读取失败";handleLiveError(e)}finally{busy=false}};return true}
    suspend fun membershipRecoveryCandidates(row:JSONObject,cursor:String?):CouponCalendarsBoard{val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows(membershipRecoveryPermissions[0]));val b=withContext(Dispatchers.IO){CouponCalendarsBoard(api.data(membershipRecoveryRoot+"/candidates?casePublicId="+LiveCommand.part(row.getString("casePublicId"))+"&expectedVersion="+row.getString("nativeVersion")+(cursor?.let{"&cursor="+LiveCommand.part(it)}?:"")))};require(b.actor==actor.employeeId&&b.enabled&&b.data.getString("caseVersion")==row.getString("nativeVersion")&&b.data.getString("casePublicId")==row.getString("casePublicId")&&access==priorityAccessKey&&version==workspaceVersion);return b}
    var memberNumberBoard by mutableStateOf<JSONObject?>(null)
        private set
    var memberNumberState by mutableStateOf("请读取会员号规则")
        private set
    val canUseMemberNumber get()=memberReady&&memberNumberBoard?.optString("employeeId")==identity?.employeeId&&memberNumberBoard?.optBoolean("durableCommands")==true&&identity?.allows("member.card.manage")==true
    private suspend fun fetchMemberNumber(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("member.card.manage"));val b=withContext(Dispatchers.IO){api.data(memberNumberRoot)};require(b.getString("employeeId")==actor.employeeId&&b.getInt("protocol")==1&&access==priorityAccessKey&&version==workspaceVersion);memberNumberBoard=b;memberNumberState="已读取原规则第${b.getJSONObject("row").getInt("version")}版"}
    fun loadMemberNumber(){if(!live||busy||heartbeatBusy)return;busy=true;memberNumberBoard=null;memberNumberState="正在读取会员号规则";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMemberNumber()}catch(e:Exception){memberNumberBoard=null;memberNumberState=e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var experiencePlansBoard by mutableStateOf<ExperiencePlansBoard?>(null)
        private set
    var experiencePlanRows by mutableStateOf<List<JSONObject>>(emptyList())
        private set
    var experiencePlansState by mutableStateOf("请读取原体验计划")
        private set
    private var experiencePlansQuery=""
    val canUseExperiencePlans get()=memberReady && experiencePlansBoard?.enabled==true && experiencePlansBoard?.canManage==true && experiencePlansBoard?.actor==identity?.employeeId && listOf("customer.experience.manage","service.manage","service.execute").all{identity?.allows(it)==true}
    private suspend fun fetchExperiencePlans(more:Boolean=false){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val next=if(more)experiencePlansBoard?.next?:error("没有下一页") else null
        val suffix=if(next==null) "" else (if(experiencePlansQuery.isBlank())"?" else "&")+"beforeDate=${next.getString("beforeDate")}&beforeId=${next.getString("beforeId")}";
        val board=withContext(Dispatchers.IO){ExperiencePlansBoard(api.data(experiencePlansRoot+experiencePlansQuery+suffix))};require(board.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion)
        experiencePlanRows=(if(more)experiencePlanRows+board.rows else board.rows).distinctBy{it.getString("id")};experiencePlansBoard=board;experiencePlansState="已读取 ${experiencePlanRows.size} 个原计划"+(if(board.next!=null)"，可继续加载" else "")
    }
    fun loadExperiencePlans(query:String=""){if(!live||busy||heartbeatBusy)return;busy=true;experiencePlansBoard=null;experiencePlanRows=emptyList();experiencePlansQuery=query;experiencePlansState="正在读取原体验计划";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchExperiencePlans()}catch(e:Exception){experiencePlansBoard=null;experiencePlanRows=emptyList();experiencePlansState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生体验计划管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    fun loadMoreExperiencePlans(){if(busy||heartbeatBusy||experiencePlansBoard?.next==null)return;busy=true;viewModelScope.launch{try{fetchExperiencePlans(true)}catch(e:Exception){experiencePlansState=e.message?:"加载失败，可重试";handleLiveError(e)}finally{busy=false}}}
    var publicationBoard by mutableStateOf<PublicationBoard?>(null)
        private set
    var publicationState by mutableStateOf("请读取顾客公开内容")
        private set
    val canUsePublication get()=memberReady && publicationBoard?.enabled==true && publicationBoard?.actor==identity?.employeeId
    private suspend fun fetchPublication(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;val board=withContext(Dispatchers.IO){PublicationBoard(api.data(publicationRoot))};require(board.actor==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);publicationBoard=board;publicationState="已读取当前授权的公开内容与版本"}
    fun loadPublication(){if(!live||busy||heartbeatBusy)return;busy=true;publicationBoard=null;publicationState="正在读取公开内容";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchPublication()}catch(e:Exception){publicationBoard=null;publicationState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生公开内容管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var recipeCostPreview by mutableStateOf<JSONObject?>(null)
        private set
    var recipeConfigurationBoard by mutableStateOf<RecipeConfigurationBoard?>(null)
        private set
    var recipeConfigurationState by mutableStateOf("请读取原商品配方")
        private set
    val canUseRecipeConfiguration get()=memberReady && recipeConfigurationBoard?.enabled==true && recipeConfigurationBoard?.actor==identity?.employeeId && identity?.allows("inventory.manage")==true
    private suspend fun fetchRecipeConfiguration(productId:String){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("inventory.manage"));val board=withContext(Dispatchers.IO){RecipeConfigurationBoard(api.data("/api/native/inventory/products/$productId/recipe"))};val cost=if(board.recipe!=null&&actor.allows("inventory.cost.view")) withContext(Dispatchers.IO){api.data("/api/native/inventory/products/$productId/recipe-cost")} else null;require(board.actor==actor.employeeId&&board.product.getString("id")==productId&&access==priorityAccessKey&&version==workspaceVersion);recipeConfigurationBoard=board;recipeCostPreview=cost?.takeIf{it.getString("recipeId")==board.recipe?.getString("id")};recipeConfigurationState="已读取原商品与物料基础单位"}
    fun loadRecipeConfiguration(productId:String){if(!live||busy||heartbeatBusy)return;busy=true;recipeCostPreview=null;recipeConfigurationBoard=null;recipeConfigurationState="正在读取配方";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchRecipeConfiguration(productId)}catch(e:Exception){recipeConfigurationBoard=null;recipeConfigurationState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生配方管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var staffAdministrationBoard by mutableStateOf<StaffAdministrationBoard?>(null)
        private set
    var staffAdministrationState by mutableStateOf("请读取员工与岗位权限")
        private set
    val canUseStaffAdministration get()=memberReady && staffAdministrationBoard?.enabled==true && staffAdministrationBoard?.employee==identity?.employeeId && identity?.allows("staff.access.configure")==true
    private suspend fun fetchStaffAdministration(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("staff.access.configure"));val board=withContext(Dispatchers.IO){StaffAdministrationBoard(api.data(staffAdminRoot))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);staffAdministrationBoard=board;staffAdministrationState="已读取原门店员工与岗位权限"}
    fun loadStaffAdministration(){if(!live||busy||heartbeatBusy)return;busy=true;staffAdministrationBoard=null;staffAdministrationState="正在读取员工与岗位权限";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchStaffAdministration()}catch(e:Exception){staffAdministrationBoard=null;staffAdministrationState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生员工管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var tableConfigurationBoard by mutableStateOf<TableConfigurationBoard?>(null)
        private set
    var tableConfigurationState by mutableStateOf("请读取区域和桌台配置")
        private set
    val canUseTableConfiguration get()=memberReady && tableConfigurationBoard?.enabled==true && tableConfigurationBoard?.employee==identity?.employeeId && identity?.allows("table.manage")==true
    private suspend fun fetchTableConfiguration(){val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("table.manage"));val board=withContext(Dispatchers.IO){TableConfigurationBoard(api.data(tableConfigRoot))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);tableConfigurationBoard=board;tableConfigurationState="已读取原门店区域与桌台配置"}
    fun loadTableConfiguration(){if(!live||busy||heartbeatBusy)return;busy=true;tableConfigurationBoard=null;tableConfigurationState="正在读取区域与桌台";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchTableConfiguration()}catch(e:Exception){tableConfigurationBoard=null;tableConfigurationState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生桌台配置" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var benefitWalletBoard by mutableStateOf<BenefitWalletBoard?>(null)
        private set
    var benefitWalletState by mutableStateOf("请扫描会员码或填写会员号")
        private set
    private var walletCode=""
    private var walletCursor=""
    val canUseBenefitWallet get()=memberReady && benefitWalletBoard?.enabled==true && benefitWalletBoard?.employee==identity?.employeeId
    private suspend fun fetchBenefitWallet(){
        if(walletCode.isBlank()){benefitWalletBoard=null;benefitWalletState="原请求已核对，可重新扫描会员码查看权益";return}
        val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("loyalty.account.view"))
        val body=JSONObject().put("code",walletCode);if(walletCursor.isNotBlank())body.put("cursor",walletCursor)
        val board=withContext(Dispatchers.IO){BenefitWalletBoard(api.data("$benefitWalletRoot/lookup",body))}
        require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion)
        benefitWalletBoard=board;benefitWalletState="已读取会员权益与当前可操作桌次"
    }
    fun loadBenefitWallet(code:String,cursor:String=""){
        if(!live||busy||heartbeatBusy)return;val verifiedCode=MemberCommands.code(code);busy=true;walletCode=verifiedCode;walletCursor=cursor;benefitWalletBoard=null;benefitWalletState="正在查询会员权益"
        viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchBenefitWallet()}catch(e:Exception){benefitWalletBoard=null;benefitWalletState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生权益钱包" else e.message?:"查询失败";handleLiveError(e)}finally{busy=false}}
    }
    suspend fun walletProducts(search:String,offset:Int):JSONObject{
        require(!busy&&!heartbeatBusy&&live);val access=priorityAccessKey;val version=workspaceVersion;busy=true
        try{identity=withContext(Dispatchers.IO){api.heartbeat()};require(access==priorityAccessKey&&identity?.allows("benefit.issue")==true);val result=withContext(Dispatchers.IO){api.data(benefitWalletRoot+"/products"+custodyQuery(mapOf("search" to search,"offset" to offset.toString())))};require(access==priorityAccessKey&&version==workspaceVersion&&result.getString("employeeId")==identity?.employeeId);return result}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){handleLiveError(e);throw e}finally{busy=false}
    }
    var remakeHandoverBoard by mutableStateOf<RemakeHandoverBoard?>(null)
        private set
    var remakeHandoverState by mutableStateOf("请读取离店实物")
        private set
    private var remakeHandoverCursor:JSONObject?=null
    val canUseRemakeHandover get()=memberReady && remakeHandoverBoard?.enabled==true && remakeHandoverBoard?.employee==identity?.employeeId && identity?.allows("refund.request")==true
    private suspend fun fetchRemakeHandover(){val actor=identity?:error("请登录");val access=priorityAccessKey;val workspace=workspaceVersion;require(actor.allows("refund.request"));val query=remakeHandoverCursor?.let{custodyQuery(mapOf("cursorId" to it.getString("id"),"createdAt" to it.getString("createdAt")))}?:"";val board=withContext(Dispatchers.IO){RemakeHandoverBoard(api.data("$remakeHandoverRoot/native-remake-handover$query"))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId&&access==priorityAccessKey&&workspace==workspaceVersion);remakeHandoverBoard=board;remakeHandoverState="已读取原批次剩余实物"}
    fun loadRemakeHandover(cursor:JSONObject?=remakeHandoverCursor){if(!live||busy||heartbeatBusy)return;busy=true;remakeHandoverCursor=cursor;remakeHandoverBoard=null;remakeHandoverState="正在读取离店实物";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchRemakeHandover()}catch(e:Exception){remakeHandoverBoard=null;remakeHandoverState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生实物交接" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    var membershipConfigBoard by mutableStateOf<MembershipConfigBoard?>(null)
        private set
    var membershipConfigDetail by mutableStateOf<JSONObject?>(null)
        private set
    var membershipConfigState by mutableStateOf("请读取会员规则")
        private set
    private var membershipConfigSection="rules"
    private var membershipConfigTarget:String?=null
    val canUseMembershipConfig get()=memberReady && membershipConfigBoard?.enabled==true && membershipConfigBoard?.employee==identity?.employeeId
    fun clearMembershipConfigDetail(){membershipConfigTarget=null;membershipConfigDetail=null}
    private suspend fun fetchMembershipConfig(){
        val actor=identity?:error("请登录");val access=priorityAccessKey;val workspace=workspaceVersion
        require(actor.allows(if(membershipConfigSection=="rules")"loyalty.configuration.view" else "loyalty.operations.view"))
        val board=withContext(Dispatchers.IO){MembershipConfigBoard(api.data("$membershipConfigRoot?section=$membershipConfigSection"))}
        val detail=membershipConfigTarget?.takeIf{membershipConfigSection=="rules"}?.let{target->withContext(Dispatchers.IO){api.data("$membershipConfigRoot/$target")}}
        require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId&&access==priorityAccessKey&&workspace==workspaceVersion)
        if(detail!=null)require(detail.getString("employeeId")==actor.employeeId&&detail.getInt("protocol")==1&&detail.getBoolean("durableCommands"))
        membershipConfigBoard=board;membershipConfigDetail=detail;membershipConfigState="已读取原规则与状态"
    }
    fun loadMembershipConfig(section:String=membershipConfigSection,target:String?=membershipConfigTarget){
        if(!live||busy||heartbeatBusy)return
        require(section in setOf("rules","controls"));if(target!=null)require(Regex("^[a-z_]+/[a-f0-9-]{36}$").matches(target))
        busy=true;membershipConfigSection=section;membershipConfigTarget=target;membershipConfigBoard=null;membershipConfigDetail=null;membershipConfigState="正在读取会员规则"
        viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMembershipConfig()}catch(e:Exception){membershipConfigBoard=null;membershipConfigDetail=null;membershipConfigState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生规则管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}
    }
    var loyaltySupplementsBoard by mutableStateOf<LoyaltySupplementsBoard?>(null)
        private set
    var loyaltySupplementsState by mutableStateOf("请读取积分原账")
        private set
    private var loyaltySupplementsPage=0
    private var loyaltySupplementsSection="reconciliation"
    val canUseLoyaltySupplements get()=memberReady && loyaltySupplementsBoard?.enabled==true && loyaltySupplementsBoard?.employee==identity?.employeeId
    private suspend fun fetchLoyaltySupplements(){val actor=identity?:error("请登录");require(actor.allows("loyalty.accrual.exception.view"));val board=withContext(Dispatchers.IO){LoyaltySupplementsBoard(api.data("$loyaltySupplementsRoot?section=$loyaltySupplementsSection&page=$loyaltySupplementsPage"))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId);loyaltySupplementsBoard=board;loyaltySupplementsState="已读取原积分与补发记录"}
    fun loadLoyaltySupplements(section:String=loyaltySupplementsSection,page:Int=loyaltySupplementsPage){if(!live||busy||heartbeatBusy)return;require(section in setOf("reconciliation","requests")&&page in 0..10000);busy=true;loyaltySupplementsSection=section;loyaltySupplementsPage=page;loyaltySupplementsBoard=null;loyaltySupplementsState="正在读取原积分账";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchLoyaltySupplements()}catch(e:Exception){loyaltySupplementsBoard=null;loyaltySupplementsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生积分对账" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}

    var benefitExceptionsBoard by mutableStateOf<BenefitExceptionsBoard?>(null)
        private set
    var benefitExceptionsState by mutableStateOf("请读取礼遇出品异常")
        private set
    private var benefitExceptionsPage=0
    val canUseBenefitExceptions get()=memberReady && benefitExceptionsBoard?.enabled==true && benefitExceptionsBoard?.employee==identity?.employeeId && identity?.allows("loyalty.redemption.exception")==true
    private suspend fun fetchBenefitExceptions(){val actor=identity?:error("请登录");require(actor.allows("loyalty.redemption.exception"));val board=withContext(Dispatchers.IO){BenefitExceptionsBoard(api.data("$benefitExceptionsRoot?page=$benefitExceptionsPage"))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId);benefitExceptionsBoard=board;benefitExceptionsState="已读取原礼遇出品异常"}
    fun loadBenefitExceptions(page:Int=benefitExceptionsPage){if(!live||busy||heartbeatBusy)return;require(page in 0..10000);busy=true;benefitExceptionsPage=page;benefitExceptionsBoard=null;benefitExceptionsState="正在读取原礼遇任务";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchBenefitExceptions()}catch(e:Exception){benefitExceptionsBoard=null;benefitExceptionsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生礼遇异常处理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}

    var loyaltyRefundBoard by mutableStateOf<LoyaltyRefundBoard?>(null)
        private set
    var loyaltyRefundState by mutableStateOf("请读取退款积分复核")
        private set
    private var loyaltyRefundPage=0
    val canUseLoyaltyRefunds get()=memberReady && loyaltyRefundBoard?.enabled==true && loyaltyRefundBoard?.employee==identity?.employeeId
    private suspend fun fetchLoyaltyRefunds(){val actor=identity?:error("请登录");require(canReadLoyaltyRefunds(actor));val board=withContext(Dispatchers.IO){LoyaltyRefundBoard(api.data("$loyaltyRefundRoot?page=$loyaltyRefundPage"))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId);loyaltyRefundBoard=board;loyaltyRefundState="已读取原退款及积分依据"}
    fun loadLoyaltyRefunds(page:Int=loyaltyRefundPage){if(!live||busy||heartbeatBusy)return;require(page in 0..10000);busy=true;loyaltyRefundPage=page;loyaltyRefundBoard=null;loyaltyRefundState="正在读取原退款依据";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchLoyaltyRefunds()}catch(e:Exception){loyaltyRefundBoard=null;loyaltyRefundState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生退款积分复核" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}

    var memberCardsBoard by mutableStateOf<MemberCardsBoard?>(null)
        private set
    var memberCardsState by mutableStateOf("请读取会员卡")
        private set
    private var memberCardsSection="projects"
    private var memberCardsCursor=""
    private var memberCardsUpdated:java.time.Instant?=null
    val canUseMemberCards get()=memberReady && memberCardsBoard?.enabled==true && memberCardsBoard?.employee==identity?.employeeId && memberCardsUpdated!=null
    private suspend fun fetchMemberCards(){val actor=identity?:error("请登录");require(memberCardPermissions.any{actor.allows(it)});val board=withContext(Dispatchers.IO){MemberCardsBoard(api.data(memberCardsRoot+custodyQuery(mapOf("section" to memberCardsSection,"cursor" to memberCardsCursor))))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId);memberCardsBoard=board;memberCardsUpdated=java.time.Instant.now();memberCardsState="已读取真实会员卡记录"}
    fun loadMemberCards(section:String=memberCardsSection,cursor:String=if(section==memberCardsSection)memberCardsCursor else ""){
        if(!live||busy||heartbeatBusy)return;require(section in setOf("projects","applications","holdings"));busy=true;memberCardsSection=section;memberCardsCursor=cursor;memberCardsBoard=null;memberCardsUpdated=null;memberCardsState="正在读取会员卡"
        viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchMemberCards()}catch(e:Exception){memberCardsBoard=null;memberCardsState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生会员卡管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}
    }
    suspend fun readMemberCardExtra(suffix:String):JSONObject{
        require(live&&!busy&&!heartbeatBusy&&identity?.allows("member.card.manage")==true)
        require(Regex("^/projects/[a-f0-9-]{36}/config$").matches(suffix)||suffix.startsWith("/products?"))
        val original=priorityAccessKey;val version=workspaceVersion;busy=true
        try{identity=withContext(Dispatchers.IO){api.heartbeat()};require(original==priorityAccessKey);val result=withContext(Dispatchers.IO){api.data(memberCardsRoot+suffix)};require(original==priorityAccessKey&&version==workspaceVersion&&result.getString("employeeId")==identity?.employeeId);return result}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){handleLiveError(e);throw e}finally{busy=false}
    }

    var performanceBoard by mutableStateOf<PerformanceBoard?>(null)
        private set
    var performanceState by mutableStateOf("请读取演出排班")
        private set
    private var performanceMonth=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).toString().take(7)
    private var performanceUpdated:java.time.Instant?=null
    val canUsePerformances get()=memberReady && performanceBoard?.enabled==true && performanceBoard?.employee==identity?.employeeId && performanceUpdated!=null
    private suspend fun fetchPerformances(){val actor=identity?:error("请登录");require(performancePermissions.any{actor.allows(it)});val board=withContext(Dispatchers.IO){PerformanceBoard(api.data("$performanceRoot?month=$performanceMonth"))};require(actor.employeeId==identity?.employeeId&&board.employee==actor.employeeId);performanceBoard=board;performanceUpdated=java.time.Instant.now();performanceState="已读取演出与修订记录"}
    fun loadPerformances(month:String=performanceMonth){if(!live||busy||heartbeatBusy)return;java.time.YearMonth.parse(month);busy=true;performanceMonth=month;performanceBoard=null;performanceUpdated=null;performanceState="正在读取演出排班";viewModelScope.launch{try{identity=withContext(Dispatchers.IO){api.heartbeat()};fetchPerformances()}catch(e:Exception){performanceBoard=null;performanceState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生演出管理" else e.message?:"读取失败";handleLiveError(e)}finally{busy=false}}}
    suspend fun readPerformanceExtra(suffix:String,preview:JSONObject?=null):JSONObject {
        require(live&&!busy&&!heartbeatBusy&&performancePermissions.any{identity?.allows(it)==true})
        require(suffix=="/preview"&&preview!=null||Regex("^/performers/[a-f0-9-]{36}/songs\\?.*$").matches(suffix)||Regex("^/revisions/[^/]+/impacts$").matches(suffix)||Regex("^\\?month=20[0-9]{2}-[0-9]{2}$").matches(suffix))
        val original=priorityAccessKey;val version=workspaceVersion;busy=true
        try{identity=withContext(Dispatchers.IO){api.heartbeat()};require(priorityAccessKey==original);val value=withContext(Dispatchers.IO){if(preview==null)api.data(performanceRoot+suffix) else JSONObject(api.raw(performanceRoot+suffix,preview,emptyMap()).text).getJSONObject("data")};require(original==priorityAccessKey&&version==workspaceVersion);return value}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){handleLiveError(e);throw e}finally{busy=false}
    }
    suspend fun previewPerformances(body:JSONObject)=readPerformanceExtra("/preview",body)

    var ownerBoard by mutableStateOf<OwnerBoard?>(null)
        private set
    var ownerState by mutableStateOf("请读取费用与工资")
        private set
    private var ownerUpdated: java.time.Instant? = null
    private var ownerQuery = ""
    val canUseOwner get() = memberReady && ownerBoard?.enabled == true && ownerBoard?.employee == identity?.employeeId && ownerUpdated?.let { java.time.Duration.between(it,java.time.Instant.now()).seconds in 0..59 } == true
    private suspend fun fetchOwnerFinance() {
        val actor=identity ?: error("请登录")
        require(ownerPermissions.any { actor.allows(it) }) { "没有经营财务权限" }
        val board=withContext(Dispatchers.IO) { OwnerBoard(api.data("$ownerRoot/owner-finance"+if(ownerQuery.isBlank()) "" else "?$ownerQuery"),api.data("$ownerRoot/native-capabilities")) }
        require(actor.employeeId==identity?.employeeId && board.employee==actor.employeeId)
        ownerBoard=board;ownerUpdated=java.time.Instant.now();ownerState="已读取服务器费用与工资"
    }
    fun loadOwnerFinance(query:String=ownerQuery) {
        if(!live||busy||heartbeatBusy)return
        busy=true;ownerUpdated=null;ownerBoard=null;ownerQuery=query;ownerState="正在读取费用与工资"
        viewModelScope.launch { try {identity=withContext(Dispatchers.IO){api.heartbeat()};fetchOwnerFinance()}
            catch(e:Exception){ownerBoard=null;ownerState=if((e as? StaffAPIError)?.status==404)"配套后台尚未启用原生经营财务" else e.message ?: "读取失败";handleLiveError(e)} finally {busy=false} }
    }

    var custodyBoard by mutableStateOf<CustodyBoard?>(null)
        private set
    var custodyState by mutableStateOf("请查询存酒")
        private set
    var custodyReceipt by mutableStateOf<JSONObject?>(null)
        private set
    private var custodyUpdated: java.time.Instant? = null
    private var custodyQuery = ""
    private var custodySelected: String? = null
    val canUseCustody get() = memberReady && custodyBoard?.enabled == true && custodyBoard?.employee == identity?.employeeId && identity?.allows("bottle.manage.all") == true && custodyUpdated?.let { java.time.Duration.between(it,java.time.Instant.now()).seconds in 0..59 } == true
    private suspend fun fetchCustody() {
        val actor = identity ?: error("请登录")
        require(actor.allows("bottle.manage.all")) { "无存酒管理权限" }
        val board = withContext(Dispatchers.IO) {
            val capability = api.data("$custodyRoot/native-capabilities")
            val config = api.data("$custodyRoot/policy")
            val rows = api.data(custodyRoot + if(custodyQuery.isBlank()) "" else "?$custodyQuery")
            val detail = custodySelected?.let { api.data("$custodyRoot/${LiveCommand.part(it)}") }
            CustodyBoard(config,rows,capability,detail)
        }
        require(actor.employeeId == identity?.employeeId && board.employee == actor.employeeId)
        custodyBoard = board; custodyUpdated = java.time.Instant.now(); custodyState = "已读取存酒记录"
    }
    fun loadCustody(query: String = custodyQuery, selected: String? = custodySelected) {
        if(!live || busy || heartbeatBusy) return
        busy = true; custodyUpdated = null; custodyQuery = query; custodySelected = selected; custodyReceipt = null; custodyState = "正在读取存酒"
        viewModelScope.launch {
            try { identity = withContext(Dispatchers.IO) { api.heartbeat() }; fetchCustody() }
            catch(e: Exception) { custodyBoard = null; custodyState = if((e as? StaffAPIError)?.status == 404) "配套后台尚未启用原生存酒，请保留现有凭证" else e.message ?: "读取失败"; handleLiveError(e) }
            finally { busy = false }
        }
    }
    suspend fun readCustodyExtra(suffix: String): JSONObject {
        require(live && !busy && !heartbeatBusy && identity?.allows("bottle.manage.all") == true)
        require(suffix.startsWith("/member-contact?") || suffix.startsWith("/source-order?") || suffix.startsWith("/report?") || Regex("^/[a-f0-9-]{36}/photos/[a-f0-9-]{36}$").matches(suffix))
        val original = priorityAccessKey; val version = workspaceVersion
        busy = true
        try { identity = withContext(Dispatchers.IO) { api.heartbeat() }; require(priorityAccessKey == original)
            val value = withContext(Dispatchers.IO) { api.data(custodyRoot + suffix) }
            require(priorityAccessKey == original && workspaceVersion == version); return value
        } catch(e: kotlinx.coroutines.CancellationException) { throw e } catch(e: Exception) { handleLiveError(e); throw e } finally { busy = false }
    }

    val priorityAccessKey get() = identity?.let{it.employeeId+":"+it.permissions.sorted().joinToString(",")+":"+it.denied.sorted().joinToString(",")}?:"signed-out"
    suspend fun queryProductConfigurationChoices(query:String,offset:Int,singleOnly:Boolean=true):List<JSONObject>{
        val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion;require(actor.allows("catalog.product.manage"))
        val board=withContext(Dispatchers.IO){ProductManagementBoard(api.data("/api/native/catalog/products?status=all&limit=50&offset=$offset&search="+LiveCommand.part(query)))}
        require(board.employee==actor.employeeId&&access==priorityAccessKey&&version==workspaceVersion);return board.products.filter{!singleOnly||it.getString("productKind")=="single"}
    }
    var productBoard by mutableStateOf<ProductManagementBoard?>(null)
    var productState by mutableStateOf("请读取商品")
    private var productUpdated: java.time.Instant? = null
    private var productQuery = ""
    private var productOffset = 0
    val canUseProducts
        get() =
            memberReady &&
                productBoard?.durable == true &&
                productBoard?.employee == identity?.employeeId &&
                identity?.allows("catalog.product.manage") == true &&
                productUpdated != null

    fun loadProducts(query: String = "", offset: Int = 0) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        productBoard = null
        productUpdated = null
        productQuery = query
        productOffset = offset
        productState = "正在读取商品"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchProducts()
            } catch (e: Exception) {
                productState =
                    if ((e as? StaffAPIError)?.status == 404) "服务器尚未启用原生商品管理，请使用网页入口"
                    else e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchProducts() {
        val actor = identity ?: error("请登录")
        check(actor.allows("catalog.product.manage")) { "无商品管理权限" }
        val board =
            withContext(Dispatchers.IO) {
                ProductManagementBoard(
                    api.data(
                        "/api/native/catalog/products?status=all&limit=40&offset=$productOffset&search=" +
                            LiveCommand.part(productQuery)
                    )
                )
            }
        check(
            board.durable &&
                board.employee == actor.employeeId &&
                identity?.employeeId == actor.employeeId &&
                board.products.map { it.getString("id") }.toSet().size == board.products.size
        ) {
            "员工或商品回执不匹配"
        }
        productBoard = board
        productUpdated = java.time.Instant.now()
        productState = "已同步商品；显示${board.products.size}项，按页查询全部状态。"
    }

    var stockCounts by mutableStateOf<StockCountPage?>(null)
    var stockWaste by mutableStateOf<StockWastePage?>(null)
    var stockAuditState by mutableStateOf("请读取盘点与报损")
    var stockCountDraft by mutableStateOf<List<JSONObject>>(emptyList())
    private var stockAuditUpdated: java.time.Instant? = null
    private var stockCountFilter = "submitted"
    private var stockCountPage = 0
    private var stockWastePage = 1
    private val countDraftFile =
        android.util.AtomicFile(java.io.File(app.filesDir, "mbox-count-drafts-v1.json"))
    val canUseStockAudit
        get() =
            canUseStock &&
                stockAuditUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    private fun countBook(): JSONObject =
        if (countDraftFile.baseFile.exists())
            JSONObject(countDraftFile.openRead().bufferedReader().use { it.readText() })
        else JSONObject()

    fun saveCountDraft(lines: List<JSONObject>) {
        check(canUseStock && identity?.allows("inventory.count") == true) { "请刷新库存" }
        saveStockFile(
            countDraftFile,
            countBook().put(identity!!.employeeId, org.json.JSONArray(lines)),
        )
        stockCountDraft = lines
    }

    fun loadStockAudit(filter: String = "submitted", page: Int = 0, wastePage: Int = 1) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        stockCounts = null
        stockWaste = null
        stockAuditUpdated = null
        stockCountFilter = filter
        stockCountPage = page
        stockWastePage = wastePage
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchStock()
                fetchStockAudit()
            } catch (e: Exception) {
                stockAuditState = e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchStockAudit() {
        val actor = identity ?: error("请登录")
        if (actor.allows("inventory.count") || actor.allows("inventory.count.approve")) {
            val page =
                withContext(Dispatchers.IO) {
                    StockCountPage(
                        api.data(
                            "/api/native/inventory/stock-counts?status=$stockCountFilter&page=$stockCountPage&pageSize=20"
                        )
                    )
                }
            check(page.durable && page.employee == actor.employeeId) { "原员工不匹配" }
            stockCounts = page
        }
        if (actor.allows("inventory.waste") || actor.allows("inventory.count.approve")) {
            val page =
                withContext(Dispatchers.IO) {
                    StockWastePage(
                        api.data("/api/native/inventory/waste-requests?page=$stockWastePage")
                    )
                }
            check(page.durable && page.employee == actor.employeeId) { "原员工不匹配" }
            stockWaste = page
        }
        check(identity?.employeeId == actor.employeeId) { "员工已变化" }
        stockAuditUpdated = java.time.Instant.now()
        stockAuditState = "已同步盘点和报损；待审申请不会提前扣库存。"
    }

    var stockBoard by mutableStateOf<StockBoard?>(null)
    var stockState by mutableStateOf("请读取库存与采购单")
    var stockDraft by mutableStateOf<List<StockLine>>(emptyList())
    var stockSupplierName by mutableStateOf("")
        private set
    var stockReceipt by mutableStateOf<JSONObject?>(null)
    private var stockEmployee: String? = null
    private var stockUpdated: java.time.Instant? = null
    private val stockDraftFile =
        android.util.AtomicFile(java.io.File(app.filesDir, "mbox-stock-drafts-v1.json"))
    private val stockReceiptFile =
        android.util.AtomicFile(java.io.File(app.filesDir, "mbox-stock-receipt-v1.json"))
    val canUseStock
        get() =
            memberReady &&
                stockBoard?.durable == true &&
                stockEmployee == identity?.employeeId &&
                stockUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    private fun stockBook(): JSONObject =
        if (stockDraftFile.baseFile.exists())
            JSONObject(stockDraftFile.openRead().bufferedReader().use { it.readText() })
        else JSONObject()

    private fun saveStockFile(file: android.util.AtomicFile, data: JSONObject) {
        val stream = file.startWrite()
        try {
            stream.write(data.toString().toByteArray())
            file.finishWrite(stream)
        } catch (e: Exception) {
            file.failWrite(stream)
            throw e
        }
    }

    fun saveStockDraft(lines: List<StockLine>, supplier: String = stockSupplierName) {
        check(canUseStock && identity?.allows("inventory.receive") == true) { "请刷新库存并核对员工权限" }
        val name = normalizedStockSupplierName(supplier)
        val book = stockDraftBookEntry(stockBook(), identity!!.employeeId, lines, name)
        saveStockFile(stockDraftFile, book)
        stockDraft = lines
        stockSupplierName = name
    }

    private var stockQuery=""
    fun loadStock(query:String=stockQuery) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        stockBoard = null
        stockUpdated = null
        stockQuery=query
        stockState = "正在读取库存与采购单"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchStock()
            } catch (e: Exception) {
                stockState =
                    if ((e as? StaffAPIError)?.status == 404) "当前服务器尚未启用原生库存，请继续使用网页库存入口。"
                    else e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchStock() {
        val actor = identity ?: error("请登录")
        check(StockBoard.permissions.any { actor.allows(it) }) { "当前岗位没有库存权限" }
        val board = withContext(Dispatchers.IO) { StockBoard(api.data("/api/native/inventory"+if(stockQuery.isBlank()) "" else "?$stockQuery")) }
        require(
            board.employee == actor.employeeId &&
                board.durable &&
                board.items.map { it.getString("id") }.toSet().size == board.items.size
        )
        val savedDrafts = stockBook()
        stockDraft =
            savedDrafts.optJSONArray(actor.employeeId)?.objects()?.map(StockLine::parse)
                ?: emptyList()
        stockSupplierName = stockDraftSupplier(savedDrafts, actor.employeeId)
        stockCountDraft = countBook().optJSONArray(actor.employeeId)?.objects() ?: emptyList()
        stockBoard = board
        stockEmployee = actor.employeeId
        stockUpdated = java.time.Instant.now()
        stockState = "库存已同步；低库存提示需结合实物核对。"
        if (stockReceiptFile.baseFile.exists()) {
            val saved =
                JSONObject(stockReceiptFile.openRead().bufferedReader().use { it.readText() })
            if (saved.getString("employeeID") == actor.employeeId) stockReceipt = saved
        }
    }

    suspend fun lookupStockCode(code: String): JSONObject {
        val actor = identity ?: error("请登录")
        check(canUseStock && actor.allows("inventory.receive") && code.length in 1..128) {
            "请刷新库存并输入有效条码"
        }
        val scan =
            withContext(Dispatchers.IO) {
                api.data(
                    "/api/native/inventory/scan?code=" + java.net.URLEncoder.encode(code, "UTF-8")
                )
            }
        require(
            identity?.employeeId == actor.employeeId &&
                scan.getString("currentEmployeeId") == actor.employeeId &&
                scan.getString("code") == code &&
                stockBoard?.items?.any {
                    it.getString("id") == scan.getString("inventoryItemId")
                } == true
        )
        return scan
    }

    var inventorySetupBoard by mutableStateOf<InventorySetupBoard?>(null)
        private set
    var inventorySetupState by mutableStateOf("请读取物料与包装条码")
        private set
    private var inventorySetupUpdated: java.time.Instant? = null
    val canUseInventorySetup
        get() = memberReady && !businessRequestInFlight && identity?.allows("inventory.manage") == true &&
            inventorySetupBoard?.enabled == true &&
            inventorySetupBoard?.actor == identity?.employeeId && inventoryReadFresh(inventorySetupUpdated)

    private fun inventoryReadFresh(updated: java.time.Instant?) = updated?.let {
        java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
    } == true

    fun loadInventorySetup() {
        if (!live || businessRequestInFlight) return
        val original = workspaceReadIdentity()
        busy = true
        // Keep the employee's editing form mounted while revalidating. The old
        // board is display-only until a fresh capability response is accepted.
        inventorySetupUpdated = null
        inventorySetupState = "正在读取物料与包装条码"
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                fetchInventorySetup()
            } catch (e: kotlinx.coroutines.CancellationException) { throw e
            } catch (e: Exception) {
                inventorySetupState = if ((e as? StaffAPIError)?.status == 404)
                    "当前服务器尚未启用原生物料设置，请使用网页库存入口。"
                else e.message ?: "物料读取失败，请重试"
                handleLiveError(e)
            } finally { busy = false }
        }
    }

    private suspend fun fetchInventorySetup() {
        val actor = identity ?: error("请登录")
        require(actor.allows("inventory.manage")) { "当前岗位没有物料设置权限" }
        val expected = workspaceReadIdentity()
        val board = readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
            withContext(Dispatchers.IO) { InventorySetupBoard(api.data("/api/native/inventory/setup")) }
        }
        require(board.enabled && board.actor == actor.employeeId) { "服务器尚未启用安全物料设置，或员工已变化" }
        inventorySetupBoard = board
        inventorySetupUpdated = java.time.Instant.now()
        inventorySetupState = "物料与包装条码已同步；修改前请核对计量单位。"
    }

    var inventoryPublishBoard by mutableStateOf<InventoryPublishBoard?>(null)
        private set
    var inventoryPublishPreview by mutableStateOf<InventoryPublishPreview?>(null)
        private set
    var inventoryPublishState by mutableStateOf("请选择待验收采购单与商品")
        private set
    private var inventoryPublishUpdated: java.time.Instant? = null
    private var inventoryPublishPreviewUpdated: java.time.Instant? = null
    val canUseInventoryPublish
        get() = memberReady && !businessRequestInFlight && inventoryPublishPermissions.all { identity?.allows(it) == true } &&
            inventoryPublishBoard?.enabled == true && inventoryPublishBoard?.actor == identity?.employeeId &&
            inventoryReadFresh(inventoryPublishUpdated)

    fun loadInventoryPublish(receiptId: String) {
        if (!live || businessRequestInFlight) return
        val original = workspaceReadIdentity()
        busy = true
        inventoryPublishBoard = null
        inventoryPublishPreview = null
        inventoryPublishUpdated = null
        inventoryPublishPreviewUpdated = null
        inventoryPublishState = "正在读取采购单与可发布商品"
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                fetchInventoryPublish(receiptId)
            } catch (e: kotlinx.coroutines.CancellationException) { throw e
            } catch (e: Exception) {
                inventoryPublishState = if ((e as? StaffAPIError)?.status == 404)
                    "当前服务器尚未启用原生验收发布，请使用网页库存入口。"
                else e.message ?: "采购单读取失败，请重试"
                handleLiveError(e)
            } finally { busy = false }
        }
    }

    private suspend fun fetchInventoryPublish(receiptId: String) {
        val actor = identity ?: error("请登录")
        require(inventoryPublishPermissions.all(actor::allows)) { "需要收货、商品管理和成本查看权限" }
        val expected = workspaceReadIdentity()
        val board = readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
            withContext(Dispatchers.IO) {
                InventoryPublishBoard(api.data("/api/native/inventory/receipts/${LiveCommand.part(receiptId)}/publish-options"))
            }
        }
        require(board.enabled && board.actor == actor.employeeId && board.receipt.getString("id") == receiptId) {
            "服务器未启用安全验收发布，或采购单已变化"
        }
        inventoryPublishBoard = board
        inventoryPublishUpdated = java.time.Instant.now()
        inventoryPublishState = "请选择商品并核对本次收货后的配方成本与售价。"
    }

    fun loadInventoryPublishPreview(receiptId: String, productId: String) {
        if (!canUseInventoryPublish) { message = "请刷新采购单并核对发布权限"; return }
        if (inventoryPublishBoard?.receipt?.optString("id") != receiptId ||
            inventoryPublishBoard?.products?.none { it.optString("id") == productId } != false) {
            message = "商品或采购单已变化，请重新选择"; return
        }
        busy = true
        inventoryPublishPreview = null
        inventoryPublishPreviewUpdated = null
        inventoryPublishState = "正在核算收货后的成本与售价"
        val expected = workspaceReadIdentity()
        viewModelScope.launch {
            try {
                val preview = readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) {
                        InventoryPublishPreview(api.data("/api/native/inventory/receipts/${LiveCommand.part(receiptId)}/receive-and-publish-preview?productId=${LiveCommand.part(productId)}"))
                    }
                }
                require(preview.enabled && preview.actor == identity?.employeeId &&
                    preview.receiptId == receiptId && preview.productId == productId &&
                    inventoryPublishBoard?.receipt?.optString("id") == receiptId) { "预览不属于当前采购单与商品，请重试" }
                inventoryPublishPreview = preview
                inventoryPublishPreviewUpdated = java.time.Instant.now()
                inventoryPublishState = "仅为预览；确认实物、成本与售价后才会入库并发布。"
            } catch (e: kotlinx.coroutines.CancellationException) { throw e
            } catch (e: Exception) {
                inventoryPublishState = e.message ?: "预览读取失败，请重试"
                handleLiveError(e)
            } finally { busy = false }
        }
    }

    var serviceAttention by mutableStateOf(ServiceAttention())
    var serviceBoard by mutableStateOf<LiveServiceBoard?>(null)
    var serviceState by mutableStateOf("")
    var serviceUpdated: java.time.Instant? = null
    val canUseService
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                serviceBoard?.enabled == true &&
                serviceBoard?.employee == identity?.employeeId &&
                identity?.allows("service.execute") == true &&
                serviceUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    var observationBoard by mutableStateOf<ObservationBoard?>(null)
    var recommendationBoard by mutableStateOf<RecommendationBoard?>(null)
    var observationState by mutableStateOf("")
    var observationEmployee: String? = null
    var observationUpdated: java.time.Instant? = null
    val canUseObservation
        get() =
            memberReady &&
                observationEmployee == identity?.employeeId &&
                observationUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    var benefitBoard by mutableStateOf<BenefitFulfillmentBoard?>(null)
    var benefitState by mutableStateOf("请读取权益兑付队列")
    private var benefitUpdated: java.time.Instant? = null
    private var benefitEmployee: String? = null
    val canUseBenefits
        get() =
            memberReady &&
                benefitEmployee == identity?.employeeId &&
                identity?.allows("loyalty.redemption.fulfill") == true &&
                benefitBoard?.enabled == true &&
                java.time.Duration.between(
                        benefitUpdated ?: java.time.Instant.EPOCH,
                        java.time.Instant.now(),
                    )
                    .seconds < 60

    var memberAccount by mutableStateOf<JSONObject?>(null)
    var memberParticipation by mutableStateOf<JSONObject?>(null)
    var memberVisit by mutableStateOf<MemberVisitStatus?>(null)
    var memberRewards by mutableStateOf<MemberRewardBoard?>(null)
    var memberState by mutableStateOf("")
    var memberRewardState by mutableStateOf("")
    var memberEmployee: String? = null
    var memberRewardEmployee: String? = null
    var memberUpdated: java.time.Instant? = null
    var memberRewardUpdated: java.time.Instant? = null
    var memberRewardFilter = "pending"
    private val memberReady
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    val canUseMember
        get() =
            memberReady &&
                memberEmployee == identity?.employeeId &&
                memberVisit?.enabled == true &&
                identity?.allows("loyalty.account.view") == true &&
                identity?.allows("customer.relationship.manage") == true &&
                memberUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    val canUseMemberRewards
        get() =
            memberReady &&
                memberRewardEmployee == identity?.employeeId &&
                memberRewards?.enabled == true &&
                identity?.allows("loyalty.configuration.approve") == true &&
                memberRewardUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    var deviceBoard by mutableStateOf<DeviceBoard?>(null)
    var deviceState by mutableStateOf("请读取打印设备")
    var bridgeRevocationEnabled by mutableStateOf(false)
    var bridgePairing by mutableStateOf<JSONObject?>(null)
    private var bridgePairingGeneration = 0
    fun clearBridgePairing() { bridgePairing = null; bridgePairingGeneration++ }
    fun createBridgePairing(reason: String) {
        if(!canUseDevices) return
        if(reason.trim().length !in 3..500) { message = "请填写3至500字配对说明"; return }
        clearBridgePairing(); val generation = bridgePairingGeneration; val access = priorityAccessKey
        busy = true
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                require(priorityAccessKey == access)
                val result = withContext(Dispatchers.IO) { api.data("/api/hardware/print-bridges/pairing-code", JSONObject().put("reason",reason.trim()).put("ttlSeconds",600)) }
                require(Regex("^[A-F0-9]{5}(-[A-F0-9]{5}){3}$").matches(result.getString("pairingCode")))
                require(assignmentDate(result.getString("expiresAt"))?.isAfter(java.time.Instant.now()) == true)
                if(generation == bridgePairingGeneration && priorityAccessKey == access) bridgePairing = result
            } catch(e: Exception) { message = "配对码未能显示。不会自动重试；如需重新生成，请手动操作，之前可能已生成的码10分钟后失效。\n" + (e.message ?: "请检查网络"); handleLiveError(e) }
            finally { busy = false }
        }
    }
    var printBridges by mutableStateOf<List<JSONObject>>(emptyList())
    private var deviceUpdated: java.time.Instant? = null
    val canUseDevices get() = memberReady && deviceBoard?.employee == identity?.employeeId && deviceBoard?.enabled == true &&
        identity?.let { it.allows("hardware.manage") || it.allows("printer.manage") } == true &&
        deviceUpdated?.let { java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59 } == true

    var songs by mutableStateOf<List<LiveSong>>(emptyList())
    var songState by mutableStateOf("请读取点歌队列")
    var songFilter by mutableStateOf("requested")
    var songEnabled by mutableStateOf(false)
    var songEvidence by mutableStateOf<List<JSONObject>>(emptyList())
    var songEvidenceID by mutableStateOf<String?>(null)
    var performances by mutableStateOf<JSONObject?>(null)
    private var songUpdated: java.time.Instant? = null
    private var songEmployee: String? = null
    val canUseSongs get() = memberReady && songEmployee == identity?.employeeId && songEnabled &&
        songUpdated?.let { java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59 } == true

    private var receptionViewGeneration = 0L
    private var receptionRequestGeneration = 0L
    private var receptionTarget: String? = null
    private data class ReceptionReadToken(val view: Long, val request: Long, val target: String?,
        val authorityEpoch: Long, val identity: WorkspaceReadIdentity)

    private var receptionPreparedId: String? = null
    private var receptionPreparedToken: ReceptionReadToken? = null
    fun isReceptionViewCurrent(token: Long) = token == receptionViewGeneration

    fun invalidateReceptionRead(viewToken: Long? = null) {
        if (viewToken != null && !isReceptionViewCurrent(viewToken)) return
        receptionRequestGeneration++
        receptionPreparedId = null; receptionPreparedToken = null
        receptionOptions = null; receptionSessions = null; receptionDetail = null
        receptionOptionsUpdated = null; receptionSessionsUpdated = null; receptionActor = null
    }

    fun selectReception(id: String?): Long {
        receptionViewGeneration++
        receptionTarget = id
        invalidateReceptionRead()
        receptionState = if (id == null) "" else if (busy) "等待原读取结束后刷新当前预约" else "请读取当前预约"
        return receptionViewGeneration
    }
    fun beginReceptionCreation(): Long = selectReception("create")
    fun closeReceptionView(token: Long) { if (token == receptionViewGeneration) selectReception(null) }
    private fun receptionToken() = ReceptionReadToken(receptionViewGeneration, receptionRequestGeneration,
        receptionTarget, receptionAuthorityEpoch, workspaceReadIdentity())
    private fun receptionReadCurrent(token: ReceptionReadToken) = token == receptionToken()
    private fun requireReceptionRead(token: ReceptionReadToken) {
        if (!receptionReadCurrent(token)) throw CancellationException("忽略已离开页面或旧权限下的预约读取")
    }

    var receptionOptions by mutableStateOf<ReservationReceptionOptions?>(null)
        private set
    var receptionSessions by mutableStateOf<ReservationReceptionSessions?>(null)
        private set
    var receptionDetail by mutableStateOf<ReservationReceptionDetail?>(null)
        private set
    var receptionState by mutableStateOf("")
        private set
    private var receptionOptionsUpdated: java.time.Instant? = null
    private var receptionSessionsUpdated: java.time.Instant? = null
    private var receptionActor: String? = null
    private fun freshReception(at: java.time.Instant?) = at?.let {
        java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
    } == true
    private val receptionReady get() = live && !busy && !heartbeatBusy && !liveStorageDamaged &&
        livePending == null && liveOrderPending == null && identity?.allows("reservation.manage") == true &&
        receptionActor == identity?.employeeId &&
        identity?.onlineLeaseUntil?.let(::assignmentDate)?.isAfter(java.time.Instant.now()) == true &&
        reservationCapabilities?.opt("admissionCreateV1") == true && reservationCapabilities?.opt("receptionSeatV1") == true
    val canCreateReception get() = receptionReady && receptionTarget == "create" && receptionOptions != null && freshReception(receptionOptionsUpdated)
    val canSeatReception get() = receptionReady && identity?.allows("table.open") == true &&
        receptionSessions?.status == "arrived" && receptionTarget == receptionSessions?.reservationId &&
        receptionDetail?.reservation?.id == receptionSessions?.reservationId &&
        freshReception(receptionSessionsUpdated)

    var reservations by mutableStateOf<List<LiveReservation>>(emptyList())
    var reservationIntake by mutableStateOf<List<LiveReservationIntake>>(emptyList())
    var reservationState by mutableStateOf("")
    var reservationTables by mutableStateOf<List<ReservationTable>>(emptyList())
    var reservationCapabilities by mutableStateOf<JSONObject?>(null)
    var reservationQuery =
        ReservationQuery("current", ReservationQuery.day(), ReservationQuery.day())
    var reservationUpdated: java.time.Instant? = null
    var reservationEmployee: String? = null
    val canUseReservations
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows("reservation.manage") == true &&
                reservationEmployee == identity?.employeeId &&
                reservationCapabilities?.optBoolean("durableTransitions") == true &&
                reservationUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    var participants by mutableStateOf<List<LiveParticipant>>(emptyList())
    var participantState by mutableStateOf("")
    var participantInput by mutableStateOf<ParticipantInput?>(null)
    var participantPreview by mutableStateOf<ParticipantPreview?>(null)
    private var participantUpdated: java.time.Instant? = null
    private var participantPrepared: LiveCommand? = null
    val canUseParticipants
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(ParticipantInput.permission) == true &&
                participantInput?.employeeID == identity?.employeeId &&
                participantUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity?.onlineLeaseUntil?.let {
                    runCatching { serverInstant(it).isAfter(java.time.Instant.now()) }
                        .getOrDefault(false)
                } == true

    var liveOperations by mutableStateOf<LiveOperations?>(null)
        private set

    var lastUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var workspaceVersion by mutableIntStateOf(0)
        private set

    var foreground by mutableStateOf(false)
    private var heartbeatBusy by mutableStateOf(false)
    val businessRequestInFlight get() = busy || heartbeatBusy || onlinePolling
    var liveOrderPending by mutableStateOf<LiveOrderSubmission?>(null)
        private set

    var lastOrderReceipt by mutableStateOf<LiveOrderReceipt?>(null)
        private set

    private val orderPendingFile = AtomicFile(File(app.filesDir, "live-order-v1.json"))
    var livePending by mutableStateOf<LiveCommand?>(null)
        private set

    var liveStorageDamaged by mutableStateOf(false)
        private set

    var liveOrders by mutableStateOf<List<LiveOrderDetail>>(emptyList())
        private set

    var assignmentsBoard by mutableStateOf<LiveAssignments?>(null)
        private set

    var assignmentsUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var assignmentsState by mutableStateOf("")
        private set

    var assignmentReceipt by mutableStateOf("")
        private set

    private var assignmentsActorID: String? = null
    var cashHandover by mutableStateOf<JSONObject?>(null)
        private set

    var cashHandoverState by mutableStateOf("")
    private var cashHandoverUpdated: java.time.Instant? = null
    private var cashHandoverActor: String? = null
    val canUseCashHandover
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                cashHandoverActor == identity?.employeeId &&
                cashHandoverUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                cashHandover?.optBoolean("canCount") == true &&
                identity?.allows("reconciliation.view") == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    var voucherHistory by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var voucherHistoryState by mutableStateOf("")
    var voucherPlatforms by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var voucherOperations by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var voucherPreview by mutableStateOf<JSONObject?>(null)
        private set

    var voucherState by mutableStateOf("")
    var voucherUpdated by mutableStateOf<java.time.Instant?>(null)
    var voucherActor by mutableStateOf<String?>(null)
    private var voucherCode = ""
    val canReadVouchers
        get() = identity?.allows("commercial.voucher.view") == true

    val canUseVouchers
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                voucherActor == identity?.employeeId &&
                voucherUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity?.allows("commercial.voucher.redeem") == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    var printJobs by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var printSources by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var ownPrintJobs by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var printState by mutableStateOf("")
    var printUpdated by mutableStateOf<java.time.Instant?>(null)
    var printActor by mutableStateOf<String?>(null)
    private val printReceiptFile = AtomicFile(File(app.filesDir, "print-receipt-v1.json"))
    var printReceipt by
        mutableStateOf(
            runCatching {
                    JSONObject(printReceiptFile.openRead().bufferedReader().use { it.readText() })
                }
                .getOrNull()
        )
        private set

    val canReadPrinting
        get() =
            listOf(
                    "order.bill.print",
                    "print.view",
                    "print.view_all",
                    "print.reprint",
                    "hardware.manage",
                    "printer.manage",
                )
                .any { identity?.allows(it) == true }

    val canUsePrinting
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                printActor == identity?.employeeId &&
                printUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    var fulfillmentBoard by mutableStateOf<LiveFulfillment?>(null)
    var fulfillmentUpdated by mutableStateOf<java.time.Instant?>(null)
    var fulfillmentState by mutableStateOf("")
    val canReadFulfillment
        get() =
            identity?.let { a ->
                listOf(
                        "order.view",
                        "kds.prepare",
                        "kds.deliver",
                        "kds.exception.manage",
                        "fulfillment.view_all",
                    )
                    .any { a.allows(it) }
            } == true

    val canUseFulfillment
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity != null &&
                fulfillmentBoard?.employeeID == identity?.employeeId &&
                fulfillmentBoard?.actor?.optBoolean("actionSessionValid") == true &&
                fulfillmentBoard?.actor?.optBoolean("supportsNativePhysicalRecovery") == true &&
                identity?.let {
                    runCatching {
                            serverInstant(it.onlineLeaseUntil)
                                .isAfter(java.time.Instant.now())
                        }
                        .getOrDefault(false)
                } == true &&
                fulfillmentUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

    var afterSales by mutableStateOf<LiveAfterSales?>(null)
    var afterSalesUpdated by mutableStateOf<java.time.Instant?>(null)
    var afterSalesActor by mutableStateOf<String?>(null)
    var afterSalesState by mutableStateOf("")
    var afterSalesPendingRows by mutableStateOf<List<JSONObject>>(emptyList())
    var afterSalesCursor by mutableStateOf<JSONObject?>(null)
    val canReadAfterSales
        get() =
            listOf("refund.request", "refund.approve", "refund.execute").any {
                identity?.allows(it) == true
            }

    val canUseAfterSales
        get() =
            live &&
                canReadAfterSales &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                afterSales != null &&
                afterSalesActor == identity?.employeeId &&
                afterSalesUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true

    var financeSummary by mutableStateOf<JSONObject?>(null)
        private set

    var financeEntries by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var financeReviews by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var financeNext by mutableStateOf<String?>(null)
        private set

    var financeMoreReviews by mutableStateOf(false)
        private set

    var financeReviewPage by mutableIntStateOf(0)
        private set

    var financeUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var financeState by mutableStateOf("")
        private set

    var financeQuery by mutableStateOf(FinanceQuery())
        private set

    private var financeActorID: String? = null
    private val financeReceiptFile = AtomicFile(File(app.filesDir, "finance-receipt-v1.json"))
    var financeReceipt by
        mutableStateOf<JSONObject?>(
            runCatching {
                    JSONObject(financeReceiptFile.openRead().bufferedReader().use { it.readText() })
                }
                .getOrNull()
        )
        private set

    var cashier by mutableStateOf<LiveCashier?>(null)
        private set

    var cashierUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var cashierState by mutableStateOf("")
        private set

    var cashierQuery by mutableStateOf("")
        private set

    var history by mutableStateOf<LiveHistory?>(null)
        private set

    var historyState by mutableStateOf("")
        private set

    var historyQuery by mutableStateOf(HistoryQuery())
        private set

    var pickupBoard by mutableStateOf<LivePickup?>(null)
        private set

    var pickupUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var pickupState by mutableStateOf("")
        private set

    var kitchenBoard by mutableStateOf<LiveKitchen?>(null)
        private set

    var kitchenUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var kitchenState by mutableStateOf("")
        private set

    var onlineAccess by mutableStateOf<JSONObject?>(null)
        private set

    private val paymentSecrets = PaymentSecrets(app)
    private val custodyReceiptSecrets = PaymentSecrets(app,"custody-receipt")
    private val onlineReceiptFile = AtomicFile(File(app.filesDir, "online-receipts-v1.json"))
    var onlineReceipts by
        mutableStateOf<JSONObject>(
            runCatching {
                    JSONObject(onlineReceiptFile.openRead().bufferedReader().use { it.readText() })
                }
                .getOrDefault(JSONObject())
        )
        private set

    var onlineStatuses by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    var onlineState by mutableStateOf("")
        private set

    private var onlinePolling = false
    var paymentOrders by mutableStateOf<List<LivePaymentOrder>>(emptyList())
        private set

    var paymentState by mutableStateOf("")
        private set

    var paymentSession by mutableStateOf<String?>(null)
        private set

    var paymentUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    var orderDetailState by mutableStateOf("")
        private set

    var liveProducts by mutableStateOf<List<LiveProduct>>(emptyList())
        private set

    var catalogState by mutableStateOf("")
        private set

    var catalogUpdated by mutableStateOf<java.time.Instant?>(null)
        private set

    private var liveDraftBook by mutableStateOf(LiveDraftBook())
    var draftStorageDamaged by mutableStateOf(false)
        private set

    private val liveDraftFile = AtomicFile(File(app.filesDir, "live-drafts-v1.json"))
    private val liveFile = AtomicFile(File(app.filesDir, "live-pending-v1.json"))
    val api = apiOverride ?: StaffAPI(credentialStore = KeystoreStaffSessionStore(app))
    var rememberLogin by mutableStateOf(false)
    var savedLoginAvailable by mutableStateOf(false)
    private var restoreAttempted = false
    private val deviceKey =
        app.getSharedPreferences("native-device", 0).let { prefs ->
            prefs.getString("key", null)
                ?: ("android-" + java.util.UUID.randomUUID().toString()).also {
                    prefs.edit().putString("key", it).apply()
                }
        }
    private val file = AtomicFile(File(app.filesDir, "training-v1.bin"))

    init {
        try {
            liveOrderPending =
                LiveOrderSubmission.parse(
                    JSONObject(orderPendingFile.openRead().bufferedReader().use { it.readText() })
                )
        } catch (_: FileNotFoundException) {} catch (_: Exception) {
            liveStorageDamaged = true
            message = "待确认订单记录无法读取，真实操作已锁定"
        }
        try {
            livePending =
                LiveCommand.parse(
                    JSONObject(liveFile.openRead().bufferedReader().use { it.readText() })
                )
            livePending?.takeIf { it.steps.singleOrNull()?.reservationProof?.optString("kind") == "create" && it.steps.single().receptionPayloadKey == null }?.let {
                val secured = secureReservationReceptionCommand(it, receptionSecrets)
                saveLive(secured)
                livePending = secured
            }
            livePending?.let(::validateReservationReceptionPending)
        } catch (_: FileNotFoundException) {} catch (_: Exception) {
            liveStorageDamaged = true
            message = "未决操作记录无法读取，真实写操作已锁定，请联系管理员"
        }
        try {
            liveDraftBook =
                LiveDraftBook.parse(
                    JSONObject(liveDraftFile.openRead().bufferedReader().use { it.readText() })
                )
        } catch (_: FileNotFoundException) {} catch (_: Exception) {
            draftStorageDamaged = true
        }
        // Employee packages must never restore sample tables or demo pending commands.
        // Keep the old training file intact for separately enabled development previews.
    }

    private fun readTraining() {
        try {
            ObjectInputStream(file.openRead()).use {
                val saved = it.readObject() as Saved
                world = saved.world
                pending = saved.pending
            }
        } catch (_: FileNotFoundException) {} catch (_: Exception) {
            message = "本地演练存档无法读取，请检查或重置"
        }
    }

    private fun save(w: World = world, p: Command? = pending) {
        val stream = file.startWrite()
        try {
            val bytes =
                ByteArrayOutputStream()
                    .also { ObjectOutputStream(it).use { out -> out.writeObject(Saved(w, p)) } }
                    .toByteArray()
            stream.write(bytes)
            file.finishWrite(stream)
        } catch (e: Exception) {
            file.failWrite(stream)
            throw e
        }
    }

    fun draft(session: String) = world.drafts[session] ?: emptyList()

    fun change(p: Product, variant: String, session: String, delta: Int) {
        if (live || busy || pending != null) return
        val lines = draft(session).toMutableList()
        val i = lines.indexOfFirst { it.productID == p.id && it.variant == variant }
        if (i >= 0) {
            val n = (lines[i].quantity + delta).coerceAtMost(99)
            if (n <= 0) lines.removeAt(i) else lines[i] = lines[i].copy(quantity = n)
        } else if (delta > 0) lines.add(Line(p.id, p.name, p.price, 1, variant))
        try {
            val next = world.copy(drafts = world.drafts + (session to lines))
            save(next)
            world = next
        } catch (_: Exception) {
            message = "草稿保存失败，请检查设备空间"
        }
    }

    fun execute(c: Command) {
        if (live || busy || pending != null) {
            message = "请先确认原操作结果"
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                save(p = c)
                pending = c
                delay(350)
                val (next, receipt) = world.apply(c)
                save(next, c)
                world = next
                if (simulateTimeout) {
                    simulateTimeout = false
                    message = "演练：回执中断。请核对原操作结果。"
                } else finish(receipt)
            } catch (e: IllegalArgumentException) {
                try {
                    save(p = null)
                    pending = null
                    message = e.message ?: "操作不允许"
                } catch (_: Exception) {
                    message = "本地保存失败，原请求仍保留，请检查设备空间后核对"
                }
            } catch (e: Exception) {
                message = "操作未确认，请核对原请求：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    private fun finish(r: Receipt) {
        save(p = null)
        pending = null
        message =
            if (r.kind == "cash") "演练收款已记录 ${money(r.applied)} · 找零 ${money(r.change)}" else "操作已保存"
    }

    fun recover() {
        val c = pending ?: return
        if (busy || live) return
        try {
            val (next, r) = world.apply(c)
            save(next, c)
            world = next
            finish(r)
        } catch (e: Exception) {
            message = e.message ?: "暂时无法确认"
        }
    }

    fun reset() {
        if (live || busy || pending != null) return
        try {
            val next = World.training()
            save(next, null)
            world = next
            message = "演练数据已重置"
        } catch (_: Exception) {
            message = "保存失败"
        }
    }

    fun train() {
        if (!BuildConfig.ALLOW_LOCAL_DEMO) return
        if (
            busy ||
                heartbeatBusy ||
                identity != null ||
                (livePending != null || liveOrderPending != null) ||
                liveStorageDamaged
        )
            return
        live = false
        api.clearIdentity()
        identity = null
        paymentOrders = emptyList()
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPlatforms = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        voucherHistory = emptyList()
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        printActor = null
        printUpdated = null
        afterSales = null
        afterSalesUpdated = null
        afterSalesActor = null
        afterSalesPendingRows = emptyList()
        onlineAccess = null
        onlineStatuses = emptyMap()
        onlineState = ""
        paymentSession = null
        paymentUpdated = null
        history = null
        historyQuery = HistoryQuery()
        cashierQuery = ""
        financeSummary = null
        financeEntries = emptyList()
        financeReviews = emptyList()
        financeUpdated = null
        financeActorID = null
        assignmentsBoard = null
        assignmentsUpdated = null
        assignmentsActorID = null
        assignmentReceipt = ""
        cashier = null
        cashierUpdated = null
        pickupBoard = null
        pickupUpdated = null
        kitchenBoard = null
        fulfillmentBoard = null
        fulfillmentUpdated = null
        kitchenUpdated = null
        lastOrderReceipt = null
        liveOrders = emptyList()
        liveProducts = emptyList()
        catalogUpdated = null
        liveOperations = null
        lastUpdated = null
        connection = "本机演练"
        resetDailyBusinessViews()
        workspaceVersion++
        staffName = "本机演练"
        world = World.training()
        readTraining()
    }

    fun grantDevice(credential: String) {
        if (busy || identity != null || pending != null) return
        busy = true
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { api.grant(credential, deviceKey) }
                deviceReady = true
                message = "设备验证成功，请登录员工账号"
            } catch (e: Exception) {
                message = e.message ?: "设备验证失败"
            } finally {
                busy = false
            }
        }
    }

    fun changeRememberLogin(enabled: Boolean) {
        if (busy || heartbeatBusy) return
        busy = true
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if(!enabled) ServiceReminders.disable(getApplication())
                    api.configureRememberSession(enabled)
                }
                rememberLogin = enabled
                savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                if (api.persistenceNotice.isNotEmpty()) message = api.persistenceNotice
            } catch (e: Exception) {
                message = e.message ?: "无法变更安全登录设置"
            } finally {
                busy = false
            }
        }
    }

    fun restoreRememberedSession(retry: Boolean = false) {
        if (
            (restoreAttempted && !retry) ||
                identity != null ||
                busy ||
                heartbeatBusy ||
                pending != null
        )
            return
        restoreAttempted = true
        busy = true
        viewModelScope.launch {
            try {
                val auth = withContext(Dispatchers.IO) { api.restoreSession() }
                if (auth == null) {
                    savedLoginAvailable = false
                    if (retry) message = "本机没有保存的登录，请使用员工账号登录"
                    return@launch
                }
                if (
                    (livePending != null && livePending?.employeeID != auth.employeeId) ||
                        (liveOrderPending != null &&
                            liveOrderPending?.employeeID != auth.employeeId)
                ) {
                    withContext(Dispatchers.IO) { api.clearIdentity() }
                    error("有原员工的未决请求，请由该员工重新登录后恢复")
                }
                identity = auth
                rememberLogin = true
                savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                staffName = auth.displayName
                deviceReady = true
                live = true
                resetDailyBusinessViews()
                workspaceVersion++
                world = World(emptyList(), emptyList())
                lastUpdated = null
                connection = "正在恢复门店数据"
                loadOperations()
                if (api.persistenceNotice.isNotEmpty()) message = api.persistenceNotice
            } catch (e: Exception) {
                savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                message = e.message ?: "恢复登录失败"
                if (identity != null) handleLiveError(e)
            } finally {
                busy = false
                resumeNotificationOpen()
                flushPushRevocations()
            }
        }
    }

    fun login(code: String, pin: String) {
        if (
            busy ||
                heartbeatBusy ||
                pending != null ||
                (identity != null && (livePending != null || liveOrderPending != null))
        )
            return
        busy = true
        val switching = identity != null
        disableNativePush()
        runCatching { ServiceReminders.disable(getApplication()) }
        viewModelScope.launch {
            try {
                val auth =
                    withContext(Dispatchers.IO) {
                        api.rememberSession = rememberLogin
                        api.login(code, pin, switching)
                    }
                savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                if (api.persistenceNotice.isNotEmpty()) message = api.persistenceNotice
                identity = auth
                staffName = auth.displayName
                live = true
                resetDailyBusinessViews()
                workspaceVersion++
                world = World(emptyList(), emptyList())
                liveOperations = null
                paymentOrders = emptyList()
                cashHandover = null
                cashHandoverUpdated = null
                cashHandoverActor = null
                voucherOperations = emptyList()
                voucherPlatforms = emptyList()
                voucherPreview = null
                voucherCode = ""
                voucherActor = null
                voucherUpdated = null
                voucherHistory = emptyList()
                printJobs = emptyList()
                printSources = emptyList()
                ownPrintJobs = emptyList()
                printActor = null
                printUpdated = null
                afterSales = null
                afterSalesUpdated = null
                afterSalesActor = null
                afterSalesPendingRows = emptyList()
                onlineAccess = null
                onlineStatuses = emptyMap()
                onlineState = ""
                paymentSession = null
                paymentUpdated = null
                history = null
                historyQuery = HistoryQuery()
                cashierQuery = ""
                financeSummary = null
                financeEntries = emptyList()
                financeReviews = emptyList()
                financeUpdated = null
                financeActorID = null
                assignmentsBoard = null
                assignmentsUpdated = null
                assignmentsActorID = null
                assignmentReceipt = ""
                cashier = null
                cashierUpdated = null
                pickupBoard = null
                pickupUpdated = null
                kitchenBoard = null
                fulfillmentBoard = null
                fulfillmentUpdated = null
                kitchenUpdated = null
                lastOrderReceipt = null
                liveOrders = emptyList()
                liveProducts = emptyList()
                catalogUpdated = null
                lastUpdated = null
                connection = "正在读取"
                try {
                    loadOperations()
                } catch (e: Exception) {
                    handleLiveError(e)
                }
            } catch (e: Exception) {
                if (api.identity == null && live) lockLiveSession()
                message = e.message ?: "登录失败，请检查网络"
            } finally {
                busy = false
                resumeNotificationOpen()
                flushPushRevocations()
            }
        }
    }

    fun logout() {
        if (
            busy ||
                heartbeatBusy ||
                identity == null ||
                (livePending != null || liveOrderPending != null)
        )
            return
        busy = true
        disableNativePush()
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { api.logout() }
                lockLiveSession()
                savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                message = "已退出员工账号" + api.persistenceNotice.let { if (it.isBlank()) "" else "；$it" }
            } catch (e: Exception) {
                if (api.identity == null) {
                    lockLiveSession()
                    savedLoginAvailable = withContext(Dispatchers.IO) { api.savedSessionAvailable() }
                    val note = api.persistenceNotice
                    message =
                        if (note.isNotBlank()) "已锁定本机账号；$note。服务器退出结果未确认。"
                        else if ((e as? StaffAPIError)?.status == 401) "登录已失效，已退出本机账号"
                        else "已退出本机账号；服务器退出结果未确认，请勿将此提示当作服务端已注销。"
                } else handleLiveError(e)
            } finally {
                busy = false
                flushPushRevocations()
            }
        }
    }

    private fun lockLiveSession() {
        disableNativePush()
        runCatching { ServiceReminders.disable(getApplication()) }
        notificationOpenTarget = null
        api.clearIdentity()
        identity = null
        paymentOrders = emptyList()
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPlatforms = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        voucherHistory = emptyList()
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        printActor = null
        printUpdated = null
        afterSales = null
        afterSalesUpdated = null
        afterSalesActor = null
        afterSalesPendingRows = emptyList()
        onlineAccess = null
        onlineStatuses = emptyMap()
        onlineState = ""
        paymentSession = null
        paymentUpdated = null
        history = null
        historyQuery = HistoryQuery()
        cashierQuery = ""
        financeSummary = null
        financeEntries = emptyList()
        financeReviews = emptyList()
        financeUpdated = null
        financeActorID = null
        assignmentsBoard = null
        assignmentsUpdated = null
        assignmentsActorID = null
        assignmentReceipt = ""
        cashier = null
        cashierUpdated = null
        pickupBoard = null
        pickupUpdated = null
        kitchenBoard = null
        fulfillmentBoard = null
        fulfillmentUpdated = null
        kitchenUpdated = null
        lastOrderReceipt = null
        liveOrders = emptyList()
        liveProducts = emptyList()
        catalogUpdated = null
        liveOperations = null
        world = World(emptyList(), emptyList())
        lastUpdated = null
        connection = "请重新登录"
        staffName = "未登录"
        resetDailyBusinessViews()
        workspaceVersion++
        flushPushRevocations()
    }

    private fun handleLiveError(e: Exception) {
        if ((e as? StaffAPIError)?.status == 401 ||
            (e is StaffAPIError && e.status == 403 && api.identity == null)) {
            lockLiveSession()
            deviceReady = false
        } else {
            connection = "更新失败 · 数据可能过期"
            if ((e as? StaffAPIError)?.status == 403) {
                resetDailyBusinessViews()
                history = null
                historyQuery = HistoryQuery()
                cashierQuery = ""
                financeSummary = null
                financeEntries = emptyList()
                financeReviews = emptyList()
                financeUpdated = null
                financeActorID = null
                assignmentsBoard = null
                assignmentsUpdated = null
                assignmentsActorID = null
                assignmentReceipt = ""
                cashier = null
                cashierUpdated = null
                pickupBoard = null
                pickupUpdated = null
                kitchenBoard = null
                fulfillmentBoard = null
                fulfillmentUpdated = null
                kitchenUpdated = null
                liveProducts = emptyList()
                catalogUpdated = null
                liveOperations = null
                world = World(emptyList(), emptyList())
                lastUpdated = null
            }
        }
        message = e.message ?: "连接失败，请重试"
    }

    private suspend fun loadOperations() {
        val auth = identity ?: return
        if (!auth.allows("order.create")) {
            liveProducts = emptyList()
            catalogUpdated = null
        }
        if (!auth.canReadTables) {
            serviceAttention = ServiceAttention()
            liveOperations = null
            world = World(emptyList(), emptyList())
            connection = "已登录 · 请使用本岗位工作台"
            return
        }
        val result =
            withContext(Dispatchers.IO) { LiveOperations.parse(api.data("/api/operations")) }
        if (result.actorId != auth.employeeId)
            throw StaffAPIError(401, "IDENTITY_CHANGED", "员工身份已变化，请重新登录")
        serviceAttention =
            serviceAttention.refresh(
                auth.employeeId,
                auth.allows("service.execute"),
                result.tasks
                    .filter { it.status in listOf("pending", "acknowledged", "in_progress") }
                    .map { ServiceAttention.Entry(it.id, it.session, it.tableCode, it.priority) },
                java.time.Instant.now(),
            )
        liveOperations = result
        world = World(result.tables.map { it.display }, emptyList())
        lastUpdated = java.time.Instant.now()
        connection = "已同步"
    }

    fun refresh() = updateConnection(false)

    fun heartbeat() = updateConnection(true)

    private fun updateConnection(quiet: Boolean) {
        if (!live || identity == null || busy || heartbeatBusy) return
        heartbeatBusy = true
        if (!quiet) busy = true
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                loadOperations()
            } catch (e: Exception) {
                if (!quiet || (e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                else connection = "连接中断 · 数据可能过期"
            } finally {
                busy = false
                heartbeatBusy = false
                resumeNotificationOpen()
                flushPushRevocations()
            }
        }
    }

    fun canAct(permission: String): Boolean {
        if (permission in listOf("reconciliation.manage", "business_day.close"))
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    assignmentDate(it)?.isAfter(java.time.Instant.now())
                } == true &&
                financeActorID == identity?.employeeId &&
                financeUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                (permission == "business_day.close" ||
                    identity?.allows("reconciliation.view") == true)

        if (permission == "payment.initiate.staff")
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    assignmentDate(it)?.isAfter(java.time.Instant.now())
                } == true &&
                onlineAccess?.optString("employeeId") == identity?.employeeId &&
                paymentUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                paymentSession != null
        if (permission == LiveAssignments.permission)
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                assignmentsBoard != null &&
                assignmentsActorID == identity?.employeeId &&
                identity?.onlineLeaseUntil?.let {
                    assignmentDate(it)?.isAfter(java.time.Instant.now())
                } == true &&
                assignmentsUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true

        if (
            permission in
                listOf(
                    "payment.manual.cash.record",
                    "payment.manual.pos.record",
                    "payment.manual.external.record",
                )
        )
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true &&
                paymentUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                paymentSession != null
        if (permission in listOf("order.cancel_unpaid", "order.settle_exception"))
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                cashier != null &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true &&
                cashierUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true
        if (LiveCashier.flags.containsKey(permission))
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true &&
                cashierUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                cashier?.actions?.optBoolean(LiveCashier.flags[permission]!!, false) == true

        if (permission in listOf("kds.deliver", "staff.access.configure")) {
            val board = pickupBoard ?: return false
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true &&
                pickupUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds < 60
                } == true &&
                board.valid &&
                (if (permission == "staff.access.configure") board.actor.getBoolean("canConfigure")
                else board.actor.getBoolean("canPickup") || board.actor.getBoolean("canUndo"))
        }
        if (permission == "kds.prepare")
            return live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows(permission) == true &&
                identity?.onlineLeaseUntil?.let {
                    serverInstant(it).isAfter(java.time.Instant.now())
                } == true &&
                kitchenUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds < 60
                } == true &&
                kitchenBoard?.employeeID == identity?.employeeId &&
                kitchenBoard?.canPrepare == true &&
                kitchenBoard?.sessionValid == true
        val auth = identity ?: return false
        return live &&
            connection == "已同步" &&
            !busy &&
            !heartbeatBusy &&
            !liveStorageDamaged &&
            (livePending == null && liveOrderPending == null) &&
            auth.allows(permission) &&
            serverInstant(auth.onlineLeaseUntil).isAfter(java.time.Instant.now()) &&
            lastUpdated?.let {
                java.time.Duration.between(it, java.time.Instant.now()).seconds < 60
            } == true &&
            liveOperations?.capabilities?.contains(permission) == true
    }

    fun prepareLive(
        kind: String,
        tableID: String,
        people: Int = 0,
        targetID: String? = null,
        taskID: String? = null,
        frozen: Boolean = false,
        reason: String = "",
    ): LiveCommand {
        val auth = identity ?: throw IllegalArgumentException("请先登录")
        val ops = liveOperations ?: throw IllegalArgumentException("请刷新桌台")
        val table =
            ops.tables.find { it.display.id == tableID }
                ?: throw IllegalArgumentException("桌台已变化，请刷新")
        val command =
            LiveCommand.make(
                kind,
                table,
                auth,
                people,
                ops.tables.find { it.display.id == targetID },
                ops.tasks.find { it.id == taskID },
                frozen,
                reason,
            )
        require(canAct(command.permission)) { "请刷新登录和桌台状态后重试" }
        return command
    }

    private fun saveLive(command: LiveCommand) {
        val stream = liveFile.startWrite()
        try {
            stream.write(command.json().toString().toByteArray(Charsets.UTF_8))
            liveFile.finishWrite(stream)
        } catch (e: Exception) {
            liveFile.failWrite(stream)
            throw e
        }
    }

    fun canCollectHistorical(provider: String): Boolean {
        val mode = LiveCashier.collectionMethods[provider] ?: return false
        return canAct("payment.recollect.authorize") &&
            identity?.allows(mode[0]) == true &&
            identity?.allows("payment.collect.all_tables") == true &&
            cashier?.actions?.optBoolean(mode[1]) == true &&
            cashier?.actions?.optBoolean("supportsGuardedClosedDebtCollection") == true
    }

    fun prepareHistoricalCollection(
        order: CashierOrder,
        provider: String,
        tender: Long?,
        reference: String,
        terminal: String,
        method: String,
        note: String,
    ): LiveCommand {
        require(canCollectHistorical(provider)) { "请刷新原收银工作台，核对历史补收权限" }
        return cashier!!.historicalCollection(
            identity!!,
            order,
            provider,
            tender,
            reference,
            terminal,
            method,
            note,
        )
    }

    fun canExecuteLive(command: LiveCommand): Boolean {
        if (command.employeeID != identity?.employeeId) return false
        if(command.steps.firstOrNull()?.memberGiftProof != null) return command.steps.size==1 && canUseMemberGifts && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.stackingPolicyProof != null) return command.steps.size==1 && canUseStackingPolicies && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.recommendationPolicyProof != null) return command.steps.size==1 && canUseRecommendationPolicies && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.membershipRecoveryProof != null) return command.steps.size==1 && canUseMembershipRecovery && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.memberNumberProof != null) return command.steps.size==1 && canUseMemberNumber
        if(command.steps.firstOrNull()?.annualPolicyProof != null) return command.steps.size==1 && canUseAnnualPolicies && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.checkoutManagementProof != null) return command.steps.size==1 && canUseCheckoutManagement && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.socialOperationsProof != null) return command.steps.size==1 && canUseSocial && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.contactGovernanceProof != null) return command.steps.size==1 && canUseContactGovernance && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.marketingProof != null) return command.steps.size==1 && canUseMarketing && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.activityOperationsProof != null) return command.steps.size==1 && canUseActivityOperations && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.homeContentProof != null) return command.steps.size==1 && canUseHomeContent && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.launchPopupProof != null) return command.steps.size==1 && canUseLaunchPopup && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.commercePolicyProof != null) return command.steps.size==1 && canUseCommercePolicy && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.couponCalendarProof != null) return command.steps.size==1 && canUseCouponCalendars && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.productPhasesProof != null) return command.steps.size==1 && canUseProductPhases && productPhasesBoard?.product==command.steps[0].productPhasesProof!!.getString("productId")
        if(command.steps.firstOrNull()?.experiencePlanProof != null) return command.steps.size==1 && canUseExperiencePlans && experiencePlanRows.any{it.getString("id")==command.steps[0].experiencePlanProof!!.getString("planId")&&it.getString("expectedVersion")==JSONObject(command.steps[0].body).getString("expectedVersion")}
        if(command.steps.firstOrNull()?.publicationProof != null) return command.steps.size==1 && canUsePublication && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.recipeConfigurationProof != null) return command.steps.size==1 && canUseRecipeConfiguration
        if(command.steps.firstOrNull()?.categoryConfigurationProof != null) return command.steps.size==1 && canUseProducts && productBoard?.configurable==true
        if(command.steps.firstOrNull()?.staffAdministrationProof != null) return command.steps.size==1 && canUseStaffAdministration
        if(command.steps.firstOrNull()?.tableConfigurationProof != null) return command.steps.size==1 && canUseTableConfiguration
        if(command.steps.firstOrNull()?.benefitWalletProof != null) return command.steps.size==1 && canUseBenefitWallet && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.remakeHandoverProof != null) return command.steps.size==1 && canUseRemakeHandover && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.membershipConfigProof != null) return command.steps.size==1 && canUseMembershipConfig && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.loyaltySupplementProof != null) return command.steps.size==1 && canUseLoyaltySupplements && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.benefitExceptionProof != null) return command.steps.size==1 && canUseBenefitExceptions
        if(command.steps.firstOrNull()?.loyaltyRefundProof != null) return command.steps.size==1 && canUseLoyaltyRefunds && canWriteLoyaltyRefunds(identity,command.steps[0].loyaltyRefundProof!!.getString("action"))
        if(command.steps.firstOrNull()?.memberCardProof != null) return command.steps.size==1 && canUseMemberCards && identity?.allows(command.permission)==true
        if(command.steps.firstOrNull()?.performanceProof != null) return command.steps.size == 1 && canUsePerformances && identity?.allows(command.permission) == true
        if(command.steps.firstOrNull()?.ownerProof != null) return command.steps.size == 1 && canUseOwner && identity?.allows(command.permission) == true
        if(command.steps.firstOrNull()?.custodyProof != null) return command.steps.size == 1 && canUseCustody && identity?.allows(command.permission) == true
        if(command.steps.firstOrNull()?.deviceProof != null) return command.steps.size == 1 && canUseDevices && identity?.allows(command.permission) == true
        command.steps.firstOrNull()?.songProof?.let { proof ->
            return command.steps.size == 1 && canUseSongs && identity?.allows(command.permission) == true &&
                songs.any { it.id == proof.getString("id") && it.status == proof.getString("previousStatus") }
        }
        if (command.steps.firstOrNull()?.productManagementProof != null)
            return command.steps.size == 1 && canUseProducts
        if (command.steps.firstOrNull()?.inventorySetupProof != null)
            return canUseInventorySetup && inventorySetupBoard?.let { validInventorySetupSelection(command, it) } == true
        if (command.steps.firstOrNull()?.inventoryPublishProof != null)
            return canUseInventoryPublish && inventoryReadFresh(inventoryPublishPreviewUpdated) &&
                inventoryPublishBoard?.let { board ->
                    inventoryPublishPreview?.let { preview -> validInventoryPublishSelection(command, board, preview) }
                } == true
        if (command.steps.firstOrNull()?.stockCostProof != null) return command.steps.size==1 && canUseStock && stockBoard?.source?.optBoolean("nativeCostCorrections")==true && identity?.allows("inventory.cost.correct")==true && identity?.allows("inventory.cost.view")==true
        if (command.steps.firstOrNull()?.stockAuditProof != null)
            return command.steps.size == 1 &&
                canUseStockAudit &&
                identity?.allows(command.permission) == true
        if (command.steps.firstOrNull()?.stockProof != null)
            return command.employeeID == identity?.employeeId &&
                command.steps.size == 1 &&
                canUseStock &&
                identity?.allows(command.permission) == true
        command.steps.firstOrNull()?.observationProof?.let { p ->
            return command.employeeID == identity?.employeeId &&
                command.steps.size == 1 &&
                canUseObservation &&
                identity?.allows(command.permission) == true &&
                if (p.getString("kind") == "recommendation")
                    recommendationBoard?.enabled == true &&
                        recommendationBoard?.session == p.getString("tableSessionId")
                else
                    observationBoard?.enabled == true &&
                        observationBoard?.session == p.getString("tableSessionId")
        }
        command.steps.firstOrNull()?.memberProof?.let { p ->
            if (p.getString("kind") == "benefit")
                return command.employeeID == identity?.employeeId &&
                    command.steps.size == 1 &&
                    canUseBenefits &&
                    benefitBoard?.rows?.any {
                        it.reservationId == p.getString("reservationId") && it.status == "reserved"
                    } == true
            return command.steps.size == 1 &&
                command.employeeID == identity?.employeeId &&
                if (p.getString("kind") == "visit")
                    canUseMember && memberVisit?.memberNo == p.getString("memberNo")
                else canUseMemberRewards
        }
        command.steps.firstOrNull()?.serviceProof?.let { p ->
            return command.steps.size == 1 &&
                command.employeeID == identity?.employeeId &&
                canUseService &&
                identity?.allows(command.permission) == true &&
                serviceBoard?.tasks?.any { it.id == p.getString("taskId") } == true
        }
        command.steps.singleOrNull()?.receptionProof?.let { p ->
            if (command.employeeID != identity?.employeeId || command.id != receptionPreparedId ||
                receptionPreparedToken?.let(::receptionReadCurrent) != true) return false
            return runCatching {
                val body = JSONObject(command.steps.single().body)
                when(p.getString("kind")) {
                    "reception-create" -> canCreateReception && body.getLong("reservationPolicyVersion") == receptionOptions!!.policyVersion &&
                        serverInstant(body.getString("arrivalAt")) == receptionOptions!!.arrival && serverInstant(body.getString("expectedEndAt")) == receptionOptions!!.end
                    "reception-seat" -> canSeatReception && p.getString("reservationId") == receptionDetail!!.reservation.id &&
                        body.getLong("reservationVersion") == receptionSessions!!.version &&
                        body.getJSONArray("sessions").objects().all { selected -> receptionSessions!!.sessions.any {
                            it.tableSessionId == selected.getString("tableSessionId") && it.tableId == selected.getString("expectedTableId") &&
                                it.locationVersion == selected.getLong("expectedLocationVersion") && it.guestCount == selected.getInt("expectedGuestCount")
                        } }
                    else -> false
                }
            }.getOrDefault(false)
        }
        command.steps.firstOrNull()?.reservationProof?.let { p ->
            return command.steps.size == 1 &&
                command.employeeID == identity?.employeeId &&
                canUseReservations &&
                (if (p.getString("kind") == "create")
                    false // Legacy create is recovery-only; never generate a new table-bound intent.
                else if (p.getString("kind") == "waitlist")
                    reservationCapabilities?.optBoolean("durableWaitlist") == true && reservationIntake.any { it.kind == "waitlist" && it.publicId == p.getString("publicId") && it.status == p.getString("previousStatus") }
                else if (p.getString("kind") == "transition")
                    reservations.any { it.id == p.getString("id") }
                else
                    reservationCapabilities?.optBoolean("durablePriority") == true &&
                        reservationIntake.any {
                            it.publicId == p.getString("publicId") &&
                                it.kind == p.getString("targetKind")
                        })
        }
        if (command.steps.firstOrNull()?.participantProof != null)
            return command.steps.size == 1 &&
                canUseParticipants &&
                participantPrepared?.id == command.id &&
                command.employeeID == identity?.employeeId
        if (command.employeeID != identity?.employeeId) return false
        val step = command.steps.firstOrNull()
        val proof = step?.cashierProof
        if (proof?.optString("action") == "historical-collection") {
            return runCatching {
                    val provider = JSONObject(step.body).getString("provider")
                    require(command.steps.size == 1 && canCollectHistorical(provider))
                    cashier!!.validateHistoricalSelection(
                        identity!!,
                        proof.getString("orderId"),
                        proof.getLong("amountMinor"),
                        proof.getString("tableSessionId"),
                        proof.getString("authorizationId"),
                        provider,
                    )
                }
                .isSuccess
        }
        if (step?.cashHandoverProof != null)
            return command.steps.size == 1 &&
                canUseCashHandover &&
                identity?.allows(command.permission) == true
        if (step?.voucherProof != null)
            return command.steps.size == 1 &&
                canUseVouchers &&
                identity?.allows(command.permission) == true
        if (step?.printProof != null)
            return command.steps.size == 1 &&
                canUsePrinting &&
                identity?.allows(command.permission) == true
        step?.activityProof?.let {
            return command.steps.size == 1 &&
                canUseActivity &&
                identity?.allows(command.permission) == true &&
                cashier?.activities?.any { r -> r.id == it.getString("registrationId") } == true
        }
        command.steps.firstOrNull()?.fulfillmentProof?.let {
            return canUseFulfillment && identity?.allows(command.permission)==true &&
                fulfillmentBoard?.let{validFulfillmentCommandSelection(command,it)}==true
        }
        command.steps.firstOrNull()?.afterSalesProof?.let {
            return canUseAfterSales &&
                identity?.allows(command.permission) == true &&
                afterSales?.let { board -> validAfterSalesCommandSelection(command, board) } == true
        }
        return canAct(command.permission)
    }

    fun executeLive(command: LiveCommand) {
        if (!canExecuteLive(command)) {
            message = "操作条件已变化，请刷新后重试"
            return
        }
        try {
            if (
                command.steps.any {
                    it.path in listOf("/api/payments/manual", "/api/payments/manual/closed-debt")
                }
            ) {
                paymentUpdated = null
                paymentState = "请核对原收款结果后刷新账单"
            }
            val secured = secureMembershipRecoveryCommand(secureSocialCommand(securePublicationCommand(secureStaffAdministrationCommand(secureOwnerCommand(secureCustodyCommand(
                secureVoucherCommand(
                    secureOnlineCommand(command, paymentSecrets::store),
                    paymentSecrets::store,
                ), paymentSecrets::store),paymentSecrets::store),paymentSecrets::store),paymentSecrets::store),paymentSecrets::store),paymentSecrets::store)
            val receptionSecured = secureReservationReceptionCommand(secured, receptionSecrets)
            saveLive(receptionSecured)
            livePending = receptionSecured
            recoverLive(retryReceptionOriginal = true)
        } catch (_: Exception) {
            message = "原请求未能保存，未发送操作，请检查设备空间"
        }
    }

    fun recoverLive(retryReceptionOriginal: Boolean = false) {
        val command = livePending ?: return
        if (busy || heartbeatBusy || liveStorageDamaged) return
        if (command.employeeID != identity?.employeeId) {
            message = "请由发起操作的员工登录后核对"
            return
        }
        if (command.rejected) {
            message = "服务器已拒绝此操作，请确认提示后清除失败请求，再刷新处理"
            return
        }
        try { validateReservationReceptionPending(command) }
        catch (e: Exception) { message = e.message ?: "预约安全记录不一致，未发送"; return }
        busy = true
        viewModelScope.launch {
            var current = command
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                require(identity?.employeeId == current.employeeID) { "请由原员工登录核对原请求" }
                if (current.steps.singleOrNull()?.reservationProof?.optString("kind") == "create" &&
                    current.steps.single().receptionPayloadKey == null) {
                    current = secureReservationReceptionCommand(current, receptionSecrets)
                    saveLive(current)
                    livePending = current
                }
                validateReservationReceptionPending(current)
                if (current.completedSteps < current.steps.size && current.steps.singleOrNull()?.receptionProof?.optString("kind") == "reception-seat")
                    require(identity?.allows("table.open") == true) { "当前员工没有开台权限，原入座请求已保留" }
                if (
                    current.completedSteps < current.steps.size &&
                        identity?.allows(current.permission) != true && !current.isStaffPermissionReceiptRecovery()
                )
                    throw StaffAPIError(403, "ACCESS_REVOKED", "操作权限已撤销，请联系管理员核对原请求")
                if (current.completedSteps < current.steps.size &&
                    current.steps.any { it.inventoryPublishProof != null } &&
                    !inventoryPublishPermissions.all { identity?.allows(it) == true })
                    throw StaffAPIError(403, "ACCESS_REVOKED", "验收发布需要收货、商品管理和成本查看权限，请由原员工核对原请求")
                val legacyCash = current.steps.singleOrNull()?.afterSalesProof
                    ?.takeIf { it.optString("afterSales") == "cash-paid" && current.completedSteps == 0 }
                if (legacyCash != null) {
                    val itemID = legacyCash.getString("itemId")
                    val board = withContext(Dispatchers.IO) {
                        LiveAfterSales(api.data("/api/commerce/item-after-sales/items/${LiveCommand.part(itemID)}"))
                            .also { it.validate(itemID) }
                    }
                    val recovered = recoverLegacyAfterSalesCashCommand(current, board, identity!!)
                    if (recovered != current) {
                        saveLive(recovered)
                        livePending = recovered
                        current = recovered
                    }
                }
                current =
                    LiveCommandRunner.advance(
                        current,
                        send = { step ->
                            if (step.onlineProof != null) {
                                val proof = step.onlineProof!!
                                val session = proof.getString("tableSessionId")
                                val saved = onlineReceipts.optJSONObject(session)
                                if (saved?.getString("commandID") == command.id)
                                    validateOnlineReply(
                                        saved.getJSONObject("response").toString(),
                                        step,
                                    )
                                else {
                                    val response =
                                        withContext(Dispatchers.IO) {
                                            api.raw(
                                                    step.path,
                                                    onlineRequestBody(step, paymentSecrets::read),
                                                    mapOf(step.keyHeader to step.key),
                                                )
                                                .text
                                        }
                                    validateOnlineReply(response, step)
                                    val receipt =
                                        JSONObject()
                                            .put("commandID", command.id)
                                            .put("employeeID", command.employeeID)
                                            .put("tableSessionID", session)
                                            .put("kind", proof.getString("online"))
                                            .put("response", JSONObject(response))
                                    val all =
                                        JSONObject(onlineReceipts.toString()).put(session, receipt)
                                    val stream = onlineReceiptFile.startWrite()
                                    try {
                                        stream.write(all.toString().toByteArray())
                                        onlineReceiptFile.finishWrite(stream)
                                    } catch (e: Exception) {
                                        onlineReceiptFile.failWrite(stream)
                                        throw e
                                    }
                                    onlineReceipts = all
                                    onlineStatuses =
                                        onlineStatuses +
                                            (receipt
                                                .getJSONObject("response")
                                                .getJSONObject("data")
                                                .getString("id") to "pending")
                                }
                            } else if (step.receptionPayloadKey != null) {
                                withContext(Dispatchers.IO) {
                                    performReservationReceptionStep(step, receptionSecrets,
                                        read = { api.raw(it).text },
                                        send = { original -> api.raw(original.path, JSONObject(original.body), mapOf(original.keyHeader to original.key)).text },
                                        readOnly = step.receptionProof?.optString("kind") == "reception-create" && !retryReceptionOriginal)
                                }
                            } else if (step.memberGiftProof != null) {
                                withContext(Dispatchers.IO){validateMemberGiftReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.stackingPolicyProof != null) {
                                withContext(Dispatchers.IO){validateStackingPolicyReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.recommendationPolicyProof != null) {
                                withContext(Dispatchers.IO){validateRecommendationPolicyReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.membershipRecoveryProof != null) {
                                withContext(Dispatchers.IO){val body=JSONObject(paymentSecrets.read(step.membershipRecoveryProof!!.getString("payloadKey")));validateMembershipRecoveryReply(api.raw(step.path,body,mapOf(step.keyHeader to step.key)).text,step,body)}
                            } else if (step.memberNumberProof != null) {
                                withContext(Dispatchers.IO){validateMemberNumberReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.annualPolicyProof != null) {
                                val response=withContext(Dispatchers.IO){api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text};validateAnnualPolicyReply(response,step)
                            } else if (step.checkoutManagementProof != null) {
                                val response=withContext(Dispatchers.IO){api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text};validateCheckoutManagementReply(response,step)
                            } else if (step.socialOperationsProof != null) {
                                withContext(Dispatchers.IO){val body=JSONObject(paymentSecrets.read(step.socialOperationsProof!!.getString("payloadKey")));validateSocialReply(api.raw(step.path,body,mapOf(step.keyHeader to step.key)).text,step,body)}
                            } else if (step.contactGovernanceProof != null) {
                                val response=withContext(Dispatchers.IO){api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text};validateContactGovernanceReply(response,step)
                            } else if (step.marketingProof != null) {
                                val response=withContext(Dispatchers.IO){api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text};validateMarketingReply(response,step)
                            } else if (step.activityOperationsProof != null) {
                                val response=withContext(Dispatchers.IO){api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text};validateActivityOperationsReply(response,step);if(step.activityOperationsProof!!.getString("action")=="create")activityOperationsSelection=JSONObject(response).getJSONObject("data").getJSONObject("row").getString("publicId")
                            } else if (step.homeContentProof != null) {
                                withContext(Dispatchers.IO){validateHomeContentReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.launchPopupProof != null) {
                                withContext(Dispatchers.IO){validateLaunchPopupReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.commercePolicyProof != null) {
                                withContext(Dispatchers.IO){validateCommercePolicyReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.couponCalendarProof != null) {
                                withContext(Dispatchers.IO){validateCouponCalendarReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.productPhasesProof != null) {
                                withContext(Dispatchers.IO){validateProductPhasesReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.experiencePlanProof != null) {
                                withContext(Dispatchers.IO){validateExperiencePlanReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.publicationProof != null) {
                                withContext(Dispatchers.IO){val body=JSONObject(paymentSecrets.read(step.publicationProof!!.getString("payloadKey")));validatePublicationReply(api.raw(step.path,body,mapOf(step.keyHeader to step.key)).text,step,body)}
                            } else if (step.recipeConfigurationProof != null) {
                                withContext(Dispatchers.IO){validateRecipeConfigurationReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.categoryConfigurationProof != null) {
                                withContext(Dispatchers.IO) { validateCategoryConfigurationReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step) }
                            } else if (step.staffAdministrationProof != null) {
                                withContext(Dispatchers.IO) { val body=JSONObject(paymentSecrets.read(step.staffAdministrationProof!!.getString("payloadKey")));validateStaffAdministrationReply(api.raw(step.path,body,mapOf(step.keyHeader to step.key)).text,step,body) }
                            } else if (step.tableConfigurationProof != null) {
                                withContext(Dispatchers.IO){validateTableConfigurationReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.benefitWalletProof != null) {
                                withContext(Dispatchers.IO){validateBenefitWalletReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.remakeHandoverProof != null) {
                                withContext(Dispatchers.IO){validateRemakeHandoverReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.membershipConfigProof != null) {
                                withContext(Dispatchers.IO){validateMembershipConfigReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.loyaltySupplementProof != null) {
                                withContext(Dispatchers.IO){validateLoyaltySupplementReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.benefitExceptionProof != null) {
                                withContext(Dispatchers.IO){validateBenefitExceptionReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.loyaltyRefundProof != null) {
                                withContext(Dispatchers.IO){validateLoyaltyRefundReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.memberCardProof != null) {
                                withContext(Dispatchers.IO){validateMemberCardReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.performanceProof != null) {
                                withContext(Dispatchers.IO){validatePerformanceReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.ownerProof != null) {
                                withContext(Dispatchers.IO) { val body=JSONObject(paymentSecrets.read(step.ownerProof!!.getString("payloadKey")));validateOwnerReply(api.raw(step.path,body,ownerHeaders(step)).text,step,body) }
                            } else if (step.custodyProof != null) {
                                val result = withContext(Dispatchers.IO) {
                                    val body = JSONObject(paymentSecrets.read(step.custodyProof!!.getString("payloadKey")))
                                    val text = api.raw(step.path,body,custodyHeaders(step)).text
                                    validateCustodyReply(text,step,body)
                                }
                                val receipt = JSONObject().put("commandId",command.id).put("operation",step.custodyProof!!.getString("operation")).put("result",result)
                                val stored = runCatching { JSONObject(custodyReceiptSecrets.read(command.id)) }.getOrNull()
                                if(stored == null) custodyReceiptSecrets.store(command.id,receipt.toString())
                                custodyReceipt = stored ?: receipt
                                result.optJSONObject("order")?.textOrNull("id")?.let { custodySelected = it }
                            } else if (step.voucherProof != null) {
                                withContext(Dispatchers.IO) {
                                    performVoucherStep(
                                        step,
                                        read = { path -> api.raw(path).text },
                                        send = { body ->
                                            api.raw(
                                                    step.path,
                                                    body,
                                                    mapOf(step.keyHeader to step.key),
                                                )
                                                .text
                                        },
                                        secret = paymentSecrets::read,
                                    )
                                }
                            } else if (step.inventorySetupProof != null || step.inventoryPublishProof != null) {
                                // Recovery sends the saved version and idempotency key, even when a
                                // successful prior submission already changed the current inventory.
                                val text = withContext(Dispatchers.IO) {
                                    api.raw(step.path, JSONObject(step.body), mapOf(step.keyHeader to step.key)).text
                                }
                                if (step.inventorySetupProof != null) validateInventorySetupReply(text, step)
                                else validateInventoryPublishReply(text, step)
                                val receipt = JSONObject().put("commandID", command.id)
                                    .put("employeeID", command.employeeID).put("text", text)
                                saveStockFile(stockReceiptFile, receipt)
                                stockReceipt = receipt
                            } else if(step.stockCostProof != null) {
                                withContext(Dispatchers.IO){validateStockCostReply(api.raw(step.path,JSONObject(step.body),mapOf(step.keyHeader to step.key)).text,step)}
                            } else if (step.stockProof != null || step.stockAuditProof != null) {
                                val text =
                                    withContext(Dispatchers.IO) {
                                        api.raw(
                                                step.path,
                                                JSONObject(step.body),
                                                mapOf(step.keyHeader to step.key),
                                            )
                                            .text
                                    }
                                if (step.stockAuditProof != null)
                                    validateStockAuditReply(text, step)
                                else validateStockReply(text, step)
                                val receipt =
                                    JSONObject()
                                        .put("commandID", command.id)
                                        .put("employeeID", command.employeeID)
                                        .put("text", text)
                                saveStockFile(stockReceiptFile, receipt)
                                stockReceipt = receipt
                            } else if (step.printProof != null) {
                                val text =
                                    withContext(Dispatchers.IO) {
                                        api.raw(
                                                step.path,
                                                JSONObject(step.body),
                                                mapOf(step.keyHeader to step.key),
                                            )
                                            .text
                                    }
                                validatePrintReply(text, step)
                                val receipt =
                                    JSONObject()
                                        .put("commandID", command.id)
                                        .put("employeeID", command.employeeID)
                                        .put("response", JSONObject(text))
                                val stream = printReceiptFile.startWrite()
                                try {
                                    stream.write(receipt.toString().toByteArray())
                                    printReceiptFile.finishWrite(stream)
                                    printReceipt = receipt
                                } catch (e: Exception) {
                                    printReceiptFile.failWrite(stream)
                                    throw e
                                }
                            } else if (step.financeProof != null) {
                                val response =
                                    withContext(Dispatchers.IO) {
                                        api.raw(
                                                step.path,
                                                JSONObject(step.body),
                                                mapOf(step.keyHeader to step.key),
                                            )
                                            .text
                                    }
                                validateFinanceReply(response, step)
                                saveFinanceReceipt(command, step, response)
                            } else withContext(Dispatchers.IO) { api.execute(step) }
                        },
                        checkpoint = { next ->
                            saveLive(next)
                            livePending = next
                        },
                    )
                val step = current.steps.firstOrNull()
                if (step?.path == "/api/commerce/kitchen-board/commands")
                    fetchKitchen(JSONObject(step.body).getString("stationCode"))
                else if (step?.collectionSession != null)
                    fetchPaymentOrders(step.collectionSession!!)
                else if (step?.onlineProof != null)
                    fetchPaymentOrders(step.onlineProof!!.getString("tableSessionId"))
                else if (step?.fulfillmentProof != null) fetchFulfillment()
                else if (step?.afterSalesProof != null)
                    fetchAfterSales(step.afterSalesProof!!.getString("itemId"))
                else if (step?.observationProof != null) {
                    fetchObservation(step.observationProof!!.getString("tableSessionId"))
                } else if (step?.memberProof != null) {
                    val p = step.memberProof!!
                    if (p.getString("kind") == "benefit") fetchBenefits()
                    else if (p.getString("kind") == "visit") fetchMember(p.getString("memberNo"))
                    else fetchMemberRewards(memberRewardFilter)
                } else if (step?.inventorySetupProof != null) {
                    inventorySetupBoard = null
                    inventorySetupUpdated = null
                    stockBoard = null
                    stockUpdated = null
                    try {
                        fetchInventorySetup()
                        fetchStock()
                        inventorySetupState = "物料设置已确认，库存与包装条码已刷新。"
                    } catch (e: kotlinx.coroutines.CancellationException) { throw e
                    } catch (e: Exception) {
                        handleLiveError(e)
                        inventorySetupBoard = null
                        inventorySetupUpdated = null
                        inventorySetupState = "原物料设置已确认，当前资料读取失败，请刷新查看。"
                        stockState = inventorySetupState
                    }
                } else if (step?.inventoryPublishProof != null) {
                    inventoryPublishBoard = null
                    inventoryPublishPreview = null
                    inventoryPublishUpdated = null
                    inventoryPublishPreviewUpdated = null
                    inventoryPublishState = "原采购单已入库，商品已发布；继续操作前请选择新的待验收单。"
                    stockBoard = null
                    stockUpdated = null
                    try { fetchStock()
                    } catch (e: kotlinx.coroutines.CancellationException) { throw e
                    } catch (e: Exception) {
                        handleLiveError(e)
                        inventoryPublishState = "原采购单入库及商品发布已确认，库存读取失败，请刷新查看。"
                        stockState = inventoryPublishState
                    }
                } else if(step?.stockCostProof != null) { fetchStock()
                } else if (step?.stockAuditProof != null) {
                    val p = step.stockAuditProof!!
                    if (
                        p.getString("kind") == "count" &&
                            countBook().optJSONArray(command.employeeID)?.toString() ==
                                p.optString("draftFingerprint")
                    ) {
                        saveStockFile(
                            countDraftFile,
                            countBook().put(command.employeeID, org.json.JSONArray()),
                        )
                        stockCountDraft = emptyList()
                    }
                    fetchStock()
                    fetchStockAudit()
                } else if (step?.productManagementProof != null) {
                    fetchProducts()
                } else if (step?.stockProof != null) {
                    val proof = step.stockProof!!
                    if (proof.getString("kind") == "create") {
                        val book = stockBook()
                        if (
                            stockDraftMatchesReceipt(book, command.employeeID, proof)
                        ) {
                            saveStockFile(stockDraftFile, stockDraftBookEntry(book, command.employeeID, emptyList(), ""))
                        }
                    }
                    fetchStock()
                } else if (step?.serviceProof != null) fetchService()
                else if (step?.memberGiftProof != null) fetchMemberGifts()
                else if (step?.stackingPolicyProof != null) fetchStackingPolicies()
                else if (step?.recommendationPolicyProof != null) fetchRecommendationPolicies()
                else if (step?.membershipRecoveryProof != null) fetchMembershipRecovery()
                else if (step?.memberNumberProof != null) fetchMemberNumber()
                else if (step?.annualPolicyProof != null) fetchAnnualPolicies()
                else if (step?.checkoutManagementProof != null) fetchCheckoutManagement()
                else if (step?.socialOperationsProof != null) fetchSocial()
                else if (step?.contactGovernanceProof != null) fetchContactGovernance()
                else if (step?.marketingProof != null) fetchMarketing()
                else if (step?.activityOperationsProof != null) {fetchActivityOperations();fetchActivityOperationsDetail()}
                else if (step?.homeContentProof != null) fetchHomeContent()
                else if (step?.launchPopupProof != null) fetchLaunchPopup()
                else if (step?.commercePolicyProof != null) fetchCommercePolicy()
                else if (step?.couponCalendarProof != null) fetchCouponCalendars()
                else if (step?.productPhasesProof != null) fetchProductPhases(step.productPhasesProof!!.getString("productId"))
                else if (step?.experiencePlanProof != null) fetchExperiencePlans()
                else if (step?.publicationProof != null) fetchPublication()
                else if (step?.recipeConfigurationProof != null) fetchRecipeConfiguration(step.recipeConfigurationProof!!.getString("productId"))
                else if (step?.categoryConfigurationProof != null) fetchProducts()
                else if (step?.staffAdministrationProof != null) {
                    // The receipt has already been verified and checkpointed. A
                    // post-change permission/session loss must not strand it again.
                    try { identity = withContext(Dispatchers.IO) { api.heartbeat() }; fetchStaffAdministration() }
                    catch(e: kotlinx.coroutines.CancellationException) { throw e }
                    catch(e: Exception) { staffAdministrationBoard=null; staffAdministrationState="原修改已确认，请刷新或重新登录查看当前权限"; handleLiveError(e) }
                }
                else if (step?.tableConfigurationProof != null) fetchTableConfiguration()
                else if (step?.benefitWalletProof != null) fetchBenefitWallet()
                else if (step?.remakeHandoverProof != null) fetchRemakeHandover()
                else if (step?.membershipConfigProof != null) fetchMembershipConfig()
                else if (step?.loyaltySupplementProof != null) fetchLoyaltySupplements()
                else if (step?.benefitExceptionProof != null) fetchBenefitExceptions()
                else if (step?.loyaltyRefundProof != null) fetchLoyaltyRefunds()
                else if (step?.memberCardProof != null) fetchMemberCards()
                else if (step?.performanceProof != null) fetchPerformances()
                else if (step?.ownerProof != null) fetchOwnerFinance()
                else if (step?.custodyProof != null) {
                    if(custodyReceipt?.optString("commandId") != command.id) custodyReceipt = JSONObject(custodyReceiptSecrets.read(command.id))
                    custodyReceipt?.getJSONObject("result")?.optJSONObject("order")?.textOrNull("id")?.let { custodySelected = it }
                    fetchCustody()
                }
                else if (step?.deviceProof != null) fetchDevices()
                else if (step?.songProof != null) fetchSongs(songFilter)
                else if (step?.reservationProof != null || step?.receptionProof != null) {
                    fetchReservations(reservationQuery)
                    receptionOptions = null; receptionSessions = null; receptionDetail = null
                    receptionOptionsUpdated = null; receptionSessionsUpdated = null
                    receptionState = "原预约操作已确认，请重新读取当前预约与桌次"
                }
                else if (step?.financeProof != null) fetchFinance(financeQuery)
                else if (step?.assignmentProof != null) fetchAssignments()
                else if (step?.cashHandoverProof != null) fetchCashHandover()
                else if (step?.voucherProof != null) fetchVouchers()
                else if (step?.printProof != null) fetchPrinting()
                else if (step?.cashierProof != null || step?.activityProof != null)
                    fetchCashier(cashierQuery)
                else if (step?.path?.startsWith("/api/commerce/pickup-board/") == true)
                    fetchPickup()
                else loadOperations()
                removeReservationReceptionPayload(current.steps.firstOrNull(), receptionSecrets)
                clearLiveFile()
                livePending = null
                if (current.steps.firstOrNull()?.participantProof != null) {
                    resetParticipantPreview()
                    participants = emptyList()
                    participantState = "人员调整已确认，请让顾客扫描目标桌二维码；如需继续，请刷新名单。"
                }
                current.steps
                    .firstOrNull()
                    ?.voucherProof
                    ?.textOrNull("voucherSecretKey")
                    ?.let(paymentSecrets::remove)
                current.steps
                    .firstOrNull()
                    ?.onlineProof
                    ?.textOrNull("authCodeKey")
                    ?.let(paymentSecrets::remove)
                current.steps.firstOrNull()?.ownerProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            current.steps.firstOrNull()?.staffAdministrationProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            current.steps.firstOrNull()?.membershipRecoveryProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            current.steps.firstOrNull()?.socialOperationsProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            current.steps.firstOrNull()?.publicationProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
                current.steps.firstOrNull()?.custodyProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it); custodyReceiptSecrets.remove(it) }
                if (step?.assignmentProof != null) assignmentReceipt = current.title + " · 已确认"
                message =
                    if (step?.inventorySetupProof != null) inventorySetupState
                    else if (step?.inventoryPublishProof != null) inventoryPublishState
                    else if (current.steps.firstOrNull()?.custodyProof != null) custodyReceipt?.getJSONObject("result")?.textOrNull("message") ?: "存酒操作已确认，请核对原单状态；打印或导出准备完成不代表已交付"
                    else if (step?.memberGiftProof != null) when(step.memberGiftProof!!.getString("action")){"target"->"原发放任务已确认；请在发放任务中核对，排队不表示已经发券";"control"->"原任务处理已确认；重试不表示发券成功";"refund"->"券权益复核已记录，未修改退款金额或发放新券";else->"会员活动操作已确认，请核对当前状态"}
                    else if (current.steps.firstOrNull()?.voucherProof == null) "操作已确认，服务器状态已更新"
                    else "原核销事项已保存；以事项状态为准，待核对不表示核销或结算成功"
            } catch (e: Exception) {
                current = livePending ?: current
                if (
                    (if (current.steps.singleOrNull()?.let { it.receptionProof != null || it.receptionPayloadKey != null } == true)
                        reservationReceptionDefinitivelyRejected(e) else (e as? StaffAPIError)?.definitivelyRejected == true) &&
                        current.completedSteps < current.steps.size
                ) {
                    current = current.copy(rejected = true)
                    try {
                        if (current.steps.singleOrNull()?.receptionPayloadKey != null) saveReceptionRefusal(current, e as StaffAPIError)
                        saveLive(current)
                        livePending = current
                    } catch (_: Exception) {
                        liveStorageDamaged = true
                    }
                }
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private fun clearLiveFile() {
        liveFile.delete()
        check(
            !liveFile.baseFile.exists() &&
                !File(liveFile.baseFile.path + ".bak").exists() &&
                !File(liveFile.baseFile.path + ".new").exists()
        ) {
            "请求记录无法清除，请检查设备空间"
        }
    }

    fun resolveServicePending(code: String, pin: String, reason: String) {
        val original = livePending ?: return
        if (busy || heartbeatBusy || liveStorageDamaged || liveOrderPending != null) return
        val request = try { serviceRecoveryRequest(original, reason) } catch (e: Exception) { message = e.message ?: "请核对原请求"; return }
        val version = workspaceVersion
        busy = true
        viewModelScope.launch {
            var supervisor: StaffAPI? = null
            try {
                val response = withContext(Dispatchers.IO) {
                    val client = api.supervisorClient(); supervisor = client
                    val actor = client.login(code,pin,false)
                    require(actor.employeeId != original.employeeID && actor.allows("service.manage") && actor.allows("service.execute")) { "请由另一位具有服务管理权限的主管核对" }
                    client.raw("/api/native-service-recovery",request).text
                }
                val result = validateServiceRecoveryReply(response,original)
                require(livePending == original && workspaceVersion == version) { "本机工作区已变化，原记录仍保留，请重新核对" }
                clearLiveFile()
                livePending = null
                resetDailyBusinessViews()
                lastUpdated = null
                workspaceVersion++
                message = result
            } catch (e: Exception) {
                // Supervisor authentication must never clear or replace the original employee session.
                message = e.message ?: "主管核对未完成，原请求已保留，请使用同一入口重试"
            } finally {
                withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                    supervisor?.let { client -> try { client.logout() } catch (_: Exception) {} finally { client.clearIdentity() } }
                }
                busy = false
            }
        }
    }

    fun dismissRejectedLive() {
        val command = livePending ?: return
        if (!command.rejected || command.employeeID != identity?.employeeId || busy) return
        resetParticipantPreview()
        try {
            removeReservationReceptionPayload(command.steps.firstOrNull(), receptionSecrets)
            clearLiveFile()
            livePending = null
            command.steps
                .firstOrNull()
                ?.voucherProof
                ?.textOrNull("voucherSecretKey")
                ?.let(paymentSecrets::remove)
            command.steps
                .firstOrNull()
                ?.onlineProof
                ?.textOrNull("authCodeKey")
                ?.let(paymentSecrets::remove)
            command.steps.firstOrNull()?.ownerProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            command.steps.firstOrNull()?.staffAdministrationProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            command.steps.firstOrNull()?.membershipRecoveryProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
        command.steps.firstOrNull()?.socialOperationsProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            command.steps.firstOrNull()?.publicationProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it) }
            command.steps.firstOrNull()?.custodyProof?.textOrNull("payloadKey")?.let { paymentSecrets.remove(it); custodyReceiptSecrets.remove(it) }
            custodyUpdated = null
            assignmentsUpdated = null
            assignmentsBoard = null
            assignmentsActorID = null
            assignmentReceipt = ""
            voucherUpdated = null
            cashHandoverUpdated = null
            afterSalesUpdated = null
            financeUpdated = null
            printUpdated = null
            lastUpdated = null
            fulfillmentUpdated = null
            fulfillmentBoard = null
            kitchenUpdated = null
            cashierUpdated = null
            paymentUpdated = null
            pickupUpdated = null
            connection = "请刷新桌台后继续"
        } catch (e: Exception) {
            message = "请求记录无法清除，请检查设备空间"
        }
    }

    fun resetParticipantPreview() {
        participantInput = null
        participantPreview = null
        participantUpdated = null
        participantPrepared = null
    }

    private fun resetDailyBusinessViews() {
        stockQuery=""
        memberGiftsBoard=null;memberGiftRows=emptyList();memberGiftKind="campaigns";memberGiftsState="请读取会员活动"
        stackingPoliciesBoard=null;stackingPolicyRows=emptyList();stackingPolicySearch="";stackingPoliciesState="请读取叠加规则"
        recommendationPolicyBoard=null;recommendationPolicyRows=emptyList();recommendationPolicyState="请读取推荐规则";recommendationPolicySearch="DEFAULT"
        membershipRecoveryBoard=null;membershipRecoveryRows=emptyList();membershipRecoveryHistory=false;membershipRecoveryState="请读取原找回申请"
        memberNumberBoard=null;memberNumberState="请读取会员号规则"
        annualPolicyBoard=null;annualPolicyRows=emptyList();annualPolicyCode="";annualPolicyState="请读取年度权益配置"
        checkoutManagementBoard=null;checkoutManagementRows=emptyList();checkoutManagementProducts=emptyMap();checkoutManagementState="请读取升级与产能配置";checkoutManagementArea="rules";checkoutManagementCode=""
        socialBoard=null;socialRows=emptyList();socialState="请读取微信运营记录";socialArea="accounts"
        contactGovernanceBoard=null;contactGovernanceRows=emptyList();contactGovernanceState="请读取保留与清除记录";contactGovernanceArea="policies";contactGovernanceSearch=""
        marketingBoard=null;marketingRows=emptyList();marketingState="请选择营销工作区";marketingArea="notices";marketingCode=""
        activityOperationsBoard=null;activityOperationsRows=emptyList();activityOperationsDetail=null;activityRegistrationRows=emptyList();activityOperationsSelection=null;activityRegistrationSearch="";activityOperationsSearch="";activityOperationsState="请读取活动"
        homeContentBoard=null;homeContentRows=emptyList();homeContentState="请读取首页内容";homeContentSearch=""
        launchPopupBoard=null;launchPopupState="请读取小程序弹窗"
        commercePolicyBoard=null;commercePolicyState="请读取门店支付策略"
        couponCalendarsBoard=null;couponCalendarRows=emptyList();couponCalendarSearch="";couponCalendarsState="请读取券日历规则"
        productPhasesBoard=null;productPhasesState="请读取商品阶段"
        experiencePlansBoard=null;experiencePlanRows=emptyList();experiencePlansQuery="";experiencePlansState="请读取原体验计划"
        publicationBoard=null;publicationState="请读取顾客公开内容"
        recipeCostPreview=null;recipeConfigurationBoard=null;recipeConfigurationState="请读取原商品配方"
        staffAdministrationBoard=null;staffAdministrationState="请读取员工与岗位权限"
        tableConfigurationBoard=null;tableConfigurationState="请读取区域和桌台配置"
        benefitWalletBoard=null;walletCode="";walletCursor="";benefitWalletState="请扫描会员码或填写会员号"
        remakeHandoverBoard=null;remakeHandoverCursor=null;remakeHandoverState="请读取离店实物"
        membershipConfigBoard=null;membershipConfigDetail=null;membershipConfigTarget=null;membershipConfigSection="rules";membershipConfigState="请读取会员规则"
        loyaltySupplementsBoard=null;loyaltySupplementsPage=0;loyaltySupplementsSection="reconciliation";loyaltySupplementsState="请读取积分原账"
        benefitExceptionsBoard=null;benefitExceptionsPage=0;benefitExceptionsState="请读取礼遇出品异常"
        loyaltyRefundBoard=null;loyaltyRefundPage=0;loyaltyRefundState="请读取退款积分复核"
        memberCardsBoard=null;memberCardsUpdated=null;memberCardsState="请读取会员卡";memberCardsSection="projects";memberCardsCursor=""
        performanceBoard=null;performanceUpdated=null;performanceState="请读取演出排班"
        ownerBoard = null; ownerUpdated = null; ownerQuery = ""; ownerState = "请读取费用与工资"
        custodyBoard = null; custodyReceipt = null; custodyUpdated = null; custodySelected = null; custodyQuery = ""; custodyState = "请读取存酒"
        overview = null
        overviewState = "请读取经营概览"
        stockCounts = null
        stockWaste = null
        stockAuditUpdated = null
        stockCountDraft = emptyList()
        stockAuditState = "请读取盘点与报损"
        productBoard = null
        productUpdated = null
        productState = "请读取商品"
        stockBoard = null
        stockEmployee = null
        stockUpdated = null
        stockDraft = emptyList()
        stockSupplierName = ""
        stockReceipt = null
        stockState = "请读取库存与采购单"
        inventorySetupBoard = null
        inventorySetupUpdated = null
        inventorySetupState = "请读取物料与包装条码"
        inventoryPublishBoard = null
        inventoryPublishPreview = null
        inventoryPublishUpdated = null
        inventoryPublishPreviewUpdated = null
        inventoryPublishState = "请选择待验收采购单与商品"
        serviceAttention = ServiceAttention()
        benefitBoard = null
        benefitUpdated = null
        benefitEmployee = null
        benefitState = "请读取权益兑付队列"
        observationBoard = null
        recommendationBoard = null
        observationEmployee = null
        observationUpdated = null
        observationState = ""

        memberAccount = null
        memberParticipation = null
        memberVisit = null
        memberRewards = null
        memberEmployee = null
        memberRewardEmployee = null
        memberUpdated = null
        memberRewardUpdated = null
        memberState = ""
        memberRewardState = ""

        resetParticipantPreview()
        participants = emptyList()
        participantState = ""
        selectReception(null)
        reservations = emptyList()
        reservationIntake = emptyList()
        reservationCapabilities = null
        reservationTables = emptyList()
        reservationUpdated = null
        reservationEmployee = null
        reservationState = ""
        deviceBoard = null; deviceUpdated = null; printBridges = emptyList(); bridgeRevocationEnabled = false; clearBridgePairing(); deviceState = "请读取打印设备"
        songs = emptyList(); songEnabled = false; songUpdated = null; songEmployee = null
        songEvidence = emptyList(); songEvidenceID = null; performances = null; songState = "请读取点歌队列"
        serviceBoard = null
        serviceUpdated = null
        serviceState = ""
    }

    fun loadService(automatic: Boolean = false) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        val original = workspaceReadIdentity()
        if (serviceBoard == null) serviceState = "正在读取服务任务"
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                fetchService()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (original.employee == identity?.employeeId && original.workspace == workspaceVersion) {
                    serviceUpdated = null
                    serviceState = if (serviceBoard != null) "同步失败 · 显示上次任务，数据已过期；请重新读取后操作" else "服务任务读取失败，请刷新重试"
                    if (!automatic || (e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                }
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchService() {
        val actor = identity ?: error("请重新登录")
        require(actor.canReadService()) { "当前岗位没有服务任务查看权限" }
        val expected = workspaceReadIdentity()
        val board =
            readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                withContext(Dispatchers.IO) { LiveServiceBoard(api.data("/api/native-service-center")) }
            }
        require(
            board.employee == actor.employeeId &&
                board.tasks.map { it.id }.distinct().size == board.tasks.size &&
                board.employees.map { it.getString("id") }.distinct().size == board.employees.size
        ) {
            "服务任务返回不一致，请重新读取"
        }
        serviceBoard = board
        serviceUpdated = java.time.Instant.now()
        serviceState = "读取${board.tasks.size}项未完成任务；紧急事项优先。"
    }

    fun prepareService(
        id: String,
        action: String,
        note: String,
        employee: String,
        priority: String,
    ): LiveCommand {
        check(canUseService) { "请刷新任务并核对当前员工权限" }
        return serviceBoard!!.command(id, action, note, employee, priority, identity!!)
    }

    fun loadObservation(session: String) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        observationBoard = null
        recommendationBoard = null
        observationUpdated = null
        observationState = "正在读取本次开台的观察与推荐"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchObservation(session)
            } catch (e: Exception) {
                observationState = e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchObservation(session: String) {
        observationBoard = null
        recommendationBoard = null
        observationUpdated = null
        val actor = identity ?: error("请重新登录")
        val failures = mutableListOf<String>()
        if (actor.allows("observation.record"))
            try {
                val board =
                    withContext(Dispatchers.IO) {
                        ObservationBoard(
                            api.data(
                                "/api/staff/native-table-sessions/" +
                                    LiveCommand.part(session) +
                                    "/observations"
                            )
                        )
                    }
                require(board.session == session) { "桌次不一致" }
                observationBoard = board
            } catch (e: Exception) {
                failures.add("观察：" + e.message)
            }
        if (actor.allows("recommendation.staff.modify"))
            try {
                val board =
                    withContext(Dispatchers.IO) {
                        RecommendationBoard(
                            api.data(
                                "/api/staff/native-customer-experience/recommendations?tableSessionId=" +
                                    LiveCommand.part(session)
                            )
                        )
                    }
                require(board.session == session) { "桌次不一致" }
                recommendationBoard = board
            } catch (e: Exception) {
                failures.add("推荐：" + e.message)
            }
        observationEmployee = actor.employeeId
        observationUpdated = java.time.Instant.now()
        observationState =
            if (failures.isEmpty()) "已读取本次开台记录 · 操作前超过一分钟请刷新" else failures.joinToString("\n")
        check(observationBoard != null || recommendationBoard != null) { observationState }
    }

    fun loadBenefits() {
        if (!live || busy || heartbeatBusy) return
        busy = true
        benefitBoard = null
        benefitUpdated = null
        benefitState = "正在读取权益兑付"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchBenefits()
            } catch (e: Exception) {
                benefitState = e.message ?: "读取兑付失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchBenefits() {
        val actor = identity ?: error("请先登录")
        require(actor.allows("loyalty.redemption.fulfill")) { "当前员工没有权益兑付权限" }
        val board =
            withContext(Dispatchers.IO) {
                BenefitFulfillmentBoard(api.data("/api/staff/native-benefit-fulfillment"))
            }
        require(board.rows.map { it.id }.toSet().size == board.rows.size) { "兑付记录重复，请刷新" }
        benefitBoard = board
        benefitEmployee = actor.employeeId
        benefitUpdated = java.time.Instant.now()
        benefitState = "${board.date}营业日 · 已读取${board.rows.size}条 · 超过一分钟请刷新"
    }

    fun loadMember(value: String) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        memberAccount = null
        memberParticipation = null
        memberVisit = null
        memberUpdated = null
        memberState = "正在读取会员"
        viewModelScope.launch {
            try {
                val code = MemberCommands.code(value)
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchMember(code)
            } catch (e: Exception) {
                memberState = e.message ?: "读取会员失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchMember(code: String) {
        val actor = identity ?: error("请登录员工")
        require(actor.allows("loyalty.account.view")) { "当前员工没有会员查询权限" }
        val part =
            withContext(Dispatchers.IO) {
                api.data("/api/staff/member-participation/lookup", JSONObject().put("code", code))
            }
        val account =
            withContext(Dispatchers.IO) {
                api.data("/api/staff/loyalty/accounts?memberNo=" + LiveCommand.part(code))
            }
        val visit =
            withContext(Dispatchers.IO) {
                MemberVisitStatus(
                    api.data("/api/staff/member-visits/lookup", JSONObject().put("code", code))
                )
            }
        require(
            part.getString("memberNo") == code &&
                account.getString("memberNo") == code &&
                visit.memberNo == code
        ) {
            "会员记录不一致，请刷新"
        }
        memberParticipation = part
        memberAccount = account
        memberVisit = visit
        memberEmployee = actor.employeeId
        memberUpdated = java.time.Instant.now()
        memberState = "会员已读取 · ${visit.date}营业日"
    }

    suspend fun readMembershipOverview():MembershipOverview {
        check(!busy&&!heartbeatBusy) { "正在处理其他请求，请稍后刷新" }
        val actor=identity?:error("请登录");require(actor.allows("loyalty.policy.view"));val access=priorityAccessKey;val workspace=workspaceVersion
        busy=true
        try {
            val result=withContext(Dispatchers.IO){
                val auth=api.heartbeat();require(auth.employeeId==actor.employeeId&&auth.allows("loyalty.policy.view")){"会员规则查看权限已变化"}
                fun rows(path:String)=JSONObject(api.raw(path).text).getJSONArray("data").objects()
                val points=publishedMembershipRows(rows("/api/staff/loyalty/policies"))
                val tiers=publishedMembershipRows(rows("/api/staff/loyalty/tier-policies"))
                val benefits=publishedMembershipRows(api.data("/api/staff/loyalty/tier-benefits").getJSONArray("policies").objects())
                val catalog=api.data("/api/staff/loyalty/redemption-configuration")
                auth to MembershipOverview(points,tiers,benefits,catalog)
            }
            require(access==priorityAccessKey&&workspace==workspaceVersion){"员工身份已变化，请重新读取"}
            identity=result.first
            return result.second
        } catch(e:Exception){handleLiveError(e);throw e} finally{busy=false}
    }

    fun loadMemberRewards(status: String = "pending", more: Boolean = false) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        memberRewardUpdated = null
        if (!more) memberRewards = null
        memberRewardState = "正在读取签到奖励"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchMemberRewards(status, more)
            } catch (e: Exception) {
                memberRewardState = e.message ?: "读取奖励失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchMemberRewards(status: String, more: Boolean = false) {
        val actor = identity ?: error("请登录员工")
        require(
            actor.allows("loyalty.configuration.view") &&
                status in listOf("pending", "issued", "rejected", "invalid", "all") &&
                (!more || status == memberRewardFilter && memberRewardEmployee == actor.employeeId)
        ) {
            "请重新选择奖励查询范围并核对权限"
        }
        val cursor = if (more) memberRewards?.next else null
        require(!more || cursor != null) { "当前没有下一页" }
        val board =
            withContext(Dispatchers.IO) {
                api.data(
                    "/api/staff/member-visit-rewards?status=" +
                        status +
                        (cursor?.let { "&cursor=" + LiveCommand.part(it) } ?: "")
                )
            }
        val rows = board.getJSONArray("items").objects()
        require(rows.map { it.getString("id") }.distinct().size == rows.size)
        if (more) {
            val ids = rows.map { it.getString("id") }.toSet()
            val previous = memberRewards?.rows.orEmpty().filter { it.getString("id") !in ids }
            board.put("items", org.json.JSONArray(previous + rows))
        }
        memberRewards = MemberRewardBoard(board)
        memberRewardFilter = status
        memberRewardEmployee = actor.employeeId
        memberRewardUpdated = java.time.Instant.now()
        memberRewardState = "已读取${memberRewards!!.rows.size}条奖励记录；发券和实物领取分别确认。"
    }

    fun loadDevices() {
        if(!live || busy || heartbeatBusy) return
        busy = true; deviceUpdated = null; deviceBoard = null; printBridges = emptyList(); deviceState = "正在读取打印设备与路由"
        viewModelScope.launch {
            try { identity = withContext(Dispatchers.IO) { api.heartbeat() }; fetchDevices() }
            catch(e: Exception) { deviceState = if((e as? StaffAPIError)?.status == 404) "后台尚未启用原生打印设备管理，请继续使用现有网页" else e.message ?: "读取失败"; handleLiveError(e) }
            finally { busy = false }
        }
    }
    private suspend fun fetchDevices() {
        val actor = identity ?: error("请登录员工")
        require(actor.allows("hardware.manage") || actor.allows("printer.manage"))
        val board = withContext(Dispatchers.IO) { DeviceBoard(api.data("/api/hardware/native-management")) }
        require(board.employee == actor.employeeId)
        val bridges = withContext(Dispatchers.IO) { JSONObject(api.raw("/api/hardware/print-bridges").text).getJSONArray("data").objects() }
        bridgeRevocationEnabled = withContext(Dispatchers.IO) { runCatching { api.data("/api/hardware/native-print-bridges/capabilities").optBoolean("durableRevocation") }.getOrDefault(false) }
        deviceBoard = board; printBridges = bridges; deviceUpdated = java.time.Instant.now()
        deviceState = "${board.devices.size}台打印机 · ${board.routes.size}条路由；配置启用不等于设备在线或已出纸。"
    }
    fun prepareDevice(body: JSONObject, confirmation: String): LiveCommand {
        check(canUseDevices) { "配置已过期或权限变化，请刷新后重试" }
        if(body.getString("kind")=="bridge-revoke") require(bridgeRevocationEnabled) { "后台未启用桥接器安全撤销" }
        return DeviceCommands.make(body,identity!!,confirmation)
    }

    fun loadSongs(filter: String = songFilter) {
        if (!live || busy || heartbeatBusy) return
        busy = true; songUpdated = null; songs = emptyList(); songEnabled = false
        songEvidence = emptyList(); songEvidenceID = null; performances = null; songState = "正在读取点歌与演出"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchSongs(filter)
            } catch(e: Exception) { songState = e.message ?: "读取失败"; handleLiveError(e) }
            finally { busy = false }
        }
    }
    private suspend fun fetchSongs(filter: String) {
        val actor = identity ?: error("请登录员工")
        require(actor.allows("song.view") || actor.allows("song.manage")) { "没有点歌查看权限" }
        require(filter in SongCommands.statuses)
        val rows = withContext(Dispatchers.IO) { JSONObject(api.raw("/api/staff/song-requests?status=$filter").text).getJSONArray("data").objects().map(::LiveSong) }
        require(rows.map { it.id }.distinct().size == rows.size)
        val capability = withContext(Dispatchers.IO) { runCatching { api.data("/api/staff/native-song-capabilities").optBoolean("durableTransitions") }.getOrDefault(false) }
        val daily = withContext(Dispatchers.IO) { api.data("/api/staff/performances/today") }
        songs = rows; performances = daily; songEnabled = capability; songFilter = filter
        songEvidence = emptyList(); songEvidenceID = null; songEmployee = actor.employeeId; songUpdated = java.time.Instant.now()
        songState = "已读取${rows.size}条${SongCommands.statuses[filter]}点歌" + (if(rows.size >= 500) "；已到500条上限" else "") +
            (if(!capability) "；当前后台未启用原生安全处理，仅可查看" else "")
    }
    fun loadSongEvidence(id: String) {
        if (!canUseSongs || identity?.allows("song.payment.record") != true) return
        busy = true; songEvidence = emptyList(); songEvidenceID = null
        val original = identity?.employeeId
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                require(identity?.employeeId == original && identity?.allows("song.payment.record") == true)
                val rows = withContext(Dispatchers.IO) { JSONObject(api.raw("/api/staff/native-song-requests/${LiveCommand.part(id)}/payment-evidence").text).getJSONArray("data").objects() }
                songEvidence = rows; songEvidenceID = id
            } catch(e: Exception) { message = e.message ?: "付款凭证读取失败"; handleLiveError(e) }
            finally { busy = false }
        }
    }
    fun prepareSong(id: String, action: String, reason: String, amount: String, evidenceId: String?): LiveCommand {
        check(canUseSongs) { "点歌数据已过期或权限变化，请刷新后重新核对" }
        val row = songs.first { it.id == id }
        val evidence = if(action == "paid") {
            require(songEvidenceID == id) { "请先读取原付款凭证" }
            songEvidence.firstOrNull { it.getString("reconciliationEntryId") == evidenceId } ?: error("请选择已核对的原付款")
        } else null
        return SongCommands.command(row, identity!!, action, reason, amount, evidence)
    }

    private fun saveReceptionRefusal(command: LiveCommand, error: StaffAPIError) {
        val step = command.steps.single()
        val evidence = JSONObject().put("commandId", command.id).put("employeeId", command.employeeID)
            .put("path", step.path).put("requestKey", step.key).put("status", error.status)
            .put("code", error.code).put("commitDisposition", error.commitDisposition)
            .put("recordedAt", java.time.Instant.now().toString())
        val target = AtomicFile(File(getApplication<Application>().filesDir, "reservation-refusal-${command.id}.json"))
        val stream = target.startWrite()
        try { stream.write(evidence.toString().toByteArray()); target.finishWrite(stream) }
        catch (e: Exception) { target.failWrite(stream); throw e }
    }

    private suspend fun refreshReceptionIdentity(token: ReceptionReadToken): StaffIdentity {
        requireReceptionRead(token)
        val actor = withContext(Dispatchers.IO) { api.heartbeat() }
        requireReceptionRead(token)
        identity = actor
        requireReceptionRead(token)
        require(actor.allows("reservation.view")) { "当前员工没有预约查看权限" }
        val capability = withContext(Dispatchers.IO) { api.data("/api/staff/native-reservation-capabilities") }
        requireReceptionRead(token)
        reservationCapabilities = capability
        receptionActor = actor.employeeId
        return actor
    }

    private fun requireReceptionCapabilities() {
        require(reservationCapabilities?.opt("admissionCreateV1") == true && reservationCapabilities?.opt("receptionSeatV1") == true) {
            "后台尚未启用新版预约接待，请更新后台；原未决请求仍可核对"
        }
    }

    private fun beginReceptionRead(target: String, status: String, viewToken: Long?): ReceptionReadToken? {
        if (!live || (viewToken != null && (!isReceptionViewCurrent(viewToken) || receptionTarget != target))) return null
        if (receptionTarget != target) selectReception(target) else invalidateReceptionRead()
        if (busy || heartbeatBusy) {
            receptionState = "等待原读取结束后刷新当前预约"
            return null
        }
        busy = true; receptionState = status
        return receptionToken()
    }

    fun loadReceptionOptions(arrival: java.time.Instant, end: java.time.Instant, viewToken: Long? = null) {
        val token = beginReceptionRead("create", "正在读取所选时段名额", viewToken) ?: return
        viewModelScope.launch {
            try {
                val actor = refreshReceptionIdentity(token)
                require(actor.allows("reservation.manage")) { "当前员工没有预约管理权限" }
                requireReceptionCapabilities()
                val options = withContext(Dispatchers.IO) { ReservationReceptionOptions(api.data(ReservationReceptionOptions.path(arrival, end))) }
                requireReceptionRead(token)
                require(options.arrival == arrival && options.end == end) { "预约时段已变化，请重新读取" }
                receptionOptions = options; receptionOptionsUpdated = java.time.Instant.now()
                receptionState = "名额已读取；最终名额以提交时核验为准"
            } catch(e: CancellationException) { throw e
            } catch(e: Exception) { if (receptionReadCurrent(token)) { receptionState = e.message ?: "名额读取失败"; handleLiveError(e) } }
            finally { busy = false }
        }
    }

    fun loadReceptionDetail(id: String, viewToken: Long? = null) {
        val token = beginReceptionRead(id, "正在读取预约接待详情", viewToken) ?: return
        viewModelScope.launch {
            try {
                refreshReceptionIdentity(token)
                val detail = withContext(Dispatchers.IO) { ReservationReceptionDetail(api.data(ReservationReceptionDetail.path(id))) }
                requireReceptionRead(token)
                require(detail.reservation.id == id) { "预约已变化" }
                receptionDetail = detail
                receptionState = "预约接待详情已读取"
            } catch(e: CancellationException) { throw e
            } catch(e: Exception) { if (receptionReadCurrent(token)) { receptionState = e.message ?: "预约详情读取失败"; handleLiveError(e) } }
            finally { busy = false }
        }
    }

    fun loadReceptionSessions(id: String, viewToken: Long? = null) {
        val token = beginReceptionRead(id, "正在核对当前实际桌次", viewToken) ?: return
        viewModelScope.launch {
            try {
                val actor = refreshReceptionIdentity(token)
                require(actor.allows("reservation.manage") && actor.allows("table.open")) { "请由具有预约管理和开台权限的员工核对" }
                requireReceptionCapabilities()
                val detail = withContext(Dispatchers.IO) { ReservationReceptionDetail(api.data(ReservationReceptionDetail.path(id))) }
                requireReceptionRead(token)
                val board = withContext(Dispatchers.IO) { ReservationReceptionSessions(api.data(ReservationReceptionSessions.path(id))) }
                requireReceptionRead(token)
                require(board.reservationId == id && detail.reservation.id == id &&
                    detail.reservation.source.getLong("aggregateVersion") == board.version && detail.reservation.status == board.status && detail.reservation.count == board.guestCount) {
                    "预约在读取期间已变化，请重新读取整组实际桌次"
                }
                receptionDetail = detail; receptionSessions = board; receptionSessionsUpdated = java.time.Instant.now()
                receptionState = "仅列当前营业日、您有权且尚未关联预约的已开桌次"
            } catch(e: CancellationException) { throw e
            } catch(e: Exception) { if (receptionReadCurrent(token)) { receptionState = e.message ?: "实际桌次读取失败"; handleLiveError(e) } }
            finally { busy = false }
        }
    }

    fun prepareReceptionCreate(draft: ReservationReceptionDraft, viewToken: Long? = null): LiveCommand {
        require(viewToken == null || isReceptionViewCurrent(viewToken)) { "预约页面已变化，请重新核对" }
        require(canCreateReception) { "名额或权限已过期，请重新读取时段" }
        return draft.command(identity!!, receptionOptions!!).also {
            receptionPreparedId = it.id; receptionPreparedToken = receptionToken()
        }
    }

    fun prepareReceptionSeat(id: String, selectedSessionIds: Set<String>, reason: String, viewToken: Long? = null): LiveCommand {
        require(viewToken == null || isReceptionViewCurrent(viewToken)) { "预约页面已变化，请重新核对" }
        require(canSeatReception && receptionDetail?.reservation?.id == id) { "预约或实际桌次已过期，请重新读取" }
        return reservationReceptionSeatCommand(receptionDetail!!.reservation, receptionSessions!!, selectedSessionIds, reason, identity!!).also {
            receptionPreparedId = it.id; receptionPreparedToken = receptionToken()
        }
    }

    fun loadReservations(query: ReservationQuery) {
        if (!live || busy || heartbeatBusy) return
        busy = true
        reservationUpdated = null
        reservationCapabilities = null
        reservationTables = emptyList()
        reservations = emptyList()
        reservationIntake = emptyList()
        reservationState = "正在读取预约与候位"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchReservations(query)
            } catch (e: Exception) {
                reservationState = e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchReservations(query: ReservationQuery) {
        val actor = identity ?: error("请登录原员工")
        require(actor.allows("reservation.view")) { "当前员工没有预约查看权限" }
        val path = query.path
        val queuePath = query.intakePath
        val rows =
            withContext(Dispatchers.IO) {
                JSONObject(api.raw(path).text).getJSONArray("data").objects().map(::LiveReservation)
            }
        val queue =
            withContext(Dispatchers.IO) {
                JSONObject(api.raw(queuePath).text)
                    .getJSONArray("data")
                    .objects()
                    .map(::LiveReservationIntake)
            }
        require(
            rows.map { it.id }.distinct().size == rows.size &&
                queue.map { it.id }.distinct().size == queue.size
        ) {
            "服务器记录重复，请刷新"
        }
        val capability =
            withContext(Dispatchers.IO) {
                runCatching { api.data("/api/staff/native-reservation-capabilities") }.getOrNull()
            }
        if (capability != null) {
            val waitlistEnabled = withContext(Dispatchers.IO) {
                runCatching { api.data("/api/staff/native-waitlist-capabilities").optBoolean("durableTransitions") }.getOrDefault(false)
            }
            capability.put("durableWaitlist", waitlistEnabled)
        }
        reservations = rows
        reservationIntake = queue
        reservationTables = emptyList() // Legacy table-bound creation is recovery-only.
        reservationCapabilities = capability
        reservationQuery = query
        reservationEmployee = actor.employeeId
        reservationUpdated = java.time.Instant.now()
        reservationState =
            "读取${rows.size}条预约、${queue.size}条安排；优先队列按所选自然日查询。" +
                (if (rows.size >= 500 || queue.size >= 1000) "已达到读取上限，请缩小日期范围。" else "") +
                (if (capability == null) "当前服务器尚未启用 App 安全操作，可查看记录。" else "")
    }

    fun prepareReservation(
        id: String,
        action: String,
        reason: String,
        override: Boolean,
    ): LiveCommand {
        check(canUseReservations) { "预约已过期或权限已变化，请刷新" }
        val row = reservations.first { it.id == id }
        return ReservationCommands.transition(row, action, reason, override, identity!!)
    }

    fun prepareWaitlist(id: String, to: String, reason: String): LiveCommand {
        check(canUseReservations && reservationCapabilities?.optBoolean("durableWaitlist") == true) { "候位操作尚未启用或数据已过期，请刷新" }
        return ReservationCommands.waitlist(reservationIntake.first { it.id == id }, to, reason, identity!!)
    }

    fun prepareReservationPriority(id: String, mode: String, reason: String): LiveCommand {
        check(
            canUseReservations && reservationCapabilities?.optBoolean("durablePriority") == true
        ) {
            "队列已过期或权限已变化，请刷新"
        }
        return ReservationCommands.priority(
            reservationIntake.first { it.id == id },
            mode,
            reason,
            identity!!,
        )
    }

    fun loadParticipants(tableID: String) {
        if (!live || busy || heartbeatBusy || identity?.allows(ParticipantInput.permission) != true)
            return
        busy = true
        resetParticipantPreview()
        participants = emptyList()
        participantState = "正在读取顾客名单"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                loadOperations()
                val table = liveOperations?.tables?.find { it.display.id == tableID }
                require(
                    identity?.allows(ParticipantInput.permission) == true &&
                        table?.sessionStatus == "open" &&
                        table.display.session != null
                ) {
                    "原桌次已结束或权限已变化"
                }
                val members =
                    withContext(Dispatchers.IO) {
                        JSONObject(
                                api.raw(
                                        "/api/table-management/sessions/" +
                                            LiveCommand.part(table!!.display.session!!) +
                                            "/participants"
                                    )
                                    .text
                            )
                            .getJSONArray("data")
                            .objects()
                            .map(LiveParticipant::parse)
                    }
                require(members.map { it.id }.distinct().size == members.size) { "顾客名单重复，请刷新" }
                participants = members
                participantState =
                    if (members.isEmpty()) "暂无已识别顾客；仅在全部业务结清后按整桌人数并桌。" else "请当面确认所选顾客，历史账单不会迁移。"
            } catch (e: Exception) {
                participantState = e.message ?: "读取失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun previewParticipants(input: ParticipantInput) {
        if (
            busy ||
                heartbeatBusy ||
                livePending != null ||
                liveOrderPending != null ||
                identity?.employeeId != input.employeeID
        )
            return
        busy = true
        resetParticipantPreview()
        participantState = "正在核对未结业务、人数和容量"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                require(
                    identity?.employeeId == input.employeeID &&
                        identity?.allows(ParticipantInput.permission) == true
                ) {
                    "原员工或权限已变化"
                }
                val preview =
                    withContext(Dispatchers.IO) {
                        ParticipantPreview(
                            api.data(input.path + "/participant-movements/preview", input.body())
                        )
                    }
                participantInput = input
                participantPreview = preview
                participantUpdated = java.time.Instant.now()
                participantState =
                    if (preview.enabled) "预检完成，提交时仍会重新检查" else "当前服务器尚未启用 App 安全拆并桌，请使用网页处理。"
            } catch (e: Exception) {
                participantState = e.message ?: "预检失败"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareParticipants(confirmed: Boolean): LiveCommand {
        check(canUseParticipants) { "请重新预检并确认现场" }
        val command = participantPreview!!.command(participantInput!!, identity!!, confirmed)
        participantPrepared = command
        return command
    }

    fun loadLiveOrders(session: String) {
        liveOrders = emptyList()
        if (
            !live ||
                identity == null ||
                !(identity!!.allows("service.execute") || identity!!.allows("order.view"))
        ) {
            orderDetailState = "当前岗位无订单查看权限"
            return
        }
        if (busy || heartbeatBusy) {
            orderDetailState = "正在同步，请稍后点击刷新"
            return
        }
        busy = true
        orderDetailState = "正在读取订单"
        viewModelScope.launch {
            try {
                liveOrders =
                    withContext(Dispatchers.IO) {
                        val rows =
                            JSONObject(
                                    api.raw(
                                            "/api/commerce/table-sessions/${LiveCommand.part(session)}/order-details"
                                        )
                                        .text
                                )
                                .getJSONArray("data")
                        (0 until rows.length()).map {
                            LiveOrderDetail.parse(rows.getJSONObject(it))
                        }
                    }
                orderDetailState = if (liveOrders.isEmpty()) "此桌次暂无订单" else ""
            } catch (e: Exception) {
                orderDetailState = "读取失败，请重试"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun liveDraft(session: String, replacement: LiveReplacement? = null): List<LiveDraftLine> {
        val employee = identity?.employeeId ?: return emptyList()
        if (!live) return emptyList()
        return liveDraftBook.entries[
                LiveDraftBook.key(employee, replacement?.draftSession ?: session)]
            .orEmpty()
    }

    private fun saveDraftBook(book: LiveDraftBook) {
        check(!draftStorageDamaged) { "点单草稿无法读取，请联系管理员检查设备存储" }
        val output = liveDraftFile.startWrite()
        try {
            output.write(book.json().toString().toByteArray(Charsets.UTF_8))
            liveDraftFile.finishWrite(output)
        } catch (e: Exception) {
            liveDraftFile.failWrite(output)
            throw e
        }
        liveDraftBook = book
    }

    fun addLiveProduct(
        product: LiveProduct,
        choices: Map<String, List<String>>,
        note: String,
        session: String,
        replacement: LiveReplacement? = null,
    ) {
        val employee = identity?.employeeId
        check(
            live &&
                employee != null &&
                identity?.allows("order.create") == true &&
                !busy &&
                (livePending == null && liveOrderPending == null) &&
                catalogUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds < 300
                } == true &&
                liveOperations?.tables?.any {
                    it.display.session == session && it.sessionStatus == "open"
                } == true
        ) {
            "请刷新商品和桌台后再点单"
        }
        val latest = liveProducts.find { it.id == product.id } ?: error("请刷新商品后再点单")
        saveDraftBook(
            liveDraftBook.add(
                LiveDraftLine.make(latest, choices, note),
                employee,
                replacement?.draftSession ?: session,
            )
        )
    }

    fun removeLiveLine(id: String, session: String, replacement: LiveReplacement? = null) {
        val employee = identity?.employeeId ?: return
        if (busy || (livePending != null || liveOrderPending != null)) return
        val key = LiveDraftBook.key(employee, replacement?.draftSession ?: session)
        try {
            saveDraftBook(
                liveDraftBook.copy(
                    entries =
                        liveDraftBook.entries +
                            (key to liveDraftBook.entries[key].orEmpty().filter { it.id != id })
                )
            )
        } catch (e: Exception) {
            message = e.message ?: "草稿保存失败"
        }
    }

    fun loadLiveCatalog(replacement: LiveReplacement? = null) {
        if (!live || identity?.allows("order.create") != true) {
            catalogState = "当前岗位无点单权限"
            return
        }
        if (busy || heartbeatBusy) {
            catalogState = "正在同步，请稍后点击刷新"
            return
        }
        busy = true
        liveProducts = emptyList()
        catalogUpdated = null
        catalogState = "正在读取商品"
        viewModelScope.launch {
            try {
                if (replacement != null) loadOperations()
                val products =
                    withContext(Dispatchers.IO) {
                        JSONObject(api.raw("/api/catalog/assisted-order-products").text)
                            .getJSONArray("data")
                            .objects()
                            .map { LiveProduct(it.toString()) }
                    }
                if (products.map { it.id }.distinct().size != products.size) invalidResponse()
                liveProducts =
                    products.sortedWith(
                        compareBy<LiveProduct> { it.menuSortOrder }.thenBy { it.code }
                    )
                catalogUpdated = java.time.Instant.now()
                catalogState = if (products.isEmpty()) "当前无商品" else ""
            } catch (e: Exception) {
                catalogState = "读取失败，请重新读取"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private fun saveOrderPending(command: LiveOrderSubmission) {
        command.validate()
        val output = orderPendingFile.startWrite()
        try {
            output.write(command.json().toString().toByteArray(Charsets.UTF_8))
            orderPendingFile.finishWrite(output)
        } catch (e: Exception) {
            orderPendingFile.failWrite(output)
            throw e
        }
        liveOrderPending = command
    }

    private fun finishLiveOrder(command: LiveOrderSubmission) {
        val receipt = command.receipt ?: invalidResponse()
        require(command.canFinish) { "换品原关联尚未核对" }
        val key = LiveDraftBook.key(command.employeeID, command.draftSession)
        saveDraftBook(
            liveDraftBook.copy(
                entries =
                    liveDraftBook.entries +
                        (key to
                            liveDraftBook.entries[key].orEmpty().filter {
                                it.id !in command.draftIDs
                            })
            )
        )
        orderPendingFile.delete()
        check(
            !orderPendingFile.baseFile.exists() &&
                !File(orderPendingFile.baseFile.path + ".bak").exists() &&
                !File(orderPendingFile.baseFile.path + ".new").exists()
        ) {
            "请求记录无法清除，请检查设备空间"
        }
        liveOrderPending = null
        lastOrderReceipt = receipt
        val amount =
            receipt.amount?.let { "¥" + String.format(java.util.Locale.CHINA, "%.2f", it / 100.0) }
                ?: "待核对"
        message = "订单已确认：${receipt.publicId} · $amount。收款状态请在原订单核对。"
    }

    private suspend fun verifyReplacementReceipt(
        command: LiveOrderSubmission
    ): LiveOrderSubmission {
        val replacement = command.replacement ?: return command
        val board =
            withContext(Dispatchers.IO) {
                LiveAfterSales(
                    api.data(
                        "/api/commerce/item-after-sales/items/" +
                            LiveCommand.part(replacement.itemID)
                    )
                )
            }
        require(
            command.receipt != null &&
                replacement.recoveredReceipt(board, command.publicId, command.receipt.id) != null
        ) {
            "新单关联尚未核对，已保留原请求，请查询原单，不要重复换品"
        }
        return command.copy(replacementVerified = true)
    }

    private suspend fun sendLiveOrder(command: LiveOrderSubmission) {
        val receipt = withContext(Dispatchers.IO) { api.submitOrder(command) }
        val acknowledged = command.copy(receipt = receipt)
        // Checkpoint creation before any secondary read can fail.
        saveOrderPending(acknowledged)
        val verified = verifyReplacementReceipt(acknowledged)
        saveOrderPending(verified)
        finishLiveOrder(verified)
    }

    fun submitLiveOrder(
        session: String,
        tableCode: String,
        expectedDraftIDs: List<String>,
        gift: Boolean,
        reason: String,
        note: String,
        settlement: String,
        replacement: LiveReplacement? = null,
    ) {
        if (
            !live ||
                identity?.allows("order.create") != true ||
                busy ||
                heartbeatBusy ||
                livePending != null ||
                liveOrderPending != null ||
                liveStorageDamaged ||
                draftStorageDamaged
        )
            return
        val lines = liveDraft(session, replacement)
        if (lines.map { it.id } != expectedDraftIDs || lines.isEmpty()) {
            message = "清单已变化，请重新核对后提交"
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                loadOperations()
                val auth = identity ?: invalidResponse()
                require(
                    liveOperations?.tables?.any {
                        it.display.session == session &&
                            it.sessionStatus == "open" &&
                            it.display.code == tableCode
                    } == true
                ) {
                    "桌台已变化，请返回桌台重新核对"
                }
                val command =
                    withContext(Dispatchers.IO) {
                        val source =
                            replacement?.let {
                                LiveAfterSales(
                                    api.data(
                                        "/api/commerce/item-after-sales/items/" +
                                            LiveCommand.part(it.itemID)
                                    )
                                )
                            }
                        val access =
                            LiveOrderAccess.parse(api.data("/api/commerce/assisted-order-access"))
                        val products =
                            JSONObject(api.raw("/api/catalog/assisted-order-products").text)
                                .getJSONArray("data")
                                .objects()
                                .map { LiveProduct(it.toString()) }
                        val context =
                            LiveOrderContext.parse(
                                api.data(
                                    "/api/commerce/assisted-order-contexts",
                                    JSONObject().put("tableSessionId", session),
                                )
                            )
                        LiveOrderSubmission.make(
                            lines,
                            products,
                            auth,
                            access,
                            context,
                            session,
                            tableCode,
                            gift,
                            reason,
                            note,
                            settlement,
                            replacement,
                            source,
                        )
                    }
                saveOrderPending(command)
                sendLiveOrder(command)
                loadOperations()
            } catch (e: Exception) {
                val command = liveOrderPending
                val code = LiveOrderSubmission.initialRejection(e)
                if (command != null && command.receipt == null && code != null) {
                    try {
                        saveOrderPending(command.copy(rejectedCode = code))
                    } catch (_: Exception) {
                        liveStorageDamaged = true
                    }
                }
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun recoverLiveOrder() {
        val command = liveOrderPending ?: return
        if (
            command.rejectedCode != null ||
                command.employeeID != identity?.employeeId ||
                busy ||
                heartbeatBusy
        )
            return
        busy = true
        viewModelScope.launch {
            try {
                if (command.receipt != null) {
                    var verified = command
                    if (command.replacement != null && !command.replacementVerified) {
                        identity = withContext(Dispatchers.IO) { api.heartbeat() }
                        require(identity?.employeeId == command.employeeID) { "请切回原员工核对" }
                        verified = verifyReplacementReceipt(command)
                        saveOrderPending(verified)
                    }
                    finishLiveOrder(verified)
                    return@launch
                }
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                val auth = identity ?: invalidResponse()
                require(auth.employeeId == command.employeeID)
                if (command.replacement != null) {
                    val board =
                        withContext(Dispatchers.IO) {
                            LiveAfterSales(
                                api.data(
                                    "/api/commerce/item-after-sales/items/" +
                                        LiveCommand.part(command.replacement.itemID)
                                )
                            )
                        }
                    val receipt = command.replacement.recoveredReceipt(board, command.publicId)
                    if (receipt != null) {
                        val confirmed = command.copy(receipt = receipt, replacementVerified = true)
                        saveOrderPending(confirmed)
                        finishLiveOrder(confirmed)
                        loadOperations()
                        return@launch
                    }
                }
                if (
                    command.replacement == null &&
                        (auth.allows("service.execute") || auth.allows("order.view"))
                ) {
                    val orders =
                        withContext(Dispatchers.IO) {
                            JSONObject(
                                    api.raw(
                                            "/api/commerce/table-sessions/${LiveCommand.part(command.tableSessionID)}/order-details"
                                        )
                                        .text
                                )
                                .getJSONArray("data")
                                .objects()
                                .map(LiveOrderDetail::parse)
                        }
                    val found = orders.find { it.id == command.publicId }
                    if (found != null) {
                        val confirmed =
                            command.copy(
                                receipt =
                                    LiveOrderReceipt(found.id, null, found.amount?.toLong(), true)
                            )
                        saveOrderPending(confirmed)
                        finishLiveOrder(confirmed)
                        loadOperations()
                        return@launch
                    }
                }
                require(command.canReplay(auth)) { "暂未查到原订单。登录会话或营业日已变化，已保留原请求，请由主管按订单号核对；不要重新下单。" }
                sendLiveOrder(command)
                loadOperations()
            } catch (e: Exception) {
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun dismissRejectedOrder() {
        val command = liveOrderPending ?: return
        if (command.rejectedCode == null || command.employeeID != identity?.employeeId || busy)
            return
        try {
            orderPendingFile.delete()
            check(
                !orderPendingFile.baseFile.exists() &&
                    !File(orderPendingFile.baseFile.path + ".bak").exists() &&
                    !File(orderPendingFile.baseFile.path + ".new").exists()
            )
            liveOrderPending = null
            catalogUpdated = null
            lastUpdated = null
            connection = "请刷新后修改清单"
            message = "订单未创建，原清单已保留。请刷新后修改。"
        } catch (_: Exception) {
            message = "请求记录无法清除，请检查设备空间"
        }
    }

    private suspend fun fetchPaymentOrders(session: String) {
        val orders =
            withContext(Dispatchers.IO) {
                JSONObject(
                        api.raw(
                                "/api/commerce/table-sessions/${LiveCommand.part(session)}/payment-orders"
                            )
                            .text
                    )
                    .getJSONArray("data")
                    .objects()
                    .map(LivePaymentOrder::parse)
            }
        require(orders.map { it.id }.distinct().size == orders.size)
        paymentOrders = orders
        paymentSession = session
        paymentUpdated = java.time.Instant.now()
        paymentState = if (orders.isEmpty()) "本桌暂无可收款订单" else ""
    }

    fun loadPaymentOrders(session: String) {
        val auth = identity
        if (!live || auth == null || LivePaymentOrder.permissions.none(auth::allows)) {
            paymentState = "当前岗位无收款查看权限"
            return
        }
        if (busy || heartbeatBusy) {
            paymentState = "正在同步，请稍后点击刷新"
            return
        }
        busy = true
        paymentOrders = emptyList()
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPlatforms = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        voucherHistory = emptyList()
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        printActor = null
        printUpdated = null
        afterSales = null
        afterSalesUpdated = null
        afterSalesActor = null
        afterSalesPendingRows = emptyList()
        onlineAccess = null
        onlineStatuses = emptyMap()
        onlineState = ""
        paymentSession = null
        paymentUpdated = null
        paymentState = "正在读取应收"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                loadOperations()
                fetchPaymentOrders(session)
            } catch (e: Exception) {
                paymentState = "读取失败，金额待核对"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareCollection(
        session: String,
        ids: Set<String>,
        amount: Int,
        provider: String,
        reference: String,
        terminal: String,
        method: String,
        note: String,
    ): LiveCommand {
        val auth = identity ?: error("请先登录")
        require(
            paymentSession == session &&
                paymentUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds < 60
                } == true
        ) {
            "请刷新本桌收款状态后再操作"
        }
        val orders = paymentOrders.filter { it.id in ids }
        require(orders.size == ids.size) { "订单已变化，请重新选择" }
        val command =
            manualCollection(
                orders,
                auth,
                amount,
                provider,
                reference,
                terminal,
                method,
                note,
                session,
            )
        require(canAct(command.permission)) { "请刷新登录和桌台状态后重试" }
        return command
    }

    suspend fun readFulfillmentHistory(kind:String,date:String,table:String,page:Int):LiveHistory{
        val actor=identity?:error("请登录");val access=priorityAccessKey;val version=workspaceVersion
        require(canReadFulfillmentHistory(actor));val path=fulfillmentHistoryPath(kind,date,table,page)
        val result=withContext(Dispatchers.IO){LiveHistory(api.data(path)).also{validateFulfillmentHistory(it,page)}}
        require(actor.employeeId==identity?.employeeId&&access==priorityAccessKey&&version==workspaceVersion)
        return result
    }
    private suspend fun fetchFulfillment() {
        val actor = identity ?: error("请先登录")
        require(canReadFulfillment) { "当前岗位无出品查看权限" }
        val board =
            withContext(Dispatchers.IO) { LiveFulfillment(api.data("/api/commerce/fulfillment")) }
        board.validate(actor.employeeId)
        require(identity?.employeeId == actor.employeeId) { "员工已变化" }
        fulfillmentBoard = board
        fulfillmentUpdated = java.time.Instant.now()
        fulfillmentState =
            if (!board.actor.optBoolean("supportsNativePhysicalRecovery"))
                "服务器尚未启用安全恢复，此处仅查看；请使用原网页操作"
            else if (board.actor.optBoolean("actionSessionValid")) "" else "请恢复设备登录后继续原任务"
    }

    fun loadFulfillment() {
        if (!live || !canReadFulfillment || busy || heartbeatBusy) return
        busy = true
        fulfillmentBoard = null
        fulfillmentUpdated = null
        fulfillmentState = "正在读取原出品任务"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchFulfillment()
            } catch (e: Exception) {
                fulfillmentState = "读取失败，请刷新后核对原任务"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareFulfillment(
        taskID: String,
        action: String,
        quantity: Int,
        reason: String,
        confirmed: Boolean,
    ): LiveCommand {
        require(canUseFulfillment) { "请刷新出品任务及岗位权限" }
        return fulfillmentBoard!!.command(identity!!, taskID, action, quantity, reason, confirmed)
    }

    private suspend fun fetchKitchen(station: String) {
        val auth = identity ?: invalidResponse()
        require(station in listOf("bar", "kitchen"))
        val expected = workspaceReadIdentity()
        val board =
            readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                withContext(Dispatchers.IO) {
                    LiveKitchen(api.data("/api/commerce/kitchen-board?station=$station"))
                }
            }
        if (board.employeeID != auth.employeeId || board.station != station) invalidResponse()
        kitchenBoard = board
        kitchenUpdated = java.time.Instant.now()
        kitchenState = if (board.sessionValid) "制作队列已同步 · 前台每5秒自动读取" else "出品会话已失效，请重新登录"
    }

    fun loadKitchen(station: String, automatic: Boolean = false) {
        if (!live || identity?.allows("kds.prepare") != true || busy || heartbeatBusy) {
            if (!automatic) kitchenState = "请先登录出品岗位，或等待当前同步结束后刷新"
            return
        }
        busy = true
        val original = workspaceReadIdentity()
        if (kitchenBoard?.station != station) {
            kitchenBoard = null
            kitchenUpdated = null
        }
        if (kitchenBoard == null) kitchenState = "正在读取制作队列"
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                fetchKitchen(station)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (original.employee == identity?.employeeId && original.workspace == workspaceVersion) {
                    kitchenUpdated = null
                    kitchenState = if (kitchenBoard != null) "同步失败 · 显示上次制作队列，数据已过期；请重新读取后操作" else "制作队列读取失败，请刷新重试"
                    if (!automatic || (e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                }
            } finally {
                busy = false
            }
        }
    }

    fun prepareKitchen(
        action: String,
        sourceID: String,
        quantity: Int = 1,
        equipment: String = "",
        seconds: Int? = null,
        unitIDs: Set<String> = emptySet(),
        selections: Map<String, Int> = emptyMap(),
    ): LiveCommand {
        check(canAct("kds.prepare")) { "请刷新制作队列后再操作" }
        return kitchenBoard!!.command(
            identity!!,
            action,
            sourceID,
            quantity,
            equipment,
            seconds,
            unitIDs,
            selections,
        )
    }

    fun loadKitchenHandoff(batchID: String, completed: (LiveKitchenHandoff?) -> Unit) {
        val board = kitchenBoard
        if (
            !canAct("kds.prepare") ||
                board == null ||
                !board.canHandoff ||
                identity?.allows("kds.exception.manage") != true
        ) {
            message = "请刷新制作队列并确认接班权限"
            completed(null)
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                val preview =
                    withContext(Dispatchers.IO) {
                        LiveKitchenHandoff(
                            api.data(
                                "/api/commerce/kitchen-board/handoff-preview?station=${board.station}&batchId=${LiveCommand.part(batchID)}"
                            )
                        )
                    }
                if (preview.id != batchID || preview.station != board.station) invalidResponse()
                completed(preview)
            } catch (e: Exception) {
                handleLiveError(e)
                completed(null)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchPickup() {
        val expected = workspaceReadIdentity()
        val board =
            readCurrentWorkspace(expected, { workspaceReadIdentity() }) {
                withContext(Dispatchers.IO) { LivePickup(api.data("/api/commerce/pickup-board")) }
            }
        if (board.scope.isBlank()) invalidResponse()
        pickupBoard = board
        pickupUpdated = java.time.Instant.now()
        pickupState = if (board.valid) "取餐队列已同步 · 前台每5秒自动读取" else "设备会话失效，请重新登录"
    }

    fun loadPickup(automatic: Boolean = false) {
        if (
            !live ||
                identity?.let { it.allows("kds.deliver") || it.allows("staff.access.configure") } !=
                    true ||
                busy ||
                heartbeatBusy
        ) {
            if (!automatic) pickupState = "请先登录取餐岗位，或等待同步结束后刷新"
            return
        }
        busy = true
        val original = workspaceReadIdentity()
        if (pickupBoard == null) pickupState = "正在读取取餐台"
        viewModelScope.launch {
            try {
                identity = readCurrentWorkspace(original, { workspaceReadIdentity() }) {
                    withContext(Dispatchers.IO) { api.heartbeat() }
                }
                fetchPickup()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (original.employee == identity?.employeeId && original.workspace == workspaceVersion) {
                    pickupUpdated = null
                    pickupState = if (pickupBoard != null) "同步失败 · 显示上次取餐队列，数据已过期；请重新读取后操作" else "取餐队列读取失败，请刷新重试"
                    if (!automatic || (e as? StaffAPIError)?.status in listOf(401, 403)) handleLiveError(e)
                }
            } finally {
                busy = false
            }
        }
    }

    val canReadCashier
        get() = identity?.let { actor -> LiveCashier.permissions.any(actor::allows) } == true

    private suspend fun fetchCashHandover() {
        val actor = identity ?: error("请登录")
        require(actor.allows("reconciliation.view"))
        val root =
            withContext(Dispatchers.IO) {
                JSONObject(api.raw("/api/commercial-ops/cash-handovers").text)
            }
        require(
            root.getJSONObject("meta").getInt("protocol") == 1 &&
                identity?.employeeId == actor.employeeId
        )
        cashHandover = root.getJSONObject("data")
        cashHandoverActor = actor.employeeId
        cashHandoverUpdated = java.time.Instant.now()
        cashHandoverState = "门店全部现金合计；差异与非营业取存独立留痕。最近30次交接。"
    }

    fun loadCashHandover() {
        if (!live || busy || heartbeatBusy || identity?.allows("reconciliation.view") != true)
            return
        busy = true
        cashHandover = null
        cashHandoverActor = null
        cashHandoverUpdated = null
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchCashHandover()
            } catch (e: Exception) {
                cashHandoverState = "交接读取失败，请核对原记录"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareCashHandover(
        action: String,
        amount: Long? = null,
        direction: String = "in",
        reference: String = "",
        reason: String,
        denominations: Map<String, Int> = emptyMap(),
    ): LiveCommand {
        require(canUseCashHandover) { "请刷新门店交接与权限" }
        return cashHandoverCommand(
            identity!!,
            cashHandover!!,
            action,
            amount,
            direction,
            reference,
            reason,
            denominations,
        )
    }

    fun loadVoucherHistory(day: String) {
        if (
            !live ||
                !canReadVouchers ||
                busy ||
                heartbeatBusy ||
                !Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$").matches(day)
        ) {
            message = "请填写有效营业日 YYYY-MM-DD"
            return
        }
        busy = true
        voucherHistory = emptyList()
        voucherHistoryState = "正在查询原核销记录"
        viewModelScope.launch {
            try {
                val actor = identity?.employeeId
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                val rows =
                    withContext(Dispatchers.IO) {
                        JSONObject(
                                api.raw("/api/commercial-ops/vouchers?startDate=$day&endDate=$day")
                                    .text
                            )
                            .getJSONArray("data")
                            .objects()
                    }
                require(identity?.employeeId == actor)
                voucherHistory = rows
                voucherHistoryState = "原营业日 $day，已加载${rows.size}条；未关联结算流水不能当作到账。"
            } catch (e: Exception) {
                voucherHistoryState = "原记录读取失败，不能视为没有核销"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun fetchVouchers() {
        val actor = identity ?: error("请登录")
        require(canReadVouchers)
        val platforms =
            withContext(Dispatchers.IO) {
                JSONObject(api.raw("/api/commercial-ops/vouchers/platforms").text)
                    .getJSONArray("data")
                    .objects()
            }
        val root =
            withContext(Dispatchers.IO) {
                JSONObject(api.raw("/api/commercial-ops/vouchers/operations").text)
            }
        val rows = root.getJSONArray("data").objects()
        require(
            root.getJSONObject("meta").getInt("protocol") == 1 &&
                identity?.employeeId == actor.employeeId &&
                rows.map { it.getString("id") }.distinct().size == rows.size
        )
        voucherPlatforms = platforms
        voucherOperations = rows
        voucherActor = actor.employeeId
        voucherUpdated = java.time.Instant.now()
        voucherState = "原核销事项已更新，最多100项，未完成优先；核销登记不抵减桌单，不表示平台已结算。"
    }

    fun loadVouchers() {
        if (!live || !canReadVouchers || busy || heartbeatBusy) return
        busy = true
        voucherUpdated = null
        voucherActor = null
        voucherPreview = null
        voucherCode = ""
        voucherOperations = emptyList()
        voucherPlatforms = emptyList()
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchVouchers()
            } catch (e: Exception) {
                voucherState = "核销事项读取失败或后台未升级，请核对原券，不重复核销"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareVoucherPreview(platform: String, code: String) {
        if (
            !canUseVouchers ||
                voucherPlatforms.none {
                    it.getString("code") == platform &&
                        it.getBoolean("enabled") &&
                        it.getString("mode") == "production"
                } ||
                code.length !in 4..256
        ) {
            message = "请选择已开通的正式平台并输入原券码"
            return
        }
        busy = true
        voucherPreview = null
        voucherCode = ""
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                require(identity?.allows("commercial.voucher.redeem") == true)
                val preview =
                    withContext(Dispatchers.IO) {
                        JSONObject(
                                api.raw(
                                        "/api/commercial-ops/vouchers/prepare",
                                        JSONObject()
                                            .put("platform", platform)
                                            .put("voucherCode", code),
                                    )
                                    .text
                            )
                            .getJSONObject("data")
                    }
                require(
                    preview.getString("platform") == platform &&
                        preview.getString("currency") == "CNY"
                )
                voucherPreview = preview
                voucherCode = code
                voucherUpdated = java.time.Instant.now()
                voucherActor = identity?.employeeId
            } catch (e: Exception) {
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareVoucher(
        code: String,
        orderID: String? = null,
        sessionID: String? = null,
    ): LiveCommand {
        require(canUseVouchers && code == voucherCode && voucherPreview != null) {
            "原券查询已过期或输入已改变，请重新查询"
        }
        return voucherRedeem(
            identity!!,
            voucherPreview!!,
            voucherPlatforms.first {
                it.getString("code") == voucherPreview!!.getString("platform")
            },
            code,
            orderID,
            sessionID,
            true,
        )
    }

    fun prepareVoucherAction(
        id: String,
        action: String,
        outcome: String = "consumed",
        certificate: String = "",
        verify: String = "",
        evidence: String = "",
        reason: String = "",
        confirmed: Boolean = false,
    ): LiveCommand {
        require(canUseVouchers) { "请刷新原核销事项与权限" }
        return voucherFollowup(
            identity!!,
            voucherOperations.first { it.getString("id") == id },
            action,
            outcome,
            certificate,
            verify,
            evidence,
            reason,
            confirmed,
        )
    }

    private suspend fun fetchPrinting() {
        val actor = identity ?: error("请登录")
        require(canReadPrinting)
        val jobs =
            if (
                listOf(
                        "print.view",
                        "print.view_all",
                        "print.reprint",
                        "hardware.manage",
                        "printer.manage",
                    )
                    .any { actor.allows(it) }
            )
                withContext(Dispatchers.IO) {
                    JSONObject(api.raw("/api/hardware/print-jobs?limit=200").text)
                        .getJSONArray("data")
                        .objects()
                }
            else emptyList()
        val sources =
            if (actor.allows("hardware.manage") || actor.allows("printer.manage"))
                withContext(Dispatchers.IO) {
                    JSONObject(api.raw("/api/hardware/print-sources").text)
                        .getJSONArray("data")
                        .objects()
                }
            else emptyList()
        val request =
            printReceipt
                ?.takeIf { it.getString("employeeID") == actor.employeeId }
                ?.getJSONObject("response")
                ?.getJSONObject("data")
                ?.textOrNull("requestId")
        val own =
            if (actor.allows("order.bill.print") && request != null)
                withContext(Dispatchers.IO) {
                    JSONObject(
                            api.raw("/api/hardware/print-requests/" + LiveCommand.part(request))
                                .text
                        )
                        .getJSONArray("data")
                        .objects()
                }
            else emptyList()
        require(
            identity?.employeeId == actor.employeeId &&
                jobs.map { it.getString("id") }.distinct().size == jobs.size &&
                sources.map { it.getString("id") }.distinct().size == sources.size &&
                (jobs + own).all {
                    it.getString("status") in
                        listOf("pending", "printing", "printed", "failed", "dead", "cancelled")
                }
        )
        printJobs = jobs
        printSources = sources
        ownPrintJobs = own
        printActor = actor.employeeId
        printUpdated = java.time.Instant.now()
        printState = "已读取服务器票据状态；最多200个任务，入队不代表出纸。"
    }

    fun loadPrinting() {
        if (!live || busy || heartbeatBusy || !canReadPrinting) return
        busy = true
        printUpdated = null
        printActor = null
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchPrinting()
            } catch (e: Exception) {
                printState = "票据状态读取失败，请刷新核对"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun preparePrint(
        kind: String,
        target: String,
        reason: String = "",
        confirmed: Boolean = false,
    ): LiveCommand {
        require(canUsePrinting) { "请刷新票据、会话与权限" }
        return printingCommand(
            identity!!,
            kind,
            target,
            reason,
            printJobs.find { it.getString("id") == target },
            printSources.find { it.getString("id") == target },
            confirmed,
        )
    }

    private suspend fun fetchAfterSales(itemID: String) {
        val actor = identity ?: error("请先登录")
        require(canReadAfterSales) { "当前岗位无商品售后权限" }
        val access =
            withContext(Dispatchers.IO) { api.data("/api/commerce/item-after-sales/access") }
        require(
            access.getString("employeeId") == actor.employeeId &&
                (access.getBoolean("enabled") || access.getBoolean("recoveryAvailable"))
        ) {
            "当前未开放商品售后，也没有可恢复的原申请"
        }
        val board =
            withContext(Dispatchers.IO) {
                LiveAfterSales(
                    api.data("/api/commerce/item-after-sales/items/" + LiveCommand.part(itemID))
                )
            }
        board.validate(itemID)
        require(identity?.employeeId == actor.employeeId)
        afterSales = board
        afterSalesActor = actor.employeeId
        afterSalesUpdated = java.time.Instant.now()
        afterSalesState = ""
    }

    fun loadAfterSales(itemID: String) {
        if (!live || !canReadAfterSales || busy || heartbeatBusy) return
        busy = true
        afterSalesUpdated = null
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        printActor = null
        printUpdated = null
        afterSales = null
        afterSalesState = "正在读取原商品与资金事实"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchAfterSales(itemID)
            } catch (e: Exception) {
                afterSalesState = "读取未完成，不能按旧状态处理"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun loadAfterSalesPending(more: Boolean = false) {
        if (!live || !canReadAfterSales || busy || heartbeatBusy) return
        busy = true
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                val cursor = if (more) afterSalesCursor else null
                val page = withContext(Dispatchers.IO) { api.data(afterSalesPendingPath(cursor)) }
                val rows =
                    (if (cursor == null) emptyList() else afterSalesPendingRows) +
                        financeRows(page, "items")
                val next = page.optJSONObject("nextCursor")
                require(
                    rows.map { it.getString("caseId") }.distinct().size == rows.size &&
                        (next == null ||
                            cursor == null ||
                            next.getString("id") != cursor.getString("id") ||
                            next.getString("createdAt") != cursor.getString("createdAt"))
                ) {
                    "售后分页发生变化，请刷新"
                }
                afterSalesPendingRows = rows
                afterSalesCursor = next
                afterSalesState = ""
            } catch (e: Exception) {
                afterSalesState = "售后待办未能读取，请刷新"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareRemediation(
        action: String,
        target: String = "",
        quantity: Int = 0,
        reason: String,
        confirmed: Boolean,
    ): LiveCommand {
        require(canUseAfterSales) { "请刷新原商品、会话与权限" }
        return afterSales!!.remediationCommand(
            identity!!,
            action,
            target,
            quantity,
            reason,
            confirmed,
        )
    }

    fun prepareAfterSales(
        action: String,
        caseID: String = "",
        quantity: Int = 0,
        reason: String,
        shares: Map<String, Int> = emptyMap(),
        unitIDs: Set<String> = emptySet(),
        refundID: String = "",
        confirmed: Boolean = false,
        receiptReference: String = "",
    ): LiveCommand {
        require(canUseAfterSales) { "请刷新原商品、权限与资金状态" }
        return afterSales!!.command(
            identity!!,
            action,
            caseID,
            quantity,
            reason,
            shares,
            unitIDs,
            refundID,
            confirmed,
            receiptReference,
        )
    }

    fun loadOnline(session: String) {
        if (!live || identity?.allows("payment.initiate.staff") != true || busy || heartbeatBusy)
            return
        busy = true
        cashHandover = null
        cashHandoverUpdated = null
        cashHandoverActor = null
        voucherOperations = emptyList()
        voucherPlatforms = emptyList()
        voucherPreview = null
        voucherCode = ""
        voucherActor = null
        voucherUpdated = null
        voucherHistory = emptyList()
        printJobs = emptyList()
        printSources = emptyList()
        ownPrintJobs = emptyList()
        printActor = null
        printUpdated = null
        afterSales = null
        afterSalesUpdated = null
        afterSalesActor = null
        afterSalesPendingRows = emptyList()
        onlineAccess = null
        paymentUpdated = null
        onlineState = "正在核对线上收款权限与原单"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                val access =
                    withContext(Dispatchers.IO) { api.data("/api/commerce/assisted-order-access") }
                if (access.getString("employeeId") != identity?.employeeId) invalidResponse()
                fetchPaymentOrders(session)
                onlineAccess = access
                onlineState = ""
            } catch (e: Exception) {
                onlineState = "线上收款未就绪，请刷新核对"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareOnline(
        session: String,
        ids: Set<String>,
        amount: Int,
        method: String,
        code: String,
    ): LiveCommand {
        require(
            canAct("payment.initiate.staff") &&
                paymentSession == session &&
                paymentOrders.filter { it.id in ids }.map { it.id }.toSet() == ids
        ) {
            "请刷新原桌应收与权限"
        }
        return onlinePayment(
            identity!!,
            onlineAccess!!,
            paymentOrders.filter { it.id in ids },
            session,
            amount,
            method,
            code,
        )
    }

    fun prepareOnlineRelease(session: String, paymentID: String, reason: String): LiveCommand {
        require(canAct("payment.initiate.staff") && paymentSession == session) { "请刷新原桌应收与权限" }
        return onlineRelease(identity!!, paymentOrders, paymentID, session, reason)
    }

    suspend fun pollOnline(paymentID: String, session: String) {
        val receipt = onlineReceipts.optJSONObject(session)
        if (
            !live ||
                identity == null ||
                busy ||
                heartbeatBusy ||
                onlinePolling ||
                paymentSession != session ||
                !(paymentOrders.any { it.pendingId == paymentID } ||
                    (receipt?.getJSONObject("response")?.getJSONObject("data")?.getString("id") ==
                        paymentID && receipt.getString("employeeID") == identity?.employeeId))
        )
            return
        onlinePolling = true
        busy = true
        val actor = identity?.employeeId
        try {
            val result =
                withContext(Dispatchers.IO) {
                    api.data("/api/payments/${LiveCommand.part(paymentID)}/status")
                }
            val status = result.getString("status")
            if (
                result.getString("id") != paymentID ||
                    status !in listOf("pending", "succeeded", "failed", "closed") ||
                    actor != identity?.employeeId ||
                    paymentSession != session
            )
                invalidResponse()
            onlineStatuses = onlineStatuses + (paymentID to status)
            onlineState = if (status == "succeeded") "服务器已确认原付款；是否结清以当前应收为准" else ""
            if (status != "pending") fetchPaymentOrders(session)
        } catch (e: Exception) {
            onlineState = "状态未能确认；保留原付款，不把网络错误当作失败"
            handleLiveError(e)
        } finally {
            onlinePolling = false
            busy = false
        }
    }

    val canReadFinance
        get() =
            identity?.let { it.allows("reconciliation.view") || it.allows("business_day.close") } ==
                true

    private suspend fun fetchFinance(
        query: FinanceQuery,
        reviewPage: Int = 0,
        moreEntries: Boolean = false,
    ) {
        val actor = identity ?: error("请先登录")
        require(canReadFinance && reviewPage in 0..100000) { "当前岗位没有日结与对账权限" }
        query.path()
        if (actor.allows("reconciliation.view")) {
            val summary =
                withContext(Dispatchers.IO) {
                    api.data(
                        "/api/operations/history" +
                            if (query.date.isEmpty()) "" else "?businessDate=${query.date}"
                    )
                }
            val resolved = FinanceQuery(summary.getString("businessDate"), query.type)
            val cursor = if (moreEntries && resolved == financeQuery) financeNext else null
            val page =
                withContext(Dispatchers.IO) { JSONObject(api.raw(resolved.path(cursor)).text) }
            val rows = financeRows(page, "data")
            val next = page.getJSONObject("meta").textOrNull("nextCursor")
            validateFinancePage(page, resolved, cursor)
            val review =
                withContext(Dispatchers.IO) {
                    JSONObject(api.raw("/api/payments/finance-review?page=$reviewPage").text)
                }
            val reviews = financeRows(review, "data")
            if (
                actor.employeeId != identity?.employeeId ||
                    reviews.map { it.getString("id") }.distinct().size != reviews.size
            )
                invalidResponse()
            val merged = if (cursor == null) rows else financeEntries + rows
            require(merged.map { it.getString("id") }.distinct().size == merged.size) {
                "对账分页发生变化，请重新刷新"
            }
            financeSummary = summary
            financeEntries = merged
            financeNext = next
            financeReviews = reviews
            financeMoreReviews = review.getBoolean("hasMore")
            financeReviewPage = reviewPage
            financeQuery = resolved
        } else {
            financeSummary = null
            financeEntries = emptyList()
            financeReviews = emptyList()
            financeNext = null
            financeMoreReviews = false
        }
        financeActorID = actor.employeeId
        financeUpdated = java.time.Instant.now()
        financeState = ""
    }

    fun loadFinance(
        query: FinanceQuery = financeQuery,
        reviewPage: Int = 0,
        moreEntries: Boolean = false,
    ) {
        if (!live || !canReadFinance || busy || heartbeatBusy) return
        busy = true
        financeUpdated = null
        financeState = "正在读取服务器账本"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchFinance(query, reviewPage, moreEntries)
            } catch (e: Exception) {
                financeSummary = null
                financeEntries = emptyList()
                financeReviews = emptyList()
                financeActorID = null
                financeState = "读取失败，不能将缺失数据当作零收款"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareFinance(
        rowID: String? = null,
        note: String = "",
        resolve: Boolean = false,
        closeDay: Boolean = false,
    ): LiveCommand {
        require(canAct(if (closeDay) "business_day.close" else "reconciliation.manage")) {
            "权限、会话或账本已过期，请刷新"
        }
        return financeCommand(
            identity!!,
            financeReviews.find { it.getString("id") == rowID },
            note,
            resolve,
            closeDay,
        )
    }

    private fun saveFinanceReceipt(command: LiveCommand, step: LiveStep, text: String) {
        val receipt =
            JSONObject()
                .put("commandID", command.id)
                .put("employeeID", command.employeeID)
                .put("kind", step.financeProof!!.getString("finance"))
                .put("response", JSONObject(text))
        val stream = financeReceiptFile.startWrite()
        try {
            stream.write(receipt.toString().toByteArray())
            financeReceiptFile.finishWrite(stream)
            financeReceipt = receipt
        } catch (e: Exception) {
            financeReceiptFile.failWrite(stream)
            throw e
        }
    }

    var assignmentScheduleMode by mutableStateOf("future")
        private set
    var assignmentSchedulePage by mutableStateOf(0)
        private set

    fun loadAssignmentSchedule(mode: String, page: Int = 0) {
        if (busy || heartbeatBusy || mode !in assignmentScheduleModes || page !in 0..10000) return
        assignmentScheduleMode = mode
        assignmentSchedulePage = page
        loadAssignments()
    }

    fun prepareSchedule(id: String, reason: String, schedule: JSONObject?): LiveCommand {
        require(canAct(LiveAssignments.permission)) { "权限或数据已过期，请刷新" }
        val board = assignmentsBoard ?: error("请刷新")
        if (schedule != null) {
            require(board.employees.any { it.getString("id") == schedule.getString("employeeId") } && board.roles.any { it.getString("id") == schedule.getString("roleId") }) { "请选择当前在职员工及岗位" }
        }
        return (board.schedule ?: error("后台尚未支持排班管理")).command(identity!!, id, reason, schedule)
    }

    private suspend fun fetchAssignments() {
        val actor = identity ?: error("请先登录")
        val result =
            withContext(Dispatchers.IO) {
                val options =
                    if (actor.allows(LiveAssignments.permission))
                        api.data("/api/table-management/assignment-options")
                    else
                        JSONObject()
                            .put("employees", org.json.JSONArray())
                            .put("roles", org.json.JSONArray())
                val tables =
                    JSONObject(api.raw("/api/table-management/tables").text).getJSONArray("data")
                val rows =
                    JSONObject(api.raw("/api/table-management/assignments").text)
                        .getJSONArray("data")
                val schedule = if(options.optBoolean("supportsNativeAssignmentSchedule")) AssignmentSchedule(api.data("/api/table-management/native-assignment-schedule?mode=$assignmentScheduleMode&page=$assignmentSchedulePage")) else null
                if(schedule != null) require(schedule.employee == actor.employeeId)
                LiveAssignments(options, tables, rows, schedule)
            }
        if (actor.employeeId != identity?.employeeId) invalidResponse()
        assignmentsBoard = result
        assignmentsActorID = actor.employeeId
        assignmentsUpdated = java.time.Instant.now()
        assignmentsState = ""
        lastUpdated = null
    }

    fun loadAssignments() {
        if (!live || identity == null || busy || heartbeatBusy) return
        busy = true
        if (assignmentsActorID != identity?.employeeId) {
            financeSummary = null
            financeEntries = emptyList()
            financeReviews = emptyList()
            financeUpdated = null
            financeActorID = null
            assignmentsBoard = null
        }
        assignmentsUpdated = null
        assignmentsActorID = null
        assignmentReceipt = ""
        assignmentsState = "正在读取责任桌"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchAssignments()
            } catch (e: Exception) {
                financeSummary = null
                financeEntries = emptyList()
                financeReviews = emptyList()
                financeUpdated = null
                financeActorID = null
                assignmentsBoard = null
                assignmentsState = "未能读取责任桌，请刷新重试"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareAssignment(
        tableIDs: Set<String>,
        employeeID: String,
        roleID: String,
        kind: String,
        start: java.time.Instant,
        end: java.time.Instant?,
        reason: String,
    ): LiveCommand {
        require(canAct(LiveAssignments.permission)) { "权限、会话或数据已过期，请刷新后核对" }
        return assignmentsBoard!!.assign(
            identity!!,
            tableIDs,
            employeeID,
            roleID,
            kind,
            start,
            end,
            reason,
        )
    }

    fun prepareAssignmentEnd(id: String, reason: String): LiveCommand {
        require(canAct(LiveAssignments.permission)) { "权限、会话或数据已过期，请刷新后核对" }
        return assignmentsBoard!!.end(identity!!, id, reason)
    }

    private suspend fun fetchCashier(query: String) {
        if (!canReadCashier) throw StaffAPIError(403, "ACCESS_REVOKED", "当前岗位无收银工作台权限")
        val result = withContext(Dispatchers.IO) { LiveCashier(api.data(LiveCashier.path(query))) }
        if (result.orders.map { it.id }.distinct().size != result.orders.size) invalidResponse()
        cashier = result
        cashierUpdated = java.time.Instant.now()
        cashierQuery = query
        cashierState = ""
    }

    fun loadCashier(query: String = "") {
        if (!live || !canReadCashier || busy || heartbeatBusy) return
        if (query.length > 64) {
            cashierState = "查询内容最多64字"
            return
        }
        busy = true
        financeSummary = null
        financeEntries = emptyList()
        financeReviews = emptyList()
        financeUpdated = null
        financeActorID = null
        assignmentsBoard = null
        assignmentsUpdated = null
        assignmentsActorID = null
        assignmentReceipt = ""
        cashier = null
        cashierUpdated = null
        cashierState = "正在读取收银待办"
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                fetchCashier(query.trim())
            } catch (e: Exception) {
                cashierState = "未能读取收银数据，请重新查询"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun prepareUnpaid(
        orderID: String,
        settle: Boolean,
        reasonCode: String,
        note: String,
    ): LiveCommand {
        require(canAct(if (settle) "order.settle_exception" else "order.cancel_unpaid")) {
            "请刷新原订单与权限"
        }
        return cashier!!.unpaidCommand(identity!!, orderID, settle, reasonCode, note)
    }

    val canUseActivity
        get() =
            live &&
                !busy &&
                !heartbeatBusy &&
                !liveStorageDamaged &&
                livePending == null &&
                liveOrderPending == null &&
                identity?.allows("community.activity.cashier") == true &&
                cashier?.actions?.optBoolean("canUseActivityCashier") == true &&
                cashierUpdated?.let {
                    java.time.Duration.between(it, java.time.Instant.now()).seconds in 0..59
                } == true &&
                identity
                    ?.onlineLeaseUntil
                    ?.let(::assignmentDate)
                    ?.isAfter(java.time.Instant.now()) == true

    fun prepareActivity(
        registrationID: String,
        action: String,
        provider: String = "cash",
        reference: String = "",
        terminal: String = "",
        externalMethod: String = "bank_transfer",
        reason: String = "",
        paymentPublicID: String = "",
        confirmed: Boolean = false,
    ): LiveCommand {
        require(canUseActivity) { "请刷新活动工作台、会话与权限" }
        return cashier!!.activityCommand(
            identity!!,
            registrationID,
            action,
            provider,
            reference,
            terminal,
            externalMethod,
            reason,
            paymentPublicID,
            confirmed,
        )
    }

    fun prepareCashier(
        orderID: String,
        paymentID: String,
        action: String,
        refundID: String = "",
        amounts: Map<String, Long> = emptyMap(),
        reason: String = "",
        purpose: String = "",
        reference: String = "",
        succeeded: Boolean = true,
    ): LiveCommand {
        val command =
            (cashier ?: error("请刷新收银工作台")).command(
                identity ?: error("请先登录"),
                orderID,
                paymentID,
                action,
                refundID,
                amounts,
                reason,
                purpose,
                reference,
                succeeded,
            )
        check(canAct(command.permission)) { "权限、会话或数据已过期，请刷新后核对" }
        return command
    }

    fun exportHistory(all: Boolean, completed: (ByteArray?) -> Unit) {
        val snapshot = history
        if (!live || !canReadHistory || busy || heartbeatBusy || snapshot == null) {
            completed(null)
            return
        }
        val query = historyQuery
        val page = if (all) 0 else snapshot.page
        busy = true
        viewModelScope.launch {
            try {
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                if (!canReadHistory) throw StaffAPIError(403, "ACCESS_REVOKED", "订单查询权限已撤销")
                val bytes =
                    withContext(Dispatchers.IO) {
                        val result = LiveHistory(api.data(query.exportPath(page, all)))
                        result.validate(page)
                        result.exportCSV()
                    }
                completed(bytes)
            } catch (e: Exception) {
                handleLiveError(e)
                completed(null)
            } finally {
                busy = false
            }
        }
    }

    val canReadHistory
        get() =
            identity?.let { actor ->
                listOf("reconciliation.view", "order.history.view", "order.history.all")
                    .any(actor::allows)
            } == true

    fun loadHistory(query: HistoryQuery = HistoryQuery(), page: Int = 0) {
        if (!live || !canReadHistory || busy || heartbeatBusy) return
        busy = true
        history = null
        historyState = "正在读取订单"
        viewModelScope.launch {
            try {
                val path = query.path(page)
                identity = withContext(Dispatchers.IO) { api.heartbeat() }
                if (!canReadHistory) throw StaffAPIError(403, "ACCESS_REVOKED", "订单查询权限已撤销")
                val result = withContext(Dispatchers.IO) { LiveHistory(api.data(path)) }
                result.validate(page)
                history = result
                historyQuery = query.copy(date = result.date, endDate = result.endDate)
                historyState = ""
            } catch (e: Exception) {
                historyState = "订单未读取成功，请重新查询"
                handleLiveError(e)
            } finally {
                busy = false
            }
        }
    }

    fun preparePickup(
        action: String,
        target: String = "",
        units: Set<String> = emptySet(),
        label: String = "",
        enabled: Boolean = true,
    ): LiveCommand {
        check(canAct(if (action == "device") "staff.access.configure" else "kds.deliver")) {
            "请刷新取餐台后再操作"
        }
        return pickupBoard!!.make(identity!!, action, target, units, label, enabled)
    }
}
