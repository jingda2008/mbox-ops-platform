import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  NormalizedCommandExecutor,
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './index.js'
import { CommerceCommandService } from './commerce-command-service.js'
import { InsufficientInventoryError } from './inventory-repository.js'
import { PostgresPricingAuthority } from './postgres-pricing-authority.js'
import {
  PricingAuthorizationDeniedError,
  PricingAuthorizationPolicy,
} from './pricing-authorization-policy.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const tenantId = randomUUID()
const storeId = randomUUID()
const areaId = randomUUID()
const tableIds = [randomUUID(), randomUUID(), randomUUID()]
const sessionIds = [randomUUID(), randomUUID(), randomUUID()]
const employeeId = randomUUID()
const deniedEmployeeId = randomUUID()
const roleId = randomUUID()
const deniedRoleId = randomUUID()
const discountLimitId = randomUUID()
const deniedLimitId = randomUUID()
let permissionId: string
const denyOverrideId = randomUUID()
const customerId = randomUUID()
const unlinkedCustomerId = randomUUID()
const discountBenefitId = randomUUID()
const rollbackBenefitId = randomUUID()
const unlinkedBenefitId = randomUUID()
const expiredBenefitId = randomUUID()
const foreignCurrencyBenefitId = randomUUID()
const concurrentBenefitId = randomUUID()
const productId = randomUUID()
const inventoryId = randomUUID()
const recipeId = randomUUID()

describe('PostgresPricingAuthority deterministic rejection', () => {
  it('rejects activity pricing before querying because no authoritative activity table exists', async () => {
    const transaction: ScopedTransaction = {
      scope: { tenantId, storeId },
      query: async () => {
        throw new Error('activity rejection must not query the database')
      },
    }
    await expect(new PostgresPricingAuthority().authorize(transaction, {
      scope: transaction.scope,
      actor: { type: 'guest', ref: 'activity-attack' },
      tableSessionId: sessionIds[0]!,
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1 }],
      request: { sourceType: 'activity', sourceId: randomUUID() },
    })).rejects.toThrow('authoritative activity table')
  })
})

