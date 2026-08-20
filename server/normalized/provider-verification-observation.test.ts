import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  NormalizedProviderObservationAuthority,
  ProviderObservationAuthorizationError,
  VerifiedProviderObservationService,
} from './provider-verification-observation.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('verified provider observation PostgreSQL authority', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let observations: VerifiedProviderObservationService
  const authority = new NormalizedProviderObservationAuthority()
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const otherStoreId = randomUUID()
  const employeeId = randomUUID()
  const requesterEmployeeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const pendingOrderId = randomUUID()
  const capturedOrderId = randomUUID()
  const pendingPaymentId = randomUUID()
  const capturedPaymentId = randomUUID()
  const refundId = randomUUID()
  const pendingPaymentPublicId = 'verified-observation-payment-pending-0001'
  const capturedPaymentPublicId = 'verified-observation-payment-captured-0001'
  const refundPublicId = 'verified-observation-refund-0001'

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 5 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    observations = new VerifiedProviderObservationService(transactions)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1,$2,'Provider observation tenant')`, [
      tenantId, `provider-observation-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES
        ($1,$3,$4,'Provider observation store'),
        ($2,$3,$5,'Other provider observation store')
    `, [storeId, otherStoreId, tenantId, `provider-${storeId.slice(0, 8)}`, `provider-${otherStoreId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name) VALUES
        ($1,$3,$4,'PROVIDER_OBSERVER','Provider Observer'),
        ($2,$3,$4,'PROVIDER_REQUESTER','Provider Refund Requester')
    `, [employeeId, requesterEmployeeId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
      VALUES ($1,$2,$3,'OBS','Observation area','indoor')
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1,$2,$3,$4,'OBS01','OBS01',4)
    `, [tableId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status)
      VALUES ($1,$2,$3,$4,$5,current_date,2,'open')
    `, [tableSessionId, tenantId, storeId, tableId, `provider-session-${tableSessionId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.orders(
        id, tenant_id, store_id, table_session_id, public_id, channel,
        settlement_mode, status, payment_status,
        subtotal_amount_minor, total_amount_minor
      ) VALUES
        ($1,$3,$4,$5,$6,'integration','table_tab','submitted','pending',8800,8800),
        ($2,$3,$4,$5,$7,'integration','table_tab','submitted','paid',8800,8800)
    `, [
      pendingOrderId, capturedOrderId, tenantId, storeId, tableSessionId,
      `provider-order-${pendingOrderId.slice(0, 8)}`,
      `provider-order-${capturedOrderId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.payments(
        id, tenant_id, store_id, order_id, public_id, provider,
        provider_transaction_id, method, amount_minor, currency, status,
        settlement_channel, succeeded_at
      ) VALUES
        ($1,$3,$4,$5,$6,'postar',NULL,'native_qr',8800,'CNY','pending',NULL,NULL),
        ($2,$3,$4,$7,$8,'postar','POSTAR-PAYMENT-CAPTURED','native_qr',8800,'CNY',
          'succeeded','wechat',clock_timestamp())
    `, [
      pendingPaymentId, capturedPaymentId, tenantId, storeId,
      pendingOrderId, pendingPaymentPublicId, capturedOrderId, capturedPaymentPublicId,
    ])
    await pool.query(`
      INSERT INTO mbox.refunds(
        id, tenant_id, store_id, payment_id, public_id, amount_minor, currency,
        status, reason, requested_by_employee_id, approved_by_employee_id,
        decision_reason, merchant_refund_id, provider_submission_started_at,
        provider_submission_state
      ) VALUES (
        $1,$2,$3,$4,$5,1000,'CNY','processing','provider observation test',
        $6,$7,'approved for provider observation test',$8,clock_timestamp(),'submitted'
      )
    `, [refundId, tenantId, storeId, capturedPaymentId, refundPublicId, requesterEmployeeId, employeeId, refundId.replaceAll('-', '')])
  })

  afterAll(async () => pool?.end())

  it('records, exactly binds and consumes a callback observation once', async () => {
    const observationId = await observations.recordPayment({
      scope: { tenantId, storeId }, provider: 'postar',
      verificationKind: 'callback_signature', providerEventId: 'provider-payment-event-0001',
      integrationRef: 'postar:verified-callback', paymentPublicId: pendingPaymentPublicId,
      providerTransactionId: 'POSTAR-PAYMENT-0001', reportedAmountMinor: 8800,
      reportedCurrency: 'CNY', status: 'succeeded', settlementChannel: 'wechat',
      occurredAt: '2026-08-16T12:00:00.000Z',
      evidence: { tradeState: 'SUCCESS', signatureVerified: true, verificationAlgorithm: 'forged-key' },
    })
    await transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'payment.callback',
      idempotencyKey: 'provider-payment-command-0001', integrationRef: 'postar:verified-callback',
      provider: 'postar', subjectPublicId: pendingPaymentPublicId,
      providerTransactionId: 'POSTAR-PAYMENT-0001', reportedAmountMinor: 8800,
      reportedCurrency: 'CNY', observedStatus: 'payment_succeeded', settlementChannel: 'wechat',
    }))
    await expect(transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'payment.callback',
      idempotencyKey: 'provider-payment-command-0002', integrationRef: 'postar:verified-callback',
      provider: 'postar', subjectPublicId: pendingPaymentPublicId,
      providerTransactionId: 'POSTAR-PAYMENT-0001', reportedAmountMinor: 8800,
      reportedCurrency: 'CNY', observedStatus: 'payment_succeeded', settlementChannel: 'wechat',
    }))).rejects.toThrow('already consumed')

    const stored = await pool.query(`
      SELECT verification_kind, observed_status, consumed_operation,
        evidence_sha256, to_jsonb(observation)-ARRAY['evidence_sha256'] AS public_shape
      FROM mbox.verified_provider_observations observation WHERE id=$1
    `, [observationId])
    expect(stored.rows[0]).toMatchObject({
      verification_kind: 'callback_signature', observed_status: 'payment_succeeded',
      consumed_operation: 'payment.callback',
    })
    expect(stored.rows[0]?.evidence_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored.rows[0]?.public_shape)).not.toContain('signatureVerified')
    expect(JSON.stringify(stored.rows[0]?.public_shape)).not.toContain('verificationAlgorithm')
  })

  it('does not let an active-query observation authorize a callback or conflicting event facts', async () => {
    const input = {
      scope: { tenantId, storeId }, provider: 'postar' as const,
      verificationKind: 'active_query_binding' as const,
      providerEventId: 'provider-query-event-0001', integrationRef: 'postar-active-query',
      paymentPublicId: pendingPaymentPublicId, providerTransactionId: 'POSTAR-PAYMENT-0001',
      reportedAmountMinor: 8800, reportedCurrency: 'CNY', status: 'pending' as const,
      occurredAt: '2026-08-16T12:01:00.000Z', evidence: { providerStatus: 'pending' },
    }
    const observationId = await observations.recordPayment(input)
    await expect(observations.recordPayment({
      ...input,
      evidence: { providerStatus: 'different-receipt' },
    })).rejects.toThrow('conflicts with different verified facts')
    await expect(transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'payment.callback',
      idempotencyKey: 'provider-query-as-callback-0001', integrationRef: 'postar-active-query',
      provider: 'postar', subjectPublicId: pendingPaymentPublicId,
      providerTransactionId: 'POSTAR-PAYMENT-0001', reportedAmountMinor: 8800,
      reportedCurrency: 'CNY', observedStatus: 'payment_pending',
    }))).rejects.toBeInstanceOf(ProviderObservationAuthorizationError)
    await expect(transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'payment.provider-query',
      idempotencyKey: 'provider-query-command-0001', integrationRef: 'postar-active-query',
      provider: 'postar', subjectPublicId: pendingPaymentPublicId,
      providerTransactionId: 'POSTAR-PAYMENT-0001', reportedAmountMinor: 8800,
      reportedCurrency: 'CNY', observedStatus: 'payment_pending',
    }))).resolves.toBeUndefined()
  })

  it('binds a refund terminal observation to the approved refund and original payment', async () => {
    const observationId = await observations.recordRefund({
      scope: { tenantId, storeId }, provider: 'postar',
      verificationKind: 'active_query_binding', providerEventId: 'provider-refund-query-event-0001',
      integrationRef: 'postar-refund-active-query', refundPublicId,
      providerTransactionId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'POSTAR-PAYMENT-CAPTURED',
      reportedAmountMinor: 1000, reportedCurrency: 'CNY', status: 'succeeded',
      occurredAt: '2026-08-16T12:02:00.000Z', evidence: { providerStatus: 'succeeded' },
    })
    await expect(transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'refund.result',
      idempotencyKey: 'provider-refund-command-0001', integrationRef: 'postar-refund-active-query',
      provider: 'postar', subjectPublicId: refundPublicId,
      providerTransactionId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'FORGED-ORIGINAL', reportedAmountMinor: 1000,
      reportedCurrency: 'CNY', observedStatus: 'refund_succeeded',
    }))).rejects.toBeInstanceOf(ProviderObservationAuthorizationError)
    await expect(transactions.run({ tenantId, storeId }, (transaction) => authority.consume({
      transaction, observationId, operation: 'refund.result',
      idempotencyKey: 'provider-refund-command-0001', integrationRef: 'postar-refund-active-query',
      provider: 'postar', subjectPublicId: refundPublicId,
      providerTransactionId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'POSTAR-PAYMENT-CAPTURED', reportedAmountMinor: 1000,
      reportedCurrency: 'CNY', observedStatus: 'refund_succeeded',
    }))).resolves.toBeUndefined()
  })

  it('enforces store RLS for observation evidence', async () => {
    const hidden = await transactions.run({ tenantId, storeId: otherStoreId }, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      return transaction.query(`SELECT count(*)::integer AS count FROM mbox.verified_provider_observations`)
    }, { readOnly: true })
    expect(hidden.rows[0]?.count).toBe(0)
  })
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
