import type { JsonObject } from './command-executor.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type PaymentProvider = 'wechat' | 'postar' | 'cash' | 'physical_pos' | 'simulation'
export type PaymentMethod = 'jsapi' | 'native_qr' | 'auth_code' | 'cash' | 'card' | 'manual'
export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'closed'
  | 'partially_refunded'
  | 'refunded'

export interface Payment {
  id: string
  orderId: string
  publicId: string
  provider: PaymentProvider
  providerTransactionId: string | null
  method: PaymentMethod
  amountMinor: number
  currency: string
  status: PaymentStatus
  providerSnapshot: JsonObject
  succeededAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePaymentForOrderInput {
  orderId: string
  publicId: string
  provider: PaymentProvider
  method: PaymentMethod
  providerTransactionId?: string | null
  evidence?: JsonObject
  initialStatus?: 'created' | 'pending' | 'succeeded'
  principal:
    | { type: 'employee'; employeeId: string }
    | { type: 'guest'; tableSessionId: string; customerId: string }
}

export interface ApplyPaymentCallbackInput {
  paymentPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar' | 'simulation'>
  providerTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  providerSnapshot?: JsonObject
  succeededAt?: string | null
}

export interface PaymentCallbackApplication {
  payment: Payment
  applied: boolean
}

interface PaymentRow extends Record<string, unknown> {
  id: string
  order_id: string
  public_id: string
  provider: PaymentProvider
  provider_transaction_id: string | null
  method: PaymentMethod
  amount_minor: string | number
  currency: string
  status: PaymentStatus
  provider_snapshot: JsonObject
  succeeded_at: string | null
  created_at: string
  updated_at: string
}

interface OrderRow extends Record<string, unknown> {
  id: string
  table_session_id: string
  total_amount_minor: string | number
  currency: string
  status: string
}

interface SettlementRow extends Record<string, unknown> {
  gross_paid_minor: string | number
  refunded_minor: string | number
  has_pending: boolean
}

const CAPTURED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'succeeded',
  'partially_refunded',
  'refunded',
]

