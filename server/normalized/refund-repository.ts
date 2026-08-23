import type { JsonObject } from './command-executor.js'
import type { PaymentProvider } from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type RefundStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface RefundAllocation {
  orderItemId: string
  amountMinor: number
}

export interface Refund {
  id: string
  paymentId: string
  orderId: string | null
  activityRegistrationId: string | null
  paymentProvider: PaymentProvider
  publicId: string
  providerRefundId: string | null
  amountMinor: number
  currency: string
  status: RefundStatus
  reason: string
  requestedByEmployeeId: string
  approvedByEmployeeId: string | null
  decisionReason: string | null
  allocations: RefundAllocation[]
  providerSnapshot: JsonObject
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RequestRefundInput {
  paymentId: string
  publicId: string
  reason: string
  requestedByEmployeeId: string
  allocations: readonly RefundAllocation[]
  requestEvidence?: JsonObject
}

export interface RequestActivityRefundInput {
  paymentId: string
  publicId: string
  reason: string
  requestedByEmployeeId: string
  requestEvidence?: JsonObject
}

export interface CompleteManualRefundInput {
  refundId: string
  succeeded: boolean
  receiptReference: string
  providerSnapshot?: JsonObject
}

export interface CompleteProviderRefundInput {
  refundPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar'>
  providerRefundId: string
  originalProviderTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  succeeded: boolean
  providerSnapshot?: JsonObject
}

export interface RefundCompletionApplication {
  refund: Refund
  applied: boolean
}

interface RefundStoredRow extends Record<string, unknown> {
  id: string
  payment_id: string
  public_id: string
  provider_refund_id: string | null
  amount_minor: string | number
  currency: string
  status: RefundStatus
  reason: string
  requested_by_employee_id: string
  approved_by_employee_id: string | null
  decision_reason: string | null
  provider_snapshot: JsonObject
  provider_submission_state: 'not_started' | 'submitting' | 'submitted' | 'manual_review'
  completed_at: string | null
  created_at: string
  updated_at: string
}

interface RefundRow extends RefundStoredRow {
  order_id: string | null
  activity_registration_id: string | null
  payment_provider: PaymentProvider
  payment_provider_transaction_id: string | null
  allocations: unknown
}

interface PaymentForRefundRow extends Record<string, unknown> {
  id: string
  payable_kind: 'order' | 'activity_registration'
  order_id: string | null
  activity_registration_id: string | null
  provider: PaymentProvider
  provider_transaction_id: string | null
  amount_minor: string | number
  currency: string
  status: string
}

interface OrderItemRow extends Record<string, unknown> {
  id: string
  total_amount_minor: string | number
  currency: string
  status: string
}

interface ExistingRefundTotalRow extends Record<string, unknown> {
  reserved_total_minor: string | number
}

interface ExistingRefundAllocationRow extends Record<string, unknown> {
  order_item_id: string
  reserved_amount_minor: string | number
}

interface RefundAllocationRow extends Record<string, unknown> {
  order_item_id: string
  amount_minor: string | number
}

const RESERVING_REFUND_STATUSES: readonly RefundStatus[] = [
  'requested',
  'approved',
  'processing',
  'succeeded',
]

export class RefundNotFoundError extends Error {
  constructor(id: string) {
    super(`Refund was not found: ${id}`)
    this.name = 'RefundNotFoundError'
  }
}

export class RefundLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefundLimitError'
  }
}

export class RefundApprovalRequiredError extends Error {
  constructor(id: string, status: RefundStatus) {
    super(`Refund ${id} requires human approval before execution; current status is ${status}`)
    this.name = 'RefundApprovalRequiredError'
  }
}

export class RefundTransitionError extends Error {
  constructor(id: string, from: RefundStatus, to: RefundStatus) {
    super(`Refund ${id} cannot transition from ${from} to ${to}`)
    this.name = 'RefundTransitionError'
  }
}

export class RefundCallbackMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefundCallbackMismatchError'
  }
}

