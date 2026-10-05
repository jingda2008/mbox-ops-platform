package com.mbox.staff

import java.time.Duration
import java.time.Instant

/** Internal navigation reference, never a source of task authority or business commands. */
data class NotificationTaskTarget(
    val notificationId: String,
    val employeeId: String,
    val staffSessionId: String,
    val taskId: String,
    val tableSessionId: String,
    val issuedAt: Instant,
    val expiresAt: Instant,
) {
    fun isWellFormed(maxTtl: Duration = Duration.ofHours(24)): Boolean =
        listOf(notificationId, employeeId, staffSessionId, taskId, tableSessionId).all(::validNotificationReference) &&
            !maxTtl.isNegative && !maxTtl.isZero && expiresAt > issuedAt &&
            Duration.between(issuedAt, expiresAt) <= maxTtl

    internal fun sameNotification(other: NotificationTaskTarget) =
        notificationId == other.notificationId && employeeId == other.employeeId && staffSessionId == other.staffSessionId

    internal fun sameReference(other: NotificationTaskTarget) =
        sameNotification(other) && taskId == other.taskId && tableSessionId == other.tableSessionId
}

private fun validNotificationReference(value: String) =
    value.isNotBlank() && value == value.trim() && value.length <= 256 && value.none(Char::isISOControl)

/** Construct from the current authenticated workspace, not from an Intent. */
data class NotificationTaskIdentity(
    val employeeId: String,
    val staffSessionId: String,
    val accessRevision: String,
    val canReadTasks: Boolean,
)

/** Construct only from a newly read, authorized service task response. */
data class NotificationTaskFact(
    val taskId: String,
    val tableSessionId: String,
    val status: String,
    val authorized: Boolean,
)

data class AuthorizedNotificationTaskSnapshot(
    val identity: NotificationTaskIdentity,
    val readStartedAt: Instant,
    val readCompletedAt: Instant,
    val tasks: List<NotificationTaskFact>,
    val complete: Boolean,
)

data class PendingNotificationTask(val target: NotificationTaskTarget, val requestedAt: Instant)
data class ConsumedNotificationTask(val target: NotificationTaskTarget, val openedAt: Instant)

data class NotificationTaskRecoveryPolicy(
    val maxTargetTtl: Duration = Duration.ofHours(24),
    val maxSnapshotAge: Duration = Duration.ofSeconds(90),
    val maxConsumed: Int = 256,
) {
    init {
        require(!maxTargetTtl.isNegative && !maxTargetTtl.isZero)
        require(!maxSnapshotAge.isNegative && !maxSnapshotAge.isZero)
        require(maxConsumed in 1..4096)
    }
}

enum class NotificationTaskRejection(val message: String) {
    INVALID_TARGET("通知内容无效，请从服务任务列表查找当前事项"),
    NOT_YET_VALID("通知时间异常，请从服务任务列表核对当前事项"),
    EXPIRED("通知已过期，请从服务任务列表查看当前事项"),
    WRONG_EMPLOYEE("此通知属于原员工，请由原员工核对"),
    WRONG_LOGIN_SESSION("原登录会话已结束，请从当前服务任务列表查看事项"),
    ACCESS_DENIED("当前账号没有查看此服务任务的权限"),
    TASK_UNAVAILABLE("当前授权任务中未找到原事项，可能已转交或不再可见，请在服务任务列表核对"),
    WRONG_TABLE_SESSION("通知所指的原桌次已不匹配，不能改为打开同桌号的新桌次"),
    TASK_NOT_ACTIVE("原任务当前不处于可处理状态，请在服务任务列表核对"),
    REFERENCE_CONFLICT("同一通知对应的原任务发生冲突，请在服务任务列表核对"),
}

