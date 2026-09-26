import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomerRepository } from './customer-repository.js'
import { BenefitRepository, type Benefit } from './benefit-repository.js'
import { CustomerExperienceRepository, type PublicActivity, type PublicActivityRegistration } from './customer-experience-repository.js'
import { loadMemberParticipation, readMemberScanCode } from './member-participation-query.js'
import { customerBenefitApiPlugin, type CustomerBenefitApiOptions } from './customer-benefit-api.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import { GuestAuthenticationRequiredError } from './guest-request-context.js'
import type { ScopedTransaction } from './transaction-runner.js'

afterEach(() => vi.restoreAllMocks())
const scope = { tenantId: 'tenant', storeId: 'store' }
const now = new Date('2026-09-26T04:00:00Z')

function fixture() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('customer_memberships')
    ? [{ customer_id: 'customer' }]
    : [{ public_id: 'activity', status: 'published', ends_at: '2026-09-27T04:00:00Z' }] }))
  const transaction = { scope, query } as unknown as ScopedTransaction
  const customer = vi.spyOn(CustomerRepository.prototype, 'resolveCanonical').mockResolvedValue({ id: 'canonical', status: 'active', profile: { displayName: '会员甲' } } as never)
  const benefits = vi.spyOn(BenefitRepository.prototype, 'listAvailableForCustomer').mockResolvedValue([])
  const activities = vi.spyOn(CustomerExperienceRepository.prototype, 'publicActivities').mockResolvedValue([])
  const registrations = vi.spyOn(CustomerExperienceRepository.prototype, 'publicActivityRegistrations').mockResolvedValue([])
  return { transaction, query, customer, benefits, activities, registrations }
}
function registration(status: string, paymentStatus: string, activityPublicId = 'activity'): PublicActivityRegistration {
  return { publicId: `${status}-${paymentStatus}`, activityPublicId, activityTitle: '超嗨活动', startsAt: now.toISOString(), partySize: 2,
    status, paymentStatus, maskedContact: '不要返回手机号', paymentId: '不要返回支付ID' } as unknown as PublicActivityRegistration
}

describe('member participation identification', () => {
  it('requires a full member identifier, never interprets a claim code or URL as identity', () => {
    expect(readMemberScanCode(' MBOX_MEMBER_V1:MBX-100000 ')).toBe('MBX-100000')
    expect(readMemberScanCode('MBX-100000')).toBe('MBX-100000')
    for (const code of ['', null, 'MBOX_CLAIM_V1:DSN-123', 'https://host/?member=1', 'MBOX_MEMBER_V1:', 'x'.repeat(129)]) {
      expect(() => readMemberScanCode(code)).toThrow()
    }
  })
  it('requires exact active membership in this store and rejects disabled customers', async () => {
    const value = fixture()
    value.query.mockResolvedValueOnce({ rows: [] })
    await expect(loadMemberParticipation(value.transaction, 'MBX-100000', true, false, now)).rejects.toThrow()
    expect(value.customer).not.toHaveBeenCalled()
    expect(value.query.mock.calls[0]?.[0]).toContain("member_no=$3 AND status='active'")
    expect(value.query).toHaveBeenCalledWith(expect.any(String), ['tenant', 'store', 'MBX-100000'])
    value.customer.mockResolvedValueOnce({ id: 'canonical', status: 'blocked', profile: {} } as never)
    await expect(loadMemberParticipation(value.transaction, 'MBX-100000', true, false, now)).rejects.toThrow()
    expect(value.benefits).not.toHaveBeenCalled()
  })
  it('does not query activity records without the activity permission', async () => {
    const value = fixture()
    const result = await loadMemberParticipation(value.transaction, 'MBX-100000', false, false, now)
    expect(result.activitiesVisible).toBe(false)
    expect(value.activities).not.toHaveBeenCalled()
    expect(value.registrations).not.toHaveBeenCalled()
    expect(value.benefits).toHaveBeenCalledWith('canonical', now.toISOString())
  })
  it('separates paid, free, unpaid, waitlisted, checked-in and ended registrations', async () => {
    const value = fixture()
    value.registrations.mockResolvedValue([
      registration('confirmed', 'paid'), registration('confirmed', 'not_required'),
      registration('confirmed', 'pending'), registration('payment_pending', 'pending'),
      registration('waitlisted', 'not_required'), registration('checked_in', 'paid'),
      registration('confirmed', 'paid', 'ended'),
    ])
    const result = await loadMemberParticipation(value.transaction, 'MBX-100000', true, false, now)
    expect(result.registrations.map(item => item.readyForCheckIn)).toEqual([true, true, false, false, false, false, false])
    expect(result.registrations[4]?.guidance).toContain('尚未取得参加名额')
    expect(result.registrations[5]?.guidance).toContain('套餐实物交付')
    expect(JSON.stringify(result)).not.toMatch(/不要返回|maskedContact|paymentId/)
  })
  it('does not promise participation from membership alone and exposes only safe benefit fields', async () => {
    const value = fixture()
    value.activities.mockResolvedValue([
      { publicId: 'open', title: '活动', remainingCapacity: 5 },
      { publicId: 'full', title: '满员', remainingCapacity: 0 },
      { publicId: 'blocked', title: '阻断', paymentAvailability: 'blocked', paymentBlockedReason: '暂不支持付款' },
      { publicId: 'registered', registrationStatus: 'confirmed' },
    ] as PublicActivity[])
    value.benefits.mockResolvedValue([{ id: 'benefit', benefitType: 'gift_product', quantityAvailable: 1, validUntil: null,
      benefitSnapshot: { publicDisplay: { title: '优惠券', internal: 'secret' }, internalNote: 'secret' },
      pricePromise: { kind: 'fixed_price' }, authorizationSource: { secret: true } } as unknown as Benefit])
    const result = await loadMemberParticipation(value.transaction, 'MBX-100000', true, false, now)
    expect(result.activities).toHaveLength(3)
    expect(result.activities[0]?.guidance).toContain('以提交校验为准')
    expect(result.activities[1]?.guidance).toContain('名额已满')
    expect(result.activities[2]?.guidance).toBe('暂不支持付款')
    expect(result.benefits[0]?.guidance).toContain('付款成功后核销')
    expect(JSON.stringify(result)).not.toMatch(/secret|authorizationSource|benefitSnapshot/)
  })
})

