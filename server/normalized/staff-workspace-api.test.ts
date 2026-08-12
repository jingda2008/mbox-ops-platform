import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StaffBootstrapView } from '../../src/shared/normalized-contracts.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { staffWorkspaceApiPlugin } from './staff-workspace-api.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const etag = '"staff-bootstrap-0123456789abcdef0123456789abcdef"'
const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function view(): StaffBootstrapView {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-11T12:00:00.000Z',
    watermark: '0123456789abcdef0123456789abcdef',
    store: {
      id: storeId, code: 'lujiazui', name: 'M-BOX', timezone: 'Asia/Shanghai',
      businessDayCutoff: '06:00:00', currency: 'CNY',
    },
    businessDay: { date: '2026-08-11', status: 'open', openedAt: null, rolloverAt: null, closedAt: null },
    staff: { id: employeeId, code: 'LIYAN', displayName: '李艳', roleCodes: ['MANAGER'], roleNames: ['店长'] },
    access: {
      permissions: ['dashboard.view'], deniedPermissions: [], dataScopes: [], approvalLimits: [],
      resolvedAt: '2026-08-11T12:00:00.000Z',
    },
    navigation: [],
    highFrequencyEntries: [],
    domainSummaries: [],
    endpointRefs: {
      workspace: '/api/staff/workspace', sessions: '/api/operations', operations: '/api/operations',
      tableManagement: '/api/table-management/tables', fulfillment: '/api/commerce/fulfillment',
      reservations: '/api/staff/reservations', reservationIntake: '/api/staff/reservation-intake',
      reconciliation: '/api/reconciliation', inventory: '/api/inventory', notifications: '/api/notifications',
      aiCapabilities: '/api/ai/capabilities', hardwareWork: '/api/hardware/work',
    },
  }
}

function createApp(resolveContext = vi.fn(async () => ({
  scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-11', capabilities: ['dashboard.view'],
}))) {
  const query = { get: vi.fn(async () => ({ view: view(), etag })) }
  const app = Fastify()
  apps.push(app)
  app.register(staffWorkspaceApiPlugin, { prefix: '/api', query, resolveContext })
  return { app, query, resolveContext }
}

describe('staffWorkspaceApiPlugin', () => {
  it('returns the compact view with private revalidation headers', async () => {
    const value = createApp()
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/workspace' })

    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toBe(etag)
    expect(response.headers['cache-control']).toBe('private, no-cache')
    expect(response.headers.vary).toContain('Cookie')
    expect(response.json()).toMatchObject({
      data: { staff: { displayName: '李艳' } },
      meta: { generatedAt: '2026-08-11T12:00:00.000Z', requestId: expect.any(String) },
    })
    expect(value.query.get).toHaveBeenCalledWith({ tenantId, storeId }, employeeId, '2026-08-11')
  })

  it('returns 304 for the same actor-specific normalized watermark', async () => {
    const value = createApp()
    const response = await value.app.inject({
      method: 'GET', url: '/api/staff/workspace', headers: { 'if-none-match': `W/${etag}` },
    })

    expect(response.statusCode).toBe(304)
    expect(response.body).toBe('')
    expect(response.headers.etag).toBe(etag)
  })

  it('maps missing authentication without exposing internal details', async () => {
    const value = createApp(vi.fn(async () => { throw new NormalizedAuthenticationRequiredError() }))
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/workspace' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      error: { code: 'AUTH_REQUIRED', message: '登录信息已过期，请重新登录', retryable: false },
      meta: { requestId: expect.any(String) },
    })
    expect(value.query.get).not.toHaveBeenCalled()
  })

  it('returns a retryable unified envelope without leaking transient failure details', async () => {
    const value = createApp()
    value.query.get.mockRejectedValueOnce(new Error('sensitive database details'))
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/workspace' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: {
        code: 'STAFF_WORKSPACE_UNAVAILABLE',
        message: '工作台暂时不可用，请稍后重试',
        retryable: true,
      },
      meta: { requestId: expect.any(String) },
    })
    expect(response.body).not.toContain('sensitive database details')
  })
})
