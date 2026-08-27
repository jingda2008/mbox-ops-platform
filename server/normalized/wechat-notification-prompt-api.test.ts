import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wechatNotificationPromptApiPlugin } from './wechat-notification-prompt-api.js'

const apps: ReturnType<typeof Fastify>[] = []
const scope = { tenantId: '83000000-0000-4000-8000-000000000001', storeId: '83000000-0000-4000-8000-000000000002' }

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks() })

describe('WeChat notification prompt API', () => {
  it('fails closed when WeChat delivery is not configured and validates the contextual trigger', async () => {
    const query = vi.fn()
    const app = Fastify(); apps.push(app)
    await app.register(wechatNotificationPromptApiPlugin, {
      transactions: { run: async (_scope, operation) => operation({ scope, query } as never) },
      channelConfigured: false,
      resolvePublicContext: () => ({ scope, customerId: '83000000-0000-4000-8000-000000000003', actorRef: 'prompt-customer', businessDate: '2026-08-27' }),
    })
    const response = await app.inject({ method: 'GET', url: '/public/mini/wechat-notification-prompt?context=order_checkout' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: { available: false, context: 'order_checkout', authorizations: [] } })
    expect(query).not.toHaveBeenCalled()
    const malformed = await app.inject({ method: 'GET', url: '/public/mini/wechat-notification-prompt?context=anything_else' })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ code: 'WECHAT_NOTIFICATION_PROMPT_CONTEXT_INVALID' })
  })
})
