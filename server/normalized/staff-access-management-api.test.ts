import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StaffAccessManagementService } from './staff-access-management-service.js'
import { staffAccessManagementApiPlugin } from './staff-access-management-api.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const roleId = '44444444-4444-4444-8444-444444444444'
const apps: ReturnType<typeof Fastify>[] = []

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('staff access management API', () => {
  it('publishes one atomic permission batch and returns server verification', async () => {
    const service = servicePort()
    service.deployPermissions.mockResolvedValue({
      status: 'verified', verifiedAt: '2026-08-13T00:00:00.000Z', replayed: false,
      changes: [{ kind: 'role_permission', targetId: roleId, configurationCode: 'order.create', applied: true, effectiveEmployeeCount: 2, affectedEmployeeCount: 2 }],
      overview: { generatedAt: '2026-08-13T00:00:00.000Z', roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy',
      headers: { 'idempotency-key': 'permission-release-0001' },
      payload: { reason: '调整服务员职责', changes: [{ kind: 'role_permission', roleId, permissionCode: 'order.create', enabled: true }] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.status).toBe('verified')
    expect(response.json().data.changes[0]).toMatchObject({ applied: true, effectiveEmployeeCount: 2 })
    expect(service.deployPermissions).toHaveBeenCalledWith(expect.objectContaining({
      actorEmployeeId: employeeId, idempotencyKey: 'permission-release-0001', reason: '调整服务员职责',
    }))
  })

  it('rejects writes without an idempotency key before changing access', async () => {
    const service = servicePort()
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy',
      payload: { reason: '调整服务员职责', changes: [{ kind: 'role_permission', roleId, permissionCode: 'order.create', enabled: true }] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PERMISSION_DEPLOYMENT_INVALID')
    expect(service.deployPermissions).not.toHaveBeenCalled()
  })

  it('accepts domain-safe approval, data-scope, and navigation changes in one batch', async () => {
    const service = servicePort()
    service.deployPermissions.mockResolvedValue({
      status: 'verified', verifiedAt: '2026-08-13T00:00:00.000Z', replayed: false,
      changes: [], overview: { generatedAt: '2026-08-13T00:00:00.000Z', roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'access-policy-release-0001' },
      payload: { reason: '调整店长审批与入口', changes: [
        { kind: 'role_approval_limit', roleId, approvalCode: 'order.gift', amountMinor: 30_000, currency: 'CNY', rules: { requiresReason: true }, enabled: true },
        { kind: 'role_data_scope', roleId, scopeKey: 'kds.station_codes', effect: 'include', scopeValue: ['bar'], enabled: true },
        { kind: 'role_navigation', roleId, navigationCode: 'live', label: '现场', route: '/staff/live', icon: null, sortOrder: 10, enabled: true, displayConfig: { highFrequency: true } },
      ] },
    })
    expect(response.statusCode).toBe(200)
    expect(service.deployPermissions).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.arrayContaining([
        expect.objectContaining({ kind: 'role_approval_limit', amountMinor: 30_000 }),
        expect.objectContaining({ kind: 'role_data_scope', scopeValue: ['bar'] }),
        expect.objectContaining({ kind: 'role_navigation', route: '/staff/live' }),
      ]),
    }))
  })

  it('rejects a navigation route outside the employee application', async () => {
    const service = servicePort()
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'access-route-release-0001' },
      payload: { reason: '错误入口验证', changes: [{
        kind: 'role_navigation', roleId, navigationCode: 'outside', label: '外部', route: 'https://example.com',
        icon: null, sortOrder: 10, enabled: true, displayConfig: {},
      }] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('入口路径')
    expect(service.deployPermissions).not.toHaveBeenCalled()
  })

  it('leaves syntactically safe navigation authority to the server catalog instead of an API route list', async () => {
    const service = servicePort()
    service.deployPermissions.mockResolvedValue({
      status: 'verified', verifiedAt: '2026-08-13T00:00:00.000Z', replayed: false,
      changes: [], overview: { generatedAt: '2026-08-13T00:00:00.000Z', roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'catalog-route-release-0001' },
      payload: { reason: '服务端目录验证', changes: [{
        kind: 'role_navigation', roleId, navigationCode: 'future', label: '未来入口', route: '/staff/future',
        icon: null, sortOrder: 10, enabled: true, displayConfig: {},
      }] },
    })
    expect(response.statusCode).toBe(200)
    expect(service.deployPermissions).toHaveBeenCalledWith(expect.objectContaining({
      changes: [expect.objectContaining({ route: '/staff/future' })],
    }))
  })

  it('does not expose management data to an employee without access permission', async () => {
    const service = servicePort()
    service.getOverview.mockRejectedValue(new StaffAccessDeniedError('forbidden'))
    const app = await build(service)
    const response = await app.inject({ method: 'GET', url: '/staff-access/overview' })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toBe('当前账号没有权限管理授权配置')
  })

  it('asks the administrator to sign in again when the session has expired', async () => {
    const service = servicePort()
    const app = await build(service, async () => { throw new NormalizedAuthenticationRequiredError() })
    const response = await app.inject({ method: 'GET', url: '/staff-access/overview' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toMatchObject({ code: 'AUTH_REQUIRED', retryable: false })
    expect(service.getOverview).not.toHaveBeenCalled()
  })
})

async function build(
  service = servicePort(),
  resolveContext = async () => ({ scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13' }),
) {
  const app = Fastify()
  apps.push(app)
  await app.register(staffAccessManagementApiPlugin, {
    service: service as unknown as StaffAccessManagementService,
    resolveContext,
  })
  return app
}

function servicePort() {
  return { getOverview: vi.fn(), deployPermissions: vi.fn() }
}
