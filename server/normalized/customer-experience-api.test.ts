import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { customerExperienceApiPlugin } from './customer-experience-api.js'
import type { CustomerExperienceService } from './customer-experience-service.js'
import type { ActivityPaymentService } from './activity-payment-service.js'
import type { MembershipRecoveryService } from './membership-recovery-service.js'
import type { MembershipTermsService } from './membership-terms-service.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { readRequestToken } from './normalized-request-context.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

describe('customer experience activity contact API', () => {
  it('returns a non-cacheable scannable member identification code in the mini-program bootstrap', async () => {
    const portal = vi.fn(async () => ({
      features: [], membership: { memberNo: 'MBX-35648', level: 'silver' }, points: [], growth: [],
      processing: [], preferences: {}, content: [], activities: [], benefits: [], annualBenefitCalendar: [],
      membershipTerms: null, supportContact: null, updatedAt: '2026-08-25T04:00:00.000Z',
      responseVersion: 'portal-member-code-test',
    }))
    const app = publicExperienceFixture({ portal })
    const response = await app.inject({ method: 'GET', url: '/public/mini/bootstrap' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('private')
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.json()).toMatchObject({ data: { membership: {
      memberNo: 'MBX-35648', memberCodeQrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    } } })
  })

  it('retires the legacy activity writer so the operations workbench is the only activity entry', async () => {
    const app = recoveryFixture({ start: vi.fn(), verify: vi.fn() })
    const response = await app.inject({
      method: 'POST', url: '/staff/community-activities',
      headers: { 'idempotency-key': 'legacy-activity-entry-0001' }, payload: {},
    })
    expect(response.statusCode).toBe(404)
  })

  it('keeps redemption creation bound to both named sessions when table authority is present', async () => {
    const createRedemption = vi.fn(async (_context, input) => ({
      replayed: false, value: { publicId: 'redemption-dual-session', tableAuthority: input.tableAuthority },
    }))
    const app = redemptionSessionFixture(createRedemption)
    const response = await app.inject({
      method: 'POST', url: '/public/mini/redemptions',
      headers: {
        cookie: 'mbox_reservation_session=reservation-session-token-00000001; __Host-mbox_guest_session=guest-session-token-0000000000001',
        'idempotency-key': 'redemption-dual-session-0001',
      },
      payload: { catalogItemPublicId: 'catalog-item-dual-session' },
    })

    expect(response.statusCode).toBe(201)
    expect(createRedemption).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tableAuthority: {
        tableSessionId: '82000000-0000-4000-8000-000000000010',
        customerId: '82000000-0000-4000-8000-000000000003',
        actorRef: 'guest:dual-session',
      },
    }))
  })

  it('does not infer table authority from the reservation session alone', async () => {
    const createRedemption = vi.fn(async (_context, input) => ({
      replayed: false, value: { publicId: 'redemption-reservation-only', tableAuthority: input.tableAuthority },
    }))
    const app = redemptionSessionFixture(createRedemption)
    const response = await app.inject({
      method: 'POST', url: '/public/mini/redemptions',
      headers: {
        cookie: 'mbox_reservation_session=reservation-session-token-00000001',
        'idempotency-key': 'redemption-reservation-only-0001',
      },
      payload: { catalogItemPublicId: 'catalog-item-reservation-only' },
    })

    expect(response.statusCode).toBe(201)
    expect(createRedemption).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tableAuthority: null }))
  })

  it('returns the safe loyalty ledger contract with customer-facing processing progress', async () => {
    const loyalty = vi.fn(async () => ({
      membership: null,
      points: [{
        id: 'point-public-test', entryType: 'earn', pointsDelta: 10, balanceAfter: 10,
        sourceKind: 'order', sourceReference: 'ORDER-PUBLIC-001',
        description: '已按付款订单和锁定规则入账',
        availableAt: '2026-08-16T12:00:00.000Z', expiresAt: null,
        policyVersion: 2, occurredAt: '2026-08-16T12:00:00.000Z',
      }],
      growth: [],
      processing: [{
        key: 'accrual:ORDER-PUBLIC-002', kind: 'accrual', state: 'manual_review',
        title: '积分正在人工核对', message: '门店正在核对付款、退款和规则。',
        sourceReference: 'ORDER-PUBLIC-002', occurredAt: '2026-08-16T12:05:00.000Z',
        updatedAt: '2026-08-16T12:10:00.000Z', active: true,
      }],
    }))
    const app = loyaltyFixture(loyalty)
    const response = await app.inject({ method: 'GET', url: '/public/mini/loyalty/ledger' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: {
      points: expect.arrayContaining([expect.objectContaining({
        sourceKind: 'order', sourceReference: 'ORDER-PUBLIC-001',
        description: '已按付款订单和锁定规则入账',
      })]),
      growth: [],
      processing: expect.arrayContaining([expect.objectContaining({
        state: 'manual_review', active: true,
      })]),
    } })
    expect(response.body).not.toContain('reason')
    expect(response.body).not.toContain('workerId')
    expect(response.body).not.toContain('employeeId')
    expect(loyalty).toHaveBeenCalledTimes(1)
  })

  it('converts the current mini-program contact shape into a protected strict snapshot', async () => {
    const rawContact = '13800138000'
    const registerActivity = vi.fn(async (_context, _input) => ({
      replayed: false,
      value: {
        publicId: 'activity-registration-api-test', status: 'confirmed', paymentRequired: false,
        paymentChoice: 'none', totalFeeAmountMinor: 0, amountDueMinor: 0,
        remainingAmountMinor: 0, paymentDueAt: null, seatHoldExpiresAt: null,
        currency: 'CNY', paymentRuleText: '本活动无需预付',
      },
    }))
    const app = fixture(registerActivity, rawContact)
    const response = await app.inject({
      method: 'POST',
      url: '/public/mini/activities/community-activity-api-test/registrations',
      headers: { 'idempotency-key': 'activity-registration-api-idempotency' },
      payload: {
        partySize: 2,
        contactSnapshot: { channel: 'miniprogram', contact: rawContact },
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none',
      },
    })

    expect(response.statusCode).toBe(201)
    const submitted = registerActivity.mock.calls[0]?.[1].protectedContact
    expect(submitted).toMatchObject({
      contactType: 'phone', contactHash: 'a'.repeat(64), encryptionKeyId: 'test-key-v1',
      maskedContact: '138****8000', source: 'mini_program',
    })
    expect(JSON.stringify(submitted)).not.toContain(rawContact)
    expect(registerActivity.mock.calls[0]?.[1]).not.toHaveProperty('contactSnapshot')
    expect(registerActivity.mock.calls[0]?.[1]).toMatchObject({
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-v1',
      acknowledgedRefundPolicyVersion: 'refund-v1',
    })
  })

  it('rejects the legacy free-form acknowledgement contract', async () => {
    const registerActivity = vi.fn()
    const app = fixture(registerActivity, '13800138000')
    const response = await app.inject({
      method: 'POST',
      url: '/public/mini/activities/community-activity-api-test/registrations',
      headers: { 'idempotency-key': 'activity-registration-api-legacy-terms' },
      payload: {
        partySize: 2,
        contactSnapshot: { channel: 'miniprogram', contact: '13800138000' },
        safetyAcknowledgement: { acknowledged: true, policyVersion: 'safety-v1' },
        paymentChoice: 'none',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(registerActivity).not.toHaveBeenCalled()
  })

  it('rejects arbitrary contact keys before invoking the activity service', async () => {
    const registerActivity = vi.fn()
    const app = fixture(registerActivity, '13800138000')
    const response = await app.inject({
      method: 'POST',
      url: '/public/mini/activities/community-activity-api-test/registrations',
      headers: { 'idempotency-key': 'activity-registration-api-invalid' },
      payload: {
        partySize: 2,
        contactSnapshot: { channel: 'miniprogram', contact: '13800138000', internalNote: '不应保存' },
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: 'safety-v1',
        acknowledgedRefundPolicyVersion: 'refund-v1',
        paymentChoice: 'none',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'ACTIVITY_CONTACT_INVALID' } })
    expect(registerActivity).not.toHaveBeenCalled()
  })

  it('reports a contact-protection provider failure safely without creating a registration', async () => {
    const registerActivity = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = fixture(registerActivity, '13800138000', undefined, () => {
      throw new Error('key material unavailable: secret-value-must-not-leak')
    })

    const response = await registerActivityRequest(app)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: {
      code: 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE',
      message: '报名服务配置异常，请稍后再试',
    } })
    expect(response.body).not.toContain('secret-value-must-not-leak')
    expect(response.body).not.toContain('13800138000')
    expect(registerActivity).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('ACTIVITY_CONTACT_PROTECTION_FAILED', {
      reason: 'provider_threw',
    })
  })

  it('rejects an invalid contact-protection result without creating a registration', async () => {
    const registerActivity = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = fixture(registerActivity, '13800138000', undefined, () => ({
      hash: 'not-a-hash', encryptedBase64: 'too-short', keyId: 'x', masked: 'x',
    }))

    const response = await registerActivityRequest(app)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE' } })
    expect(registerActivity).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('ACTIVITY_CONTACT_PROTECTION_FAILED', {
      reason: 'provider_output_invalid',
    })
  })

  it.each([
    [new IdempotencyConflictError('community.activity.register', 'activity-registration-api-idempotency'), 409, 'ACTIVITY_REGISTRATION_IDEMPOTENCY_CONFLICT'],
    [new IdempotencyInProgressError('community.activity.register', 'activity-registration-api-idempotency'), 425, 'ACTIVITY_REGISTRATION_IN_PROGRESS'],
    [new IdempotencyRecordError('store internal idempotency data is unavailable'), 503, 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED'],
    [new Error('database diagnostic that must not reach a customer'), 503, 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED'],
  ])('maps registration command failures to their safe customer contract', async (failure, expectedStatus, expectedCode) => {
    const registerActivity = vi.fn(async () => { throw failure })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = fixture(registerActivity, '13800138000')

    const response = await registerActivityRequest(app)

    expect(response.statusCode).toBe(expectedStatus)
    expect(response.json()).toMatchObject({ error: { code: expectedCode } })
    expect(response.body).not.toContain(failure.message)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(failure.message)
    if (expectedStatus === 503) {
      expect(errorSpy).toHaveBeenCalledWith('ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED', {
        kind: failure instanceof IdempotencyRecordError ? 'idempotency_record' : 'unexpected',
      })
    } else {
      expect(errorSpy).not.toHaveBeenCalled()
    }
  })

  it('marks the customer activity-registration list private and non-cacheable', async () => {
    const activityRegistrations = vi.fn(async () => [{
      publicId: 'activity-registration-1234567890abcdef12345678',
      activityTitle: '周末音乐活动', status: 'confirmed',
      maskedContact: '138****8000', contactVersionPublicId: `ACV${'A'.repeat(32)}`,
    }])
    const app = activityRegistrationsFixture(activityRegistrations)
    const response = await app.inject({ method: 'GET', url: '/public/mini/activity-registrations' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('private')
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.body).toContain('138****8000')
    expect(response.body).not.toMatch(/contactHash|encryptedContact|encryptionKeyId|customerId/)
  })

  it('exposes the fixed activity payment read, action and query contracts', async () => {
    const state = {
      registrationPublicId: 'activity-registration-api-test',
      paymentPublicId: 'activity-payment-api-test',
      resolutionState: 'unknown', paymentStatus: 'pending', amountDueMinor: 2000,
      paidAmountMinor: 0, currency: 'CNY', expiresAt: '2026-08-16T12:00:00.000Z',
      allowedActions: ['query_payment'], refundStatus: null,
    } as const
    const get = vi.fn(async () => state)
    const createAction = vi.fn(async () => ({
      payment: { ...state, resolutionState: 'pending', allowedActions: ['query_payment'] },
      providerAction: {
        paymentPublicId: state.paymentPublicId, status: 'pending', presentation: 'jsapi',
        expiresAt: state.expiresAt,
        payload: { timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=1', signType: 'RSA', paySign: 'signature' },
      },
    }))
    const query = vi.fn(async () => ({ ...state, resolutionState: 'confirmed', allowedActions: [] }))
    const app = fixture(vi.fn(), '13800138000', { get, createAction, query })

    const read = await app.inject({
      method: 'GET', url: `/public/mini/activity-registrations/${state.registrationPublicId}/payment`,
    })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ data: state })

    const action = await app.inject({
      method: 'POST', url: `/public/mini/activity-registrations/${state.registrationPublicId}/payment-action`,
      headers: { 'idempotency-key': 'activity-payment-action-api-0001' },
    })
    expect(action.statusCode).toBe(200)
    expect(createAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      registrationPublicId: state.registrationPublicId,
      idempotencyKey: 'activity-payment-action-api-0001',
    }))
    expect(action.json().data.providerAction.payload).toEqual({
      timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=1', signType: 'RSA', paySign: 'signature',
    })

    const queried = await app.inject({
      method: 'POST', url: `/public/mini/activity-registrations/${state.registrationPublicId}/payment-query`,
      headers: { 'idempotency-key': 'activity-payment-query-api-0001' },
    })
    expect(queried.statusCode).toBe(200)
    expect(queried.json().data).toMatchObject({ resolutionState: 'confirmed', allowedActions: [] })
  })

  it('exposes recent confirmed observations through the table-scoped read contract', async () => {
    const tableSessionId = '82000000-0000-4000-8000-000000000010'
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockResolvedValue({
      employeeId: '82000000-0000-4000-8000-000000000003', employeeCode: 'SERVER1', displayName: '服务员A',
      roleCodes: ['SERVER'], roleNames: ['服务员'], permissions: ['observation.record'], deniedPermissions: [],
      dataScopes: [], approvalLimits: [], navigation: [], resolvedAt: '2026-08-16T12:00:00.000Z',
    })
    const recentObservations = vi.fn(async () => ({
      items: [], permissions: { canCorrect: false, canViewRaw: false },
    }))
    const app = staffObservationFixture(recentObservations)
    const response = await app.inject({
      method: 'GET', url: `/staff/table-sessions/${tableSessionId}/observations/recent`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: { items: [], permissions: { canCorrect: false, canViewRaw: false } } })
    expect(recentObservations).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: '82000000-0000-4000-8000-000000000003',
    }), { tableSessionId, limit: 5 })
  })

  it('uses separate approval and highest-publication contracts for loyalty rules', async () => {
    const checkedPermissions: string[] = []
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      return {} as never
    })
    const value = { id: '82000000-0000-4000-8000-000000000020', version: 2, status: 'approved' }
    const approveLoyaltyPolicy = vi.fn(async () => ({ value, replayed: false }))
    const publishLoyaltyPolicy = vi.fn(async () => ({ value: { ...value, status: 'published' }, replayed: false }))
    const approveLoyaltyTierPolicy = vi.fn(async () => ({ value, replayed: false }))
    const publishLoyaltyTierPolicy = vi.fn(async () => ({ value: { ...value, status: 'published' }, replayed: false }))
    const approveRedemptionCatalog = vi.fn(async () => ({ value: { ...value, itemCount: 1 }, replayed: false }))
    const publishRedemptionCatalog = vi.fn(async () => ({ value: { ...value, status: 'published', itemCount: 1 }, replayed: false }))
    const app = staffReleaseFixture({
      approveLoyaltyPolicy, publishLoyaltyPolicy,
      approveLoyaltyTierPolicy, publishLoyaltyTierPolicy,
      approveRedemptionCatalog, publishRedemptionCatalog,
    })
    const policyId = value.id
    const calls = [
      app.inject({ method: 'POST', url: `/staff/loyalty/policies/${policyId}/approve`,
        headers: { 'idempotency-key': 'policy-approval-contract-0001' }, payload: { reason: '独立审批通过' } }),
      app.inject({ method: 'POST', url: `/staff/loyalty/policies/${policyId}/publish`,
        headers: { 'idempotency-key': 'policy-publish-contract-0001' },
        payload: { effectiveFrom: '2026-08-20T00:00:00Z', reason: '最高权限正式发布' } }),
      app.inject({ method: 'POST', url: `/staff/loyalty/tier-policies/${policyId}/approve`,
        headers: { 'idempotency-key': 'tier-approval-contract-0001' },
        payload: { impactPreviewAcknowledged: true, reason: '影响复核通过' } }),
      app.inject({ method: 'POST', url: `/staff/loyalty/tier-policies/${policyId}/publish`,
        headers: { 'idempotency-key': 'tier-publish-contract-0001' },
        payload: { effectiveFrom: '2026-08-20T00:00:00Z', reason: '最高权限正式发布' } }),
      app.inject({ method: 'POST', url: `/staff/loyalty/redemption-catalogs/${policyId}/approve`,
        headers: { 'idempotency-key': 'catalog-approval-contract-0001' },
        payload: { costAndFulfillmentReviewed: true, reason: '成本履约复核通过' } }),
      app.inject({ method: 'POST', url: `/staff/loyalty/redemption-catalogs/${policyId}/publish`,
        headers: { 'idempotency-key': 'catalog-publish-contract-0001' },
        payload: { effectiveFrom: '2026-08-20T00:00:00Z', reason: '最高权限正式发布' } }),
    ]
    const responses = await Promise.all(calls)
    expect(responses.map((response) => response.statusCode)).toEqual([409, 200, 409, 200, 409, 200])
    expect(responses.filter((_response,index)=>index%2===0).every((response)=>(
      response.json().error.code==='MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED'
    ))).toBe(true)
    expect(checkedPermissions).toEqual([
      'loyalty.policy.approve', 'loyalty.policy.publish',
      'loyalty.policy.approve', 'loyalty.policy.publish',
      'loyalty.redemption.catalog.approve', 'loyalty.redemption.catalog.publish',
    ])
    expect(approveLoyaltyPolicy).not.toHaveBeenCalled()
    expect(approveLoyaltyTierPolicy).not.toHaveBeenCalled()
    expect(publishLoyaltyTierPolicy).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({
      impactPreviewAcknowledged: expect.anything(),
    }))
    expect(approveRedemptionCatalog).not.toHaveBeenCalled()
  })

  it('requires the redemption exception permission and an explicit unfulfilled confirmation', async () => {
    const checkedPermissions: string[] = []
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      return {} as never
    })
    const failRedemption = vi.fn(async () => ({
      replayed: false,
      value: {
        publicId: 'redemption-api-failure-0001', status: 'failed',
        failureCode: 'product_unavailable', recoveryState: 'restored', pointsRestored: 600,
      },
    }))
    const app = staffReleaseFixture({ failRedemption })
    const response = await app.inject({
      method: 'POST', url: '/staff/loyalty/redemptions/redemption-api-failure-0001/fail',
      headers: { 'idempotency-key': 'redemption-api-failure-command-0001' },
      payload: {
        failureCode: 'product_unavailable', reason: '现场确认缺货且顾客尚未收到商品',
        confirmedUnfulfilled: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(checkedPermissions).toEqual(['loyalty.redemption.exception'])
    expect(failRedemption).toHaveBeenCalledWith(expect.anything(), {
      publicId: 'redemption-api-failure-0001', failureCode: 'product_unavailable',
      reason: '现场确认缺货且顾客尚未收到商品', confirmedUnfulfilled: true,
      idempotencyKey: 'redemption-api-failure-command-0001',
    })

    const invalid = await app.inject({
      method: 'POST', url: '/staff/loyalty/redemptions/redemption-api-failure-0001/fail',
      headers: { 'idempotency-key': 'redemption-api-failure-command-0002' },
      payload: { failureCode: 'product_unavailable', reason: '没有确认' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(failRedemption).toHaveBeenCalledTimes(1)
  })

  it('lets a fulfillment-only employee read pending redemptions without policy-view permission', async () => {
    const checkedPermissions: string[] = []
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      if (permission !== 'loyalty.redemption.fulfill') throw new StaffAccessDeniedError(permission)
      return {} as never
    })
    const pendingRedemptions = vi.fn(async () => [{
      publicId: 'redemption-pending-api-0001', memberNo: 'MBX-35648', itemName: '会员赠饮',
      pointsUsed: 600, fulfillmentKind: 'product', status: 'awaiting_fulfillment',
      expiresAt: '2026-08-24T18:00:00.000Z', createdAt: '2026-08-24T12:00:00.000Z',
      failureCode: null, recoveryState: 'not_required', recoveryRequestedAt: null, pointsRestored: 0,
    }])
    const app = staffReleaseFixture({ pendingRedemptions })

    const response = await app.inject({ method: 'GET', url: '/staff/loyalty/redemptions/pending' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{ memberNo: 'MBX-35648', itemName: '会员赠饮' }] })
    expect(checkedPermissions).toEqual(['loyalty.redemption.fulfill'])
    expect(pendingRedemptions).toHaveBeenCalledTimes(1)
  })

  it('uses only the dedicated WeChat phone authorization port for membership recovery', async () => {
    const start = vi.fn(async () => ({
      challengePublicId: 'MRC00000000000000000000000000000001',
      status: 'awaiting_verification', message: '请授权', expiresAt: '2026-08-16T12:10:00.000Z',
    }))
    const verify = vi.fn(async () => ({
      challengePublicId: 'MRC00000000000000000000000000000001',
      status: 'manual_review', message: '发现多个可能账户，已转人工核验；系统不会自动合并或展示账户信息。',
      expiresAt: '2026-08-16T12:10:00.000Z',
    }))
    const verifyPhone = vi.fn(async () => ({
      e164Phone: '+8613800138000', providerReference: 'wechat-phone-event-0001',
      verifiedAt: '2026-08-16T12:00:00.000Z',
    }))
    const app = recoveryFixture({ start, verify }, verifyPhone)
    const started = await app.inject({
      method: 'POST', url: '/public/mini/membership/recovery/start',
      headers: { 'idempotency-key': 'membership-recovery-start-api-0001' },
    })
    expect(started.statusCode).toBe(201)
    const response = await app.inject({
      method: 'POST', url: '/public/mini/membership/recovery/verify',
      headers: { 'idempotency-key': 'membership-recovery-verify-api-0001' },
      payload: {
        challengePublicId: 'MRC00000000000000000000000000000001',
        phoneAuthorizationCode: 'wechat-phone-code-one-use-0001',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(verifyPhone).toHaveBeenCalledWith({
      authorizationCode: 'wechat-phone-code-one-use-0001',
      customerId: '82000000-0000-4000-8000-000000000003',
    })
    expect(verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      challengePublicId: 'MRC00000000000000000000000000000001',
      verifiedPhone: expect.objectContaining({ providerReference: 'wechat-phone-event-0001' }),
    }))
    expect(JSON.stringify(response.json())).not.toMatch(/13800138000|memberNo|points|candidate/i)
  })

  it('requires the typed current membership terms contract for public enrollment', async () => {
    const enrollMembership = vi.fn(async () => ({
      value: { membership: { memberNo: 'MBX-TEST' }, created: true }, replayed: false,
    }))
    const app = membershipTermsFixture({} as MembershipTermsService, enrollMembership)
    const legacy = await app.inject({
      method: 'POST', url: '/public/mini/membership/enroll',
      headers: { 'idempotency-key': 'membership-enroll-legacy-client-0001' },
      payload: { termsVersion: 3, acknowledgementSource: 'mini_menu' },
    })
    expect(legacy.statusCode).toBe(426)
    expect(legacy.headers['cache-control']).toContain('no-store')
    expect(enrollMembership).not.toHaveBeenCalled()
    const missing = await app.inject({
      method: 'POST', url: '/public/mini/membership/enroll-with-phone',
      headers: { 'idempotency-key': 'membership-enroll-missing-terms-0001' }, payload: {},
    })
    expect(missing.statusCode).toBe(400)
    expect(enrollMembership).not.toHaveBeenCalled()
    const accepted = await app.inject({
      method: 'POST', url: '/public/mini/membership/enroll-with-phone',
      headers: { 'idempotency-key': 'membership-enroll-typed-terms-0001' },
      payload: {
        termsVersion: 3,
        acknowledgementSource: 'mini_menu',
        phoneAuthorizationCode: 'wechat-phone-code-enroll-0001',
      },
    })
    expect(accepted.statusCode).toBe(201)
    expect(accepted.headers['cache-control']).toContain('no-store')
    expect(enrollMembership).toHaveBeenCalledWith(expect.anything(), {
      termsVersion: 3, acknowledgementSource: 'mini_menu',
      phoneAuthorizationCode: 'wechat-phone-code-enroll-0001',
      idempotencyKey: 'membership-enroll-typed-terms-0001',
    })
    const community = await app.inject({
      method: 'POST', url: '/public/mini/membership/enroll-with-phone',
      headers: { 'idempotency-key': 'membership-enroll-community-0001' },
      payload: {
        termsVersion: 3,
        acknowledgementSource: 'mini_community',
        phoneAuthorizationCode: 'wechat-phone-code-community-0001',
      },
    })
    expect(community.statusCode).toBe(201)
    expect(enrollMembership).toHaveBeenLastCalledWith(expect.anything(), {
      termsVersion: 3, acknowledgementSource: 'mini_community',
      phoneAuthorizationCode: 'wechat-phone-code-community-0001',
      idempotencyKey: 'membership-enroll-community-0001',
    })
  })

  it('separates membership terms view, draft, approval and publication permissions', async () => {
    const checkedPermissions: string[] = []
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      return {} as never
    })
    const version = {
      publicId: 'MTV00000000000000000000000000000001', version: 1,
      status: 'draft', title: 'M-BOX入会条款', summary: '会员积分与权益说明',
      content: '加入后可以累计积分并查看门店发放的权益。', effectiveFrom: null,
      effectiveUntil: null, draftedByEmployeeId: '82000000-0000-4000-8000-000000000003',
      approvedByEmployeeId: null, publishedByEmployeeId: null, createdAt: '2026-08-16T12:00:00Z',
    }
    const terms = {
      list: vi.fn(async () => [version]),
      createDraft: vi.fn(async () => ({ value: version, replayed: false })),
      approve: vi.fn(async () => ({
        value: { ...version, status: 'approved', approvedByEmployeeId: 'approver' }, replayed: false,
      })),
      publish: vi.fn(async () => ({
        value: { ...version, status: 'published', publishedByEmployeeId: 'publisher' }, replayed: false,
      })),
    }
    const app = membershipTermsFixture(terms as unknown as MembershipTermsService, vi.fn())
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/staff/membership-terms' }),
      app.inject({ method: 'POST', url: '/staff/membership-terms/drafts',
        headers: { 'idempotency-key': 'membership-terms-draft-api-0001' },
        payload: { title: version.title, summary: version.summary, content: version.content, reason: '首次建立正式条款' } }),
      app.inject({ method: 'POST', url: '/staff/membership-terms/1/approve',
        headers: { 'idempotency-key': 'membership-terms-approve-api-0001' }, payload: { reason: '独立审批通过' } }),
      app.inject({ method: 'POST', url: '/staff/membership-terms/1/publish',
        headers: { 'idempotency-key': 'membership-terms-publish-api-0001' },
        payload: { effectiveFrom: '2026-08-20T00:00:00Z', reason: '最高权限排期发布' } }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual([200,201,409,200])
    expect(responses[2]?.json().error.code).toBe('MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED')
    expect(terms.approve).not.toHaveBeenCalled()
    expect(checkedPermissions).toEqual([
      'membership.terms.view','membership.terms.manage',
      'membership.terms.approve','membership.terms.publish',
    ])
    expect(terms.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      version: 1, effectiveFrom: '2026-08-20T00:00:00.000Z',
    }))
  })

  it('keeps customer-visible staff names and privacy policies inside independent publication permissions', async () => {
    const checkedPermissions: string[] = []
    vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      return {} as never
    })
    const profileId = '82000000-0000-4000-8000-000000000020'
    const employeeId = '82000000-0000-4000-8000-000000000021'
    const profile = { id: profileId, employeeId, publicDisplayName: '小林', status: 'draft' as const }
    const privacy = {
      id: '82000000-0000-4000-8000-000000000022', policyVersion: 'PIPL.2026.08',
      contentSha256: 'a'.repeat(64), status: 'draft' as const,
    }
    const listCustomerPublicationEmployees = vi.fn(async () => [{
      id: employeeId, employeeCode: 'EMP-001', displayName: '林晓',
    }])
    const listCustomerPublicProfiles = vi.fn(async () => [profile])
    const draftCustomerPublicProfile = vi.fn(async () => ({ value: profile, replayed: false }))
    const publishCustomerPublicProfile = vi.fn(async () => ({
      value: { ...profile, status: 'published' as const, effectiveAt: '2026-08-24T00:00:00.000Z' }, replayed: false,
    }))
    const withdrawCustomerPublicProfile = vi.fn(async () => ({
      value: { id: profileId, status: 'withdrawn' as const, withdrawnAt: '2026-08-24T01:00:00.000Z' }, replayed: false,
    }))
    const listPrivacyPolicyReleases = vi.fn(async () => [privacy])
    const draftPrivacyPolicy = vi.fn(async () => ({ value: privacy, replayed: false }))
    const publishPrivacyPolicy = vi.fn(async () => ({
      value: { ...privacy, status: 'published' as const, effectiveAt: '2026-08-24T00:00:00.000Z' }, replayed: false,
    }))
    const withdrawPrivacyPolicy = vi.fn(async () => ({
      value: { id: privacy.id, policyVersion: privacy.policyVersion, status: 'withdrawn' as const, withdrawnAt: '2026-08-24T01:00:00.000Z' }, replayed: false,
    }))
    const app = staffReleaseFixture({
      listCustomerPublicationEmployees, listCustomerPublicProfiles, draftCustomerPublicProfile, publishCustomerPublicProfile,
      withdrawCustomerPublicProfile, listPrivacyPolicyReleases, draftPrivacyPolicy, publishPrivacyPolicy,
      withdrawPrivacyPolicy,
    })
    const content = 'M-BOX 顾客隐私政策正式正文。'.repeat(8)

    expect((await app.inject({ method: 'GET', url: '/staff/customer-publication/employees' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/staff/customer-publication/profiles' })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'PUT', url: `/staff/customer-publication/profiles/${employeeId}/draft`,
      headers: { 'idempotency-key': 'customer-profile-draft-api-0001' },
      payload: { publicDisplayName: '小林', reason: '员工已确认顾客公开服务名' },
    })).statusCode).toBe(201)
    expect((await app.inject({
      method: 'POST', url: `/staff/customer-publication/profiles/${profileId}/publish`,
      headers: { 'idempotency-key': 'customer-profile-publish-api-0001' },
      payload: { approvalReference: 'HR-2026-0824-001', effectiveAt: '2026-08-24T00:00:00Z', reason: '人事复核完成' },
    })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'POST', url: `/staff/customer-publication/profiles/${profileId}/withdraw`,
      headers: { 'idempotency-key': 'customer-profile-withdraw-api-0001' },
      payload: { reason: '员工服务范围调整' },
    })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/staff/customer-publication/privacy-policies' })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'POST', url: '/staff/customer-publication/privacy-policies/drafts',
      headers: { 'idempotency-key': 'privacy-policy-draft-api-0001' },
      payload: {
        policyVersion: privacy.policyVersion, content, contentSha256: 'a'.repeat(64),
        operatorName: 'M-BOX 运营主体', contact: 'privacy@example.test',
        dataRetentionPolicyVersion: 'retention-v1', thirdPartyRegisterVersion: 'third-party-v1',
        reason: '录入法务提供的正式政策正文',
      },
    })).statusCode).toBe(201)
    expect((await app.inject({
      method: 'POST', url: `/staff/customer-publication/privacy-policies/${privacy.policyVersion}/publish`,
      headers: { 'idempotency-key': 'privacy-policy-publish-api-0001' },
      payload: {
        approvedBy: '法务复核人', approvalReference: 'LEGAL-2026-0824-001',
        effectiveAt: '2026-08-24T00:00:00Z', reason: '法务与运营复核完成',
      },
    })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'POST', url: `/staff/customer-publication/privacy-policies/${privacy.policyVersion}/withdraw`,
      headers: { 'idempotency-key': 'privacy-policy-withdraw-api-0001' },
      payload: { reason: '等待更新后的法务版本' },
    })).statusCode).toBe(200)

    expect(checkedPermissions).toEqual([
      'customer.public-profile.manage', 'customer.public-profile.manage', 'customer.public-profile.manage',
      'customer.public-profile.publish', 'customer.public-profile.publish',
      'privacy.policy.view', 'privacy.policy.manage', 'privacy.policy.publish', 'privacy.policy.publish',
    ])
    expect(listCustomerPublicationEmployees).toHaveBeenCalledTimes(1)
    expect(draftCustomerPublicProfile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ employeeId, publicDisplayName: '小林' }))
    expect(publishCustomerPublicProfile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvalReference: 'HR-2026-0824-001' }))
    expect(draftPrivacyPolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contentSha256: 'a'.repeat(64), content }))
    expect(publishPrivacyPolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvedBy: '法务复核人' }))
    expect(withdrawPrivacyPolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyVersion: privacy.policyVersion }))
  })

  it('keeps product restrictions customer-owned and performance phase writes permission-scoped', async () => {
    const restriction = {
      publicId: 'product-restriction-api-test',
      productId: '82000000-0000-4000-8000-000000000020',
      productName: '演出阶段套餐', restrictionType: 'dislike', createdAt: '2026-08-16T12:00:00Z',
    }
    const productRestrictions = vi.fn(async () => [restriction])
    const withdrawProductRestriction = vi.fn(async () => ({ value: restriction, replayed: false }))
    const publicApp = publicExperienceFixture({ productRestrictions, withdrawProductRestriction })
    const listed = await publicApp.inject({ method: 'GET', url: '/public/mini/product-restrictions' })
    const withdrawn = await publicApp.inject({
      method: 'POST', url: `/public/mini/product-restrictions/${restriction.publicId}/withdraw`,
      headers: { 'idempotency-key': 'product-restriction-withdraw-api-test' },
      payload: { reason: '顾客本人确认恢复推荐' },
    })
    expect(listed.statusCode).toBe(200)
    expect(withdrawn.statusCode).toBe(200)
    expect(withdrawProductRestriction).toHaveBeenCalledWith(expect.objectContaining({
      customerId: '82000000-0000-4000-8000-000000000004',
    }), {
      publicId: restriction.publicId, reason: '顾客本人确认恢复推荐',
      idempotencyKey: 'product-restriction-withdraw-api-test',
    })

    const checkedPermissions: string[] = []
    const access = vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async (_employeeId, permission) => {
      checkedPermissions.push(permission)
      return {} as never
    })
    const phase = {
      publicId: 'performance-phase-api-test', scheduleId: '82000000-0000-4000-8000-000000000030',
      performerStageName: '测试乐队', phaseCode: 'band_live', status: 'active',
      startedAt: '2026-08-16T12:00:00Z', endedAt: null, cancelledAt: null,
    }
    const performancePhases = vi.fn(async () => [phase])
    const productPerformancePhases = vi.fn(async () => ({
      productId: restriction.productId, phaseCodes: ['band_live'],
    }))
    const configureProductPerformancePhases = vi.fn(async () => ({
      value: { productId: restriction.productId, phaseCodes: ['band_live'] }, replayed: false,
    }))
    const startPerformancePhase = vi.fn(async () => ({ value: phase, replayed: false }))
    const transitionPerformancePhase = vi.fn(async () => ({
      value: { ...phase, status: 'ended', endedAt: '2026-08-16T13:00:00Z' }, replayed: false,
    }))
    const staffApp = staffReleaseFixture({
      performancePhases, productPerformancePhases, configureProductPerformancePhases,
      startPerformancePhase, transitionPerformancePhase,
    })
    const responses = await Promise.all([
      staffApp.inject({ method: 'GET', url: '/staff/customer-experience/performance-phases/current' }),
      staffApp.inject({ method: 'GET', url: `/staff/customer-experience/products/${restriction.productId}/performance-phases` }),
      staffApp.inject({
        method: 'PUT', url: `/staff/customer-experience/products/${restriction.productId}/performance-phases`,
        headers: { 'idempotency-key': 'performance-phase-configure-api-test' },
        payload: { phaseCodes: ['band_live'], reason: '仅在乐队现场推荐' },
      }),
      staffApp.inject({
        method: 'POST', url: `/staff/customer-experience/schedules/${phase.scheduleId}/performance-phases`,
        headers: { 'idempotency-key': 'performance-phase-start-api-test' },
        payload: { phaseCode: 'band_live', reason: '现场确认阶段开始' },
      }),
      staffApp.inject({
        method: 'POST', url: `/staff/customer-experience/performance-phases/${phase.publicId}/end`,
        headers: { 'idempotency-key': 'performance-phase-end-api-test' },
        payload: { reason: '现场确认阶段结束' },
      }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 201, 200])
    expect(checkedPermissions).toEqual([
      'song.view', 'recommendation.phase.configure', 'recommendation.phase.configure',
      'performance.phase.manage', 'performance.phase.manage',
    ])
    expect(productPerformancePhases).toHaveBeenCalledWith(expect.anything(), restriction.productId)
    expect(configureProductPerformancePhases).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      productId: restriction.productId, phaseCodes: ['band_live'],
    }))
    expect(startPerformancePhase).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scheduleId: phase.scheduleId, phaseCode: 'band_live',
    }))
    expect(transitionPerformancePhase).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      publicId: phase.publicId, action: 'end',
    }))

    access.mockRejectedValueOnce(new StaffAccessDeniedError('internal permission detail'))
    const denied = await staffApp.inject({
      method: 'PUT', url: `/staff/customer-experience/products/${restriction.productId}/performance-phases`,
      headers: { 'idempotency-key': 'performance-phase-configure-denied-api-test' },
      payload: { phaseCodes: [], reason: '取消阶段限制' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ error: { code: 'PERMISSION_DENIED', message: '当前岗位没有这项权限' } })
    expect(configureProductPerformancePhases).toHaveBeenCalledTimes(1)
  })

  it('fails closed before handling a phone code when the WeChat phone verifier is absent', async () => {
    const start = vi.fn()
    const verify = vi.fn()
    const app = recoveryFixture({ start, verify })
    const response = await app.inject({
      method: 'POST', url: '/public/mini/membership/recovery/verify',
      headers: { 'idempotency-key': 'membership-recovery-no-provider-0001' },
      payload: {
        challengePublicId: 'MRC00000000000000000000000000000001',
        phoneAuthorizationCode: 'untrusted-client-phone-code',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'MEMBERSHIP_RECOVERY_PHONE_NOT_CONFIGURED' } })
    expect(verify).not.toHaveBeenCalled()
  })

  it('replays a completed verification before attempting to consume the one-use WeChat code again', async () => {
    const start = vi.fn()
    const verify = vi.fn()
    const verifyPhone = vi.fn()
    const replay = vi.fn(async () => ({
      challengePublicId: 'MRC00000000000000000000000000000001',
      status: 'pending_review', message: '已进入人工复核。',
      expiresAt: '2026-08-16T12:10:00.000Z',
    }))
    const app = recoveryFixture({ start, verify }, verifyPhone, replay)
    const response = await app.inject({
      method: 'POST', url: '/public/mini/membership/recovery/verify',
      headers: { 'idempotency-key': 'membership-recovery-verify-api-replay-0001' },
      payload: { challengePublicId: 'MRC00000000000000000000000000000001' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { status: 'pending_review' }, meta: { replayed: true },
    })
    expect(replay).toHaveBeenCalledWith(expect.anything(), {
      challengePublicId: 'MRC00000000000000000000000000000001',
      idempotencyKey: 'membership-recovery-verify-api-replay-0001',
    })
    expect(verifyPhone).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('returns an explicit active verified-phone state without cacheable or internal evidence', async () => {
    const listMyVerifiedPhones = vi.fn(async () => [{
      publicId: `CVC${'A'.repeat(32)}`, maskedPhone: '+86138****8000', status: 'active' as const,
      verifiedAt: '2026-08-16T12:00:00.000Z', verificationSource: 'wechat_phone_authorization' as const,
    }])
    const app = recoveryFixture({ start: vi.fn(), verify: vi.fn(), listMyVerifiedPhones })
    const response = await app.inject({ method: 'GET', url: '/public/mini/membership/verified-phones' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.json()).toEqual({ data: [expect.objectContaining({ status: 'active' })] })
    expect(response.body).not.toMatch(/contactHash|encryptedValue|encryptionKeyId|customerId|employeeId/)
  })
})

function redemptionSessionFixture(createRedemption: ReturnType<typeof vi.fn>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  void app.register(customerExperienceApiPlugin, {
    transactions: {
      run: async (_scope, action) => action({
        scope,
        query: vi.fn(async () => ({ rows: [{ same_family: true }], rowCount: 1 })),
      } as never),
    },
    service: { createRedemption } as unknown as CustomerExperienceService,
    resolvePublicContext: (request) => ({
      scope,
      customerId: '82000000-0000-4000-8000-000000000003',
      actorRef: `customer:${readRequestToken(request, 'mbox_reservation_session')}`,
      businessDate: '2026-08-16',
    }),
    resolveGuestContext: async (request) => {
      readRequestToken(request, '__Host-mbox_guest_session')
      return {
        scope,
        customerId: '82000000-0000-4000-8000-000000000003',
        tableSessionId: '82000000-0000-4000-8000-000000000010',
        businessDate: '2026-08-16', actorRef: 'guest:dual-session',
      }
    },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: () => { throw new Error('not used') },
  })
  return app
}

function recoveryFixture(
  membershipRecovery: Pick<MembershipRecoveryService, 'start' | 'verify'>
    & Partial<Pick<MembershipRecoveryService, 'listMyVerifiedPhones'>>,
  verifyPhone?: ReturnType<typeof vi.fn>,
  verifiedReplay: ReturnType<typeof vi.fn> = vi.fn(async () => null),
): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const context = {
    scope: {
      tenantId: '82000000-0000-4000-8000-000000000001',
      storeId: '82000000-0000-4000-8000-000000000002',
    },
    customerId: '82000000-0000-4000-8000-000000000003',
    actorRef: 'customer:82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
  }
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async () => { throw new Error('not used') } },
    service: {} as CustomerExperienceService,
    resolvePublicContext: () => context,
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: () => { throw new Error('not used') },
    membershipRecovery: {
      ...membershipRecovery,
      verifiedReplay,
    } as MembershipRecoveryService,
    ...(verifyPhone === undefined ? {} : {
      recoveryPhoneAuthorization: { verify: verifyPhone },
    }),
  })
  return app
}

