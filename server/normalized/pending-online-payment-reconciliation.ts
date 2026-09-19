import { createHash, randomUUID } from 'node:crypto'
import type { AuditActor } from './command-executor.js'
import type { PaymentCommandService } from './payment-command-service.js'
import { OnlinePaymentUnknownError, type OnlinePaymentService } from './online-payment-service.js'
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
  attemptedPaymentIds: readonly string[]
  failedPaymentIds: readonly string[]
}

export async function reconcileStalePendingOnlinePayments(
  deps: Readonly<PendingOnlinePaymentReconciliationDeps>,
  context: Readonly<PendingOnlinePaymentReconciliationContext>,
  paymentIds: readonly string[],
  queryBindingPrefix: string,
): Promise<PendingOnlinePaymentReconciliationResult> {
  const reconciled: string[] = []
  const failedPaymentIds: string[] = []
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
      failedPaymentIds.push(paymentId)
      const application = error instanceof VerifiedPaymentApplicationError
      const cause = application ? error.cause : error
      console.error(JSON.stringify({
        event: 'payment_reconciliation_failed', paymentId,
        stage: application ? 'apply_verified_observation' : 'query_provider',
        observedStatus: application ? error.observedStatus : undefined,
        errorCode: safePaymentErrorCode(cause),
        errorLocation: safePaymentErrorLocation(cause),
        providerDiagnostic: cause instanceof OnlinePaymentUnknownError ? cause.diagnostic : undefined,
      }))
      await deps.onlinePayments.recordAutomaticPaymentQueryOutcome(
        context.scope,paymentId,'error',application ? error.observedStatus : undefined,false,
      ).catch(() => {})
      // A single stale payment must not block workbench/status reads for the rest.
    }
  }
  return { attempted: paymentIds.length, reconciled: reconciled.length, paymentIds: reconciled,
    attemptedPaymentIds: paymentIds, failedPaymentIds }
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
  // Preserve existing short identities, but hash the entire long identity rather
  // than truncating it. The provider observation and command share this binding.
  queryBindingId = boundedPaymentQueryBinding(queryBindingId)
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
    throw new VerifiedPaymentApplicationError(cause, queried.observation.status)
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
    idempotencyKey: queried.reusedVerifiedSuccess ? `verified-payment:${queried.verifiedObservationId}` : boundedPaymentQueryBinding(idempotencyKey),
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

export function boundedPaymentQueryBinding(identity: string): string {
  return identity.length <= 128 ? identity : `payment-query:${createHash('sha256').update(identity).digest('hex')}`
}

class VerifiedPaymentApplicationError extends Error {
  constructor(cause: unknown, readonly observedStatus: string) {
    super('Verified payment observation could not be applied', { cause })
    this.name = 'VerifiedPaymentApplicationError'
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