integration('PostgresPricingAuthority PostgreSQL authorization integrity', () => {
  let pool: Pool
  let service: CommerceCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    await seed(pool)
    service = new CommerceCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      new PostgresPricingAuthority(),
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('derives employee discount from active role permission and consumes it with the order', async () => {
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    const identifiers = await runner.run({ tenantId, storeId }, async (transaction) => {
      await insertApprovalLimit(transaction, discountLimitId, 'order.discount', 2000, {
        discountBasisPoints: 1000,
      })
      const policy = new PricingAuthorizationPolicy(new PostgresPricingAuthority())
      const authorization = await policy.authorize(transaction, {
        scope: transaction.scope,
        actor: { type: 'employee', employeeId },
        tableSessionId: sessionIds[0]!,
        channel: 'staff_assisted',
        lines: [{ productId, quantity: 1 }],
      }, { sourceType: 'employee', sourceId: discountLimitId })
      const order = await transaction.query<{ id: string }>(`
        INSERT INTO mbox.orders(
          tenant_id, store_id, table_session_id, public_id, channel, status,
          payment_status, subtotal_amount_minor, discount_amount_minor,
          total_amount_minor, currency, created_by_employee_id, submitted_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'pricing-employee-order', 'staff_assisted',
          'submitted', 'unpaid', 8800, $4::bigint, 8800 - $4::bigint, 'CNY',
          $5::uuid, clock_timestamp()
        ) RETURNING id
      `, [tenantId, storeId, sessionIds[0], authorization!.amountMinor, employeeId])
      await policy.consume(transaction, authorization!, order.rows[0]!.id)
      return { authorizationId: authorization!.authorizationId, orderId: order.rows[0]!.id }
    })
    const evidence = await pool.query<{ status: string; orders: string; authorizations: string }>(`
      SELECT pricing_authorization.status,
        count(DISTINCT pricing_authorization.order_id)::text AS orders,
        count(*)::text AS authorizations
      FROM mbox.pricing_authorizations AS pricing_authorization
      WHERE pricing_authorization.tenant_id = $1::uuid
        AND pricing_authorization.store_id = $2::uuid
        AND pricing_authorization.table_session_id = $3::uuid
        AND pricing_authorization.source_id = $4::uuid
      GROUP BY pricing_authorization.status
    `, [tenantId, storeId, sessionIds[0], discountLimitId])
    expect(evidence.rows[0]).toEqual({ status: 'consumed', orders: '1', authorizations: '1' })
    expect(identifiers.authorizationId).toBeTruthy()
    expect(identifiers.orderId).toBeTruthy()
  })

  it('does not trust a guest presenting an employee approval source', async () => {
    await expect(service.submitOrder({
      ...baseOrder(sessionIds[2]!, 'pricing-forged-employee', 'pricing-forged-employee-0001'),
      pricingAuthorization: { sourceType: 'employee', sourceId: discountLimitId },
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    await expectNoOrder('pricing-forged-employee')
  })

  it('honours an explicit permission deny even while the role grants the capability', async () => {
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await expect(runner.run({ tenantId, storeId }, async (transaction) => {
      await insertApprovalLimit(transaction, deniedLimitId, 'order.discount', 2000, {
        fixedAmountMinor: 500,
      }, deniedRoleId)
      return new PostgresPricingAuthority().authorize(transaction, {
        scope: transaction.scope,
        actor: { type: 'employee', employeeId: deniedEmployeeId },
        tableSessionId: sessionIds[2]!,
        channel: 'staff_assisted',
        lines: [{ productId, quantity: 1 }],
        request: { sourceType: 'employee', sourceId: deniedLimitId },
      })
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    await expectNoOrder('pricing-denied-employee')
  })

  it('requires a normalized customer-table link before reserving a benefit', async () => {
    await expect(service.submitOrder({
      ...baseOrder(sessionIds[2]!, 'pricing-unlinked-benefit', 'pricing-unlinked-benefit-0001'),
      pricingAuthorization: { sourceType: 'benefit', sourceId: unlinkedBenefitId },
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    const benefit = await pool.query<{ status: string }>(`
      SELECT status FROM mbox.benefits WHERE id = $1::uuid
    `, [unlinkedBenefitId])
    expect(benefit.rows[0]?.status).toBe('issued')
  })

  it('rejects expired and foreign-currency benefits from server data', async () => {
    for (const [sourceId, publicId] of [
      [expiredBenefitId, 'pricing-expired-benefit'],
      [foreignCurrencyBenefitId, 'pricing-foreign-benefit'],
    ] as const) {
      await expect(service.submitOrder({
        ...baseOrder(sessionIds[1]!, publicId, `${publicId}-0001`),
        pricingAuthorization: { sourceType: 'benefit', sourceId },
      })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
      await expectNoOrder(publicId)
    }
  })

  it('reserves and redeems a linked benefit atomically', async () => {
    const result = await service.submitOrder({
      ...baseOrder(sessionIds[1]!, 'pricing-benefit-order', 'pricing-benefit-order-0001'),
      pricingAuthorization: { sourceType: 'benefit', sourceId: discountBenefitId },
    })
    expect(result.value.order).toMatchObject({
      subtotalAmountMinor: 8800,
      discountAmountMinor: 500,
      totalAmountMinor: 8300,
    })
    const evidence = await pool.query<{ benefit_status: string; authorization_status: string }>(`
      SELECT benefit.status AS benefit_status, pricing_authorization.status AS authorization_status
      FROM mbox.benefits AS benefit
      JOIN mbox.pricing_authorizations AS pricing_authorization
        ON pricing_authorization.benefit_id = benefit.id
      WHERE benefit.id = $1::uuid
    `, [discountBenefitId])
    expect(evidence.rows[0]).toEqual({
      benefit_status: 'redeemed',
      authorization_status: 'consumed',
    })
  })

  it('does not allow a consumed authorization record to be consumed again', async () => {
    const authorization = await pool.query<{
      id: string
      kind: 'discount' | 'gift'
      source_type: 'employee' | 'benefit'
      source_id: string
      amount_minor: string
      maximum_amount_minor: string
      currency: string
      authorized_by_employee_id: string | null
      capability: string | null
      order_id: string
    }>(`
      SELECT id, kind, source_type, source_id, amount_minor::text,
        maximum_amount_minor::text, currency, authorized_by_employee_id,
        capability, order_id
      FROM mbox.pricing_authorizations
      WHERE source_id = $1::uuid AND status = 'consumed'
    `, [discountBenefitId])
    const row = authorization.rows[0]!
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await expect(runner.run({ tenantId, storeId }, (transaction) => (
      new PostgresPricingAuthority().consume(transaction, {
        authorizationId: row.id,
        kind: row.kind,
        sourceType: row.source_type,
        sourceId: row.source_id,
        amountMinor: Number(row.amount_minor),
        maximumAmountMinor: Number(row.maximum_amount_minor),
        currency: row.currency,
        authorizedByEmployeeId: row.authorized_by_employee_id,
        capability: row.capability,
      }, row.order_id)
    ))).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
  })

  it('rolls benefit reservation and authorization back when inventory fails later', async () => {
    await expect(service.submitOrder({
      ...baseOrder(sessionIds[1]!, 'pricing-benefit-rollback', 'pricing-benefit-rollback-0001', 100),
      pricingAuthorization: { sourceType: 'benefit', sourceId: rollbackBenefitId },
    })).rejects.toBeInstanceOf(InsufficientInventoryError)
    const evidence = await pool.query<{ benefit_status: string; authorizations: string; orders: string }>(`
      SELECT benefit.status AS benefit_status,
        (SELECT count(*)::text FROM mbox.pricing_authorizations WHERE source_id = benefit.id) AS authorizations,
        (SELECT count(*)::text FROM mbox.orders WHERE public_id = 'pricing-benefit-rollback') AS orders
      FROM mbox.benefits AS benefit
      WHERE benefit.id = $1::uuid
    `, [rollbackBenefitId])
    expect(evidence.rows[0]).toEqual({ benefit_status: 'issued', authorizations: '0', orders: '0' })
  })

  it('allows only one concurrent use of the same server source for a table session', async () => {
    const outcomes = await Promise.allSettled([
      service.submitOrder({
        ...baseOrder(sessionIds[2]!, 'pricing-concurrent-one', 'pricing-concurrent-one-0001'),
        pricingAuthorization: { sourceType: 'benefit', sourceId: concurrentBenefitId },
      }),
      service.submitOrder({
        ...baseOrder(sessionIds[2]!, 'pricing-concurrent-two', 'pricing-concurrent-two-0001'),
        pricingAuthorization: { sourceType: 'benefit', sourceId: concurrentBenefitId },
      }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const evidence = await pool.query<{ authorizations: string; orders: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.pricing_authorizations
          WHERE table_session_id = $1::uuid AND source_id = $2::uuid) AS authorizations,
        (SELECT count(*)::text FROM mbox.orders
          WHERE public_id IN ('pricing-concurrent-one', 'pricing-concurrent-two')) AS orders
    `, [sessionIds[2], concurrentBenefitId])
    expect(evidence.rows[0]).toEqual({ authorizations: '1', orders: '1' })
  })

  async function expectNoOrder(publicId: string): Promise<void> {
    const result = await pool.query<{ orders: string }>(`
      SELECT count(*)::text AS orders FROM mbox.orders WHERE public_id = $1
    `, [publicId])
    expect(result.rows[0]?.orders).toBe('0')
  }
})

function baseOrder(
  sessionId: string,
  publicId: string,
  idempotencyKey: string,
  quantity = 1,
) {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'guest' as const, ref: 'pricing-test' },
    businessDate: '2026-08-11',
    tableSessionId: sessionId,
    publicId,
    channel: 'guest_qr' as const,
    createdByCustomerId: customerId,
    lines: [{ productId, quantity }],
    idempotencyKey,
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

async function insertApprovalLimit(
  transaction: ScopedTransaction,
  id: string,
  approvalCode: 'order.discount' | 'order.gift',
  amountMinor: number,
  rules: Record<string, unknown>,
  approvalRoleId = roleId,
): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.role_approval_limits(
      id, tenant_id, store_id, role_id, approval_code,
      amount_minor, currency, rules, enabled
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, 'CNY', $7::jsonb, true)
  `, [id, tenantId, storeId, approvalRoleId, approvalCode, amountMinor, JSON.stringify(rules)])
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Pricing Tenant')`, [tenantId, `pricing-${tenantId.slice(0, 8)}`])
  await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, $3, 'Pricing Store')`, [storeId, tenantId, `pricing-${storeId.slice(0, 8)}`])
  await pool.query(`INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'PRICING', 'Pricing', 'indoor')`, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
    SELECT id, $3::uuid, $4::uuid, $5::uuid, code, code, 4
    FROM unnest($1::uuid[], $2::text[]) AS source(id, code)
  `, [tableIds, ['PT01', 'PT02', 'PT03'], tenantId, storeId, areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status)
    SELECT session_id, $4::uuid, $5::uuid, table_id, public_id, '2026-08-11', 2, 'open'
    FROM unnest($1::uuid[], $2::uuid[], $3::text[])
      AS source(session_id, table_id, public_id)
  `, [sessionIds, tableIds, ['pricing-session-one', 'pricing-session-two', 'pricing-session-three'], tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status) VALUES
      ($1, $3, $4, 'PRICE_OK', 'Pricing Employee', 'active'),
      ($2, $3, $4, 'PRICE_DENY', 'Denied Employee', 'active')
  `, [employeeId, deniedEmployeeId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name, capabilities, status) VALUES
      ($1, $3, $4, 'PRICE_ROLE', 'Pricing Role',
        ARRAY['order.discount', 'order.gift', 'kds.prepare'], 'active'),
      ($2, $3, $4, 'PRICE_DENIED_ROLE', 'Denied Pricing Role',
        ARRAY['order.discount', 'kds.prepare'], 'active')
  `, [roleId, deniedRoleId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id) VALUES
      ($1, $2, $3, $5), ($1, $2, $4, $6)
  `, [tenantId, storeId, employeeId, deniedEmployeeId, roleId, deniedRoleId])
  const permission = await pool.query<{ id: string }>(`
    INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
    VALUES ($1, $2, 'order.discount', 'Order discount')
    ON CONFLICT (tenant_id, store_id, code) DO UPDATE
    SET name = EXCLUDED.name
    RETURNING id
  `, [tenantId, storeId])
  permissionId = permission.rows[0]!.id
  await pool.query(`
    INSERT INTO mbox.employee_permission_overrides(
      id, tenant_id, store_id, employee_id, permission_id, effect, reason, configured_by_employee_id
    ) VALUES ($1, $2, $3, $4, $5, 'deny', 'test explicit deny', $6)
  `, [denyOverrideId, tenantId, storeId, deniedEmployeeId, permissionId, employeeId])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id, status) VALUES
      ($1, $3, $4, 'pricing-customer-linked', 'active'),
      ($2, $3, $4, 'pricing-customer-unlinked', 'active')
  `, [customerId, unlinkedCustomerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.table_session_customers(tenant_id, store_id, table_session_id, customer_id, relationship)
    VALUES
      ($1, $2, $3, $5, 'primary'),
      ($1, $2, $4, $5, 'primary'),
      ($1, $2, $6, $5, 'primary')
  `, [tenantId, storeId, sessionIds[0], sessionIds[1], customerId, sessionIds[2]])
  await pool.query(`
    INSERT INTO mbox.benefits(
      id, tenant_id, store_id, customer_id, benefit_code, benefit_type, status,
      value_amount_minor, currency, benefit_snapshot, valid_from, valid_until
    ) VALUES
      ($1, $4, $5, $6, 'PRICE500', 'discount', 'issued', 500, 'CNY', '{}',
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day'),
      ($2, $4, $5, $6, 'ROLLBACKGIFT', 'gift_product', 'issued', 900000, 'CNY',
        jsonb_build_object('allowedProductIds', jsonb_build_array($7::text)),
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day'),
      ($3, $4, $5, $8, 'UNLINKED500', 'discount', 'issued', 500, 'CNY', '{}',
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day'),
      ($9, $4, $5, $6, 'EXPIRED500', 'discount', 'issued', 500, 'CNY', '{}',
        clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'),
      ($10, $4, $5, $6, 'USD500', 'discount', 'issued', 500, 'USD', '{}',
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day'),
      ($11, $4, $5, $6, 'CONCURRENT500', 'discount', 'issued', 500, 'CNY', '{}',
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day')
  `, [
    discountBenefitId, rollbackBenefitId, unlinkedBenefitId,
    tenantId, storeId, customerId, productId, unlinkedCustomerId,
    expiredBenefitId, foreignCurrencyBenefitId, concurrentBenefitId,
  ])
  await pool.query(`
    INSERT INTO mbox.products(
      id, tenant_id, store_id, code, name, category_code,
      fulfillment_station, product_snapshot
    ) VALUES (
      $1, $2, $3, 'PRICE-PRODUCT', 'Pricing Product', 'drink', 'bar',
      '{"maxOrderQuantity": 100}'::jsonb
    )
  `, [productId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.product_prices(tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from)
    VALUES ($1, $2, $3, 'standard', 8800, 'CNY', clock_timestamp() - interval '1 day')
  `, [tenantId, storeId, productId])
  await pool.query(`
    INSERT INTO mbox.inventory_items(id, tenant_id, store_id, sku, name, item_type, base_unit)
    VALUES ($1, $2, $3, 'PRICE-ING', 'Pricing Ingredient', 'ingredient', 'ml')
  `, [inventoryId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.recipes(id, tenant_id, store_id, product_id, version, yield_quantity, status, effective_at)
    VALUES ($1, $2, $3, $4, 1, 1, 'active', clock_timestamp() - interval '1 day')
  `, [recipeId, tenantId, storeId, productId])
  await pool.query(`
    INSERT INTO mbox.recipe_items(tenant_id, store_id, recipe_id, inventory_item_id, quantity)
    VALUES ($1, $2, $3, $4, 1)
  `, [tenantId, storeId, recipeId, inventoryId])
  await pool.query(`
    INSERT INTO mbox.inventory_balances(tenant_id, store_id, inventory_item_id, on_hand_quantity)
    VALUES ($1, $2, $3, 20)
  `, [tenantId, storeId, inventoryId])
}
