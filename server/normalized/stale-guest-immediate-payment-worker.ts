import { randomUUID } from 'node:crypto'
import type { PaymentCommandService } from './payment-command-service.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import {
  applyProviderQueryObservation,
  PENDING_PAYMENT_RECONCILE_BATCH_LIMIT,
  PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS,
  reconcileStalePendingOnlinePaymentsForStore,
  type PendingOnlinePaymentReconciliationContext,
} from './pending-online-payment-reconciliation.js'
import {
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
  OnlineRefundStatusUnknownError,
  type OnlinePaymentService,
} from './online-payment-service.js'
import { GuestImmediateCheckoutReconciliationService } from './guest-immediate-checkout-reconciliation-service.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

// A normal native WeChat sheet has time to finish, but an abandoned customer
// checkout must not keep a small bar's table or next checkout hostage.  We
// query/close after 90 seconds; if the provider itself stays unreachable for
// five minutes, we release operations and retain only a protected finance
// fact for any late capture/refund review.
export const STALE_GUEST_IMMEDIATE_PAYMENT_MIN_AGE_SECONDS = 90
export const STALE_GUEST_IMMEDIATE_PAYMENT_UNRESOLVED_ABANDON_AGE_SECONDS = 5 * 60
export const STALE_GUEST_IMMEDIATE_PAYMENT_BATCH_LIMIT = 20
export const STALE_GUEST_IMMEDIATE_PAYMENT_DEFERRED_RETRY_SECONDS = 5 * 60

type OnlinePaymentPort = Pick<
  OnlinePaymentService,
  'closeSystem' | 'listStaleGuestImmediateCheckoutPaymentCandidates'
> & Partial<Pick<OnlinePaymentService,
  'query' | 'querySystem' | 'listStalePendingPostarPaymentIds'
  | 'queryRefund' | 'listStaleProcessingPostarRefundIds'
  | 'recordAutomaticPaymentQueryOutcome' | 'recordAutomaticRefundQueryOutcome'
>>
type PaymentCommandPort = Pick<PaymentCommandService,
  'recordProviderQueryResult' | 'recordProviderRefundResult'
>

export interface StaleGuestImmediatePaymentWorkerDeps {
  onlinePayments: OnlinePaymentPort
  payments: PaymentCommandPort
  reconciliation: Pick<
    GuestImmediateCheckoutReconciliationService,
    'commitTerminal' | 'abandonUnresolved'
  >
}

export interface StaleGuestImmediatePaymentBatch {
  workerId: string
  claimed: number
  queriedPaymentIds: readonly string[]
  paidPaymentIds: readonly string[]
  terminalAbandonedPaymentIds: readonly string[]
  unresolvedAbandonedPaymentIds: readonly string[]
  deferredPaymentIds: readonly string[]
  failedPaymentIds: readonly string[]
  queriedRefundIds: readonly string[]
  terminalRefundIds: readonly string[]
  deferredRefundIds: readonly string[]
  failedRefundIds: readonly string[]
}

/**
 * Reconciles only customer QR + immediate JSAPI payments. It is deliberately
 * separate from generic reservation expiry: it always asks the provider first,
 * it never closes the table itself, and a late success after operational
 * abandonment remains a finance/refund case rather than renewed fulfilment.
 */
