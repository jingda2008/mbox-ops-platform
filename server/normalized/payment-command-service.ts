import type {
  AuditActor,
  CommandExecution,
  CommandOutcome,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import {
  PaymentRepository,
  type Payment,
  type PaymentMethod,
  type PaymentProvider,
} from './payment-repository.js'
import {
  paymentBusinessEventKey,
  sanitizeClientPaymentHints,
  sanitizeClientRefundEvidence,
  sanitizeProviderSnapshot,
  type PaymentCapabilityAuthorizationPort,
} from './payment-security-policy.js'
import { ReconciliationRepository } from './reconciliation-repository.js'
import {
  RefundRepository,
  type Refund,
  type RefundAllocation,
} from './refund-repository.js'
import type { StoreScope } from './transaction-runner.js'

interface CommandMetadata {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface InitiatePaymentCommand extends CommandMetadata {
  orderId: string
  publicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar' | 'simulation'>
  method: Extract<PaymentMethod, 'jsapi' | 'native_qr' | 'auth_code'>
  providerSnapshot?: JsonObject
  principal:
    | { type: 'employee'; employeeId: string }
    | { type: 'guest'; tableSessionId: string; customerId: string }
}

export interface RecordManualPaymentCommand extends CommandMetadata {
  orderId: string
  publicId: string
  provider: Extract<PaymentProvider, 'cash' | 'physical_pos'>
  method: Extract<PaymentMethod, 'cash' | 'card' | 'manual'>
  evidence: JsonObject
  occurredAt: string
}

export interface PaymentCallbackCommand extends CommandMetadata {
  paymentPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar' | 'simulation'>
  providerTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  providerSnapshot?: JsonObject
  occurredAt: string
}

export interface RequestRefundCommand extends CommandMetadata {
  paymentId: string
  publicId: string
  reason: string
  allocations: readonly RefundAllocation[]
  requestEvidence?: JsonObject
}

export interface ApproveRefundCommand extends CommandMetadata {
  refundId: string
  decisionReason: string
}

export interface RejectRefundCommand extends CommandMetadata {
  refundId: string
  decisionReason: string
}

export interface BeginRefundExecutionCommand extends CommandMetadata {
  refundId: string
}

export interface RecordProviderRefundResultCommand extends CommandMetadata {
  refundPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar'>
  providerRefundId: string
  originalProviderTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  succeeded: boolean
  providerSnapshot?: JsonObject
  occurredAt: string
}

export interface RecordManualRefundResultCommand extends CommandMetadata {
  refundId: string
  succeeded: boolean
  receiptReference: string
  providerSnapshot?: JsonObject
  occurredAt: string
}

export class PaymentCommandService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly authorization: PaymentCapabilityAuthorizationPort,
  ) {}

  initiate(input: Readonly<InitiatePaymentCommand>): Promise<CommandExecution<Payment>> {
    const providerHints = sanitizeClientPaymentHints(input.providerSnapshot)
    return this.commands.execute(command(input, 'payment.initiate', paymentCodec), async (transaction) => {
      if (input.principal.type === 'employee') {
        const employeeId = requireEmployee(input.actor, 'Staff payment initiation')
        if (employeeId !== input.principal.employeeId) {
          throw new TypeError('Payment initiation principal must match the employee actor')
        }
        await this.authorization.assertEmployeeCapability({
          transaction,
          employeeId,
          capability: 'payment.initiate.staff',
        })
      } else if (input.actor.type !== 'guest') {
        throw new TypeError('Guest payment initiation requires a guest actor')
      }
      const payments = new PaymentRepository(transaction)
      const payment = await payments.createForOrder({
        orderId: input.orderId,
        publicId: input.publicId,
        provider: input.provider,
        method: input.method,
        evidence: providerHints,
        initialStatus: 'pending',
        principal: input.principal,
      })
      await payments.syncOrderPaymentStatus(payment.orderId)
      return paymentOutcome(input, payment, 'payment.initiated', 1)
    })
  }

  recordManual(input: Readonly<RecordManualPaymentCommand>): Promise<CommandExecution<Payment>> {
    const employeeId = requireEmployee(input.actor, 'Manual payment recording')
    const evidence = sanitizeProviderSnapshot(input.evidence)
    if (evidence.collectedByEmployeeId !== employeeId) {
      throw new TypeError('Manual payment evidence collector must match the acting employee')
    }
    return this.commands.execute(command(input, 'payment.manual-record', paymentCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: input.provider === 'cash'
          ? 'payment.manual.cash.record'
          : 'payment.manual.pos.record',
      })
      const payments = new PaymentRepository(transaction)
      const reference = requiredEvidenceString(evidence, 'receiptReference')
      const payment = await payments.createForOrder({
        orderId: input.orderId,
        publicId: input.publicId,
        provider: input.provider,
        method: input.method,
        providerTransactionId: reference,
        evidence,
        initialStatus: 'succeeded',
        principal: { type: 'employee', employeeId },
      })
      await new ReconciliationRepository(transaction).append({
        paymentId: payment.id,
        entryType: 'payment',
        provider: payment.provider,
        providerReference: reference,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        businessDate: input.businessDate,
        occurredAt: input.occurredAt,
        evidenceSnapshot: evidence,
      })
      await payments.syncOrderPaymentStatus(payment.orderId)
      return paymentOutcome(input, payment, 'payment.manual_recorded', 1)
    })
  }

  recordSucceededCallback(input: Readonly<PaymentCallbackCommand>): Promise<CommandExecution<Payment>> {
    const providerSnapshot = sanitizeProviderSnapshot(input.providerSnapshot)
    requireVerifiedIntegration(input.actor, providerSnapshot, 'Payment callback')
    return this.commands.execute(command(input, 'payment.callback', paymentCodec), async (transaction) => {
      const payments = new PaymentRepository(transaction)
      const application = await payments.applySucceededCallback({
        paymentPublicId: input.paymentPublicId,
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        providerSnapshot,
        succeededAt: input.occurredAt,
      })
      const payment = application.payment
      await payments.consumeProviderAction(payment.id)
      if (!application.applied) return noOpOutcome(payment)
      await new ReconciliationRepository(transaction).append({
        paymentId: payment.id,
        entryType: 'payment',
        provider: payment.provider,
        providerReference: input.providerTransactionId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        businessDate: input.businessDate,
        occurredAt: input.occurredAt,
        evidenceSnapshot: providerSnapshot,
      })
      await payments.syncOrderPaymentStatus(payment.orderId)
      return paymentOutcome(
        input,
        payment,
        'payment.succeeded',
        2,
        paymentBusinessEventKey(
          'succeeded',
          payment.provider,
          input.providerTransactionId,
        ),
      )
    })
  }

  requestRefund(input: Readonly<RequestRefundCommand>): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Refund request')
    const requestEvidence = sanitizeClientRefundEvidence(input.requestEvidence)
    return this.commands.execute(command(input, 'refund.request', refundCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'refund.request',
      })
      const refund = await new RefundRepository(transaction).request({
        paymentId: input.paymentId,
        publicId: input.publicId,
        reason: input.reason,
        requestedByEmployeeId: employeeId,
        allocations: input.allocations,
        requestEvidence,
      })
      return refundOutcome(input, refund, 'refund.requested', 1)
    })
  }

  approveRefund(input: Readonly<ApproveRefundCommand>): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Refund approval')
    return this.commands.execute(command(input, 'refund.approve', refundCodec), async (transaction) => {
      await this.authorization.assertRefundApproval({ transaction, employeeId, refundId: input.refundId })
      const refund = await new RefundRepository(transaction).approve(
        input.refundId,
        employeeId,
        input.decisionReason,
      )
      return refundOutcome(input, refund, 'refund.approved', 2, input.decisionReason)
    })
  }

  rejectRefund(input: Readonly<RejectRefundCommand>): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Refund rejection')
    return this.commands.execute(command(input, 'refund.reject', refundCodec), async (transaction) => {
      await this.authorization.assertRefundApproval({ transaction, employeeId, refundId: input.refundId })
      const refund = await new RefundRepository(transaction).reject(
        input.refundId,
        employeeId,
        input.decisionReason,
      )
      return refundOutcome(input, refund, 'refund.rejected', 2, input.decisionReason)
    })
  }

  beginRefundExecution(
    input: Readonly<BeginRefundExecutionCommand>,
  ): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Refund execution')
    return this.commands.execute(command(input, 'refund.execute', refundCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'refund.execute',
      })
      const refund = await new RefundRepository(transaction).beginExecution(input.refundId)
      return refundOutcome(input, refund, 'refund.execution_requested', 3)
    })
  }

  recordProviderRefundResult(
    input: Readonly<RecordProviderRefundResultCommand>,
  ): Promise<CommandExecution<Refund>> {
    const providerSnapshot = sanitizeProviderSnapshot(input.providerSnapshot)
    requireVerifiedIntegration(input.actor, providerSnapshot, 'Refund result')
    return this.commands.execute(command(input, 'refund.result', refundCodec), async (transaction) => {
      const refunds = new RefundRepository(transaction)
      const application = await refunds.completeProviderExecution({
        refundPublicId: input.refundPublicId,
        provider: input.provider,
        succeeded: input.succeeded,
        providerRefundId: input.providerRefundId,
        originalProviderTransactionId: input.originalProviderTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        providerSnapshot,
      })
      const refund = application.refund
      if (!application.applied) return noOpOutcome(refund)
      if (refund.status === 'succeeded') {
        await new ReconciliationRepository(transaction).append({
          paymentId: refund.paymentId,
          refundId: refund.id,
          entryType: 'refund',
          provider: refund.paymentProvider,
          providerReference: refund.providerRefundId!,
          amountMinor: -refund.amountMinor,
          currency: refund.currency,
          businessDate: input.businessDate,
          occurredAt: input.occurredAt,
          evidenceSnapshot: providerSnapshot,
        })
        await refunds.syncPaymentRefundStatus(refund.paymentId)
        await new PaymentRepository(transaction).syncOrderPaymentStatus(refund.orderId)
      }
      return refundOutcome(
        input,
        refund,
        refund.status === 'succeeded' ? 'refund.succeeded' : 'refund.failed',
        4,
      )
    })
  }

  recordManualRefundResult(
    input: Readonly<RecordManualRefundResultCommand>,
  ): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Manual refund result')
    const providerSnapshot = sanitizeProviderSnapshot(input.providerSnapshot)
    return this.commands.execute(command(input, 'refund.manual-result', refundCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'refund.execute',
      })
      const refunds = new RefundRepository(transaction)
      const refund = await refunds.completeManualExecution({
        refundId: input.refundId,
        succeeded: input.succeeded,
        receiptReference: input.receiptReference,
        providerSnapshot,
      })
      if (refund.status === 'succeeded') {
        await new ReconciliationRepository(transaction).append({
          paymentId: refund.paymentId,
          refundId: refund.id,
          entryType: 'refund',
          provider: refund.paymentProvider,
          providerReference: refund.providerRefundId!,
          amountMinor: -refund.amountMinor,
          currency: refund.currency,
          businessDate: input.businessDate,
          occurredAt: input.occurredAt,
          evidenceSnapshot: providerSnapshot,
        })
        await refunds.syncPaymentRefundStatus(refund.paymentId)
        await new PaymentRepository(transaction).syncOrderPaymentStatus(refund.orderId)
      }
      return refundOutcome(
        input,
        refund,
        refund.status === 'succeeded' ? 'refund.manual_succeeded' : 'refund.manual_failed',
        4,
      )
    })
  }
}

