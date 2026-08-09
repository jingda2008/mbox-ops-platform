import { randomUUID } from 'node:crypto'
import type { BenefitChannel, CustomerNotification } from '../src/shared/benefit-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository } from './repository.js'
import { PostgresOptimisticConcurrencyError } from './postgres-repository.js'

export type NotificationChannel = Exclude<BenefitChannel, 'none'>

export interface NotificationDispatchRequest {
  notificationId: string
  idempotencyKey: string
  channel: NotificationChannel
  memberId: string
  benefitId: string
  campaignId: string | null
  templateCode: string
  content: string
}

export type NotificationDispatchResult =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'retryable_failure'; reason: string; errorCode?: string }
  | { outcome: 'permanent_failure'; reason: string; errorCode?: string }

export interface NotificationProviderAdapter {
  readonly channel: NotificationChannel
  dispatch(request: NotificationDispatchRequest): Promise<NotificationDispatchResult>
}

export interface NotificationDispatchOptions {
  maxAttempts?: number
  baseRetrySeconds?: number
  maxRetrySeconds?: number
  limit?: number
  leaseSeconds?: number
  minimumGlobalIdleMs?: number
}

export interface NotificationDispatchSummary {
  due: number
  attempted: number
  sent: number
  retryScheduled: number
  failed: number
  unconfigured: number
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_RETRY_SECONDS = 60
const DEFAULT_MAX_RETRY_SECONDS = 60 * 60
const DEFAULT_LIMIT = 100
const DEFAULT_LEASE_SECONDS = 60

function attemptCount(notification: CustomerNotification) {
  return notification.attemptCount ?? 0
}

function nextAttemptAt(notification: CustomerNotification) {
  return notification.nextAttemptAt ?? notification.queuedAt
}

export function selectDueNotifications(state: RuntimeState, now = new Date(), limit = DEFAULT_LIMIT) {
  const dueAt = now.toISOString()
  return state.customerNotifications
    .filter((notification) => (
      notification.status === 'queued' &&
      nextAttemptAt(notification) <= dueAt &&
      (!notification.leaseExpiresAt || notification.leaseExpiresAt <= dueAt)
    ))
    .sort((left, right) => nextAttemptAt(left).localeCompare(nextAttemptAt(right)))
    .slice(0, Math.max(0, limit))
}

export function notificationsWouldDispatch(
  state: RuntimeState,
  adapters: readonly NotificationProviderAdapter[],
  now = new Date(),
  options: NotificationDispatchOptions = {},
) {
  const settings = validateOptions(options)
  const configuredChannels = new Set(adapters.map((adapter) => adapter.channel))
  return selectDueNotifications(state, now, settings.limit)
    .some((notification) => configuredChannels.has(notification.channel))
}

function appendAudit(
  state: RuntimeState,
  notification: CustomerNotification,
  action: string,
  now: Date,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'system-notification-dispatcher',
    action,
    objectType: 'customerNotification',
    objectId: notification.id,
    occurredAt: now.toISOString(),
    details: {
      channel: notification.channel,
      attemptCount: attemptCount(notification),
      ...details,
    },
  })
  state.revision += 1
}

function retryDelaySeconds(attempt: number, baseSeconds: number, maxSeconds: number) {
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1))
}

function validateOptions(options: NotificationDispatchOptions) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseRetrySeconds = options.baseRetrySeconds ?? DEFAULT_BASE_RETRY_SECONDS
  const maxRetrySeconds = options.maxRetrySeconds ?? DEFAULT_MAX_RETRY_SECONDS
  const limit = options.limit ?? DEFAULT_LIMIT
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts必须是正整数')
  if (!Number.isSafeInteger(baseRetrySeconds) || baseRetrySeconds < 1) throw new Error('baseRetrySeconds必须是正整数')
  if (!Number.isSafeInteger(maxRetrySeconds) || maxRetrySeconds < baseRetrySeconds) {
    throw new Error('maxRetrySeconds不能小于baseRetrySeconds')
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit必须是正整数')
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 600) {
    throw new Error('leaseSeconds必须是10至600之间的整数')
  }
  return { maxAttempts, baseRetrySeconds, maxRetrySeconds, limit, leaseSeconds }
}

