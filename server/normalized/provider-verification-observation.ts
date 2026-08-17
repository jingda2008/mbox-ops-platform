import { createHash, randomUUID } from 'node:crypto'
import type { ChannelPaymentStatus } from '../../src/shared/payment-contracts.js'
import type { JsonObject, JsonValue } from './command-executor.js'
import type {
  AuthoritativeSettlementChannel,
  PaymentProvider,
} from './payment-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export type ProviderObservationVerificationKind =
  | 'callback_signature'
  | 'active_query_binding'

export type VerifiedProviderObservedStatus =
  | 'payment_succeeded'
  | 'payment_pending'
  | 'payment_failed'
  | 'payment_closed'
  | 'refund_succeeded'
  | 'refund_processing'
  | 'refund_failed'

type VerifiedProvider = Extract<PaymentProvider, 'wechat' | 'postar'>

interface ObservationMetadata {
  scope: Readonly<StoreScope>
  provider: VerifiedProvider
  verificationKind: ProviderObservationVerificationKind
  providerEventId: string
  integrationRef: string
  providerTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  occurredAt: string
  evidence?: JsonObject
}

export interface RecordVerifiedPaymentObservationInput extends ObservationMetadata {
  paymentPublicId: string
  status: ChannelPaymentStatus
  settlementChannel?: AuthoritativeSettlementChannel
}

export interface RecordVerifiedRefundObservationInput extends ObservationMetadata {
  refundPublicId: string
  status: 'processing' | 'succeeded' | 'failed'
  originalProviderTransactionId: string
}

export interface ConsumeVerifiedProviderObservationInput {
  transaction: ScopedTransaction
  observationId: string
  operation: 'payment.callback' | 'payment.provider-query' | 'refund.result'
  idempotencyKey: string
  integrationRef: string
  provider: VerifiedProvider
  subjectPublicId: string
  providerTransactionId: string
  originalProviderTransactionId?: string
  reportedAmountMinor: number
  reportedCurrency: string
  observedStatus: VerifiedProviderObservedStatus
  settlementChannel?: AuthoritativeSettlementChannel
}

export interface ProviderObservationAuthorityPort {
  consume(input: Readonly<ConsumeVerifiedProviderObservationInput>): Promise<void>
}

export interface ProviderObservationRecorderPort {
  recordPayment(input: Readonly<RecordVerifiedPaymentObservationInput>): Promise<string>
  recordRefund(input: Readonly<RecordVerifiedRefundObservationInput>): Promise<string>
}

interface PaymentTargetRow extends Record<string, unknown> {
  id: string
  public_id: string
  provider: string
  provider_transaction_id: string | null
  settlement_channel: AuthoritativeSettlementChannel | null
  amount_minor: string | number
  currency: string
}

interface RefundTargetRow extends Record<string, unknown> {
  id: string
  public_id: string
  merchant_refund_id: string | null
  provider_refund_id: string | null
  payment_provider: string
  payment_provider_transaction_id: string | null
  amount_minor: string | number
  currency: string
}

interface ObservationRow extends Record<string, unknown> {
  id: string
  provider: VerifiedProvider
  subject_kind: 'payment' | 'refund'
  payment_id: string | null
  refund_id: string | null
  payment_public_id: string | null
  refund_public_id: string | null
  merchant_refund_id: string | null
  provider_refund_id: string | null
  verification_kind: ProviderObservationVerificationKind
  provider_event_id: string
  integration_ref: string
  observed_status: VerifiedProviderObservedStatus
  provider_transaction_id: string
  original_provider_transaction_id: string | null
  reported_amount_minor: string | number
  reported_currency: string
  settlement_channel: AuthoritativeSettlementChannel | null
  evidence_sha256: string
  occurred_at: string
  consumed_at: string | null
  consumed_operation: ConsumeVerifiedProviderObservationInput['operation'] | null
  consumed_idempotency_key: string | null
}

export class ProviderObservationAuthorizationError extends Error {
  constructor(message = 'Provider result lacks a matching unconsumed verified observation') {
    super(message)
    this.name = 'ProviderObservationAuthorizationError'
  }
}

export class VerifiedProviderObservationService implements ProviderObservationRecorderPort {
  constructor(private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>) {}

