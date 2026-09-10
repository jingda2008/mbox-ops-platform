import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stackingPricingApiPlugin } from './stacking-pricing-api.js'
import { DEFAULT_STACKING_POLICY } from './stacking-pricing.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import type { MembershipConfigurationApiOptions } from './membership-configuration-api.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
function setup(denied = false) {
  const app = Fastify(); apps.push(app)
  const assertPermission = vi.fn(async () => { if (denied) throw new StaffAccessDeniedError('denied') })
  const run = vi.fn(async (_scope, operation) => operation({ scope: _scope, query: vi.fn(() => { throw new Error('preview must not query financial facts') }) }))
  app.register(stackingPricingApiPlugin, {
    transactions: { run } as MembershipConfigurationApiOptions['transactions'],
    resolveStaffContext: async () => ({ scope: { tenantId: 'tenant', storeId: 'store' }, employeeId: 'employee', businessDate: '2026-09-09' }),
    createStaffAccessRepository: () => ({ assertPermission }),
  })
  return { app, run, assertPermission }
}
const payload = { policy: DEFAULT_STACKING_POLICY, scenario: { units: [{ id: 'one', amountMinor: 6800, costMinor: null, bundle: false }], effects: [] } }
describe('staff stacking preview boundaries', () => {
  it.each([{action:'publish',reason:'有效原因',price:1},{action:'approve',employeeId:'other'},null,[]])('rejects unexpected release command fields: %j',async payload=>{
    const {app}=setup()
    const result=await app.inject({method:'POST',url:'/staff/loyalty/stacking-price-drafts/33333333-3333-4333-8333-333333333333/decisions',payload})
    expect(result.statusCode).toBe(400)
    expect(result.headers['cache-control']).toContain('no-store')
  })
  it('calendar preview uses server time, is read-only and has no redemption authority', async () => {
    const { app, run, assertPermission } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/coupon-calendar-preview', payload: {
      at: '2000-01-01T00:00:00Z', days: 2,
      rule: { timezone: 'Asia/Shanghai', dateBasis: 'natural', businessDayStartMinute: 0,
        dateFrom: '2026-09-01', dateThrough: '2026-09-30', validFrom: '2026-09-01T00:00:00+08:00',
        validUntil: '2026-10-01T00:00:00+08:00', weekdays: [1,2,3], weekStartsOn: 1,
        windows: [{ startMinute: 0, endMinute: 1440 }], excludedDates: [] },
    } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ mode: 'simulation', redemptionAuthorization: false })
    expect(Math.abs(Date.parse(response.json().data.asOf) - Date.now())).toBeLessThan(5000)
    expect(response.json().data.calendar).toHaveLength(2)
    expect(assertPermission).toHaveBeenCalledWith('employee', 'loyalty.configuration.preview')
    expect(run.mock.calls[0]![2]).toEqual({ readOnly: true })
  })
  it('protects calendar preview and reports malformed calendars distinctly', async () => {
    const denied = setup(true)
    expect((await denied.app.inject({ method: 'POST', url: '/staff/loyalty/coupon-calendar-preview', payload: {} })).statusCode).toBe(403)
    const { app } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/coupon-calendar-preview', payload: {} })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('COUPON_CALENDAR_INVALID')
  })
  it('returns an explicit simulation, requires permission, and uses only a read transaction', async () => {
    const { app, run, assertPermission } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/stacking-price-preview', payload })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ mode: 'simulation', orderAuthorization: false, payableMinor: 6800, grossProfitMinor: null })
    expect(response.headers['cache-control']).toContain('no-store')
    expect(assertPermission).toHaveBeenCalledWith('employee', 'loyalty.configuration.preview')
    expect(run.mock.calls[0]![2]).toEqual({ readOnly: true })
  })
  it('rejects employees without preview permission', async () => {
    const { app } = setup(true)
    expect((await app.inject({ method: 'POST', url: '/staff/loyalty/stacking-price-preview', payload })).statusCode).toBe(403)
  })
  it('does not silently accept incomplete configuration', async () => {
    const { app } = setup()
    expect((await app.inject({ method: 'POST', url: '/staff/loyalty/stacking-price-preview', payload: { policy: {}, scenario: {} } })).statusCode).toBe(400)
  })
  it.each([
    ['GET', 'loyalty.configuration.view'],
    ['POST', 'loyalty.configuration.edit'],
  ] as const)('protects draft %s separately from preview permission', async (method, permission) => {
    const { app, assertPermission } = setup(true)
    const response = await app.inject({ method, url: '/staff/loyalty/stacking-price-drafts',
      ...(method === 'POST' ? { payload: {} } : {}) })
    expect(response.statusCode).toBe(403)
    expect(assertPermission).toHaveBeenCalledWith('employee', permission)
    expect(response.headers['cache-control']).toContain('no-store')
  })
  it.each([
    { code: ['DEFAULT'] }, { reason: '' }, { expectedVersion: -1 },
    { policy: {} }, { expectedVersion: '0' },
  ])('rejects invalid draft fields before writing: %j', async invalid => {
    const { app } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/stacking-price-drafts',
      headers: { 'idempotency-key': 'draft-request-123' },
      payload: { code: 'DEFAULT', reason: '测试草稿', expectedVersion: 0, policy: DEFAULT_STACKING_POLICY, ...invalid } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('STACKING_PRICING_INVALID')
  })
  it('requires a recoverable request identity for saving', async () => {
    const { app } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/loyalty/stacking-price-drafts',
      payload: { code: 'DEFAULT', reason: '测试草稿', expectedVersion: 0, policy: DEFAULT_STACKING_POLICY } })
    expect(response.statusCode).toBe(400)
  })
})
