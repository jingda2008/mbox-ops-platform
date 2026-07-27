import type { RuntimeState } from '../src/shared/contracts.js'
import type { OrderAuthorizationAuthority } from '../src/shared/order-contracts.js'

export interface GiftPolicyItem {
  productId: string
  quantity: number
}

export interface GiftPolicyUsage {
  tableAmount: number
  shiftAmount: number
  businessDayAmount: number
  monthAmount: number
  businessDayCount: number
}

export interface GiftPolicyDecision {
  authorityId: string
  usageBefore: GiftPolicyUsage
  usageAfter: GiftPolicyUsage
}

export class GiftPolicyError extends Error {
  readonly statusCode = 403
  readonly code = 'GIFT_POLICY_DENIED'

  constructor(message: string) {
    super(message)
    this.name = 'GiftPolicyError'
  }
}

interface GiftPolicyRequest {
  actorId: string
  tableSessionId: string
  items: GiftPolicyItem[]
  amount: number
  occurredAt: string
}

interface GiftUsageRecord {
  tableSessionId: string
  amount: number
  occurredAt: number
}

function chinaBusinessDayRange(businessDate: string) {
  const start = Date.parse(`${businessDate}T06:00:00+08:00`)
  return { start, end: start + 24 * 60 * 60_000 }
}

function chinaBusinessMonthRange(businessDate: string) {
  const year = Number(businessDate.slice(0, 4))
  const month = Number(businessDate.slice(5, 7))
  const start = Date.parse(`${businessDate.slice(0, 7)}-01T06:00:00+08:00`)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const end = Date.parse(`${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01T06:00:00+08:00`)
  return { start, end }
}

function usageRecords(state: RuntimeState, actorId: string): GiftUsageRecord[] {
  return state.orderDomain.authorizations.flatMap((authorization) => {
    if (
      authorization.kind !== 'gift'
      || authorization.status !== 'granted'
      || authorization.decidedBy !== actorId
      || !authorization.decidedAt
    ) return []
    const order = state.orderDomain.orders.find((candidate) => candidate.id === authorization.orderId)
    const occurredAt = Date.parse(authorization.decidedAt)
    if (!order || !Number.isFinite(occurredAt)) return []
    return [{
      tableSessionId: order.tableSessionId,
      amount: authorization.requestedAmount,
      occurredAt,
    }]
  })
}

function amountWithin(records: GiftUsageRecord[], start: number, end: number) {
  return records.reduce((total, record) => (
    record.occurredAt >= start && record.occurredAt < end ? total + record.amount : total
  ), 0)
}

function usageFor(
  state: RuntimeState,
  authority: OrderAuthorizationAuthority,
  request: GiftPolicyRequest,
): GiftPolicyUsage {
  const occurredAt = Date.parse(request.occurredAt)
  const records = usageRecords(state, request.actorId)
  const activeShift = state.shiftAssignments.find((shift) => (
    shift.employeeId === request.actorId
    && shift.businessDate === state.store.businessDate
    && shift.status === 'active'
    && occurredAt >= Date.parse(shift.startAt)
    && occurredAt <= Date.parse(shift.endAt)
  ))
  const shiftStart = activeShift ? Date.parse(activeShift.startAt) : Date.parse(authority.validFrom)
  const shiftEnd = activeShift ? Date.parse(activeShift.endAt) : Date.parse(authority.validUntil)
  const businessDay = chinaBusinessDayRange(state.store.businessDate)
  const month = chinaBusinessMonthRange(state.store.businessDate)
  return {
    tableAmount: records.reduce((total, record) => (
      record.tableSessionId === request.tableSessionId ? total + record.amount : total
    ), 0),
    shiftAmount: amountWithin(records, shiftStart, shiftEnd),
    businessDayAmount: amountWithin(records, businessDay.start, businessDay.end),
    monthAmount: amountWithin(records, month.start, month.end),
    businessDayCount: records.filter((record) => (
      record.occurredAt >= businessDay.start && record.occurredAt < businessDay.end
    )).length,
  }
}