  recordPayment(input: Readonly<RecordVerifiedPaymentObservationInput>): Promise<string> {
    validateMetadata(input)
    const observedStatus = paymentObservedStatus(input.status)
    return this.transactions.run(input.scope, async (transaction) => {
      const target = await findPayment(transaction, input.paymentPublicId)
      if (target.provider !== input.provider) {
        throw new ProviderObservationAuthorizationError('Verified payment observation provider does not match payment authority')
      }
      if (safeMinor(target.amount_minor) !== input.reportedAmountMinor) {
        throw new ProviderObservationAuthorizationError('Verified payment observation amount does not match payment authority')
      }
      if (target.currency !== input.reportedCurrency) {
        throw new ProviderObservationAuthorizationError('Verified payment observation currency does not match payment authority')
      }
      if (target.provider_transaction_id !== null
        && target.provider_transaction_id !== input.providerTransactionId) {
        throw new ProviderObservationAuthorizationError('Verified payment observation transaction does not match payment authority')
      }
      if (target.settlement_channel !== null
        && input.settlementChannel !== undefined
        && target.settlement_channel !== input.settlementChannel) {
        throw new ProviderObservationAuthorizationError('Verified payment observation settlement channel does not match payment authority')
      }
      return recordObservation(transaction, {
        ...input,
        subjectKind: 'payment',
        subjectId: target.id,
        observedStatus,
        originalProviderTransactionId: null,
        settlementChannel: input.settlementChannel ?? null,
      })
    })
  }

  recordRefund(input: Readonly<RecordVerifiedRefundObservationInput>): Promise<string> {
    validateMetadata(input)
    requireText(input.originalProviderTransactionId, 'originalProviderTransactionId', 256)
    const observedStatus = refundObservedStatus(input.status)
    return this.transactions.run(input.scope, async (transaction) => {
      const target = await findRefund(transaction, input.refundPublicId)
      if (target.payment_provider !== input.provider) {
        throw new ProviderObservationAuthorizationError('Verified refund observation provider does not match refund authority')
      }
      if (target.payment_provider_transaction_id !== input.originalProviderTransactionId) {
        throw new ProviderObservationAuthorizationError('Verified refund observation original transaction does not match refund authority')
      }
      if (safeMinor(target.amount_minor) !== input.reportedAmountMinor) {
        throw new ProviderObservationAuthorizationError('Verified refund observation amount does not match refund authority')
      }
      if (target.currency !== input.reportedCurrency) {
        throw new ProviderObservationAuthorizationError('Verified refund observation currency does not match refund authority')
      }
      if (target.provider_refund_id !== null
        && target.provider_refund_id !== input.providerTransactionId) {
        throw new ProviderObservationAuthorizationError('Verified refund observation terminal result conflicts with refund authority')
      }
      return recordObservation(transaction, {
        ...input,
        subjectKind: 'refund',
        subjectId: target.id,
        observedStatus,
        originalProviderTransactionId: input.originalProviderTransactionId,
        settlementChannel: null,
      })
    })
  }
}

export class NormalizedProviderObservationAuthority implements ProviderObservationAuthorityPort {
  async consume(input: Readonly<ConsumeVerifiedProviderObservationInput>): Promise<void> {
    requireUuid(input.observationId, 'observationId')
    requireText(input.idempotencyKey, 'idempotencyKey', 128, 8)
    requireText(input.integrationRef, 'integrationRef', 256, 3)
    requireText(input.subjectPublicId, 'subjectPublicId', 256)
    requireText(input.providerTransactionId, 'providerTransactionId', 256)
    if (input.originalProviderTransactionId !== undefined) {
      requireText(input.originalProviderTransactionId, 'originalProviderTransactionId', 256)
    }
    if (!Number.isSafeInteger(input.reportedAmountMinor) || input.reportedAmountMinor <= 0) {
      throw new ProviderObservationAuthorizationError('Provider observation amount is invalid')
    }
    if (!/^[A-Z]{3}$/.test(input.reportedCurrency)) {
      throw new ProviderObservationAuthorizationError('Provider observation currency is invalid')
    }

    const selected = await input.transaction.query<ObservationRow>(`
      SELECT observation.id, observation.provider, observation.subject_kind,
        observation.payment_id, observation.refund_id,
        payment.public_id AS payment_public_id,
        refund.public_id AS refund_public_id,
        refund.merchant_refund_id, refund.provider_refund_id,
        observation.verification_kind, observation.provider_event_id,
        observation.integration_ref, observation.observed_status,
        observation.provider_transaction_id, observation.original_provider_transaction_id,
        observation.reported_amount_minor, observation.reported_currency,
        observation.settlement_channel, observation.evidence_sha256,
        observation.occurred_at::text, observation.consumed_at::text,
        observation.consumed_operation, observation.consumed_idempotency_key
      FROM mbox.verified_provider_observations observation
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=observation.tenant_id AND payment.store_id=observation.store_id
       AND payment.id=observation.payment_id
      LEFT JOIN mbox.refunds refund
        ON refund.tenant_id=observation.tenant_id AND refund.store_id=observation.store_id
       AND refund.id=observation.refund_id
      WHERE observation.tenant_id=$1::uuid AND observation.store_id=$2::uuid
        AND observation.id=$3::uuid
      FOR UPDATE OF observation
    `, [input.transaction.scope.tenantId, input.transaction.scope.storeId, input.observationId])
    const row = selected.rows[0]
    if (row === undefined || !matchesConsumption(row, input)) {
      throw new ProviderObservationAuthorizationError()
    }
    if (row.consumed_at !== null) {
      throw new ProviderObservationAuthorizationError('Verified provider observation was already consumed')
    }
    const consumed = await input.transaction.query(`
      UPDATE mbox.verified_provider_observations
      SET consumed_at=clock_timestamp(), consumed_operation=$4,
        consumed_idempotency_key=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND consumed_at IS NULL
    `, [
      input.transaction.scope.tenantId,
      input.transaction.scope.storeId,
      input.observationId,
      input.operation,
      input.idempotencyKey,
    ])
    if (consumed.rowCount !== 1) {
      throw new ProviderObservationAuthorizationError('Verified provider observation lost a concurrent consume')
    }
  }
}

