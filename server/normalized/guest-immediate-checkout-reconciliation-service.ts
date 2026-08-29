import type {
  AuditActor,
  CommandExecution,
  CommandOutcome,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import type { PaymentProviderQueryResultCommand } from './payment-command-service.js'
import { PaymentRepository, type Payment } from './payment-repository.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ProviderObservationAuthorityPort } from './provider-verification-observation.js'
import {
  GuestImmediateCheckoutReconciliationRepository,
  type GuestImmediateCheckoutAbandonment,
} from './guest-immediate-checkout-reconciliation-repository.js'

export interface CommitStaleGuestImmediatePaymentTerminalCommand extends PaymentProviderQueryResultCommand {
  workerId: string
}

export interface AbandonUnresolvedGuestImmediatePaymentCommand {
  scope: CommitStaleGuestImmediatePaymentTerminalCommand['scope']
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
  paymentId: string
  workerId: string
}

/**
 * The payment-channel request happens outside this service. This service
 * applies a verified result and operationally retires one customer-owned
 * checkout in the same database command. It never closes a physical table.
 */
export class GuestImmediateCheckoutReconciliationService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly providerObservations: ProviderObservationAuthorityPort,
  ) {}

  commitTerminal(
    input: Readonly<CommitStaleGuestImmediatePaymentTerminalCommand>,
  ): Promise<CommandExecution<Payment>> {
    if (input.provider !== 'postar' || !['closed', 'failed'].includes(input.status)) {
      throw new TypeError('guest immediate checkout reconciliation requires a terminal Postar result')
    }
    const actor = requireIntegrationActor(input.actor)
    requireWorkerId(input.workerId)
    const providerSnapshot = sanitizeProviderSnapshot({
      ...input.providerSnapshot,
      guestImmediateCheckoutReconciliation: true,
      guestCheckoutAbandoned: true,
    })
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'payment.guest-self-checkout-terminal-reconciliation',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: paymentCodec,
    }, async (transaction) => {
      await this.providerObservations.consume({
        transaction,
        observationId: input.verifiedObservationId,
        operation: 'payment.provider-query',
        idempotencyKey: input.idempotencyKey,
        integrationRef: actor.ref,
        provider: 'postar',
        subjectPublicId: input.paymentPublicId,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        observedStatus: input.status === 'closed' ? 'payment_closed' : 'payment_failed',
        settlementChannel: input.settlementChannel,
      })
      const payments = new PaymentRepository(transaction)
      const application = await payments.applyProviderQueryResult({
        paymentPublicId: input.paymentPublicId,
        provider: 'postar',
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        settlementChannel: input.settlementChannel,
        providerSnapshot,
        succeededAt: input.occurredAt,
        status: input.status,
      })
      const payment = application.payment
      if (payment.orderId === null) throw new TypeError('guest payment lost its order target')
      const orderPaymentStatus = await payments.syncOrderPaymentStatus(payment.orderId)
      if (orderPaymentStatus !== 'unpaid') {
        throw new Error('guest checkout acquired a non-unpaid order during terminal reconciliation')
      }
      const abandonment = await new GuestImmediateCheckoutReconciliationRepository(transaction).retire({
        paymentId: payment.id,
        workerRef: input.workerId,
        providerOutcome: 'terminal',
        reasonCode: 'stale_guest_immediate_payment',
      })
      return terminalOutcome(input, payment, abandonment, application.applied)
    })
  }

  /**
   * Last-resort capacity release for a payment rail that stayed unavailable or
   * unknown past the configured window. The payment fact remains pending so a
   * later capture enters the database trigger's controlled refund review.
   */
  abandonUnresolved(
    input: Readonly<AbandonUnresolvedGuestImmediatePaymentCommand>,
  ): Promise<CommandExecution<GuestImmediateCheckoutAbandonment>> {
    const actor = requireIntegrationActor(input.actor)
    requireWorkerId(input.workerId)
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'payment.guest-self-checkout-unresolved-abandonment',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: abandonmentCodec,
    }, async (transaction) => {
      const abandonment = await new GuestImmediateCheckoutReconciliationRepository(transaction).retire({
        paymentId: input.paymentId,
        workerRef: input.workerId,
        providerOutcome: 'unresolved',
        reasonCode: 'stale_guest_immediate_payment',
      })
      const snapshot = abandonmentToJson(abandonment)
      return {
        result: abandonment,
        auditEvents: [{
          actor,
          action: 'order.guest_self_checkout_unresolved_abandoned',
          objectType: 'order',
          objectId: abandonment.orderId,
          businessDate: abandonment.actionBusinessDate,
          afterData: snapshot,
          reason: '支付渠道长时间无法确认；订单停止履约并等待晚到支付或人工退款复核',
          metadata: { workerId: input.workerId, paymentId: input.paymentId },
        }],
        outboxMessages: [{
          businessEventKey: `order:guest-self-checkout-unresolved-abandoned:${abandonment.eventId}`,
          aggregateType: 'order', aggregateId: abandonment.orderId, aggregateVersion: 2,
          eventType: 'order.guest_self_checkout_unresolved_abandoned.v1', payload: snapshot,
        }],
      }
    })
  }
}

