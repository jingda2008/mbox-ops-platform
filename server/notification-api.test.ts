import { describe, expect, it } from 'vitest'
import { retryCustomerNotification } from './notification-api.js'
import { createSeedState } from './seed.js'

describe('notification manual retry', () => {
  it('moves a failed notification back to the due queue with audit', () => {
    const state = createSeedState()
    state.customerNotifications.push({
      id: 'notification-failed', memberId: 'member-amy', benefitId: 'benefit-instance', campaignId: null,
      channel: 'service_account', status: 'failed', templateCode: 'BENEFIT_GRANTED', content: 'test',
      queuedAt: '2026-07-14T10:00:00.000Z', sentAt: null, failureReason: 'provider rejected', adapter: 'service_account',
      attemptCount: 5, lastAttemptAt: '2026-07-14T10:05:00.000Z', nextAttemptAt: null,
      providerMessageId: null, lastErrorCode: 'PROVIDER_REJECTED',
    })
    const retried = retryCustomerNotification(state, 'notification-failed', 'emp-chen', new Date('2026-07-14T11:00:00.000Z'))
    expect(retried).toMatchObject({ status: 'queued', nextAttemptAt: '2026-07-14T11:00:00.000Z', failureReason: null })
    expect(state.auditEntries.at(-1)?.action).toBe('customer.notification_manual_retry.v1')
  })

  it('does not requeue sent or skipped notifications', () => {
    const state = createSeedState()
    state.customerNotifications.push({
      id: 'notification-sent', memberId: 'member-amy', benefitId: 'benefit-instance', campaignId: null,
      channel: 'wecom', status: 'sent', templateCode: 'BENEFIT_GRANTED', content: 'test',
      queuedAt: '2026-07-14T10:00:00.000Z', sentAt: '2026-07-14T10:01:00.000Z', failureReason: null, adapter: 'wecom',
      attemptCount: 1, lastAttemptAt: '2026-07-14T10:01:00.000Z', nextAttemptAt: null,
      providerMessageId: 'provider-1', lastErrorCode: null,
    })
    expect(() => retryCustomerNotification(state, 'notification-sent', 'emp-chen')).toThrow('只有发送失败的通知可以人工重试')
  })
})
