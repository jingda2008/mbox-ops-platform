import { describe, expect, it, vi } from 'vitest'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationProviderAdapter,
} from './notification-dispatch.js'
import { dispatchDueNotifications, processDueNotifications } from './notification-dispatch.js'
import { requestBenefitGrant } from './benefit-domain.js'
import { createSeedState } from './seed.js'
import type { RuntimeRepository } from './repository.js'
import type { RuntimeState } from '../src/shared/contracts.js'

const NOW = new Date('2026-07-14T12:00:00.000Z')

function queuedState(channel: 'service_account' | 'wecom' = 'service_account') {
  const state = createSeedState()
  requestBenefitGrant(state, {
    actorId: 'emp-lin',
    memberId: 'member-amy',
    templateId: 'benefit-beer',
    quantity: 1,
    reason: '通知执行器测试',
    channel,
    idempotencyKey: `notification-dispatch-${channel}`,
  }, NOW)
  return state
}

function mockAdapter(
  channel: 'service_account' | 'wecom',
  results: NotificationDispatchResult[],
): NotificationProviderAdapter & { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async (_request: NotificationDispatchRequest) => {
    const result = results.shift()
    if (!result) throw new Error('mock adapter result exhausted')
    return result
  })
  return { channel, dispatch }
}

class MemoryRepository implements RuntimeRepository {
  private queue = Promise.resolve()
  readCount = 0

  constructor(readonly state: RuntimeState) {}

  async init() {}
  async read() { this.readCount += 1; await this.queue; return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    let result!: T
    this.queue = this.queue.then(async () => {
      const working = structuredClone(this.state)
      result = await mutation(working)
      Object.assign(this.state, working)
    })
    await this.queue
    return result
  }
  async reset() { return this.state }
  async healthCheck() { return { ready: true, repository: 'memory', revision: this.state.revision } }
  async close() {}
}