function command<Result>(
  input: Readonly<CommandMetadata>,
  operationScope: string,
  resultCodec: JsonCodec<Result>,
) {
  validateBusinessDate(input.businessDate)
  return {
    scope: input.scope,
    operationScope,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    resultCodec,
  }
}

function paymentOutcome(
  input: Readonly<CommandMetadata>,
  payment: Payment,
  action: string,
  version: number,
  businessEventKey?: string,
) {
  const snapshot = paymentToJson(payment)
  return {
    result: payment,
    auditEvents: [{
      actor: input.actor,
      action,
      objectType: 'payment',
      objectId: payment.id,
      businessDate: input.businessDate,
      afterData: snapshot,
    }],
    outboxMessages: [{
      businessEventKey,
      aggregateType: 'payment',
      aggregateId: payment.id,
      aggregateVersion: version,
      eventType: `${action}.v1`,
      payload: snapshot,
    }],
  }
}

function refundOutcome(
  input: Readonly<CommandMetadata>,
  refund: Refund,
  action: string,
  version: number,
  auditReason?: string,
) {
  const snapshot = refundToJson(refund)
  return {
    result: refund,
    auditEvents: [{
      actor: input.actor,
      action,
      objectType: 'refund',
      objectId: refund.id,
      businessDate: input.businessDate,
      afterData: snapshot,
      reason: auditReason ?? refund.reason,
    }],
    outboxMessages: [{
      aggregateType: 'refund',
      aggregateId: refund.id,
      aggregateVersion: version,
      eventType: `${action}.v1`,
      payload: snapshot,
    }],
  }
}

