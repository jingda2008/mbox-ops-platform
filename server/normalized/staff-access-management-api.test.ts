import { StaffAccessVersionConflictError } from './staff-access-version.js'
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
      overview: { generatedAt: '2026-08-13T00:00:00.000Z', scopeKey: `${tenantId}:${storeId}`, configurationVersion: 'a'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy',
      headers: { 'idempotency-key': 'permission-release-0001' },
      payload: { expectedVersion: 'a'.repeat(64), reason: '调整服务员职责', changes: [{ kind: 'role_permission', roleId, permissionCode: 'order.create', enabled: true }] },
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
      payload: { expectedVersion: 'a'.repeat(64), reason: '调整服务员职责', changes: [{ kind: 'role_permission', roleId, permissionCode: 'order.create', enabled: true }] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PERMISSION_DEPLOYMENT_INVALID')
    expect(service.deployPermissions).not.toHaveBeenCalled()
  })

  it('requires a configuration version and returns a definitive stale-version rejection', async () => {
    const service = servicePort()
    const app = await build(service)
    const payload = { reason: '核对配置版本', changes: [{ kind: 'role_permission', roleId, permissionCode: 'order.create', enabled: true }] }
    const missing = await app.inject({ method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'permission-version-required' }, payload })
    expect(missing.statusCode).toBe(400)
    expect(service.deployPermissions).not.toHaveBeenCalled()
    service.deployPermissions.mockRejectedValue(new StaffAccessVersionConflictError())
    const stale = await app.inject({ method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'permission-version-stale' }, payload: { ...payload, expectedVersion: 'a'.repeat(64) } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'STAFF_ACCESS_VERSION_CONFLICT', retryable: false })
  })

  it('accepts domain-safe approval, data-scope, and navigation changes in one batch', async () => {
    const service = servicePort()
    service.deployPermissions.mockResolvedValue({
      status: 'verified', verifiedAt: '2026-08-13T00:00:00.000Z', replayed: false,
      changes: [], overview: { generatedAt: '2026-08-13T00:00:00.000Z', scopeKey: `${tenantId}:${storeId}`, configurationVersion: 'a'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'access-policy-release-0001' },
      payload: { expectedVersion: 'a'.repeat(64), reason: '调整店长审批与入口', changes: [
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
      payload: { expectedVersion: 'a'.repeat(64), reason: '错误入口验证', changes: [{
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
      changes: [], overview: { generatedAt: '2026-08-13T00:00:00.000Z', scopeKey: `${tenantId}:${storeId}`, configurationVersion: 'a'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] },
    })
    const app = await build(service)
    const response = await app.inject({
      method: 'POST', url: '/staff-access/deploy', headers: { 'idempotency-key': 'catalog-route-release-0001' },
      payload: { expectedVersion: 'a'.repeat(64), reason: '服务端目录验证', changes: [{
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

  it('creates an employee without placing the raw PIN in the command fingerprint', async () => {
    const service = servicePort()
    service.createEmployee.mockResolvedValue({ employeeId: '55555555-5555-4555-8555-555555555555', status: 'active', verifiedAt: '2026-09-08T00:00:00.000Z', overview: emptyOverview(), replayed: false })
    const app = await build(service)
    const response = await app.inject({ method: 'POST', url: '/staff-access/employees', headers: { 'idempotency-key': 'staff-employee-create-0001' }, payload: { employeeCode: 'LIYAN', displayName: '李艳', pin: '4826', roleId, reason: '员工入职' } })
    expect(response.statusCode).toBe(201)
    const input = service.createEmployee.mock.calls[0]?.[0]
    expect(input?.pin).toBe('4826')
    expect(JSON.parse(input!.requestFingerprint)).not.toHaveProperty('pin')
    expect(JSON.parse(input!.requestFingerprint).pinBinding).toMatch(/^[a-f0-9]{64}$/)
    expect(input?.requestFingerprint).toContain('"pinConfigured":true')
  })

  it('validates employee status changes before calling the service', async () => {
    const service = servicePort()
    const app = await build(service)
    const response = await app.inject({ method: 'POST', url: `/staff-access/employees/${roleId}/status`, headers: { 'idempotency-key': 'staff-employee-status-0001' }, payload: { status: 'departed', reason: '无效状态' } })
    expect(response.statusCode).toBe(400)
    expect(service.setEmployeeStatus).not.toHaveBeenCalled()
  })

  it.each(['pin','actor','tenant','store','key','secret'])('isolates the PIN binding by %s while keeping identical retries stable', async dimension => {
    const service = servicePort()
    service.createEmployee.mockResolvedValue({ verifiedAt: '2026-11-02', replayed: false })
    const context = { scope: { tenantId, storeId }, employeeId, businessDate: '2026-11-02' }
    const secret = 'local-audit-fixture-key-not-for-production-20261102'
    const app = await build(service, async () => context, secret)
    const req = { method: 'POST' as const, url: '/staff-access/employees', headers: { 'idempotency-key': 'staff-create-pin-binding' }, payload: { employeeCode: 'LOCAL', displayName: 'Local', pin: '4826', roleId, reason: 'Local fixture' } }
    expect((await app.inject(req)).statusCode).toBe(201)
    expect((await app.inject(req)).statusCode).toBe(201)
    const original = service.createEmployee.mock.calls[0]![0].requestFingerprint
    expect(service.createEmployee.mock.calls[1]![0].requestFingerprint).toBe(original)
    if (dimension === 'actor') context.employeeId = roleId
    if (dimension === 'tenant') context.scope.tenantId = roleId
    if (dimension === 'store') context.scope.storeId = roleId
    if (dimension === 'pin') req.payload.pin = '7391'
    if (dimension === 'key') req.headers['idempotency-key'] += '-other'
    const target = dimension === 'secret' ? await build(service, async () => context, `${secret}-rotated`) : app
    expect((await target.inject(req)).statusCode).toBe(201)
    expect(JSON.parse(service.createEmployee.mock.calls[2]![0].requestFingerprint).pinBinding).not.toBe(JSON.parse(original).pinBinding)
  })

  it('fails registration without a sufficiently long fingerprint key', async () => {
    await expect(build(servicePort(), undefined, 'short')).rejects.toThrow('fingerprint key')
  })
})

async function build(
  service = servicePort(),
  resolveContext = async () => ({ scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13' }),
  fingerprintSecret = 'local-audit-fixture-key-not-for-production-20261102',
) {
  const app = Fastify()
  apps.push(app)
  await app.register(staffAccessManagementApiPlugin, {
    fingerprintSecret,
    service: service as unknown as StaffAccessManagementService,
    resolveContext,
  })
  return app
}

function servicePort() {
  return { getOverview: vi.fn(), deployPermissions: vi.fn(), createEmployee: vi.fn(), setEmployeeStatus: vi.fn() }
}

function emptyOverview() {
  return { generatedAt: '2026-09-08T00:00:00.000Z', scopeKey: `${tenantId}:${storeId}`, configurationVersion: 'a'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] }
}
