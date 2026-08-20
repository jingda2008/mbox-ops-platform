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
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import {
  GuestOrderDuplicateConfirmationRequiredError,
  GuestOrderRateLimitedError,
} from './guest-order-safety.js'
import { InsufficientInventoryError } from './inventory-repository.js'
import { KdsRepository } from './kds-repository.js'
import { PaymentCommandService } from './payment-command-service.js'
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import type { PaymentCapabilityAuthorizationPort } from './payment-security-policy.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
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
const nonFulfillmentProductId = randomUUID()
const inventoryAId = randomUUID()
const inventoryBId = randomUUID()
const inventoryKitchenId = randomUUID()
const recipeAId = randomUUID()
const recipeBId = randomUUID()
const recipeKitchenId = randomUUID()
const employeeId = randomUUID()
const checkoutRuleDrafterId = randomUUID()
const checkoutRulePublisherId = randomUUID()
const customerId = randomUUID()
const customerTwoId = randomUUID()
const guestActorRefs=new Map<string,string>([[customerId,`guest-session:${randomUUID()}`]])
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
  it('reserves inventory and withholds KDS for an immediate-payment order', async () => {
    const orderId = 'b1000000-0000-4000-8000-000000000001'
    const orderItemId = 'b1000000-0000-4000-8000-000000000002'
    const reservationId = 'b1000000-0000-4000-8000-000000000003'
    const expiresAt = '2026-08-11T12:10:00.000Z'
    const transaction = new ScriptedTransaction([
      { rows: [{ id: sessionOneId }] },
      { rows: [typedPriceRow()] },
      { rows: [{ id: orderId, table_session_id: sessionOneId, public_id: 'unit-order-0001', channel: 'integration', settlement_mode: 'immediate_payment', status: 'submitted', payment_status: 'unpaid', subtotal_amount_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', note: null, created_by_employee_id: null, created_at: '2026-08-11T12:00:00.000Z', submitted_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ id: orderItemId, order_id: orderId, product_id: productAId, parent_order_item_id: null, quantity: 1, unit_price_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', fulfillment_station: 'bar', product_snapshot: {}, cost_snapshot: {}, status: 'submitted', note: null, created_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ affected_count: 0 }] },
      { rows: [{ fulfillment_expires_at: expiresAt, fulfillment_state: 'awaiting_payment' }] },
      { rows: [{ order_item_id: orderItemId }] },
      { rows: [{ order_item_id: orderItemId, inventory_item_id: inventoryAId, sku: 'A-ING', required_quantity: '1.000000' }] },
      { rows: [] },
      { rows: [{ inventory_item_id: inventoryAId, sku: 'A-ING', on_hand_quantity: '10.000000', reserved_quantity: '0.000000', required_quantity: '1.000000', insufficient: false }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ id: reservationId, order_id: orderId, order_item_id: orderItemId, inventory_item_id: inventoryAId, sku: 'A-ING', quantity: '1.000000', status: 'reserved', expires_at: expiresAt, movement_id: null }] },
    ])
    const executor = new RecordingExecutor(transaction)
    const result = await new CommerceCommandService(executor).submitOrder({
      ...command('unit-order-0001', sessionOneId, productAId, 1, 'unit-command-0001'),
      settlementMode: 'immediate_payment',
    })
    expect(result.value.order.id).toBe(orderId)
    expect(result.value.inventoryConsumptions).toHaveLength(0)
    expect(result.value.kdsTasks).toHaveLength(0)
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

  it('keeps validation ordering available without recipes and records the exact audit bypass', async () => {
    const orderId = 'b1000000-0000-4000-8000-000000000011'
    const orderItemId = 'b1000000-0000-4000-8000-000000000012'
    const kdsTaskId = 'b1000000-0000-4000-8000-000000000013'
    const transaction = new ScriptedTransaction([
      { rows: [{ id: sessionOneId }] },
      { rows: [typedPriceRow()] },
      { rows: [{ id: orderId, table_session_id: sessionOneId, public_id: 'unit-audit-order', channel: 'integration', settlement_mode: 'table_tab', status: 'submitted', payment_status: 'unpaid', subtotal_amount_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', note: null, created_by_employee_id: null, created_at: '2026-08-11T12:00:00.000Z', submitted_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ id: orderItemId, order_id: orderId, product_id: productAId, parent_order_item_id: null, quantity: 1, unit_price_minor: '8800', discount_amount_minor: '0', total_amount_minor: '8800', currency: 'CNY', fulfillment_station: 'bar', product_snapshot: {}, cost_snapshot: {}, status: 'submitted', note: null, created_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
      { rows: [{ id: kdsTaskId, order_item_id: orderItemId, station_code: 'bar', status: 'pending', priority: 100, quantity: 1, assigned_employee_id: null, due_at: null, next_action_at: '2026-08-11T12:00:00Z', accepted_at: null, ready_at: null, cancelled_at: null }] },
      { rows: [], rowCount: 1 },
    ])
    const executor = new RecordingExecutor(transaction)
    const result = await new CommerceCommandService(
      executor,
      undefined,
      { inventoryEnforcementMode: 'audit_only' },
    ).submitOrder(command('unit-audit-order', sessionOneId, productAId, 1, 'unit-audit-command'))

    expect(result.value.inventoryConsumptions).toEqual([])
    expect(result.value.kdsTasks).toHaveLength(1)
    expect(executor.outcome?.auditEvents[0]?.afterData).toMatchObject({
      inventoryControl: {
        enforcementMode: 'audit_only',
        configurationComplete: false,
        unconfiguredOrderItemIds: [orderItemId],
      },
    })
    expect(executor.outcome?.outboxMessages[0]?.payload).toMatchObject({
      inventoryControl: {
        enforcementMode: 'audit_only',
        configurationComplete: false,
        unconfiguredOrderItemIds: [orderItemId],
      },
    })
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
    const executor = new RecordingExecutor(new ScriptedTransaction([
      { rows: [{ id: sessionOneId }] },
      { rows: [{ participation_id: randomUUID() }] },
    ]))
    const authority = employeePricingAuthority(8800, 'gift')
    await expect(new CommerceCommandService(executor, authority).submitOrder({
      ...guestCommand('unit-guest-forged-gift',customerId,productAId,1,'unit-guest-gift-0001'),
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
      { rows: [typedPriceRow()] },
      { rows: [{ id: orderId, table_session_id: sessionOneId, public_id: 'unit-gift-order', channel: 'cashier', settlement_mode: 'table_tab', status: 'submitted', payment_status: 'unpaid', subtotal_amount_minor: '8800', discount_amount_minor: '8800', total_amount_minor: '0', currency: 'CNY', note: null, created_by_employee_id: employeeId, created_at: '2026-08-11T12:00:00.000Z', submitted_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [{ id: orderItemId, order_id: orderId, product_id: productAId, parent_order_item_id: null, quantity: 1, unit_price_minor: '8800', discount_amount_minor: '8800', total_amount_minor: '0', currency: 'CNY', fulfillment_station: 'bar', product_snapshot: {}, cost_snapshot: {}, status: 'submitted', note: null, created_at: '2026-08-11T12:00:00.000Z' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ order_item_id: orderItemId }] },
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
      UPDATE mbox.checkout_upgrade_offers SET status='expired',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND status IN ('offered','selected')
    `, [tenantId, storeId])
    await pool.query(`
      UPDATE mbox.checkout_upgrade_rules
      SET status='retired',valid_until=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND status='active' AND publication_mode='separated'
    `, [tenantId, storeId])
    await pool.query(`
      UPDATE mbox.customer_experience_features
      SET rollout_state='disabled', updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='checkout_upgrade'
    `, [tenantId, storeId])
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

  it('replays a pre-066 idempotency result without inferring cost from JSON', async () => {
    const input = command(
      `integration-legacy-cost-replay-${randomUUID()}`,
      sessionOneId,
      productAId,
      1,
      `legacy-cost-replay-${randomUUID()}`,
    )
    const first = await service.submitOrder(input)
    await pool.query(`
      UPDATE mbox.idempotency_records AS record
      SET response_snapshot=jsonb_set(
        record.response_snapshot,
        '{result,order,items}',
        (
          SELECT jsonb_agg(item
            - 'unitCostMinorAtSubmission'
            - 'totalCostMinorAtSubmission'
            - 'costSource'
            - 'costReferenceProductId'
            - 'costReferenceOrderItemId'
            - 'costReferenceProductUpdatedAt')
          FROM jsonb_array_elements(record.response_snapshot #> '{result,order,items}') AS item
        )
      )
      WHERE record.tenant_id=$1 AND record.store_id=$2
        AND record.operation_scope='commerce.order.submit'
        AND record.idempotency_key=$3
    `, [tenantId, storeId, input.idempotencyKey])

    const replay = await service.submitOrder(input)
    expect(replay.replayed).toBe(true)
    expect(replay.value.order.id).toBe(first.value.order.id)
    expect(replay.value.order.items[0]).toMatchObject({
      unitCostMinorAtSubmission: null,
      totalCostMinorAtSubmission: null,
      costSource: 'unavailable',
      costReferenceProductId: null,
      costReferenceOrderItemId: null,
      costReferenceProductUpdatedAt: null,
    })
  })

  it('binds a valid recommendation option to the order transaction and fingerprints the attribution', async () => {
    const recommendation = await seedRecommendation(pool, {
      customerId,
      tableSessionId: sessionOneId,
      productId: productAId,
    })
    const input = {
      ...guestCommand(
        'integration-recommendation-order',
        customerId,
        productAId,
        1,
        'integration-recommendation-order-0001',
      ),
      recommendationAttribution: {
        recommendationPublicId: recommendation.publicId,
        selectedProductId: productAId,
      },
    }

    const submitted = await service.submitOrder(input)
    const replayed = await service.submitOrder(input)
    expect(replayed).toEqual({ value: submitted.value, replayed: true })
    await expect(service.submitOrder({
      ...input,
      recommendationAttribution: {
        recommendationPublicId: recommendation.publicId,
        selectedProductId: productBId,
      },
    })).rejects.toBeInstanceOf(IdempotencyConflictError)

    const evidence = await pool.query<{
      event_type: string
      customer_id: string
      table_session_id: string
      order_id: string
      ordered_events: string
    }>(`
      SELECT event.event_type, event.customer_id::text, event.table_session_id::text,
        event.order_id::text,
        (SELECT count(*)::text FROM mbox.recommendation_behavior_events duplicate
          WHERE duplicate.tenant_id=event.tenant_id AND duplicate.store_id=event.store_id
            AND duplicate.recommendation_session_id=event.recommendation_session_id
            AND duplicate.event_type='ordered') AS ordered_events
      FROM mbox.recommendation_behavior_events AS event
      WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
        AND event.recommendation_session_id=$3::uuid AND event.event_type='ordered'
    `, [tenantId, storeId, recommendation.sessionId])
    expect(evidence.rows[0]).toEqual({
      event_type: 'ordered',
      customer_id: customerId,
      table_session_id: sessionOneId,
      order_id: submitted.value.order.id,
      ordered_events: '1',
    })
  })

  it('keeps selected evidence without writing a false ordered event when transformed checkout omits attribution', async () => {
    const recommendation = await seedRecommendation(pool, {
      customerId,
      tableSessionId: sessionOneId,
      productId: productAId,
    })
    await pool.query(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, event_type, actor_type, actor_ref,
        reason_code, evidence_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        'selected', 'guest', 'guest-test:selected-before-upgrade', NULL,
        '{"surface":"guest_order_recommendations"}'::jsonb
      )
    `, [
      tenantId,
      storeId,
      recommendation.sessionId,
      recommendation.optionId,
      customerId,
      sessionOneId,
    ])

    await service.submitOrder(guestCommand(
      'integration-recommendation-transformed-order',
      customerId,
      productBId,
      1,
      'integration-recommendation-transformed-order-0001',
    ))

    const evidence = await pool.query<{ selected: string; ordered: string }>(`
      SELECT
        count(*) FILTER (WHERE event_type='selected')::text AS selected,
        count(*) FILTER (WHERE event_type='ordered')::text AS ordered
      FROM mbox.recommendation_behavior_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND recommendation_session_id=$3::uuid
    `, [tenantId, storeId, recommendation.sessionId])
    expect(evidence.rows[0]).toEqual({ selected: '1', ordered: '0' })
  })

  it('rolls back the whole order when recommendation attribution belongs to another table or is absent from order lines', async () => {
    const forgedTable = await seedRecommendation(pool, {
      customerId: customerTwoId,
      tableSessionId: sessionTwoId,
      productId: productAId,
    })
    const missingLine = await seedRecommendation(pool, {
      customerId,
      tableSessionId: sessionOneId,
      productId: productBId,
    })
    const attempts = [
      {
        publicId: 'integration-recommendation-forged-table',
        idempotencyKey: 'integration-recommendation-forged-table-0001',
        recommendationPublicId: forgedTable.publicId,
        selectedProductId: productAId,
      },
      {
        publicId: 'integration-recommendation-missing-line',
        idempotencyKey: 'integration-recommendation-missing-line-0001',
        recommendationPublicId: missingLine.publicId,
        selectedProductId: productBId,
      },
    ]

    for (const attempt of attempts) {
      await expect(service.submitOrder({
        ...guestCommand(attempt.publicId, customerId, productAId, 5, attempt.idempotencyKey),
        recommendationAttribution: {
          recommendationPublicId: attempt.recommendationPublicId,
          selectedProductId: attempt.selectedProductId,
        },
      })).rejects.toMatchObject({
        code: 'RECOMMENDATION_ORDER_INVALID',
        statusCode: 409,
      })
    }

    const evidence = await pool.query<{ orders: string; events: string; reserved: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.orders
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND public_id=ANY($3::text[])) AS orders,
        (SELECT count(*)::text FROM mbox.recommendation_behavior_events
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND recommendation_session_id=ANY($4::uuid[]) AND event_type='ordered') AS events,
        (SELECT reserved_quantity::text FROM mbox.inventory_balances
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND inventory_item_id=$5::uuid) AS reserved
    `, [
      tenantId,
      storeId,
      attempts.map((attempt) => attempt.publicId),
      [forgedTable.sessionId, missingLine.sessionId],
      inventoryAId,
    ])
    expect(evidence.rows[0]).toEqual({ orders: '0', events: '0', reserved: '0.000000' })
  })

  it('keeps an immediate-payment order out of inventory consumption and KDS until trusted payment succeeds', async () => {
    const publicId = 'integration-payment-gated-order'
    const order = await service.submitOrder({
      ...command(publicId, sessionOneId, productAId, 1, 'integration-payment-gated-0001'),
      settlementMode: 'immediate_payment',
    })
    const orderId = order.value.order.id
    const orderItemId = order.value.order.items[0]!.id
    const before = await pool.query<{
      fulfillment_state: string
      payment_status: string
      reservation_status: string
      on_hand: string
      reserved: string
      movements: string
      tasks: string
    }>(`
      SELECT order_row.fulfillment_state, order_row.payment_status,
        reservation.status AS reservation_status,
        balance.on_hand_quantity::text AS on_hand,
        balance.reserved_quantity::text AS reserved,
        (SELECT count(*)::text FROM mbox.inventory_movements WHERE order_item_id = $2::uuid) AS movements,
        (SELECT count(*)::text FROM mbox.kds_tasks WHERE order_item_id = $2::uuid) AS tasks
      FROM mbox.orders AS order_row
      JOIN mbox.inventory_order_reservations AS reservation
        ON reservation.order_id = order_row.id AND reservation.order_item_id = $2::uuid
      JOIN mbox.inventory_balances AS balance
        ON balance.tenant_id = reservation.tenant_id AND balance.store_id = reservation.store_id
       AND balance.inventory_item_id = reservation.inventory_item_id
      WHERE order_row.id = $1::uuid
    `, [orderId, orderItemId])
    expect(before.rows[0]).toEqual({
      fulfillment_state: 'awaiting_payment', payment_status: 'unpaid',
      reservation_status: 'reserved', on_hand: '5.000000', reserved: '1.000000',
      movements: '0', tasks: '0',
    })

    await expect(pool.query(`
      UPDATE mbox.orders
      SET fulfillment_state = 'active', fulfillment_expires_at = NULL,
        fulfillment_activated_at = clock_timestamp()
      WHERE id = $1::uuid
    `, [orderId])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`
      INSERT INTO mbox.kds_tasks(
        id, tenant_id, store_id, order_item_id, station_code, priority, quantity
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'bar', 100, 1)
    `, [randomUUID(), tenantId, storeId, orderItemId])).rejects.toMatchObject({ code: '23514' })

    const paymentAuthorization: PaymentCapabilityAuthorizationPort = {
      assertEmployeeCapability: async () => undefined,
      assertRefundRequestLimit: async () => undefined,
      assertRefundApproval: async () => undefined,
    }
    const payment = new PaymentCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      paymentAuthorization,
    )
    const operationalControl = new LoyaltyOperationalControlService(
      new ScopedPostgresTransactionRunner(asPool(pool)),
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
    )
    await operationalControl.set({
      scope:{tenantId,storeId},employeeId,businessDate:'2026-08-11',
    },{
      capability:'points_accrual',operation:'pause',reason:'积分规则待复核，付款继续正常处理',
      reviewAt:null,expectedVersion:0,idempotencyKey:'integration-payment-loyalty-pause-087',
    })
    await payment.recordManual({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-11',
      idempotencyKey: 'integration-payment-gated-cash-0001',
      requestFingerprint: 'a'.repeat(64),
      orderId,
      publicId: 'integration-payment-gated-cash',
      provider: 'cash',
      method: 'cash',
      evidence: { collectedByEmployeeId: employeeId, receiptReference: 'CASH-TEST-0001' },
      occurredAt: '2026-08-11T12:05:00.000Z',
    })

    const after = await pool.query<{
      fulfillment_state: string
      payment_status: string
      reservation_status: string
      on_hand: string
      reserved: string
      movements: string
      tasks: string
    }>(`
      SELECT order_row.fulfillment_state, order_row.payment_status,
        reservation.status AS reservation_status,
        balance.on_hand_quantity::text AS on_hand,
        balance.reserved_quantity::text AS reserved,
        (SELECT count(*)::text FROM mbox.inventory_movements WHERE order_item_id = $2::uuid) AS movements,
        (SELECT count(*)::text FROM mbox.kds_tasks WHERE order_item_id = $2::uuid) AS tasks
      FROM mbox.orders AS order_row
      JOIN mbox.inventory_order_reservations AS reservation
        ON reservation.order_id = order_row.id AND reservation.order_item_id = $2::uuid
      JOIN mbox.inventory_balances AS balance
        ON balance.tenant_id = reservation.tenant_id AND balance.store_id = reservation.store_id
       AND balance.inventory_item_id = reservation.inventory_item_id
      WHERE order_row.id = $1::uuid
    `, [orderId, orderItemId])
    expect(after.rows[0]).toEqual({
      fulfillment_state: 'active', payment_status: 'paid',
      reservation_status: 'consumed', on_hand: '4.000000', reserved: '0.000000',
      movements: '1', tasks: '1',
    })
    expect((await pool.query(`SELECT status,pause_control_version FROM mbox.loyalty_accrual_deferred_orders
      WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[tenantId,storeId,orderId])).rows[0])
      .toEqual({status:'pending',pause_control_version:1})
    await operationalControl.set({
      scope:{tenantId,storeId},employeeId,businessDate:'2026-08-11',
    },{
      capability:'points_accrual',operation:'resume',reason:'积分规则复核完成，恢复补算',
      reviewAt:null,expectedVersion:1,idempotencyKey:'integration-payment-loyalty-resume-087',
    })
  })

  it('locks, revalidates and converts a checkout upgrade in the same order transaction', async () => {
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    const ruleCode = `UPGRADE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
    await pool.query(`
      INSERT INTO mbox.customer_experience_features(
        tenant_id, store_id, feature_code, rollout_state, configuration, reason
      ) VALUES ($1, $2, 'checkout_upgrade', 'enabled', '{}'::jsonb, '原子结账数据库测试')
      ON CONFLICT (tenant_id, store_id, feature_code) DO UPDATE
      SET rollout_state='enabled', updated_at=clock_timestamp()
    `, [tenantId, storeId])
    await seedReleasedCheckoutUpgradeRule(pool, ruleCode, 'Atomic upgrade')
    const offer = await runner.run({ tenantId, storeId }, async (transaction) => (
      new CustomerExperienceRepository(transaction).prepareCheckoutUpgrade({
        customerId,
        tableSessionId: sessionOneId,
        businessDate: '2026-08-11',
        actorRef: 'checkout-upgrade-integration',
        partySize: 2,
      }, {
        items: [{ productId: productBId, quantity: 1 }],
        idempotencyKey: `checkout-upgrade-offer-${randomUUID()}`,
      })
    ))
    expect(offer).not.toBeNull()

    const submitted = await service.submitOrder({
      ...guestCommand(
        'integration-checkout-upgrade-order', customerId, productBId, 1,
        `integration-checkout-upgrade-${randomUUID()}`,
      ),
      checkoutUpgradeOfferPublicId: offer!.publicId,
    })

    expect(submitted.value.order.items.filter((item) => item.billable)).toEqual([
      expect.objectContaining({ productId: bundleProductId, unitPriceMinor: 14800, quantity: 1 }),
    ])
    expect(submitted.value.kdsTasks).toHaveLength(0)
    expect(submitted.value.inventoryConsumptions).toHaveLength(0)
    const evidence = await pool.query<{
      offer_status: string
      converted_order_id: string
      reservations: string
      kds_tasks: string
    }>(`
      SELECT offer.status AS offer_status, offer.converted_order_id::text,
        (SELECT count(*)::text FROM mbox.inventory_order_reservations reservation
          WHERE reservation.order_id=offer.converted_order_id) AS reservations,
        (SELECT count(*)::text FROM mbox.kds_tasks task
          JOIN mbox.order_items item ON item.id=task.order_item_id
          WHERE item.order_id=offer.converted_order_id) AS kds_tasks
      FROM mbox.checkout_upgrade_offers offer
      WHERE offer.tenant_id=$1 AND offer.store_id=$2 AND offer.public_id=$3
    `, [tenantId, storeId, offer!.publicId])
    expect(evidence.rows[0]).toEqual({
      offer_status: 'converted',
      converted_order_id: submitted.value.order.id,
      reservations: '2',
      kds_tasks: '0',
    })
  })

  it('rolls back the whole order command when an accepted upgrade price changed', async () => {
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    const ruleCode = `UPGRADE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
    await pool.query(`
      INSERT INTO mbox.customer_experience_features(
        tenant_id, store_id, feature_code, rollout_state, configuration, reason
      ) VALUES ($1, $2, 'checkout_upgrade', 'enabled', '{}'::jsonb, '价格变化回滚数据库测试')
      ON CONFLICT (tenant_id, store_id, feature_code) DO UPDATE
      SET rollout_state='enabled', updated_at=clock_timestamp()
    `, [tenantId, storeId])
    await seedReleasedCheckoutUpgradeRule(pool, ruleCode, 'Price change upgrade')
    const offer = await runner.run({ tenantId, storeId }, async (transaction) => (
      new CustomerExperienceRepository(transaction).prepareCheckoutUpgrade({
        customerId,
        tableSessionId: sessionOneId,
        businessDate: '2026-08-11',
        actorRef: 'checkout-upgrade-price-change',
        partySize: 2,
      }, {
        items: [{ productId: productBId, quantity: 1 }],
        idempotencyKey: `checkout-upgrade-price-offer-${randomUUID()}`,
      })
    ))
    const changedPrice = await pool.query<{ id: string }>(`
      UPDATE mbox.product_prices
      SET amount_minor=14900
      WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3
        AND price_type='standard' AND valid_until IS NULL
      RETURNING id
    `, [tenantId, storeId, bundleProductId])
    const publicId = 'integration-checkout-upgrade-price-changed'
    const idempotencyKey = `integration-checkout-upgrade-price-${randomUUID()}`
    try {
      await expect(service.submitOrder({
        ...guestCommand(publicId, customerId, productBId, 1, idempotencyKey),
        checkoutUpgradeOfferPublicId: offer!.publicId,
      })).rejects.toMatchObject({ code: 'CHECKOUT_UPGRADE_PRICE_CHANGED', statusCode: 409 })
      const evidence = await pool.query<{
        orders: string
        claims: string
        offer_status: string
      }>(`
        SELECT
          (SELECT count(*)::text FROM mbox.orders
            WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3) AS orders,
          (SELECT count(*)::text FROM mbox.idempotency_records
            WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$4) AS claims,
          (SELECT status FROM mbox.checkout_upgrade_offers
            WHERE tenant_id=$1 AND store_id=$2 AND public_id=$5) AS offer_status
      `, [tenantId, storeId, publicId, idempotencyKey, offer!.publicId])
      expect(evidence.rows[0]).toEqual({ orders: '0', claims: '0', offer_status: 'offered' })
    } finally {
      await pool.query(`UPDATE mbox.product_prices SET amount_minor=14800 WHERE id=$1`, [changedPrice.rows[0]!.id])
    }
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

  it('submits a one-yuan non-fulfillment item for immediate payment without inventory or KDS work', async () => {
    const result = await service.submitOrder({
      ...command(
        'integration-one-yuan-payment',
        sessionOneId,
        nonFulfillmentProductId,
        1,
        'integration-one-yuan-payment-0001',
      ),
      settlementMode: 'immediate_payment',
    })

    expect(result.value.order).toMatchObject({
      totalAmountMinor: 100,
      settlementMode: 'immediate_payment',
    })
    expect(result.value.inventoryConsumptions).toEqual([])
    expect(result.value.kdsTasks).toEqual([])
    expect(result.value.paymentNextStep).toMatchObject({
      status: 'required', action: 'create_payment_intent', amountMinor: 100, currency: 'CNY',
    })
    const evidence = await pool.query<{ fulfillment_state: string; reservations: string; kds_tasks: string }>(`
      SELECT order_row.fulfillment_state,
        (SELECT count(*)::text FROM mbox.inventory_order_reservations
          WHERE order_id=order_row.id) AS reservations,
        (SELECT count(*)::text FROM mbox.kds_tasks AS task
          JOIN mbox.order_items AS item ON item.id=task.order_item_id
          WHERE item.order_id=order_row.id) AS kds_tasks
      FROM mbox.orders AS order_row
      WHERE order_row.id=$1::uuid
    `, [result.value.order.id])
    expect(evidence.rows[0]).toEqual({
      fulfillment_state: 'awaiting_payment', reservations: '0', kds_tasks: '0',
    })
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

  it('serializes same-table guest orders across customers, requires duplicate confirmation, and rate-limits per customer', async () => {
    const raceCustomerOneId = randomUUID()
    const raceCustomerTwoId = randomUUID()
    const raceTableId = randomUUID()
    const raceSessionId = randomUUID()
    const raceSuffix = raceSessionId.replaceAll('-', '').slice(0, 12)
    await pool.query(`
      INSERT INTO mbox.tables(
        id, tenant_id, store_id, area_id, code, display_name, capacity
      ) VALUES ($1, $2, $3, $4, $5, 'Guest race table', 4)
    `, [raceTableId, tenantId, storeId, areaId, `RACE_${raceSuffix}`])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES ($1, $2, $3, $4, $5, '2026-08-11', 2, 'open')
    `, [raceSessionId, tenantId, storeId, raceTableId, `guest-race-session-${raceSuffix}`])
    await pool.query(`
      INSERT INTO mbox.customers(id, tenant_id, store_id, public_id) VALUES
        ($1, $3, $4, $5), ($2, $3, $4, $6)
    `, [
      raceCustomerOneId, raceCustomerTwoId, tenantId, storeId,
      `guest-race-${raceCustomerOneId}`, `guest-race-${raceCustomerTwoId}`,
    ])
    await pool.query(`
      INSERT INTO mbox.table_session_customers(
        tenant_id, store_id, table_session_id, customer_id, relationship
      ) VALUES ($1, $2, $3, $4, 'guest'), ($1, $2, $3, $5, 'guest')
    `, [tenantId, storeId, raceSessionId, raceCustomerOneId, raceCustomerTwoId])
    guestActorRefs.set(raceCustomerOneId,await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId:raceSessionId,customerId:raceCustomerOneId,
    }))
    guestActorRefs.set(raceCustomerTwoId,await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId:raceSessionId,customerId:raceCustomerTwoId,
    }))
    const guestService = new CommerceCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      undefined,
      {
        guestOrderSafetyPolicy: {
          duplicateWindowSeconds: 45,
          maxOrdersPerCustomerPerMinute: 2,
          maxOrdersPerTablePerMinute: 20,
        },
      },
    )
    const concurrentInputs = [
      guestCommand('guest-race-one', raceCustomerOneId, productBId, 1, 'guest-race-one-0001', raceSessionId),
      guestCommand('guest-race-two', raceCustomerTwoId, productBId, 1, 'guest-race-two-0001', raceSessionId),
    ] as const
    const results = await Promise.allSettled(concurrentInputs.map((input) => guestService.submitOrder(input)))
    const fulfilledIndex = results.findIndex((result) => result.status === 'fulfilled')
    const rejectedIndex = results.findIndex((result) => result.status === 'rejected')
    expect(fulfilledIndex).toBeGreaterThanOrEqual(0)
    expect(rejectedIndex).toBeGreaterThanOrEqual(0)
    expect(results[rejectedIndex]).toMatchObject({
      status: 'rejected',
      reason: expect.any(GuestOrderDuplicateConfirmationRequiredError),
    })

    const accepted = results[fulfilledIndex]
    if (accepted?.status !== 'fulfilled') throw new Error('Expected one accepted guest order')
    const rejectedCustomerId = concurrentInputs[rejectedIndex]!.createdByCustomerId
    const confirmed = await guestService.submitOrder({
      ...guestCommand('guest-race-confirmed', rejectedCustomerId, productBId, 1, 'guest-race-confirmed-0001', raceSessionId),
      confirmedDuplicateOrderPublicId: accepted.value.value.order.publicId,
    })
    expect(confirmed.value.order.createdByCustomerId).toBe(rejectedCustomerId)

    await guestService.submitOrder(
      guestCommand('guest-race-distinct', rejectedCustomerId, productAId, 1, 'guest-race-distinct-0001', raceSessionId),
    )
    await expect(guestService.submitOrder(
      guestCommand('guest-race-rate-limited', rejectedCustomerId, productAId, 2, 'guest-race-limited-0001', raceSessionId),
    )).rejects.toMatchObject({
      name: 'GuestOrderRateLimitedError',
      dimension: 'customer',
    } satisfies Partial<GuestOrderRateLimitedError>)

    const evidence = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = ANY($3::text[])
    `, [tenantId, storeId, ['guest-race-one', 'guest-race-two', 'guest-race-confirmed', 'guest-race-distinct', 'guest-race-rate-limited']])
    expect(evidence.rows[0]?.count).toBe('3')
  })

  it('allows two customers at the same table to submit different baskets concurrently', async () => {
    const guestService = new CommerceCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      undefined,
      {
        guestOrderSafetyPolicy: {
          duplicateWindowSeconds: 45,
          maxOrdersPerCustomerPerMinute: 100,
          maxOrdersPerTablePerMinute: 100,
        },
      },
    )
    const results = await Promise.all([
      guestService.submitOrder(
        guestCommand('guest-distinct-one', customerId, productAId, 3, 'guest-distinct-one-0001'),
      ),
      guestService.submitOrder(
        guestCommand('guest-distinct-two', customerTwoId, productBId, 3, 'guest-distinct-two-0001'),
      ),
    ])

    expect(results.map((result) => result.value.order.publicId).toSorted())
      .toEqual(['guest-distinct-one', 'guest-distinct-two'])
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

function typedPriceRow() {
  return {
    request_index: 0, product_id: productAId, product_code: 'A', product_name: 'A',
    category_code: 'drink', product_kind: 'single', fulfillment_station: 'bar',
    product_snapshot: {}, guest_visible: true,
    allowed_channels: ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'],
    max_order_quantity: 50, available_from: null, available_until: null,
    kds_priority: 100, fulfillment_sla_seconds: 300,
    cost_amount_minor: '3000', product_updated_at: '2026-08-11T11:59:00.000Z',
    price_type: 'standard', amount_minor: '8800', currency: 'CNY',
    store_timezone: 'Asia/Shanghai', store_local_time: '20:00', store_iso_weekday: 1,
  }
}

async function seedRecommendation(
  pool: Pool,
  input: Readonly<{ customerId: string; tableSessionId: string; productId: string }>,
): Promise<{ sessionId: string; optionId: string; publicId: string }> {
  const policyId = randomUUID()
  const sessionId = randomUUID()
  const optionId = randomUUID()
  const token = sessionId.replaceAll('-', '').slice(0, 16)
  const publicId = `recommendation-order-${token}`
  await pool.query(`
    INSERT INTO mbox.recommendation_policy_versions (
      id, tenant_id, store_id, public_id, policy_code, version, status,
      created_by_employee_id, draft_reason, explanation_template
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, $5, 1, 'draft',
      $6::uuid, '仅作为订单归因外键测试，不进入运行推荐', '订单推荐归因测试'
    )
  `, [policyId, tenantId, storeId, `recommendation-policy-${token}`, `TEST_${token.toUpperCase()}`, employeeId])
  await pool.query(`
    INSERT INTO mbox.recommendation_sessions (
      id, tenant_id, store_id, public_id, customer_id, table_session_id,
      business_date, source, party_size, occasion, alcohol_preference,
      experience_level, service_intensity, answers_snapshot, recommendation_snapshot
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
      '2026-08-11', 'miniprogram', 2, 'friends', 'undecided',
      'enhanced', 'balanced', '{}'::jsonb, '[]'::jsonb
    )
  `, [sessionId, tenantId, storeId, publicId, input.customerId, input.tableSessionId])
  await pool.query(`
    INSERT INTO mbox.recommendation_options (
      id, tenant_id, store_id, recommendation_session_id, policy_version_id,
      product_id, rank, tier, amount_minor, cost_amount_minor, currency,
      total_score, explanation, display_snapshot
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
      $6::uuid, 1, 'enhanced', 8800, 3000, 'CNY',
      100, '适合当前桌次', '{}'::jsonb
    )
  `, [optionId, tenantId, storeId, sessionId, policyId, input.productId])
  return { sessionId, optionId, publicId }
}

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

function guestCommand(
  publicId: string,
  createdByCustomerId: string,
  productId: string,
  quantity: number,
  idempotencyKey: string,
  tableSessionId = sessionOneId,
) {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'guest' as const, ref: guestActorRefs.get(createdByCustomerId)! },
    businessDate: '2026-08-11',
    tableSessionId,
    publicId,
    channel: 'guest_qr' as const,
    settlementMode: 'immediate_payment' as const,
    lines: [{ productId, quantity }],
    createdByCustomerId,
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

async function seedReleasedCheckoutUpgradeRule(pool: Pool, code: string, name: string): Promise<void> {
  const created = await pool.query<{ id: string }>(`
    INSERT INTO mbox.checkout_upgrade_rules(
      tenant_id,store_id,code,revision,name,source_product_id,target_product_id,
      prompt_title,prompt_body,call_to_action,status,drafted_by_employee_id,
      minimum_gross_margin_basis_points,publication_mode
    ) VALUES ($1,$2,$3,1,$4,$5,$6,'升级今晚体验','将当前单品换成完整套餐',
      '确认升级','draft',$7,100,'separated')
    RETURNING id
  `, [tenantId,storeId,code,name,productBId,bundleProductId,checkoutRuleDrafterId])
  const ruleId = created.rows[0]!.id
  await pool.query(`
    UPDATE mbox.checkout_upgrade_rules
    SET status='approved',approved_by_employee_id=$4,approved_at=clock_timestamp(),
      approval_reason='测试复核价格、毛利、套餐和配方'
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3
  `, [tenantId,storeId,ruleId,employeeId])
  await pool.query(`
    UPDATE mbox.checkout_upgrade_rules
    SET status='active',published_by_employee_id=$4,published_at=clock_timestamp(),
      publication_reason='测试发布原子升级规则',valid_from=clock_timestamp()
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3
  `, [tenantId,storeId,ruleId,checkoutRulePublisherId])
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
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status) VALUES
      ($1, $3, $4, 'KDS01', 'KDS Tester', 'active'),
      ($2, $3, $4, 'UPGRADE_DRAFTER', 'Upgrade Rule Drafter', 'active'),
      ($5, $3, $4, 'UPGRADE_PUBLISHER', 'Upgrade Rule Publisher', 'active')
    ON CONFLICT DO NOTHING
  `, [employeeId, checkoutRuleDrafterId, tenantId, storeId, checkoutRulePublisherId])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id) VALUES
      ($1, $3, $4, 'commerce-guest-one'),
      ($2, $3, $4, 'commerce-guest-two')
    ON CONFLICT DO NOTHING
  `, [customerId, customerTwoId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.table_session_customers(
      tenant_id, store_id, table_session_id, customer_id, relationship
    ) VALUES
      ($1, $2, $3, $4, 'primary'),
      ($1, $2, $3, $5, 'guest')
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, sessionOneId, customerId, customerTwoId])
  guestActorRefs.set(customerId,await seedActiveGuestTableAuthority(pool,{
    tenantId,storeId,tableSessionId:sessionOneId,customerId,
  }))
  guestActorRefs.set(customerTwoId,await seedActiveGuestTableAuthority(pool,{
    tenantId,storeId,tableSessionId:sessionOneId,customerId:customerTwoId,
  }))
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
    INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
    VALUES ($1, $2, 'kds.prepare', 'Prepare KDS items')
    ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET status='active'
  `, [tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT $1, $2, $3, id FROM mbox.staff_permission_definitions
    WHERE tenant_id=$1 AND store_id=$2 AND code='kds.prepare'
    ON CONFLICT DO NOTHING
  `, [tenantId, storeId, kdsRoleId])
  await pool.query(`
    INSERT INTO mbox.products(
      id, tenant_id, store_id, code, name, category_code,
      fulfillment_station, product_kind, cost_amount_minor
    ) VALUES
      ($1, $3, $4, 'PRODUCT-A', 'Product A', 'drink', 'bar', 'single', 3000),
      ($2, $3, $4, 'PRODUCT-B', 'Product B', 'drink', 'bar', 'single', 2000),
      ($5, $3, $4, 'PRODUCT-KITCHEN', 'Kitchen Product', 'food', 'kitchen', 'single', 2000),
      ($6, $3, $4, 'BUNDLE-AB', 'Bar and Kitchen Bundle', 'bundle', 'none', 'bundle', 6000),
      ($7, $3, $4, 'PAYMENT-ONE-YUAN', '真实支付联调1元', 'other', 'none', 'single', 0)
    ON CONFLICT DO NOTHING
  `, [
    productAId, productBId, tenantId, storeId, productKitchenId, bundleProductId,
    nonFulfillmentProductId,
  ])
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
      ($1, $2, $6, 'standard', 14800, '2026-01-01T00:00:00Z'),
      ($1, $2, $7, 'standard', 100, '2026-01-01T00:00:00Z')
    ON CONFLICT DO NOTHING
  `, [
    tenantId, storeId, productAId, productBId, productKitchenId, bundleProductId,
    nonFulfillmentProductId,
  ])
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