export class StaleGuestImmediatePaymentWorker {
  constructor(
    private readonly deps: Readonly<StaleGuestImmediatePaymentWorkerDeps>,
    private readonly transactions?: Pick<ScopedPostgresTransactionRunner, 'run'>,
  ) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    businessDate?: string,
    options: Readonly<{
      minAgeSeconds?: number
      unresolvedAbandonAgeSeconds?: number
      limit?: number
      now?: () => number
    }> = {},
  ): Promise<StaleGuestImmediatePaymentBatch> {
    assertWorkerId(workerId)
    const minAgeSeconds = options.minAgeSeconds ?? STALE_GUEST_IMMEDIATE_PAYMENT_MIN_AGE_SECONDS
    const unresolvedAbandonAgeSeconds = options.unresolvedAbandonAgeSeconds
      ?? STALE_GUEST_IMMEDIATE_PAYMENT_UNRESOLVED_ABANDON_AGE_SECONDS
    const limit = options.limit ?? STALE_GUEST_IMMEDIATE_PAYMENT_BATCH_LIMIT
    assertPositiveInt(minAgeSeconds, 'minAgeSeconds')
    assertPositiveInt(unresolvedAbandonAgeSeconds, 'unresolvedAbandonAgeSeconds')
    assertPositiveInt(limit, 'limit')
    if (unresolvedAbandonAgeSeconds < minAgeSeconds) {
      throw new TypeError('unresolvedAbandonAgeSeconds must not precede minAgeSeconds')
    }
    const now = options.now ?? Date.now
    const resolvedBusinessDate = businessDate ?? await this.readBusinessDate(scope)
    const candidates = await this.deps.onlinePayments.listStaleGuestImmediateCheckoutPaymentCandidates(
      scope, minAgeSeconds, limit,
    )
    const queriedPaymentIds: string[] = []
    const paidPaymentIds: string[] = []
    const terminalAbandonedPaymentIds: string[] = []
    const unresolvedAbandonedPaymentIds: string[] = []
    const deferredPaymentIds: string[] = []
    const failedPaymentIds: string[] = []
    const queriedRefundIds: string[] = []
    const terminalRefundIds: string[] = []
    const deferredRefundIds: string[] = []
    const failedRefundIds: string[] = []
    const context: PendingOnlinePaymentReconciliationContext = {
      scope,
      businessDate: resolvedBusinessDate,
      actor: { type: 'integration', ref: 'postar-stale-guest-checkout' },
    }

    // General staff-started Postar payments used to be reconciled as a side
    // effect of opening the workbench/status page. Keep provider I/O in this
    // bounded worker instead, so page refresh and table operation remain
    // independent from channel latency or outage.
    if (this.deps.onlinePayments.querySystem !== undefined
      && this.deps.onlinePayments.listStalePendingPostarPaymentIds !== undefined) {
      try {
        await reconcileStalePendingOnlinePaymentsForStore(
          {
            onlinePayments: this.deps.onlinePayments as Pick<OnlinePaymentService,
              'query' | 'querySystem' | 'listStalePendingPostarPaymentIds' | 'recordAutomaticPaymentQueryOutcome'>,
            commands: this.deps.payments,
          },
          context,
          `pending-payment-worker:${workerId}:${Math.floor(now() / 30_000)}`,
        )
      } catch {
        // A provider/list failure is financial follow-up only. Guest checkout
        // retirement below must still run and the physical table stays usable.
      }
    }

    // A refund submission response only proves that the provider accepted the
    // request. Query stale processing refunds in this bounded worker so a
    // signed terminal result is applied without an employee repeatedly opening
    // the cashier screen. Each refund is isolated from table operations and
    // from the remaining batch when the provider is unavailable.
    if (this.deps.onlinePayments.queryRefund !== undefined
      && this.deps.onlinePayments.listStaleProcessingPostarRefundIds !== undefined) {
      try {
        const refundIds = await this.deps.onlinePayments.listStaleProcessingPostarRefundIds(
          scope, PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS, PENDING_PAYMENT_RECONCILE_BATCH_LIMIT,
        )
        for (const refundId of refundIds) {
          const binding = `pending-refund:${refundId}:${randomUUID()}`
          try {
            const result = await this.deps.onlinePayments.queryRefund(scope, refundId, binding)
            queriedRefundIds.push(refundId)
            const observed = result.observation
            if (!['succeeded', 'failed'].includes(observed.status)
              || result.verifiedObservationId === null) {
              deferredRefundIds.push(refundId)
              await this.deps.onlinePayments.recordAutomaticRefundQueryOutcome?.(
                scope,refundId,'processing',observed.status,
              )
              continue
            }
            const actor = {
              type: 'integration' as const,
              ref: result.observationIntegrationRef ?? 'postar-refund-active-query',
            }
            await this.deps.payments.recordProviderRefundResult({
              scope,
              actor,
              businessDate: resolvedBusinessDate,
              idempotencyKey: binding,
              requestFingerprint: JSON.stringify({
                method: 'POST', path: '/internal/refunds/provider-query',
                tenantId: scope.tenantId, storeId: scope.storeId, actor,
                payload: {
                  merchantRefundId: result.merchantRefundId,
                  providerRefundTransactionId: observed.providerRefundTransactionId,
                  status: observed.status,
                  amountMinor: observed.amount,
                  currency: observed.currency,
                },
              }),
              refundPublicId: result.merchantRefundId,
              verifiedObservationId: result.verifiedObservationId,
              provider: 'postar',
              succeeded: observed.status === 'succeeded',
              providerRefundId: observed.providerRefundTransactionId ?? result.merchantRefundId,
              originalProviderTransactionId: result.originalProviderTransactionId,
              reportedAmountMinor: observed.amount,
              reportedCurrency: observed.currency,
              providerSnapshot: sanitizeProviderSnapshot({
                merchantRefundId: result.merchantRefundId,
                providerStatus: observed.status,
                providerReportedAmountMinor: observed.amount,
                occurredAt: observed.occurredAt,
                receivedAt: new Date().toISOString(),
                ...(observed.failureReason === undefined ? {} : { failureReason: observed.failureReason }),
              }),
              occurredAt: observed.occurredAt,
            })
            terminalRefundIds.push(refundId)
            await this.deps.onlinePayments.recordAutomaticRefundQueryOutcome?.(
              scope,refundId,'terminal',observed.status,
            )
          } catch (error) {
            if (error instanceof OnlineRefundStatusUnknownError
              || error instanceof OnlinePaymentUnavailableError) deferredRefundIds.push(refundId)
            else failedRefundIds.push(refundId)
            await this.deps.onlinePayments.recordAutomaticRefundQueryOutcome?.(
              scope,refundId,'error',
            )
          }
        }
      } catch {
        // A provider/list failure is financial follow-up only. Payment recovery
        // and table operations below must continue independently.
      }
    }

    for (const candidate of candidates) {
      const candidateNow = now()
      // This value is both the provider close binding and the normalized
      // command idempotency key, whose audited maximum is 128 characters.
      // The coordinator appends the full worker name to workerId, so including
      // it here made production bindings exceed that limit. Payment UUID plus
      // a fresh UUID remains unique while keeping the binding below the cap.
      const binding = `stale-guest-checkout:${candidate.id}:${randomUUID()}`
      try {
        const closed = await this.deps.onlinePayments.closeSystem({
          scope, paymentId: candidate.id, closeBindingId: binding,
        })
        queriedPaymentIds.push(candidate.id)
        const observation = closed.observation
        if (observation.status === 'closed' || observation.status === 'failed') {
          if (candidate.operationallyAbandoned) {
            // The order was already cancelled. Apply the verified financial
            // terminal fact only; never attempt to re-open or re-retire it.
            await applyProviderQueryObservation(
              this.deps.payments, context, closed, binding, 'postar-close-payment',
            )
          } else {
            if (closed.verifiedObservationId === null) {
              throw new OnlinePaymentUnknownError()
            }
            await this.deps.reconciliation.commitTerminal({
              scope,
              actor: { type: 'integration', ref: 'postar-close-payment' },
              businessDate: resolvedBusinessDate,
              idempotencyKey: `stale-guest-terminal:${candidate.id}:${observation.status}`,
              requestFingerprint: JSON.stringify({
                operation: 'stale_guest_immediate_payment_terminal', paymentId: candidate.id,
                paymentPublicId: closed.context.publicId, status: observation.status,
                providerTransactionId: observation.providerTransactionId,
              }),
              workerId,
              verifiedObservationId: closed.verifiedObservationId,
              paymentPublicId: closed.context.publicId,
              provider: 'postar',
              providerTransactionId: observation.providerTransactionId,
              reportedAmountMinor: observation.amount,
              reportedCurrency: observation.currency,
              settlementChannel: observation.settlementChannel,
              status: observation.status,
              providerSnapshot: {
                providerStatus: observation.status,
                observedAt: observation.occurredAt,
                reconciliationSource: 'stale_guest_immediate_payment_worker',
              },
              occurredAt: observation.occurredAt,
            })
            terminalAbandonedPaymentIds.push(candidate.id)
          }
          await this.recordAutomaticOutcome(scope,candidate.id,'terminal',observation.status,true)
          continue
        }
        await applyProviderQueryObservation(
          this.deps.payments, context, closed, binding, 'postar-close-payment',
        )
        if (observation.status === 'succeeded') {
          paidPaymentIds.push(candidate.id)
          await this.recordAutomaticOutcome(scope,candidate.id,'terminal',observation.status,true)
        } else {
          let operationallyReleased = candidate.operationallyAbandoned
          if (!operationallyReleased
            && candidateAgeSeconds(candidate.createdAt, candidateNow) >= unresolvedAbandonAgeSeconds) {
            try {
              await this.deps.reconciliation.abandonUnresolved({
                scope,
                actor: { type: 'integration', ref: 'postar-stale-guest-checkout' },
                businessDate: resolvedBusinessDate,
                idempotencyKey: `stale-guest-unresolved:${candidate.id}`,
                requestFingerprint: JSON.stringify({
                  operation: 'stale_guest_immediate_payment_processing_abandon', paymentId: candidate.id,
                }),
                paymentId: candidate.id,
                workerId,
              })
              unresolvedAbandonedPaymentIds.push(candidate.id)
              operationallyReleased = true
            } catch {
              failedPaymentIds.push(candidate.id)
            }
          }
          deferredPaymentIds.push(candidate.id)
          await this.recordAutomaticOutcome(
            scope,candidate.id,'processing',observation.status,operationallyReleased,
          )
        }
      } catch (error) {
        if (!candidate.operationallyAbandoned
          && isProviderOutcomeUnknown(error)
          && candidateAgeSeconds(candidate.createdAt, now()) >= unresolvedAbandonAgeSeconds) {
          try {
            await this.deps.reconciliation.abandonUnresolved({
              scope,
              actor: { type: 'integration', ref: 'postar-stale-guest-checkout' },
              businessDate: resolvedBusinessDate,
              idempotencyKey: `stale-guest-unresolved:${candidate.id}`,
              requestFingerprint: JSON.stringify({
                operation: 'stale_guest_immediate_payment_unresolved_abandon', paymentId: candidate.id,
              }),
              paymentId: candidate.id,
              workerId,
            })
            unresolvedAbandonedPaymentIds.push(candidate.id)
            await this.recordAutomaticOutcome(scope,candidate.id,'error',undefined,true)
          } catch {
            failedPaymentIds.push(candidate.id)
          }
        } else if (isProviderOutcomeUnknown(error)) {
          deferredPaymentIds.push(candidate.id)
          await this.recordAutomaticOutcome(
            scope,candidate.id,'error',undefined,candidate.operationallyAbandoned,
          )
        } else {
          failedPaymentIds.push(candidate.id)
          await this.recordAutomaticOutcome(
            scope,candidate.id,'error',undefined,candidate.operationallyAbandoned,
          )
        }
      }
    }
    return {
      workerId, claimed: candidates.length, queriedPaymentIds, paidPaymentIds,
      terminalAbandonedPaymentIds, unresolvedAbandonedPaymentIds, deferredPaymentIds, failedPaymentIds,
      queriedRefundIds, terminalRefundIds, deferredRefundIds, failedRefundIds,
    }
  }

  private async recordAutomaticOutcome(
    scope: Readonly<StoreScope>,
    paymentId: string,
    outcome: 'processing' | 'error' | 'terminal',
    observedStatus?: string,
    forceReleased = false,
  ): Promise<void> {
    await this.deps.onlinePayments.recordAutomaticPaymentQueryOutcome?.(
      scope,paymentId,outcome,observedStatus,forceReleased,
    )
  }

  private async readBusinessDate(scope: Readonly<StoreScope>): Promise<string> {
    if (this.transactions === undefined) throw new Error('stale guest payment worker needs a business date')
    return this.transactions.run(scope, async (transaction) => readBusinessDate(transaction))
  }
}

async function readBusinessDate(transaction: ScopedTransaction): Promise<string> {
  const result = await transaction.query<{ business_date: string }>(`
    SELECT (((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date)::text AS business_date
    FROM mbox.stores
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const businessDate = result.rows[0]?.business_date
  if (businessDate === undefined) throw new Error('stale guest payment worker store is unavailable')
  return businessDate
}

function candidateAgeSeconds(createdAt: string, nowMs: number): number {
  const createdAtMs = Date.parse(createdAt)
  return Number.isFinite(createdAtMs) ? Math.max(0, (nowMs - createdAtMs) / 1_000) : 0
}

function isProviderOutcomeUnknown(error: unknown): boolean {
  return error instanceof OnlinePaymentUnknownError || error instanceof OnlinePaymentUnavailableError
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(workerId)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 128 characters')
  }
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new TypeError(`${name} must be an integer between 1 and 86400`)
  }
}
