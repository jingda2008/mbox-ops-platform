import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type { SubmittedCommerceResult } from './commerce-command-service.js'
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
  actorRef: 'guest-session:api-unit-test-session',
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('guest commerce/service API trust boundaries', () => {
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

  it('searches menu names, aliases, pinyin and specifications without exposing snapshots', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/guest/menu/products?search=qingdao&limit=20',
    })
    expect(response.statusCode).toBe(200)
    expect(value.query).toHaveBeenCalledWith(
      expect.stringContaining("product.product_snapshot ->> 'pinyin'"),
      expect.arrayContaining(['qingdao']),
    )
    expect(value.query.mock.calls[0]?.[0]).toContain(
      "product.product_snapshot -> 'recommendation' ->> 'priority' ~ '^\\d{1,4}$'",
    )
    expect(response.json()).toMatchObject({
      data: [{
        productId,
        name: '青岛啤酒',
        specification: '330ml',
        amountMinor: 6800,
        available: true,
      }],
    })
    expect(response.body).not.toContain('internalCost')
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
      principal: { type: 'guest', tableSessionId, customerId },
    }))
    expect(response.json()).toMatchObject({
      data: {
        cart: { itemCount: 2, lineCount: 1 },
        order: {
          publicId: 'guest-order-public-0001',
          attentionRequired: true,
          kdsNotice: '订单含备注，出品与配送页面将重点提示',
        },
        settlement: { payableAmountMinor: 13_600, currency: 'CNY' },
        payment: {
          mode: 'wechat_jsapi',
          provider: 'postar',
          method: 'jsapi',
          status: 'pending',
          simulated: false,
          providerAction: 'provider_order_required',
        },
      },
    })
  })

  it('shares paid table orders without payer or payment details', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/guest/orders/table' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: [{
      publicId: 'shared-order-0001', round: 1, visibility: 'shared', isMine: false,
      items: [{ productId, name: '青岛啤酒', quantity: 2, status: 'preparing' }],
    }] })
    expect(response.body).not.toMatch(/customerId|provider|paymentStatus|amountMinor/)
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
        providerAction: 'simulation_confirmation_required',
      } },
    })
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
      capabilities: ['guest.service.create'],
      actorRef: 'guest-session:api-postgres-integration-session',
    }
    app = Fastify()
    app.register(guestCommerceServiceApiPlugin, {
      prefix: '/api',
      transactions,
      commandExecutor,
      commerce: { submitOrder: vi.fn() } as never,
      payments: { initiate: vi.fn() } as never,
      resolveGuestContext: async () => integrationContext,
      resolveDeviceFingerprint: () => 'wechat-device-api-postgres-0001',
      paymentMode: 'simulation',
      deviceServiceLimitPerMinute: 2,
      tableServiceLimitPerMinute: 20,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
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
  const query = vi.fn(async (sql: string) => sql.includes('WITH table_orders AS') ? ({
    rows: [{
      public_id: 'shared-order-0001', round_number: 1, channel: 'guest_qr',
      order_status: 'submitted', visibility: 'shared', is_mine: false,
      order_created_at: '2026-08-11T12:00:00.000Z', product_id: productId,
      product_name: '青岛啤酒', quantity: 2, item_status: 'preparing',
    }],
    rowCount: 1,
  }) : ({
    rows: [{
      id: productId,
      code: 'BEER-QD-330',
      name: '青岛啤酒',
      category_code: 'beer',
      fulfillment_station: 'bar',
      product_kind: 'single',
      bundle_components: [],
      product_snapshot: {
        specification: '330ml', aliases: ['青啤'], pinyin: 'qingdao pijiu', internalCost: 1234,
      },
      status: 'active',
      amount_minor: '6800',
      currency: 'CNY',
      guest_count: 2,
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
  const options: GuestCommerceServiceApiOptions = {
    transactions,
    commandExecutor: { execute: vi.fn() } as never,
    commerce,
    payments,
    resolveGuestContext: async () => context,
    resolveDeviceFingerprint: () => 'wechat-device-api-unit-test-0001',
    paymentMode: 'wechat_jsapi',
    createPublicId: (kind) => `guest-${kind}-public-0001`,
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(guestCommerceServiceApiPlugin, { prefix: '/api', ...options })
  return { app, options, transactions, query, commerce, payments }
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
