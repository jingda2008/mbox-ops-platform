import { describe, expect, it } from 'vitest'
import type { OrderDomainState, OrderItemDraftInput } from '../src/shared/order-contracts.js'
import {
  addOrderItem,
  completeAndDeliverKdsTask,
  completeKdsTask,
  createOrderDomainState,
  createOrderDraft,
  decideKdsException,
  decideOrderAuthorization,
  deliverKdsTask,
  getTableAccountSummary,
  getTableBalance,
  pickUpKdsTask,
  reportKdsException,
  requestOrderAuthorization,
  startKdsTask,
  submitOrder,
} from './order-domain.js'

const T0 = '2026-07-14T10:00:00.000Z'
const T1 = '2026-07-14T10:01:00.000Z'
const T2 = '2026-07-14T10:02:00.000Z'
const T3 = '2026-07-14T10:03:00.000Z'
const T4 = '2026-07-14T10:04:00.000Z'
const T5 = '2026-07-14T10:05:00.000Z'
const T6 = '2026-07-14T10:06:00.000Z'
const T7 = '2026-07-14T10:07:00.000Z'
const T8 = '2026-07-14T10:08:00.000Z'
const T9 = '2026-07-14T10:09:00.000Z'
const T10 = '2026-07-14T10:10:00.000Z'
const T11 = '2026-07-14T10:11:00.000Z'

function draft(state: OrderDomainState, orderId = 'order-1', tableSessionId = 'table-session-1') {
  return createOrderDraft(state, {
    orderId,
    tableSessionId,
    createdBy: 'employee-server',
    occurredAt: T0,
    idempotencyKey: `create-${orderId}`,
  })
}

function authorizedState() {
  return createOrderDomainState([
    {
      id: 'manager-order-authority',
      actorId: 'manager-1',
      kinds: ['discount', 'gift'],
      maxAmount: 10_000,
      tableSessionIds: null,
      validFrom: '2026-07-14T00:00:00.000Z',
      validUntil: '2026-07-14T23:59:59.999Z',
    },
  ])
}

function itemInput(overrides: Partial<OrderItemDraftInput> = {}): OrderItemDraftInput {
  return {
    id: 'line-1',
    skuId: 'sku-1',
    name: '啤酒',
    specification: '330ml',
    quantity: 1,
    unitListPriceAmount: 1_000,
    unitSalePriceAmount: 1_000,
    unitCostAmount: 300,
    stationId: 'bar-main',
    configVersion: 3,
    ...overrides,
  }
}

function addItem(
  state: OrderDomainState,
  orderId: string,
  item: OrderItemDraftInput,
  idempotencyKey = `add-${orderId}-${item.id}`,
) {
  return addOrderItem(state, {
    orderId,
    item,
    actorId: 'employee-server',
    occurredAt: T1,
    idempotencyKey,
  })
}

function submit(state: OrderDomainState, orderId = 'order-1', key = `submit-${orderId}`) {
  return submitOrder(state, {
    orderId,
    submittedBy: 'employee-server',
    occurredAt: T2,
    idempotencyKey: key,
  })
}

function grantAuthorization(
  state: OrderDomainState,
  orderId: string,
  authorizationId: string,
  kind: 'discount' | 'gift',
  lineIds: string[],
) {
  const requested = requestOrderAuthorization(state, {
    authorizationId,
    orderId,
    kind,
    lineIds,
    requestedBy: 'employee-server',
    occurredAt: T1,
    idempotencyKey: `request-${authorizationId}`,
  })
  decideOrderAuthorization(state, {
    authorizationId,
    decision: 'granted',
    decidedBy: 'manager-1',
    reason: '额度内批准',
    occurredAt: T2,
    idempotencyKey: `decide-${authorizationId}`,
  })
  return requested
}

function runKdsFlow(state: OrderDomainState, taskId: string, keyPrefix: string) {
  startKdsTask(state, { taskId, actorId: 'bartender-1', occurredAt: T2, idempotencyKey: `${keyPrefix}-start` })
  completeKdsTask(state, {
    taskId,
    actorId: 'bartender-1',
    occurredAt: T3,
    idempotencyKey: `${keyPrefix}-complete`,
  })
  pickUpKdsTask(state, {
    taskId,
    actorId: 'runner-1',
    occurredAt: T4,
    idempotencyKey: `${keyPrefix}-pickup`,
  })
  return deliverKdsTask(state, {
    taskId,
    actorId: 'server-1',
    occurredAt: T5,
    idempotencyKey: `${keyPrefix}-deliver`,
  })
}