export class RejectingProviderObservationAuthority implements ProviderObservationAuthorityPort {
  async consume(): Promise<never> {
    throw new ProviderObservationAuthorizationError()
  }
}

export function providerObservationEventId(parts: readonly (string | number | null | undefined)[]): string {
  return `observation:${createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\u0000'), 'utf8')
    .digest('hex')}`
}

async function findPayment(
  transaction: ScopedTransaction,
  paymentPublicId: string,
): Promise<PaymentTargetRow> {
  requireText(paymentPublicId, 'paymentPublicId', 128, 8)
  const result = await transaction.query<PaymentTargetRow>(`
    SELECT id, public_id, provider, provider_transaction_id, settlement_channel,
      amount_minor, currency
    FROM mbox.payments
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    FOR SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, paymentPublicId])
  const row = result.rows[0]
  if (row === undefined) throw new ProviderObservationAuthorizationError('Verified observation payment was not found')
  return row
}

async function findRefund(
  transaction: ScopedTransaction,
  refundPublicId: string,
): Promise<RefundTargetRow> {
  requireText(refundPublicId, 'refundPublicId', 128, 8)
  const result = await transaction.query<RefundTargetRow>(`
    SELECT refund.id, refund.public_id, refund.merchant_refund_id,
      refund.provider_refund_id, refund.amount_minor, refund.currency,
      payment.provider AS payment_provider,
      payment.provider_transaction_id AS payment_provider_transaction_id
    FROM mbox.refunds refund
    JOIN mbox.payments payment
      ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
     AND payment.id=refund.payment_id
    WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
      AND ($3 IN (refund.public_id, refund.merchant_refund_id, refund.provider_refund_id))
    FOR SHARE OF refund, payment
  `, [transaction.scope.tenantId, transaction.scope.storeId, refundPublicId])
  const row = result.rows[0]
  if (row === undefined) throw new ProviderObservationAuthorizationError('Verified observation refund was not found')
  return row
}

async function recordObservation(
  transaction: ScopedTransaction,
  input: Readonly<ObservationMetadata & {
    subjectKind: 'payment' | 'refund'
    subjectId: string
    observedStatus: VerifiedProviderObservedStatus
    originalProviderTransactionId: string | null
    settlementChannel: AuthoritativeSettlementChannel | null
  }>,
): Promise<string> {
  const evidenceSha256 = createHash('sha256')
    .update(stableJson(input.evidence ?? {}), 'utf8')
    .digest('hex')
  const id = randomUUID()
  await transaction.query(`
    INSERT INTO mbox.verified_provider_observations(
      id, tenant_id, store_id, provider, subject_kind, payment_id, refund_id,
      verification_kind, provider_event_id, integration_ref, observed_status,
      provider_transaction_id, original_provider_transaction_id,
      reported_amount_minor, reported_currency, settlement_channel,
      evidence_sha256, occurred_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, $5,
      CASE WHEN $5='payment' THEN $6::uuid ELSE NULL END,
      CASE WHEN $5='refund' THEN $6::uuid ELSE NULL END,
      $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz
    )
    ON CONFLICT (tenant_id, store_id, provider, provider_event_id) DO NOTHING
  `, [
    id,
    transaction.scope.tenantId,
    transaction.scope.storeId,
    input.provider,
    input.subjectKind,
    input.subjectId,
    input.verificationKind,
    input.providerEventId,
    input.integrationRef,
    input.observedStatus,
    input.providerTransactionId,
    input.originalProviderTransactionId,
    input.reportedAmountMinor,
    input.reportedCurrency,
    input.settlementChannel,
    evidenceSha256,
    input.occurredAt,
  ])
  const selected = await transaction.query<ObservationRow>(`
    SELECT id, provider, subject_kind, payment_id, refund_id,
      NULL::text AS payment_public_id, NULL::text AS refund_public_id,
      NULL::text AS merchant_refund_id, NULL::text AS provider_refund_id,
      verification_kind, provider_event_id, integration_ref, observed_status,
      provider_transaction_id, original_provider_transaction_id,
      reported_amount_minor, reported_currency, settlement_channel,
      evidence_sha256, occurred_at::text, consumed_at::text,
      consumed_operation, consumed_idempotency_key
    FROM mbox.verified_provider_observations
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND provider=$3 AND provider_event_id=$4
    FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, input.provider, input.providerEventId])
  const row = selected.rows[0]
  if (row === undefined
    || row.subject_kind !== input.subjectKind
    || (input.subjectKind === 'payment' ? row.payment_id : row.refund_id) !== input.subjectId
    || row.verification_kind !== input.verificationKind
    || row.integration_ref !== input.integrationRef
    || row.observed_status !== input.observedStatus
    || row.provider_transaction_id !== input.providerTransactionId
    || row.original_provider_transaction_id !== input.originalProviderTransactionId
    || safeMinor(row.reported_amount_minor) !== input.reportedAmountMinor
    || row.reported_currency !== input.reportedCurrency
    || row.settlement_channel !== input.settlementChannel
    || row.evidence_sha256 !== evidenceSha256
    || Date.parse(row.occurred_at) !== Date.parse(input.occurredAt)) {
    throw new ProviderObservationAuthorizationError('Provider event id conflicts with different verified facts')
  }
  return row.id
}