enum class NotificationVerificationWait(val message: String) {
    NETWORK_UNKNOWN("当前网络无法核实原任务，已保留通知，联网后可重新核对"),
    SNAPSHOT_NOT_CURRENT("任务读取结果已过期或权限已变化，请重新核对原任务"),
    INCOMPLETE_SNAPSHOT("任务列表尚未读取完整，暂不能判断原事项是否可见"),
    INCONSISTENT_SNAPSHOT("原任务读取结果不一致，请重新核对"),
    DEDUP_CAPACITY("通知打开记录已满，请从服务任务列表手动查看；原通知仍保留待核对"),
}

sealed interface NotificationTaskDecision {
    data object Idle : NotificationTaskDecision
    data object LoginRequired : NotificationTaskDecision
    data class RefreshRequired(val pending: PendingNotificationTask) : NotificationTaskDecision
    data class AwaitingVerification(val reason: NotificationVerificationWait) : NotificationTaskDecision
    data class Focus(val target: NotificationTaskTarget, val task: NotificationTaskFact) : NotificationTaskDecision
    data class Rejected(val reason: NotificationTaskRejection) : NotificationTaskDecision
    data object Duplicate : NotificationTaskDecision
    data object Opened : NotificationTaskDecision
}

data class NotificationTaskTransition(val recovery: NotificationTaskRecovery, val decision: NotificationTaskDecision)

/**
 * Pure navigation state machine. Persist only pending and consumed using the
 * caller's AtomicFile store. Never persist an authorized snapshot or focus claim.
 * resolve(Focus) reserves a single UI focus; acknowledgeOpened must be called only
 * after that focus succeeds. A process restart restores pending and revalidates.
 */