export class RefundRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async request(input: Readonly<RequestRefundInput>): Promise<Refund> {
    validateRequest(input)
    const payment = await this.lockPayment(input.paymentId)
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) {
      throw new RefundLimitError(`Payment ${payment.id} is not refundable from status ${payment.status}`)
    }
    if (payment.order_id === null) {
      throw new RefundLimitError('Activity payments require the full activity refund workflow')
    }

    const allocations = normalizeAllocations(input.allocations)
    const amountMinor = allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)
    const items = await this.lockOrderItems(payment.order_id, allocations.map((item) => item.orderItemId))
    validateItems(items, allocations, payment.currency)

    const existingTotal = await this.transaction.query<ExistingRefundTotalRow>(`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS reserved_total_minor
      FROM mbox.refunds
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND payment_id = $3::uuid
        AND status = ANY($4::text[])
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      RESERVING_REFUND_STATUSES,
    ])
    const existingAllocations = await this.transaction.query<ExistingRefundAllocationRow>(`
      SELECT refund_item.order_item_id,
        SUM(refund_item.amount_minor)::text AS reserved_amount_minor
      FROM mbox.refund_items refund_item
      JOIN mbox.refunds refund
        ON refund.tenant_id = refund_item.tenant_id
        AND refund.store_id = refund_item.store_id
        AND refund.id = refund_item.refund_id
      WHERE refund.tenant_id = $1::uuid
        AND refund.store_id = $2::uuid
        AND refund.payment_id = $3::uuid
        AND refund.status = ANY($4::text[])
        AND refund_item.order_item_id = ANY($5::uuid[])
      GROUP BY refund_item.order_item_id
      ORDER BY refund_item.order_item_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      RESERVING_REFUND_STATUSES,
      allocations.map((allocation) => allocation.orderItemId),
    ])
    validateRefundCapacity(
      payment,
      items,
      allocations,
      amountMinor,
      existingTotal.rows[0]?.reserved_total_minor ?? 0,
      existingAllocations.rows,
    )

    const snapshot: JsonObject = {
      requestEvidence: input.requestEvidence ?? {},
    }
    const inserted = await this.transaction.query<RefundStoredRow>(`
      INSERT INTO mbox.refunds (
        tenant_id, store_id, payment_id, public_id, amount_minor, currency,
        status, reason, requested_by_employee_id, provider_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6,
        'requested', $7, $8::uuid, $9::jsonb
      )
      RETURNING ${REFUND_BASE_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.publicId,
      amountMinor,
      payment.currency,
      input.reason.trim(),
      input.requestedByEmployeeId,
      JSON.stringify(snapshot),
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new Error('Creating a refund request did not insert exactly one row')
    }
    const insertedAllocations = await this.transaction.query<RefundAllocationRow>(`
      INSERT INTO mbox.refund_items (
        tenant_id, store_id, refund_id, order_item_id, amount_minor, currency
      )
      SELECT $1::uuid, $2::uuid, $3::uuid, allocation.order_item_id,
        allocation.amount_minor, $4
      FROM unnest($5::uuid[], $6::bigint[]) AS allocation(order_item_id, amount_minor)
      RETURNING order_item_id, amount_minor
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      row.id,
      payment.currency,
      allocations.map((allocation) => allocation.orderItemId),
      allocations.map((allocation) => allocation.amountMinor),
    ])
    if (insertedAllocations.rowCount !== allocations.length) {
      throw new Error('Creating refund item allocations did not insert every item')
    }
    return mapRefund({
      ...row,
      order_id: payment.order_id,
      activity_registration_id: null,
      payment_provider: payment.provider,
      payment_provider_transaction_id: payment.provider_transaction_id,
      allocations: insertedAllocations.rows.map(allocationRowToJson),
    })
  }

  async requestActivity(input: Readonly<RequestActivityRefundInput>): Promise<Refund> {
    validateActivityRequest(input)
    const payment = await this.lockPayment(input.paymentId)
    if (payment.payable_kind !== 'activity_registration' || payment.activity_registration_id === null) {
      throw new RefundLimitError('Payment does not belong to an activity registration')
    }
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) {
      throw new RefundLimitError(`Payment ${payment.id} is not refundable from status ${payment.status}`)
    }
    const existing = await this.transaction.query<ExistingRefundTotalRow>(`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS reserved_total_minor
      FROM mbox.refunds
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
        AND status=ANY($4::text[])
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      RESERVING_REFUND_STATUSES,
    ])
    const amountMinor = toSafeMinor(payment.amount_minor, 'activity payment amount')
      - toSafeMinor(existing.rows[0]?.reserved_total_minor ?? 0, 'activity refund reserved amount')
    if (amountMinor <= 0) throw new RefundLimitError('Activity payment has no refundable balance')
    const inserted = await this.transaction.query<RefundStoredRow>(`
      INSERT INTO mbox.refunds (
        tenant_id, store_id, payment_id, public_id, amount_minor, currency,
        status, reason, requested_by_employee_id, provider_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6,
        'requested', $7, $8::uuid, $9::jsonb
      ) RETURNING ${REFUND_BASE_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.publicId,
      amountMinor,
      payment.currency,
      input.reason.trim(),
      input.requestedByEmployeeId,
      JSON.stringify({ requestEvidence: input.requestEvidence ?? {}, targetKind: 'activity_registration' }),
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new Error('Creating an activity refund request did not insert exactly one row')
    }
    return mapRefund({
      ...row,
      order_id: null,
      activity_registration_id: payment.activity_registration_id,
      payment_provider: payment.provider,
      payment_provider_transaction_id: payment.provider_transaction_id,
      allocations: [],
    })
  }

  async approve(refundId: string, approverEmployeeId: string, decisionReason: string): Promise<Refund> {
    const current = await this.lockRefund(refundId)
    if (current.status !== 'requested') {
      throw new RefundTransitionError(current.id, current.status, 'approved')
    }
    if (current.requested_by_employee_id === approverEmployeeId) {
      throw new RefundTransitionError(current.id, current.status, 'approved')
    }
    return this.transition(current, 'approved', approverEmployeeId, decisionReason)
  }

  async reject(refundId: string, approverEmployeeId: string, decisionReason: string): Promise<Refund> {
    const current = await this.lockRefund(refundId)
    if (current.status !== 'requested') {
      throw new RefundTransitionError(current.id, current.status, 'rejected')
    }
    return this.transition(current, 'rejected', approverEmployeeId, decisionReason)
  }

  async beginExecution(refundId: string): Promise<Refund> {
    const current = await this.lockRefund(refundId)
    if (current.status === 'processing' && current.provider_submission_state === 'not_started') {
      return mapRefund(current)
    }
    if (current.status !== 'approved' || current.approved_by_employee_id === null) {
      throw new RefundApprovalRequiredError(current.id, current.status)
    }
    return this.transition(
      current,
      'processing',
      current.approved_by_employee_id,
      current.decision_reason ?? 'approved',
    )
  }

  async completeManualExecution(input: Readonly<CompleteManualRefundInput>): Promise<Refund> {
    const current = await this.lockRefund(input.refundId)
    if (current.payment_provider !== 'cash' && current.payment_provider !== 'physical_pos') {
      throw new RefundCallbackMismatchError('Online-provider refunds require a verified provider callback or query')
    }
    return this.completeLocked(current, {
      succeeded: input.succeeded,
      providerRefundId: input.receiptReference,
      providerSnapshot: input.providerSnapshot,
    })
  }

  async completeProviderExecution(
    input: Readonly<CompleteProviderRefundInput>,
  ): Promise<RefundCompletionApplication> {
    validateProviderCompletion(input)
    const current = await this.lockRefundByPublicId(input.refundPublicId)
    verifyProviderCompletion(current, input)
    const target: RefundStatus = input.succeeded ? 'succeeded' : 'failed'
    if (current.status === target && current.provider_refund_id === input.providerRefundId) {
      return { refund: mapRefund(current), applied: false }
    }
    if (current.status === 'succeeded' || current.status === 'failed') {
      throw new RefundCallbackMismatchError(
        `Refund ${current.id} terminal result conflicts with the verified provider callback`,
      )
    }
    return {
      refund: await this.completeLocked(current, {
        succeeded: input.succeeded,
        providerRefundId: input.providerRefundId,
        providerSnapshot: input.providerSnapshot,
      }),
      applied: true,
    }
  }

  private async completeLocked(
    current: RefundRow,
    input: { succeeded: boolean; providerRefundId: string; providerSnapshot?: JsonObject },
  ): Promise<Refund> {
    if (current.status !== 'processing') {
      throw new RefundTransitionError(current.id, current.status, input.succeeded ? 'succeeded' : 'failed')
    }
    if (input.providerRefundId.trim().length === 0) throw new TypeError('Refund result requires providerRefundId')
    const target: RefundStatus = input.succeeded ? 'succeeded' : 'failed'
    const updated = await this.transaction.query<RefundRow>(`
      UPDATE mbox.refunds AS r
      SET status = $4,
          provider_refund_id = $5,
          provider_snapshot = r.provider_snapshot || $6::jsonb,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      FROM mbox.payments AS p
      WHERE r.tenant_id = $1::uuid
        AND r.store_id = $2::uuid
        AND r.id = $3::uuid
        AND r.status = 'processing'
        AND p.tenant_id = r.tenant_id
        AND p.store_id = r.store_id
        AND p.id = r.payment_id
      RETURNING ${JOINED_REFUND_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      current.id,
      target,
      input.providerRefundId,
      JSON.stringify(input.providerSnapshot ?? {}),
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new RefundTransitionError(current.id, current.status, target)
    }
    return mapRefund(row)
  }

  async syncPaymentRefundStatus(paymentId: string): Promise<Refund['status'] | PaymentRefundStatus> {
    const payment = await this.lockPayment(paymentId)
    const totals = await this.transaction.query<{ refunded_minor: string | number }>(`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS refunded_minor
      FROM mbox.refunds
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND payment_id = $3::uuid
        AND status = 'succeeded'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.id])
    const refunded = toSafeMinor(totals.rows[0]?.refunded_minor ?? 0, 'refunded total')
    const paid = toSafeMinor(payment.amount_minor, 'payment amount')
    const status: PaymentRefundStatus = refunded >= paid
      ? 'refunded'
      : refunded > 0
        ? 'partially_refunded'
        : 'succeeded'
    const updated = await this.transaction.query<{ status: PaymentRefundStatus }>(`
      UPDATE mbox.payments
      SET status = $4
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      RETURNING status
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.id, status])
    if (updated.rowCount !== 1 || updated.rows[0] === undefined) {
      throw new Error(`Payment ${payment.id} refund status was not updated`)
    }
    return updated.rows[0].status
  }

  private async lockPayment(paymentId: string): Promise<PaymentForRefundRow> {
    const reference = await this.transaction.query<{
      payable_kind: 'order' | 'activity_registration'; order_id: string | null; activity_registration_id: string | null
    }>(`
      SELECT payable_kind, order_id, activity_registration_id
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const target = reference.rows[0]
    if (target === undefined) throw new RefundNotFoundError(paymentId)
    await this.lockPaymentTarget(target)
    const result = await this.transaction.query<PaymentForRefundRow>(`
      SELECT id, payable_kind, order_id, activity_registration_id,
        provider, provider_transaction_id, amount_minor, currency, status
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (row === undefined) throw new RefundNotFoundError(paymentId)
    return row
  }

  private async lockOrderItems(orderId: string, itemIds: readonly string[]): Promise<OrderItemRow[]> {
    const result = await this.transaction.query<OrderItemRow>(`
      SELECT id, total_amount_minor, currency, status
      FROM mbox.order_items
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND order_id = $3::uuid
        AND id = ANY($4::uuid[])
      ORDER BY id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId, [...itemIds]])
    return result.rows
  }

  private async lockRefund(refundId: string): Promise<RefundRow> {
    const reference = await this.transaction.query<{
      payable_kind: 'order' | 'activity_registration'; order_id: string | null; activity_registration_id: string | null
    }>(`
      SELECT p.payable_kind, p.order_id, p.activity_registration_id
      FROM mbox.refunds AS r
      JOIN mbox.payments AS p
        ON p.tenant_id = r.tenant_id
       AND p.store_id = r.store_id
       AND p.id = r.payment_id
      WHERE r.tenant_id = $1::uuid
        AND r.store_id = $2::uuid
        AND r.id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const target = reference.rows[0]
    if (target === undefined) throw new RefundNotFoundError(refundId)
    await this.lockPaymentTarget(target)
    const result = await this.transaction.query<RefundRow>(`
      SELECT ${JOINED_REFUND_COLUMNS}
      FROM mbox.refunds AS r
      JOIN mbox.payments AS p
        ON p.tenant_id = r.tenant_id
       AND p.store_id = r.store_id
       AND p.id = r.payment_id
      WHERE r.tenant_id = $1::uuid
        AND r.store_id = $2::uuid
        AND r.id = $3::uuid
      FOR UPDATE OF r, p
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const row = result.rows[0]
    if (row === undefined) throw new RefundNotFoundError(refundId)
    return row
  }

  private async lockRefundByPublicId(refundPublicId: string): Promise<RefundRow> {
    const reference = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.refunds
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND (
          public_id = $3
          OR provider_refund_id = $3
          OR merchant_refund_id = $3
        )
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundPublicId])
    const refundId = reference.rows[0]?.id
    if (refundId === undefined) throw new RefundNotFoundError(refundPublicId)
    return this.lockRefund(refundId)
  }

  private async lockOrder(orderId: string): Promise<void> {
    const locked = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.orders
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (locked.rowCount !== 1) throw new RefundNotFoundError(orderId)
  }

  private async lockPaymentTarget(target: Readonly<{
    payable_kind: 'order' | 'activity_registration'; order_id: string | null; activity_registration_id: string | null
  }>): Promise<void> {
    if (target.payable_kind === 'order' && target.order_id !== null) {
      await this.lockOrder(target.order_id)
      return
    }
    if (target.payable_kind === 'activity_registration' && target.activity_registration_id !== null) {
      const locked = await this.transaction.query(`
        SELECT id FROM mbox.community_activity_registrations
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, target.activity_registration_id])
      if (locked.rowCount !== 1) throw new RefundNotFoundError(target.activity_registration_id)
      return
    }
    throw new RefundNotFoundError('invalid payment target')
  }

  private async transition(
    current: RefundRow,
    target: Extract<RefundStatus, 'approved' | 'rejected' | 'processing'>,
    approverEmployeeId: string,
    decisionReason: string,
  ): Promise<Refund> {
    const normalizedDecisionReason = decisionReason.trim()
    if (normalizedDecisionReason.length < 2 || normalizedDecisionReason.length > 1_000) {
      throw new TypeError('Refund decision reason must contain between 2 and 1000 characters')
    }
    const expected = target === 'processing' ? 'approved' : 'requested'
    const updated = await this.transaction.query<RefundRow>(`
      UPDATE mbox.refunds AS r
      SET status = $4,
          approved_by_employee_id = CASE
            WHEN $4 IN ('approved', 'rejected') THEN $5::uuid
            ELSE approved_by_employee_id
          END,
          decision_reason = CASE
            WHEN $4 IN ('approved', 'rejected') THEN $7
            ELSE decision_reason
          END,
          updated_at = clock_timestamp()
      FROM mbox.payments AS p
      WHERE r.tenant_id = $1::uuid
        AND r.store_id = $2::uuid
        AND r.id = $3::uuid
        AND r.status = $6
        AND p.tenant_id = r.tenant_id
        AND p.store_id = r.store_id
        AND p.id = r.payment_id
      RETURNING ${JOINED_REFUND_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      current.id,
      target,
      approverEmployeeId,
      expected,
      normalizedDecisionReason,
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new RefundTransitionError(current.id, current.status, target)
    }
    return mapRefund(row)
  }
}

type PaymentRefundStatus = 'succeeded' | 'partially_refunded' | 'refunded'

const REFUND_BASE_COLUMNS = `
  id, payment_id, public_id, provider_refund_id, amount_minor, currency,
  status, reason, requested_by_employee_id, approved_by_employee_id, decision_reason,
  provider_snapshot, provider_submission_state, completed_at::text, created_at::text, updated_at::text
`

const JOINED_REFUND_COLUMNS = `
  r.id, r.payment_id, p.order_id, p.activity_registration_id,
  p.provider AS payment_provider,
  p.provider_transaction_id AS payment_provider_transaction_id,
  r.public_id, r.provider_refund_id, r.amount_minor, r.currency,
  r.status, r.reason, r.requested_by_employee_id, r.approved_by_employee_id, r.decision_reason,
  r.provider_snapshot, r.provider_submission_state, r.completed_at::text, r.created_at::text, r.updated_at::text,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'orderItemId', refund_item.order_item_id,
      'amountMinor', refund_item.amount_minor
    ) ORDER BY refund_item.order_item_id)
    FROM mbox.refund_items refund_item
    WHERE refund_item.tenant_id = r.tenant_id
      AND refund_item.store_id = r.store_id
      AND refund_item.refund_id = r.id
  ), '[]'::jsonb) AS allocations
`

function validateRequest(input: Readonly<RequestRefundInput>): void {
  if (input.paymentId.trim().length === 0) throw new TypeError('paymentId must not be blank')
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.reason.trim().length === 0) throw new TypeError('refund reason must not be blank')
  if (input.requestedByEmployeeId.trim().length === 0) {
    throw new TypeError('requestedByEmployeeId must not be blank')
  }
  if (input.allocations.length === 0) {
    throw new TypeError('refund requires at least one order item allocation')
  }
}

