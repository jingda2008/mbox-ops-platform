import type {
  AuditActor,
  CommandExecution,
  CommandOutcome,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
  OutboxMessage,
} from './command-executor.js'
import { appendOutboxMessage } from './command-executor.js'
import type { ChannelPaymentStatus } from '../../src/shared/payment-contracts.js'
import {
  PaymentRepository,
  type Payment,
  type AuthoritativeSettlementChannel,
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
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import {
  PaymentFulfillmentRepository,
  type PaymentFulfillmentActivation,
  type PaymentFulfillmentRelease,
} from './payment-fulfillment-repository.js'
import { RecommendationFinancialAttributionRepository } from './recommendation-financial-attribution-repository.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { ExperiencePlanActivationRepository } from './experience-plan-activation-repository.js'
import {
  RejectingProviderObservationAuthority,
  type ProviderObservationAuthorityPort,
} from './provider-verification-observation.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'
import {
  RecollectionAuthorizationRepository,
  type OrderRecollectionAuthorization,
} from './recollection-authorization-repository.js'
import {
  ActivityRecollectionAuthorizationRepository,
  type ActivityRecollectionAuthorization,
} from './activity-recollection-authorization-repository.js'

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
    | { type: 'guest'; tableSessionId: string; customerId: string; guestSessionId: string }
}

export interface RecordManualPaymentCommand extends CommandMetadata {
  orderId: string
  publicId: string
  provider: Extract<PaymentProvider, 'cash' | 'physical_pos' | 'external_manual'>
  method: Extract<PaymentMethod, 'cash' | 'card' | 'manual'>
  evidence: JsonObject
}

export interface RecordManualActivityPaymentCommand extends CommandMetadata {
  registrationPublicId: string
  publicId: string
  provider: Extract<PaymentProvider, 'cash' | 'physical_pos' | 'external_manual'>
  method: Extract<PaymentMethod, 'cash' | 'card' | 'manual'>
  evidence: JsonObject
}

export interface PaymentCallbackCommand extends CommandMetadata {
  verifiedObservationId: string
  paymentPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar'>
  providerTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  settlementChannel?: AuthoritativeSettlementChannel
  providerSnapshot?: JsonObject
  occurredAt: string
}

export interface PaymentProviderQueryResultCommand extends PaymentCallbackCommand {
  status: ChannelPaymentStatus
}

export interface RequestRefundCommand extends CommandMetadata {
  paymentId: string
  publicId: string
  reason: string
  allocations: readonly RefundAllocation[]
  requestEvidence?: JsonObject
}

export interface RequestActivityRefundCommand extends CommandMetadata {
  paymentId: string
  publicId: string
  reason: string
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
  verifiedObservationId: string
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
}

export interface AuthorizeRecollectionCommand extends CommandMetadata {
  orderId: string
  reason: string
}

export interface AuthorizeActivityRecollectionCommand extends CommandMetadata {
  registrationPublicId: string
  reason: string
}

