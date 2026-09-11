import type { AuditActor } from './command-executor.js'
import type { OrderChannel, SubmitOrderLineInput } from './order-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import {verifyPricingLineAllocations,type PricingLineAllocation} from './pricing-line-allocation.js'

export type PricingAuthorizationKind = 'discount' | 'gift'
export type PricingAuthorizationSourceType = 'employee' | 'activity' | 'benefit' | 'checkout_quote'

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
  /** Internal fulfillment reference; never populated from an order HTTP body. */
  benefitFulfillmentReservationId?: string
  request: Readonly<PricingAuthorizationRequest>
}

export interface PricingAuthorityDecision {
  lineAllocations?:readonly PricingLineAllocation[]
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
  readonly lineAllocations?:readonly Readonly<PricingLineAllocation>[]
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
  get userMessage():string {return pricingDenialMessage(this.message)}
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
      ...(decision.lineAllocations===undefined?{}:{lineAllocations:verifyPricingLineAllocations(decision.lineAllocations,context.lines,decision.amountMinor)}),
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

function pricingDenialMessage(message:string):string{
 const reasons:Record<string,string>={
 'Pricing adjustment is not authorized':'本次价格调整未获授权，请联系有对应审批权限的负责人',
 'Pricing authority returned a mismatched source':'本次授权来源与申请不一致，请重新选择有效授权',
 'Pricing adjustment exceeds the authorized limit':'本次减免超过授权金额，请降低减免或申请更高额度',
 'Pricing authorization has expired':'本次授权已过期，请重新申请授权',
 'Employee pricing authority is incomplete':'本次授权人员或操作权限不匹配，请使用本人有效授权',
 'Employee pricing permission is not active':'当前员工赠送或折扣权限未生效，请联系权限管理员',
 'Employee pricing currency does not match the order':'授权币种与订单不一致，不能使用本次授权',
 'Role limit does not authorize this full gift':'本单全额赠送超过当前审批额度，请降低赠送金额或申请更高额度',
 'Table session is no longer open':'当前桌次已结束，请回到当前有效桌台操作',
 'Benefit is outside its validity period':'该权益不在有效期内，请选择当前可用权益',
 'Benefit currency does not match the order':'权益币种与订单币种不一致',
 'Reserved benefit could not be redeemed':'权益暂留未能核销，请刷新原暂留记录核对当前状态',
 'Pricing authorization source is not trusted':'该授权来源未通过验证，请重新从正式入口申请',
 'Employee pricing requires an employee actor':'员工赠送或折扣必须由已登录员工操作',
 'Employee pricing is limited to staff-assisted channels':'此员工授权仅适用于协助点单入口',
 'Calculated discount is outside the server approval limit':'计算后的折扣超过服务端批准上限，请重新申请',
 }
 return reasons[message]??(/^[^A-Za-z]*[\u4e00-\u9fff]/.test(message)?message:'本次价格授权校验未通过，未应用减免；请刷新原授权并联系审批负责人')
}