export interface NotificationDeliveryClaim {
  notificationId: string
  workerId: string
  attemptNumber: number
  request: NotificationDispatchRequest
}

export function claimDueNotifications(
  state: RuntimeState,
  workerId: string,
  configuredChannels: readonly NotificationChannel[],
  now = new Date(),
  options: NotificationDispatchOptions = {},
): NotificationDeliveryClaim[] {
  if (!workerId.trim()) throw new Error('通知workerId不能为空')
  const settings = validateOptions(options)
  const channels = new Set(configuredChannels)
  const due = selectDueNotifications(state, now, settings.limit)
    .filter((notification) => channels.has(notification.channel))
  if (due.length === 0) return []

  const leaseExpiresAt = new Date(now.getTime() + settings.leaseSeconds * 1000).toISOString()
  const claims = due.map((notification) => {
    notification.providerMessageId ??= null
    notification.lastErrorCode ??= null
    notification.adapter = notification.channel
    notification.attemptCount = attemptCount(notification) + 1
    notification.lastAttemptAt = now.toISOString()
    notification.nextAttemptAt = null
    notification.leaseOwner = workerId
    notification.leaseExpiresAt = leaseExpiresAt
    return {
      notificationId: notification.id,
      workerId,
      attemptNumber: notification.attemptCount,
      request: {
        notificationId: notification.id,
        idempotencyKey: notification.id,
        channel: notification.channel,
        memberId: notification.memberId,
        benefitId: notification.benefitId,
        campaignId: notification.campaignId,
        templateCode: notification.templateCode,
        content: notification.content,
      },
    }
  })
  state.revision += 1
  return claims
}

async function callProvider(
  claim: NotificationDeliveryClaim,
  adapters: readonly NotificationProviderAdapter[],
): Promise<NotificationDispatchResult> {
  const adapter = adapters.find((candidate) => candidate.channel === claim.request.channel)
  if (!adapter) return { outcome: 'retryable_failure', reason: '通知渠道尚未配置', errorCode: 'ADAPTER_UNCONFIGURED' }
  try {
    const result = await adapter.dispatch(claim.request)
    if (result.outcome === 'sent' && !result.providerMessageId.trim()) {
      return {
        outcome: 'retryable_failure',
        reason: '通知提供方未返回消息ID，不能确认送达',
        errorCode: 'INVALID_PROVIDER_RESPONSE',
      }
    }
    return result
  } catch (error) {
    return {
      outcome: 'retryable_failure',
      reason: error instanceof Error ? error.message : '通知适配器发生未知异常',
      errorCode: 'ADAPTER_EXCEPTION',
    }
  }
}

