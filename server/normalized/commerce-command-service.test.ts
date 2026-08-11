import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type {
  CommandOutcome,
  IdempotentCommand,
  PostgresPool,
  ScopedTransaction,
} from './index.js'
import {
  IdempotencyConflictError,
  NormalizedCommandExecutor,
  ScopedPostgresTransactionRunner,
} from './index.js'
import { CommerceCommandService, type SubmittedCommerceResult } from './commerce-command-service.js'
import { InsufficientInventoryError } from './inventory-repository.js'
import { KdsRepository } from './kds-repository.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import {
  PricingAuthorizationDeniedError,
  type PricingAuthorityContext,
  type PricingAuthorityDecision,
  type PricingAuthorityPort,
} from './pricing-authorization-policy.js'

const tenantId = randomUUID()
const storeId = randomUUID()
const areaId = randomUUID()
const tableOneId = randomUUID()
const tableTwoId = randomUUID()
const sessionOneId = randomUUID()
const sessionTwoId = randomUUID()
const productAId = randomUUID()
const productBId = randomUUID()
const productKitchenId = randomUUID()
const bundleProductId = randomUUID()
const inventoryAId = randomUUID()
const inventoryBId = randomUUID()
const inventoryKitchenId = randomUUID()
const recipeAId = randomUUID()
const recipeBId = randomUUID()
const recipeKitchenId = randomUUID()
const employeeId = randomUUID()
const kdsRoleId = randomUUID()
const pricingAuthorizationId = randomUUID()

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>() {
    const response = this.responses.shift()
    if (!response) throw new Error('Unexpected query')
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

class RecordingExecutor {
  outcome: CommandOutcome<SubmittedCommerceResult> | null = null
  constructor(private readonly transaction: ScopedTransaction) {}
  async execute<Result>(
    _command: Readonly<IdempotentCommand<Result>>,
    handler: (transaction: ScopedTransaction) => Promise<CommandOutcome<Result>>,
  ) {
    const outcome = await handler(this.transaction)
    this.outcome = outcome as unknown as CommandOutcome<SubmittedCommerceResult>
    return { value: outcome.result, replayed: false }
  }
}

class RecordingPricingAuthority implements PricingAuthorityPort {
  calls: PricingAuthorityContext[] = []
  authorizeTransactions: ScopedTransaction[] = []
  consumeCalls: Array<{
    transaction: ScopedTransaction
    authorizationId: string
    orderId: string
  }> = []

  constructor(private readonly decision: PricingAuthorityDecision) {}

  async authorize(_transaction: ScopedTransaction, context: Readonly<PricingAuthorityContext>) {
    this.authorizeTransactions.push(_transaction)
    this.calls.push(context)
    return this.decision
  }

  async consume(
    transaction: ScopedTransaction,
    authorization: Readonly<{ authorizationId: string }>,
    orderId: string,
  ) {
    this.consumeCalls.push({ transaction, authorizationId: authorization.authorizationId, orderId })
  }
}

describe('CommerceCommandService unit transaction composition', () => {
  it('composes order, inventory and KDS writes before returning audit and outbox evidence', async () => {
    const orderId = 'b1000000-0000-4000-8000-000000000001'
    const orderItemId = 'b1000000-0000-4000-8000-000000000002'
    const movementId = 'b1000000-0000-4000-8000-000000000003'
    const kdsTaskId = 'b1000000-0000-4000-8000-000000000004'
    const transaction = new ScriptedTransaction([
      { rows: [{ id: sessionOneId }] },
      { rows: [{ request_index: 0, product_id: productAId, product_code: 'A', product_name: 'A', category_code: 'drink', product_kind: 'single', fulfillment_station: 'bar', product_snapshot: {}, price_type: 'standard', amount_minor: '8800', currency: 'CNY', store_timezone: 'Asia/Shanghai', store_local_time: '20:00', store_iso_weekday: 1 }] },
      { rows: [{ id: orderId, table_session_id: sessionOneId, public_id: 'unit-order-0001', channel: 'integration', settlement_mode: 'immediate_payment', status: 'submitted', payment_status: 'unpaid', subtotal_amount_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', note: null, created_by_employee_id: null, created_at: '2026-08-11T12:00:00.000Z', submitted_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ id: orderItemId, order_id: orderId, product_id: productAId, parent_order_item_id: null, quantity: 1, unit_price_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', fulfillment_station: 'bar', product_snapshot: {}, cost_snapshot: {}, status: 'submitted', note: null, created_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ order_item_id: orderItemId, inventory_item_id: inventoryAId, sku: 'A-ING', required_quantity: '1.000000' }] },
      { rows: [{ inventory_item_id: inventoryAId, sku: 'A-ING', on_hand_quantity: '10.000000', reserved_quantity: '0.000000', required_quantity: '1.000000', insufficient: false }] },
      { rows: [{ id: movementId }] },
      { rows: [{ on_hand_quantity: '9.000000' }] },
      { rows: [{ id: kdsTaskId, order_item_id: orderItemId, station_code: 'bar', status: 'pending', priority: 100, quantity: 1, assigned_employee_id: null, due_at: null, next_action_at: '2026-08-11T12:00:00Z', accepted_at: null, ready_at: null, cancelled_at: null }] },
      { rows: [], rowCount: 1 },
    ])
    const executor = new RecordingExecutor(transaction)
    const result = await new CommerceCommandService(executor).submitOrder({
      ...command('unit-order-0001', sessionOneId, productAId, 1, 'unit-command-0001'),
      settlementMode: 'immediate_payment',
    })
    expect(result.value.order.id).toBe(orderId)
    expect(result.value.inventoryConsumptions).toHaveLength(1)
    expect(result.value.kdsTasks).toHaveLength(1)
    expect(result.value.paymentNextStep).toEqual({
      status: 'required', action: 'create_payment_intent', orderId,
      amountMinor: 8800, currency: 'CNY', paymentStatus: 'unpaid',
    })
    expect(executor.outcome?.auditEvents).toHaveLength(1)
    expect(executor.outcome?.outboxMessages).toHaveLength(1)
  })

  it('rejects an adjustment above the authority limit before order, inventory or KDS writes', async () => {
    const executor = new RecordingExecutor(new ScriptedTransaction([]))
    const authority = employeePricingAuthority(101, 'discount', 100)
    const service = new CommerceCommandService(executor, authority)

    await expect(service.submitOrder({
      ...command('unit-order-over-limit', sessionOneId, productAId, 1, 'unit-over-limit-0001'),
      actor: { type: 'employee', employeeId },
      createdByEmployeeId: employeeId,
      pricingAuthorization: {
        sourceType: 'employee',
        sourceId: employeeId,
      },
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    expect(authority.calls).toHaveLength(1)
    expect(executor.outcome).toBeNull()
  })

  it('rejects a client-supplied adjustment amount instead of forwarding it to the authority', async () => {
    const executor = new RecordingExecutor(new ScriptedTransaction([]))
    const authority = employeePricingAuthority(8800, 'gift')
    const clientControlledAuthorization = {
      sourceType: 'employee' as const,
      sourceId: employeeId,
      requestedAmountMinor: 8800,
    }
    await expect(new CommerceCommandService(executor, authority).submitOrder({
      ...command('unit-client-priced-gift', sessionOneId, productAId, 1, 'unit-client-price-0001'),
      actor: { type: 'employee', employeeId },
      createdByEmployeeId: employeeId,
      pricingAuthorization: clientControlledAuthorization,
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    expect(authority.calls).toHaveLength(0)
    expect(executor.outcome).toBeNull()
  })

  it('rejects a guest presenting an employee pricing source even when a port claims approval', async () => {
    const executor = new RecordingExecutor(new ScriptedTransaction([]))
    const authority = employeePricingAuthority(8800, 'gift')
    await expect(new CommerceCommandService(executor, authority).submitOrder({
      ...command('unit-guest-forged-gift', sessionOneId, productAId, 1, 'unit-guest-gift-0001'),
      channel: 'guest_qr',
      pricingAuthorization: {
        sourceType: 'employee',
        sourceId: employeeId,
      },
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    expect(authority.calls).toHaveLength(1)
    expect(executor.outcome).toBeNull()
  })

  it('requires a dedicated live permission and reason for manual KDS scheduling override', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [{ id: employeeId, employee_code: 'LIYAN', display_name: '李艳', status: 'active' }] },
      { rows: [{ code: 'MANAGER', name: '店长' }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ])
    const executor = new RecordingExecutor(transaction)
    await expect(new CommerceCommandService(executor).submitOrder({
      ...command('unit-kds-override', sessionOneId, productAId, 1, 'unit-kds-override-0001'),
      actor: { type: 'employee', employeeId },
      createdByEmployeeId: employeeId,
      channel: 'cashier',
      kdsOverride: { priority: 900, reason: '经理确认生日桌优先制作' },
    })).rejects.toBeInstanceOf(StaffAccessDeniedError)
    expect(executor.outcome).toBeNull()
  })

  it('allows a fully authorized gift while preserving its source in audit and outbox', async () => {
    const orderId = 'b2000000-0000-4000-8000-000000000001'
    const orderItemId = 'b2000000-0000-4000-8000-000000000002'
    const movementId = 'b2000000-0000-4000-8000-000000000003'
    const kdsTaskId = 'b2000000-0000-4000-8000-000000000004'
    const transaction = new ScriptedTransaction([
      { rows: [{ id: sessionOneId }] },
      { rows: [{ request_index: 0, product_id: productAId, product_code: 'A', product_name: 'A', category_code: 'drink', product_kind: 'single', fulfillment_station: 'bar', product_snapshot: {}, price_type: 'standard', amount_minor: '8800', currency: 'CNY', store_timezone: 'Asia/Shanghai', store_local_time: '20:00', store_iso_weekday: 1 }] },
      { rows: [{ id: orderId, table_session_id: sessionOneId, public_id: 'unit-gift-order', channel: 'cashier', settlement_mode: 'table_tab', status: 'submitted', payment_status: 'unpaid', subtotal_amount_minor: '8800', discount_amount_minor: '8800', total_amount_minor: '0', currency: 'CNY', note: null, created_by_employee_id: employeeId, created_at: '2026-08-11T12:00:00.000Z', submitted_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ id: orderItemId, order_id: orderId, product_id: productAId, parent_order_item_id: null, quantity: 1, unit_price_minor: '8800', discount_amount_minor: '8800', total_amount_minor: '0', currency: 'CNY', fulfillment_station: 'bar', product_snapshot: {}, cost_snapshot: {}, status: 'submitted', note: null, created_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ order_item_id: orderItemId, inventory_item_id: inventoryAId, sku: 'A-ING', required_quantity: '1.000000' }] },
      { rows: [{ inventory_item_id: inventoryAId, sku: 'A-ING', on_hand_quantity: '10.000000', reserved_quantity: '0.000000', required_quantity: '1.000000', insufficient: false }] },
      { rows: [{ id: movementId }] },
      { rows: [{ on_hand_quantity: '9.000000' }] },
      { rows: [{ id: kdsTaskId, order_item_id: orderItemId, station_code: 'bar', status: 'pending', priority: 100, quantity: 1, assigned_employee_id: null, due_at: null, next_action_at: '2026-08-11T12:00:00Z', accepted_at: null, ready_at: null, cancelled_at: null }] },
      { rows: [], rowCount: 1 },
    ])
    const executor = new RecordingExecutor(transaction)
    const authority = employeePricingAuthority(8800, 'gift')
    const result = await new CommerceCommandService(executor, authority).submitOrder({
      ...command('unit-gift-order', sessionOneId, productAId, 1, 'unit-gift-0001'),
      channel: 'cashier',
      actor: { type: 'employee', employeeId },
      createdByEmployeeId: employeeId,
      pricingAuthorization: {
        sourceType: 'employee',
        sourceId: employeeId,
      },
    })

    expect(result.value.order).toMatchObject({
      subtotalAmountMinor: 8800,
      discountAmountMinor: 8800,
      totalAmountMinor: 0,
    })
    expect(authority.consumeCalls).toEqual([{
      transaction,
      authorizationId: pricingAuthorizationId,
      orderId,
    }])
    expect(authority.authorizeTransactions).toEqual([transaction])
    expect(executor.outcome?.auditEvents[0]?.afterData).toMatchObject({
      pricingAuthorization: {
        authorizationId: pricingAuthorizationId,
        kind: 'gift',
        sourceType: 'employee',
        sourceId: employeeId,
        amountMinor: 8800,
        authorizedByEmployeeId: employeeId,
        capability: 'order.gift',
      },
    })
    expect(executor.outcome?.outboxMessages[0]?.payload).toMatchObject({
      pricingAuthorization: { authorizationId: pricingAuthorizationId, kind: 'gift' },
    })
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('CommerceCommandService PostgreSQL concurrency', () => {
  let pool: Pool
  let service: CommerceCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    service = new CommerceCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
    )
    await seed(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      UPDATE mbox.inventory_balances
      SET on_hand_quantity = CASE inventory_item_id
        WHEN $3::uuid THEN 5
        ELSE 20
      END,
      reserved_quantity = 0,
      last_movement_id = NULL
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND inventory_item_id = ANY($4::uuid[])
    `, [tenantId, storeId, inventoryAId, [inventoryAId, inventoryBId, inventoryKitchenId]])
  })

  it('replays the same submitted order without duplicate rows, stock, audit or outbox', async () => {
    const input = command('integration-idempotent-order', sessionOneId, productAId, 1, 'integration-idempotent-0001')
    const first = await service.submitOrder(input)
    const replay = await service.submitOrder(input)
    expect(first.replayed).toBe(false)
    expect(replay).toEqual({ value: first.value, replayed: true })
    await expect(service.submitOrder({ ...input, lines: [{ productId: productAId, quantity: 2 }] }))
      .rejects.toBeInstanceOf(IdempotencyConflictError)

    const evidence = await pool.query<{ orders: string; movements: string; tasks: string; events: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.orders WHERE tenant_id = $4::uuid AND store_id = $5::uuid AND public_id = $1) AS orders,
        (SELECT count(*)::text FROM mbox.inventory_movements WHERE reference_id = $2::uuid) AS movements,
        (SELECT count(*)::text FROM mbox.kds_tasks WHERE order_item_id = $2::uuid) AS tasks,
        (SELECT count(*)::text FROM mbox.kds_task_events e JOIN mbox.kds_tasks t ON t.id = e.kds_task_id WHERE t.order_item_id = $2::uuid) AS events,
        (SELECT count(*)::text FROM mbox.audit_events WHERE object_id = $3) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE aggregate_id = $3::uuid) AS outbox
    `, [input.publicId, first.value.order.items[0]!.id, first.value.order.id, tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ orders: '1', movements: '1', tasks: '1', events: '1', audits: '1', outbox: '1' })
  })

  it('persists settlement mode and treats a changed settlement mode as an idempotency conflict', async () => {
    const input = {
      ...command('integration-settlement-order', sessionOneId, productBId, 1, 'integration-settlement-0001'),
      settlementMode: 'table_tab' as const,
    }
    const first = await service.submitOrder(input)
    expect(first.value.order).toMatchObject({ settlementMode: 'table_tab', paymentStatus: 'unpaid' })
    expect(first.value.paymentNextStep).toMatchObject({
      status: 'deferred', action: 'settle_table_later', paymentStatus: 'unpaid',
    })
    await expect(service.submitOrder({ ...input, settlementMode: 'immediate_payment' }))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
    const stored = await pool.query<{ settlement_mode: string; payment_status: string }>(`
      SELECT settlement_mode, payment_status
      FROM mbox.orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [tenantId, storeId, first.value.order.id])
    expect(stored.rows[0]).toEqual({ settlement_mode: 'table_tab', payment_status: 'unpaid' })
  })

  it('charges a bundle once while routing its components to separate KDS stations and inventory recipes', async () => {
    const submitted = await service.submitOrder(command(
      'integration-bundle-order',
      sessionOneId,
      bundleProductId,
      1,
      'integration-bundle-0001',
    ))

    expect(submitted.value.order).toMatchObject({
      subtotalAmountMinor: 14800,
      totalAmountMinor: 14800,
    })
    expect(submitted.value.order.items).toHaveLength(3)
    const parent = submitted.value.order.items.find((item) => item.productId === bundleProductId)!
    const children = submitted.value.order.items.filter((item) => item.parentOrderItemId === parent.id)
    expect(parent).toMatchObject({ billable: true, fulfillmentStation: 'none', totalAmountMinor: 14800 })
    expect(children).toHaveLength(2)
    expect(children.every((item) => !item.billable && item.totalAmountMinor === 0)).toBe(true)
    expect(children.map((item) => item.fulfillmentStation).toSorted()).toEqual(['bar', 'kitchen'])
    expect(submitted.value.kdsTasks.map((task) => task.stationCode).toSorted()).toEqual(['bar', 'kitchen'])
    expect(submitted.value.inventoryConsumptions).toHaveLength(2)

    const evidence = await pool.query<{
      paid_lines: string
      operational_lines: string
      kds_tasks: string
      movements: string
      charged_total: string
    }>(`
      SELECT
        count(*) FILTER (WHERE item.parent_order_item_id IS NULL)::text AS paid_lines,
        count(*) FILTER (WHERE item.parent_order_item_id IS NOT NULL)::text AS operational_lines,
        (SELECT count(*)::text FROM mbox.kds_tasks task
          WHERE task.order_item_id IN (SELECT child.id FROM mbox.order_items child WHERE child.order_id = $1)) AS kds_tasks,
        (SELECT count(*)::text FROM mbox.inventory_movements movement
          WHERE movement.order_item_id IN (SELECT child.id FROM mbox.order_items child WHERE child.order_id = $1)) AS movements,
        sum(item.total_amount_minor)::text AS charged_total
      FROM mbox.order_items item
      WHERE item.order_id = $1
    `, [submitted.value.order.id])
    expect(evidence.rows[0]).toEqual({
      paid_lines: '1', operational_lines: '2', kds_tasks: '2', movements: '2', charged_total: '14800',
    })
  })

  it('replays an authorized adjustment without authorizing or writing it twice', async () => {
    const authority = employeePricingAuthority(100)
    const authorizedService = new CommerceCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      authority,
    )
    const input = {
      ...command('integration-authorized-order', sessionOneId, productBId, 1, 'integration-authorized-0001'),
      channel: 'cashier' as const,
      actor: { type: 'employee' as const, employeeId },
      createdByEmployeeId: employeeId,
      pricingAuthorization: {
        sourceType: 'employee' as const,
        sourceId: employeeId,
      },
    }
    const first = await authorizedService.submitOrder(input)
    const replay = await authorizedService.submitOrder(input)

    expect(first.value.order).toMatchObject({
      subtotalAmountMinor: 6800,
      discountAmountMinor: 100,
      totalAmountMinor: 6700,
    })
    expect(replay).toEqual({ value: first.value, replayed: true })
    expect(authority.calls).toHaveLength(1)
    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE object_id = $1) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE aggregate_id = $1::uuid) AS outbox
    `, [first.value.order.id])
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('rolls back order, items, stock movement, KDS, audit, outbox and idempotency on shortage', async () => {
    const input = command('integration-shortage-order', sessionOneId, productAId, 6, 'integration-shortage-0001')
    await expect(service.submitOrder(input)).rejects.toBeInstanceOf(InsufficientInventoryError)
    const evidence = await pool.query<{
      orders: string; items: string; movements: string; tasks: string;
      claims: string; audits: string; outbox: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.orders WHERE tenant_id = $3::uuid AND store_id = $4::uuid AND public_id = $1) AS orders,
        (SELECT count(*)::text FROM mbox.order_items item JOIN mbox.orders ordering ON ordering.id = item.order_id WHERE ordering.tenant_id = $3::uuid AND ordering.store_id = $4::uuid AND ordering.public_id = $1) AS items,
        (SELECT count(*)::text FROM mbox.inventory_movements movement JOIN mbox.order_items item ON item.id = movement.order_item_id JOIN mbox.orders ordering ON ordering.id = item.order_id WHERE ordering.tenant_id = $3::uuid AND ordering.store_id = $4::uuid AND ordering.public_id = $1) AS movements,
        (SELECT count(*)::text FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.id = task.order_item_id JOIN mbox.orders ordering ON ordering.id = item.order_id WHERE ordering.tenant_id = $3::uuid AND ordering.store_id = $4::uuid AND ordering.public_id = $1) AS tasks,
        (SELECT count(*)::text FROM mbox.idempotency_records WHERE tenant_id = $3::uuid AND store_id = $4::uuid AND idempotency_key = $2) AS claims,
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $3::uuid AND store_id = $4::uuid AND after_snapshot ->> 'publicId' = $1) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $3::uuid AND store_id = $4::uuid AND payload -> 'order' ->> 'publicId' = $1) AS outbox
    `, [input.publicId, input.idempotencyKey, tenantId, storeId])
    expect(evidence.rows[0]).toEqual({
      orders: '0', items: '0', movements: '0', tasks: '0',
      claims: '0', audits: '0', outbox: '0',
    })
  })

  it('serializes concurrent deductions of one ingredient so stock cannot go negative', async () => {
    const results = await Promise.allSettled([
      service.submitOrder(command('integration-race-one', sessionOneId, productAId, 4, 'integration-race-one-0001')),
      service.submitOrder(command('integration-race-two', sessionTwoId, productAId, 4, 'integration-race-two-0001')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const balance = await pool.query<{ on_hand_quantity: string }>(`
      SELECT on_hand_quantity::text FROM mbox.inventory_balances WHERE inventory_item_id = $1::uuid
    `, [inventoryAId])
    expect(Number(balance.rows[0]?.on_hand_quantity)).toBe(1)
  })

  it('submits orders for different tables and inventory rows concurrently', async () => {
    const results = await Promise.all([
      service.submitOrder(command('integration-parallel-one', sessionOneId, productAId, 1, 'integration-parallel-one-0001')),
      service.submitOrder(command('integration-parallel-two', sessionTwoId, productBId, 1, 'integration-parallel-two-0001')),
    ])
    expect(results.map((result) => result.value.order.tableSessionId).toSorted())
      .toEqual([sessionOneId, sessionTwoId].toSorted())
  })

  it('records each KDS production transition as an event without updating order-item status', async () => {
    const submitted = await service.submitOrder(command('integration-kds-events', sessionOneId, productBId, 1, 'integration-kds-events-0001'))
    const taskId = submitted.value.kdsTasks[0]!.id
    const orderItemId = submitted.value.order.items[0]!.id
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await runner.run({ tenantId, storeId }, async (transaction) => {
      const kds = new KdsRepository(transaction)
      await kds.accept({ taskId, actorEmployeeId: employeeId, eventIdempotencyKey: 'integration-kds-accept' })
      await kds.startPreparing({ taskId, actorEmployeeId: employeeId, eventIdempotencyKey: 'integration-kds-prepare' })
      await kds.markReady({ taskId, actorEmployeeId: employeeId, eventIdempotencyKey: 'integration-kds-ready' })
    })
    const evidence = await pool.query<{ kds_status: string; item_status: string; events: string }>(`
      SELECT task.status AS kds_status, item.status AS item_status,
        (SELECT count(*)::text FROM mbox.kds_task_events event WHERE event.kds_task_id = task.id) AS events
      FROM mbox.kds_tasks task
      JOIN mbox.order_items item ON item.id = task.order_item_id
      WHERE task.id = $1::uuid AND item.id = $2::uuid
    `, [taskId, orderItemId])
    expect(evidence.rows[0]).toEqual({ kds_status: 'ready', item_status: 'submitted', events: '4' })
  })

  it('lets two KDS workers claim different pending tasks without duplicate events', async () => {
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    const claim = (workerId: string) => runner.run({ tenantId, storeId }, async (transaction) => (
      new KdsRepository(transaction).claimPending({
        stationCode: 'bar',
        actorEmployeeId: employeeId,
        workerId,
        limit: 1,
      })
    ))
    const [first, second] = await Promise.all([
      claim('integration-bar-worker-one'),
      claim('integration-bar-worker-two'),
    ])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]!.id).not.toBe(second[0]!.id)
    const evidence = await pool.query<{ accepted: string; events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.kds_tasks WHERE id = ANY($1::uuid[]) AND status = 'accepted') AS accepted,
        (SELECT count(*)::text FROM mbox.kds_task_events WHERE kds_task_id = ANY($1::uuid[]) AND event_type = 'task.accepted') AS events
    `, [[first[0]!.id, second[0]!.id]])
    expect(evidence.rows[0]).toEqual({ accepted: '2', events: '2' })
  })
})

function command(publicId: string, tableSessionId: string, productId: string, quantity: number, idempotencyKey: string) {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'system' as const, ref: 'commerce-test' },
    businessDate: '2026-08-11',
    tableSessionId,
    publicId,
    channel: 'integration' as const,
    lines: [{ productId, quantity }],
    idempotencyKey,
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

function employeePricingAuthority(
  amountMinor: number,
  kind: 'discount' | 'gift' = 'discount',
  maximumAmountMinor = amountMinor,
): RecordingPricingAuthority {
  return new RecordingPricingAuthority({
    authorized: true,
    authorizationId: pricingAuthorizationId,
    kind,
    sourceType: 'employee',
    sourceId: employeeId,
    amountMinor,
    maximumAmountMinor,
    currency: 'CNY',
    authorizedByEmployeeId: employeeId,
    capability: kind === 'gift' ? 'order.gift' : 'order.discount',
  })
}

async function seed(pool: Pool): Promise<void> {
  const suffix = tenantId.slice(0, 8)
  await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Commerce Tenant') ON CONFLICT DO NOTHING`, [tenantId, `commerce-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, $3, 'Commerce Store') ON CONFLICT DO NOTHING`, [storeId, tenantId, `commerce-${suffix}`])
  await pool.query(`INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'COMMERCE', 'Commerce', 'indoor') ON CONFLICT DO NOTHING`, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES
      ($1, $3, $4, $5, 'CT01', 'Commerce Table 1', 4),
      ($2, $3, $4, $5, 'CT02', 'Commerce Table 2', 4)
    ON CONFLICT DO NOTHING
  `, [tableOneId, tableTwoId, tenantId, storeId, areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status) VALUES
      ($1, $3, $4, $5, 'commerce-session-one', '2026-08-11', 2, 'open'),
      ($2, $3, $4, $6, 'commerce-session-two', '2026-08-11', 2, 'open')
    ON CONFLICT DO NOTHING
  `, [sessionOneId, sessionTwoId, tenantId, storeId, tableOneId, tableTwoId])
  await pool.query(`INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status) VALUES ($1, $2, $3, 'KDS01', 'KDS Tester', 'active') ON CONFLICT DO NOTHING`, [employeeId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name, capabilities, status)
    VALUES ($1, $2, $3, 'KDS_TESTER', 'KDS Tester', ARRAY['kds.prepare'], 'active')
    ON CONFLICT DO NOTHING
  `, [kdsRoleId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, employeeId, kdsRoleId])
  await pool.query(`
    INSERT INTO mbox.products(id, tenant_id, store_id, code, name, category_code, fulfillment_station, product_kind) VALUES
      ($1, $3, $4, 'PRODUCT-A', 'Product A', 'drink', 'bar', 'single'),
      ($2, $3, $4, 'PRODUCT-B', 'Product B', 'drink', 'bar', 'single'),
      ($5, $3, $4, 'PRODUCT-KITCHEN', 'Kitchen Product', 'food', 'kitchen', 'single'),
      ($6, $3, $4, 'BUNDLE-AB', 'Bar and Kitchen Bundle', 'bundle', 'none', 'bundle')
    ON CONFLICT DO NOTHING
  `, [productAId, productBId, tenantId, storeId, productKitchenId, bundleProductId])
  await pool.query(`
    INSERT INTO mbox.product_bundle_components(
      tenant_id, store_id, bundle_product_id, component_product_id, quantity, sort_order
    ) VALUES ($1, $2, $3, $4, 1, 10), ($1, $2, $3, $5, 1, 20)
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, bundleProductId, productAId, productKitchenId])
  await pool.query(`
    INSERT INTO mbox.product_prices(tenant_id, store_id, product_id, price_type, amount_minor, valid_from) VALUES
      ($1, $2, $3, 'standard', 8800, '2026-01-01T00:00:00Z'),
      ($1, $2, $4, 'standard', 6800, '2026-01-01T00:00:00Z'),
      ($1, $2, $5, 'standard', 5800, '2026-01-01T00:00:00Z'),
      ($1, $2, $6, 'standard', 14800, '2026-01-01T00:00:00Z')
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, productAId, productBId, productKitchenId, bundleProductId])
  await pool.query(`
    INSERT INTO mbox.inventory_items(id, tenant_id, store_id, sku, name, item_type, base_unit) VALUES
      ($1, $3, $4, 'ING-A', 'Ingredient A', 'ingredient', 'ml'),
      ($2, $3, $4, 'ING-B', 'Ingredient B', 'ingredient', 'ml'),
      ($5, $3, $4, 'ING-KITCHEN', 'Kitchen Ingredient', 'food', 'piece')
    ON CONFLICT DO NOTHING
  `, [inventoryAId, inventoryBId, tenantId, storeId, inventoryKitchenId])
  await pool.query(`
    INSERT INTO mbox.recipes(id, tenant_id, store_id, product_id, version, yield_quantity, status, effective_at) VALUES
      ($1, $3, $4, $5, 1, 1, 'active', '2026-01-01T00:00:00Z'),
      ($2, $3, $4, $6, 1, 1, 'active', '2026-01-01T00:00:00Z'),
      ($7, $3, $4, $8, 1, 1, 'active', '2026-01-01T00:00:00Z')
    ON CONFLICT DO NOTHING
  `, [recipeAId, recipeBId, tenantId, storeId, productAId, productBId, recipeKitchenId, productKitchenId])
  await pool.query(`
    INSERT INTO mbox.recipe_items(tenant_id, store_id, recipe_id, inventory_item_id, quantity) VALUES
      ($1, $2, $3, $6, 1), ($1, $2, $4, $7, 1), ($1, $2, $5, $8, 1)
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, recipeAId, recipeBId, recipeKitchenId, inventoryAId, inventoryBId, inventoryKitchenId])
  await pool.query(`
    INSERT INTO mbox.inventory_balances(tenant_id, store_id, inventory_item_id, on_hand_quantity) VALUES
      ($1, $2, $3, 5), ($1, $2, $4, 20), ($1, $2, $5, 20)
    ON CONFLICT (tenant_id, store_id, inventory_item_id) DO UPDATE
      SET on_hand_quantity = EXCLUDED.on_hand_quantity, reserved_quantity = 0, last_movement_id = NULL
  `, [tenantId, storeId, inventoryAId, inventoryBId, inventoryKitchenId])
}
