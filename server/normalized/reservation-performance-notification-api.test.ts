import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { reservationPerformanceNotificationApiPlugin } from './reservation-performance-notification-api.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const context = {
  scope,
  customerId: '10000000-0000-4000-8000-000000000003',
  actorRef: 'reservation-session:self',
  businessDate: '2026-08-17',
}
const policyId = '10000000-0000-4000-8000-000000000004'

describe('reservation performance notification API', () => {
  it('fails closed when the formal WeChat reservation channel is not configured', async () => {
    const app = await application(false)
    const response = await app.inject({
      method: 'POST', url: '/public/reservation/performance-notification-authorizations',
      headers: { 'idempotency-key': 'reservation-reminder-attempt-001' },
      payload: validPayload(),
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().code).toBe('RESERVATION_NOTIFICATION_NOT_CONFIGURED')
    await app.close()
  })

  it('lists no controls when the channel is unavailable instead of exposing a generic member setting', async () => {
    const app = await application(false)
    const response = await app.inject({
      method: 'GET', url: '/public/reservation/performance-notification-authorizations',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: { available: false, authorizations: [] } })
    await app.close()
  })

  it('rejects customer, reservation and identity authority claims from the client', async () => {
    const app = await application(true)
    const response = await app.inject({
      method: 'POST', url: '/public/reservation/performance-notification-authorizations',
      headers: { 'idempotency-key': 'reservation-reminder-attempt-002' },
      payload: { ...validPayload(), customerId: context.customerId },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('RESERVATION_NOTIFICATION_INPUT_INVALID')
    await app.close()
  })

  it('records only the authenticated reservation-context choice with an idempotent command', async () => {
    const execute = vi.fn(async () => ({
      replayed: false,
      value: {
        id: '10000000-0000-4000-8000-000000000005',
        reservationPublicId: 'reservation-public-001',
        decision: 'granted', authorizationVersion: 1,
        changedAt: '2026-08-17T10:00:00.000Z',
      },
    }))
    const app = await application(true, execute)
    const response = await app.inject({
      method: 'POST', url: '/public/reservation/performance-notification-authorizations',
      headers: { 'idempotency-key': 'reservation-reminder-attempt-003' },
      payload: validPayload(),
    })
    expect(response.statusCode).toBe(201)
    expect(execute).toHaveBeenCalledOnce()
    const [command] = execute.mock.calls[0]!
    expect(command.operationScope).toBe('customer.reservation-performance-notification-authorization.record')
    expect(command.idempotencyKey).toBe('reservation-reminder-attempt-003')
    expect(command.requestFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await app.close()
  })
})

function validPayload() {
  return {
    reservationPublicId: 'reservation-public-001',
    policyId,
    policyVersion: 1,
    templateId: 'wechat-template-reservation-revised',
    expectedVersion: 0,
    platformResult: 'accept',
    platformEventReference: 'wx-subscribe-reservation-001',
  }
}

async function application(
  channelConfigured: boolean,
  execute: (...args: any[]) => Promise<any> = async () => { throw new Error('execute should not run') },
) {
  const app = Fastify()
  await app.register(reservationPerformanceNotificationApiPlugin, {
    transactions: {
      run: async (_scope, callback) => callback({
        scope,
        query: async () => ({ rows: [], rowCount: 0 }),
      } as never),
    },
    commands: { execute } as never,
    channelConfigured,
    resolveCustomerContext: () => context,
  })
  return app
}
