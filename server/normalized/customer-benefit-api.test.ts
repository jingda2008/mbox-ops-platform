import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Benefit, BenefitReservation } from './benefit-repository.js'
import {
  customerBenefitApiPlugin,
  type CustomerBenefitApiOptions,
} from './customer-benefit-api.js'
import type { Customer, PublicCustomer } from './customer-repository.js'
import { GuestAuthenticationRequiredError } from './guest-request-context.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const customerId = '33333333-3333-4333-8333-333333333333'
const employeeId = '44444444-4444-4444-8444-444444444444'
const tableSessionId = '55555555-5555-4555-8555-555555555555'
const benefitId = '66666666-6666-4666-8666-666666666666'
const reservationId = '77777777-7777-4777-8777-777777777777'

const publicCustomer: PublicCustomer = {
  publicId: 'customer-public-0001',
  displayName: '林女士',
  tags: ['香槟偏好'],
  preferences: { scene: 'date' },
  firstSeenAt: '2026-08-11T12:00:00.000Z',
}

const customer: Customer = {
  id: customerId,
  publicId: publicCustomer.publicId,
  status: 'active',
  mergedIntoCustomerId: null,
  firstSeenAt: publicCustomer.firstSeenAt,
  lastSeenAt: publicCustomer.firstSeenAt,
  profile: {
    displayName: '林女士',
    tags: ['香槟偏好'],
    publicTags: ['香槟偏好'],
    preferences: { scene: 'date', internalRisk: 'never-public' },
    publicPreferences: { scene: 'date' },
    consentSnapshot: { internal: true },
  },
  identities: [{ kind: 'wechat', status: 'active', linkedAt: publicCustomer.firstSeenAt }],
}

const benefit: Benefit = {
  id: benefitId,
  customerId,
  benefitCode: 'gift.birthday',
  benefitType: 'gift_product',
  status: 'issued',
  valueAmountMinor: 6800,
  currency: 'CNY',
  benefitSnapshot: {
    productCode: 'COCKTAIL-SECRET',
    internalNote: 'never-public',
    publicDisplay: { title: '生日赠饮' },
  },
  quantityTotal: 1,
  quantityReserved: 0,
  quantityRedeemed: 0,
  quantityAvailable: 1,
  validFrom: '2026-08-11T00:00:00.000Z',
  validUntil: '2026-08-12T00:00:00.000Z',
  issuedByEmployeeId: employeeId,
  issuanceReason: '生日关怀',
  redeemedAt: null,
  aggregateVersion: 1,
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
}

const reservation: BenefitReservation = {
  id: reservationId,
  benefitId,
  customerId,
  tableSessionId,
  quantity: 1,
  status: 'reserved',
  reservedAt: '2026-08-11T12:01:00.000Z',
  expiresAt: '2099-08-11T12:11:00.000Z',
  completedAt: null,
  cancelReason: null,
}

