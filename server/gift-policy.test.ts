import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import { requireGiftPolicy } from './gift-policy.js'
import { createSeedState } from './seed.js'
import { tableOperationsConfig } from './table-sessions.js'

const BUSINESS_DATE = '2026-07-27'
const NOW = '2026-07-27T12:00:00.000Z'
const TABLE_SESSION = `session:table-l01:${BUSINESS_DATE}:gift-policy`

function stateForPolicy() {
  const state = createSeedState()
  state.store.businessDate = BUSINESS_DATE
  const shift = state.shiftAssignments.find((candidate) => candidate.employeeId === 'emp-lin')!
  Object.assign(shift, {
    businessDate: BUSINESS_DATE,
    startAt: '2026-07-27T10:00:00.000Z',
    endAt: '2026-07-27T18:00:00.000Z',
    status: 'active',
  })
  const authority = state.orderDomain.authorizationAuthorities.find((candidate) => candidate.actorId === 'emp-lin')!
  Object.assign(authority, {
    validFrom: '2026-07-27T10:00:00.000Z',
    validUntil: '2026-07-27T18:00:00.000Z',
    maxAmount: 20_000,
    allowedSkuIds: ['product-beer'],
    allowedCategoryIds: null,
    tableSessionIds: null,
    maxPerTableAmount: null,
    maxPerShiftAmount: null,
    maxPerBusinessDayAmount: null,
    maxPerMonthAmount: null,
    maxPerBusinessDayCount: null,
    maxQuantityPerOrder: null,
  })
  return { state, authority }
}

function addGrantedGift(
  state: RuntimeState,
  id: string,
  amount: number,
  occurredAt: string,
  tableSessionId = TABLE_SESSION,
) {
  state.orderDomain.orders.push({
    id: `order-${id}`,
    tableSessionId,
    status: 'submitted',
    items: [],
    amounts: { grossAmount: amount, discountAmount: 0, giftAmount: amount, payableAmount: 0 },
    revision: 1,
    createdBy: 'emp-lin',
    createdAt: occurredAt,
    submittedBy: 'emp-lin',
    submittedAt: occurredAt,
    fulfilledAt: null,
  })
  state.orderDomain.authorizations.push({
    id: `authorization-${id}`,
    orderId: `order-${id}`,
    orderRevision: 1,
    kind: 'gift',
    lineIds: [],
    requestedAmount: amount,
    status: 'granted',
    requestedBy: 'emp-lin',
    requestedAt: occurredAt,
    decidedBy: 'emp-lin',
    decidedAt: occurredAt,
    decisionReason: '测试赠送',
  })
}

function decide(
  state: RuntimeState,
  productId = 'product-beer',
  amount = 6_800,
  tableSessionId = TABLE_SESSION,
  quantity = 1,
) {
  return requireGiftPolicy(state, {
    actorId: 'emp-lin',
    tableSessionId,
    items: [{ productId, quantity }],
    amount,
    occurredAt: NOW,
  })
}

describe('unified gift policy', () => {
  it('allows only configured products or configured product categories', () => {
    const { state, authority } = stateForPolicy()
    expect(decide(state).authorityId).toBe(authority.id)
    expect(() => decide(state, 'product-cocktail', 8_800)).toThrow('未授权赠送的商品')

    authority.allowedSkuIds = []
    authority.allowedCategoryIds = ['drinks']
    expect(decide(state, 'product-cocktail', 8_800).authorityId).toBe(authority.id)
    expect(() => decide(state, 'product-fruit', 12_800)).toThrow('未授权赠送的商品')
  })

  it('enforces table scope and per-order quantity', () => {
    const { state, authority } = stateForPolicy()
    authority.tableSessionIds = [TABLE_SESSION]
    authority.maxQuantityPerOrder = 2
    expect(() => decide(state, 'product-beer', 13_600, 'another-session', 2)).toThrow('不适用于这桌')
    expect(() => decide(state, 'product-beer', 20_000, TABLE_SESSION, 3)).toThrow('单次赠送数量超限')
  })

  it('enforces the cumulative amount for one table', () => {
    const { state, authority } = stateForPolicy()
    authority.maxPerTableAmount = 10_000
    addGrantedGift(state, 'table-prior', 6_800, '2026-07-27T11:00:00.000Z')
    expect(() => decide(state)).toThrow('单桌累计赠送额度不足')
  })

  it('enforces shift and business-day amount independently', () => {
    const { state, authority } = stateForPolicy()
    addGrantedGift(state, 'shift-prior', 6_800, '2026-07-27T11:00:00.000Z', 'another-session')
    authority.maxPerShiftAmount = 10_000
    expect(() => decide(state)).toThrow('班次累计赠送额度不足')

    authority.maxPerShiftAmount = null
    authority.maxPerBusinessDayAmount = 10_000
    expect(() => decide(state)).toThrow('营业日累计赠送额度不足')
  })

  it('uses the 06:00 Beijing business-day boundary and enforces daily count', () => {
    const { state, authority } = stateForPolicy()
    authority.maxPerBusinessDayCount = 2
    addGrantedGift(state, 'before-boundary', 100, '2026-07-26T21:59:59.000Z', 'old-session')
    addGrantedGift(state, 'after-boundary-1', 100, '2026-07-26T22:00:00.000Z', 'day-session-1')
    expect(decide(state).usageBefore.businessDayCount).toBe(1)
    addGrantedGift(state, 'after-boundary-2', 100, '2026-07-27T11:30:00.000Z', 'day-session-2')
    expect(() => decide(state)).toThrow('营业日赠送次数已达上限')
  })

  it('uses the configured cutoff instead of a hardcoded Beijing 06:00 boundary', () => {
    const { state, authority } = stateForPolicy()
    state.tableOperationsConfig = { ...tableOperationsConfig(state), businessDayRolloverHour: 4 }
    authority.maxPerBusinessDayCount = 2
    addGrantedGift(state, 'before-custom-boundary', 100, '2026-07-26T19:59:59.000Z', 'old-session')
    addGrantedGift(state, 'after-custom-boundary', 100, '2026-07-26T20:00:00.000Z', 'current-session')
    expect(decide(state).usageBefore.businessDayCount).toBe(1)
  })

  it('enforces the monthly value without counting the prior month', () => {
    const { state, authority } = stateForPolicy()
    authority.maxPerMonthAmount = 10_000
    addGrantedGift(state, 'prior-month', 6_800, '2026-06-30T21:59:59.000Z', 'prior-month-session')
    expect(decide(state).usageBefore.monthAmount).toBe(0)
    addGrantedGift(state, 'current-month', 6_800, '2026-06-30T22:00:00.000Z', 'current-month-session')
    expect(() => decide(state)).toThrow('月度累计赠送额度不足')
  })
})