function matchesConsumption(
  row: Readonly<ObservationRow>,
  input: Readonly<ConsumeVerifiedProviderObservationInput>,
): boolean {
  const expectedSubjectKind = input.operation === 'refund.result' ? 'refund' : 'payment'
  const expectedVerification = input.operation === 'payment.callback'
    ? 'callback_signature'
    : input.operation === 'payment.provider-query'
      ? 'active_query_binding'
      : null
  const subjectMatches = expectedSubjectKind === 'payment'
    ? row.payment_public_id === input.subjectPublicId
    : [row.refund_public_id, row.merchant_refund_id, row.provider_refund_id]
        .includes(input.subjectPublicId)
  return row.subject_kind === expectedSubjectKind
    && (expectedVerification === null || row.verification_kind === expectedVerification)
    && row.provider === input.provider
    && row.integration_ref === input.integrationRef
    && subjectMatches
    && row.observed_status === input.observedStatus
    && row.provider_transaction_id === input.providerTransactionId
    && row.original_provider_transaction_id === (input.originalProviderTransactionId ?? null)
    && safeMinor(row.reported_amount_minor) === input.reportedAmountMinor
    && row.reported_currency === input.reportedCurrency
    && row.settlement_channel === (input.settlementChannel ?? null)
}

function validateMetadata(input: Readonly<ObservationMetadata>): void {
  requireText(input.providerEventId, 'providerEventId', 256, 8)
  requireText(input.integrationRef, 'integrationRef', 256, 3)
  requireText(input.providerTransactionId, 'providerTransactionId', 256)
  if (!Number.isSafeInteger(input.reportedAmountMinor) || input.reportedAmountMinor <= 0) {
    throw new ProviderObservationAuthorizationError('Provider observation amount is invalid')
  }
  if (!/^[A-Z]{3}$/.test(input.reportedCurrency)) {
    throw new ProviderObservationAuthorizationError('Provider observation currency is invalid')
  }
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new ProviderObservationAuthorizationError('Provider observation time is invalid')
  }
}

function paymentObservedStatus(status: ChannelPaymentStatus): VerifiedProviderObservedStatus {
  if (status === 'succeeded') return 'payment_succeeded'
  if (status === 'failed') return 'payment_failed'
  if (status === 'closed') return 'payment_closed'
  return 'payment_pending'
}

function refundObservedStatus(
  status: 'processing' | 'succeeded' | 'failed',
): VerifiedProviderObservedStatus {
  if (status === 'succeeded') return 'refund_succeeded'
  if (status === 'failed') return 'refund_failed'
  return 'refund_processing'
}

function safeMinor(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProviderObservationAuthorizationError('Provider observation amount is invalid')
  }
  return parsed
}

function requireText(
  value: string,
  label: string,
  maximum: number,
  minimum = 1,
): void {
  if (typeof value !== 'string' || value.trim() !== value
    || value.length < minimum || value.length > maximum) {
    throw new ProviderObservationAuthorizationError(`${label} is invalid`)
  }
}

function requireUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ProviderObservationAuthorizationError(`${label} is invalid`)
  }
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key]!)}`
  )).join(',')}}`
}