const paymentCodec: JsonCodec<Payment> = {
  encode: paymentToJson,
  decode: (value) => decodeObject<Payment>(value, ['id', 'orderId', 'publicId', 'provider', 'status']),
}

const refundCodec: JsonCodec<Refund> = {
  encode: refundToJson,
  decode: (value) => decodeObject<Refund>(value, ['id', 'paymentId', 'orderId', 'publicId', 'status']),
}

function paymentToJson(payment: Payment): JsonObject {
  return { ...payment, providerSnapshot: sanitizeProviderSnapshot(payment.providerSnapshot) }
}

function refundToJson(refund: Refund): JsonObject {
  return {
    ...refund,
    allocations: refund.allocations.map((allocation) => ({ ...allocation })),
    providerSnapshot: sanitizeProviderSnapshot(refund.providerSnapshot),
  }
}

function decodeObject<Result>(value: unknown, required: readonly string[]): Result {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Stored command result is invalid')
  }
  const record = value as Record<string, unknown>
  for (const key of required) {
    if (typeof record[key] !== 'string') throw new TypeError(`Stored command result lacks ${key}`)
  }
  return value as Result
}

function requireEmployee(actor: AuditActor, action: string): string {
  if (actor.type !== 'employee') throw new TypeError(`${action} requires an employee actor`)
  return actor.employeeId
}

function requireVerifiedIntegration(
  actor: AuditActor,
  providerSnapshot: JsonObject,
  action: string,
): void {
  if (
    actor.type !== 'integration'
    || actor.ref === undefined
    || actor.ref.trim().length === 0
    || providerSnapshot.signatureVerified !== true
  ) {
    throw new TypeError(`${action} requires an identified integration with verified signature`)
  }
}

function noOpOutcome<Result>(result: Result): CommandOutcome<Result> {
  return { result, auditEvents: [], outboxMessages: [] }
}

function requiredEvidenceString(evidence: JsonObject, key: string): string {
  const value = evidence[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Payment evidence requires ${key}`)
  }
  return value
}

function validateBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('businessDate must use YYYY-MM-DD')
}
