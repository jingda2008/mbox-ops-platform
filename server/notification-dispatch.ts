import { randomUUID } from 'node:crypto'
import type { BenefitChannel, CustomerNotification } from '../src/shared/benefit-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'

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

function attemptCount(notification: CustomerNotification) {
  return notification.attemptCount ?? 0
}

function nextAttemptAt(notification: CustomerNotification) {
  return notification.nextAttemptAt ?? notification.queuedAt
}

export function selectDueNotifications(state: RuntimeState, now = new Date(), limit = DEFAULT_LIMIT) {
  const dueAt = now.toISOString()
  return state.customerNotifications
    .filter((notification) => notification.status === 'queued' && nextAttemptAt(notification) <= dueAt)
    .sort((left, right) => nextAttemptAt(left).localeCompare(nextAttemptAt(right)))
    .slice(0, Math.max(0, limit))
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
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts必须是正整数')
  if (!Number.isSafeInteger(baseRetrySeconds) || baseRetrySeconds < 1) throw new Error('baseRetrySeconds必须是正整数')
  if (!Number.isSafeInteger(maxRetrySeconds) || maxRetrySeconds < baseRetrySeconds) {
    throw new Error('maxRetrySeconds不能小于baseRetrySeconds')
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit必须是正整数')
  return { maxAttempts, baseRetrySeconds, maxRetrySeconds, limit }
}

export async function processDueNotifications(
  state: RuntimeState,
  adapters: readonly NotificationProviderAdapter[],
  now = new Date(),
  options: NotificationDispatchOptions = {},
): Promise<NotificationDispatchSummary> {
  const settings = validateOptions(options)
  const adapterByChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]))
  const due = selectDueNotifications(state, now, settings.limit)
  const summary: NotificationDispatchSummary = {
    due: due.length,
    attempted: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    unconfigured: 0,
  }

  for (const notification of due) {
    if (notification.status !== 'queued') continue
    const adapter = adapterByChannel.get(notification.channel)
    if (!adapter) {
      summary.unconfigured += 1
      continue
    }

    notification.providerMessageId ??= null
    notification.lastErrorCode ??= null
    notification.adapter = notification.channel
    notification.attemptCount = attemptCount(notification) + 1
    notification.lastAttemptAt = now.toISOString()
    notification.nextAttemptAt = null
    summary.attempted += 1

    let result: NotificationDispatchResult
    try {
      result = await adapter.dispatch({
        notificationId: notification.id,
        idempotencyKey: notification.id,
        channel: notification.channel,
        memberId: notification.memberId,
        benefitId: notification.benefitId,
        campaignId: notification.campaignId,
        templateCode: notification.templateCode,
        content: notification.content,
      })
      if (result.outcome === 'sent' && !result.providerMessageId.trim()) {
        result = {
          outcome: 'retryable_failure',
          reason: '通知提供方未返回消息ID，不能确认送达',
          errorCode: 'INVALID_PROVIDER_RESPONSE',
        }
      }
    } catch (error) {
      result = {
        outcome: 'retryable_failure',
        reason: error instanceof Error ? error.message : '通知适配器发生未知异常',
        errorCode: 'ADAPTER_EXCEPTION',
      }
    }

    if (result.outcome === 'sent') {
      notification.status = 'sent'
      notification.sentAt = now.toISOString()
      notification.failureReason = null
      notification.providerMessageId = result.providerMessageId
      notification.lastErrorCode = null
      summary.sent += 1
      appendAudit(state, notification, 'customer.notification_sent.v1', now, {
        providerMessageId: result.providerMessageId,
      })
      continue
    }

    notification.failureReason = result.reason
    notification.lastErrorCode = result.errorCode ?? null
    const exhausted = attemptCount(notification) >= settings.maxAttempts
    if (result.outcome === 'permanent_failure' || exhausted) {
      notification.status = 'failed'
      summary.failed += 1
      appendAudit(state, notification, 'customer.notification_failed.v1', now, {
        errorCode: notification.lastErrorCode,
        reason: result.reason,
        retryable: result.outcome === 'retryable_failure',
        exhausted,
      })
      continue
    }

    const delaySeconds = retryDelaySeconds(
      attemptCount(notification),
      settings.baseRetrySeconds,
      settings.maxRetrySeconds,
    )
    notification.nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString()
    summary.retryScheduled += 1
    appendAudit(state, notification, 'customer.notification_retry_scheduled.v1', now, {
      errorCode: notification.lastErrorCode,
      reason: result.reason,
      nextAttemptAt: notification.nextAttemptAt,
      delaySeconds,
    })
  }

  return summary
}
