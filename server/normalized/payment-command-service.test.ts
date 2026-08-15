import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type {
  CommandExecution,
  CommandOutcome,
  IdempotentCommand,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { PaymentCommandService } from './payment-command-service.js'
import type { Payment } from './payment-repository.js'
import {
  NormalizedPaymentCapabilityAuthorization,
  PaymentAuthorizationError,
  paymentBusinessEventKey,
  type PaymentCapabilityAuthorizationPort,
} from './payment-security-policy.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
  type ScopedTransaction,
} from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const orderOneId = '33333333-3333-4333-8333-333333333331'
const orderTwoId = '33333333-3333-4333-8333-333333333332'
const paymentOneId = '44444444-4444-4444-8444-444444444441'
const paymentTwoId = '44444444-4444-4444-8444-444444444442'
const allowAllAuthorization: PaymentCapabilityAuthorizationPort = {
  assertEmployeeCapability: async () => undefined,
  assertRefundApproval: async () => undefined,
}

describe('PaymentCommandService', () => {
  it('uses the command idempotency boundary so a duplicate payment callback runs once', async () => {
    const transaction = new PaymentFlowTransaction(orderOneId, paymentOneId, 'callback')
    const executor = new MemoryIdempotentExecutor(() => transaction)
    const service = new PaymentCommandService(executor, allowAllAuthorization)
    const input = callbackCommand()

    const first = await service.recordSucceededCallback(input)
    const replay = await service.recordSucceededCallback(input)

    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(executor.handlerCalls).toBe(1)
    expect(executor.outcomes[0]?.auditEvents).toHaveLength(1)
    expect(executor.outcomes[0]?.outboxMessages).toHaveLength(1)
    expect(transaction.calls.filter((sql) => sql.includes('UPDATE mbox.payments'))).toHaveLength(1)
    expect(transaction.calls.filter((sql) => sql.includes('UPDATE mbox.payment_provider_actions')))
      .toHaveLength(1)
    expect(transaction.calls.filter((sql) => sql.includes('INSERT INTO mbox.reconciliation_entries')))
      .toHaveLength(1)
  })

  it('rejects an unverified or unidentified provider callback before opening a transaction', async () => {
    const transaction = new PaymentFlowTransaction(orderOneId, paymentOneId, 'callback')
    const executor = new MemoryIdempotentExecutor(() => transaction)
    const service = new PaymentCommandService(executor, allowAllAuthorization)

    expect(() => service.recordSucceededCallback({
      ...callbackCommand(),
      idempotencyKey: 'callback-unverified-provider-0001',
      providerSnapshot: { tradeState: 'SUCCESS', signature: 'untrusted' },
    })).toThrow('verified signature')
    expect(() => service.recordSucceededCallback({
      ...callbackCommand(),
      idempotencyKey: 'callback-unidentified-provider-0002',
      actor: { type: 'employee', employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    })).toThrow('identified integration')

    expect(executor.handlerCalls).toBe(0)
    expect(transaction.calls).toEqual([])
  })

  it('lets different orders progress concurrently without a process-wide payment queue', async () => {
    const transactions = new Map([
      ['init-order-one-0001', new PaymentFlowTransaction(orderOneId, paymentOneId, 'initiate')],
      ['init-order-two-0001', new PaymentFlowTransaction(orderTwoId, paymentTwoId, 'initiate')],
    ])
    const executor = new MemoryIdempotentExecutor((key) => transactions.get(key)!)
    const service = new PaymentCommandService(executor, allowAllAuthorization)

    const [first, second] = await Promise.all([
      service.initiate(initiateCommand(orderOneId, 'init-order-one-0001', 'payment-public-one')),
      service.initiate(initiateCommand(orderTwoId, 'init-order-two-0001', 'payment-public-two')),
    ])

    expect(executor.maxActiveHandlers).toBe(2)
    expect(first.value.orderId).toBe(orderOneId)
    expect(second.value.orderId).toBe(orderTwoId)
    expect(transactions.get('init-order-one-0001')?.lockedOrderIds).toEqual([orderOneId, orderOneId, orderOneId])
    expect(transactions.get('init-order-two-0001')?.lockedOrderIds).toEqual([orderTwoId, orderTwoId, orderTwoId])
  })

  it('rolls the payment mutation back when audit insertion fails', async () => {
    const client = new RollbackClient()
    const pool: PostgresPool = {
      connect: async () => client,
      end: async () => undefined,
    }
    const service = new PaymentCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool)),
      allowAllAuthorization,
    )

    await expect(service.initiate(initiateCommand(
      orderOneId,
      'rollback-payment-0001',
      'payment-rollback-one',
    ))).rejects.toThrow('audit insertion failed')

    expect(client.paymentCommitted).toBe(false)
    expect(client.commands).toContain('ROLLBACK')
    expect(client.commands).not.toContain('COMMIT')
  })

  it('authorizes every human cash, POS and refund action before any financial write', async () => {
    const transaction = new PaymentFlowTransaction(orderOneId, paymentOneId, 'initiate')
    const denied: string[] = []
    const authorization: PaymentCapabilityAuthorizationPort = {
      assertEmployeeCapability: async ({ capability }) => {
        denied.push(capability)
        throw new PaymentAuthorizationError(`denied:${capability}`)
      },
      assertRefundApproval: async () => {
        denied.push('refund.approve')
        throw new PaymentAuthorizationError('denied:refund.approve')
      },
    }
    const service = new PaymentCommandService(
      new MemoryIdempotentExecutor(() => transaction),
      authorization,
    )
    const employeeActor = {
      type: 'employee' as const,
      employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    const metadata = (key: string) => ({
      scope: { tenantId, storeId },
      actor: employeeActor,
      businessDate: '2026-08-11',
      idempotencyKey: key,
      requestFingerprint: key,
    })

    await expect(service.recordManual({
      ...metadata('auth-cash-record-0001'),
      orderId: orderOneId,
      publicId: 'auth-cash-payment-0001',
      provider: 'cash',
      method: 'cash',
      evidence: {
        receiptReference: 'CASH-0001',
        collectedByEmployeeId: employeeActor.employeeId,
      },
      occurredAt: '2026-08-11T12:00:00.000Z',
    })).rejects.toThrow('denied:payment.manual.cash.record')
    await expect(service.recordManual({
      ...metadata('auth-pos-record-0001'),
      orderId: orderOneId,
      publicId: 'auth-pos-payment-0001',
      provider: 'physical_pos',
      method: 'card',
      evidence: {
        terminalId: 'POS-01',
        receiptReference: 'POS-0001',
        collectedByEmployeeId: employeeActor.employeeId,
      },
      occurredAt: '2026-08-11T12:00:00.000Z',
    })).rejects.toThrow('denied:payment.manual.pos.record')
    await expect(service.requestRefund({
      ...metadata('auth-refund-request-0001'),
      paymentId: paymentOneId,
      publicId: 'auth-refund-request-one',
      reason: 'test',
      allocations: [{ orderItemId: orderOneId, amountMinor: 100 }],
    })).rejects.toThrow('denied:refund.request')
    await expect(service.approveRefund({
      ...metadata('auth-refund-approve-0001'),
      refundId: paymentOneId,
      decisionReason: '同意测试退款',
    })).rejects.toThrow('denied:refund.approve')
    await expect(service.rejectRefund({
      ...metadata('auth-refund-reject-0001'),
      refundId: paymentOneId,
      decisionReason: '拒绝测试退款',
    })).rejects.toThrow('denied:refund.approve')
    await expect(service.beginRefundExecution({
      ...metadata('auth-refund-execute-0001'),
      refundId: paymentOneId,
    })).rejects.toThrow('denied:refund.execute')
    await expect(service.recordManualRefundResult({
      ...metadata('auth-refund-result-0001'),
      refundId: paymentOneId,
      succeeded: false,
      receiptReference: 'MANUAL-REFUND-001',
      occurredAt: '2026-08-11T12:00:00.000Z',
    })).rejects.toThrow('denied:refund.execute')

    expect(denied).toEqual([
      'payment.manual.cash.record',
      'payment.manual.pos.record',
      'refund.request',
      'refund.approve',
      'refund.approve',
      'refund.execute',
      'refund.execute',
    ])
    expect(transaction.calls).toEqual([])
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const integrationTenantId = 'c1000000-0000-4000-8000-000000000001'
const integrationStoreId = 'c1000000-0000-4000-8000-000000000002'
const integrationRequesterId = 'c1000000-0000-4000-8000-000000000003'
const integrationApproverId = 'c1000000-0000-4000-8000-000000000004'
const integrationRequesterRoleId = 'c1000000-0000-4000-8000-000000000007'
const integrationApproverRoleId = 'c1000000-0000-4000-8000-000000000008'
const integrationRequesterRoleAssignmentId = 'c1000000-0000-4000-8000-000000000009'
const integrationApproverRoleAssignmentId = 'c1000000-0000-4000-8000-00000000000a'
const integrationApprovalLimitId = 'c1000000-0000-4000-8000-00000000000b'
const integrationOrderOne = 'c1000000-0000-4000-8000-000000000021'
const integrationOrderTwo = 'c1000000-0000-4000-8000-000000000022'
const integrationOrderThree = 'c1000000-0000-4000-8000-000000000023'
const integrationOrderRollback = 'c1000000-0000-4000-8000-000000000024'
const integrationItemOne = 'c1000000-0000-4000-8000-000000000031'

integration('normalized payment PostgreSQL integration', () => {
  let pool: Pool
  let service: PaymentCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    service = new PaymentCommandService(
      new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(pool))),
      new NormalizedPaymentCapabilityAuthorization(),
    )
    await seedPaymentIntegration(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('persists idempotent callback, human-approved item refund and financial evidence', async () => {
    const initiated = await service.initiate(integrationInitiate(
      integrationOrderOne,
      'integration-payment-one',
      'integration-payment-init-0001',
    ))
    await pool.query(`
      INSERT INTO mbox.payment_provider_actions(
        payment_id, tenant_id, store_id, presentation,
        initiated_by_type, initiated_by_ref, state,
        ciphertext, nonce, auth_tag, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'qr',
        'employee', $4::uuid, 'ready',
        decode(repeat('01', 24), 'hex'),
        decode(repeat('02', 12), 'hex'),
        decode(repeat('03', 16), 'hex'),
        clock_timestamp() + interval '5 minutes'
      )
    `, [initiated.value.id, integrationTenantId, integrationStoreId, integrationRequesterId])
    const callback = integrationCallback(initiated.value.publicId, initiated.value.amountMinor)
    const first = await service.recordSucceededCallback(callback)
    const replay = await service.recordSucceededCallback(callback)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    const providerReplay = await service.recordSucceededCallback({
      ...callback,
      idempotencyKey: 'integration-payment-callback-provider-retry-0002',
      requestFingerprint: JSON.stringify({
        paymentPublicId: callback.paymentPublicId,
        amountMinor: callback.reportedAmountMinor,
        transaction: callback.providerTransactionId,
        delivery: 2,
      }),
    })
    expect(providerReplay).toMatchObject({ replayed: false, value: { status: 'succeeded' } })

    const callbackEvidence = await pool.query<{
      reconciliation: string
      outbox: string
      audit: string
      stored_snapshot: JsonObject
      audit_snapshot: JsonObject
      outbox_payload: JsonObject
      idempotency_snapshot: JsonObject
      action_state: string
      action_payload_cleared: boolean
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.reconciliation_entries
          WHERE provider = 'postar' AND provider_reference = $2) AS reconciliation,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE message_key = $3) AS outbox,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE object_type = 'payment' AND object_id = $1::text AND action = 'payment.succeeded') AS audit,
        (SELECT provider_snapshot FROM mbox.payments WHERE id = $1::uuid) AS stored_snapshot,
        (SELECT after_snapshot FROM mbox.audit_events
          WHERE object_type = 'payment' AND object_id = $1::text AND action = 'payment.succeeded'
          ORDER BY occurred_at DESC LIMIT 1) AS audit_snapshot,
        (SELECT payload FROM mbox.outbox_messages WHERE message_key = $3) AS outbox_payload,
        (SELECT response_snapshot FROM mbox.idempotency_records
          WHERE operation_scope = 'payment.callback' AND idempotency_key = $4) AS idempotency_snapshot,
        (SELECT state FROM mbox.payment_provider_actions
          WHERE payment_id = $1::uuid) AS action_state,
        (SELECT ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL
          FROM mbox.payment_provider_actions
          WHERE payment_id = $1::uuid) AS action_payload_cleared
    `, [
      initiated.value.id,
      callback.providerTransactionId,
      paymentBusinessEventKey('succeeded', 'postar', callback.providerTransactionId),
      'integration-payment-callback-provider-retry-0002',
    ])
    expect(callbackEvidence.rows[0]).toMatchObject({ reconciliation: '1', outbox: '1', audit: '1' })
    expect(callbackEvidence.rows[0]).toMatchObject({
      action_state: 'consumed',
      action_payload_cleared: true,
    })
    const serializedEvidence = JSON.stringify(callbackEvidence.rows[0])
    expect(serializedEvidence).not.toContain('secret-signature')
    expect(serializedEvidence).not.toContain('secret-token')
    expect(serializedEvidence).not.toContain('customer-openid')
    expect(serializedEvidence).not.toContain('authorization')
    expect(callbackEvidence.rows[0]?.stored_snapshot).toEqual({
      signatureVerified: true,
      tradeState: 'SUCCESS',
    })

    const requested = await service.requestRefund({
      ...integrationMetadata('integration-refund-request-0001', '{"refund":1000}'),
      actor: { type: 'employee', employeeId: integrationRequesterId },
      paymentId: initiated.value.id,
      publicId: 'integration-refund-one',
      reason: 'integration partial item refund',
      allocations: [{ orderItemId: integrationItemOne, amountMinor: 1000 }],
    })
    await upsertPaymentApprovalLimit(pool)
    await expect(service.approveRefund({
      ...integrationMetadata('integration-refund-self-approve-0001', '{"approve":"self"}'),
      actor: { type: 'employee', employeeId: integrationRequesterId },
      refundId: requested.value.id,
      decisionReason: '申请人不能审批自己的退款',
    })).rejects.toBeInstanceOf(PaymentAuthorizationError)
    const overLimit = await service.requestRefund({
      ...integrationMetadata('integration-refund-over-limit-request-0001', '{"refund":6000}'),
      actor: { type: 'employee', employeeId: integrationRequesterId },
      paymentId: initiated.value.id,
      publicId: 'integration-refund-over-limit',
      reason: 'approval limit test',
      allocations: [{ orderItemId: integrationItemOne, amountMinor: 6000 }],
    })
    await expect(service.approveRefund({
      ...integrationMetadata('integration-refund-over-limit-approve-0001', '{"approve":6000}'),
      actor: { type: 'employee', employeeId: integrationApproverId },
      refundId: overLimit.value.id,
      decisionReason: '金额超过权限测试',
    })).rejects.toThrow('exceeds employee approval limit')
    await expect(service.beginRefundExecution({
      ...integrationMetadata('integration-refund-no-approval-0001', '{"execute":"early"}'),
      actor: { type: 'employee', employeeId: integrationApproverId },
      refundId: requested.value.id,
    })).rejects.toThrow('requires human approval')

    await service.approveRefund({
      ...integrationMetadata('integration-refund-approve-0001', '{"approve":true}'),
      actor: { type: 'employee', employeeId: integrationApproverId },
      refundId: requested.value.id,
      decisionReason: '商品未出品，同意退款',
    })
    await service.beginRefundExecution({
      ...integrationMetadata('integration-refund-execute-0001', '{"execute":true}'),
      actor: { type: 'employee', employeeId: integrationApproverId },
      refundId: requested.value.id,
    })
    await service.recordProviderRefundResult({
      ...integrationMetadata('integration-refund-result-0001', '{"result":"succeeded"}'),
      actor: { type: 'integration', ref: 'postar-refund-callback' },
      refundPublicId: requested.value.publicId,
      provider: 'postar',
      succeeded: true,
      providerRefundId: 'integration-provider-refund-0001',
      originalProviderTransactionId: callback.providerTransactionId,
      reportedAmountMinor: requested.value.amountMinor,
      reportedCurrency: requested.value.currency,
      providerSnapshot: { signatureVerified: true },
      occurredAt: '2026-08-11T13:00:00.000Z',
    })

    const evidence = await pool.query<{
      payments: string
      refunds: string
      reconciliation: string
      audits: string
      outbox: string
      refund_decision: string
      approval_audit_reason: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.payments WHERE order_id = $1::uuid) AS payments,
        (SELECT count(*)::text FROM mbox.refunds r JOIN mbox.payments p ON p.id = r.payment_id
          WHERE p.order_id = $1::uuid AND r.status = 'succeeded') AS refunds,
        (SELECT count(*)::text FROM mbox.reconciliation_entries e JOIN mbox.payments p ON p.id = e.payment_id
          WHERE p.order_id = $1::uuid) AS reconciliation,
        (SELECT count(*)::text FROM mbox.audit_events WHERE object_type IN ('payment', 'refund')) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE aggregate_type IN ('payment', 'refund')) AS outbox,
        (SELECT r.decision_reason FROM mbox.refunds r JOIN mbox.payments p ON p.id = r.payment_id
          WHERE p.order_id = $1::uuid AND r.public_id = 'integration-refund-one') AS refund_decision,
        (SELECT reason FROM mbox.audit_events
          WHERE object_type = 'refund' AND object_id = $2::text AND action = 'refund.approved'
          ORDER BY occurred_at DESC LIMIT 1) AS approval_audit_reason
    `, [integrationOrderOne, requested.value.id])
    expect(evidence.rows[0]).toMatchObject({ payments: '1', refunds: '1', reconciliation: '2' })
    expect(Number(evidence.rows[0]?.audits)).toBeGreaterThanOrEqual(6)
    expect(Number(evidence.rows[0]?.outbox)).toBeGreaterThanOrEqual(6)
    expect(evidence.rows[0]?.refund_decision).toBe('商品未出品，同意退款')
    expect(evidence.rows[0]?.approval_audit_reason).toBe('商品未出品，同意退款')
  })

  it('rejects a departed employee before resolving or mutating a refund', async () => {
    await pool.query('UPDATE mbox.employees SET status = \'departed\' WHERE id = $1::uuid', [
      integrationRequesterId,
    ])
    try {
      await expect(service.requestRefund({
        ...integrationMetadata('integration-departed-refund-request-0001', '{"refund":100}'),
        actor: { type: 'employee', employeeId: integrationRequesterId },
        paymentId: paymentOneId,
        publicId: 'integration-departed-refund',
        reason: 'must be denied',
        allocations: [{ orderItemId: integrationItemOne, amountMinor: 100 }],
      })).rejects.toThrow('not active')
    } finally {
      await pool.query('UPDATE mbox.employees SET status = \'active\' WHERE id = $1::uuid', [
        integrationRequesterId,
      ])
    }
  })

  it('enforces captured-payment and reconciliation sign invariants in PostgreSQL', async () => {
    const capturedPaymentId = 'c1000000-0000-4000-8000-000000000041'
    await expect(pool.query(`
      INSERT INTO mbox.payments(
        id, tenant_id, store_id, order_id, public_id, provider, method,
        amount_minor, currency, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'postar', 'native_qr',
        100, 'CNY', 'succeeded')
    `, [
      capturedPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderRollback,
      'invalid-captured-payment',
    ])).rejects.toThrow(/payments_captured_evidence_ck/)

    const pendingPaymentId = 'c1000000-0000-4000-8000-000000000042'
    await pool.query(`
      INSERT INTO mbox.payments(
        id, tenant_id, store_id, order_id, public_id, provider, method,
        amount_minor, currency, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'postar', 'native_qr',
        100, 'CNY', 'pending')
    `, [
      pendingPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderRollback,
      'constraint-pending-payment',
    ])
    try {
      await expect(pool.query(`
        INSERT INTO mbox.reconciliation_entries(
          tenant_id, store_id, payment_id, entry_type, provider, provider_reference,
          amount_minor, currency, business_date, occurred_at
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'payment', 'postar', 'invalid-negative-payment',
          -100, 'CNY', '2026-08-11', clock_timestamp())
      `, [integrationTenantId, integrationStoreId, pendingPaymentId]))
        .rejects.toThrow(/reconciliation_financial_identity_ck/)
    } finally {
      await pool.query('DELETE FROM mbox.payments WHERE id = $1::uuid', [pendingPaymentId])
    }
  })

  it('executes different order writes concurrently and rolls back on audit failure', async () => {
    const [left, right] = await Promise.all([
      service.initiate(integrationInitiate(
        integrationOrderTwo,
        'integration-payment-two',
        'integration-payment-init-0002',
      )),
      service.initiate(integrationInitiate(
        integrationOrderThree,
        'integration-payment-three',
        'integration-payment-init-0003',
      )),
    ])
    expect(left.value.orderId).toBe(integrationOrderTwo)
    expect(right.value.orderId).toBe(integrationOrderThree)

    await expect(service.initiate({
      ...integrationInitiate(
        integrationOrderRollback,
        'integration-payment-rollback',
        'integration-payment-rollback-0001',
      ),
      businessDate: '2026-99-99',
    })).rejects.toThrow()
    const rolledBack = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.payments WHERE order_id = $1::uuid
    `, [integrationOrderRollback])
    expect(rolledBack.rows[0]?.count).toBe('0')
  })
})

class MemoryIdempotentExecutor {
  handlerCalls = 0
  activeHandlers = 0
  maxActiveHandlers = 0
  readonly outcomes: CommandOutcome<unknown>[] = []
  private readonly cache = new Map<string, { fingerprint: string; encoded: unknown }>()

  constructor(private readonly transactionForKey: (key: string) => ScopedTransaction) {}

  async execute<Result>(
    command: Readonly<IdempotentCommand<Result>>,
    handler: (transaction: ScopedTransaction) => Promise<CommandOutcome<Result>>,
  ): Promise<CommandExecution<Result>> {
    const key = `${command.operationScope}:${command.idempotencyKey}`
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      if (cached.fingerprint !== command.requestFingerprint) throw new Error('idempotency conflict')
      return { value: command.resultCodec.decode(cached.encoded), replayed: true }
    }

    this.handlerCalls += 1
    this.activeHandlers += 1
    this.maxActiveHandlers = Math.max(this.maxActiveHandlers, this.activeHandlers)
    await new Promise((resolve) => setTimeout(resolve, 5))
    try {
      const outcome = await handler(this.transactionForKey(command.idempotencyKey))
      this.outcomes.push(outcome as CommandOutcome<unknown>)
      this.cache.set(key, {
        fingerprint: command.requestFingerprint,
        encoded: command.resultCodec.encode(outcome.result),
      })
      return { value: outcome.result, replayed: false }
    } finally {
      this.activeHandlers -= 1
    }
  }
}

class PaymentFlowTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: string[] = []
  readonly lockedOrderIds: string[] = []
  private readonly paymentStatus: 'pending' | 'succeeded'
  private paymentStaged = false

  constructor(
    private readonly orderId: string,
    private readonly paymentId: string,
    private readonly mode: 'initiate' | 'callback',
  ) {
    this.paymentStatus = mode === 'callback' ? 'pending' : 'pending'
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const sql = normalizeSql(text)
    this.calls.push(sql)
    await Promise.resolve()

    if (sql.includes('FROM mbox.orders') && sql.includes('FOR UPDATE')) {
      this.lockedOrderIds.push(String(values[2]))
      return result([{
        id: this.orderId,
        table_session_id: '99999999-9999-4999-8999-999999999999',
        total_amount_minor: '8800',
        currency: 'CNY',
        status: 'submitted',
      }])
    }
    if (sql.startsWith('SELECT id, order_id FROM mbox.payments')) {
      return result([{ id: this.paymentId, order_id: this.orderId }])
    }
    if (sql.includes('AS gross_paid_minor')) {
      return result([this.mode === 'callback'
        ? { gross_paid_minor: '8800', refunded_minor: '0', has_pending: false }
        : { gross_paid_minor: '0', refunded_minor: '0', has_pending: this.paymentStaged }])
    }
    if (sql.includes('INSERT INTO mbox.payments')) {
      this.paymentStaged = true
      return result([paymentRow(this.orderId, this.paymentId, 'pending')])
    }
    if (sql.includes('FROM mbox.payments') && sql.includes('FOR UPDATE')) {
      return result([paymentRow(this.orderId, this.paymentId, this.paymentStatus)])
    }
    if (sql.includes('UPDATE mbox.payments')) {
      return result([paymentRow(this.orderId, this.paymentId, 'succeeded', 'provider-payment-001')])
    }
    if (sql.includes('UPDATE mbox.payment_provider_actions')) return result([])
    if (sql.includes('INSERT INTO mbox.reconciliation_entries')) {
      return result([reconciliationRow(this.paymentId)])
    }
    if (sql.includes('UPDATE mbox.orders')) {
      return result([{ payment_status: this.mode === 'callback' ? 'paid' : 'pending' }])
    }
    throw new Error(`Unexpected query: ${sql}`)
  }
}

class RollbackClient implements PostgresPoolClient {
  readonly commands: string[] = []
  paymentCommitted = false
  private paymentStaged = false

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const sql = normalizeSql(text)
    if (sql.startsWith('BEGIN')) {
      this.commands.push('BEGIN')
      return result([])
    }
    if (sql.includes("set_config('app.tenant_id'")) return result([{ tenant_id: tenantId, store_id: storeId }])
    if (sql === 'COMMIT') {
      this.commands.push('COMMIT')
      this.paymentCommitted = this.paymentStaged
      return result([])
    }
    if (sql === 'ROLLBACK') {
      this.commands.push('ROLLBACK')
      this.paymentStaged = false
      this.paymentCommitted = false
      return result([])
    }
    if (sql.includes('INSERT INTO mbox.idempotency_records')) return result([{ id: '99999999-9999-4999-8999-999999999999' }])
    if (sql.includes('FROM mbox.orders') && sql.includes('FOR UPDATE')) {
      return result([{
        id: orderOneId,
        table_session_id: '99999999-9999-4999-8999-999999999999',
        total_amount_minor: '8800',
        currency: 'CNY',
        status: 'submitted',
      }])
    }
    if (sql.includes('AS gross_paid_minor')) {
      return result([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: this.paymentStaged }])
    }
    if (sql.includes('INSERT INTO mbox.payments')) {
      this.paymentStaged = true
      return result([paymentRow(orderOneId, paymentOneId, 'pending')])
    }
    if (sql.includes('UPDATE mbox.orders')) return result([{ payment_status: 'pending' }])
    if (sql.includes('INSERT INTO mbox.audit_events')) throw new Error('audit insertion failed')
    throw new Error(`Unexpected transaction query: ${sql}; values=${JSON.stringify(values)}`)
  }

  release(): void {}
}

function callbackCommand() {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'integration' as const, ref: 'postar-callback' },
    businessDate: '2026-08-11',
    idempotencyKey: 'callback-provider-payment-001',
    requestFingerprint: '{"transaction":"provider-payment-001","amount":8800}',
    paymentPublicId: `payment-${paymentOneId.slice(-8)}`,
    provider: 'postar' as const,
    providerTransactionId: 'provider-payment-001',
    reportedAmountMinor: 8800,
    reportedCurrency: 'CNY',
    providerSnapshot: {
      signatureVerified: true,
      tradeState: 'SUCCESS',
      signature: 'secret-signature',
      token: 'secret-token',
      headers: { authorization: 'Bearer secret-token' },
      openid: 'customer-openid',
    },
    occurredAt: '2026-08-11T12:00:00.000Z',
  }
}

function initiateCommand(orderId: string, idempotencyKey: string, publicId: string) {
  return {
    scope: { tenantId, storeId },
    actor: { type: 'employee' as const, employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    businessDate: '2026-08-11',
    idempotencyKey,
    requestFingerprint: JSON.stringify({ orderId, publicId }),
    orderId,
    publicId,
    provider: 'postar' as const,
    method: 'native_qr' as const,
    principal: {
      type: 'employee' as const,
      employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  }
}

function paymentRow(
  orderId: string,
  paymentId: string,
  status: Payment['status'],
  providerTransactionId: string | null = null,
): Record<string, unknown> {
  const snapshot: JsonObject = {}
  return {
    id: paymentId,
    order_id: orderId,
    public_id: `payment-${paymentId.slice(-8)}`,
    provider: 'postar',
    provider_transaction_id: providerTransactionId,
    method: 'native_qr',
    amount_minor: '8800',
    currency: 'CNY',
    status,
    provider_snapshot: snapshot,
    succeeded_at: status === 'succeeded' ? '2026-08-11T12:00:00.000Z' : null,
    created_at: '2026-08-11T11:59:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function reconciliationRow(paymentId: string): Record<string, unknown> {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    payment_id: paymentId,
    refund_id: null,
    entry_type: 'payment',
    provider: 'postar',
    provider_reference: 'provider-payment-001',
    amount_minor: '8800',
    currency: 'CNY',
    business_date: '2026-08-11',
    occurred_at: '2026-08-11T12:00:00.000Z',
    evidence_snapshot: { signatureVerified: true },
    created_at: '2026-08-11T12:00:01.000Z',
  }
}

function result<Row extends Record<string, unknown>>(
  rows: Row[],
): PostgresQueryResult<Row> & { rowCount: number } {
  return { rows, rowCount: rows.length }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => pool.connect(),
    end: async () => pool.end(),
  }
}

function integrationMetadata(idempotencyKey: string, requestFingerprint: string) {
  return {
    scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
    actor: { type: 'integration' as const, ref: 'integration-test' },
    businessDate: '2026-08-11',
    idempotencyKey,
    requestFingerprint,
  }
}

function integrationInitiate(orderId: string, publicId: string, idempotencyKey: string) {
  return {
    ...integrationMetadata(idempotencyKey, JSON.stringify({ orderId, publicId })),
    actor: { type: 'employee' as const, employeeId: integrationRequesterId },
    orderId,
    publicId,
    provider: 'postar' as const,
    method: 'native_qr' as const,
    principal: { type: 'employee' as const, employeeId: integrationRequesterId },
  }
}

function integrationCallback(paymentPublicId: string, amountMinor: number) {
  return {
    ...integrationMetadata(
      'integration-payment-callback-0001',
      JSON.stringify({ paymentPublicId, amountMinor, transaction: 'integration-provider-payment-0001' }),
    ),
    paymentPublicId,
    provider: 'postar' as const,
    providerTransactionId: 'integration-provider-payment-0001',
    reportedAmountMinor: amountMinor,
    reportedCurrency: 'CNY',
    providerSnapshot: {
      signatureVerified: true,
      tradeState: 'SUCCESS',
      signature: 'secret-signature',
      token: 'secret-token',
      headers: { authorization: 'Bearer secret-token' },
      openid: 'customer-openid',
    },
    occurredAt: '2026-08-11T12:00:00.000Z',
  }
}

async function seedPaymentIntegration(pool: Pool): Promise<void> {
  const areaId = 'c1000000-0000-4000-8000-000000000005'
  const productId = 'c1000000-0000-4000-8000-000000000006'
  const tableIds = [
    'c1000000-0000-4000-8000-000000000011',
    'c1000000-0000-4000-8000-000000000012',
    'c1000000-0000-4000-8000-000000000013',
    'c1000000-0000-4000-8000-000000000014',
  ]
  const sessionIds = [
    'c1000000-0000-4000-8000-000000000015',
    'c1000000-0000-4000-8000-000000000016',
    'c1000000-0000-4000-8000-000000000017',
    'c1000000-0000-4000-8000-000000000018',
  ]
  const orderIds = [integrationOrderOne, integrationOrderTwo, integrationOrderThree, integrationOrderRollback]
  const itemIds = [
    integrationItemOne,
    'c1000000-0000-4000-8000-000000000032',
    'c1000000-0000-4000-8000-000000000033',
    'c1000000-0000-4000-8000-000000000034',
  ]

  await pool.query(`
    INSERT INTO mbox.tenants(id, code, name)
    VALUES ($1::uuid, 'payment_integration', 'Payment Integration')
    ON CONFLICT (id) DO NOTHING
  `, [integrationTenantId])
  await pool.query(`
    INSERT INTO mbox.stores(id, tenant_id, code, name)
    VALUES ($1::uuid, $2::uuid, 'payment_store', 'Payment Store')
    ON CONFLICT (id) DO NOTHING
  `, [integrationStoreId, integrationTenantId])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
    VALUES
      ($1::uuid, $3::uuid, $4::uuid, 'REQUESTER', 'Requester'),
      ($2::uuid, $3::uuid, $4::uuid, 'APPROVER', 'Approver')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `, [integrationRequesterId, integrationApproverId, integrationTenantId, integrationStoreId])
  await pool.query(`
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name, capabilities)
    VALUES
      ($1::uuid, $3::uuid, $4::uuid, 'REFUND_REQUESTER', 'Refund Requester',
        ARRAY['refund.request', 'payment.initiate.staff']::text[]),
      ($2::uuid, $3::uuid, $4::uuid, 'REFUND_APPROVER', 'Refund Approver',
        ARRAY['refund.approve', 'refund.execute']::text[])
    ON CONFLICT (id) DO UPDATE SET
      capabilities = EXCLUDED.capabilities,
      status = 'active'
  `, [
    integrationRequesterRoleId,
    integrationApproverRoleId,
    integrationTenantId,
    integrationStoreId,
  ])
  await pool.query(`
    INSERT INTO mbox.employee_roles(id, tenant_id, store_id, employee_id, role_id)
    VALUES
      ($1::uuid, $5::uuid, $6::uuid, $3::uuid, $7::uuid),
      ($2::uuid, $5::uuid, $6::uuid, $4::uuid, $8::uuid)
    ON CONFLICT (id) DO UPDATE SET ends_at = NULL
  `, [
    integrationRequesterRoleAssignmentId,
    integrationApproverRoleAssignmentId,
    integrationRequesterId,
    integrationApproverId,
    integrationTenantId,
    integrationStoreId,
    integrationRequesterRoleId,
    integrationApproverRoleId,
  ])
  await pool.query(`
    INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
    SELECT $1::uuid, $2::uuid, code, code
    FROM unnest(ARRAY['refund.request','payment.initiate.staff','refund.approve','refund.execute']::text[]) code
    ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET status='active'
  `, [integrationTenantId, integrationStoreId])
  await pool.query(`
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT $1::uuid, $2::uuid,
      CASE WHEN permission.code IN ('refund.request','payment.initiate.staff') THEN $3::uuid ELSE $4::uuid END,
      permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=$1::uuid AND permission.store_id=$2::uuid
      AND permission.code IN ('refund.request','payment.initiate.staff','refund.approve','refund.execute')
    ON CONFLICT DO NOTHING
  `, [integrationTenantId, integrationStoreId, integrationRequesterRoleId, integrationApproverRoleId])
  await upsertPaymentApprovalLimit(pool)
  await pool.query(`
    INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'PAYMENT', 'Payment Area', 'indoor')
    ON CONFLICT (id) DO NOTHING
  `, [areaId, integrationTenantId, integrationStoreId])
  await pool.query(`
    INSERT INTO mbox.products(id, tenant_id, store_id, code, name, category_code, fulfillment_station)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'PAYMENT_PRODUCT', 'Payment Product', 'test', 'bar')
    ON CONFLICT (id) DO NOTHING
  `, [productId, integrationTenantId, integrationStoreId])

  for (let index = 0; index < orderIds.length; index += 1) {
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, 4)
      ON CONFLICT (id) DO NOTHING
    `, [tableIds[index], integrationTenantId, integrationStoreId, areaId, `PT${index + 1}`])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, '2026-08-11', 2, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [sessionIds[index], integrationTenantId, integrationStoreId, tableIds[index], `payment-session-${index + 1}`])
    await pool.query(`
      INSERT INTO mbox.orders(
        id, tenant_id, store_id, table_session_id, public_id, channel, status,
        subtotal_amount_minor, discount_amount_minor, total_amount_minor, currency
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'staff_assisted', 'submitted',
        10000, 0, 10000, 'CNY')
      ON CONFLICT (id) DO NOTHING
    `, [orderIds[index], integrationTenantId, integrationStoreId, sessionIds[index], `payment-order-${index + 1}`])
    await pool.query(`
      INSERT INTO mbox.order_items(
        id, tenant_id, store_id, order_id, product_id, quantity,
        unit_price_minor, discount_amount_minor, total_amount_minor,
        currency, fulfillment_station, product_snapshot, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
        10000, 0, 10000, 'CNY', 'bar', '{"name":"Payment Product"}'::jsonb, 'delivered')
      ON CONFLICT (id) DO NOTHING
    `, [itemIds[index], integrationTenantId, integrationStoreId, orderIds[index], productId])
  }
}

async function upsertPaymentApprovalLimit(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO mbox.role_approval_limits(
      id, tenant_id, store_id, role_id, approval_code, amount_minor, currency, enabled
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'refund.approve', 5000, 'CNY', true)
    ON CONFLICT (id) DO UPDATE SET
      amount_minor = EXCLUDED.amount_minor,
      enabled = true
  `, [
    integrationApprovalLimitId,
    integrationTenantId,
    integrationStoreId,
    integrationApproverRoleId,
  ])
}