describe('customer notification dispatcher', () => {
  it('reuses the scheduler snapshot when checking for due work', async () => {
    const state = createSeedState()
    const repository = new MemoryRepository(state)
    const adapter = mockAdapter('service_account', [])

    await dispatchDueNotifications(repository, [adapter], 'worker-a', NOW, {}, structuredClone(state))

    expect(repository.readCount).toBe(0)
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })

  it('does not steal an active lease and recovers it only after expiry', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!
    notification.leaseOwner = 'worker-stopped'
    notification.leaseExpiresAt = '2026-07-14T12:01:00.000Z'
    const adapter = mockAdapter('service_account', [
      { outcome: 'sent', providerMessageId: 'wx-recovered-message-001' },
    ])

    const activeLease = await processDueNotifications(state, [adapter], NOW)
    expect(activeLease.attempted).toBe(0)
    expect(adapter.dispatch).not.toHaveBeenCalled()

    const recovered = await processDueNotifications(state, [adapter], new Date('2026-07-14T12:01:00.000Z'))
    expect(recovered.sent).toBe(1)
    expect(adapter.dispatch).toHaveBeenCalledTimes(1)
  })

  it('persists a worker lease before provider I/O so concurrent workers send once', async () => {
    const repository = new MemoryRepository(queuedState())
    const adapter = mockAdapter('service_account', [
      { outcome: 'sent', providerMessageId: 'wx-leased-message-001' },
    ])

    const [first, second] = await Promise.all([
      dispatchDueNotifications(repository, [adapter], 'worker-a', NOW),
      dispatchDueNotifications(repository, [adapter], 'worker-b', NOW),
    ])

    expect(first.claimed + second.claimed).toBe(1)
    expect(adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(repository.state.customerNotifications[0]).toMatchObject({
      status: 'sent',
      leaseOwner: null,
      leaseExpiresAt: null,
      providerMessageId: 'wx-leased-message-001',
    })
  })

  it('keeps due notifications queued when the channel adapter is not configured', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!

    const summary = await processDueNotifications(state, [], NOW)

    expect(summary).toEqual({ due: 1, attempted: 0, sent: 0, retryScheduled: 0, failed: 0, unconfigured: 1 })
    expect(notification.status).toBe('queued')
    expect(notification.adapter).toBe('unconfigured')
    expect(notification.attemptCount ?? 0).toBe(0)
    expect(notification.sentAt).toBeNull()
  })

  it('records a provider-confirmed send and never dispatches the sent notification twice', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!
    const adapter = mockAdapter('service_account', [
      { outcome: 'sent', providerMessageId: 'wx-message-001' },
    ])

    const first = await processDueNotifications(state, [adapter], NOW)
    const repeated = await processDueNotifications(state, [adapter], new Date(NOW.getTime() + 60_000))

    expect(first.sent).toBe(1)
    expect(repeated.due).toBe(0)
    expect(adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(adapter.dispatch.mock.calls[0]?.[0]).toMatchObject({
      notificationId: notification.id,
      idempotencyKey: notification.id,
      channel: 'service_account',
    })
    expect(notification).toMatchObject({
      status: 'sent',
      adapter: 'service_account',
      attemptCount: 1,
      sentAt: NOW.toISOString(),
      providerMessageId: 'wx-message-001',
      failureReason: null,
    })
    expect(state.auditEntries.at(-1)).toMatchObject({
      action: 'customer.notification_sent.v1',
      objectId: notification.id,
    })
  })

  it('uses exponential backoff for retryable failures and preserves one provider idempotency key', async () => {
    const state = queuedState('wecom')
    const notification = state.customerNotifications[0]!
    const adapter = mockAdapter('wecom', [
      { outcome: 'retryable_failure', reason: '企业微信限流', errorCode: 'RATE_LIMIT' },
      { outcome: 'retryable_failure', reason: '企业微信服务繁忙', errorCode: 'BUSY' },
    ])

    await processDueNotifications(state, [adapter], NOW, { baseRetrySeconds: 30, maxRetrySeconds: 300 })
    expect(notification.nextAttemptAt).toBe('2026-07-14T12:00:30.000Z')
    expect(notification.attemptCount).toBe(1)

    const tooEarly = await processDueNotifications(
      state,
      [adapter],
      new Date('2026-07-14T12:00:29.999Z'),
      { baseRetrySeconds: 30, maxRetrySeconds: 300 },
    )
    expect(tooEarly.attempted).toBe(0)

    await processDueNotifications(
      state,
      [adapter],
      new Date('2026-07-14T12:00:30.000Z'),
      { baseRetrySeconds: 30, maxRetrySeconds: 300 },
    )
    expect(notification.nextAttemptAt).toBe('2026-07-14T12:01:30.000Z')
    expect(notification.attemptCount).toBe(2)
    expect(adapter.dispatch.mock.calls.map((call) => call[0].idempotencyKey)).toEqual([
      notification.id,
      notification.id,
    ])
    expect(state.auditEntries.at(-1)?.action).toBe('customer.notification_retry_scheduled.v1')
  })

  it('fails immediately on a permanent provider rejection', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!
    const adapter = mockAdapter('service_account', [
      { outcome: 'permanent_failure', reason: '用户已取消关注', errorCode: 'USER_UNSUBSCRIBED' },
    ])

    const summary = await processDueNotifications(state, [adapter], NOW)

    expect(summary.failed).toBe(1)
    expect(notification).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureReason: '用户已取消关注',
      lastErrorCode: 'USER_UNSUBSCRIBED',
      sentAt: null,
      providerMessageId: null,
    })
    expect(state.auditEntries.at(-1)?.action).toBe('customer.notification_failed.v1')
  })

  it('stops retrying at the configured maximum attempt count', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!
    const adapter = mockAdapter('service_account', [
      { outcome: 'retryable_failure', reason: 'timeout-1' },
      { outcome: 'retryable_failure', reason: 'timeout-2' },
    ])
    const options = { maxAttempts: 2, baseRetrySeconds: 10, maxRetrySeconds: 60 }

    await processDueNotifications(state, [adapter], NOW, options)
    await processDueNotifications(state, [adapter], new Date('2026-07-14T12:00:10.000Z'), options)

    expect(notification.status).toBe('failed')
    expect(notification.attemptCount).toBe(2)
    expect(notification.nextAttemptAt).toBeNull()
    expect(adapter.dispatch).toHaveBeenCalledTimes(2)
    expect(state.auditEntries.at(-1)?.details).toMatchObject({ retryable: true, exhausted: true })
  })

  it('does not claim delivery when an adapter returns success without a provider message id', async () => {
    const state = queuedState()
    const notification = state.customerNotifications[0]!
    const adapter = mockAdapter('service_account', [{ outcome: 'sent', providerMessageId: '  ' }])

    await processDueNotifications(state, [adapter], NOW)

    expect(notification.status).toBe('queued')
    expect(notification.sentAt).toBeNull()
    expect(notification.providerMessageId ?? null).toBeNull()
    expect(notification.lastErrorCode).toBe('INVALID_PROVIDER_RESPONSE')
  })
})
