import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import { requestBenefitGrant } from './benefit-domain.js'
import { registerAuthContext } from './auth-context.js'
import {
  BenefitRedemptionBusinessError,
  cancelBenefitRedemption,
  confirmBenefitRedemption,
  lockBenefitRedemption,
  registerBenefitRedemptionRoutes,
} from './benefit-redemption.js'
import { createSeedState } from './seed.js'
import { receiveInventory } from './inventory-domain.js'
import { JsonRepository } from './repository.js'

const issuedAt = new Date('2026-07-14T10:00:00.000Z')
const lockedAt = '2026-07-14T10:10:00.000Z'
const confirmedAt = '2026-07-14T10:12:00.000Z'

function stateWithBenefit(templateId = 'benefit-beer', quantity = 1) {
  const state = createSeedState()
  state.benefitRedemptions = []
  state.orderDomain.authorizationAuthorities = state.orderDomain.authorizationAuthorities.map((authority) => ({
    ...authority,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-31T23:59:59.999Z',
  }))
  const request = requestBenefitGrant(state, {
    actorId: 'emp-chen',
    memberId: 'member-amy',
    templateId,
    quantity,
    reason: '核销领域测试发放',
    channel: 'none',
    idempotencyKey: `redemption-grant-${templateId}-${quantity}`,
  }, issuedAt)
  const benefit = state.memberBenefits.find((item) => item.id === request.benefitId)
  if (!benefit) throw new Error('测试权益发放失败')
  return { state, benefit }
}

function lock(state: RuntimeState, benefitId: string, overrides: Partial<Parameters<typeof lockBenefitRedemption>[1]> = {}) {
  return lockBenefitRedemption(state, {
    actorId: 'emp-lin',
    benefitId,
    tableId: 'table-l01',
    quantity: 1,
    occurredAt: lockedAt,
    idempotencyKey: 'redemption-lock-0001',
    ...overrides,
  })
}

function confirm(state: RuntimeState, redemptionId: string, overrides: Partial<Parameters<typeof confirmBenefitRedemption>[2]> = {}) {
  return confirmBenefitRedemption(state, redemptionId, {
    actorId: 'emp-lin',
    authorizedBy: 'emp-chen',
    occurredAt: confirmedAt,
    idempotencyKey: 'redemption-confirm-0001',
    ...overrides,
  })
}

function expectBusinessError(execute: () => unknown, code: string) {
  try {
    execute()
    throw new Error('预期业务错误但操作成功')
  } catch (error) {
    expect(error).toBeInstanceOf(BenefitRedemptionBusinessError)
    expect((error as BenefitRedemptionBusinessError).code).toBe(code)
  }
}

function manageProductInventory(state: RuntimeState, productId: string, quantity: number) {
  receiveInventory(state.inventoryDomain!, {
    movementId: `benefit-receipt-${productId}`,
    productId,
    unitCode: 'bottle',
    quantity,
    actorId: 'emp-chen',
    reason: '权益核销测试入库',
    businessDate: state.store.businessDate,
    occurredAt: issuedAt.toISOString(),
    idempotencyKey: `benefit-receipt-${productId}-0001`,
  })
}