function activityRegistrationsFixture(activityRegistrations: ReturnType<typeof vi.fn>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async () => { throw new Error('not used') } },
    service: { activityRegistrations } as unknown as CustomerExperienceService,
    resolvePublicContext: () => ({
      scope: {
        tenantId: '82000000-0000-4000-8000-000000000001',
        storeId: '82000000-0000-4000-8000-000000000002',
      },
      customerId: '82000000-0000-4000-8000-000000000003',
      actorRef: 'customer:82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
    }),
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: () => { throw new Error('not used') },
  })
  return app
}

function membershipTermsFixture(
  membershipTerms: MembershipTermsService,
  enrollMembership: ReturnType<typeof vi.fn>,
): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  const context = {
    scope, customerId: '82000000-0000-4000-8000-000000000004',
    actorRef: 'customer:82000000-0000-4000-8000-000000000004', businessDate: '2026-08-16',
  }
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async (_scope, action) => action({ scope, query: vi.fn() } as never) },
    service: {} as CustomerExperienceService,
    resolvePublicContext: () => context,
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: () => ({
      scope, employeeId: '82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
    }),
    protectContact: () => { throw new Error('not used') },
    membershipTerms,
    membershipEnrollment: { enroll: enrollMembership } as never,
  })
  return app
}

function publicExperienceFixture(service: Record<string, ReturnType<typeof vi.fn>>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async () => { throw new Error('not used') } },
    service: service as unknown as CustomerExperienceService,
    resolvePublicContext: () => ({
      scope, customerId: '82000000-0000-4000-8000-000000000004',
      actorRef: 'customer:82000000-0000-4000-8000-000000000004', businessDate: '2026-08-16',
    }),
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: () => { throw new Error('not used') },
  })
  return app
}