function validateActivityRequest(input: Readonly<RequestActivityRefundInput>): void {
  if (input.paymentId.trim().length === 0) throw new TypeError('paymentId must not be blank')
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.reason.trim().length < 2 || input.reason.trim().length > 1_000) {
    throw new TypeError('activity refund reason must contain between 2 and 1000 characters')
  }
  if (input.requestedByEmployeeId.trim().length === 0) {
    throw new TypeError('requestedByEmployeeId must not be blank')
  }
}

function normalizeAllocations(allocations: readonly RefundAllocation[]): RefundAllocation[] {
  const byItem = new Map<string, number>()
  for (const allocation of allocations) {
    if (allocation.orderItemId.trim().length === 0) throw new TypeError('orderItemId must not be blank')
    if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) {
      throw new TypeError('refund allocation amount must be a positive safe integer')
    }
    byItem.set(allocation.orderItemId, (byItem.get(allocation.orderItemId) ?? 0) + allocation.amountMinor)
  }
  return [...byItem.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([orderItemId, amountMinor]) => ({ orderItemId, amountMinor }))
}

function validateItems(
  items: readonly OrderItemRow[],
  allocations: readonly RefundAllocation[],
  currency: string,
): void {
  if (items.length !== allocations.length) {
    throw new RefundLimitError('One or more refund allocations do not belong to the payment order')
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const allocation of allocations) {
    const item = byId.get(allocation.orderItemId)
    if (item === undefined) throw new RefundLimitError(`Order item ${allocation.orderItemId} was not found`)
    if (item.status === 'cancelled') throw new RefundLimitError(`Order item ${item.id} is cancelled`)
    if (item.currency !== currency) throw new RefundLimitError(`Order item ${item.id} has a currency mismatch`)
  }
}

