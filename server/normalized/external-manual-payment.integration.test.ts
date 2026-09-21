import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { PaymentCommandService } from './payment-command-service.js'
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js'
import { NormalizedProviderObservationAuthority, VerifiedProviderObservationService } from './provider-verification-observation.js'
import { paymentApiPlugin } from './payment-api.js'
import { PostgresCashierWorkbenchQuery } from './cashier-workbench-query.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL

;(adminUrl && runtimeUrl ? describe : describe.skip)('external manual receipts, real restricted LOGIN', () => {
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, money: PaymentCommandService, date: string
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const area = randomUUID(), product = randomUUID(), cashier = randomUUID(), requester = randomUUID()
  const capabilities = ['payment.manual.cash.record', 'payment.manual.external.record', 'payment.collect.all_tables',
    'payment.recollect.authorize', 'reconciliation.view', 'refund.request', 'refund.approve', 'refund.execute']

  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 6 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 6 })
    runner = new ScopedPostgresTransactionRunner(runtime)
    const identity = (await runtime.query('SELECT session_user=current_user AS direct_login, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]
    expect(identity).toEqual({ direct_login: true, rolsuper: false, rolbypassrls: false })
    money = new PaymentCommandService(new NormalizedCommandExecutor(runner), new NormalizedPaymentCapabilityAuthorization(), new NormalizedProviderObservationAuthority())
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'external receipt fixture')", [scope.tenantId, scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'receipt','receipt','Asia/Shanghai','06:00')", [scope.storeId, scope.tenantId])
    date = await runner.run(scope, async tx => (await tx.query<{ date: string }>('SELECT mbox.current_operating_business_date($1,$2)::text date', [scope.tenantId, scope.storeId])).rows[0]!.date)
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [area, scope.tenantId, scope.storeId])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'EXT','Receipt fixture','drink','none')", [product, scope.tenantId, scope.storeId])
    for (const employee of [cashier, requester]) {
      await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)', [employee, scope.tenantId, scope.storeId, employee])
      const role = randomUUID()
      await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')", [role, scope.tenantId, scope.storeId, `EXT_${role.replaceAll('-', '').toUpperCase()}`])
      await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)', [scope.tenantId, scope.storeId, employee, role])
      for (const code of employee === cashier ? capabilities : ['refund.request']) {
        const permission = (await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id", [scope.tenantId, scope.storeId, code])).rows[0].id
        await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope.tenantId, scope.storeId, role, permission])
      }
      if (employee === cashier) await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')", [scope.tenantId, scope.storeId, role])
    }
  }, 30000)
  afterAll(async () => { await runtime?.end(); await admin?.end() })

  const meta = (employeeId = cashier, businessDate = date) => ({ scope, actor: { type: 'employee' as const, employeeId }, businessDate, idempotencyKey: randomUUID(), requestFingerprint: randomUUID() })
  async function post(path: string, payload: object, key = randomUUID(), employeeId = cashier, currentScope = scope) {
    const app = Fastify({ logger: false })
    const context = () => ({ scope: currentScope, actor: { type: 'employee' as const, employeeId }, employeeId, businessDate: date, capabilities })
    const unused = async () => { throw new Error('External provider calls are forbidden in this fixture') }
    await app.register(paymentApiPlugin, { commands: money, providerVerifier: { verifyPaymentCallback: unused, verifyRefundCallback: unused },
      providerObservations: new VerifiedProviderObservationService(runner), reconciliationQuery: { list: unused },
      cashierWorkbenchQuery: new PostgresCashierWorkbenchQuery(runner), orderCancellation: { cancel: unused }, orderSettlementException: { settle: unused },
      resolveActorContext: context, resolveStaffContext: context, resolveProviderBusinessDate: () => date })
    try { return await app.inject({ method: 'POST', url: path, headers: { 'idempotency-key': key }, payload }) } finally { await app.close() }
  }
  const receipt = () => ({ provider: 'external_manual', method: 'manual', receiptReference: `BANK-${randomUUID()}`,
    externalMethodCode: 'bank_transfer', collectionNote: '已核对系统外银行入账回单，原凭证保留' })
  const authorize = (orderId: string) => post(`/orders/${orderId}/recollection-authorizations`, { reason: '核对原退款及真实剩欠，明确授权独立补收' })
  async function newOrder(originalDate = date, session?: string) {
    const table = randomUUID(), order = randomUUID(), item = randomUUID()
    if (!session) {
      session = randomUUID()
      await admin.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)', [table, scope.tenantId, scope.storeId, area, `T${table.slice(0, 8)}`])
      await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)', [session, scope.tenantId, scope.storeId, table, session, originalDate])
    }
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)", [order, scope.tenantId, scope.storeId, session, order])
    await admin.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"fixture","inventoryControlMode":"not_managed"}')`, [item, scope.tenantId, scope.storeId, order, product])
    return { order, session, item }
  }
  async function assertReceipt(paymentId: string, evidence: ReturnType<typeof receipt>, amount: number) {
    const expected = { externalMethodCode: evidence.externalMethodCode, collectionNote: evidence.collectionNote, receiptReference: evidence.receiptReference, collectedByEmployeeId: cashier }
    const payment = (await admin.query('SELECT status,amount_minor::int,provider_snapshot FROM mbox.payments WHERE id=$1', [paymentId])).rows[0]
    expect(payment).toEqual({ status: 'succeeded', amount_minor: amount, provider_snapshot: expected })
    const ledger = (await admin.query('SELECT amount_minor::int,business_date::text,evidence_snapshot FROM mbox.reconciliation_entries WHERE payment_id=$1', [paymentId])).rows
    expect(ledger).toEqual([{ amount_minor: amount, business_date: date, evidence_snapshot: expected }])
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payment_provider_actions WHERE payment_id=$1', [paymentId])).rows[0].n).toBe(0)
  }
  async function withDeniedPermission(code: string, action: () => Promise<void>) {
    await admin.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','fixture current revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4", [scope.tenantId, scope.storeId, cashier, code])
    try { await action() } finally { await admin.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3', [scope.tenantId, scope.storeId, cashier]) }
  }

  it('preserves ordinary receipt evidence through concurrent original-key replay and current revocation', async () => {
    const f = await newOrder(), evidence = receipt(), body = { orderId: f.order, ...evidence }, key = randomUUID()
    const results = await Promise.all([post('/payments/manual', body, key), post('/payments/manual', body, key)])
    expect(results.map(r => r.statusCode).sort(), results.map(r => r.body).join('\n')).toEqual([200, 201])
    const paymentId = results[0]!.json().data.id
    expect(new Set(results.map(r => r.json().data.id)).size).toBe(1)
    expect(results[0]!.json().data.providerSnapshot).toMatchObject({ externalMethodCode: 'bank_transfer', collectionNote: evidence.collectionNote })
    await assertReceipt(paymentId, evidence, 4000)
    expect((await post('/payments/manual', { ...body, collectionNote: '不同的回单说明' }, key)).statusCode).toBe(409)
    await withDeniedPermission('payment.manual.external.record', async () => { expect((await post('/payments/manual', body, key)).statusCode).toBe(403) })
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1", [f.session, cashier])
    expect((await post('/payments/manual', body, key)).json().meta.replayed).toBe(true)
    await assertReceipt(paymentId, evidence, 4000)
  })

  it('keeps complete evidence and single allocations for same-session batch receipts', async () => {
    const first = await newOrder(), second = await newOrder(date, first.session), evidence = receipt()
    const body = { orderIds: [first.order, second.order], ...evidence }, key = randomUUID()
    const paid = await post('/payments/manual', body, key)
    expect(paid.statusCode, paid.body).toBe(201)
    await assertReceipt(paid.json().data.id, evidence, 8000)
    expect((await post('/payments/manual', body, key)).json().meta.replayed).toBe(true)
    const allocations = (await admin.query('SELECT order_id,amount_minor::int FROM mbox.order_payment_allocations WHERE batch_id=$1 ORDER BY order_id', [paid.json().data.orderBatchId])).rows
    expect(allocations).toHaveLength(2)
    expect(allocations.map(a => a.amount_minor)).toEqual([4000, 4000])
    await withDeniedPermission('payment.manual.external.record', async () => { expect((await post('/payments/manual', body, key)).statusCode).toBe(403) })
  })

  it('collects cross-day closed historical debt once without rewriting original money, item or session facts', async () => {
    const originalDate = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
    const f = await newOrder(originalDate)
    const original = (await money.recordManual({ ...meta(cashier, originalDate), orderId: f.order, publicId: randomUUID(), provider: 'cash', method: 'cash', evidence: { collectedByEmployeeId: cashier, receiptReference: randomUUID() } })).value
    const refund = (await money.requestRefund({ ...meta(requester, originalDate), paymentId: original.id, publicId: randomUUID(), purpose: 'price_adjustment', reason: '已核准原普通退款', allocations: [{ orderItemId: f.item, amountMinor: 2000 }] })).value
    await money.approveRefund({ ...meta(cashier, originalDate), refundId: refund.id, decisionReason: '异人审核原退款' })
    await money.beginRefundExecution({ ...meta(cashier, originalDate), refundId: refund.id })
    await money.recordManualRefundResult({ ...meta(cashier, originalDate), refundId: refund.id, succeeded: true, receiptReference: randomUUID() })
    expect((await authorize(f.order)).statusCode).toBe(201)
    // Model the pre-235 closed-with-debt fact; actual old dump upgrade is covered
    // separately. Command timestamps are real, business metadata is cross-day.
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1", [f.session, cashier])
    const before = (await admin.query('SELECT to_jsonb(s) session,to_jsonb(i) item FROM mbox.table_sessions s JOIN mbox.order_items i ON i.id=$2 WHERE s.id=$1', [f.session, f.item])).rows[0]
    const originalLedger = (await admin.query('SELECT * FROM mbox.reconciliation_entries WHERE payment_id=$1 ORDER BY id', [original.id])).rows
    expect((await authorize(f.order)).statusCode).toBe(201)
    const evidence = receipt(), body = { orderId: f.order, ...evidence }, key = randomUUID()
    const paid = await post('/payments/manual', body, key)
    expect(paid.statusCode, paid.body).toBe(201)
    await assertReceipt(paid.json().data.id, evidence, 2000)
    for (const code of ['payment.manual.external.record', 'payment.collect.all_tables', 'payment.recollect.authorize']) {
      await withDeniedPermission(code, async () => { expect((await post('/payments/manual', body, key)).statusCode, code).toBe(403) })
    }
    expect((await post('/payments/manual', body, key)).json().meta.replayed).toBe(true)
    expect((await post('/payments/manual', { ...body, receiptReference: 'CHANGED-BANK-RECEIPT' }, key)).statusCode).toBe(409)
    expect((await admin.query('SELECT to_jsonb(s) session,to_jsonb(i) item FROM mbox.table_sessions s JOIN mbox.order_items i ON i.id=$2 WHERE s.id=$1', [f.session, f.item])).rows[0]).toEqual(before)
    expect((await admin.query('SELECT * FROM mbox.reconciliation_entries WHERE payment_id=$1 ORDER BY id', [original.id])).rows).toEqual(originalLedger)
    const recovered = (await admin.query("SELECT business_date::text,after_snapshot FROM mbox.audit_events WHERE action='payment.closed_debt_recovered' AND object_id=$1", [paid.json().data.id])).rows
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ business_date: date, after_snapshot: { originalBusinessDate: originalDate, collectionBusinessDate: date, amountMinor: 2000 } })
    const workbench = await new PostgresCashierWorkbenchQuery(runner).get({ scope, employeeId: cashier, businessDate: date, capabilities, query: f.order, limit: 10 })
    expect(workbench.orders.find(order => order.id === f.order)?.outstandingAmountMinor).toBe(0)
  })

  it('rejects missing, invalid or forged evidence and unauthorized scope before any collection', async () => {
    const f = await newOrder(), evidence = receipt(), body = { orderId: f.order, ...evidence }
    for (const override of [{ externalMethodCode: null }, { externalMethodCode: 'unknown_method' }, { collectionNote: '' }, { receiptReference: '' }, { method: 'cash' }]) {
      expect((await post('/payments/manual', { ...body, ...override })).statusCode).toBe(400)
    }
    expect((await post('/payments/manual', { ...body, actorId: requester })).statusCode).toBe(403)
    expect((await post('/payments/manual', body, randomUUID(), requester)).statusCode).toBe(403)
    expect((await post('/payments/manual', body, randomUUID(), cashier, { tenantId: randomUUID(), storeId: randomUUID() })).statusCode).toBe(403)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1', [f.order])).rows[0].n).toBe(0)
  })
})