function staffObservationFixture(recentObservations: ReturnType<typeof vi.fn>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  const transaction = { scope, query: vi.fn() }
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async (_scope, action) => action(transaction as never) },
    service: { recentObservations } as unknown as CustomerExperienceService,
    resolvePublicContext: () => { throw new Error('not used') },
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: () => ({
      scope, employeeId: '82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
    }),
    protectContact: () => { throw new Error('not used') },
  })
  return app
}

function staffReleaseFixture(service: Record<string, ReturnType<typeof vi.fn>>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  const scope = {
    tenantId: '82000000-0000-4000-8000-000000000001',
    storeId: '82000000-0000-4000-8000-000000000002',
  }
  const transaction = { scope, query: vi.fn() }
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async (_scope, action) => action(transaction as never) },
    service: service as unknown as CustomerExperienceService,
    resolvePublicContext: () => { throw new Error('not used') },
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: () => ({
      scope, employeeId: '82000000-0000-4000-8000-000000000003', businessDate: '2026-08-16',
    }),
    protectContact: () => { throw new Error('not used') },
  })
  return app
}

function fixture(
  registerActivity: ReturnType<typeof vi.fn>,
  rawContact: string,
  activityPayments?: Pick<ActivityPaymentService, 'get' | 'createAction' | 'query'>,
  protectContactOverride?: (value: string) => {
    hash: string
    encryptedBase64: string
    keyId: string
    masked: string
  } | Promise<{
    hash: string
    encryptedBase64: string
    keyId: string
    masked: string
  }>,
): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async () => { throw new Error('not used') } },
    service: { registerActivity } as unknown as CustomerExperienceService,
    resolvePublicContext: () => ({
      scope: {
        tenantId: '82000000-0000-4000-8000-000000000001',
        storeId: '82000000-0000-4000-8000-000000000002',
      },
      customerId: '82000000-0000-4000-8000-000000000003',
      actorRef: 'guest:test', businessDate: '2026-08-16',
    }),
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: protectContactOverride ?? ((value) => {
      expect(value).toBe(rawContact)
      return {
        hash: 'a'.repeat(64),
        encryptedBase64: Buffer.from(`encrypted:${value}`).toString('base64'),
        keyId: 'test-key-v1',
        masked: '138****8000',
      }
    }),
    ...(activityPayments === undefined ? {} : { activityPayments: activityPayments as ActivityPaymentService }),
  })
  return app
}