function validateRefundCapacity(
  payment: PaymentForRefundRow,
  items: readonly OrderItemRow[],
  allocations: readonly RefundAllocation[],
  amountMinor: number,
  reservedTotalValue: string | number,
  existingAllocations: readonly ExistingRefundAllocationRow[],
): void {
  const paymentAmount = toSafeMinor(payment.amount_minor, 'payment amount')
  const reservedTotal = toSafeMinor(reservedTotalValue, 'existing refund amount')
  if (reservedTotal + amountMinor > paymentAmount) {
    throw new RefundLimitError('Cumulative refunds cannot exceed the captured payment amount')
  }

  const existingByItem = new Map(existingAllocations.map((allocation) => [
    allocation.order_item_id,
    toSafeMinor(allocation.reserved_amount_minor, 'existing order item refund amount'),
  ]))
  const itemById = new Map(items.map((item) => [item.id, item]))
  for (const allocation of allocations) {
    const item = itemById.get(allocation.orderItemId)!
    const itemTotal = toSafeMinor(item.total_amount_minor, 'order item total')
    if ((existingByItem.get(item.id) ?? 0) + allocation.amountMinor > itemTotal) {
      throw new RefundLimitError(`Cumulative refund exceeds order item ${item.id} paid amount`)
    }
  }
}