export class PaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment was not found: ${id}`)
    this.name = 'PaymentNotFoundError'
  }
}

export class OrderNotPayableError extends Error {
  constructor(orderId: string, reason: string) {
    super(`Order ${orderId} cannot be paid: ${reason}`)
    this.name = 'OrderNotPayableError'
  }
}

export class PaymentEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentEvidenceError'
  }
}

export class PaymentCallbackMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentCallbackMismatchError'
  }
}

export class PaymentTransitionError extends Error {
  constructor(id: string, status: PaymentStatus) {
    super(`Payment ${id} cannot be marked succeeded from status ${status}`)
    this.name = 'PaymentTransitionError'
  }
}

export class PaymentRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createForOrder(input: Readonly<CreatePaymentForOrderInput>): Promise<Payment> {
    validateCreateInput(input)
    const order = await this.lockOrder(input.orderId)
    await this.assertOrderAccess(order, input.principal)
    if (order.status === 'draft' || order.status === 'cancelled') {
      throw new OrderNotPayableError(order.id, `status is ${order.status}`)
    }

    const settlement = await this.readSettlement(order.id)
    if (settlement.has_pending) {
      throw new OrderNotPayableError(order.id, 'another payment is already pending')
    }
    const outstandingMinor = toSafeMinor(order.total_amount_minor, 'order total')
      - (toSafeMinor(settlement.gross_paid_minor, 'gross paid')
        - toSafeMinor(settlement.refunded_minor, 'refunded'))
    if (outstandingMinor <= 0) {
      throw new OrderNotPayableError(order.id, 'the order has no outstanding balance')
    }

    const status = input.initialStatus ?? 'created'
    const inserted = await this.transaction.query<PaymentRow>(`
      INSERT INTO mbox.payments (
        tenant_id, store_id, order_id, public_id, provider,
        provider_transaction_id, method, amount_minor, currency, status,
        provider_snapshot, succeeded_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5,
        $6, $7, $8::bigint, $9, $10,
        $11::jsonb,
        CASE WHEN $10 = 'succeeded' THEN clock_timestamp() ELSE NULL END
      )
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      order.id,
      input.publicId,
      input.provider,
      input.providerTransactionId ?? null,
      input.method,
      outstandingMinor,
      order.currency,
      status,
      JSON.stringify(sanitizeProviderSnapshot(input.evidence)),
    ])
    return onePayment(inserted, 'Creating a payment did not insert exactly one row')
  }

  async applySucceededCallback(
    input: Readonly<ApplyPaymentCallbackInput>,
  ): Promise<PaymentCallbackApplication> {
    validateCallbackInput(input)
    const paymentOrder = await this.transaction.query<{ id: string; order_id: string }>(`
      SELECT id, order_id
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND public_id = $3
        AND provider = $4
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentPublicId,
      input.provider,
    ])
    const orderId = paymentOrder.rows[0]?.order_id
    const paymentId = paymentOrder.rows[0]?.id
    if (orderId === undefined || paymentId === undefined) {
      throw new PaymentNotFoundError(input.paymentPublicId)
    }
    await this.lockOrder(orderId)
    const selected = await this.transaction.query<PaymentRow>(`
      SELECT ${PAYMENT_COLUMNS}
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const payment = selected.rows[0]
    if (payment === undefined) throw new PaymentNotFoundError(input.paymentPublicId)
    verifyCallback(payment, input)
    if (CAPTURED_PAYMENT_STATUSES.includes(payment.status)) {
      return { payment: mapPayment(payment), applied: false }
    }
    if (payment.status === 'failed' || payment.status === 'closed') {
      throw new PaymentTransitionError(payment.id, payment.status)
    }

    const updated = await this.transaction.query<PaymentRow>(`
      UPDATE mbox.payments
      SET status = 'succeeded',
          provider_transaction_id = $4,
          provider_snapshot = provider_snapshot || $5::jsonb,
          succeeded_at = COALESCE($6::timestamptz, clock_timestamp()),
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status IN ('created', 'pending')
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.providerTransactionId,
      JSON.stringify(sanitizeProviderSnapshot(input.providerSnapshot)),
      input.succeededAt ?? null,
    ])
    return {
      payment: onePayment(updated, `Payment ${payment.id} lost its callback transition`),
      applied: true,
    }
  }

  async syncOrderPaymentStatus(orderId: string): Promise<string> {
    const order = await this.lockOrder(orderId)
    const settlement = await this.readSettlement(order.id)
    const total = toSafeMinor(order.total_amount_minor, 'order total')
    const grossPaid = toSafeMinor(settlement.gross_paid_minor, 'gross paid')
    const refunded = toSafeMinor(settlement.refunded_minor, 'refunded')
    const netPaid = grossPaid - refunded
    const paymentStatus = settlement.has_pending && netPaid < total
      ? 'pending'
      : netPaid >= total
        ? 'paid'
        : refunded > 0 && netPaid <= 0
          ? 'refunded'
          : refunded > 0
            ? 'partially_refunded'
            : netPaid > 0
              ? 'partially_paid'
              : 'unpaid'

    const updated = await this.transaction.query<{ payment_status: string }>(`
      UPDATE mbox.orders
      SET payment_status = $4
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      RETURNING payment_status
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, order.id, paymentStatus])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new Error(`Order ${order.id} payment status was not updated`)
    }
    return row.payment_status
  }

  private async lockOrder(orderId: string): Promise<OrderRow> {
    const result = await this.transaction.query<OrderRow>(`
      SELECT id, table_session_id, total_amount_minor, currency, status
      FROM mbox.orders
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (row === undefined) throw new OrderNotPayableError(orderId, 'order was not found')
    return row
  }

  private async assertOrderAccess(
    order: Readonly<OrderRow>,
    principal: Readonly<CreatePaymentForOrderInput['principal']>,
  ): Promise<void> {
    if (principal.type === 'employee') return
    if (order.table_session_id !== principal.tableSessionId) {
      throw new OrderNotPayableError(order.id, 'order does not belong to the authenticated table session')
    }
    const linked = await this.transaction.query<{ linked: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM mbox.table_session_customers
        WHERE tenant_id = $1::uuid
          AND store_id = $2::uuid
          AND table_session_id = $3::uuid
          AND customer_id = $4::uuid
      ) AS linked
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      principal.tableSessionId,
      principal.customerId,
    ])
    if (linked.rows[0]?.linked !== true) {
      throw new OrderNotPayableError(order.id, 'customer is not linked to the authenticated table session')
    }
  }

  private async readSettlement(orderId: string): Promise<SettlementRow> {
    const result = await this.transaction.query<SettlementRow>(`
      SELECT
        COALESCE(SUM(p.amount_minor) FILTER (
          WHERE p.status IN ('succeeded', 'partially_refunded', 'refunded')
        ), 0)::text AS gross_paid_minor,
        COALESCE((
          SELECT SUM(r.amount_minor)
          FROM mbox.refunds AS r
          JOIN mbox.payments AS paid
            ON paid.tenant_id = r.tenant_id
           AND paid.store_id = r.store_id
           AND paid.id = r.payment_id
          WHERE paid.tenant_id = $1::uuid
            AND paid.store_id = $2::uuid
            AND paid.order_id = $3::uuid
            AND r.status = 'succeeded'
        ), 0)::text AS refunded_minor,
        COALESCE(BOOL_OR(p.status IN ('created', 'pending')), false) AS has_pending
      FROM mbox.payments AS p
      WHERE p.tenant_id = $1::uuid
        AND p.store_id = $2::uuid
        AND p.order_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return result.rows[0] ?? { gross_paid_minor: '0', refunded_minor: '0', has_pending: false }
  }
}