function terminalOutcome(
  input: Readonly<CommitStaleGuestImmediatePaymentTerminalCommand>,
  payment: Readonly<Payment>,
  abandonment: Readonly<GuestImmediateCheckoutAbandonment>,
  appliedProviderResult: boolean,
): CommandOutcome<Payment> {
  const paymentSnapshot = paymentToJson(payment)
  const abandonmentSnapshot = abandonmentToJson(abandonment)
  return {
    result: payment as Payment,
    auditEvents: [
      {
        actor: input.actor,
        action: appliedProviderResult ? 'payment.guest_self_checkout_terminal_reconciled' : 'payment.guest_self_checkout_terminal_replayed',
        objectType: 'payment', objectId: payment.id, businessDate: abandonment.actionBusinessDate,
        afterData: paymentSnapshot,
        reason: '渠道已核实未收款；自动收尾顾客自助即时支付订单',
        metadata: { workerId: input.workerId, abandonmentEventId: abandonment.eventId },
      },
      {
        actor: input.actor,
        action: 'order.guest_self_checkout_abandoned',
        objectType: 'order', objectId: abandonment.orderId, businessDate: abandonment.actionBusinessDate,
        afterData: abandonmentSnapshot,
        reason: '渠道已核实未收款；不保留不可履约的顾客自助支付订单',
        metadata: { workerId: input.workerId, paymentId: payment.id },
      },
    ],
    outboxMessages: [
      {
        businessEventKey: `payment:guest-self-checkout-terminal:${payment.id}`,
        aggregateType: 'payment', aggregateId: payment.id, aggregateVersion: 3,
        eventType: 'payment.guest_self_checkout_terminal_reconciled.v1', payload: paymentSnapshot,
      },
      {
        businessEventKey: `order:guest-self-checkout-abandoned:${abandonment.eventId}`,
        aggregateType: 'order', aggregateId: abandonment.orderId, aggregateVersion: 2,
        eventType: 'order.guest_self_checkout_abandoned.v1', payload: abandonmentSnapshot,
      },
    ],
  }
}

function paymentToJson(payment: Readonly<Payment>): JsonObject {
  return { ...payment, providerSnapshot: sanitizeProviderSnapshot(payment.providerSnapshot) }
}

function abandonmentToJson(abandonment: Readonly<GuestImmediateCheckoutAbandonment>): JsonObject {
  return {
    eventId: abandonment.eventId, paymentId: abandonment.paymentId, paymentPublicId: abandonment.paymentPublicId,
    orderId: abandonment.orderId, orderPublicId: abandonment.orderPublicId,
    sourceBusinessDate: abandonment.sourceBusinessDate, actionBusinessDate: abandonment.actionBusinessDate,
    providerTerminalStatus: abandonment.providerTerminalStatus,
    releasedInventoryReservationCount: abandonment.releasedInventoryReservationCount,
    cancelledItemCount: abandonment.cancelledItemCount, cancelledKdsTaskCount: abandonment.cancelledKdsTaskCount,
    replayed: abandonment.replayed,
  }
}

const paymentCodec: JsonCodec<Payment> = {
  encode: paymentToJson,
  decode(value: unknown): Payment {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('stored guest checkout payment result is invalid')
    }
    const record = value as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.publicId !== 'string'
      || typeof record.status !== 'string' || typeof record.provider !== 'string') {
      throw new TypeError('stored guest checkout payment result is incomplete')
    }
    return value as Payment
  },
}

const abandonmentCodec: JsonCodec<GuestImmediateCheckoutAbandonment> = {
  encode: abandonmentToJson,
  decode(value: unknown): GuestImmediateCheckoutAbandonment {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('stored guest checkout abandonment result is invalid')
    }
    const record = value as Record<string, unknown>
    if (typeof record.eventId !== 'string' || typeof record.paymentId !== 'string'
      || typeof record.orderId !== 'string' || typeof record.providerTerminalStatus !== 'string') {
      throw new TypeError('stored guest checkout abandonment result is incomplete')
    }
    return value as GuestImmediateCheckoutAbandonment
  },
}

function requireIntegrationActor(actor: AuditActor): { type: 'integration'; ref: string } {
  if (actor.type !== 'integration' || typeof actor.ref !== 'string' || actor.ref.length < 3) {
    throw new TypeError('guest immediate checkout reconciliation requires an integration actor')
  }
  return { type: 'integration', ref: actor.ref }
}

function requireWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 128 characters')
  }
}
