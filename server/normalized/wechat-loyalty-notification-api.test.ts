import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wechatLoyaltyNotificationApiPlugin } from './wechat-loyalty-notification-api.js'

const apps: ReturnType<typeof Fastify>[] = []
const scope = {
  tenantId: '83000000-0000-4000-8000-000000000001',
  storeId: '83000000-0000-4000-8000-000000000002',
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

describe('WeChat loyalty notification API', () => {
  it('fails closed without formal channel configuration and exposes no legacy consent as authorization', async () => {
    const execute = vi.fn()
    const query = vi.fn()
    const app = Fastify(); apps.push(app)
    await app.register(wechatLoyaltyNotificationApiPlugin, {
      transactions: {
        run: async (_scope, operation) => operation({ scope, query } as never),
      },
      commands: { execute },
      channelConfigured: false,
      resolvePublicContext: () => ({
        scope,
        customerId: '83000000-0000-4000-8000-000000000003',
        actorRef: 'wechat-notification-api-customer',
        businessDate: '2026-08-16',
      }),
    })

    const options = await app.inject({
      method: 'GET',
      url: '/public/mini/wechat-notification-authorizations',
    })
    expect(options.statusCode).toBe(200)
    expect(options.json()).toEqual({ data: { available: false, authorizations: [] } })
    expect(query).not.toHaveBeenCalled()

    const record = await app.inject({
      method: 'POST',
      url: '/public/mini/wechat-notification-authorizations',
      headers: { 'idempotency-key': 'wechat-notification-api-test-0001' },
      payload: {
        notificationType: 'loyalty_points_credited',
        policyId: '83000000-0000-4000-8000-000000000004',
        policyVersion: 1,
        templateId: 'wechat-template-credit-001',
        expectedVersion: 0,
        platformResult: 'accept',
        platformEventReference: 'wechat-platform-event-test-0001',
      },
    })
    expect(record.statusCode).toBe(503)
    expect(record.json()).toMatchObject({ code: 'WECHAT_NOTIFICATION_NOT_CONFIGURED' })
    expect(execute).not.toHaveBeenCalled()
  })
})