describe('order draft and deterministic money', () => {
  it('keeps price snapshots and calculates all amounts as integers', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    const item = addItem(
      state,
      order.id,
      itemInput({ quantity: 2, unitListPriceAmount: 1_000, unitSalePriceAmount: 800 }),
    )

    expect(item).toMatchObject({
      fulfillmentStatus: 'draft',
      kdsTaskId: null,
      addedBy: 'employee-server',
      addedAt: T1,
    })
    expect(order.amounts).toEqual({
      grossAmount: 2_000,
      discountAmount: 400,
      giftAmount: 0,
      payableAmount: 1_600,
    })
    expect(order.revision).toBe(2)
  })

  it('rejects fractional and overflowing money without mutating the draft', () => {
    const state = createOrderDomainState()
    const order = draft(state)

    expect(() =>
      addItem(state, order.id, itemInput({ unitSalePriceAmount: 99.5 }), 'fractional-money'),
    ).toThrow('商品成交价必须是非负安全整数')
    expect(() =>
      addItem(
        state,
        order.id,
        itemInput({ id: 'line-overflow', quantity: 2, unitListPriceAmount: Number.MAX_SAFE_INTEGER }),
        'overflow-money',
      ),
    ).toThrow('商品原价金额超出安全整数范围')
    expect(order.items).toHaveLength(0)
    expect(state.idempotencyRecords).toHaveLength(1)
  })

  it('returns the original result for retries and rejects key reuse with changed input', () => {
    const state = createOrderDomainState()
    const command = {
      orderId: 'order-1',
      tableSessionId: 'table-session-1',
      createdBy: 'employee-server',
      occurredAt: T0,
      idempotencyKey: 'same-create-key',
    }

    const first = createOrderDraft(state, command)
    const retry = createOrderDraft(state, command)
    expect(retry).toBe(first)
    expect(state.orders).toHaveLength(1)

    expect(() => createOrderDraft(state, { ...command, orderId: 'order-2' })).toThrow(
      '幂等键已用于不同请求',
    )
    expect(state.orders).toHaveLength(1)
  })
})