function productScopeAllows(state: RuntimeState, authority: OrderAuthorizationAuthority, items: GiftPolicyItem[]) {
  const productScoped = authority.allowedSkuIds != null || authority.allowedCategoryIds != null
  if (!productScoped) return true
  return items.every((item) => {
    const product = state.products.find((candidate) => candidate.id === item.productId)
    if (!product) return false
    return Boolean(
      authority.allowedSkuIds?.includes(product.id)
      || authority.allowedCategoryIds?.includes(product.categoryId ?? 'featured'),
    )
  })
}

function limitFailure(
  label: string,
  current: number,
  requested: number,
  limit: number | null | undefined,
) {
  if (limit == null || current + requested <= limit) return null
  return `${label}不足：已使用${current}分，本次${requested}分，上限${limit}分`
}

function evaluateAuthority(
  state: RuntimeState,
  authority: OrderAuthorizationAuthority,
  request: GiftPolicyRequest,
): { decision?: GiftPolicyDecision; reason?: string } {
  const occurredAt = Date.parse(request.occurredAt)
  if (occurredAt < Date.parse(authority.validFrom) || occurredAt > Date.parse(authority.validUntil)) {
    return { reason: '赠送授权不在有效时间内' }
  }
  if (authority.maxAmount < request.amount) {
    return { reason: `单次赠送额度不足：本次${request.amount}分，上限${authority.maxAmount}分` }
  }
  if (authority.tableSessionIds !== null && !authority.tableSessionIds.includes(request.tableSessionId)) {
    return { reason: '当前赠送授权不适用于这桌' }
  }
  if (!productScopeAllows(state, authority, request.items)) {
    return { reason: '本次包含未授权赠送的商品' }
  }
  const quantity = request.items.reduce((total, item) => total + item.quantity, 0)
  if (authority.maxQuantityPerOrder != null && quantity > authority.maxQuantityPerOrder) {
    return { reason: `单次赠送数量超限：本次${quantity}件，上限${authority.maxQuantityPerOrder}件` }
  }

  const usageBefore = usageFor(state, authority, request)
  const failures = [
    limitFailure('单桌累计赠送额度', usageBefore.tableAmount, request.amount, authority.maxPerTableAmount),
    limitFailure('班次累计赠送额度', usageBefore.shiftAmount, request.amount, authority.maxPerShiftAmount),
    limitFailure('营业日累计赠送额度', usageBefore.businessDayAmount, request.amount, authority.maxPerBusinessDayAmount),
    limitFailure('月度累计赠送额度', usageBefore.monthAmount, request.amount, authority.maxPerMonthAmount),
  ].filter(Boolean)
  if (
    authority.maxPerBusinessDayCount != null
    && usageBefore.businessDayCount + 1 > authority.maxPerBusinessDayCount
  ) {
    failures.push(`营业日赠送次数已达上限${authority.maxPerBusinessDayCount}次`)
  }
  if (failures.length > 0) return { reason: failures[0]! }

  return {
    decision: {
      authorityId: authority.id,
      usageBefore,
      usageAfter: {
        tableAmount: usageBefore.tableAmount + request.amount,
        shiftAmount: usageBefore.shiftAmount + request.amount,
        businessDayAmount: usageBefore.businessDayAmount + request.amount,
        monthAmount: usageBefore.monthAmount + request.amount,
        businessDayCount: usageBefore.businessDayCount + 1,
      },
    },
  }
}

export function requireGiftPolicy(state: RuntimeState, request: GiftPolicyRequest): GiftPolicyDecision {
  if (!Number.isSafeInteger(request.amount) || request.amount < 0) {
    throw new GiftPolicyError('赠送金额不合法')
  }
  if (request.items.length === 0 || request.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
    throw new GiftPolicyError('赠送商品数量不合法')
  }
  if (!Number.isFinite(Date.parse(request.occurredAt))) throw new GiftPolicyError('赠送时间不合法')

  const authorities = state.orderDomain.authorizationAuthorities.filter((authority) => (
    authority.actorId === request.actorId && authority.kinds.includes('gift')
  ))
  if (authorities.length === 0) throw new GiftPolicyError('当前员工没有配置赠送授权')

  const reasons: string[] = []
  for (const authority of authorities) {
    const result = evaluateAuthority(state, authority, request)
    if (result.decision) return result.decision
    if (result.reason) reasons.push(result.reason)
  }
  throw new GiftPolicyError(reasons[0] ?? '当前员工没有可用于本次操作的赠送授权')
}