export function applyNotificationDispatchResult(
  state: RuntimeState,
  claim: NotificationDeliveryClaim,
  result: NotificationDispatchResult,
  now = new Date(),
  options: NotificationDispatchOptions = {},
) {
  const settings = validateOptions(options)
  const notification = state.customerNotifications.find((item) => item.id === claim.notificationId)
  if (!notification) throw new Error('通知记录不存在')
  if (notification.leaseOwner !== claim.workerId || notification.attemptCount !== claim.attemptNumber) {
    throw new Error('通知租约已经失效或被其他worker接管')
  }
  notification.leaseOwner = null
  notification.leaseExpiresAt = null

  if (result.outcome === 'sent') {
    notification.status = 'sent'
    notification.sentAt = now.toISOString()
    notification.failureReason = null
    notification.providerMessageId = result.providerMessageId
    notification.lastErrorCode = null
    appendAudit(state, notification, 'customer.notification_sent.v1', now, {
      providerMessageId: result.providerMessageId,
      attemptNumber: claim.attemptNumber,
    })
    return 'sent' as const
  }

  notification.failureReason = result.reason
  notification.lastErrorCode = result.errorCode ?? null
  const exhausted = attemptCount(notification) >= settings.maxAttempts
  if (result.outcome === 'permanent_failure' || exhausted) {
    notification.status = 'failed'
    notification.nextAttemptAt = null
    appendAudit(state, notification, 'customer.notification_failed.v1', now, {
      errorCode: notification.lastErrorCode,
      reason: result.reason,
      retryable: result.outcome === 'retryable_failure',
      exhausted,
      attemptNumber: claim.attemptNumber,
    })
    return 'failed' as const
  }

  const delaySeconds = retryDelaySeconds(
    attemptCount(notification),
    settings.baseRetrySeconds,
    settings.maxRetrySeconds,
  )
  notification.nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString()
  appendAudit(state, notification, 'customer.notification_retry_scheduled.v1', now, {
    errorCode: notification.lastErrorCode,
    reason: result.reason,
    nextAttemptAt: notification.nextAttemptAt,
    delaySeconds,
    attemptNumber: claim.attemptNumber,
  })
  return 'retry_scheduled' as const
}

export async function dispatchDueNotifications(
  repository: RuntimeRepository,
  adapters: readonly NotificationProviderAdapter[],
  workerId: string,
  now = new Date(),
  options: NotificationDispatchOptions = {},
  snapshot?: RuntimeState,
) {
  if (adapters.length === 0) return { claimed: 0, sent: 0, retryScheduled: 0, failed: 0 }
  const hasDueNotification = notificationsWouldDispatch(snapshot ?? await repository.read(), adapters, now, options)
  if (!hasDueNotification) return { claimed: 0, sent: 0, retryScheduled: 0, failed: 0 }
  const claims = await repository.mutate((state) => claimDueNotifications(
    state,
    workerId,
    adapters.map((adapter) => adapter.channel),
    now,
    options,
  ), { metricLabel: 'scheduler', minimumGlobalIdleMs: options.minimumGlobalIdleMs })
  const summary = { claimed: claims.length, sent: 0, retryScheduled: 0, failed: 0 }
  for (const claim of claims) {
    const result = await callProvider(claim, adapters)
    let outcome: ReturnType<typeof applyNotificationDispatchResult> | null = null
    for (let attempt = 1; attempt <= 3 && outcome === null; attempt += 1) {
      try {
        outcome = await repository.mutate(
          (state) => applyNotificationDispatchResult(state, claim, result, new Date(), options),
          { metricLabel: 'scheduler' },
        )
      } catch (error) {
        if (!(error instanceof PostgresOptimisticConcurrencyError) || attempt === 3) throw error
      }
    }
    if (outcome === null) throw new Error('通知投递结果未能持久化')
    if (outcome === 'sent') summary.sent += 1
    else if (outcome === 'failed') summary.failed += 1
    else summary.retryScheduled += 1
  }
  return summary
}

export async function processDueNotifications(
  state: RuntimeState,
  adapters: readonly NotificationProviderAdapter[],
  now = new Date(),
  options: NotificationDispatchOptions = {},
): Promise<NotificationDispatchSummary> {
  const settings = validateOptions(options)
  const due = selectDueNotifications(state, now, settings.limit)
  const summary: NotificationDispatchSummary = {
    due: due.length,
    attempted: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    unconfigured: 0,
  }

  summary.unconfigured = due.filter((notification) => !adapters.some((adapter) => adapter.channel === notification.channel)).length
  const claims = claimDueNotifications(state, 'inline-notification-worker', adapters.map((adapter) => adapter.channel), now, options)
  summary.attempted = claims.length
  for (const claim of claims) {
    const result = await callProvider(claim, adapters)
    const outcome = applyNotificationDispatchResult(state, claim, result, now, options)
    if (outcome === 'sent') summary.sent += 1
    else if (outcome === 'failed') summary.failed += 1
    else summary.retryScheduled += 1
  }

  return summary
}