describe('order authorization and submission', () => {
  it('requires line-level discount and gift authorization before submission', () => {
    const state = authorizedState()
    const order = draft(state)
    addItem(state, order.id, itemInput({ id: 'line-full' }))
    addItem(
      state,
      order.id,
      itemInput({ id: 'line-discount', skuId: 'sku-2', unitSalePriceAmount: 800 }),
    )
    addItem(
      state,
      order.id,
      itemInput({ id: 'line-gift', skuId: 'sku-3', unitSalePriceAmount: 0 }),
    )

    expect(() => submit(state)).toThrow('订单缺少折扣或赠送授权')
    const discountAuthorization = requestOrderAuthorization(state, {
      authorizationId: 'auth-discount',
      orderId: order.id,
      kind: 'discount',
      lineIds: ['line-discount'],
      requestedBy: 'employee-server',
      occurredAt: T1,
      idempotencyKey: 'request-discount',
    })
    expect(discountAuthorization.requestedAmount).toBe(200)
    expect(() => submit(state, order.id, 'submit-pending')).toThrow('订单授权尚未完成')

    decideOrderAuthorization(state, {
      authorizationId: 'auth-discount',
      decision: 'granted',
      decidedBy: 'manager-1',
      reason: '批准折扣',
      occurredAt: T2,
      idempotencyKey: 'decide-discount',
    })
    const giftAuthorization = grantAuthorization(state, order.id, 'auth-gift', 'gift', ['line-gift'])
    expect(giftAuthorization.requestedAmount).toBe(1_000)

    const submitted = submit(state, order.id, 'submit-authorized')
    expect(submitted.status).toBe('submitted')
    expect(state.tableLedgerEntries.map((entry) => [entry.type, entry.amount])).toEqual([
      ['order_gross_charge', 3_000],
      ['order_discount', -200],
      ['order_gift', -1_000],
    ])
    expect(getTableBalance(state, order.tableSessionId)).toBe(1_800)
  })

  it('allows a new request after rejection but keeps the draft frozen', () => {
    const state = authorizedState()
    const order = draft(state)
    addItem(state, order.id, itemInput({ unitSalePriceAmount: 800 }))
    requestOrderAuthorization(state, {
      authorizationId: 'auth-rejected',
      orderId: order.id,
      kind: 'discount',
      lineIds: ['line-1'],
      requestedBy: 'employee-server',
      occurredAt: T1,
      idempotencyKey: 'request-rejected',
    })
    decideOrderAuthorization(state, {
      authorizationId: 'auth-rejected',
      decision: 'rejected',
      decidedBy: 'manager-1',
      reason: '超出当班额度',
      occurredAt: T2,
      idempotencyKey: 'reject-authorization',
    })

    expect(() => addItem(state, order.id, itemInput({ id: 'line-2' }), 'add-after-auth')).toThrow(
      '只有草稿订单可以添加商品',
    )
    expect(() => submit(state, order.id, 'submit-after-reject')).toThrow('订单缺少折扣或赠送授权')

    grantAuthorization(state, order.id, 'auth-retry', 'discount', ['line-1'])
    expect(submit(state, order.id, 'submit-after-grant').status).toBe('submitted')
  })

  it('rejects approval outside the approver amount limit', () => {
    const state = createOrderDomainState([
      {
        id: 'limited-authority',
        actorId: 'manager-1',
        kinds: ['discount'],
        maxAmount: 100,
        tableSessionIds: ['table-session-1'],
        validFrom: '2026-07-14T00:00:00.000Z',
        validUntil: '2026-07-14T23:59:59.999Z',
      },
    ])
    const order = draft(state)
    addItem(state, order.id, itemInput({ unitSalePriceAmount: 800 }))
    const authorization = requestOrderAuthorization(state, {
      authorizationId: 'auth-over-limit',
      orderId: order.id,
      kind: 'discount',
      lineIds: ['line-1'],
      requestedBy: 'employee-server',
      occurredAt: T1,
      idempotencyKey: 'request-over-limit',
    })

    expect(() =>
      decideOrderAuthorization(state, {
        authorizationId: authorization.id,
        decision: 'granted',
        decidedBy: 'manager-1',
        reason: '尝试批准',
        occurredAt: T2,
        idempotencyKey: 'approve-over-limit',
      }),
    ).toThrow('审批人没有该授权额度或授权已失效')
    expect(authorization.status).toBe('pending')
  })

  it('rejects approval when the product is outside the configured gift list', () => {
    const state = createOrderDomainState([{
      id: 'beer-only-authority',
      actorId: 'manager-1',
      kinds: ['gift'],
      maxAmount: 10_000,
      allowedSkuIds: ['sku-beer'],
      tableSessionIds: null,
      validFrom: '2026-07-14T00:00:00.000Z',
      validUntil: '2026-07-14T23:59:59.999Z',
    }])
    const order = draft(state)
    addItem(state, order.id, itemInput({ skuId: 'sku-cocktail', unitSalePriceAmount: 0 }))
    const authorization = requestOrderAuthorization(state, {
      authorizationId: 'auth-product-denied',
      orderId: order.id,
      kind: 'gift',
      lineIds: ['line-1'],
      requestedBy: 'employee-server',
      occurredAt: T1,
      idempotencyKey: 'request-product-denied',
    })

    expect(() => decideOrderAuthorization(state, {
      authorizationId: authorization.id,
      decision: 'granted',
      decidedBy: 'manager-1',
      reason: '尝试批准非授权商品',
      occurredAt: T2,
      idempotencyKey: 'approve-product-denied',
    })).toThrow('审批人没有该授权额度或授权已失效')
  })

  it('creates one queued KDS task per item and one gross table charge for a full-price order', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({ quantity: 2 }))
    addItem(state, order.id, itemInput({ id: 'line-2', skuId: 'sku-2', unitListPriceAmount: 500, unitSalePriceAmount: 500 }))

    const submitted = submit(state)
    const retried = submit(state)
    expect(retried).toBe(submitted)
    expect(submitted.items.map((item) => item.fulfillmentStatus)).toEqual(['queued', 'queued'])
    expect(state.kdsTasks).toHaveLength(2)
    expect(state.tableLedgerEntries).toHaveLength(1)
    expect(state.kdsTasks[0]).toMatchObject({
      id: 'kds:order-1:line-1',
      itemName: '啤酒',
      quantity: 2,
      status: 'queued',
    })
    expect(getTableAccountSummary(state, order.tableSessionId)).toMatchObject({
      balance: 2_500,
      entries: [{ type: 'order_gross_charge', amount: 2_500, balanceAfter: 2_500, sequence: 1 }],
    })
  })

  it('normalizes one fulfillment note and snapshots it to every KDS task', () => {
    const state = createOrderDomainState()
    const order = createOrderDraft(state, {
      orderId: 'order-with-note',
      tableSessionId: 'table-session-1',
      createdBy: 'employee-server',
      fulfillmentNote: '  两杯少冰\n小食一起上  ',
      occurredAt: T0,
      idempotencyKey: 'create-order-with-note',
    })
    addItem(state, order.id, itemInput({ id: 'note-line-1' }))
    addItem(state, order.id, itemInput({ id: 'note-line-2', skuId: 'sku-2' }))

    const submitted = submit(state, order.id, 'submit-order-with-note')

    expect(submitted.fulfillmentNote).toBe('两杯少冰 小食一起上')
    expect(state.kdsTasks.map((task) => task.fulfillmentNote)).toEqual([
      '两杯少冰 小食一起上',
      '两杯少冰 小食一起上',
    ])
  })

  it('rejects fulfillment notes longer than 300 characters', () => {
    const state = createOrderDomainState()
    expect(() => createOrderDraft(state, {
      orderId: 'order-note-too-long',
      tableSessionId: 'table-session-1',
      createdBy: 'employee-server',
      fulfillmentNote: '长'.repeat(301),
      occurredAt: T0,
      idempotencyKey: 'create-order-note-too-long',
    })).toThrow('订单备注不能超过300字')
  })

  it('records non-fulfillment adjustment items without creating KDS work', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      skuId: 'product-balance-adjustment',
      name: '补差额',
      specification: '1元',
      quantity: 188,
      unitListPriceAmount: 100,
      unitSalePriceAmount: 100,
      unitCostAmount: 0,
      stationId: 'non-fulfillment',
      fulfillmentType: 'no_fulfillment',
    }))

    const submitted = submit(state)

    expect(submitted).toMatchObject({ status: 'fulfilled', fulfilledAt: T2 })
    expect(submitted.items[0]).toMatchObject({
      fulfillmentType: 'no_fulfillment',
      fulfillmentStatus: 'delivered',
      kdsTaskId: null,
    })
    expect(state.kdsTasks).toHaveLength(0)
    expect(getTableBalance(state, order.tableSessionId)).toBe(18_800)
  })

  it('keeps the legacy false switch compatible with no-fulfillment products', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      skuId: 'legacy-adjustment',
      stationId: 'legacy-non-fulfillment',
      requiresFulfillment: false,
    }))

    const submitted = submit(state)

    expect(submitted.items[0]).toMatchObject({
      fulfillmentType: 'no_fulfillment',
      requiresFulfillment: false,
      fulfillmentStatus: 'delivered',
      kdsTaskId: null,
    })
    expect(state.kdsTasks).toHaveLength(0)
  })

  it('keeps legacy products on the made-to-order KDS path by default', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    const item = addItem(state, order.id, itemInput())

    submit(state)

    expect(item).toMatchObject({
      fulfillmentType: 'made_to_order',
      requiresFulfillment: true,
      fulfillmentStatus: 'queued',
    })
    expect(state.kdsTasks[0]).toMatchObject({
      fulfillmentType: 'made_to_order',
      status: 'queued',
      startedAt: null,
      completedAt: null,
    })
  })

  it('routes ready products directly to pickup without requiring production', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      skuId: 'bottled-beer',
      name: '瓶装啤酒',
      fulfillmentType: 'ready_to_serve',
    }))

    const submitted = submit(state)
    const task = state.kdsTasks[0]!

    expect(submitted.status).toBe('in_fulfillment')
    expect(task).toMatchObject({
      fulfillmentType: 'ready_to_serve',
      status: 'completed',
      startedAt: null,
      completedAt: T2,
      completedBy: 'employee-server',
      pickedUpAt: null,
    })
    expect(task.productionSla).toBeUndefined()
    expect(() => startKdsTask(state, {
      taskId: task.id,
      actorId: 'bartender-1',
      occurredAt: T3,
      idempotencyKey: 'ready-product-start',
    })).toThrow('KDS任务不能从completed跳转到preparing')

    pickUpKdsTask(state, {
      taskId: task.id,
      actorId: 'runner-1',
      occurredAt: T3,
      idempotencyKey: 'ready-product-pickup',
    })
    deliverKdsTask(state, {
      taskId: task.id,
      actorId: 'server-1',
      occurredAt: T4,
      idempotencyKey: 'ready-product-deliver',
    })
    expect(submitted).toMatchObject({ status: 'fulfilled', fulfilledAt: T4 })
  })

  it('routes service-only lines directly to service completion', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      skuId: 'birthday-service',
      name: '生日服务',
      fulfillmentType: 'service_only',
    }))

    const submitted = submit(state)
    const task = state.kdsTasks[0]!

    expect(task).toMatchObject({
      fulfillmentType: 'service_only',
      status: 'picked_up',
      completedAt: T2,
      pickedUpAt: T2,
    })
    deliverKdsTask(state, {
      taskId: task.id,
      actorId: 'server-1',
      occurredAt: T3,
      idempotencyKey: 'service-only-deliver',
    })
    expect(submitted.status).toBe('fulfilled')
  })

  it('does not let a no-fulfillment line hide an undelivered physical item', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      id: 'adjustment-line',
      skuId: 'adjustment',
      stationId: 'non-fulfillment',
      fulfillmentType: 'no_fulfillment',
    }))
    addItem(state, order.id, itemInput({
      id: 'ready-line',
      skuId: 'bottled-beer',
      fulfillmentType: 'ready_to_serve',
    }))

    const submitted = submit(state)

    expect(submitted.status).toBe('in_fulfillment')
    expect(submitted.items.map((item) => item.fulfillmentStatus)).toEqual(['delivered', 'completed'])
    expect(state.kdsTasks).toHaveLength(1)
  })

  it('rejects conflicting legacy and typed fulfillment configuration', () => {
    const state = createOrderDomainState()
    const order = draft(state)

    expect(() => addItem(state, order.id, itemInput({
      requiresFulfillment: false,
      fulfillmentType: 'ready_to_serve',
    }))).toThrow('商品履约类型与旧版履约开关冲突')
    expect(order.items).toHaveLength(0)
  })
})