const PAYMENT_COLUMNS = `
  id, order_id, public_id, provider, provider_transaction_id, method,
  amount_minor, currency, status, provider_snapshot,
  succeeded_at::text, created_at::text, updated_at::text
`

function verifyCallback(payment: PaymentRow, input: Readonly<ApplyPaymentCallbackInput>): void {
  if (payment.provider !== input.provider) {
    throw new PaymentCallbackMismatchError('Payment callback provider does not match the payment')
  }
  if (toSafeMinor(payment.amount_minor, 'stored payment amount') !== input.reportedAmountMinor) {
    throw new PaymentCallbackMismatchError('Payment callback amount does not match the order-derived payment amount')
  }
  if (payment.currency !== input.reportedCurrency) {
    throw new PaymentCallbackMismatchError('Payment callback currency does not match the payment')
  }
  if (payment.provider_transaction_id !== null
    && payment.provider_transaction_id !== input.providerTransactionId) {
    throw new PaymentCallbackMismatchError('Payment callback transaction id conflicts with the stored transaction')
  }
}

function validateCreateInput(input: Readonly<CreatePaymentForOrderInput>): void {
  nonBlank('orderId', input.orderId)
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  const evidence = input.evidence ?? {}
  if (input.principal.type === 'guest') {
    nonBlank('tableSessionId', input.principal.tableSessionId)
    nonBlank('customerId', input.principal.customerId)
  } else {
    nonBlank('employeeId', input.principal.employeeId)
  }
  if (input.provider === 'cash') {
    if (input.method !== 'cash') throw new PaymentEvidenceError('Cash payments must use the cash method')
    requireEvidence(evidence, ['receiptReference', 'collectedByEmployeeId'], 'cash')
    if (input.initialStatus !== 'succeeded') {
      throw new PaymentEvidenceError('Cash payments must be recorded as already collected')
    }
  } else if (input.provider === 'physical_pos') {
    if (input.method !== 'card' && input.method !== 'manual') {
      throw new PaymentEvidenceError('Physical POS payments must use card or manual method')
    }
    requireEvidence(
      evidence,
      ['terminalId', 'receiptReference', 'collectedByEmployeeId'],
      'physical POS',
    )
    if (input.initialStatus !== 'succeeded') {
      throw new PaymentEvidenceError('Physical POS payments must be recorded as already collected')
    }
  } else if (input.method === 'cash' || input.method === 'card') {
    throw new PaymentEvidenceError('Online providers cannot use cash or card manual methods')
  }
}

function validateCallbackInput(input: Readonly<ApplyPaymentCallbackInput>): void {
  nonBlank('paymentPublicId', input.paymentPublicId)
  nonBlank('providerTransactionId', input.providerTransactionId)
  if (!Number.isSafeInteger(input.reportedAmountMinor) || input.reportedAmountMinor <= 0) {
    throw new TypeError('reportedAmountMinor must be a positive safe integer')
  }
  if (!/^[A-Z]{3}$/.test(input.reportedCurrency)) {
    throw new TypeError('reportedCurrency must be a three-letter uppercase currency code')
  }
}

function requireEvidence(evidence: JsonObject, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (typeof evidence[key] !== 'string' || evidence[key].trim().length === 0) {
      throw new PaymentEvidenceError(`${label} evidence requires ${key}`)
    }
  }
}

function onePayment(
  result: { rows: PaymentRow[]; rowCount: number | null },
  message: string,
): Payment {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(message)
  return mapPayment(row)
}

function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    publicId: row.public_id,
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    method: row.method,
    amountMinor: toSafeMinor(row.amount_minor, 'payment amount'),
    currency: row.currency,
    status: row.status,
    providerSnapshot: sanitizeProviderSnapshot(row.provider_snapshot),
    succeededAt: row.succeeded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSafeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds safe integer range`)
  return parsed
}

function nonBlank(name: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be blank`)
}
