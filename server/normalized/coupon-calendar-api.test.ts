import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { couponCalendarApiPlugin } from './coupon-calendar-api.js'
import type { MembershipConfigurationApiOptions } from './membership-configuration-api.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
function setup(mode: 'allowed' | 'denied' | 'anonymous' = 'allowed') {
  const app = Fastify(); apps.push(app)
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const assertPermission = vi.fn(async () => { if (mode === 'denied') throw new StaffAccessDeniedError('denied') })
  const run = vi.fn(async (scope, operation) => operation({ scope, query }))
  app.register(couponCalendarApiPlugin, { transactions: { run } as MembershipConfigurationApiOptions['transactions'],
    resolveStaffContext: async () => {
      if (mode === 'anonymous') throw new NormalizedAuthenticationRequiredError()
      return { scope: { tenantId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222' }, employeeId: '33333333-3333-4333-8333-333333333333', businessDate: '2026-09-09' }
    }, createStaffAccessRepository: () => ({ assertPermission }),
  })
  return { app, query, run, assertPermission }
}
describe('durable coupon calendar HTTP boundary', () => {
  it.each(['GET','POST'] as const)('requires authentication before %s version access', async method => {
    const { app, query } = setup('anonymous')
    expect((await app.inject({ method, url: '/staff/loyalty/coupon-calendar-versions', ...(method === 'POST' ? { payload: {} } : {}) })).statusCode).toBe(401)
    expect(query).not.toHaveBeenCalled()
  })
  it.each(['GET','POST'] as const)('requires the independent %s permission', async method => {
    const { app, query, assertPermission } = setup('denied')
    const response = await app.inject({ method, url: '/staff/loyalty/coupon-calendar-versions', ...(method === 'POST' ? { payload: {} } : {}) })
    expect(response.statusCode).toBe(403)
    expect(assertPermission).toHaveBeenCalledWith(expect.any(String), method === 'GET' ? 'loyalty.configuration.view' : 'loyalty.configuration.edit')
    expect(query).not.toHaveBeenCalled()
  })
  it('returns a bounded empty list using a private readonly transaction', async () => {
    const { app, run } = setup()
    const response = await app.inject({ method: 'GET', url: '/staff/loyalty/coupon-calendar-versions' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [] })
    expect(response.headers['cache-control']).toContain('no-store')
    expect(run.mock.calls[0]![2]).toEqual({ readOnly: true })
  })
  it('rejects malformed data rather than persisting a partly specified rule', async () => {
    const { app, query } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/coupon-calendar-versions', payload: { code: ['ARRAY_NOT_A_CODE'] } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('COUPON_CALENDAR_INVALID')
    expect(query).not.toHaveBeenCalled()
  })
  it('rejects a decision with an invalid version id before database access', async () => {
    const { app, query } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/coupon-calendar-versions/not-a-uuid/decisions', payload: { action: 'publish', reason: '测试发布' } })
    expect(response.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
})