describe('KDS item fulfillment', () => {
  it('blocks illegal jumps and fulfills the order only after every item is delivered', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput())
    addItem(state, order.id, itemInput({ id: 'line-2', skuId: 'sku-2' }))
    submit(state)
    const firstTaskId = 'kds:order-1:line-1'
    const secondTaskId = 'kds:order-1:line-2'

    expect(() =>
      completeKdsTask(state, {
        taskId: firstTaskId,
        actorId: 'bartender-1',
        occurredAt: T3,
        idempotencyKey: 'illegal-complete',
      }),
    ).toThrow('KDS任务不能从queued跳转到completed')

    startKdsTask(state, { taskId: firstTaskId, actorId: 'bartender-1', occurredAt: T2, idempotencyKey: 'first-start' })
    completeKdsTask(state, {
      taskId: firstTaskId,
      actorId: 'bartender-1',
      occurredAt: T3,
      idempotencyKey: 'first-complete',
    })
    expect(() =>
      deliverKdsTask(state, {
        taskId: firstTaskId,
        actorId: 'server-1',
        occurredAt: T4,
        idempotencyKey: 'illegal-deliver',
      }),
    ).toThrow('KDS任务不能从completed跳转到delivered')
    pickUpKdsTask(state, {
      taskId: firstTaskId,
      actorId: 'runner-1',
      occurredAt: T4,
      idempotencyKey: 'first-pickup',
    })
    deliverKdsTask(state, {
      taskId: firstTaskId,
      actorId: 'server-1',
      occurredAt: T5,
      idempotencyKey: 'first-deliver',
    })

    expect(order.status).toBe('in_fulfillment')
    expect(order.items.map((item) => item.fulfillmentStatus)).toEqual(['delivered', 'queued'])
    runKdsFlow(state, secondTaskId, 'second')
    expect(order.status).toBe('fulfilled')
    expect(order.fulfilledAt).toBe(T5)
  })

  it('makes KDS actions idempotent and rejects a reused key with another actor', () => {
    const state = createOrderDomainState()
    draft(state)
    addItem(state, 'order-1', itemInput())
    submit(state)
    const command = {
      taskId: 'kds:order-1:line-1',
      actorId: 'bartender-1',
      occurredAt: T2,
      idempotencyKey: 'same-kds-key',
    }

    const first = startKdsTask(state, command)
    const retry = startKdsTask(state, command)
    expect(retry).toBe(first)
    expect(first.status).toBe('preparing')
    expect(() => startKdsTask(state, { ...command, actorId: 'bartender-2' })).toThrow(
      '幂等键已用于不同请求',
    )
  })

  it('atomically completes, picks up and delivers a made-to-order item', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({ name: '现调鸡尾酒' }))
    submit(state)
    const task = state.kdsTasks[0]!
    startKdsTask(state, {
      taskId: task.id,
      actorId: 'bartender-1',
      occurredAt: T3,
      idempotencyKey: 'combined-start',
    })
    const command = {
      taskId: task.id,
      actorId: 'bartender-1',
      occurredAt: T4,
      idempotencyKey: 'combined-complete-deliver',
    }

    const completed = completeAndDeliverKdsTask(state, command)
    const retried = completeAndDeliverKdsTask(state, command)

    expect(retried).toBe(completed)
    expect(completed).toMatchObject({
      status: 'delivered',
      completedAt: T4,
      completedBy: 'bartender-1',
      pickedUpAt: T4,
      pickedUpBy: 'bartender-1',
      deliveredAt: T4,
      deliveredBy: 'bartender-1',
    })
    expect(order).toMatchObject({ status: 'fulfilled', fulfilledAt: T4 })
    expect(state.idempotencyRecords.filter(
      (record) => record.operation === 'kds.complete_and_deliver.v1',
    )).toHaveLength(1)
  })

  it('does not let combined completion bypass a pending KDS exception', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({ name: '现调鸡尾酒' }))
    submit(state)
    const task = state.kdsTasks[0]!
    startKdsTask(state, {
      taskId: task.id,
      actorId: 'bartender-1',
      occurredAt: T3,
      idempotencyKey: 'blocked-combined-start',
    })
    reportKdsException(state, {
      exceptionId: 'blocked-combined-shortage',
      eventId: 'blocked-combined-report',
      taskId: task.id,
      exceptionKind: 'shortage',
      reasonCode: 'ingredient_out_of_stock',
      reasonNote: '',
      actorId: 'bartender-1',
      actorRoleId: 'bartender',
      occurredAt: T4,
      idempotencyKey: 'blocked-combined-report-key',
    })

    expect(() => completeAndDeliverKdsTask(state, {
      taskId: task.id,
      actorId: 'bartender-1',
      occurredAt: T5,
      idempotencyKey: 'blocked-combined-deliver',
    })).toThrow('KDS异常待领班或经理处置')
    expect(task.status).toBe('preparing')
    expect(order.status).toBe('in_fulfillment')
  })
})