describe('benefit redemption', () => {
  it('locks an available product benefit without consuming its quantity and replays idempotently', () => {
    const { state, benefit } = stateWithBenefit('benefit-beer', 2)
    const redemption = lock(state, benefit.id)
    const replay = lock(state, benefit.id, { occurredAt: '2026-07-14T10:11:00.000Z' })

    expect(replay).toBe(redemption)
    expect(state.benefitRedemptions).toHaveLength(1)
    expect(benefit.status).toBe('locked')
    expect(benefit.remainingQuantity).toBe(2)
    expect(redemption.tableSessionId).toBe('session:table-l01:2026-07-14')
    expect(state.auditEntries.at(-1)?.action).toBe('benefit.redemption_locked.v1')
  })

  it('rejects an idempotency key reused with a different lock payload', () => {
    const { state, benefit } = stateWithBenefit()
    lock(state, benefit.id)
    expectBusinessError(
      () => lock(state, benefit.id, { tableId: 'table-i01' }),
      'IDEMPOTENCY_CONFLICT',
    )
  })

  it('requires an open table and a responsible or management employee', () => {
    const { state, benefit } = stateWithBenefit()
    expectBusinessError(
      () => lock(state, benefit.id, { tableId: 'table-l04' }),
      'TABLE_NOT_OPEN',
    )
    expectBusinessError(
      () => lock(state, benefit.id, { actorId: 'emp-wu', idempotencyKey: 'redemption-lock-0002' }),
      'TABLE_OPERATION_FORBIDDEN',
    )
    expect(benefit.status).toBe('available')
  })

  it('creates an authorized zero-pay gift order and queues the original product in KDS', () => {
    const { state, benefit } = stateWithBenefit('benefit-beer', 2)
    manageProductInventory(state, 'product-beer', 3)
    const redemption = lock(state, benefit.id, { quantity: 2 })
    const confirmed = confirm(state, redemption.id)
    const order = state.orderDomain.orders.find((item) => item.id === confirmed.orderId)
    const line = order?.items[0]

    expect(confirmed.status).toBe('confirmed')
    expect(order?.status).toBe('submitted')
    expect(order?.tableSessionId).toBe(redemption.tableSessionId)
    expect(order?.amounts).toEqual({
      grossAmount: 13_600,
      discountAmount: 0,
      giftAmount: 13_600,
      payableAmount: 0,
    })
    expect(line).toMatchObject({
      skuId: 'product-beer',
      quantity: 2,
      unitListPriceAmount: 6_800,
      unitSalePriceAmount: 0,
      unitCostAmount: 1_800,
      fulfillmentStatus: 'queued',
    })
    expect(state.orderDomain.authorizations).toContainEqual(expect.objectContaining({
      id: confirmed.authorizationId,
      kind: 'gift',
      status: 'granted',
      decidedBy: 'emp-chen',
    }))
    expect(state.orderDomain.kdsTasks).toContainEqual(expect.objectContaining({
      orderId: confirmed.orderId,
      tableSessionId: redemption.tableSessionId,
      itemName: '精酿啤酒',
      quantity: 2,
      status: 'queued',
    }))
    expect(benefit.remainingQuantity).toBe(0)
    expect(benefit.status).toBe('redeemed')
    expect(state.inventoryDomain?.balances.find((balance) => balance.productId === 'product-beer')?.onHandQuantity).toBe(1)
    expect(state.inventoryDomain?.movements.filter((movement) => movement.type === 'gift')).toEqual([
      expect.objectContaining({
        productId: 'product-beer',
        quantity: 2,
        tableSessionId: redemption.tableSessionId,
        orderId: confirmed.orderId,
        orderItemId: confirmed.orderItemId,
        businessDate: state.store.businessDate,
      }),
    ])
    expect(state.auditEntries.at(-1)?.action).toBe('benefit.redemption_confirmed.v1')
  })

  it('replays confirmation without duplicating orders, authorizations, ledger entries or KDS tasks', () => {
    const { state, benefit } = stateWithBenefit()
    manageProductInventory(state, 'product-beer', 2)
    const redemption = lock(state, benefit.id)
    const first = confirm(state, redemption.id)
    const replay = confirm(state, redemption.id, { occurredAt: '2026-07-14T10:13:00.000Z' })

    expect(replay).toBe(first)
    expect(state.orderDomain.orders).toHaveLength(1)
    expect(state.orderDomain.authorizations).toHaveLength(1)
    expect(state.orderDomain.kdsTasks).toHaveLength(1)
    expect(state.orderDomain.tableLedgerEntries).toHaveLength(2)
    expect(benefit.remainingQuantity).toBe(0)
    expect(state.inventoryDomain?.movements.filter((movement) => movement.type === 'gift')).toHaveLength(1)
    expect(state.inventoryDomain?.balances.find((balance) => balance.productId === 'product-beer')?.onHandQuantity).toBe(1)
  })

  it('keeps the benefit locked and leaves no order when managed gift stock is insufficient', () => {
    const { state, benefit } = stateWithBenefit('benefit-beer', 2)
    manageProductInventory(state, 'product-beer', 1)
    const redemption = lock(state, benefit.id, { quantity: 2 })

    expectBusinessError(
      () => confirm(state, redemption.id),
      'BENEFIT_ORDER_CREATION_FAILED',
    )
    expect(redemption.status).toBe('locked')
    expect(benefit.status).toBe('locked')
    expect(benefit.remainingQuantity).toBe(2)
    expect(state.orderDomain.orders).toHaveLength(0)
    expect(state.orderDomain.authorizations).toHaveLength(0)
    expect(state.orderDomain.kdsTasks).toHaveLength(0)
    expect(state.orderDomain.tableLedgerEntries).toHaveLength(0)
    expect(state.inventoryDomain?.balances.find((balance) => balance.productId === 'product-beer')?.onHandQuantity).toBe(1)
    expect(state.inventoryDomain?.movements).toHaveLength(1)
  })

  it('keeps the lock and leaves no partial order when gift authorization fails', () => {
    const { state, benefit } = stateWithBenefit()
    const redemption = lock(state, benefit.id)

    expectBusinessError(
      () => confirm(state, redemption.id, { authorizedBy: 'emp-jie' }),
      'ORDER_GIFT_AUTHORIZATION_FAILED',
    )
    expect(redemption.status).toBe('locked')
    expect(benefit.status).toBe('locked')
    expect(benefit.remainingQuantity).toBe(1)
    expect(state.orderDomain.orders).toHaveLength(0)
    expect(state.orderDomain.authorizations).toHaveLength(0)
    expect(state.orderDomain.kdsTasks).toHaveLength(0)
    expect(state.orderDomain.tableLedgerEntries).toHaveLength(0)
  })

  it('rejects confirmation after the table has been closed and reopened', () => {
    const { state, benefit } = stateWithBenefit()
    const redemption = lock(state, benefit.id)
    const table = state.tables.find((item) => item.id === 'table-l01')!
    table.openedAt = '2026-07-14T10:11:00.000Z'

    expectBusinessError(
      () => confirm(state, redemption.id),
      'TABLE_SESSION_CHANGED',
    )
    expect(redemption.status).toBe('locked')
  })

  it('cancels and releases a lock without creating an order or consuming quantity', () => {
    const { state, benefit } = stateWithBenefit()
    const redemption = lock(state, benefit.id)
    state.tables.find((item) => item.id === 'table-l01')!.status = 'available'
    const cancelled = cancelBenefitRedemption(state, redemption.id, {
      actorId: 'emp-lin',
      reason: '客人暂不兑换',
      occurredAt: '2026-07-14T10:15:00.000Z',
      idempotencyKey: 'redemption-cancel-0001',
    })
    const replay = cancelBenefitRedemption(state, redemption.id, {
      actorId: 'emp-lin',
      reason: '客人暂不兑换',
      occurredAt: '2026-07-14T10:16:00.000Z',
      idempotencyKey: 'redemption-cancel-0001',
    })

    expect(replay).toBe(cancelled)
    expect(cancelled.status).toBe('cancelled')
    expect(benefit.status).toBe('available')
    expect(benefit.remainingQuantity).toBe(1)
    expect(state.orderDomain.orders).toHaveLength(0)
    expect(state.auditEntries.at(-1)?.action).toBe('benefit.redemption_cancelled.v1')
  })

  it('returns an explicit business error for amount coupons instead of mutating order or benefit state', () => {
    const { state, benefit } = stateWithBenefit('benefit-return-50')

    expectBusinessError(
      () => lock(state, benefit.id),
      'AMOUNT_COUPON_ORDER_INTEGRATION_UNAVAILABLE',
    )
    expect(benefit.status).toBe('available')
    expect(benefit.remainingQuantity).toBe(1)
    expect(state.benefitRedemptions).toHaveLength(0)
    expect(state.orderDomain.orders).toHaveLength(0)
  })
})