describe('member participation staff endpoint', () => {
  it('uses staff authentication and enforces member-account permission before querying identity', async () => {
    for (const authFails of [true, false]) {
      const value = fixture()
      const app = Fastify()
      app.register(customerBenefitApiPlugin, options(value.transaction, {
        resolveStaffContext: async () => {
          if (authFails) throw new GuestAuthenticationRequiredError()
          return { scope, employeeId: 'employee', businessDate: '2026-09-26' }
        },
        createStaffAccessRepository: () => ({ assertPermission: vi.fn(async () => { throw new StaffAccessDeniedError('denied') }) }),
      }))
      try {
        const response = await app.inject({ method: 'POST', url: '/staff/member-participation/lookup', payload: { code: 'MBX-100000' } })
        expect(response.statusCode).toBe(authFails ? 401 : 403)
        expect(value.query).not.toHaveBeenCalled()
        expect(response.headers['cache-control']).toContain('no-store')
      } finally { await app.close(); vi.restoreAllMocks() }
    }
  })
  it('runs the complete lookup in a read-only transaction and never uses a supplied customer id', async () => {
    const value = fixture()
    const app = Fastify()
    const assertPermission = vi.fn(async () => ({ permissions: ['loyalty.account.view', 'community.activity.view'] }) as never)
    const config = options(value.transaction, { createStaffAccessRepository: () => ({ assertPermission }) })
    app.register(customerBenefitApiPlugin, config)
    try {
      const response = await app.inject({ method: 'POST', url: '/staff/member-participation/lookup', payload: { code: 'MBOX_MEMBER_V1:MBX-100000', customerId: 'other' } })
      expect(response.statusCode).toBe(200)
      expect(response.json().data.memberNo).toBe('MBX-100000')
      expect(config.transactions.run).toHaveBeenCalledWith(scope, expect.any(Function), { readOnly: true })
      expect(assertPermission).toHaveBeenCalledWith('employee', 'loyalty.account.view')
      expect(value.customer).toHaveBeenCalledWith('customer')
      expect(response.headers['cache-control']).toContain('no-store')
    } finally { await app.close() }
  })
})
function options(transaction: ScopedTransaction, overrides: Partial<CustomerBenefitApiOptions> = {}): CustomerBenefitApiOptions {
  return { transactions: { run: vi.fn(async (_scope, operation) => operation(transaction)) },
    customers: {} as never, benefits: {} as never,
    resolveSelfContext: vi.fn(), resolveGuestContext: vi.fn(),
    resolveStaffContext: async () => ({ scope, employeeId: 'employee', businessDate: '2026-09-26' }),
    createStaffAccessRepository: () => ({ assertPermission: vi.fn(async () => ({ permissions: ['loyalty.account.view', 'community.activity.view'] }) as never) }),
    now: () => now, ...overrides }
}
