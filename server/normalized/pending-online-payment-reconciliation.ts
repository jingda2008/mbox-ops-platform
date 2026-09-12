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
  'query' | 'querySystem' | 'listStalePendingPostarPaymentIds' | 'recordAutomaticPaymentQueryOutcome'
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
    } catch (error) {
      const application = error instanceof ConfirmedPaymentApplicationError
      console.error(JSON.stringify({
        event: 'payment_reconciliation_failed', paymentId,
        stage: application ? 'apply_verified_success' : 'query_provider',
        errorCode: safePaymentErrorCode(application ? error.cause : error),
        errorLocation: safePaymentErrorLocation(application ? error.cause : error),
      }))
      await deps.onlinePayments.recordAutomaticPaymentQueryOutcome(
        context.scope,paymentId,'error',application ? 'succeeded' : undefined,false,
      ).catch(() => {})
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
  try {
    await applyProviderQueryObservation(deps.commands, context, queried, queryBindingId)
  } catch (cause) {
    if (queried.observation.status === 'succeeded' && queried.verifiedObservationId !== null) {
      throw new ConfirmedPaymentApplicationError(cause)
    }
    throw cause
  }
  await deps.onlinePayments.recordAutomaticPaymentQueryOutcome(
    context.scope,paymentId,
    isTerminalStatus(queried.observation.status) ? 'terminal' : 'processing',
    queried.observation.status,
    false,
  )
  return queried.observation.status === 'succeeded'
}

export async function applyProviderQueryObservation(
  commands: PaymentCommandReconciliationPort,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  queried: Awaited<ReturnType<OnlinePaymentService['query']>>,
  idempotencyKey: string,
  integrationRef = 'postar-active-query',
): Promise<void> {
  if (queried.verifiedObservationId === null) return
  const observed = queried.observation
  const actor: AuditActor = { type: 'integration', ref: integrationRef }
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
    businessDate: queried.businessDate ?? context.businessDate,
    idempotencyKey: queried.reusedVerifiedSuccess ? `verified-payment:${queried.verifiedObservationId}` : idempotencyKey,
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

function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'closed'
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

class ConfirmedPaymentApplicationError extends Error {
  constructor(cause: unknown) {
    super('Verified payment success could not be applied', { cause })
    this.name = 'ConfirmedPaymentApplicationError'
  }
}

export function safePaymentErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'UNKNOWN'
}

export function safePaymentErrorLocation(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined
  // Log code locations only, never the exception message, SQL, provider body,
  // local home directory or request parameters embedded in an error.
  const frames = error.stack.split('\n').slice(1).flatMap((line) => (
    line.match(/\/server\/[A-Za-z0-9_./-]+\.(?:js|ts):[0-9]+:[0-9]+/g) ?? []
  )).slice(0, 3)
  return frames.length === 0 ? undefined : frames.join(' <- ')
}
