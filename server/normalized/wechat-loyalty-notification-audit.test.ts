import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wechatLoyaltyNotificationApiPlugin } from './wechat-loyalty-notification-api.js'
import { WechatLoyaltyNotificationRepository } from './wechat-loyalty-notification-repository.js'

const scope = {
  tenantId: '83000000-0000-4000-8000-000000000001',
  storeId: '83000000-0000-4000-8000-000000000002',
}
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

// Regression: prod 2026-10-22 07:34 POST returned 500
// "audit event requires beforeData, afterData, or reason" because the audit
// event carried only metadata, so command-executor rejected it and rolled back.
describe('WeChat loyalty notification authorization audit', () => {
  it.each(['accept', 'reject'] as const)('records %s with an audit event the command executor accepts', async (platformResult) => {
    vi.spyOn(WechatLoyaltyNotificationRepository.prototype, 'recordAuthorization').mockResolvedValue({
      id: '83000000-0000-4000-8000-000000000010',
      notificationType: 'loyalty_points_expiring',
      purpose: 'loyalty_expiry_reminder',
      authorizationContext: 'loyalty_expiry',
      policyVersion: 3,
      decision: platformResult === 'accept' ? 'granted' : 'denied',
      authorizationVersion: 1,
      changedAt: '2026-10-22T07:34:30.000+08:00',
    } as never)
    const auditEvents: Array<Record<string, unknown>> = []
    const execute = vi.fn(async (_command, operation) => {
      const outcome = await operation({ scope, query: vi.fn() })
      auditEvents.push(...outcome.auditEvents)
      return { value: outcome.result, replayed: false }
    })
    const app = Fastify(); apps.push(app)
    await app.register(wechatLoyaltyNotificationApiPlugin, {
      transactions: { run: async (_s, op) => op({ scope, query: vi.fn() } as never) },
      commands: { execute },
      channelConfigured: true,
      resolvePublicContext: () => ({
        scope,
        customerId: '83000000-0000-4000-8000-000000000003',
        actorRef: 'wechat-notification-api-customer',
        businessDate: '2026-10-22',
      }),
    } as never)
    const response = await app.inject({
      method: 'POST',
      url: '/public/mini/wechat-notification-authorizations',
      headers: { 'idempotency-key': 'wechat-notification-audit-0001' },
      payload: {
        notificationType: 'loyalty_points_expiring',
        policyId: '83000000-0000-4000-8000-000000000004',
        policyVersion: 3,
        templateId: 'y0Ap5aXFOjK66XaFodXGAu4qmpGeUhrF9Yd8I224wG4',
        expectedVersion: 0,
        platformResult,
        platformEventReference: 'wx-subscribe-loyalty_points_expiring-test',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(auditEvents).toHaveLength(1)
    const event = auditEvents[0]
    expect(event.afterData !== undefined || event.beforeData !== undefined || (event.reason ?? null) !== null).toBe(true)
    expect(event.afterData).toMatchObject({ decision: platformResult === 'accept' ? 'granted' : 'denied' })
  })
})