async function redemptionRouteFixture() {
  const repository = new JsonRepository(`/tmp/mbox-benefit-redemption-${crypto.randomUUID()}.json`)
  await repository.init()
  const benefitId = await repository.mutate((state) => {
    state.orderDomain.authorizationAuthorities = state.orderDomain.authorizationAuthorities.map((authority) => ({
      ...authority,
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-12-31T23:59:59.999Z',
    }))
    const request = requestBenefitGrant(state, {
      actorId: 'emp-chen',
      memberId: 'member-amy',
      templateId: 'benefit-beer',
      quantity: 1,
      reason: 'HTTP核销身份测试发放',
      channel: 'none',
      idempotencyKey: `redemption-http-grant-${crypto.randomUUID()}`,
    })
    receiveInventory(state.inventoryDomain!, {
      movementId: `redemption-http-stock-${crypto.randomUUID()}`,
      productId: 'product-beer',
      unitCode: 'bottle',
      quantity: 2,
      actorId: 'emp-chen',
      reason: 'HTTP核销测试入库',
      businessDate: state.store.businessDate,
      occurredAt: new Date().toISOString(),
      idempotencyKey: `redemption-http-stock-${crypto.randomUUID()}`,
    })
    return request.benefitId!
  })
  const app = Fastify()
  await registerAuthContext(app, { runtimeMode: 'test', readState: () => repository.read() })
  registerBenefitRedemptionRoutes(app, repository)
  return { app, repository, benefitId }
}