function registerActivityRequest(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/public/mini/activities/community-activity-api-test/registrations',
    headers: { 'idempotency-key': 'activity-registration-api-idempotency' },
    payload: {
      partySize: 2,
      contactSnapshot: { channel: 'miniprogram', contact: '13800138000' },
      termsAcknowledged: true,
      acknowledgedSafetyPolicyVersion: 'safety-v1',
      acknowledgedRefundPolicyVersion: 'refund-v1',
      paymentChoice: 'none',
    },
  })
}

function loyaltyFixture(loyalty: ReturnType<typeof vi.fn>): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  void app.register(customerExperienceApiPlugin, {
    transactions: { run: async () => { throw new Error('not used') } },
    service: { loyalty } as unknown as CustomerExperienceService,
    resolvePublicContext: () => ({
      scope: {
        tenantId: '82000000-0000-4000-8000-000000000001',
        storeId: '82000000-0000-4000-8000-000000000002',
      },
      customerId: '82000000-0000-4000-8000-000000000003',
      actorRef: 'guest:test', businessDate: '2026-08-16',
    }),
    resolveGuestContext: async () => { throw new Error('not used') },
    resolveStaffContext: async () => { throw new Error('not used') },
    protectContact: () => { throw new Error('not used') },
  })
  return app
}
