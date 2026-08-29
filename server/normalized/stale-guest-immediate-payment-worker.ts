import { randomUUID } from 'node:crypto'
import type { PaymentCommandService } from './payment-command-service.js'
import {
  applyProviderQueryObservation,
  type PendingOnlinePaymentReconciliationContext,
} from './pending-online-payment-reconciliation.js'
import {
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
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

type OnlinePaymentPort = Pick<
  OnlinePaymentService,
  'closeSystem' | 'listStaleGuestImmediateCheckoutPaymentCandidates'
>
type PaymentCommandPort = Pick<PaymentCommandService, 'recordProviderQueryResult'>

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
    const context: PendingOnlinePaymentReconciliationContext = {
      scope,
      businessDate: resolvedBusinessDate,
      actor: { type: 'integration', ref: 'postar-stale-guest-checkout' },
    }

    for (const candidate of candidates) {
      const binding = `stale-guest-checkout:${workerId}:${candidate.id}:${randomUUID()}`
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
            await applyProviderQueryObservation(this.deps.payments, context, closed, binding)
          } else {
            await this.deps.reconciliation.commitTerminal({
              scope,
              actor: { type: 'integration', ref: 'postar-stale-guest-checkout' },
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
          continue
        }
        await applyProviderQueryObservation(this.deps.payments, context, closed, binding)
        if (observation.status === 'succeeded') paidPaymentIds.push(candidate.id)
        else deferredPaymentIds.push(candidate.id)
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
          } catch {
            failedPaymentIds.push(candidate.id)
          }
        } else if (isProviderOutcomeUnknown(error)) {
          deferredPaymentIds.push(candidate.id)
        } else {
          failedPaymentIds.push(candidate.id)
        }
      }
    }
    return {
      workerId, claimed: candidates.length, queriedPaymentIds, paidPaymentIds,
      terminalAbandonedPaymentIds, unresolvedAbandonedPaymentIds, deferredPaymentIds, failedPaymentIds,
    }
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