const apps: FastifyInstance[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('customerBenefitApiPlugin privacy and permission boundaries', () => {
  it('returns a scannable daily-snack claim code without treating the QR as authorization', async () => {
    const claim = vi.fn(async () => ({ replayed: false, value: {
      id: 'daily-snack-claim-1', claimCode: 'DSN-ABCDEFGHIJ', benefitId,
      benefitReservationId: reservationId, quantity: 1, status: 'reserved',
      expiresAt: '2026-08-25T04:15:00.000Z', redeemedByEmployeeName: null,
      redeemedAt: null, fulfilledAt: null, title: '每日点心', tableCode: 'VIP1',
      tableSessionId, memberNo: 'MBX-35648', customerName: '林女士',
    } }))
    const value = fixture({ dailySnackClaims: { claim } as never })
    const response = await value.app.inject({
      method: 'POST', url: '/api/guest/customer/annual-daily-snacks/claim',
      headers: { 'idempotency-key': 'daily-snack-qr-code-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ data: {
      claimCode: 'DSN-ABCDEFGHIJ', claimCodeQrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    } })
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ customerId, tableSessionId }), {
      idempotencyKey: 'daily-snack-qr-code-0001',
    })
  })

  it('returns an authentication response instead of a service fault when guest identity is missing', async () => {
    const value = fixture({
      resolveGuestContext: vi.fn(async () => { throw new GuestAuthenticationRequiredError() }),
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/customer/profile' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'CUSTOMER_BENEFIT_AUTH_REQUIRED' } })
  })

  it('returns a strict public customer DTO without identity hashes, consent, or staff preferences', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/customer/profile' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: publicCustomer })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(JSON.stringify(response.json())).not.toMatch(/identity|hash|consent|internalRisk/i)
  })

  it('returns only public benefit display data and never leaks product/internal snapshots', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/customer/benefits' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{ id: benefitId, display: { title: '生日赠饮' } }] })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(JSON.stringify(response.json())).not.toMatch(/COCKTAIL-SECRET|internalNote|issuedByEmployeeId/)
  })

  it('allows the authenticated member to read profile and benefits without a table session', async () => {
    const value = fixture({
      resolveSelfContext: vi.fn(async () => ({
        scope: { tenantId, storeId }, customerId, tableSessionId: null,
        businessDate: '2026-08-11', actorRef: `customer:${customerId}`,
      })),
    })
    const profile = await value.app.inject({ method: 'GET', url: '/api/public/mini/customer/profile' })
    const benefits = await value.app.inject({ method: 'GET', url: '/api/public/mini/customer/benefits' })
    expect(profile.statusCode).toBe(200)
    expect(profile.json()).toEqual({ data: publicCustomer })
    expect(profile.headers['cache-control']).toBe('private, no-store')
    expect(profile.headers.pragma).toBe('no-cache')
    expect(benefits.statusCode).toBe(200)
    expect(benefits.json()).toMatchObject({ data: [{ id: benefitId }] })
    expect(benefits.headers['cache-control']).toBe('private, no-store')
    expect(benefits.headers.pragma).toBe('no-cache')
  })

  it('maps an expired reservation identity to 401 without caching the error', async () => {
    const value = fixture({
      resolveSelfContext: vi.fn(async () => { throw new ReservationGuestSessionInvalidError() }),
    })
    const response = await value.app.inject({
      method: 'GET', url: '/api/public/mini/customer/benefits',
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'CUSTOMER_BENEFIT_AUTH_REQUIRED' } })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers.pragma).toBe('no-cache')
  })

  it('rejects sensitive reads when the exact guest-session position was revoked', async () => {
    const query = vi.fn(async () => ({ rows: [{ participation_id: null }], rowCount: 1 }))
    const value = fixture({
      transactions: {
        run: vi.fn(async (_scope, operation) => operation({
          scope: { tenantId, storeId }, query,
        } as unknown as ScopedTransaction)),
      },
    })
    const profile = await value.app.inject({ method: 'GET', url: '/api/guest/customer/profile' })
    const benefits = await value.app.inject({ method: 'GET', url: '/api/guest/customer/benefits' })
    expect(profile.statusCode).toBe(401)
    expect(benefits.statusCode).toBe(401)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('does not expose notification-consent settings in the member API', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET', url: '/api/guest/customer/notification-consents',
    })
    expect(response.statusCode).toBe(404)
  })

  it('rejects attempts to store notification consent in free-form customer JSON', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'PATCH',
      url: `/api/customers/${customerId}/profile`,
      headers: { 'idempotency-key': 'staff-profile-consent-json-0001' },
      payload: {
        reason: '错误写入通知授权',
        profile: { displayName: '林女士', consentSnapshot: { wechat: true } },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'CUSTOMER_BENEFIT_REQUEST_INVALID' } })
    expect(value.updateProfile).not.toHaveBeenCalled()
  })

  it('uses trusted guest customer and table context instead of body identity claims', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/guest/customer/benefits/${benefitId}/reservations`,
      headers: { 'idempotency-key': 'guest-benefit-reserve-0001' },
      payload: {
        customerId: 'attacker-customer',
        tableSessionId: 'attacker-table',
        quantity: 1,
        expiresAt: '2099-08-11T12:11:00.000Z',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(value.reserve).toHaveBeenCalledWith(expect.objectContaining({
      customerId,
      tableSessionId,
      expiresAt: '2026-08-11T12:15:00.000Z',
    }))
    expect(value.reserve).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'attacker-customer' }))
  })

  it('shows staff identity kinds without returning identity hashes', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/customers/${publicCustomer.publicId}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { identityKinds: ['wechat'] } })
    expect(JSON.stringify(response.json())).not.toMatch(/[0-9a-f]{64}/)
  })

  it('lists annual gift reservations only through the server-side employee table scope', async () => {
    const originalProductId = '88888888-8888-4888-8888-888888888888'
    const substituteProductId = '99999999-9999-4999-8999-999999999999'
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM mbox.benefit_reservations') ? [{
        reservation_id: reservationId, benefit_id: benefitId, customer_id: customerId,
        table_session_id: tableSessionId, table_code: 'VIP1', member_no: 'MBX000001',
        customer_name: '林女士', rule_kind: 'birthday', rule_title: '金卡生日礼遇', quantity: 1,
        reserved_at: '2026-08-11T12:00:00.000Z', expires_at: '2026-08-11T12:15:00.000Z',
        original_product_id: originalProductId, original_product_name: '生日特调', allowed_products: [
          { productId: originalProductId, name: '生日特调', isOriginal: true, configuredReason: null },
          { productId: substituteProductId, name: '无酒精特调', isOriginal: false, configuredReason: '酒水合规无酒精替代' },
        ],
      }] : [],
      rowCount: sql.includes('FROM mbox.benefit_reservations') ? 1 : 0,
    }))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation({
        scope: { tenantId, storeId }, query,
      } as unknown as ScopedTransaction)) },
    })
    const response = await value.app.inject({
      method: 'GET', url: `/api/staff/annual-benefit-reservations?tableSessionId=${tableSessionId}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{
      reservationId, tableSessionId, tableCode: 'VIP1', memberNo: 'MBX000001', originalProductId,
      allowedProducts: [{ productId: originalProductId, isOriginal: true },
        { productId: substituteProductId, isOriginal: false }],
    }] })
    const queueSql = query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('FROM mbox.benefit_reservations')) ?? ''
    expect(queueSql).toContain('mbox.employee_has_effective_permission')
    expect(queueSql).toContain('mbox.table_assignments')
    expect(queueSql).toContain("rule.rule_kind IN ('birthday','festival')")
  })

  it('lets a fulfillment employee cancel only an annual reservation in the current assigned table scope',async()=>{
    const query=vi.fn(async(sql:string)=>({
      rows:sql.includes('FROM mbox.benefit_reservations')?[{
        reservation_id:reservationId,benefit_id:benefitId,customer_id:customerId,
        table_session_id:tableSessionId,table_code:'VIP1',member_no:'MBX000001',customer_name:'林女士',
        rule_kind:'birthday',rule_title:'金卡生日礼遇',quantity:1,reserved_at:'2026-08-11T12:00:00Z',
        expires_at:'2099-08-11T12:15:00Z',original_product_id:'88888888-8888-4888-8888-888888888888',
        original_product_name:'生日特调',allowed_products:[],
      }]:[],rowCount:sql.includes('FROM mbox.benefit_reservations')?1:0,
    }))
    const value=fixture({transactions:{run:vi.fn(async(_scope,operation)=>operation({
      scope:{tenantId,storeId},query,
    } as unknown as ScopedTransaction))}})
    const response=await value.app.inject({method:'POST',
      url:`/api/staff/annual-benefit-reservations/${reservationId}/cancel`,
      headers:{'idempotency-key':'annual-gift-cancel-assigned-0001'},
      payload:{customerId,tableSessionId,reason:'顾客现场取消'},
    })
    expect(response.statusCode).toBe(200)
    expect(value.cancelReservation).toHaveBeenCalledWith(expect.objectContaining({
      benefitReservationId:reservationId,customerId,tableSessionId,
      employeePermission:'loyalty.redemption.fulfill',reason:'顾客现场取消',
    }))
    expect(query.mock.calls.map(([sql])=>sql).find((sql)=>sql.includes('FROM mbox.benefit_reservations')))
      .toContain('reservation.id=$5::uuid')
  })

  it('rejects manual issuance before command execution when live permission is absent', async () => {
    const value = fixture({
      createStaffAccessRepository: () => ({
        assertPermission: vi.fn(async () => { throw new StaffAccessDeniedError('denied') }),
      }),
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/benefits',
      headers: { 'idempotency-key': 'staff-benefit-issue-denied-0001' },
      payload: {
        customerId,
        benefitCode: 'gift.birthday',
        benefitType: 'gift_product',
        valueAmountMinor: 6800,
        currency: 'CNY',
        authorizationLimitId: '88888888-8888-4888-8888-888888888888',
        reason: '生日关怀',
        authorizationSource: { kind: 'approval_limit' },
      },
    })
    expect(response.statusCode).toBe(403)
    expect(value.issue).not.toHaveBeenCalled()
  })
})