function redemptionActorHeaders(actorId: string) {
  return { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': 'mbox-lujiazui' }
}

describe('benefit redemption HTTP actor binding', () => {
  it('ignores claimed lock and authorization identities and requires the authenticated approver authority', async () => {
    const { app, repository, benefitId } = await redemptionRouteFixture()
    const locked = await app.inject({
      method: 'POST',
      url: '/api/benefits/redemptions/locks',
      headers: redemptionActorHeaders('emp-lin'),
      payload: {
        actorId: 'emp-chen',
        requestedBy: 'emp-chen',
        benefitId,
        tableId: 'table-l01',
        quantity: 1,
        idempotencyKey: 'redemption-http-lock-0001',
      },
    })
    expect(locked.statusCode).toBe(201)
    expect(locked.json().lockedBy).toBe('emp-lin')

    const denied = await app.inject({
      method: 'POST',
      url: `/api/benefits/redemptions/${locked.json().id}/confirm`,
      headers: redemptionActorHeaders('emp-jie'),
      payload: {
        actorId: 'emp-lin',
        decidedBy: 'emp-chen',
        authorizedBy: 'emp-chen',
        idempotencyKey: 'redemption-http-confirm-0001',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect((await repository.read()).benefitRedemptions[0]?.status).toBe('locked')

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/benefits/redemptions/${locked.json().id}/confirm`,
      headers: redemptionActorHeaders('emp-chen'),
      payload: {
        actorId: 'emp-lin',
        decidedBy: 'emp-lin',
        authorizedBy: 'emp-lin',
        idempotencyKey: 'redemption-http-confirm-0001',
      },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toMatchObject({ confirmedBy: 'emp-chen', authorizedBy: 'emp-chen' })

    await app.close()
    await repository.close()
  })

  it('does not let an unrelated employee cancel a lock by claiming the locker identity', async () => {
    const { app, repository, benefitId } = await redemptionRouteFixture()
    const locked = await app.inject({
      method: 'POST',
      url: '/api/benefits/redemptions/locks',
      headers: redemptionActorHeaders('emp-lin'),
      payload: {
        benefitId,
        tableId: 'table-l01',
        quantity: 1,
        idempotencyKey: 'redemption-http-lock-0002',
      },
    })
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/benefits/redemptions/${locked.json().id}/cancel`,
      headers: redemptionActorHeaders('emp-wu'),
      payload: {
        actorId: 'emp-lin',
        requestedBy: 'emp-lin',
        reason: '冒用锁定人取消',
        idempotencyKey: 'redemption-http-cancel-0001',
      },
    })
    expect(cancelled.statusCode).toBe(403)
    expect((await repository.read()).benefitRedemptions[0]?.status).toBe('locked')

    await app.close()
    await repository.close()
  })
})
