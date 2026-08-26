import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type { SubmittedCommerceResult } from './commerce-command-service.js'
import {
  GuestOrderDuplicateConfirmationRequiredError,
  GuestOrderRateLimitedError,
} from './guest-order-safety.js'
import {
  guestCommerceServiceApiPlugin,
  type GuestCommerceServiceApiOptions,
} from './guest-commerce-service-api.js'
import {
  GuestAuthenticationRequiredError,
  GuestStoreScopeError,
  type GuestRequestContext,
} from './guest-request-context.js'
import type { Payment } from './payment-repository.js'
import { OnlinePaymentUnknownError } from './online-payment-service.js'
import { PostarPaymentRejectedError } from '../postar-adapter.js'
import { FulfillmentCapacityUnavailableError } from './fulfillment-capacity-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
  type ScopedTransaction,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const customerId = '33333333-3333-4333-8333-333333333333'
const tableSessionId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'
const orderId = '66666666-6666-4666-8666-666666666666'
const orderItemId = '77777777-7777-4777-8777-777777777777'
const operationalOrderItemId = '77777777-7777-4777-8777-777777777778'
const paymentId = '88888888-8888-4888-8888-888888888888'

const context: GuestRequestContext = {
  scope: { tenantId, storeId },
  sessionKind: 'table',
  customerId,
  tableSessionId,
  reservationId: null,
  tableCode: 'VIP1',
  tableDisplayName: 'VIP 1',
  businessDate: '2026-08-11',
  expiresAt: '2026-08-11T15:00:00.000Z',
  capabilities: ['guest.session.read', 'guest.menu.read', 'guest.order.create', 'guest.service.create'],
  actorRef: 'guest-session:99999999-9999-4999-8999-999999999999',
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('guest commerce/service API trust boundaries', () => {
  it('allows an authenticated mini-program customer to browse the current menu without a table session', async () => {
    const resolvePublicContext = vi.fn(async () => ({ scope: context.scope }))
    const value = fixture({
      resolvePublicContext,
      resolveGuestContext: async () => { throw new GuestAuthenticationRequiredError() },
    })
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/public/mini/menu/products?search=qingdao',
    })

    expect(response.statusCode).toBe(200)
    expect(resolvePublicContext).toHaveBeenCalledOnce()
    expect(response.json()).toMatchObject({
      data: [{ productId, name: '青岛啤酒', amountMinor: 6800, availabilityStatus: 'available', available: true }],
      meta: { partySize: null, recommendationScene: null, orderingRequiresTableScan: true },
    })
    expect(value.query).toHaveBeenCalledOnce()
    expect(value.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([null, 'qingdao']))
  })

  it('returns an authentication response when the public mini-program session has expired', async () => {
    const value = fixture({
      resolvePublicContext: async () => { throw new ReservationGuestSessionInvalidError() },
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/public/mini/menu/products' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_SESSION_INVALID' } })
    expect(value.query).not.toHaveBeenCalled()
  })

  it('returns an authentication response instead of a server error when the guest session is missing', async () => {
    const value = fixture({
      resolveGuestContext: async () => { throw new GuestAuthenticationRequiredError() },
    })
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/guest/menu/products',
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_SESSION_INVALID' } })
    expect(value.query).not.toHaveBeenCalled()
  })

  it('returns a forbidden response when the trusted store scope is invalid', async () => {
    const value = fixture({
      resolveGuestContext: async () => { throw new GuestStoreScopeError() },
    })
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/guest/menu/products',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'STORE_ACCESS_FORBIDDEN' } })
    expect(value.query).not.toHaveBeenCalled()
  })

  it('searches the normalized menu search field without exposing internal snapshots', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/guest/menu/products?search=qingdao&limit=20',
    })
    expect(response.statusCode).toBe(200)
    expect(value.query).toHaveBeenCalledWith(
      expect.stringContaining('product.search_text ILIKE'),
      expect.arrayContaining(['qingdao']),
    )
    const catalogSql = value.query.mock.calls.find(([sql]) => sql.includes('product.recommendation_priority'))?.[0]
    expect(catalogSql).toContain('product.recommendation_priority DESC')
    expect(catalogSql).toContain('product.recommendation_beverage_family')
    expect(catalogSql).toContain("'guest_qr'=ANY(product.allowed_channels)")
    expect(catalogSql).not.toContain("product.product_snapshot -> 'recommendation'")
    expect(response.json()).toMatchObject({
      data: [{
        productId,
        name: '青岛啤酒',
        beverageFamily: 'beer',
        specification: '330ml',
        amountMinor: 6800,
        availabilityStatus: 'available',
        available: true,
        recommendation: { enabled: true },
      }],
      meta: { partySize: 2, recommendationScene: 'date' },
    })
    expect(response.body).not.toMatch(/internalCost|costAmount|grossMargin|contributionAmount|catalogContributionScore|contributionPositive/)
  })

  it('returns the configurable customer category hierarchy instead of exposing an internal category code', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/menu/products' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: [{
        categoryCode: 'beer',
        categoryName: '啤酒',
        categoryParentCode: 'drinks',
        categoryParentName: '酒水',
        categorySortOrder: 20,
        topCategorySortOrder: 20,
      }],
    })
    const catalogSql = value.query.mock.calls.find(([sql]) => sql.includes('FROM mbox.products AS product'))?.[0]
    expect(catalogSql).toContain('LEFT JOIN mbox.menu_categories AS menu_category')
    expect(catalogSql).toContain('LEFT JOIN mbox.menu_categories AS parent_menu_category')
    expect(catalogSql).toContain('menu_category.guest_visible')
    expect(response.body).not.toContain('categoryName":"beer')
  })

  it('does not read table-scoped menu context after the exact guest position is revoked', async () => {
    const query = vi.fn(async () => ({ rows: [{ participation_id: null }], rowCount: 1 }))
    const value = fixture({
      transactions: {
        run: vi.fn(async (_scope, operation) => operation({
          scope: context.scope, query,
        } as unknown as ScopedTransaction)),
      },
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/menu/products' })
    expect(response.statusCode).toBe(401)
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('lock_active_table_guest_session_position')
  })

  it('rejects client-supplied identity, table, scope and price fields before creating an order', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-untrusted-0001' },
      payload: {
        customerId: 'attacker-customer',
        tableSessionId: 'attacker-table',
        items: [{ productId, quantity: 1, unitPriceMinor: 1 }],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'UNTRUSTED_FIELD' } })
    expect(value.commerce.submitOrder).not.toHaveBeenCalled()
  })

  it('uses only authenticated context and returns explicit checkout/payment intent state', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-valid-0001' },
      payload: {
        items: [{ productId, quantity: 2, note: '少冰' }],
        note: '一起上，生日桌',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      scope: context.scope,
      tableSessionId,
      channel: 'guest_qr',
      settlementMode: 'immediate_payment',
      createdByCustomerId: customerId,
      lines: [{ productId, quantity: 2, note: '少冰' }],
      note: '一起上，生日桌',
    }))
    expect(value.payments.initiate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'postar',
      method: 'jsapi',
      principal: {
        type: 'guest',tableSessionId,customerId,
        guestSessionId:'99999999-9999-4999-8999-999999999999',
      },
    }))
    expect(response.json()).toMatchObject({
      data: {
        cart: { itemCount: 2, lineCount: 1 },
        order: {
          publicId: 'guest-order-public-0001',
          attentionRequired: true,
          kdsNotice: '备注已保存，付款成功后将在出品与配送页面重点提示',
        },
        settlement: { payableAmountMinor: 13_600, currency: 'CNY' },
        payment: {
          mode: 'wechat_jsapi',
          provider: 'postar',
          method: 'jsapi',
          status: 'pending',
          simulated: false,
          providerAction: paymentAction('jsapi'),
        },
      },
    })
  })

  it('passes a checkout upgrade reference into the single atomic order command', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-upgrade-atomic-0001' },
      payload: {
        items: [{ productId, quantity: 1 }],
        checkoutUpgradeOfferPublicId: 'checkout-upgrade-public-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledOnce()
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      lines: [{ productId, quantity: 1, note: null }],
      checkoutUpgradeOfferPublicId: 'checkout-upgrade-public-0001',
    }))
  })

  it('forwards an optional server recommendation attribution into the order command', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-recommendation-0001' },
      payload: {
        items: [{ productId, quantity: 1 }],
        recommendationPublicId: 'recommendation-public-0001',
        selectedRecommendationProductId: productId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      recommendationAttribution: {
        recommendationPublicId: 'recommendation-public-0001',
        selectedProductId: productId,
      },
    }))
  })

  it('rejects a partial recommendation attribution without invoking commerce', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-recommendation-invalid-0001' },
      payload: {
        items: [{ productId, quantity: 1 }],
        recommendationPublicId: 'recommendation-public-0001',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'RECOMMENDATION_ATTRIBUTION_INVALID' } })
    expect(value.commerce.submitOrder).not.toHaveBeenCalled()
  })

  it('does not create a guest order when the store has closed online payment', async () => {
    const value = fixture({ resolvePaymentMode: vi.fn(async () => null) })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-policy-closed-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'ONLINE_PAYMENT_UNAVAILABLE' } })
    expect(value.commerce.submitOrder).not.toHaveBeenCalled()
    expect(value.payments.initiate).not.toHaveBeenCalled()
  })

  it('forwards only the public conflicting order confirmation to server-authoritative validation', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-confirmed-0001' },
      payload: {
        items: [{ productId, quantity: 2 }],
        confirmedDuplicateOrderId: 'guest-order-existing-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      confirmedDuplicateOrderPublicId: 'guest-order-existing-0001',
    }))
  })

  it('returns actionable duplicate and rate-limit responses without creating payment', async () => {
    const duplicate = fixture({
      commerce: {
        submitOrder: vi.fn(async () => {
          throw new GuestOrderDuplicateConfirmationRequiredError(
            'guest-order-existing-0001',
            '2026-08-13T12:00:00.000Z',
          )
        }),
      } as never,
    })
    const duplicateResponse = await duplicate.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-duplicate-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })
    expect(duplicateResponse.statusCode).toBe(409)
    expect(duplicateResponse.json()).toMatchObject({ error: {
      code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
      details: { conflictingOrderId: 'guest-order-existing-0001' },
    } })
    expect(duplicate.payments.initiate).not.toHaveBeenCalled()

    const limited = fixture({
      commerce: {
        submitOrder: vi.fn(async () => {
          throw new GuestOrderRateLimitedError('customer', '2026-08-13T12:01:00.000Z')
        }),
      } as never,
    })
    const limitedResponse = await limited.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-limited-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })
    expect(limitedResponse.statusCode).toBe(429)
    expect(limitedResponse.json()).toMatchObject({ error: {
      code: 'GUEST_ORDER_RATE_LIMITED',
      retryAt: '2026-08-13T12:01:00.000Z',
      details: { dimension: 'customer' },
    } })
    expect(limited.payments.initiate).not.toHaveBeenCalled()
  })

  it('returns a stable capacity error without starting payment', async () => {
    const value = fixture({
      commerce: {
        submitOrder: vi.fn(async () => {
          throw new FulfillmentCapacityUnavailableError(
            'FULFILLMENT_CAPACITY_EXCEEDED',
            '该出品时段的可用产能已满，请稍后重试或调整商品',
          )
        }),
      } as never,
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-capacity-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: {
      code: 'FULFILLMENT_CAPACITY_EXCEEDED',
    } })
    expect(value.payments.initiate).not.toHaveBeenCalled()
  })

  it('shares table order settlement state without payer identity or provider evidence', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/orders/table' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{
      publicId: 'shared-order-0001', round: 1, visibility: 'shared', isMine: false,
      pricingKind: 'gift', pricingLabel: '门店赠送',
      paymentAccess: 'available',
      items: [{ productId, name: '青岛啤酒', quantity: 2, status: 'preparing' }],
    }] })
    expect(response.body).not.toMatch(/customerId|providerTransaction|providerSnapshot|openid|authCode/i)
    expect(response.body).not.toContain(tableSessionId)
    expect(response.json()).toMatchObject({ meta: { count: 1 } })
    expect(response.json().meta).not.toHaveProperty('tableSessionId')
  })

  it('continues the employee-created QR payment on a guest phone without creating a second payment', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('lock_active_table_guest_session_position')) {
        return { rows: [{ participation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount:1 }
      }
      if (sql.includes('SELECT ordering.id AS order_id')) {
        return { rows: [{ order_id: orderId, payment_id: paymentId }], rowCount: 1 }
      }
      if (sql.includes('SELECT payment.id, payment.payable_kind, payment.order_id')) {
        return { rows: [{
          id: paymentId,
          payable_kind: 'order',
          order_id: orderId,
          activity_registration_id: null,
          activity_registration_public_id: null,
          order_public_id: 'staff-order-public-0001',
          public_id: 'staff-payment-public-0001',
          provider: 'postar',
          method: 'native_qr',
          amount_minor: '13600',
          currency: 'CNY',
          status: 'pending',
          table_session_id: tableSessionId,
          table_code: 'VIP1',
          created_at: '2026-08-14T12:00:00.000Z',
        }], rowCount: 1 }
      }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ linked: true }], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const transaction = { scope: context.scope, query } as unknown as ScopedTransaction
    const create = vi.fn(async () => ({
      ...paymentAction('qr'),
      paymentId,
      paymentPublicId: 'staff-payment-public-0001',
      orderPublicId: 'staff-order-public-0001',
    }))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation(transaction)) },
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveGuestMethod: vi.fn(async () => 'native_qr' as const),
        resolveActivePayment: vi.fn(async () => null),
        create,
      },
    })

    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders/staff-order-public-0001/payment',
      headers: { 'idempotency-key': 'guest-continues-staff-payment-0001' },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: {
      paymentId,
      paymentPublicId: 'staff-payment-public-0001',
      orderPublicId: 'staff-order-public-0001',
      presentation: 'qr',
    } })
    expect(value.options.payments.initiate).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      paymentId,
      principal: {
        type: 'guest',tableSessionId,customerId,
        guestSessionId:'99999999-9999-4999-8999-999999999999',
      },
    }))
    const paymentContextSql = query.mock.calls.find(([sql]) => String(sql).includes('SELECT payment.id, payment.payable_kind, payment.order_id'))?.[0]
    expect(paymentContextSql).not.toContain('FOR SHARE')
  })

  it('fails closed if a guest loses the table position after order resolution but before active-payment replay', async () => {
    let positionChecks = 0
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT ordering.id AS order_id')) {
        return { rows: [{ order_id: orderId, payment_id: paymentId }], rowCount: 1 }
      }
      if (sql.includes('lock_active_table_guest_session_position')) {
        positionChecks += 1
        return { rows: [{ participation_id: positionChecks === 1 ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null }], rowCount: 1 }
      }
      if (sql.includes('SELECT payment.id, payment.payable_kind, payment.order_id')) {
        return { rows: [{
          id: paymentId, payable_kind: 'order', order_id: orderId,
          activity_registration_id: null, activity_registration_public_id: null,
          order_public_id: 'staff-order-public-0001', public_id: 'staff-payment-public-0001',
          provider: 'postar', method: 'native_qr', amount_minor: '13600', currency: 'CNY', status: 'pending',
          table_session_id: tableSessionId, table_code: 'VIP1', created_at: '2026-08-14T12:00:00.000Z',
        }], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const create = vi.fn(async () => paymentAction('qr'))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation({ scope: context.scope, query } as unknown as ScopedTransaction)) },
      onlinePayments: {
        assertAvailable: vi.fn(), resolveGuestMethod: vi.fn(async () => 'native_qr' as const),
        resolveActivePayment: vi.fn(async () => null), create,
      },
    })

    const response = await value.app.inject({
      method: 'POST', url: '/api/guest/orders/staff-order-public-0001/payment',
      headers: { 'idempotency-key': 'guest-revoked-before-active-replay-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_SESSION_INVALID' } })
    expect(value.payments.initiate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('returns the stable cross-table conflict before any provider action when active payment context changes', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT ordering.id AS order_id')) {
        return { rows: [{ order_id: orderId, payment_id: paymentId }], rowCount: 1 }
      }
      if (sql.includes('lock_active_table_guest_session_position')) {
        return { rows: [{ participation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 }
      }
      if (sql.includes('SELECT payment.id, payment.payable_kind, payment.order_id')) {
        return { rows: [{
          id: paymentId, payable_kind: 'order', order_id: orderId,
          activity_registration_id: null, activity_registration_public_id: null,
          order_public_id: 'staff-order-public-0001', public_id: 'staff-payment-public-0001',
          provider: 'postar', method: 'native_qr', amount_minor: '13600', currency: 'CNY', status: 'pending',
          table_session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', table_code: 'VIP2', created_at: '2026-08-14T12:00:00.000Z',
        }], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const create = vi.fn(async () => paymentAction('qr'))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation({ scope: context.scope, query } as unknown as ScopedTransaction)) },
      onlinePayments: {
        assertAvailable: vi.fn(), resolveGuestMethod: vi.fn(async () => 'native_qr' as const),
        resolveActivePayment: vi.fn(async () => null), create,
      },
    })

    const response = await value.app.inject({
      method: 'POST', url: '/api/guest/orders/staff-order-public-0001/payment',
      headers: { 'idempotency-key': 'guest-changed-before-provider-action-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_ORDER_ACCESS_FORBIDDEN' } })
    expect(value.payments.initiate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('fails closed when a guest tries to resume an order from another table', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT ordering.id AS order_id')) return { rows: [], rowCount: 0 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const create = vi.fn(async () => paymentAction('jsapi'))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation({
        scope: context.scope, query,
      } as unknown as ScopedTransaction)) },
      onlinePayments: {
        assertAvailable: vi.fn(), resolveGuestMethod: vi.fn(async () => 'jsapi' as const),
        resolveActivePayment: vi.fn(async () => null), create,
      },
    })

    const response = await value.app.inject({
      method: 'POST', url: '/api/guest/orders/other-table-order-public-0001/payment',
      headers: { 'idempotency-key': 'guest-other-table-payment-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_ORDER_ACCESS_FORBIDDEN' } })
    expect(value.options.payments.initiate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('returns an authentication response when the guest is no longer at the current table', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT ordering.id AS order_id')) {
        return { rows: [{ order_id: orderId, payment_id: null }], rowCount: 1 }
      }
      if (sql.includes('lock_active_table_guest_session_position')) return { rows: [{ participation_id: null }], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const create = vi.fn(async () => paymentAction('jsapi'))
    const value = fixture({
      transactions: { run: vi.fn(async (_scope, operation) => operation({
        scope: context.scope, query,
      } as unknown as ScopedTransaction)) },
      onlinePayments: {
        assertAvailable: vi.fn(), resolveGuestMethod: vi.fn(async () => 'jsapi' as const),
        resolveActivePayment: vi.fn(async () => null), create,
      },
    })

    const response = await value.app.inject({
      method: 'POST', url: '/api/guest/orders/current-table-order-public-0001/payment',
      headers: { 'idempotency-key': 'guest-revoked-table-payment-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'GUEST_SESSION_INVALID' } })
    expect(value.options.payments.initiate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('labels simulation as pending test confirmation instead of pretending it is paid', async () => {
    const value = fixture({ paymentMode: 'simulation' })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-simulation-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })
    expect(response.statusCode).toBe(201)
    expect(value.payments.initiate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'simulation', method: 'native_qr',
    }))
    expect(response.json()).toMatchObject({
      data: { payment: {
        mode: 'simulation',
        status: 'pending',
        simulated: true,
        providerAction: paymentAction('qr'),
      } },
    })
  })

  it('keeps the created order visible when the provider rejects payment initiation', async () => {
    const value = fixture({
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveGuestMethod: vi.fn(async () => 'jsapi' as const),
        resolveActivePayment: vi.fn(async () => null),
        create: vi.fn(async () => { throw new PostarPaymentRejectedError('test rejection') }),
      },
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-provider-rejected-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledOnce()
    expect(response.json()).toMatchObject({ data: {
      order: { publicId: 'guest-order-public-0001' },
      payment: {
        status: 'failed',
        providerAction: {
          orderPublicId: 'guest-order-public-0001',
          status: 'failed',
          presentation: 'jsapi',
          payload: null,
        },
      },
    } })
  })

  it('keeps an uncertain payment attached to the created order without issuing another action', async () => {
    const value = fixture({
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveGuestMethod: vi.fn(async () => 'native_qr' as const),
        resolveActivePayment: vi.fn(async () => null),
        create: vi.fn(async () => { throw new OnlinePaymentUnknownError() }),
      },
      paymentMode: 'wechat_native_qr',
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      headers: { 'idempotency-key': 'guest-order-provider-unknown-0001' },
      payload: { items: [{ productId, quantity: 1 }] },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commerce.submitOrder).toHaveBeenCalledOnce()
    expect(response.json()).toMatchObject({ data: {
      order: { publicId: 'guest-order-public-0001' },
      payment: {
        status: 'pending',
        providerAction: {
          orderPublicId: 'guest-order-public-0001',
          status: 'unknown',
          presentation: 'qr',
          payload: null,
        },
      },
    } })
  })
})

integration('guest service and mood API with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let commandExecutor: NormalizedCommandExecutor
  let integrationContext: GuestRequestContext
  let integrationTenantId: string
  let integrationStoreId: string
  let integrationSessionId: string
  let integrationCustomerId: string
  let integrationProductId: string
  let integrationStockedProductId: string
  let integrationStockItemId: string
  let integrationNotManagedProductId: string
  let app: FastifyInstance

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    commandExecutor = new NormalizedCommandExecutor(transactions)
    integrationTenantId = randomUUID()
    integrationStoreId = randomUUID()
    integrationCustomerId = randomUUID()
    integrationSessionId = randomUUID()
    integrationProductId = randomUUID()
    integrationStockedProductId = randomUUID()
    integrationStockItemId = randomUUID()
    integrationNotManagedProductId = randomUUID()
    const areaId = randomUUID()
    const tableId = randomUUID()
    await pool.query(
      `INSERT INTO mbox.tenants (id, code, name) VALUES ($1::uuid, $2, 'Guest API integration tenant')`,
      [integrationTenantId, `gapi-tenant-${integrationTenantId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
       VALUES ($1::uuid, $2::uuid, $3, 'Guest API integration store', 'Asia/Shanghai', '06:00')`,
      [integrationStoreId, integrationTenantId, `gapi-store-${integrationStoreId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'GA', 'Guest API', 'indoor')`,
      [areaId, integrationTenantId, integrationStoreId],
    )
    await pool.query(
      `INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity, qr_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VIP3', 'VIP 3', 6, 1)`,
      [tableId, integrationTenantId, integrationStoreId, areaId],
    )
    await pool.query(
      `INSERT INTO mbox.customers (id, tenant_id, store_id, public_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [integrationCustomerId, integrationTenantId, integrationStoreId, `gapi-customer-${integrationCustomerId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.products (
         id, tenant_id, store_id, code, name, category_code, fulfillment_station,
         product_kind, guest_visible, search_text, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, '公开菜单测试饮品', 'drink', 'bar',
         'single', true, $4 || ' 公开菜单测试饮品', 'active'
       )`,
      [integrationProductId, integrationTenantId, integrationStoreId, `PUBLIC-${integrationProductId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.products (
         id, tenant_id, store_id, code, name, category_code, fulfillment_station,
         product_kind, guest_visible, search_text, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, '公开菜单库存饮品', 'drink', 'bar',
         'single', true, $4 || ' 公开菜单库存饮品', 'active'
       )`,
      [integrationStockedProductId, integrationTenantId, integrationStoreId, `STOCK-${integrationStockedProductId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.products (
         id, tenant_id, store_id, code, name, category_code, fulfillment_station,
         product_kind, inventory_control_mode, guest_visible, search_text, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, '公开菜单测试小食', 'food', 'kitchen',
         'single', 'not_managed', true, $4 || ' 公开菜单测试小食', 'active'
       )`,
      [integrationNotManagedProductId, integrationTenantId, integrationStoreId, `PUBLIC-${integrationNotManagedProductId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.product_prices (
         tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'standard', 6800, 'CNY', clock_timestamp() - interval '1 minute')`,
      [integrationTenantId, integrationStoreId, integrationProductId],
    )
    await pool.query(
      `INSERT INTO mbox.product_prices (
         tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'standard', 8800, 'CNY', clock_timestamp() - interval '1 minute')`,
      [integrationTenantId, integrationStoreId, integrationStockedProductId],
    )
    await pool.query(
      `INSERT INTO mbox.product_prices (
         tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'standard', 3800, 'CNY', clock_timestamp() - interval '1 minute')`,
      [integrationTenantId, integrationStoreId, integrationNotManagedProductId],
    )
    const recipeId = randomUUID()
    await pool.query(
      `INSERT INTO mbox.inventory_items (
         id, tenant_id, store_id, sku, name, item_type, base_unit
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '库存菜单测试瓶', 'bottle', 'bottle')`,
      [integrationStockItemId, integrationTenantId, integrationStoreId, `STOCK-${integrationStockItemId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.inventory_balances (
         tenant_id, store_id, inventory_item_id, on_hand_quantity, reserved_quantity
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 0, 0)`,
      [integrationTenantId, integrationStoreId, integrationStockItemId],
    )
    await pool.query(
      `INSERT INTO mbox.recipes (
         id, tenant_id, store_id, product_id, version, yield_quantity, status, effective_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, 'active', clock_timestamp() - interval '1 minute')`,
      [recipeId, integrationTenantId, integrationStoreId, integrationStockedProductId],
    )
    await pool.query(
      `INSERT INTO mbox.recipe_items (
         tenant_id, store_id, recipe_id, inventory_item_id, quantity
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)`,
      [integrationTenantId, integrationStoreId, recipeId, integrationStockItemId],
    )
    await pool.query(
      `INSERT INTO mbox.table_sessions (
         id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, DATE '2026-08-11', 2, 'open')`,
      [integrationSessionId, integrationTenantId, integrationStoreId, tableId, `gapi-session-${integrationSessionId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.table_session_customers (
         tenant_id, store_id, table_session_id, customer_id, relationship
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'primary')`,
      [integrationTenantId, integrationStoreId, integrationSessionId, integrationCustomerId],
    )
    const integrationActorRef=await seedActiveGuestTableAuthority(pool,{
      tenantId:integrationTenantId,storeId:integrationStoreId,
      tableSessionId:integrationSessionId,customerId:integrationCustomerId,
    })
    integrationContext = {
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      sessionKind: 'table',
      customerId: integrationCustomerId,
      tableSessionId: integrationSessionId,
      reservationId: null,
      tableCode: 'VIP3',
      tableDisplayName: 'VIP 3',
      businessDate: '2026-08-11',
      expiresAt: '2026-08-11T15:00:00.000Z',
      capabilities: ['guest.session.read', 'guest.service.create'],
      actorRef: integrationActorRef,
    }
    app = Fastify()
    app.register(guestCommerceServiceApiPlugin, {
      prefix: '/api',
      transactions,
      commandExecutor,
      commerce: { submitOrder: vi.fn() } as never,
      payments: { initiate: vi.fn() } as never,
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveGuestMethod: vi.fn(async () => 'native_qr'),
        resolveActivePayment: vi.fn(async () => null),
        create: vi.fn(),
      } as never,
      resolveGuestContext: async () => integrationContext,
      resolvePublicContext: async () => ({ scope: integrationContext.scope }),
      resolveDeviceFingerprint: () => 'wechat-device-api-postgres-0001',
      paymentMode: 'simulation',
      paymentActionSecret: 'integration-payment-action-secret-32-bytes',
      deviceServiceLimitPerMinute: 2,
      tableServiceLimitPerMinute: 20,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  it('loads a public read-only menu without a table session and fails closed when inventory setup is incomplete', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/public/mini/menu/products?search=${integrationProductId.slice(0, 8)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: [{ productId: integrationProductId, name: '公开菜单测试饮品', availabilityStatus: 'configuration_incomplete', available: false }],
      meta: { partySize: null, recommendationScene: null, orderingRequiresTableScan: true },
    })
  })

  it('keeps explicitly not-managed food orderable without inventing an inventory recipe', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/public/mini/menu/products?search=${integrationNotManagedProductId.slice(0, 8)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: [{ productId: integrationNotManagedProductId, name: '公开菜单测试小食', availabilityStatus: 'available', available: true }],
    })
  })

  it('hides a configured tracked drink at zero stock and restores it after stock is recorded', async () => {
    const unavailable = await app.inject({
      method: 'GET',
      url: `/api/public/mini/menu/products?search=${integrationStockedProductId.slice(0, 8)}`,
    })
    expect(unavailable.statusCode).toBe(200)
    expect(unavailable.json()).toMatchObject({
      data: [{ productId: integrationStockedProductId, availabilityStatus: 'inventory_unavailable', available: false }],
    })

    await pool.query(
      `UPDATE mbox.inventory_balances
       SET on_hand_quantity=2, updated_at=clock_timestamp()
       WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid`,
      [integrationTenantId, integrationStoreId, integrationStockItemId],
    )
    const available = await app.inject({
      method: 'GET',
      url: `/api/public/mini/menu/products?search=${integrationStockedProductId.slice(0, 8)}`,
    })
    expect(available.statusCode).toBe(200)
    expect(available.json()).toMatchObject({
      data: [{ productId: integrationStockedProductId, availabilityStatus: 'available', available: true }],
    })
  })

  it('records mood, audit and outbox without creating an employee task', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/guest/mood',
      headers: { 'idempotency-key': 'guest-mood-postgres-0001' },
      payload: { mood: 'happy' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      data: { recorded: true, mood: 'happy' },
      meta: { createsServiceTask: false },
    })
    const evidence = await pool.query<{ behaviors: string; tasks: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.guest_behavior_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid AND behavior_type = 'guest.mood.selected') AS behaviors,
        (SELECT count(*)::text FROM mbox.service_tasks
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS tasks,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND action = 'guest.mood.selected') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND message_type = 'guest.mood.selected.v1') AS outbox
    `, [integrationTenantId, integrationStoreId, integrationSessionId])
    expect(evidence.rows[0]).toEqual({ behaviors: '1', tasks: '0', audits: '1', outbox: '1' })
  })

  it('merges concurrent service clicks, persists rate limiting, then blocks stale session writes', async () => {
    const submit = (key: string) => app.inject({
      method: 'POST',
      url: '/api/guest/service-requests',
      headers: { 'idempotency-key': key },
      payload: { requestType: 'call_staff' },
    })
    const [first, second] = await Promise.all([
      submit('guest-service-api-concurrent-0001'),
      submit('guest-service-api-concurrent-0002'),
    ])
    expect([first.statusCode, second.statusCode].toSorted()).toEqual([200, 201])
    expect([first.json().data.status, second.json().data.status].toSorted()).toEqual(['created', 'merged'])

    const limited = await submit('guest-service-api-limited-0003')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({
      data: { status: 'rate_limited', message: '我们已经收到啦，伙伴正在赶来，请稍等一下' },
    })
    const evidence = await pool.query<{ tasks: string; groups: string; behaviors: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.service_tasks
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS tasks,
        (SELECT count(*)::text FROM mbox.guest_service_request_groups
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS groups,
        (SELECT count(*)::text FROM mbox.guest_behavior_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid
            AND behavior_type LIKE 'guest.service.%') AS behaviors,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND action LIKE 'guest.service.%') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND message_type LIKE 'guest.service.%.v1') AS outbox
    `, [integrationTenantId, integrationStoreId, integrationSessionId])
    expect(evidence.rows[0]).toEqual({ tasks: '1', groups: '1', behaviors: '3', audits: '3', outbox: '3' })

    const visible = await app.inject({ method: 'GET', url: '/api/guest/service-requests' })
    expect(visible.statusCode).toBe(200)
    expect(visible.json()).toMatchObject({
      data: [{ requestType: 'call_staff', status: 'pending', publicServiceName: null }],
      meta: { count: 1 },
    })
    expect(visible.body).not.toMatch(/detail|requestSnapshot|customerId|employeeId/i)
    const taskPublicId = visible.json().data[0].publicId as string
    const escalate = () => app.inject({
      method: 'POST',
      url: `/api/guest/service-requests/${taskPublicId}/feedback`,
      headers: { 'idempotency-key': 'guest-service-feedback-escalate-0001' },
      payload: { action: 'escalate' },
    })
    const escalated = await escalate()
    expect(escalated.statusCode).toBe(200)
    expect(escalated.json()).toMatchObject({
      data: { publicId: taskPublicId, action: 'escalate', recorded: true },
      meta: { replayed: false },
    })
    const escalatedReplay = await escalate()
    expect(escalatedReplay.statusCode).toBe(200)
    expect(escalatedReplay.json()).toMatchObject({ meta: { replayed: true } })
    const prematureConfirm = await app.inject({
      method: 'POST',
      url: `/api/guest/service-requests/${taskPublicId}/feedback`,
      headers: { 'idempotency-key': 'guest-service-feedback-confirm-early-0001' },
      payload: { action: 'confirm' },
    })
    expect(prematureConfirm.statusCode).toBe(409)
    expect(prematureConfirm.json()).toMatchObject({ error: { code: 'SERVICE_FEEDBACK_STATE_CONFLICT' } })

    const activeTask = await transactions.run(integrationContext.scope, (transaction) => (
      new ServiceTaskRepository(transaction).findActiveByTableSession(integrationSessionId)
    ), { readOnly: true })
    await transactions.run(integrationContext.scope, (transaction) => (
      new ServiceTaskRepository(transaction).complete({
        taskId: activeTask[0]!.id,
        actor: { type: 'system' },
        eventIdempotencyKey: 'guest-service-api-complete-0001',
      })
    ))
    const confirm = () => app.inject({
      method: 'POST',
      url: `/api/guest/service-requests/${taskPublicId}/feedback`,
      headers: { 'idempotency-key': 'guest-service-feedback-confirm-0001' },
      payload: { action: 'confirm' },
    })
    const confirmed = await confirm()
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toMatchObject({
      data: { publicId: taskPublicId, action: 'confirm', taskStatus: 'completed', recorded: true },
      meta: { replayed: false },
    })
    expect((await confirm()).json()).toMatchObject({ meta: { replayed: true } })
    const feedbackEvidence = await pool.query<{ escalations: string; confirmations: string; audits: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.service_task_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND service_task_id = $3::uuid AND event_type = 'guest.escalated') AS escalations,
        (SELECT count(*)::text FROM mbox.service_task_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND service_task_id = $3::uuid AND event_type = 'guest.confirmed') AS confirmations,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND object_id = $3::text AND action LIKE 'guest.service.%') AS audits
    `, [integrationTenantId, integrationStoreId, activeTask[0]!.id])
    expect(feedbackEvidence.rows[0]).toEqual({ escalations: '1', confirmations: '1', audits: '2' })

    const ownedContext = integrationContext
    integrationContext = { ...integrationContext, customerId: randomUUID() }
    const forbidden = await app.inject({ method: 'GET', url: '/api/guest/service-requests' })
    integrationContext = ownedContext
    expect(forbidden.statusCode).toBe(401)
    expect(forbidden.json()).toMatchObject({ error: { code: 'GUEST_SESSION_INVALID' } })

    await pool.query(`
      UPDATE mbox.table_sessions SET status = 'closing'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [integrationTenantId, integrationStoreId, integrationSessionId])
    const stale = await app.inject({
      method: 'POST',
      url: '/api/guest/mood',
      headers: { 'idempotency-key': 'guest-mood-after-turnover-0001' },
      payload: { mood: 'quiet' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'TABLE_SESSION_ENDED' } })
    const history = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.guest_behavior_events
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_session_id = $3::uuid
    `, [integrationTenantId, integrationStoreId, integrationSessionId])
    expect(history.rows[0]?.count).toBe('4')
  })
})

function fixture(overrides: Partial<GuestCommerceServiceApiOptions> = {}) {
  const paymentMode = overrides.paymentMode ?? 'wechat_jsapi'
  const query = vi.fn(async (sql: string) => sql.includes('lock_active_table_guest_session_position') ? ({
    rows:[{ participation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],rowCount:1,
  }) : sql.includes('WITH order_balances AS') ? ({
    rows: [{
      public_id: 'shared-order-0001', round_number: 1, channel: 'guest_qr',
      order_status: 'submitted', visibility: 'shared', is_mine: false,
      order_created_at: '2026-08-11T12:00:00.000Z', payment_status: 'unpaid',
      payment_access: 'available', payable_amount_minor: '13600', currency: 'CNY', product_id: productId,
      pricing_kind: 'gift',
      product_name: '青岛啤酒', quantity: 2, item_status: 'preparing',
    }],
    rowCount: 1,
  }) : ({
    rows: [{
      id: productId,
      code: 'BEER-QD-330',
      name: '青岛啤酒',
      category_code: 'beer',
      category_name: '啤酒',
      category_parent_code: 'drinks',
      category_parent_name: '酒水',
      category_sort_order: 20,
      top_category_sort_order: 20,
      fulfillment_station: 'bar',
      product_kind: 'single',
      bundle_components: [],
      product_snapshot: {
        specification: '330ml', aliases: ['青啤'], pinyin: 'qingdao pijiu', beverageFamily: 'wine',
        internalCost: 1234,
      },
      guest_visible: true,
      search_text: 'BEER-QD-330 青岛啤酒 青啤 qingdao pijiu 330ml',
      recommendation_beverage_family: 'beer',
      recommendation_enabled: true,
      recommendation_min_guests: 1,
      recommendation_max_guests: 4,
      recommendation_priority: 800,
      recommendation_scene_tags: ['date', 'friends'],
      recommendation_intent_tags: ['relaxed'],
      recommendation_taste_tags: ['refreshing'],
      recommendation_dwell_tags: ['one_set'],
      recommendation_single_wave_eligible: true,
      recommendation_expected_prep_minutes: 3,
      recommendation_hold_minutes: 10,
      recommendation_upgrade_product_id: null,
      menu_sort_order: 20,
      available_from: null,
      available_until: null,
      max_order_quantity: 50,
      within_availability: true,
      cost_amount_minor: '1800',
      status: 'active',
      amount_minor: '6800',
      currency: 'CNY',
      guest_count: 2,
      guest_profile_snapshot: { recommendationScene: 'date' },
      inventory_configuration_complete: true,
      inventory_available: true,
    }],
    rowCount: 1,
  }))
  const transaction = { scope: context.scope, query } as unknown as ScopedTransaction
  const transactions: GuestCommerceServiceApiOptions['transactions'] = {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  }
  const commerce = {
    submitOrder: vi.fn(async () => ({ value: commerceResult(), replayed: false })),
  }
  const payments = {
    initiate: vi.fn(async (input: { provider: Payment['provider']; method: Payment['method'] }) => ({
      value: paymentResult(input.provider, input.method),
      replayed: false,
    })),
  }
  const onlinePayments = overrides.onlinePayments ?? {
    assertAvailable: vi.fn(),
    resolveGuestMethod: vi.fn(async () => 'jsapi' as const),
    resolveActivePayment: vi.fn(async () => null),
    create: vi.fn(async () => paymentAction(paymentMode === 'simulation' ? 'qr' : 'jsapi')),
  }
  const options: GuestCommerceServiceApiOptions = {
    transactions,
    commandExecutor: { execute: vi.fn() } as never,
    commerce,
    payments,
    onlinePayments,
    resolveGuestContext: async () => context,
    resolvePublicContext: async () => ({ scope: context.scope }),
    resolveDeviceFingerprint: () => 'wechat-device-api-unit-test-0001',
    paymentMode,
    paymentActionSecret: 'unit-payment-action-secret-at-least-32-bytes',
    createPublicId: (kind) => `guest-${kind}-public-0001`,
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(guestCommerceServiceApiPlugin, { prefix: '/api', ...options })
  return { app, options, transactions, query, commerce, payments }
}

function paymentAction(presentation: 'jsapi' | 'qr' | 'barcode') {
  return {
    paymentId,
    paymentPublicId: 'guest-payment-public-0001',
    orderPublicId: 'guest-order-public-0001',
    status: 'pending' as const,
    presentation,
    expiresAt: '2026-08-11T12:05:00.000Z',
    payload: presentation === 'jsapi'
      ? { appId: 'wx-app-1', package: 'prepay_id=test' }
      : { qrCodeUrl: 'https://pay.example.test/order/1' },
  }
}

function commerceResult(): SubmittedCommerceResult {
  return {
    order: {
      id: orderId,
      tableSessionId,
      publicId: 'guest-order-public-0001',
      channel: 'guest_qr',
      settlementMode: 'immediate_payment',
      status: 'submitted',
      paymentStatus: 'unpaid',
      subtotalAmountMinor: 13_600,
      discountAmountMinor: 0,
      totalAmountMinor: 13_600,
      currency: 'CNY',
      note: '一起上，生日桌',
      createdByEmployeeId: null,
      createdByCustomerId: customerId,
      createdAt: '2026-08-11T12:00:00.000Z',
      submittedAt: '2026-08-11T12:00:00.000Z',
      items: [{
        id: orderItemId,
        orderId,
        productId,
        parentOrderItemId: null,
        billable: true,
        consumesInventory: true,
        quantity: 2,
        unitPriceMinor: 6800,
        discountAmountMinor: 0,
        totalAmountMinor: 13_600,
        currency: 'CNY',
        fulfillmentStation: 'bar',
        productSnapshot: { name: '青岛啤酒' },
        costSnapshot: {},
        status: 'submitted',
        note: '少冰',
        createdAt: '2026-08-11T12:00:00.000Z',
      }, {
        id: operationalOrderItemId,
        orderId,
        productId: '55555555-5555-4555-8555-555555555556',
        parentOrderItemId: orderItemId,
        billable: false,
        consumesInventory: true,
        quantity: 2,
        unitPriceMinor: 0,
        discountAmountMinor: 0,
        totalAmountMinor: 0,
        currency: 'CNY',
        fulfillmentStation: 'bar',
        productSnapshot: { name: '套餐履约子项' },
        costSnapshot: {},
        status: 'submitted',
        note: '少冰',
        createdAt: '2026-08-11T12:00:00.000Z',
      }],
    },
    kdsTasks: [],
    inventoryConsumptions: [],
    paymentNextStep: {
      status: 'required',
      action: 'create_payment_intent',
      orderId,
      amountMinor: 13_600,
      currency: 'CNY',
      paymentStatus: 'unpaid',
    },
  }
}

function paymentResult(provider: Payment['provider'], method: Payment['method']): Payment {
  return {
    id: paymentId,
    orderId,
    publicId: 'guest-payment-public-0001',
    provider,
    providerTransactionId: null,
    method,
    amountMinor: 13_600,
    currency: 'CNY',
    status: 'pending',
    providerSnapshot: {},
    succeededAt: null,
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:00:00.000Z',
  }
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values === undefined ? undefined : [...values]),
    release: (error) => client.release(error),
  }
}