function fixture(overrides: Partial<CustomerBenefitApiOptions> = {}) {
  const transaction = {
    scope: { tenantId, storeId },
    query: vi.fn(async (sql: string) => sql.includes('lock_active_table_guest_session_position')
      ? ({ rows: [{ participation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 })
      : ({ rows: [], rowCount: 0 })),
  } as unknown as ScopedTransaction
  const transactions = {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  } as CustomerBenefitApiOptions['transactions']
  const reserve = vi.fn(async () => ({ value: reservation, replayed: false }))
  const issue = vi.fn(async () => ({ value: benefit, replayed: false }))
  const updateProfile = vi.fn()
  const cancelReservation=vi.fn(async()=>({value:reservation,replayed:false}))
  const options: CustomerBenefitApiOptions = {
    transactions,
    resolveSelfContext: vi.fn(async () => ({
      scope: { tenantId, storeId }, customerId, tableSessionId: null,
      businessDate: '2026-08-11', actorRef: `customer:${customerId}`,
    })),
    resolveGuestContext: vi.fn(async () => ({
      scope: { tenantId, storeId }, customerId, tableSessionId,
      businessDate: '2026-08-11',
      actorRef: 'guest-session:99999999-9999-4999-8999-999999999999',
    })),
    resolveStaffContext: vi.fn(async () => ({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-11',
    })),
    customers: {
      createAnonymous: vi.fn(), linkIdentity: vi.fn(), updateProfile, merge: vi.fn(),
    } as unknown as CustomerCommandServiceMock,
    benefits: {
      issue,
      reserve,
      redeem: vi.fn(),
      cancelReservation,
    } as unknown as BenefitCommandServiceMock,
    createCustomerRepository: () => ({
      findPublicById: vi.fn(async () => publicCustomer),
      findByPublicId: vi.fn(async () => customer),
      listHistory: vi.fn(async () => []),
    } as unknown as ReturnType<NonNullable<CustomerBenefitApiOptions['createCustomerRepository']>>),
    createBenefitRepository: () => ({
      listAvailableForCustomer: vi.fn(async () => [benefit]),
    } as unknown as ReturnType<NonNullable<CustomerBenefitApiOptions['createBenefitRepository']>>),
    createStaffAccessRepository: () => ({ assertPermission: vi.fn(async () => ({} as never)) }),
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(customerBenefitApiPlugin, { prefix: '/api', ...options })
  return { app, reserve, issue, updateProfile, cancelReservation }
}

type CustomerCommandServiceMock = CustomerBenefitApiOptions['customers']
type BenefitCommandServiceMock = CustomerBenefitApiOptions['benefits']
