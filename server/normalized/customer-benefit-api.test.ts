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
    expect(JSON.stringify(response.json())).not.toMatch(/identity|hash|consent|internalRisk/i)
  })

  it('returns only public benefit display data and never leaks product/internal snapshots', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/customer/benefits' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{ id: benefitId, display: { title: '生日赠饮' } }] })
    expect(JSON.stringify(response.json())).not.toMatch(/COCKTAIL-SECRET|internalNote|issuedByEmployeeId/)
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
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as ScopedTransaction
  const transactions = {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  } as CustomerBenefitApiOptions['transactions']
  const reserve = vi.fn(async () => ({ value: reservation, replayed: false }))
  const issue = vi.fn(async () => ({ value: benefit, replayed: false }))
  const updateProfile = vi.fn()
  const options: CustomerBenefitApiOptions = {
    transactions,
    resolveGuestContext: vi.fn(async () => ({
      scope: { tenantId, storeId }, customerId, tableSessionId,
      businessDate: '2026-08-11', actorRef: 'guest-session-safe',
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
      cancelReservation: vi.fn(),
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
  return { app, reserve, issue, updateProfile }
}

type CustomerCommandServiceMock = CustomerBenefitApiOptions['customers']
type BenefitCommandServiceMock = CustomerBenefitApiOptions['benefits']