function readAllocations(value: unknown): RefundAllocation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((allocation) => {
    if (typeof allocation !== 'object' || allocation === null || Array.isArray(allocation)) return []
    const itemId = allocation.orderItemId
    const amount = allocation.amountMinor
    return typeof itemId === 'string' && typeof amount === 'number' && Number.isSafeInteger(amount)
      ? [{ orderItemId: itemId, amountMinor: amount }]
      : []
  })
}

function allocationRowToJson(row: RefundAllocationRow): JsonObject {
  return {
    orderItemId: row.order_item_id,
    amountMinor: toSafeMinor(row.amount_minor, 'refund allocation amount'),
  }
}

function mapRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    activityRegistrationId: row.activity_registration_id,
    paymentProvider: row.payment_provider,
    publicId: row.public_id,
    providerRefundId: row.provider_refund_id,
    amountMinor: toSafeMinor(row.amount_minor, 'refund amount'),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    requestedByEmployeeId: row.requested_by_employee_id,
    approvedByEmployeeId: row.approved_by_employee_id,
    decisionReason: row.decision_reason,
    allocations: readAllocations(row.allocations),
    providerSnapshot: row.provider_snapshot,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateProviderCompletion(input: Readonly<CompleteProviderRefundInput>): void {
  if (input.refundPublicId.trim().length === 0) throw new TypeError('refundPublicId must not be blank')
  if (input.providerRefundId.trim().length === 0) throw new TypeError('providerRefundId must not be blank')
  if (input.originalProviderTransactionId.trim().length === 0) {
    throw new TypeError('originalProviderTransactionId must not be blank')
  }
  if (!Number.isSafeInteger(input.reportedAmountMinor) || input.reportedAmountMinor <= 0) {
    throw new TypeError('reportedAmountMinor must be a positive safe integer')
  }
  if (!/^[A-Z]{3}$/.test(input.reportedCurrency)) throw new TypeError('reportedCurrency is invalid')
}

function verifyProviderCompletion(
  refund: Readonly<RefundRow>,
  input: Readonly<CompleteProviderRefundInput>,
): void {
  if (refund.payment_provider !== input.provider) {
    throw new RefundCallbackMismatchError('Refund callback provider does not match the original payment')
  }
  if (refund.payment_provider_transaction_id !== input.originalProviderTransactionId) {
    throw new RefundCallbackMismatchError('Refund callback original transaction does not match the payment')
  }
  if (toSafeMinor(refund.amount_minor, 'refund amount') !== input.reportedAmountMinor) {
    throw new RefundCallbackMismatchError('Refund callback amount does not match the approved refund')
  }
  if (refund.currency !== input.reportedCurrency) {
    throw new RefundCallbackMismatchError('Refund callback currency does not match the approved refund')
  }
}

function toSafeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds safe integer range`)
  return parsed
}
