import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { activityOperationsApiPlugin } from './activity-operations-api.js'
import { ActivityOperationsError } from './activity-operations-repository.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const context = {
  scope,
  employeeId: '10000000-0000-4000-8000-000000000003',
  businessDate: '2026-08-16',
}

describe('activity operations API', () => {
  it('returns a clear authentication response when the staff session expired', async () => {
    const service = serviceMock()
    const app = await application(
      service,
      { assertPermission: async () => undefined },
      undefined,
      undefined,
      async () => { throw new StaffSessionNotFoundError() },
    )
    const response = await app.inject({ method: 'GET', url: '/staff/activity-operations' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
    expect(service.list).not.toHaveBeenCalled()
    await app.close()
  })

  it('requires activity view permission before listing operational data', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({ method: 'GET', url: '/staff/activity-operations' })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.view'])
    expect(service.list).toHaveBeenCalledOnce()
    await app.close()
  })

  it('treats activity management as including the read needed to open its page', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => {
        permissions.push(permission)
        if (permission === 'community.activity.view') throw new StaffAccessDeniedError('denied')
      },
    })
    const response = await app.inject({ method: 'GET', url: '/staff/activity-operations' })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.view', 'community.activity.manage'])
    expect(service.list).toHaveBeenCalledOnce()
    await app.close()
  })

  it('returns the activity component catalog with activity management only and never calls the inventory dashboard', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    service.componentCatalog.mockResolvedValueOnce([{
      id: '10000000-0000-4000-8000-000000000099', sku: 'ACT-DRINK-001', name: '限定饮品基酒', baseUnit: 'ml',
    }])
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({ method: 'GET', url: '/staff/activity-operations/component-catalog' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [{
      id: '10000000-0000-4000-8000-000000000099', sku: 'ACT-DRINK-001', name: '限定饮品基酒', baseUnit: 'ml',
    }] })
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.componentCatalog).toHaveBeenCalledWith(context)
    expect(service.detail).not.toHaveBeenCalled()
    await app.close()
  })

  it('creates a fully typed draft through the single operations contract', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations',
      headers: { 'idempotency-key': 'activity-draft-create-key-001' },
      payload: validDraft(),
    })
    expect(response.statusCode).toBe(201)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.createDraft).toHaveBeenCalledWith(context, {
      draft: expect.objectContaining({ title: '会员音乐夜', audienceMemberLevels: [] }),
      reason: '补充本周活动安排', idempotencyKey: 'activity-draft-create-key-001',
    })
    await app.close()
  })

  it('rejects unapproved black-tier targeting before any draft write', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations',
      headers: { 'idempotency-key': 'activity-draft-create-key-002' },
      payload: {
        ...validDraft(), visibility: 'segment',
        audienceMemberLevels: ['black'], audienceLifecycleStages: [],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(service.createDraft).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts only a bounded image-library cover address', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations',
      headers: { 'idempotency-key': 'activity-draft-cover-invalid-001' },
      payload: { ...validDraft(), coverUrl: 'https://example.com/unbounded-cover.png' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('封面必须从站内图片库选择')
    expect(service.createDraft).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts an immutable public media asset as the activity cover', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations',
      headers: { 'idempotency-key': 'activity-draft-cover-media-001' },
      payload: { ...validDraft(), coverUrl: '/api/public/media-assets/MA00000000000000000000000000000001' },
    })
    expect(response.statusCode).toBe(201)
    expect(service.createDraft).toHaveBeenCalledWith(context, expect.objectContaining({
      draft: expect.objectContaining({ coverUrl: '/api/public/media-assets/MA00000000000000000000000000000001' }),
    }))
    await app.close()
  })

  it('maps compact registration actions and keeps mutation permission separate', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/staff/activity-operations/registrations/activity-registration-001/check-in',
      headers: { 'idempotency-key': 'activity-check-in-key-001' },
      payload: { reason: '现场核对本人到场' },
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.transitionRegistration).toHaveBeenCalledWith(context, {
      publicId: 'activity-registration-001', operation: 'check_in',
      reason: '现场核对本人到场', idempotencyKey: 'activity-check-in-key-001',
    })
    await app.close()
  })

  it('keeps package delivery separate from check-in and accepts the compact delivery action', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/staff/activity-operations/registrations/activity-registration-001/fulfill-package',
      headers: { 'idempotency-key': 'activity-package-delivery-key-001' },
      payload: { reason: '吧台已实际交付套餐内容' },
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.transitionRegistration).toHaveBeenCalledWith(context, {
      publicId: 'activity-registration-001', operation: 'fulfill_package',
      reason: '吧台已实际交付套餐内容', idempotencyKey: 'activity-package-delivery-key-001',
    })
    await app.close()
  })

  it('accepts one fully specified package in the same activity draft request', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations',
      headers: { 'idempotency-key': 'activity-package-draft-key-001' },
      payload: {
        ...validDraft(), packageSelectionRequired: true,
        packages: [validPackageDraft()],
      },
    })
    expect(response.statusCode).toBe(201)
    expect(service.createDraft).toHaveBeenCalledWith(context, expect.objectContaining({
      draft: expect.objectContaining({
        packageSelectionRequired: true,
        packages: [expect.objectContaining({
          name: '限定饮品加购', memberPurchaseLimit: 2,
          redemptionPolicyVersion: 'package-redeem-v1', refundPolicyVersion: 'package-refund-v1',
        })],
      }),
    }))
    await app.close()
  })

  it('lets the activity operator pause a published package without granting activity publication', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/staff/activity-operations/community-activity-001/packages/activity-package-001/pause',
      headers: { 'idempotency-key': 'activity-package-pause-key-001' },
      payload: { reason: '套餐物料补货中' },
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.setPackageAvailability).toHaveBeenCalledWith(context, {
      activityPublicId: 'community-activity-001', packagePublicId: 'activity-package-001',
      operation: 'pause', reason: '套餐物料补货中', idempotencyKey: 'activity-package-pause-key-001',
    })
    await app.close()
  })

  it('publishes through the canonical activity operations entrance', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const publisher = { publishActivity: vi.fn(async () => ({
      value: { publicId: 'community-activity-001', status: 'published' }, replayed: false,
    })) }
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    }, undefined, publisher)
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations/community-activity-001/publish',
      headers: { 'idempotency-key': 'activity-publish-key-001' }, payload: {},
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.publish'])
    expect(publisher.publishActivity).toHaveBeenCalledWith(context, {
      publicId: 'community-activity-001', idempotencyKey: 'activity-publish-key-001',
    })
    await app.close()
  })

  it('can only bring an existing waitlist task forward; it cannot confirm a registration', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    service.retryWaitlistPromotion.mockResolvedValueOnce({
      value: { activityPublicId: 'community-activity-001', state: 'queued', nextAttemptAt: '2026-08-22T00:00:00.000Z' },
      replayed: false,
    })
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST', url: '/staff/activity-operations/community-activity-001/waitlist-retry',
      headers: { 'idempotency-key': 'activity-waitlist-retry-key-001' },
      payload: { reason: '核对候补任务运行状态' },
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.retryWaitlistPromotion).toHaveBeenCalledWith(context, {
      publicId: 'community-activity-001', reason: '核对候补任务运行状态',
      idempotencyKey: 'activity-waitlist-retry-key-001',
    })
    expect(service.transitionRegistration).not.toHaveBeenCalled()
    await app.close()
  })

  it('requires both manager activity authority and refund request authority for paid cancellation', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const requestRefund = vi.fn(async () => ({ value: { id: 'refund-id', status: 'requested' }, replayed: false }))
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    }, requestRefund)
    const response = await app.inject({
      method: 'POST',
      url: '/staff/activity-operations/registrations/activity-registration-001/refund-request',
      headers: { 'idempotency-key': 'activity-refund-request-key-001' },
      payload: { reason: '顾客明确取消，按公示规则申请退款' },
    })
    expect(response.statusCode).toBe(201)
    expect(permissions).toEqual(['community.activity.manage','refund.request'])
    expect(requestRefund).toHaveBeenCalledWith(context, {
      registrationPublicId: 'activity-registration-001',
      reason: '顾客明确取消，按公示规则申请退款',
      idempotencyKey: 'activity-refund-request-key-001',
    })
    await app.close()
  })

  it('fails closed when a cashier-only or manager-only permission set is incomplete', async () => {
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => {
        if (permission === 'refund.request') throw new StaffAccessDeniedError(permission)
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/staff/activity-operations/registrations/activity-registration-001/refund-request',
      headers: { 'idempotency-key': 'activity-refund-request-key-002' },
      payload: { reason: '顾客申请取消活动' },
    })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('rejects the dead unversioned activity points field and does not call draft mutation', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'PUT',
      url: '/staff/activity-operations/community-activity-001/draft',
      headers: { 'idempotency-key': 'activity-draft-update-key-001' },
      payload: { ...validDraft(), pointsReward: 100 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('当前停用')
    expect(service.updateDraft).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns the explicit published commitment boundary without rewriting it', async () => {
    const service = serviceMock()
    service.updateDraft.mockRejectedValueOnce(new ActivityOperationsError(
      '活动发布后不可静默修改', 'PUBLISHED_ACTIVITY_IMMUTABLE', 409,
    ))
    const app = await application(service)
    const response = await app.inject({
      method: 'PUT',
      url: '/staff/activity-operations/community-activity-001/draft',
      headers: { 'idempotency-key': 'activity-draft-update-key-002' },
      payload: validDraft(),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PUBLISHED_ACTIVITY_IMMUTABLE')
    await app.close()
  })
})

function serviceMock() {
  return {
    list: vi.fn(async () => []),
    componentCatalog: vi.fn(async () => []),
    detail: vi.fn(async () => ({ activity: {}, registrations: [] })),
    createDraft: vi.fn(async () => ({ value: { publicId: 'community-activity-new', status: 'draft' }, replayed: false })),
    updateDraft: vi.fn(async () => ({ value: {}, replayed: false })),
    transitionRegistration: vi.fn(async () => ({ value: { status: 'checked_in' }, replayed: false })),
    setPackageAvailability: vi.fn(async () => ({ value: { status: 'published' }, replayed: false })),
    retryWaitlistPromotion: vi.fn(async () => ({ value: { state: 'not_required' }, replayed: false })),
  }
}

async function application(
  service = serviceMock(),
  access = { assertPermission: async () => undefined },
  requestRefund = vi.fn(async () => ({ value: { id: 'refund-id', status: 'requested' }, replayed: false })),
  publisher = { publishActivity: vi.fn(async () => ({ value: { status: 'published' }, replayed: false })) },
  resolveStaffContext = () => context,
) {
  const app = Fastify()
  await app.register(activityOperationsApiPlugin, {
    transactions: { run: async (_scope, callback) => callback({ scope } as never) },
    service: service as never,
    activityPublisher: publisher as never,
    activityPayments: { requestRefund } as never,
    resolveStaffContext,
    createStaffAccessRepository: () => access,
  })
  return app
}

function validDraft() {
  return {
    kind: 'member_night', title: '会员音乐夜', summary: '本周会员音乐夜', coverUrl: null,
    startsAt: '2026-08-20T11:00:00.000Z', endsAt: '2026-08-20T14:00:00.000Z',
    assemblyLocation: 'M-BOX陆家嘴店', capacity: 30, feeAmountMinor: 0, depositAmountMinor: 0,
    feeBasis: 'per_registration', paymentMode: 'none', paymentDeadlineMinutes: 15,
    paymentRuleText: '本活动无需预付', pointsReward: 0, visibility: 'public',
    audienceMemberLevels: [], audienceLifecycleStages: [], safetyPolicyVersion: 'activity-safety-v1',
    safetyAcknowledgementText: '我已阅读并同意安全要求', safetyRequirements: ['须年满18周岁'],
    refundPolicyVersion: 'activity-refund-v1', refundPolicySummary: '免费活动可在开始前取消',
    activityDetails: '现场音乐、交流与限定饮品体验。', includedItems: ['欢迎饮品'],
    participationRequirements: ['请提前15分钟到场'], contactInstructions: '报名成功后在小程序查看集合通知',
    memberBenefitText: '会员获赠限定徽章', reason: '补充本周活动安排',
  }
}

function validPackageDraft() {
  return {
    name: '限定饮品加购', description: '一杯限定鸡尾酒', imageUrl: null, includedItems: ['限定鸡尾酒'],
    capacity: 20, memberPurchaseLimit: 2, feeAmountMinor: 2_800, depositAmountMinor: 0,
    feeBasis: 'per_registration', paymentMode: 'full_required', paymentDeadlineMinutes: 15,
    paymentRuleText: '需全额支付加购费用', redemptionPolicyVersion: 'package-redeem-v1',
    refundPolicyVersion: 'package-refund-v1', sortOrder: 0, availableFrom: null, availableUntil: null,
    components: [],
  }
}