describe('KDS exception closure', () => {
  it('keeps shortage handling available for ready-to-serve stock before pickup', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput({
      skuId: 'bottled-beer',
      name: '瓶装啤酒',
      fulfillmentType: 'ready_to_serve',
    }))
    submit(state)
    const task = state.kdsTasks[0]!

    reportKdsException(state, {
      exceptionId: 'ready-shortage',
      eventId: 'ready-shortage-report',
      taskId: task.id,
      exceptionKind: 'shortage',
      reasonCode: 'product_out_of_stock',
      reasonNote: '',
      actorId: 'runner-1',
      actorRoleId: 'runner',
      occurredAt: T3,
      idempotencyKey: 'ready-shortage-report-key',
    })
    expect(order.status).toBe('in_fulfillment')
    expect(() => pickUpKdsTask(state, {
      taskId: task.id,
      actorId: 'runner-1',
      occurredAt: T4,
      idempotencyKey: 'ready-shortage-pickup',
    })).toThrow('KDS异常待领班或经理处置')

    decideKdsException(state, {
      eventId: 'ready-shortage-decision',
      exceptionId: 'ready-shortage',
      disposition: 'cancelled',
      reasonCode: 'unavailable_confirmed',
      reasonNote: '',
      remakeTaskId: null,
      actorId: 'manager-1',
      actorRoleId: 'manager',
      occurredAt: T4,
      idempotencyKey: 'ready-shortage-decision-key',
    })
    expect(order.status).toBe('fulfilled')
  })

  it('keeps the original task and commercial order facts while a shortage is remade', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput())
    submit(state)
    const originalTask = state.kdsTasks[0]!
    const originalTaskFacts = {
      status: originalTask.status,
      queuedAt: originalTask.queuedAt,
      startedAt: originalTask.startedAt,
      completedAt: originalTask.completedAt,
    }
    const originalAmounts = structuredClone(order.amounts)
    const originalLedger = structuredClone(state.tableLedgerEntries)
    const reportCommand = {
      exceptionId: 'exception-shortage-1',
      eventId: 'event-shortage-report-1',
      taskId: originalTask.id,
      exceptionKind: 'shortage' as const,
      reasonCode: 'product_out_of_stock' as const,
      reasonNote: '',
      actorId: 'bartender-1',
      actorRoleId: 'bartender',
      occurredAt: T3,
      idempotencyKey: 'exception-shortage-report-0001',
    }

    const reported = reportKdsException(state, reportCommand)
    expect(reportKdsException(state, reportCommand)).toBe(reported)
    expect(reported).toMatchObject({
      type: 'reported', exceptionKind: 'shortage', reasonCode: 'product_out_of_stock',
      originalOrderItemId: 'line-1', originalKdsTaskId: originalTask.id,
      actorId: 'bartender-1', actorRoleId: 'bartender', occurredAt: T3,
    })
    expect(() => startKdsTask(state, {
      taskId: originalTask.id, actorId: 'bartender-1', occurredAt: T4, idempotencyKey: 'blocked-original-start',
    })).toThrow('KDS异常待领班或经理处置')

    const decisionCommand = {
      eventId: 'event-shortage-decision-1',
      exceptionId: reported.exceptionId,
      disposition: 'remake' as const,
      reasonCode: 'service_recovery' as const,
      reasonNote: '',
      remakeTaskId: 'kds-remake-shortage-1',
      actorId: 'supervisor-1',
      actorRoleId: 'supervisor',
      occurredAt: T4,
      idempotencyKey: 'exception-shortage-remake-0001',
    }
    const decision = decideKdsException(state, decisionCommand)
    expect(decideKdsException(state, decisionCommand)).toBe(decision)
    const remake = state.kdsTasks.find((task) => task.id === decision.remakeKdsTaskId)!

    expect(originalTask).toMatchObject(originalTaskFacts)
    expect(originalTask.exceptionEvents).toHaveLength(2)
    expect(order.items[0]?.kdsTaskId).toBe(originalTask.id)
    expect(order.amounts).toEqual(originalAmounts)
    expect(state.tableLedgerEntries).toEqual(originalLedger)
    expect(remake).toMatchObject({
      status: 'queued', orderItemId: 'line-1',
      remakeOf: { orderItemId: 'line-1', kdsTaskId: originalTask.id, exceptionId: reported.exceptionId, attempt: 1 },
    })
    expect(Object.hasOwn(remake, 'tableCode')).toBe(false)
    expect(() => startKdsTask(state, {
      taskId: originalTask.id, actorId: 'bartender-1', occurredAt: T5, idempotencyKey: 'closed-original-start',
    })).toThrow('原KDS任务已由异常处置关闭')

    startKdsTask(state, { taskId: remake.id, actorId: 'bartender-1', occurredAt: T5, idempotencyKey: 'remake-start' })
    completeKdsTask(state, { taskId: remake.id, actorId: 'bartender-1', occurredAt: T6, idempotencyKey: 'remake-complete' })
    pickUpKdsTask(state, { taskId: remake.id, actorId: 'runner-1', occurredAt: T7, idempotencyKey: 'remake-pickup' })
    deliverKdsTask(state, { taskId: remake.id, actorId: 'runner-1', occurredAt: T8, idempotencyKey: 'remake-deliver' })

    expect(originalTask.status).toBe('queued')
    expect(remake.status).toBe('delivered')
    expect(order.status).toBe('fulfilled')
    expect(order.items[0]?.fulfillmentStatus).toBe('delivered')
  })

  it('closes a shortage by manager cancellation without deleting the original KDS task', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput())
    submit(state)
    const task = state.kdsTasks[0]!
    reportKdsException(state, {
      exceptionId: 'exception-cancel-1', eventId: 'event-cancel-report-1', taskId: task.id,
      exceptionKind: 'shortage', reasonCode: 'ingredient_out_of_stock', reasonNote: '',
      actorId: 'bartender-1', actorRoleId: 'bartender', occurredAt: T3,
      idempotencyKey: 'exception-cancel-report-0001',
    })
    const disposition = decideKdsException(state, {
      eventId: 'event-cancel-decision-1', exceptionId: 'exception-cancel-1', disposition: 'cancelled',
      reasonCode: 'unavailable_confirmed', reasonNote: '', remakeTaskId: null,
      actorId: 'manager-1', actorRoleId: 'manager', occurredAt: T4,
      idempotencyKey: 'exception-cancel-decision-0001',
    })

    expect(disposition).toMatchObject({ managerDisposition: 'cancelled', remakeKdsTaskId: null })
    expect(state.kdsTasks).toHaveLength(1)
    expect(task.status).toBe('queued')
    expect(order.items[0]).toMatchObject({ id: 'line-1', kdsTaskId: task.id, fulfillmentStatus: 'queued' })
    expect(order.status).toBe('fulfilled')
  })

  it('reopens a delivered wrong item and fulfills it again through a linked remake', () => {
    const state = createOrderDomainState()
    const order = draft(state)
    addItem(state, order.id, itemInput())
    submit(state)
    const originalTask = state.kdsTasks[0]!
    runKdsFlow(state, originalTask.id, 'wrong-item-original')
    expect(order.status).toBe('fulfilled')

    const report = reportKdsException(state, {
      exceptionId: 'exception-wrong-item-1', eventId: 'event-wrong-item-report-1', taskId: originalTask.id,
      exceptionKind: 'wrong_item', reasonCode: 'wrong_product', reasonNote: '',
      actorId: 'runner-1', actorRoleId: 'runner', occurredAt: T6,
      idempotencyKey: 'exception-wrong-item-report-0001',
    })
    expect(order.status).toBe('in_fulfillment')
    const decision = decideKdsException(state, {
      eventId: 'event-wrong-item-decision-1', exceptionId: report.exceptionId, disposition: 'remake',
      reasonCode: 'quality_recovery', reasonNote: '', remakeTaskId: 'kds-remake-wrong-item-1',
      actorId: 'manager-1', actorRoleId: 'manager', occurredAt: T7,
      idempotencyKey: 'exception-wrong-item-remake-0001',
    })
    const remake = state.kdsTasks.find((task) => task.id === decision.remakeKdsTaskId)!
    startKdsTask(state, { taskId: remake.id, actorId: 'bartender-1', occurredAt: T8, idempotencyKey: 'wrong-remake-start' })
    completeKdsTask(state, { taskId: remake.id, actorId: 'bartender-1', occurredAt: T9, idempotencyKey: 'wrong-remake-complete' })
    pickUpKdsTask(state, { taskId: remake.id, actorId: 'runner-1', occurredAt: T10, idempotencyKey: 'wrong-remake-pickup' })
    deliverKdsTask(state, { taskId: remake.id, actorId: 'runner-1', occurredAt: T11, idempotencyKey: 'wrong-remake-deliver' })

    expect(originalTask.status).toBe('delivered')
    expect(originalTask.deliveredAt).toBe(T5)
    expect(remake.remakeOf).toMatchObject({ orderItemId: 'line-1', kdsTaskId: originalTask.id })
    expect(order.status).toBe('fulfilled')
    expect(order.fulfilledAt).toBe(T11)
  })
})

describe('table ledger', () => {
  it('keeps append-only sequence and balance across multiple orders on one table session', () => {
    const state = createOrderDomainState()
    draft(state, 'order-1', 'table-session-1')
    addItem(state, 'order-1', itemInput())
    submit(state, 'order-1')

    draft(state, 'order-2', 'table-session-1')
    addItem(state, 'order-2', itemInput({ id: 'line-2', unitListPriceAmount: 600, unitSalePriceAmount: 600 }))
    submit(state, 'order-2')

    const summary = getTableAccountSummary(state, 'table-session-1')
    expect(summary.entries.map((entry) => [entry.orderId, entry.sequence, entry.balanceAfter])).toEqual([
      ['order-1', 1, 1_000],
      ['order-2', 2, 1_600],
    ])
    expect(summary.balance).toBe(1_600)
  })
})
