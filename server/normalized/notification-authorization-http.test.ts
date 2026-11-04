import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError } from './command-executor.js'
import { wechatLoyaltyNotificationApiPlugin } from './wechat-loyalty-notification-api.js'
import { wechatMemberServiceNotificationApiPlugin } from './wechat-member-service-notification-api.js'
import { reservationPerformanceNotificationApiPlugin } from './reservation-performance-notification-api.js'
import { boundedNotificationOperation } from './notification-operation-timeout.js'

const scope = { tenantId: '10000000-0000-4000-8000-000000000001', storeId: '10000000-0000-4000-8000-000000000002' }
const context = () => ({ scope, customerId: '10000000-0000-4000-8000-000000000003', actorRef: 'test-owner', businessDate: '2026-11-04' })
const domains = [
  ['loyalty', wechatLoyaltyNotificationApiPlugin, '/public/mini/wechat-notification-authorizations', { notificationType: 'loyalty_points_credited' }],
  ['member', wechatMemberServiceNotificationApiPlugin, '/public/mini/wechat-member-service-notification-authorizations', { notificationType: 'member_benefit_issued' }],
  ['reservation', reservationPerformanceNotificationApiPlugin, '/public/reservation/performance-notification-authorizations', { reservationPublicId: 'synthetic-reservation' }],
] as const

describe('notification authorization HTTP recovery contract', () => {
  for (const [domain, plugin, url, extra] of domains) {
    it.each([
      [new IdempotencyConflictError('test', 'sensitive-key'), 409, 'NOTIFICATION_AUTHORIZATION_CONFLICT'],
      [new IdempotencyInProgressError('test', 'sensitive-key'), 425, 'NOTIFICATION_AUTHORIZATION_IN_PROGRESS'],
      [new IdempotencyRecordError('internal receipt details'), 503, 'NOTIFICATION_AUTHORIZATION_UNAVAILABLE'],
    ] as const)(`${domain} maps %s without exposing private receipt details`, async (error, status, code) => {
      const app = Fastify(), query = vi.fn()
      try {
        await app.register(plugin as typeof wechatLoyaltyNotificationApiPlugin, { transactions: { run: async (_scope, operation) => operation({ scope, query } as never) },
          commands: { execute: async () => { throw error } }, channelConfigured: true, resolvePublicContext: context, resolveCustomerContext: context } as never)
        const result = await app.inject({ method: 'POST', url, headers: { 'idempotency-key': 'original-test-request' }, payload: {
          ...extra, policyId: '10000000-0000-4000-8000-000000000004', policyVersion: 1, templateId: 'formal-template-001', expectedVersion: 0, platformResult: 'accept', platformEventReference: 'original-platform-event',
        } })
        expect(result.statusCode).toBe(status)
        expect(result.json()).toMatchObject({ code })
        expect(result.body).not.toMatch(/sensitive-key|internal receipt details/)
        expect(query).not.toHaveBeenCalled()
      } finally { await app.close() }
    })
  }
  it('bounds an unresolved external call without treating late completion as success', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (value: string) => void
      const bounded = boundedNotificationOperation(new Promise<string>(done => { resolve = done }), 2000)
      const rejected = expect(bounded).rejects.toThrow('Notification operation timeout')
      await vi.advanceTimersByTimeAsync(2000)
      await rejected
      resolve('late-provider-success')
      await Promise.resolve()
      await expect(bounded).rejects.toThrow('Notification operation timeout')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
