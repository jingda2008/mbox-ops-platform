import { randomUUID } from 'node:crypto'
import type { AuditActor } from './command-executor.js'
import type { PaymentCommandService } from './payment-command-service.js'
import type { OnlinePaymentService } from './online-payment-service.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { StoreScope } from './transaction-runner.js'

export const PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS = 15
export const PENDING_PAYMENT_RECONCILE_BATCH_LIMIT = 20

type OnlinePaymentReconciliationPort = Pick<
  OnlinePaymentService,
  'query' | 'querySystem' | 'listStalePendingPostarPaymentIds'
>

type PaymentCommandReconciliationPort = Pick<PaymentCommandService, 'recordProviderQueryResult'>

export interface PendingOnlinePaymentReconciliationDeps {
  onlinePayments: OnlinePaymentReconciliationPort
  commands: PaymentCommandReconciliationPort
}

export interface PendingOnlinePaymentReconciliationContext {
  scope: Readonly<StoreScope>
  businessDate: string
  actor: AuditActor
}

export interface PendingOnlinePaymentReconciliationResult {
  attempted: number
  reconciled: number
  paymentIds: readonly string[]
}

export async function reconcileStalePendingOnlinePayments(
  deps: Readonly<PendingOnlinePaymentReconciliationDeps>,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  paymentIds: readonly string[],
  queryBindingPrefix: string,
): Promise<PendingOnlinePaymentReconciliationResult> {
  const reconciled: string[] = []
  for (const paymentId of paymentIds) {
    try {
      const applied = await reconcileStalePendingOnlinePayment(
        deps,
        context,
        paymentId,
        `${queryBindingPrefix}:${paymentId}`,
      )
      if (applied) reconciled.push(paymentId)
    } catch {
      // A single stale payment must not block workbench/status reads for the rest.
    }
  }
  return { attempted: paymentIds.length, reconciled: reconciled.length, paymentIds: reconciled }
}

export async function reconcileStalePendingOnlinePaymentsForStore(
  deps: Readonly<PendingOnlinePaymentReconciliationDeps>,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  queryBindingPrefix: string,
  minAgeSeconds = PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS,
  limit = PENDING_PAYMENT_RECONCILE_BATCH_LIMIT,
): Promise<PendingOnlinePaymentReconciliationResult> {
  const paymentIds = await deps.onlinePayments.listStalePendingPostarPaymentIds(
    context.scope,
    minAgeSeconds,
    limit,
  )
  return reconcileStalePendingOnlinePayments(deps, context, paymentIds, queryBindingPrefix)
}

export async function reconcileStalePendingOnlinePayment(
  deps: Readonly<PendingOnlinePaymentReconciliationDeps>,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  paymentId: string,
  queryBindingId: string,
  principal?: Parameters<OnlinePaymentService['query']>[0]['principal'],
): Promise<boolean> {
  const queried = principal === undefined
    ? await deps.onlinePayments.querySystem({
      scope: context.scope,
      paymentId,
      queryBindingId,
    })
    : await deps.onlinePayments.query({
      scope: context.scope,
      paymentId,
      queryBindingId,
      principal,
    })
  await applyProviderQueryObservation(deps.commands, context, queried, queryBindingId)
  return queried.observation.status === 'succeeded'
}

export async function applyProviderQueryObservation(
  commands: PaymentCommandReconciliationPort,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  queried: Awaited<ReturnType<OnlinePaymentService['query']>>,
  idempotencyKey: string,
): Promise<void> {
  const observed = queried.observation
  const actor: AuditActor = { type: 'integration', ref: 'postar-active-query' }
  const providerSnapshot = sanitizeProviderSnapshot({
    providerStatus: observed.status,
    providerReportedAmountMinor: observed.providerReportedAmount ?? observed.amount,
    occurredAt: observed.occurredAt,
    receivedAt: new Date().toISOString(),
    ...(observed.settlementChannel === undefined ? {} : { channel: observed.settlementChannel }),
  })
  await commands.recordProviderQueryResult({
    scope: context.scope,
    actor,
    businessDate: context.businessDate,
    idempotencyKey,
    requestFingerprint: JSON.stringify({
      method: 'POST',
      path: '/internal/payments/provider-query',
      tenantId: context.scope.tenantId,
      storeId: context.scope.storeId,
      actor: { type: actor.type, ref: actor.ref },
      payload: {
        paymentPublicId: queried.context.publicId,
        provider: 'postar',
        providerTransactionId: observed.providerTransactionId,
        status: observed.status,
        amountMinor: observed.amount,
        currency: observed.currency,
        settlementChannel: observed.settlementChannel ?? null,
      },
    }),
    paymentPublicId: queried.context.publicId,
    verifiedObservationId: queried.verifiedObservationId,
    provider: 'postar',
    providerTransactionId: observed.providerTransactionId,
    reportedAmountMinor: observed.amount,
    reportedCurrency: observed.currency,
    settlementChannel: observed.settlementChannel,
    status: observed.status,
    providerSnapshot,
    occurredAt: observed.occurredAt,
  })
}

export function shouldReconcilePaymentContext(
  context: Readonly<{ provider: string; status: string; createdAt: string }>,
  minAgeSeconds = PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS,
): boolean {
  if (context.provider !== 'postar' || !['created', 'pending'].includes(context.status)) {
    return false
  }
  const createdAt = Date.parse(context.createdAt)
  if (!Number.isFinite(createdAt)) return false
  return Date.now() - createdAt >= minAgeSeconds * 1_000
}

export function reconciliationQueryBinding(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}
