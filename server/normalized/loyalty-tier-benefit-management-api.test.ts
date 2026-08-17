import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loyaltyTierBenefitManagementApiPlugin } from './loyalty-tier-benefit-management-api.js'
import type { LoyaltyTierBenefitManagementService } from './loyalty-tier-benefit-management-service.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const apps: ReturnType<typeof Fastify>[] = []
const policyId = '82000000-0000-4000-8000-000000000020'

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

describe('loyalty tier benefit management API', () => {
  it('maps view, draft, approval and publication to four explicit permissions and contracts', async () => {
    const checked: string[] = []
    const service = {
      configuration: vi.fn(async () => ({ policies: [], definitions: [], tierPolicies: [] })),
      draft: vi.fn(async () => ({ value: { id: policyId, version: 1, status: 'draft', ruleCount: 1 }, replayed: false })),
      approve: vi.fn(async () => ({ value: { id: policyId, version: 1, status: 'approved', ruleCount: 1 }, replayed: false })),
      publish: vi.fn(async () => ({ value: { id: policyId, version: 1, status: 'published', ruleCount: 1 }, replayed: false })),
    }
    const app = fixture(service, async (_employeeId, permission) => { checked.push(permission); return {} })
    const rule = {
      ruleCode: 'SILVER_ENTRY', eligibleTier: 'silver', inheritToHigherTiers: false,
      grantOnEntry: true, grantOnRetention: false, benefitDefinitionId: policyId,
      quantity: 1, validityDays: 30, revocationPolicy: 'revoke_unreserved', enabled: true,
    }
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/staff/loyalty/tier-benefits' }),
      app.inject({
        method: 'POST', url: '/staff/loyalty/tier-benefit-policies',
        headers: { 'idempotency-key': 'tier-benefit-draft-api-0001' },
        payload: { tierPolicyVersionId: policyId, reason: '建立等级自动权益政策', rules: [rule] },
      }),
      app.inject({
        method: 'POST', url: `/staff/loyalty/tier-benefit-policies/${policyId}/approve`,
        headers: { 'idempotency-key': 'tier-benefit-approve-api-0001' }, payload: { reason: '独立审批通过' },
      }),
      app.inject({
        method: 'POST', url: `/staff/loyalty/tier-benefit-policies/${policyId}/publish`,
        headers: { 'idempotency-key': 'tier-benefit-publish-api-0001' },
        payload: { effectiveFrom: '2026-09-01T00:00:00Z', reason: '最高权限正式发布' },
      }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 201, 409, 200])
    expect(responses[2]?.json().error.code).toBe('MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED')
    expect(checked).toEqual([
      'loyalty.policy.view', 'loyalty.policy.manage', 'loyalty.policy.approve', 'loyalty.policy.publish',
    ])
    expect(service.draft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      rules: [expect.objectContaining({ validityDays: 30, revocationPolicy: 'revoke_unreserved' })],
    }))
    expect(service.approve).not.toHaveBeenCalled()
    expect(service.publish).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ rules: expect.anything() }))
  })

  it('returns 403 before invoking service when the staff lacks the required permission', async () => {
    const service = { configuration: vi.fn() }
    const app = fixture(service, async () => { throw new StaffAccessDeniedError('denied') })
    const response = await app.inject({ method: 'GET', url: '/staff/loyalty/tier-benefits' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该操作的权限' } })
    expect(service.configuration).not.toHaveBeenCalled()
  })

  it('rejects free-form or incomplete runtime rules at the API boundary', async () => {
    const service = { draft: vi.fn() }
    const app = fixture(service, async () => ({}))
    const response = await app.inject({
      method: 'POST', url: '/staff/loyalty/tier-benefit-policies',
      headers: { 'idempotency-key': 'tier-benefit-invalid-api-0001' },
      payload: {
        tierPolicyVersionId: policyId, reason: '无效规则测试',
        rules: [{ ruleCode: 'BAD', eligibility: { tier: 'silver' } }],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(service.draft).not.toHaveBeenCalled()
  })
})

function fixture(
  service: Record<string, ReturnType<typeof vi.fn>>,
  assertPermission: (employeeId: string, permission: string) => Promise<unknown>,
) {
  const app = Fastify(); apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  void app.register(loyaltyTierBenefitManagementApiPlugin, {
    transactions: { run: async (_scope, operation) => operation({ scope } as never) },
    service: service as unknown as LoyaltyTierBenefitManagementService,
    resolveStaffContext: () => ({
      scope, employeeId: '82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
    }),
    createStaffAccessRepository: () => ({ assertPermission }),
  })
  return app
}
