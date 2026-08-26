import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PostgresCashierWorkbenchQuery } from './cashier-workbench-query.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const orderId = '44444444-4444-4444-8444-444444444444'
const itemId = '55555555-5555-4555-8555-555555555555'
const paymentId = '66666666-6666-4666-8666-666666666666'
const refundId = '77777777-7777-4777-8777-777777777777'

describe('PostgresCashierWorkbenchQuery', () => {
  it('returns current-day orders with payment and per-item remaining refundable amounts', async () => {
    const runner = new QueryRunner([
      [orderRow()],
      [],
      [itemRow()],
      [paymentRow()],
      [refundRow()],
      [allocationRow()],
    ])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    const view = await query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request', 'refund.approve', 'refund.execute', 'community.activity.cashier'],
      query: ' VIP1 ',
      limit: 20,
    })

    expect(view.businessDate).toBe('2026-08-13')
    expect(view.query).toBe('VIP1')
    expect(view.actions).toEqual({
      canInitiateOnlinePayment: false,
      canQueryOnlinePayment: false,
      onlinePaymentProvider: null,
      canRecordManualCash: false,
      canRecordManualPos: false,
      canRecordManualExternal: false,
      canRequestRefund: true,
      canApproveRefund: true,
      canExecuteRefund: true,
      canAuthorizeRecollection: false,
      canUseActivityCashier: true,
      canViewReconciliation: false,
      canManageKdsException: false,
    })
    expect(view.summary).toEqual({
      orderCount: 1,
      capturedPaymentCount: 1,
      requestedRefundCount: 1,
      processingRefundCount: 0,
      carryoverOrderCount: 0,
      carryoverPendingPaymentCount: 0,
      activityPendingPaymentCount: 0,
      activityRequestedRefundCount: 0,
      activityProcessingRefundCount: 0,
    })
    expect(view.orders[0]).toMatchObject({
      publicId: 'ORDER-VIP1-0001', tableCode: 'VIP1', tableSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tableSessionStatus: 'open', outstandingAmountMinor: 0,
    })
    expect(view.orders[0]?.payments[0]).toMatchObject({
      id: paymentId,
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(view.orders[0]?.payments[0]?.refundableItems[0]).toMatchObject({
      id: itemId,
      productName: '精酿啤酒',
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(view.orders[0]?.payments[0]?.refunds[0]).toMatchObject({
      id: refundId,
      requestedByEmployeeName: 'Tom',
      receiptReference: null,
      allocations: [{ orderItemId: itemId, amountMinor: 1_000 }],
    })
    expect(runner.calls[0]?.sql).toContain('session.business_date = $3::date')
    expect(runner.calls[0]?.values).toEqual([
      tenantId,
      storeId,
      '2026-08-13',
      'VIP1',
      20,
      employeeId,
      true,
    ])
    expect(runner.calls[0]?.sql).toContain("workbench_assignment.assignment_type IN ('primary','backup')")
    expect(runner.readOnly).toBe(true)
  })

  it('keeps per-item and payment-level remaining capacity after a succeeded partial refund', async () => {
    const dishItemId = '88888888-8888-4888-8888-888888888888'
    const drinkItemId = '99999999-9999-4999-8999-999999999999'
    const succeededRefundId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const runner = new QueryRunner([
      [orderRow()],
      [
        { ...itemRow(), id: dishItemId, product_name: '主菜', total_amount_minor: '6000' },
        { ...itemRow(), id: drinkItemId, product_name: '酒水', total_amount_minor: '4000' },
      ],
      [{ ...paymentRow(), amount_minor: '10000' }],
      [{
        ...refundRow(),
        id: succeededRefundId,
        amount_minor: '2000',
        status: 'succeeded',
        completed_at: '2026-08-13T12:10:00.000Z',
      }],
      [{ refund_id: succeededRefundId, order_item_id: dishItemId, amount_minor: '2000' }],
      [],
      [],
      [],
    ])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    const view = await query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request'],
      limit: 20,
    })

    const payment = view.orders[0]?.payments[0]
    expect(payment).toMatchObject({
      amountMinor: 10_000,
      reservedRefundAmountMinor: 2_000,
      remainingRefundableMinor: 8_000,
    })
    expect(payment?.refundableItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: dishItemId, remainingRefundableMinor: 4_000 }),
      expect.objectContaining({ id: drinkItemId, remainingRefundableMinor: 4_000 }),
    ]))
  })

  it('projects every historical late success that still has refundable value instead of allowing a newer fully-refunded row to hide it', async () => {
    const runner = new QueryRunner([
      [],
      [activityRow({
        late_success_payments: [
          {
            publicId: 'PAYMENT-LATE-FAILED-0001', amountMinor: 6_800, remainingRefundableMinor: 6_800,
            currency: 'CNY', succeededAt: '2026-08-12T23:58:00.000Z', refundStatus: 'failed',
          },
          {
            publicId: 'PAYMENT-LATE-PENDING-0001', amountMinor: 1_200, remainingRefundableMinor: 1_200,
            currency: 'CNY', succeededAt: '2026-08-12T23:55:00.000Z', refundStatus: 'requested',
          },
        ],
      })],
    ])
    const query = new PostgresCashierWorkbenchQuery(runner as unknown as ScopedPostgresTransactionRunner)

    const view = await query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['community.activity.cashier', 'refund.request'], limit: 20,
    })

    expect(view.activityRegistrations?.[0]?.lateSuccessPayments).toEqual([
      expect.objectContaining({ publicId: 'PAYMENT-LATE-FAILED-0001', remainingRefundableMinor: 6_800, refundStatus: 'failed' }),
      expect.objectContaining({ publicId: 'PAYMENT-LATE-PENDING-0001', remainingRefundableMinor: 1_200, refundStatus: 'requested' }),
    ])
    const activitySql = runner.calls[1]?.sql ?? ''
    expect(activitySql).toContain('jsonb_agg')
    expect(activitySql).toContain("succeeded_refund.status='succeeded'")
    expect(activitySql).toContain('candidate.amount_minor>COALESCE')
  })

  it('returns an empty workbench without running detail queries', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )
    const view = await query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['reconciliation.view'],
      limit: 50,
    })

    expect(view.orders).toEqual([])
    expect(view.summary.orderCount).toBe(0)
    expect(runner.calls).toHaveLength(1)
  })

  it('projects a delivered unpaid settlement exception without describing it as payment', async () => {
    const cancelledOrder = { ...orderRow(), status: 'cancelled', payment_status: 'unpaid' }
    const runner = new QueryRunner([
      [cancelledOrder], [itemRow()], [], [], [], [{
        order_id: orderId, reason_code: 'manager_comp', settled_amount_minor: '8800',
        occurred_at: '2026-08-13T13:00:00.000Z',
      }],
    ])
    const query = new PostgresCashierWorkbenchQuery(runner as unknown as ScopedPostgresTransactionRunner)
    const view = await query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['reconciliation.view', 'order.settle_exception'], limit: 20,
    })
    expect(view.orders[0]?.settlementException).toEqual({
      reasonCode: 'manager_comp', settledAmountMinor: 8_800, occurredAt: '2026-08-13T13:00:00.000Z',
    })
    expect(runner.calls.some((call) => call.sql.includes('order_settlement_exception_events'))).toBe(true)
  })

  it('keeps an unresolved prior-business-day refund visible as handover work', async () => {
    const priorOrder = { ...orderRow(), business_date: '2026-08-12' }
    const runner = new QueryRunner([[priorOrder], [itemRow()], [paymentRow()], [refundRow()], [allocationRow()]])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    const view = await query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['refund.approve'], limit: 20,
    })

    expect(view.summary.carryoverOrderCount).toBe(1)
    expect(view.orders[0]).toMatchObject({ businessDate: '2026-08-12', carryover: true })
    expect(runner.calls[0]?.sql).toContain("orders.payment_status='unpaid'")
    expect(runner.calls[0]?.sql).toContain("carryover_payment.status IN ('created','pending')")
    expect(runner.calls[0]?.sql).toContain("carryover_refund.status IN ('requested','approved','processing')")
  })

  it('projects a completed-refund allocation onto an unstarted KDS task without treating it as an automatic cancellation', async () => {
    const succeededRefund = { ...refundRow(), status: 'succeeded', completed_at: '2026-08-13T12:08:00.000Z' }
    const runner = new QueryRunner([
      [orderRow()], [itemRow()], [paymentRow()], [succeededRefund], [allocationRow()],
      [{ id: '99999999-9999-4999-8999-999999999999', order_item_id: itemId, refundable_order_item_id: itemId, station_code: 'bar', status: 'accepted', quantity: 1 }],
      [], [],
    ])
    const query = new PostgresCashierWorkbenchQuery(runner as unknown as ScopedPostgresTransactionRunner)

    const view = await query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['refund.execute', 'kds.exception.manage'], limit: 20,
    })

    expect(view.actions.canManageKdsException).toBe(true)
    expect(view.orders[0]?.kdsTasks).toEqual([{
      id: '99999999-9999-4999-8999-999999999999',
      orderItemId: itemId,
      stationCode: 'bar',
      status: 'accepted',
      quantity: 1,
      succeededRefundAmountMinor: 1_000,
    }])
    expect(runner.calls.some((call) => call.sql.includes('FROM mbox.kds_tasks'))).toBe(true)
  })

  it('rejects callers without a financial capability before opening the database', () => {
    const runner = new QueryRunner([])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    expect(() => query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['dashboard.view'],
      limit: 50,
    })).toThrow('requires a financial capability')
    expect(runner.runCalls).toBe(0)
  })

  it('allows a manager with only refund request permission to open the workbench', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )
    await expect(query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request'],
      limit: 20,
    })).resolves.toMatchObject({ actions: { canRequestRefund: true, canApproveRefund: false } })
  })

  it('exposes cash collection independently from online payment initiation', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(runner as unknown as ScopedPostgresTransactionRunner)
    await expect(query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['payment.manual.cash.record'], limit: 20,
    })).resolves.toMatchObject({
      actions: { canRecordManualCash: true, canRecordManualPos: false, canRecordManualExternal: false },
    })
  })

  it('exposes other offline collection only with its dedicated permission', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(runner as unknown as ScopedPostgresTransactionRunner)
    await expect(query.get({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-13',
      capabilities: ['payment.manual.external.record'], limit: 20,
    })).resolves.toMatchObject({
      actions: { canRecordManualCash: false, canRecordManualPos: false, canRecordManualExternal: true },
    })
  })

  it('does not treat payment initiation alone as permission to read the store-wide workbench', () => {
    const runner = new QueryRunner([])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    expect(() => query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['payment.initiate.staff'],
      limit: 50,
    })).toThrow('requires a financial capability')
    expect(runner.runCalls).toBe(0)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('PostgresCashierWorkbenchQuery PostgreSQL integration', () => {
  const suffix = randomUUID().slice(0, 8)
  const integrationTenantId = randomUUID()
  const integrationStoreId = randomUUID()
  const integrationAreaId = randomUUID()
  const integrationTableId = randomUUID()
  const integrationCarryoverTableId = randomUUID()
  const integrationSessionId = randomUUID()
  const integrationEmployeeId = randomUUID()
  const integrationApproverId = randomUUID()
  const integrationServerRoleId = randomUUID()
  const integrationProductId = randomUUID()
  const integrationOrderId = randomUUID()
  const integrationItemId = randomUUID()
  const integrationPaymentId = randomUUID()
  const integrationRefundId = randomUUID()
  const integrationCarryoverSessionId = randomUUID()
  const integrationCarryoverOrderId = randomUUID()
  const integrationCarryoverItemId = randomUUID()
  const integrationCarryoverPaymentId = randomUUID()
  const integrationActivityCustomerId = randomUUID()
  const integrationActivityId = randomUUID()
  const integrationActivityRegistrationId = randomUUID()
  const integrationActivityCurrentPaymentId = randomUUID()
  const integrationLateFullyRefundedPaymentId = randomUUID()
  const integrationLateFailedPaymentId = randomUUID()
  const integrationLateRejectedPaymentId = randomUUID()
  const integrationLateFullyRefundedRefundId = randomUUID()
  const integrationLateFailedRefundId = randomUUID()
  const integrationLateRejectedRefundId = randomUUID()
  let pool: Pool
  let query: PostgresCashierWorkbenchQuery

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    query = new PostgresCashierWorkbenchQuery(new ScopedPostgresTransactionRunner(asPool(pool)))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1, $2, 'Cashier Workbench Tenant')`, [integrationTenantId, `cw-${suffix}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Cashier Workbench Store')`, [integrationStoreId, integrationTenantId, `cw-store-${suffix}`])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'VIP', 'VIP区', 'indoor')`, [integrationAreaId, integrationTenantId, integrationStoreId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'VIP1', 'VIP1', 6)`, [integrationTableId, integrationTenantId, integrationStoreId, integrationAreaId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'VIP2', 'VIP2', 6)`, [integrationCarryoverTableId, integrationTenantId, integrationStoreId, integrationAreaId])
    await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, $4, 'Tom'), ($5, $2, $3, $6, '李艳')`, [
      integrationEmployeeId,
      integrationTenantId,
      integrationStoreId,
      `cw-request-${suffix}`,
      integrationApproverId,
      `cw-approve-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,$4,'桌台服务角色')`, [
      integrationServerRoleId, integrationTenantId, integrationStoreId, `CW_SERVER_${suffix.toUpperCase()}`,
    ])
    await pool.query(`INSERT INTO mbox.table_assignments(
      tenant_id,store_id,table_id,employee_id,role_id,assignment_type,reason
    ) VALUES($1,$2,$3,$4,$5,'primary','收银工作台桌台范围测试')`, [
      integrationTenantId, integrationStoreId, integrationTableId,
      integrationEmployeeId, integrationServerRoleId,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions (
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count
    ) VALUES ($1, $2, $3, $4, $5, '2026-08-13', 2)`, [
      integrationSessionId,
      integrationTenantId,
      integrationStoreId,
      integrationTableId,
      `cw-session-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.products (
      id, tenant_id, store_id, code, name, category_code, fulfillment_station, product_snapshot
    ) VALUES ($1, $2, $3, $4, '精酿啤酒', 'beer', 'bar', '{}')`, [
      integrationProductId,
      integrationTenantId,
      integrationStoreId,
      `CW-BEER-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.orders (
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor, currency,
      created_by_employee_id, submitted_at
    ) VALUES ($1, $2, $3, $4, $5, 'staff_assisted', 'completed',
      'partially_refunded', 8800, 8800, 'CNY', $6, '2026-08-13T12:00:00Z')`, [
      integrationOrderId,
      integrationTenantId,
      integrationStoreId,
      integrationSessionId,
      `cw-order-${suffix}`,
      integrationEmployeeId,
    ])
    await pool.query(`INSERT INTO mbox.order_items (
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, currency, fulfillment_station, product_snapshot, status
    ) VALUES ($1, $2, $3, $4, $5, 1, 8800, 8800, 'CNY', 'bar',
      '{"name":"精酿啤酒"}', 'delivered')`, [
      integrationItemId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderId,
      integrationProductId,
    ])
    await pool.query(`INSERT INTO mbox.payments (
      id, tenant_id, store_id, order_id, public_id, provider, provider_transaction_id,
      method, amount_minor, currency, status, succeeded_at
    ) VALUES ($1, $2, $3, $4, $5, 'postar', $6, 'native_qr', 8800, 'CNY',
      'partially_refunded', '2026-08-13T12:02:00Z')`, [
      integrationPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderId,
      `cw-payment-${suffix}`,
      `cw-provider-tx-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.refunds (
      id, tenant_id, store_id, payment_id, public_id, amount_minor, currency, status,
      reason, requested_by_employee_id, approved_by_employee_id, decision_reason
    ) VALUES ($1, $2, $3, $4, $5, 1000, 'CNY', 'approved', '商品未出品', $6, $7, '核对无误')`, [
      integrationRefundId,
      integrationTenantId,
      integrationStoreId,
      integrationPaymentId,
      `cw-refund-${suffix}`,
      integrationEmployeeId,
      integrationApproverId,
    ])
    await pool.query(`INSERT INTO mbox.refund_items (
      tenant_id, store_id, refund_id, order_item_id, amount_minor, currency
    ) VALUES ($1, $2, $3, $4, 1000, 'CNY')`, [
      integrationTenantId,
      integrationStoreId,
      integrationRefundId,
      integrationItemId,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions (
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count
    ) VALUES ($1, $2, $3, $4, $5, '2026-08-12', 2)`, [
      integrationCarryoverSessionId,
      integrationTenantId,
      integrationStoreId,
      integrationCarryoverTableId,
      `cw-carryover-session-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.orders (
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor, currency,
      created_by_employee_id, submitted_at
    ) VALUES ($1, $2, $3, $4, $5, 'staff_assisted', 'submitted',
      'unpaid', 6800, 6800, 'CNY', $6, '2026-08-12T23:50:00Z')`, [
      integrationCarryoverOrderId,
      integrationTenantId,
      integrationStoreId,
      integrationCarryoverSessionId,
      `cw-carryover-order-${suffix}`,
      integrationEmployeeId,
    ])
    await pool.query(`INSERT INTO mbox.order_items (
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, currency, fulfillment_station, product_snapshot, status
    ) VALUES ($1, $2, $3, $4, $5, 1, 6800, 6800, 'CNY', 'bar',
      '{"name":"跨日待查支付"}', 'submitted')`, [
      integrationCarryoverItemId,
      integrationTenantId,
      integrationStoreId,
      integrationCarryoverOrderId,
      integrationProductId,
    ])
    await pool.query(`INSERT INTO mbox.payments (
      id, tenant_id, store_id, order_id, public_id, provider, method,
      amount_minor, currency, status
    ) VALUES ($1, $2, $3, $4, $5, 'postar', 'native_qr', 6800, 'CNY', 'pending')`, [
      integrationCarryoverPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationCarryoverOrderId,
      `cw-carryover-payment-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
      VALUES($1,$2,$3,$4)`, [
      integrationActivityCustomerId, integrationTenantId, integrationStoreId, `cw-activity-customer-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.community_activities(
      id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
      assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,
      registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,
      points_reward,visibility,audience_member_levels,audience_lifecycle_stages,
      safety_policy_version,safety_acknowledgement_text,safety_requirements,
      refund_policy_version,refund_policy_summary,activity_details,included_items,
      participation_requirements,contact_instructions,status,published_at,
      created_by_employee_id,approved_by_employee_id
    ) VALUES($1,$2,$3,$4,'member_night','活动晚到付款收银测试','确保旧周期付款不会漏退',
      clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 3 hours',
      'M-BOX',20,6800,0,'per_registration','full_required',15,'须全额预付','CNY',
      0,'public','{}'::text[],'{}'::text[],'cashier-activity-safety-v1','我已阅读安全要求',ARRAY['遵守安全要求']::text[],
      'cashier-activity-refund-v1','原路退款','活动晚到付款收银测试',ARRAY['欢迎饮品']::text[],
      ARRAY['准时到场']::text[],'店内收银处理','published',clock_timestamp(),$5,$5)`, [
      integrationActivityId, integrationTenantId, integrationStoreId, `cw-activity-${suffix}`, integrationEmployeeId,
    ])
    await pool.query(`INSERT INTO mbox.community_activity_registrations(
      id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,
      payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,
      contact_snapshot,safety_acknowledgement,idempotency_key,refund_policy_snapshot,
      payment_due_at,seat_hold_expires_at,registration_cycle,requested_payment_choice,
      requested_payment_method,requested_amount_due_minor,acknowledged_safety_policy_version,
      acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source
    ) VALUES($1,$2,$3,$4,$5,$6,2,'payment_pending',
      'full','pending',6800,6800,0,'CNY',NULL,
      '{"acknowledged":true,"policyVersion":"cashier-activity-safety-v1"}'::jsonb,
      $7,'{"policyVersion":"cashier-activity-refund-v1","summary":"原路退款"}'::jsonb,
      clock_timestamp()+interval '15 minutes',clock_timestamp()+interval '15 minutes',4,'full',
      'jsapi',6800,'cashier-activity-safety-v1','cashier-activity-refund-v1',clock_timestamp(),'mini_program')`, [
      integrationActivityRegistrationId, integrationTenantId, integrationStoreId,
      `cw-activity-registration-${suffix}`, integrationActivityId, integrationActivityCustomerId,
      `cw-activity-registration-key-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,payable_kind,order_id,activity_registration_id,activity_registration_cycle,
      public_id,provider,method,amount_minor,currency,status,provider_snapshot,provider_transaction_id,succeeded_at
    ) VALUES
      ($1,$5,$6,'activity_registration',NULL,$7,4,$8,'postar','jsapi',6800,'CNY','pending','{}'::jsonb,NULL,NULL),
      ($2,$5,$6,'activity_registration',NULL,$7,3,$9,'postar','jsapi',6800,'CNY','succeeded','{"lateSuccessAfterClose":true}'::jsonb,'late-refunded-provider-transaction','2026-08-12T23:59:00Z'),
      ($3,$5,$6,'activity_registration',NULL,$7,2,$10,'postar','jsapi',6800,'CNY','succeeded','{"lateSuccessAfterClose":true}'::jsonb,'late-failed-provider-transaction','2026-08-12T23:58:00Z'),
      ($4,$5,$6,'activity_registration',NULL,$7,1,$11,'postar','jsapi',1200,'CNY','succeeded','{"lateSuccessAfterClose":true}'::jsonb,'late-rejected-provider-transaction','2026-08-12T23:57:00Z')`, [
      integrationActivityCurrentPaymentId,
      integrationLateFullyRefundedPaymentId,
      integrationLateFailedPaymentId,
      integrationLateRejectedPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationActivityRegistrationId,
      `cw-activity-current-payment-${suffix}`,
      `cw-activity-late-fully-refunded-${suffix}`,
      `cw-activity-late-failed-${suffix}`,
      `cw-activity-late-rejected-${suffix}`,
    ])
    await pool.query(`UPDATE mbox.community_activity_registrations
      SET payment_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [
      integrationTenantId, integrationStoreId, integrationActivityRegistrationId, integrationActivityCurrentPaymentId,
    ])
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,
      provider_refund_id,decision_reason,requested_by_employee_id,approved_by_employee_id,completed_at
    ) VALUES
      ($1,$4,$5,$6,$7,6800,'CNY','succeeded','旧款已全额退回','late-refunded-provider-refund','退款执行完成',$8,$9,'2026-08-13T00:10:00Z'),
      ($2,$4,$5,$10,$11,6800,'CNY','failed','渠道退款失败','late-failed-provider-refund','渠道退款失败',$8,$9,'2026-08-13T00:11:00Z'),
      ($3,$4,$5,$12,$13,1200,'CNY','rejected','复核驳回后可重新申请',NULL,'复核驳回',$8,$9,NULL)`, [
      integrationLateFullyRefundedRefundId,
      integrationLateFailedRefundId,
      integrationLateRejectedRefundId,
      integrationTenantId,
      integrationStoreId,
      integrationLateFullyRefundedPaymentId,
      `cw-activity-late-refunded-refund-${suffix}`,
      integrationEmployeeId,
      integrationApproverId,
      integrationLateFailedPaymentId,
      `cw-activity-late-failed-refund-${suffix}`,
      integrationLateRejectedPaymentId,
      `cw-activity-late-rejected-refund-${suffix}`,
    ])
  })

  afterAll(async () => pool?.end())

  it('executes the read model SQL and isolates the trusted business date', async () => {
    const current = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request', 'refund.approve', 'refund.execute'],
      query: 'VIP',
      limit: 20,
    })
    const stale = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-12',
      capabilities: ['reconciliation.view'],
      limit: 20,
    })

    expect(current.orders).toHaveLength(2)
    const currentOrder = current.orders.find((order) => order.id === integrationOrderId)
    expect(currentOrder?.payments[0]).toMatchObject({
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(currentOrder?.payments[0]?.refundableItems[0]).toMatchObject({
      productName: '精酿啤酒',
      remainingRefundableMinor: 7_800,
    })
    expect(current.summary.processingRefundCount).toBe(1)
    expect(current.activityRegistrations).toEqual([])
    expect(current.summary.carryoverPendingPaymentCount).toBe(1)
    expect(current.orders.some((order) => order.id === integrationCarryoverOrderId && order.carryover)).toBe(true)
    expect(stale.orders).toHaveLength(1)
    expect(stale.orders[0]).toMatchObject({ id: integrationCarryoverOrderId, carryover: false })
    expect(stale.summary.carryoverPendingPaymentCount).toBe(0)
  })

  it('keeps every historical late success with refundable money in the activity queue while excluding a newer fully-refunded payment', async () => {
    const view = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-13',
      capabilities: ['community.activity.cashier', 'refund.request'],
      query: `cw-activity-registration-${suffix}`,
      limit: 20,
    })

    const registration = view.activityRegistrations?.find((entry) => entry.id === integrationActivityRegistrationId)
    expect(registration?.lateSuccessPayments).toEqual([
      expect.objectContaining({
        publicId: `cw-activity-late-failed-${suffix}`,
        amountMinor: 6_800,
        remainingRefundableMinor: 6_800,
        refundStatus: 'failed',
      }),
      expect.objectContaining({
        publicId: `cw-activity-late-rejected-${suffix}`,
        amountMinor: 1_200,
        remainingRefundableMinor: 1_200,
        refundStatus: 'rejected',
      }),
    ])
    expect(registration?.lateSuccessPayments?.some((payment) => (
      payment.publicId === `cw-activity-late-fully-refunded-${suffix}`
    ))).toBe(false)
  })

  it('limits a manual-collection or refund-request employee to assigned tables unless a dedicated store-wide capability exists', async () => {
    const restricted = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationEmployeeId,
      businessDate: '2026-08-13',
      capabilities: ['payment.manual.cash.record', 'refund.request'],
      limit: 20,
    })
    expect(restricted.orders.map((order) => order.id)).toEqual([integrationOrderId])
    expect(restricted.orders.some((order) => order.id === integrationCarryoverOrderId)).toBe(false)

    const storeWide = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request', 'payment.collect.all_tables'],
      limit: 20,
    })
    expect(storeWide.orders.map((order) => order.id).toSorted()).toEqual(
      [integrationOrderId, integrationCarryoverOrderId].toSorted(),
    )
  })
})

class QueryRunner {
  runCalls = 0
  readOnly = false
  calls: { sql: string; values: readonly unknown[] }[] = []

  constructor(private readonly resultSets: Record<string, unknown>[][]) {}

  async run<Result>(
    scope: { tenantId: string; storeId: string },
    handler: (transaction: ScopedTransaction) => Promise<Result>,
    options?: { readOnly?: boolean },
  ): Promise<Result> {
    this.runCalls += 1
    this.readOnly = options?.readOnly === true
    expect(scope).toEqual({ tenantId, storeId })
    return handler({
      scope,
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values })
        const rows = this.resultSets.shift() ?? []
        return { rows: rows as Row[], rowCount: rows.length }
      },
    })
  }
}

function orderRow(): Record<string, unknown> {
  return {
    id: orderId,
    public_id: 'ORDER-VIP1-0001',
    table_code: 'VIP1',
    table_session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    table_session_status: 'open',
    channel: 'staff_assisted',
    status: 'submitted',
    payment_status: 'paid',
    total_amount_minor: '8800',
    currency: 'CNY',
    submitted_at: '2026-08-13T12:00:00.000Z',
    created_at: '2026-08-13T11:59:00.000Z',
    business_date: '2026-08-13',
  }
}

function itemRow(): Record<string, unknown> {
  return {
    id: itemId,
    order_id: orderId,
    product_name: '精酿啤酒',
    quantity: 1,
    total_amount_minor: '8800',
    status: 'delivered',
  }
}

function paymentRow(): Record<string, unknown> {
  return {
    id: paymentId,
    order_id: orderId,
    public_id: 'PAYMENT-VIP1-0001',
    provider: 'postar',
    method: 'native_qr',
    provider_transaction_id: 'POSTAR-TX-0001',
    provider_action_state: 'consumed',
    amount_minor: '8800',
    currency: 'CNY',
    status: 'succeeded',
    succeeded_at: '2026-08-13T12:02:00.000Z',
    created_at: '2026-08-13T12:01:00.000Z',
  }
}

function activityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    public_id: 'ACTIVITY-REGISTRATION-0001',
    activity_public_id: 'ACTIVITY-0001',
    activity_title: '超嗨会员之夜',
    starts_at: '2026-08-13T20:00:00.000Z',
    party_size: 2,
    status: 'payment_pending',
    payment_status: 'pending',
    amount_due_minor: '6800',
    paid_amount_minor: '0',
    currency: 'CNY',
    payment_id: null,
    payment_public_id: null,
    payment_provider: null,
    payment_method: null,
    payment_provider_transaction_id: null,
    payment_provider_action_state: null,
    payment_retry_released_at: null,
    payment_retry_release_reason: null,
    payment_amount_minor: null,
    payment_currency: null,
    payment_status_value: null,
    payment_succeeded_at: null,
    payment_created_at: null,
    refund_id: null,
    refund_public_id: null,
    refund_provider_refund_id: null,
    refund_amount_minor: null,
    refund_currency: null,
    refund_status: null,
    refund_provider_submission_state: null,
    refund_reason: null,
    refund_requested_by_employee_id: null,
    refund_requested_by_employee_name: null,
    refund_approved_by_employee_id: null,
    refund_approved_by_employee_name: null,
    refund_decision_reason: null,
    refund_receipt_reference: null,
    refund_completed_at: null,
    refund_created_at: null,
    recollection_authorization_id: null,
    recollection_authorization_amount_minor: null,
    recollection_authorization_expires_at: null,
    late_success_payments: [],
    ...overrides,
  }
}

function refundRow(): Record<string, unknown> {
  return {
    id: refundId,
    payment_id: paymentId,
    public_id: 'REFUND-VIP1-0001',
    provider_refund_id: null,
    amount_minor: '1000',
    currency: 'CNY',
    status: 'requested',
    provider_submission_state: 'not_started',
    reason: '商品未出品',
    requested_by_employee_id: employeeId,
    requested_by_employee_name: 'Tom',
    approved_by_employee_id: null,
    approved_by_employee_name: null,
    decision_reason: null,
    receipt_reference: null,
    completed_at: null,
    created_at: '2026-08-13T12:05:00.000Z',
  }
}

function allocationRow(): Record<string, unknown> {
  return { refund_id: refundId, order_item_id: itemId, amount_minor: '1000' }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