export class PaymentCommandService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly authorization: PaymentCapabilityAuthorizationPort,
    private readonly providerObservations: ProviderObservationAuthorityPort = new RejectingProviderObservationAuthority(),
    private readonly options: Readonly<{ printTicketSources?: boolean }> = {},
  ) {}

  initiate(input: Readonly<InitiatePaymentCommand>): Promise<CommandExecution<Payment>> {
    return this.commands.execute(command(input, 'payment.initiate', paymentCodec), (transaction) => (
      this.initiateInTransaction(transaction, input)
    ))
  }

  async initiateInTransaction(
    transaction: ScopedTransaction,
    input: Readonly<InitiatePaymentCommand>,
  ): Promise<CommandOutcome<Payment>> {
      const providerHints = sanitizeClientPaymentHints(input.providerSnapshot)
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
        await this.authorization.assertEmployeeOrderAccess({
          transaction,
          employeeId,
          orderId: input.orderId,
        })
      } else if (input.actor.type !== 'guest') {
        throw new TypeError('Guest payment initiation requires a guest actor')
      }
      await new PaymentFulfillmentRepository(transaction).ensureReservationBeforePayment(input.orderId)
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
      if (payment.orderId === null) throw new Error('Order payment lost its order target')
      await payments.syncOrderPaymentStatus(payment.orderId)
      return paymentOutcome(transaction, input, payment, 'payment.initiated', 1, undefined, undefined, this.options.printTicketSources === true)
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
          : input.provider === 'physical_pos'
            ? 'payment.manual.pos.record'
            : 'payment.manual.external.record',
      })
      await this.authorization.assertEmployeeOrderAccess({
        transaction,
        employeeId,
        orderId: input.orderId,
      })
      const fulfillment = new PaymentFulfillmentRepository(transaction)
      await fulfillment.ensureReservationBeforePayment(input.orderId)
      const payments = new PaymentRepository(transaction)
      const supersededOnlinePayments = await payments.closeUnpresentedOnlinePaymentsForManualCollection(
        input.orderId,
        employeeId,
      )
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
      const occurredAt=payment.succeededAt
      if (occurredAt===null) throw new Error('Manual payment did not return an authoritative settlement time')
      await new ReconciliationRepository(transaction).append({
        paymentId: payment.id,
        entryType: 'payment',
        provider: payment.provider,
        providerReference: reference,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        businessDate: input.businessDate,
        occurredAt,
        evidenceSnapshot: evidence,
      })
      if (payment.orderId === null) throw new Error('Manual payment lost its order target')
      const orderPaymentStatus = await payments.syncOrderPaymentStatus(payment.orderId)
      if (orderPaymentStatus === 'paid') {
        await new RecommendationFinancialAttributionRepository(transaction).recordPaidForOrder({
          paymentId: payment.id,
          orderId: payment.orderId,
          actorRef: `payment:${payment.id}`,
        })
        await new LoyaltyAccrualRepository(transaction).recordPaidOrder({
          paymentId: payment.id,
          orderId: payment.orderId,
          occurredAt,
        })
      }
      const activation = await fulfillment.activatePaidOrder(payment.orderId, {
        createdByEmployeeId: employeeId,
        metadata: { paymentId: payment.id, paymentProvider: payment.provider },
        paymentId: payment.id,
      })
      const outcome = await paymentOutcome(
        transaction,
        input,
        payment,
        'payment.manual_recorded',
        1,
        undefined,
        activation,
        this.options.printTicketSources === true,
      )
      if (supersededOnlinePayments.length === 0) return outcome
      return {
        ...outcome,
        auditEvents: [
          ...supersededOnlinePayments.map((superseded) => ({
            actor: input.actor,
            action: 'payment.unpresented_closed_for_manual',
            objectType: 'payment',
            objectId: superseded.id,
            businessDate: input.businessDate,
            afterData: {
              publicId: superseded.publicId,
              provider: superseded.provider,
              status: 'closed',
              replacementPaymentId: payment.id,
            },
            reason: '尚未向支付渠道发起，改为现场收款',
          })),
          ...outcome.auditEvents,
        ],
        outboxMessages: [
          ...supersededOnlinePayments.map((superseded) => ({
            aggregateType: 'payment',
            aggregateId: superseded.id,
            aggregateVersion: 2,
            eventType: 'payment.unpresented_closed_for_manual.v1',
            payload: {
              id: superseded.id,
              publicId: superseded.publicId,
              provider: superseded.provider,
              status: 'closed',
              replacementPaymentId: payment.id,
            },
          })),
          ...outcome.outboxMessages,
        ],
      }
    })
  }

  recordManualActivity(input: Readonly<RecordManualActivityPaymentCommand>): Promise<CommandExecution<Payment>> {
    const employeeId = requireEmployee(input.actor, 'Manual activity payment recording')
    const evidence = sanitizeProviderSnapshot(input.evidence)
    if (evidence.collectedByEmployeeId !== employeeId) {
      throw new TypeError('Manual activity payment evidence collector must match the acting employee')
    }
    return this.commands.execute(command(input, 'payment.activity.manual-record', paymentCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: input.provider === 'cash'
          ? 'payment.manual.cash.record'
          : input.provider === 'physical_pos'
            ? 'payment.manual.pos.record'
            : 'payment.manual.external.record',
      })
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'community.activity.cashier',
      })
      const result = await new PaymentRepository(transaction).recordManualForActivityRegistration({
        registrationPublicId: input.registrationPublicId,
        publicId: input.publicId,
        provider: input.provider,
        method: input.method,
        evidence,
        collectedByEmployeeId: employeeId,
      })
      const occurredAt = result.payment.succeededAt
      if (occurredAt === null) throw new Error('Manual activity payment did not return an authoritative settlement time')
      const reference = evidence.receiptReference
      if (typeof reference !== 'string' || reference.trim().length === 0) {
        throw new TypeError('Manual activity payment receipt reference is required')
      }
      await new ReconciliationRepository(transaction).append({
        paymentId: result.payment.id,
        entryType: 'payment',
        provider: result.payment.provider,
        providerReference: reference.trim(),
        amountMinor: result.payment.amountMinor,
        currency: result.payment.currency,
        businessDate: input.businessDate,
        occurredAt,
        evidenceSnapshot: evidence,
      })
      const outcome = await paymentOutcome(
        transaction,
        input,
        result.payment,
        'payment.activity_manual_recorded',
        1,
        undefined,
        undefined,
        this.options.printTicketSources === true,
      )
      if (result.supersededOnlinePayments.length === 0) return outcome
      return {
        ...outcome,
        auditEvents: [
          ...result.supersededOnlinePayments.map((superseded) => ({
            actor: input.actor,
            action: 'payment.activity_unpresented_closed_for_manual',
            objectType: 'payment',
            objectId: superseded.id,
            businessDate: input.businessDate,
            afterData: {
              publicId: superseded.publicId,
              provider: superseded.provider,
              status: 'closed',
              registrationPublicId: input.registrationPublicId,
              replacementPaymentId: result.payment.id,
            },
            reason: '尚未向支付渠道发起，改为活动现场收款',
          })),
          ...outcome.auditEvents,
        ],
        outboxMessages: [
          ...result.supersededOnlinePayments.map((superseded) => ({
            aggregateType: 'payment',
            aggregateId: superseded.id,
            aggregateVersion: 2,
            eventType: 'payment.activity_unpresented_closed_for_manual.v1',
            payload: {
              id: superseded.id,
              publicId: superseded.publicId,
              provider: superseded.provider,
              status: 'closed',
              registrationPublicId: input.registrationPublicId,
              replacementPaymentId: result.payment.id,
            },
          })),
          ...outcome.outboxMessages,
        ],
      }
    })
  }

  authorizeRecollection(
    input: Readonly<AuthorizeRecollectionCommand>,
  ): Promise<CommandExecution<OrderRecollectionAuthorization>> {
    const employeeId = requireEmployee(input.actor, 'Refund recollection authorization')
    return this.commands.execute(command(input, 'payment.recollection.authorize', recollectionCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'payment.recollect.authorize',
      })
      const authorization = await new RecollectionAuthorizationRepository(transaction).authorize({
        orderId: input.orderId,
        employeeId,
        reason: input.reason,
      })
      return {
        result: authorization,
        auditEvents: [{
          actor: input.actor,
          action: 'payment.recollection_authorized',
          objectType: 'order_recollection_authorization',
          objectId: authorization.id,
          businessDate: input.businessDate,
          afterData: recollectionToJson(authorization),
          reason: authorization.reason,
        }],
        outboxMessages: [{
          aggregateType: 'order_recollection_authorization',
          aggregateId: authorization.id,
          aggregateVersion: 1,
          eventType: 'payment.recollection_authorized.v1',
          payload: recollectionToJson(authorization),
        }],
      }
    })
  }

  authorizeActivityRecollection(
    input: Readonly<AuthorizeActivityRecollectionCommand>,
  ): Promise<CommandExecution<ActivityRecollectionAuthorization>> {
    const employeeId = requireEmployee(input.actor, 'Activity refund recollection authorization')
    return this.commands.execute(command(input, 'payment.activity_recollection.authorize', activityRecollectionCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'payment.recollect.authorize',
      })
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'community.activity.cashier',
      })
      const authorization = await new ActivityRecollectionAuthorizationRepository(transaction).authorize({
        activityRegistrationPublicId: input.registrationPublicId,
        employeeId,
        reason: input.reason,
      })
      return {
        result: authorization,
        auditEvents: [{
          actor: input.actor,
          action: 'payment.activity_recollection_authorized',
          objectType: 'activity_registration_recollection_authorization',
          objectId: authorization.id,
          businessDate: input.businessDate,
          afterData: activityRecollectionToJson(authorization),
          reason: authorization.reason,
        }],
        outboxMessages: [{
          aggregateType: 'activity_registration_recollection_authorization',
          aggregateId: authorization.id,
          aggregateVersion: 1,
          eventType: 'payment.activity_recollection_authorized.v1',
          payload: activityRecollectionToJson(authorization),
        }],
      }
    })
  }

  recordSucceededCallback(input: Readonly<PaymentCallbackCommand>): Promise<CommandExecution<Payment>> {
    const providerSnapshot = sanitizeProviderSnapshot(input.providerSnapshot)
    const integrationRef = requireIntegrationRef(input.actor, 'Payment callback')
    return this.commands.execute(command(input, 'payment.callback', paymentCodec), async (transaction) => {
      await this.providerObservations.consume({
        transaction,
        observationId: input.verifiedObservationId,
        operation: 'payment.callback',
        idempotencyKey: input.idempotencyKey,
        integrationRef,
        provider: input.provider,
        subjectPublicId: input.paymentPublicId,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        observedStatus: 'payment_succeeded',
        settlementChannel: input.settlementChannel,
      })
      const payments = new PaymentRepository(transaction)
      const application = await payments.applySucceededCallback({
        paymentPublicId: input.paymentPublicId,
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        settlementChannel: input.settlementChannel,
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
      let activation: PaymentFulfillmentActivation | undefined
      if (payment.orderId === null) {
        await payments.syncActivityRegistrationPaymentStatus(payment)
      } else {
        const orderPaymentStatus = await payments.syncOrderPaymentStatus(payment.orderId)
        if (orderPaymentStatus === 'paid') {
          await new RecommendationFinancialAttributionRepository(transaction).recordPaidForOrder({
            paymentId: payment.id,
            orderId: payment.orderId,
            actorRef: `payment:${payment.id}`,
          })
          await new LoyaltyAccrualRepository(transaction).recordPaidOrder({
            paymentId: payment.id,
            orderId: payment.orderId,
            occurredAt: input.occurredAt,
          })
        }
        activation = await new PaymentFulfillmentRepository(transaction).activatePaidOrder(payment.orderId, {
          metadata: { paymentId: payment.id, paymentProvider: payment.provider },
          paymentId: payment.id,
        })
      }
      return await paymentOutcome(
        transaction,
        input,
        payment,
        'payment.succeeded',
        2,
        paymentBusinessEventKey(
          'succeeded',
          payment.provider,
          input.providerTransactionId,
        ),
        activation,
        this.options.printTicketSources === true,
      )
    })
  }

  recordProviderQueryResult(
    input: Readonly<PaymentProviderQueryResultCommand>,
  ): Promise<CommandExecution<Payment>> {
    const providerSnapshot = sanitizeProviderSnapshot(input.providerSnapshot)
    const integrationRef = requireIntegrationRef(input.actor, 'Payment provider query')
    return this.commands.execute(command(input, 'payment.provider-query', paymentCodec), async (transaction) => {
      await this.providerObservations.consume({
        transaction,
        observationId: input.verifiedObservationId,
        operation: 'payment.provider-query',
        idempotencyKey: input.idempotencyKey,
        integrationRef,
        provider: input.provider,
        subjectPublicId: input.paymentPublicId,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        observedStatus: input.status === 'succeeded'
          ? 'payment_succeeded'
          : input.status === 'failed'
            ? 'payment_failed'
            : input.status === 'closed'
              ? 'payment_closed'
              : 'payment_pending',
        settlementChannel: input.settlementChannel,
      })
      const payments = new PaymentRepository(transaction)
      const application = await payments.applyProviderQueryResult({
        paymentPublicId: input.paymentPublicId,
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        settlementChannel: input.settlementChannel,
        providerSnapshot,
        succeededAt: input.occurredAt,
        status: input.status,
      })
      const payment = application.payment
      if (!application.applied) return noOpOutcome(payment)
      if (input.status === 'succeeded') {
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
      }
      let fulfillmentResult: PaymentFulfillmentActivation | PaymentFulfillmentRelease | undefined
      if (payment.orderId === null) {
        await payments.syncActivityRegistrationPaymentStatus(payment)
      } else {
        const orderPaymentStatus = await payments.syncOrderPaymentStatus(payment.orderId)
        if (input.status === 'succeeded' && orderPaymentStatus === 'paid') {
          await new RecommendationFinancialAttributionRepository(transaction).recordPaidForOrder({
            paymentId: payment.id,
            orderId: payment.orderId,
            actorRef: `payment:${payment.id}`,
          })
          await new LoyaltyAccrualRepository(transaction).recordPaidOrder({
            paymentId: payment.id,
            orderId: payment.orderId,
            occurredAt: input.occurredAt,
          })
        }
        const fulfillment = new PaymentFulfillmentRepository(transaction)
        fulfillmentResult = input.status === 'succeeded'
          ? await fulfillment.activatePaidOrder(payment.orderId, {
              metadata: { paymentId: payment.id, paymentProvider: payment.provider },
              paymentId: payment.id,
            })
          : input.status === 'failed' || input.status === 'closed'
            ? await fulfillment.releaseAfterDefinitiveFailure(
                payment.orderId,
                `verified provider result: ${input.status}`,
              )
            : undefined
      }
      const action = input.status === 'succeeded'
        ? 'payment.succeeded'
        : input.status === 'failed' || input.status === 'closed'
          ? 'payment.provider_failed'
          : 'payment.provider_pending'
      return await paymentOutcome(
        transaction,
        input,
        payment,
        action,
        input.status === 'succeeded' ? 2 : 1,
        input.status === 'succeeded'
          ? paymentBusinessEventKey('succeeded', payment.provider, input.providerTransactionId)
          : undefined,
        fulfillmentResult,
        this.options.printTicketSources === true,
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
      await this.authorization.assertRefundRequestLimit({
        transaction,
        employeeId,
        refundId: refund.id,
      })
      return refundOutcome(input, refund, 'refund.requested', 1)
    })
  }

  requestActivityRefund(input: Readonly<RequestActivityRefundCommand>): Promise<CommandExecution<Refund>> {
    const employeeId = requireEmployee(input.actor, 'Activity refund request')
    const requestEvidence = sanitizeClientRefundEvidence(input.requestEvidence)
    return this.commands.execute(command(input, 'refund.activity-request', refundCodec), async (transaction) => {
      await this.authorization.assertEmployeeCapability({
        transaction,
        employeeId,
        capability: 'refund.request',
      })
      const refund = await new RefundRepository(transaction).requestActivity({
        paymentId: input.paymentId,
        publicId: input.publicId,
        reason: input.reason,
        requestedByEmployeeId: employeeId,
        requestEvidence,
      })
      await this.authorization.assertRefundRequestLimit({
        transaction,
        employeeId,
        refundId: refund.id,
      })
      return refundOutcome(input, refund, 'refund.activity_requested', 1)
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
    const integrationRef = requireIntegrationRef(input.actor, 'Refund provider result')
    return this.commands.execute(command(input, 'refund.result', refundCodec), async (transaction) => {
      await this.providerObservations.consume({
        transaction,
        observationId: input.verifiedObservationId,
        operation: 'refund.result',
        idempotencyKey: input.idempotencyKey,
        integrationRef,
        provider: input.provider,
        subjectPublicId: input.refundPublicId,
        providerTransactionId: input.providerRefundId,
        originalProviderTransactionId: input.originalProviderTransactionId,
        reportedAmountMinor: input.reportedAmountMinor,
        reportedCurrency: input.reportedCurrency,
        observedStatus: input.succeeded ? 'refund_succeeded' : 'refund_failed',
      })
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
        const payments = new PaymentRepository(transaction)
        if (refund.orderId === null) await payments.syncActivityRegistrationRefundStatus(refund.paymentId)
        else {
          await new RecommendationFinancialAttributionRepository(transaction).recordRefundedForOrder({
            refundId: refund.id,
            paymentId: refund.paymentId,
            orderId: refund.orderId,
            actorRef: `refund:${refund.id}`,
          })
          await new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
            refundId: refund.id,
            paymentId: refund.paymentId,
            orderId: refund.orderId,
            occurredAt: input.occurredAt,
          })
          await payments.syncOrderPaymentStatus(refund.orderId)
          await new ExperiencePlanActivationRepository(transaction)
            .cancelAfterFullRefund(refund.orderId,refund.paymentId)
        }
      }
      return refundOutcome(
        input,
        refund,
        refund.status === 'succeeded' ? 'refund.succeeded' : 'refund.failed',
        4,
        undefined,
        transaction,
        this.options.printTicketSources === true,
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
        // `completeManualExecution` writes refunds.completed_at with
        // clock_timestamp(). Never accept an employee/device completion time
        // for a financial fact or a business-day reconciliation entry.
        const occurredAt = refund.completedAt
        if (occurredAt === null) throw new Error('Manual refund lacks an authoritative completion time')
        await new ReconciliationRepository(transaction).append({
          paymentId: refund.paymentId,
          refundId: refund.id,
          entryType: 'refund',
          provider: refund.paymentProvider,
          providerReference: refund.providerRefundId!,
          amountMinor: -refund.amountMinor,
          currency: refund.currency,
          businessDate: input.businessDate,
          occurredAt,
          evidenceSnapshot: providerSnapshot,
        })
        await refunds.syncPaymentRefundStatus(refund.paymentId)
        const payments = new PaymentRepository(transaction)
        if (refund.orderId === null) await payments.syncActivityRegistrationRefundStatus(refund.paymentId)
        else {
          await new RecommendationFinancialAttributionRepository(transaction).recordRefundedForOrder({
            refundId: refund.id,
            paymentId: refund.paymentId,
            orderId: refund.orderId,
            actorRef: `refund:${refund.id}`,
          })
          await new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
            refundId: refund.id,
            paymentId: refund.paymentId,
            orderId: refund.orderId,
            occurredAt,
          })
          await payments.syncOrderPaymentStatus(refund.orderId)
          await new ExperiencePlanActivationRepository(transaction)
            .cancelAfterFullRefund(refund.orderId,refund.paymentId)
        }
      }
      return refundOutcome(
        input,
        refund,
        refund.status === 'succeeded' ? 'refund.manual_succeeded' : 'refund.manual_failed',
        4,
        undefined,
        transaction,
        this.options.printTicketSources === true,
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

async function paymentOutcome(
  transaction: import('./transaction-runner.js').ScopedTransaction,
  input: Readonly<CommandMetadata>,
  payment: Payment,
  action: string,
  version: number,
  businessEventKey?: string,
  fulfillment?: PaymentFulfillmentActivation | PaymentFulfillmentRelease,
  printTicketSources = false,
): Promise<CommandOutcome<Payment>> {
  const snapshot = paymentToJson(payment)
  const fulfillmentChanged = fulfillment !== undefined && (
    ('activated' in fulfillment && fulfillment.activated)
    || ('released' in fulfillment && fulfillment.released)
  )
  const fulfillmentEvent = !fulfillmentChanged
    ? null
    : 'activated' in fulfillment
      ? {
          action: 'order.fulfillment_activated_after_payment',
          eventType: 'order.fulfillment_activated_after_payment.v1',
          payload: {
            orderId: fulfillment.orderId,
            inventoryMovementCount: fulfillment.inventoryConsumptions.length,
            kdsTaskCount: fulfillment.kdsTasks.length,
          } as JsonObject,
        }
      : {
          action: 'order.fulfillment_reservation_released',
          eventType: 'order.fulfillment_reservation_released.v1',
          payload: {
            orderId: fulfillment.orderId,
            reservationCount: fulfillment.reservationCount,
          } as JsonObject,
        }
  const paymentOutbox: OutboxMessage = {
    businessEventKey,
    aggregateType: 'payment',
    aggregateId: payment.id,
    aggregateVersion: version,
    eventType: `${action}.v1`,
    payload: snapshot,
  }
  const producesCashierTicket = printTicketSources && (
    (action === 'payment.initiated' && payment.orderId !== null) || payment.status === 'succeeded'
  )
  if (producesCashierTicket) {
    const sourceOutboxMessageId = await appendOutboxMessage(transaction, paymentOutbox)
    const sources = new PrintTicketSourceRepository(transaction)
    if (action === 'payment.initiated') {
      await sources.materializeCashierSettlement(sourceOutboxMessageId, payment.id)
    } else if (payment.orderId !== null) {
      await sources.materializeCashierPayment(sourceOutboxMessageId, payment.id)
    } else {
      await sources.materializeActivityCashierPayment(sourceOutboxMessageId, payment.id)
    }
  }
  const fulfillmentOutbox: OutboxMessage | null = fulfillmentEvent === null ? null : {
    businessEventKey: `fulfillment:${fulfillmentEvent.action}:${fulfillment!.orderId}`,
    aggregateType: 'order',
    aggregateId: fulfillment!.orderId,
    aggregateVersion: 2,
    eventType: fulfillmentEvent.eventType,
    payload: fulfillmentEvent.payload,
  }
  const producesProductionTicket = printTicketSources && fulfillmentOutbox !== null && 'activated' in fulfillment! && fulfillment!.activated
  if (producesProductionTicket && fulfillmentOutbox !== null) {
    const sourceOutboxMessageId = await appendOutboxMessage(transaction, fulfillmentOutbox)
    await new PrintTicketSourceRepository(transaction).materializeOrderProduction(sourceOutboxMessageId, fulfillment!.orderId)
  }
  return {
    result: payment,
    auditEvents: [{
      actor: input.actor,
      action,
      objectType: 'payment',
      objectId: payment.id,
      businessDate: input.businessDate,
      afterData: snapshot,
    }, ...(fulfillmentEvent === null ? [] : [{
      actor: input.actor,
      action: fulfillmentEvent.action,
      objectType: 'order',
      objectId: fulfillment!.orderId,
      businessDate: input.businessDate,
      afterData: fulfillmentEvent.payload,
    }])],
    outboxMessages: [
      ...(producesCashierTicket ? [] : [paymentOutbox]),
      ...(fulfillmentOutbox === null || producesProductionTicket ? [] : [fulfillmentOutbox]),
    ],
  }
}

async function refundOutcome(
  input: Readonly<CommandMetadata>,
  refund: Refund,
  action: string,
  version: number,
  auditReason?: string,
  transaction?: import('./transaction-runner.js').ScopedTransaction,
  printTicketSources = false,
): Promise<CommandOutcome<Refund>> {
  const snapshot = refundToJson(refund)
  const refundOutbox: OutboxMessage = {
    aggregateType: 'refund',
    aggregateId: refund.id,
    aggregateVersion: version,
    eventType: `${action}.v1`,
    payload: snapshot,
  }
  const producesRefundTicket = printTicketSources && transaction !== undefined
    && refund.status === 'succeeded'
  if (producesRefundTicket) {
    const sourceOutboxMessageId = await appendOutboxMessage(transaction!, refundOutbox)
    const sources = new PrintTicketSourceRepository(transaction!)
    if (refund.orderId !== null) await sources.materializeCashierRefund(sourceOutboxMessageId, refund.id)
    else await sources.materializeActivityCashierRefund(sourceOutboxMessageId, refund.id)
  }
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
    outboxMessages: producesRefundTicket ? [] : [refundOutbox],
  }
}

const paymentCodec: JsonCodec<Payment> = {
  encode: paymentToJson,
  decode: (value) => decodeObject<Payment>(value, ['id', 'payableKind', 'publicId', 'provider', 'status']),
}

const refundCodec: JsonCodec<Refund> = {
  encode: refundToJson,
  decode: (value) => decodeObject<Refund>(value, ['id', 'paymentId', 'publicId', 'status']),
}

const recollectionCodec: JsonCodec<OrderRecollectionAuthorization> = {
  encode: recollectionToJson,
  decode: (value) => decodeObject<OrderRecollectionAuthorization>(value, ['id', 'publicId', 'orderId']),
}

const activityRecollectionCodec: JsonCodec<ActivityRecollectionAuthorization> = {
  encode: activityRecollectionToJson,
  decode: (value) => decodeObject<ActivityRecollectionAuthorization>(
    value,
    ['id', 'publicId', 'activityRegistrationId', 'sourceRefundId'],
  ),
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

function activityRecollectionToJson(value: ActivityRecollectionAuthorization): JsonObject {
  return {
    id: value.id,
    publicId: value.publicId,
    activityRegistrationId: value.activityRegistrationId,
    sourceRefundId: value.sourceRefundId,
    amountMinor: value.amountMinor,
    currency: value.currency,
    reason: value.reason,
    authorizedByEmployeeId: value.authorizedByEmployeeId,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
  }
}

function recollectionToJson(authorization: OrderRecollectionAuthorization): JsonObject {
  return {
    id: authorization.id,
    publicId: authorization.publicId,
    orderId: authorization.orderId,
    amountMinor: authorization.amountMinor,
    currency: authorization.currency,
    reason: authorization.reason,
    authorizedByEmployeeId: authorization.authorizedByEmployeeId,
    expiresAt: authorization.expiresAt,
    createdAt: authorization.createdAt,
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

function requireIntegrationRef(actor: AuditActor, action: string): string {
  if (
    actor.type !== 'integration'
    || actor.ref === undefined
    || actor.ref.trim().length === 0
  ) {
    throw new TypeError(`${action} requires an identified integration and verified observation`)
  }
  return actor.ref
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
