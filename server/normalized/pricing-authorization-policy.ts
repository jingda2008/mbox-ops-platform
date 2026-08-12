import type { AuditActor } from './command-executor.js'
import type { OrderChannel, SubmitOrderLineInput } from './order-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export type PricingAuthorizationKind = 'discount' | 'gift'
export type PricingAuthorizationSourceType = 'employee' | 'activity' | 'benefit'

export interface PricingAuthorizationRequest {
  sourceType: PricingAuthorizationSourceType
  sourceId: string
}

export interface PricingAuthorityContext {
  scope: Readonly<StoreScope>
  actor: AuditActor
  tableSessionId: string
  channel: OrderChannel
  lines: readonly SubmitOrderLineInput[]
  request: Readonly<PricingAuthorizationRequest>
}

export interface PricingAuthorityDecision {
  authorized: boolean
  authorizationId: string
  kind: PricingAuthorizationKind
  sourceType: PricingAuthorizationSourceType
  sourceId: string
  amountMinor: number
  maximumAmountMinor: number
  currency: string
  authorizedByEmployeeId?: string | null
  capability?: string | null
  expiresAt?: string | null
}

export interface PricingAuthorityPort {
  authorize(
    transaction: ScopedTransaction,
    context: Readonly<PricingAuthorityContext>,
  ): Promise<Readonly<PricingAuthorityDecision>>
  consume(
    transaction: ScopedTransaction,
    authorization: Readonly<VerifiedPricingAuthorization>,
    orderId: string,
  ): Promise<void>
}

export interface VerifiedPricingAuthorization {
  readonly authorizationId: string
  readonly kind: PricingAuthorizationKind
  readonly sourceType: PricingAuthorizationSourceType
  readonly sourceId: string
  readonly amountMinor: number
  readonly maximumAmountMinor: number
  readonly currency: string
  readonly authorizedByEmployeeId: string | null
  readonly capability: string | null
}

export class PricingAuthorizationDeniedError extends Error {
  constructor(message = 'Pricing adjustment is not authorized') {
    super(message)
    this.name = 'PricingAuthorizationDeniedError'
  }
}

const verifiedAuthorizations = new WeakSet<object>()

export class PricingAuthorizationPolicy {
  constructor(private readonly authority: PricingAuthorityPort) {}

  async authorize(
    transaction: ScopedTransaction,
    context: Omit<PricingAuthorityContext, 'request'>,
    request: Readonly<PricingAuthorizationRequest> | undefined,
  ): Promise<Readonly<VerifiedPricingAuthorization> | undefined> {
    if (request === undefined) return undefined
    validateRequest(request)

    const decision = await this.authority.authorize(transaction, { ...context, request })
    if (!decision.authorized) throw new PricingAuthorizationDeniedError()
    validateDecision(decision)
    if (decision.sourceType !== request.sourceType
      || decision.sourceId !== request.sourceId) {
      throw new PricingAuthorizationDeniedError('Pricing authority returned a mismatched source')
    }
    if (decision.amountMinor > decision.maximumAmountMinor) {
      throw new PricingAuthorizationDeniedError('Pricing adjustment exceeds the authorized limit')
    }
    if (decision.expiresAt !== undefined && decision.expiresAt !== null) {
      const expiresAt = Date.parse(decision.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new PricingAuthorizationDeniedError('Pricing authorization has expired')
      }
    }
    if (decision.sourceType === 'employee') {
      if (context.actor.type !== 'employee'
        || decision.authorizedByEmployeeId !== context.actor.employeeId
        || decision.capability === undefined
        || decision.capability === null
        || decision.capability !== requiredEmployeeCapability(decision.kind)) {
        throw new PricingAuthorizationDeniedError('Employee pricing authority is incomplete')
      }
    }

    const verified = Object.freeze({
      authorizationId: decision.authorizationId,
      kind: decision.kind,
      sourceType: decision.sourceType,
      sourceId: decision.sourceId,
      amountMinor: decision.amountMinor,
      maximumAmountMinor: decision.maximumAmountMinor,
      currency: decision.currency,
      authorizedByEmployeeId: decision.authorizedByEmployeeId ?? null,
      capability: decision.capability ?? null,
    })
    verifiedAuthorizations.add(verified)
    return verified
  }

  async consume(
    transaction: ScopedTransaction,
    authorization: Readonly<VerifiedPricingAuthorization>,
    orderId: string,
  ): Promise<void> {
    assertVerifiedPricingAuthorization(authorization)
    requireUuid('orderId', orderId)
    await this.authority.consume(transaction, authorization, orderId)
  }
}

export function assertVerifiedPricingAuthorization(
  authorization: Readonly<VerifiedPricingAuthorization>,
): void {
  if (!verifiedAuthorizations.has(authorization)) {
    throw new PricingAuthorizationDeniedError('Pricing authorization source is not trusted')
  }
}

function validateRequest(request: Readonly<PricingAuthorizationRequest>): void {
  requireUuid('pricingAuthorization.sourceId', request.sourceId)
  const keys = Object.keys(request).toSorted()
  if (keys.length !== 2 || keys[0] !== 'sourceId' || keys[1] !== 'sourceType') {
    throw new PricingAuthorizationDeniedError(
      'Pricing authorization requests may only identify a server-side source',
    )
  }
}

function validateDecision(decision: Readonly<PricingAuthorityDecision>): void {
  requireUuid('pricing authority authorizationId', decision.authorizationId)
  requireUuid('pricing authority sourceId', decision.sourceId)
  requireMoney('pricing authority amountMinor', decision.amountMinor)
  requireMoney('pricing authority maximumAmountMinor', decision.maximumAmountMinor)
  if (!/^[A-Z]{3}$/.test(decision.currency)) {
    throw new TypeError('pricing authority currency must be a three-letter uppercase code')
  }
  if (decision.amountMinor < 1) {
    throw new TypeError('pricing authority amountMinor must be greater than zero')
  }
  if (decision.authorizedByEmployeeId) {
    requireUuid('pricing authority authorizedByEmployeeId', decision.authorizedByEmployeeId)
  }
}

function requiredEmployeeCapability(kind: PricingAuthorizationKind): string {
  return kind === 'gift' ? 'order.gift' : 'order.discount'
}

function requireMoney(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

function requireUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}
