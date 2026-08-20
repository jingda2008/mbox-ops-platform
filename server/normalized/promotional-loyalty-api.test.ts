import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { promotionalLoyaltyApiPlugin } from './promotional-loyalty-api.js'
import type { PromotionalLoyaltyService } from './promotional-loyalty-service.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const context = {
  scope: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    storeId: '22222222-2222-4222-8222-222222222222',
  },
  employeeId: '33333333-3333-4333-8333-333333333333',
  businessDate: '2026-08-16',
}
const policyId = '44444444-4444-4444-8444-444444444444'
const activityId = '55555555-5555-4555-8555-555555555555'

describe('promotional loyalty API', () => {
  it('enforces separated permissions for view, draft, approve and publish', async () => {
    const service = fakeService()
    const permissions: string[] = []
    const app = await build(service, async (_employeeId, permission) => { permissions.push(permission) })

    expect((await app.inject({ method: 'GET', url: '/staff/loyalty/promotion-policies' })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'POST',
      url: '/staff/loyalty/promotion-policies',
      headers: { 'idempotency-key': 'promotion-draft-0001' },
      payload: validDraft(),
    })).statusCode).toBe(201)
    expect((await app.inject({
      method: 'POST',
      url: `/staff/loyalty/promotion-policies/${policyId}/approve`,
      headers: { 'idempotency-key': 'promotion-approve-0001' },
      payload: { reason: '独立复核预算和叠加范围' },
    })).statusCode).toBe(409)
    expect((await app.inject({
      method: 'POST',
      url: `/staff/loyalty/promotion-policies/${policyId}/publish`,
      headers: { 'idempotency-key': 'promotion-publish-0001' },
      payload: {
        effectiveFrom: '2026-08-20T10:00:00+08:00',
        effectiveUntil: '2026-08-21T02:00:00+08:00',
        reason: '最高管理人员确认上线窗口',
      },
    })).statusCode).toBe(200)

    expect(permissions).toEqual([
      'loyalty.promotion.view',
      'loyalty.promotion.manage',
      'loyalty.promotion.approve',
      'loyalty.promotion.publish',
    ])
    expect(service.approve).not.toHaveBeenCalled()
  })

  it('rejects free-form trigger, invalid thresholds and missing idempotency before service execution', async () => {
    const service = fakeService()
    const app = await build(service, async () => {})

    const freeForm = await app.inject({
      method: 'POST',
      url: '/staff/loyalty/promotion-policies',
      headers: { 'idempotency-key': 'promotion-invalid-0001' },
      payload: {
        ...validDraft(),
        rules: [{ ...validDraft().rules[0], triggerKind: 'providerSnapshot.paid' }],
      },
    })
    expect(freeForm.statusCode).toBe(400)
    expect(freeForm.json().error.code).toBe('LOYALTY_PROMOTION_INVALID_INPUT')

    const invalidAmount = await app.inject({
      method: 'POST',
      url: '/staff/loyalty/promotion-policies',
      headers: { 'idempotency-key': 'promotion-invalid-0002' },
      payload: { ...validDraft(), storeBudgetPoints: 0 },
    })
    expect(invalidAmount.statusCode).toBe(400)

    const noKey = await app.inject({
      method: 'POST',
      url: '/staff/loyalty/promotion-policies',
      payload: validDraft(),
    })
    expect(noKey.statusCode).toBe(400)
    expect(service.draft).not.toHaveBeenCalled()
  })

  it('fails closed when an employee lacks promotion authority', async () => {
    const service = fakeService()
    const app = await build(service, async (_employeeId, permission) => {
      throw new StaffAccessDeniedError(permission)
    })
    const response = await app.inject({ method: 'GET', url: '/staff/loyalty/promotion-policies' })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('STAFF_ACCESS_DENIED')
    expect(service.configuration).not.toHaveBeenCalled()
  })
})

async function build(
  service: ReturnType<typeof fakeService>,
  assertPermission: (employeeId: string, permission: string) => Promise<void>,
) {
  const app = Fastify()
  await app.register(promotionalLoyaltyApiPlugin, {
    service: service as unknown as PromotionalLoyaltyService,
    transactions: { run: async (_scope, handler) => handler({} as never) },
    resolveStaffContext: () => context,
    createStaffAccessRepository: () => ({ assertPermission }),
  })
  return app
}

function fakeService() {
  const data = policy()
  return {
    configuration: vi.fn(async () => [data]),
    draft: vi.fn(async () => ({ value: data, replayed: false })),
    approve: vi.fn(async () => ({ value: { ...data, status: 'approved' }, replayed: false })),
    publish: vi.fn(async () => ({ value: { ...data, status: 'published' }, replayed: false })),
  }
}

function validDraft() {
  return {
    campaignCode: 'SUPERHIGH-AUG',
    name: '超嗨活动到场积分',
    activityId,
    stackingGroup: 'SUPERHIGH',
    stackingMode: 'exclusive_highest',
    priority: 100,
    storeBudgetPoints: 10_000,
    perMemberPointsLimit: 200,
    pointValidityDays: 180,
    refundPolicy: 'reverse_on_any_refund',
    budgetReuseAfterRefund: false,
    memberLimitReuseAfterRefund: false,
    eligibleMemberLevels: ['member', 'silver', 'gold'],
    rules: [{
      ruleCode: 'CHECKIN',
      triggerKind: 'activity_check_in',
      points: 60,
      perMemberAwardLimit: 1,
      minimumPaidAmountMinor: 0,
      enabled: true,
    }],
    reason: '限定预算试运行并观察活动完成质量',
  }
}

function policy() {
  return {
    id: policyId,
    campaignCode: 'SUPERHIGH-AUG',
    version: 1,
    name: '超嗨活动到场积分',
    activityId,
    activityTitle: '超嗨周末夜',
    stackingGroup: 'SUPERHIGH',
    stackingMode: 'exclusive_highest',
    priority: 100,
    storeBudgetPoints: 10_000,
    perMemberPointsLimit: 200,
    pointValidityDays: 180,
    refundPolicy: 'reverse_on_any_refund',
    budgetReuseAfterRefund: false,
    memberLimitReuseAfterRefund: false,
    eligibleMemberLevels: ['member', 'silver', 'gold'],
    status: 'draft',
    effectiveFrom: null,
    effectiveUntil: null,
    draftedByEmployeeId: context.employeeId,
    approvedByEmployeeId: null,
    approvedAt: null,
    publishedByEmployeeId: null,
    publishedAt: null,
    reason: '限定预算试运行并观察活动完成质量',
    rules: [],
    awardedPoints: 0,
    remainingBudgetPoints: 10_000,
    deferredTriggerCount: 0,
  }
}