class NotificationTaskRecovery private constructor(
    val pending: PendingNotificationTask?,
    consumed: List<ConsumedNotificationTask>,
    val policy: NotificationTaskRecoveryPolicy,
    private val focusClaim: FocusClaim? = null,
) {
    val consumed: List<ConsumedNotificationTask> = consumed.toList()
    private data class FocusClaim(val identity: NotificationTaskIdentity, val verifiedAt: Instant)

    companion object {
        fun empty(policy: NotificationTaskRecoveryPolicy = NotificationTaskRecoveryPolicy()) =
            NotificationTaskRecovery(null, emptyList(), policy)

        /** Reject corrupt/oversized saved records; never truncate live deduplication history. */
        fun restore(
            pending: PendingNotificationTask?,
            consumed: List<ConsumedNotificationTask>,
            policy: NotificationTaskRecoveryPolicy = NotificationTaskRecoveryPolicy(),
        ): NotificationTaskRecovery {
            require(consumed.size <= policy.maxConsumed) { "通知恢复记录超出允许数量" }
            require(pending == null || pending.target.isWellFormed(policy.maxTargetTtl) &&
                pending.requestedAt >= pending.target.issuedAt && pending.requestedAt < pending.target.expiresAt) { "原通知待核对记录无效" }
            require(consumed.all { it.target.isWellFormed(policy.maxTargetTtl) &&
                it.openedAt >= it.target.issuedAt && it.openedAt < it.target.expiresAt }) { "通知打开记录无效" }
            require(consumed.indices.all { index -> consumed.take(index).none { it.target.sameNotification(consumed[index].target) } }) { "通知打开记录冲突" }
            return NotificationTaskRecovery(pending, consumed, policy)
        }
    }

    fun offer(target: NotificationTaskTarget, identity: NotificationTaskIdentity?, now: Instant): NotificationTaskTransition {
        val state = prune(now)
        // Every explicit new click supersedes the previous navigation intention,
        // including rejected or already opened targets. Otherwise an automatic
        // foreground retry could unexpectedly open the previously clicked task.
        invalidTarget(target, now)?.let { return state.reject(it) }
        identityRejection(target, identity)?.let { return state.reject(it) }
        val previous = state.pending
        val duplicate = state.consumed.firstOrNull { it.target.sameNotification(target) }
        if (duplicate != null && !duplicate.target.sameReference(target))
            return state.reject(NotificationTaskRejection.REFERENCE_CONFLICT)
        if (previous != null && previous.target.sameNotification(target) && !previous.target.sameReference(target))
            return state.reject(NotificationTaskRejection.REFERENCE_CONFLICT)
        if (identity != null && duplicate != null) return state.clear(NotificationTaskDecision.Duplicate)
        if (previous != null && previous.target.sameReference(target) && invalidTarget(previous.target, now) == null) {
            return NotificationTaskTransition(state, if (identity == null) NotificationTaskDecision.LoginRequired else NotificationTaskDecision.Duplicate)
        }
        // A new explicit click supersedes only an older navigation intention;
        // neither intention is a business command or business completion.
        val next = NotificationTaskRecovery(PendingNotificationTask(target, now), state.consumed, policy)
        return NotificationTaskTransition(next, if (identity == null) NotificationTaskDecision.LoginRequired else NotificationTaskDecision.RefreshRequired(next.pending!!))
    }

    fun retry(identity: NotificationTaskIdentity?, now: Instant): NotificationTaskTransition {
        val state = prune(now); val target = state.pending?.target ?: return NotificationTaskTransition(state, NotificationTaskDecision.Idle)
        state.rejection(target, identity, now)?.let { return state.reject(it) }
        if (identity == null) return NotificationTaskTransition(state, NotificationTaskDecision.LoginRequired)
        val duplicate = state.consumed.firstOrNull { it.target.sameNotification(target) }
        if (duplicate != null) return if (duplicate.target.sameReference(target)) state.clear(NotificationTaskDecision.Duplicate) else state.reject(NotificationTaskRejection.REFERENCE_CONFLICT)
        val next = NotificationTaskRecovery(PendingNotificationTask(target, now), state.consumed, policy)
        return NotificationTaskTransition(next, NotificationTaskDecision.RefreshRequired(next.pending!!))
    }

    /** Unknown network result is not task absence, failure or completion. */
    fun defer(identity: NotificationTaskIdentity?, now: Instant): NotificationTaskTransition {
        val state = prune(now); val target = state.pending?.target ?: return NotificationTaskTransition(state, NotificationTaskDecision.Idle)
        state.rejection(target, identity, now)?.let { return state.reject(it) }
        val next = NotificationTaskRecovery(state.pending, state.consumed, policy)
        return NotificationTaskTransition(next, if (identity == null) NotificationTaskDecision.LoginRequired else NotificationTaskDecision.AwaitingVerification(NotificationVerificationWait.NETWORK_UNKNOWN))
    }

    fun resolve(identity: NotificationTaskIdentity?, snapshot: AuthorizedNotificationTaskSnapshot, now: Instant): NotificationTaskTransition {
        val state = prune(now); val pending = state.pending ?: return NotificationTaskTransition(state, NotificationTaskDecision.Idle)
        val target = pending.target
        state.rejection(target, identity, now)?.let { return state.reject(it) }
        if (identity == null) return NotificationTaskTransition(state, NotificationTaskDecision.LoginRequired)
        val duplicate = state.consumed.firstOrNull { it.target.sameNotification(target) }
        if (duplicate != null) return if (duplicate.target.sameReference(target)) state.clear(NotificationTaskDecision.Duplicate) else state.reject(NotificationTaskRejection.REFERENCE_CONFLICT)
        if (state.focusClaim != null) return NotificationTaskTransition(state, NotificationTaskDecision.Duplicate)
        if (snapshot.identity != identity || snapshot.readStartedAt < pending.requestedAt ||
            snapshot.readCompletedAt < snapshot.readStartedAt || now < snapshot.readCompletedAt ||
            Duration.between(snapshot.readStartedAt, now) >= policy.maxSnapshotAge)
            return state.waitFor(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT)
        val matches = snapshot.tasks.filter { it.taskId == target.taskId }
        if (matches.size > 1) return state.waitFor(NotificationVerificationWait.INCONSISTENT_SNAPSHOT)
        val task = matches.singleOrNull() ?: return if (snapshot.complete) state.reject(NotificationTaskRejection.TASK_UNAVAILABLE)
            else state.waitFor(NotificationVerificationWait.INCOMPLETE_SNAPSHOT)
        if (!task.authorized) return state.reject(NotificationTaskRejection.ACCESS_DENIED)
        if (task.tableSessionId != target.tableSessionId) return state.reject(NotificationTaskRejection.WRONG_TABLE_SESSION)
        // Authorized historical unfinished tasks may still be actionable. Do not
        // resolve a task by a reused table number or invent a current-table flag.
        if (task.status !in setOf("pending", "acknowledged", "in_progress")) return state.reject(NotificationTaskRejection.TASK_NOT_ACTIVE)
        if (state.consumed.size >= policy.maxConsumed) return state.waitFor(NotificationVerificationWait.DEDUP_CAPACITY)
        val next = NotificationTaskRecovery(pending, state.consumed, policy, FocusClaim(identity, now))
        return NotificationTaskTransition(next, NotificationTaskDecision.Focus(target, task))
    }

    /** Navigation acknowledgement only: it does not acknowledge/start/finish the service task. */
    fun acknowledgeOpened(identity: NotificationTaskIdentity?, now: Instant): NotificationTaskTransition {
        val state = prune(now); val target = state.pending?.target ?: return NotificationTaskTransition(state, NotificationTaskDecision.Idle)
        state.rejection(target, identity, now)?.let { return state.reject(it) }
        if (identity == null) return NotificationTaskTransition(state, NotificationTaskDecision.LoginRequired)
        val claim = state.focusClaim
        if (claim == null || claim.identity != identity || now < claim.verifiedAt || Duration.between(claim.verifiedAt, now) >= policy.maxSnapshotAge)
            return state.waitFor(NotificationVerificationWait.SNAPSHOT_NOT_CURRENT)
        if (state.consumed.size >= policy.maxConsumed) return state.waitFor(NotificationVerificationWait.DEDUP_CAPACITY)
        val next = NotificationTaskRecovery(null, state.consumed + ConsumedNotificationTask(target, now), policy)
        return NotificationTaskTransition(next, NotificationTaskDecision.Opened)
    }

    private fun prune(now: Instant) = NotificationTaskRecovery(pending, consumed.filter { now < it.target.expiresAt }, policy, focusClaim)
    private fun clear(decision: NotificationTaskDecision) = NotificationTaskTransition(NotificationTaskRecovery(null, consumed, policy), decision)
    private fun reject(reason: NotificationTaskRejection) = clear(NotificationTaskDecision.Rejected(reason))
    private fun waitFor(reason: NotificationVerificationWait) = NotificationTaskTransition(NotificationTaskRecovery(pending, consumed, policy), NotificationTaskDecision.AwaitingVerification(reason))
    private fun rejection(target: NotificationTaskTarget, identity: NotificationTaskIdentity?, now: Instant) = invalidTarget(target, now) ?: identityRejection(target, identity)
    private fun invalidTarget(target: NotificationTaskTarget, now: Instant): NotificationTaskRejection? = when {
        !target.isWellFormed(policy.maxTargetTtl) -> NotificationTaskRejection.INVALID_TARGET
        now < target.issuedAt -> NotificationTaskRejection.NOT_YET_VALID
        now >= target.expiresAt -> NotificationTaskRejection.EXPIRED
        else -> null
    }
    private fun identityRejection(target: NotificationTaskTarget, identity: NotificationTaskIdentity?): NotificationTaskRejection? = when {
        identity == null -> null
        identity.employeeId != target.employeeId -> NotificationTaskRejection.WRONG_EMPLOYEE
        identity.staffSessionId != target.staffSessionId -> NotificationTaskRejection.WRONG_LOGIN_SESSION
        !identity.canReadTasks || identity.accessRevision.isBlank() -> NotificationTaskRejection.ACCESS_DENIED
        else -> null
    }
}
