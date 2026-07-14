import { describe, expect, it } from 'vitest'
import type {
  ConsumeInventoryCommand,
  DepositBottleCommand,
  ReceiveInventoryCommand,
} from '../src/shared/inventory-contracts.js'
import {
  confirmStockCount,
  consumeInventoryForGift,
  consumeInventoryForSale,
  createInventoryDomainState,
  depositBottle,
  expireStoredBottle,
  getInventoryBalance,
  rejectStockCount,
  returnInventoryForRefund,
  submitStockCount,
  transferStoredBottle,
  useStoredBottle,
  voidStoredBottle,
  receiveInventory,
} from './inventory-domain.js'

const T0 = '2026-07-14T10:00:00.000Z'
const T1 = '2026-07-14T10:10:00.000Z'
const T2 = '2026-07-14T10:20:00.000Z'
const T3 = '2026-07-14T10:30:00.000Z'
const EXPIRES_AT = '2026-08-14T10:00:00.000Z'
const BUSINESS_DATE = '2026-07-14'

function state() {
  return createInventoryDomainState({ tenantId: 'tenant-mbox', storeId: 'store-lujiazui' })
}

function receipt(overrides: Partial<ReceiveInventoryCommand> = {}): ReceiveInventoryCommand {
  return {
    movementId: 'movement-receipt-1',
    productId: 'product-whisky',
    unitCode: 'bottle',
    quantity: 10,
    actorId: 'warehouse-1',
    reason: '供应商到货验收',
    businessDate: BUSINESS_DATE,
    occurredAt: T0,
    idempotencyKey: 'inventory-receipt-0001',
    ...overrides,
  }
}

function consumption(overrides: Partial<ConsumeInventoryCommand> = {}): ConsumeInventoryCommand {
  return {
    movementId: 'movement-sale-1',
    productId: 'product-whisky',
    unitCode: 'bottle',
    quantity: 2,
    tableSessionId: 'table-session-1',
    orderId: 'order-1',
    orderItemId: 'order-item-1',
    actorId: 'server-1',
    reason: '订单出库',
    businessDate: BUSINESS_DATE,
    occurredAt: T1,
    idempotencyKey: 'inventory-sale-0001',
    ...overrides,
  }
}

function bottleDeposit(overrides: Partial<DepositBottleCommand> = {}): DepositBottleCommand {
  return {
    batchId: 'bottle-batch-1',
    eventId: 'bottle-event-deposit-1',
    productId: 'product-whisky',
    skuSnapshot: 'WHISKY-001',
    productNameSnapshot: '单一麦芽威士忌',
    owner: { kind: 'member', memberId: 'member-1' },
    capacityQuantity: 700,
    unitCode: 'ml',
    expiresAt: EXPIRES_AT,
    tableSessionId: 'table-session-1',
    orderId: 'order-1',
    orderItemId: 'order-item-1',
    actorId: 'server-1',
    approvalId: 'approval-deposit-1',
    reason: '客人结账后存酒',
    businessDate: BUSINESS_DATE,
    occurredAt: T0,
    idempotencyKey: 'bottle-deposit-0001',
    ...overrides,
  }
}

describe('SKU inventory movements', () => {
  it('maintains a scoped balance from immutable receipt, sale, gift and refund facts', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    const sale = consumeInventoryForSale(domain, consumption())
    const gift = consumeInventoryForGift(domain, consumption({
      movementId: 'movement-gift-1',
      orderItemId: 'order-item-gift-1',
      quantity: 1,
      reason: '经理批准赠送',
      idempotencyKey: 'inventory-gift-0001',
    }))
    const refund = returnInventoryForRefund(domain, {
      movementId: 'movement-refund-1',
      productId: 'product-whisky',
      unitCode: 'bottle',
      quantity: 1,
      tableSessionId: 'table-session-1',
      orderId: 'order-1',
      orderItemId: 'order-item-1',
      refundId: 'refund-1',
      actorId: 'cashier-1',
      reason: '未开封退货重新入库',
      businessDate: BUSINESS_DATE,
      occurredAt: T2,
      idempotencyKey: 'inventory-refund-0001',
    })

    expect(getInventoryBalance(domain, 'product-whisky')).toBe(8)
    expect(sale).toMatchObject({ type: 'sale', direction: 'out', balanceAfter: 8, orderId: 'order-1' })
    expect(gift).toMatchObject({ type: 'gift', direction: 'out', balanceAfter: 7, orderItemId: 'order-item-gift-1' })
    expect(refund).toMatchObject({ type: 'refund', direction: 'in', balanceAfter: 8, refundId: 'refund-1' })
    expect(domain.movements).toHaveLength(4)
    expect(domain.movements.every((item) => item.tenantId === 'tenant-mbox' && item.storeId === 'store-lujiazui')).toBe(true)
    expect(domain.auditEvents.filter((item) => item.objectType === 'inventory_movement')).toHaveLength(4)
  })

  it('rejects negative inventory before mutating balance or writing a movement', () => {
    const domain = state()
    receiveInventory(domain, receipt({ quantity: 1 }))

    expect(() => consumeInventoryForSale(domain, consumption({ quantity: 2 }))).toThrow(
      '库存不足，禁止产生负库存',
    )
    expect(getInventoryBalance(domain, 'product-whisky')).toBe(1)
    expect(domain.movements).toHaveLength(1)
    expect(domain.auditEvents).toHaveLength(1)
  })

  it('returns the original result for a replay and rejects changed input under the same key', () => {
    const domain = state()
    const command = receipt()
    const first = receiveInventory(domain, command)
    const replay = receiveInventory(domain, command)

    expect(replay).toBe(first)
    expect(domain.movements).toHaveLength(1)
    expect(() => receiveInventory(domain, { ...command, quantity: 11 })).toThrow('幂等键已用于不同请求')
    expect(getInventoryBalance(domain, 'product-whisky')).toBe(10)
  })

  it('prevents a SKU balance from silently changing its measurement unit', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    expect(() => receiveInventory(domain, receipt({
      movementId: 'movement-receipt-2',
      unitCode: 'case',
      idempotencyKey: 'inventory-receipt-0002',
    }))).toThrow('商品库存计量单位不一致')
  })
})

describe('stock count variance approval', () => {
  it('closes a no-variance count without creating an adjustment', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    const count = submitStockCount(domain, {
      countId: 'count-1',
      productId: 'product-whisky',
      unitCode: 'bottle',
      countedQuantity: 10,
      countedBy: 'counter-1',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'stock-count-submit-0001',
    })

    expect(count).toMatchObject({ status: 'applied', differenceQuantity: 0, adjustmentMovementId: null })
    expect(domain.movements).toHaveLength(1)
  })

  it('requires an approval reference for any variance', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    expect(() => submitStockCount(domain, {
      countId: 'count-1',
      productId: 'product-whisky',
      unitCode: 'bottle',
      countedQuantity: 8,
      countedBy: 'counter-1',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'stock-count-submit-0001',
    })).toThrow('盘点差异必须关联审批')
    expect(domain.stockCounts).toHaveLength(0)
  })

  it('applies a variance only after confirmation by a different operator', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    const count = submitStockCount(domain, {
      countId: 'count-1',
      productId: 'product-whisky',
      unitCode: 'bottle',
      countedQuantity: 8,
      countedBy: 'counter-1',
      approvalId: 'approval-count-1',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'stock-count-submit-0001',
    })
    expect(count.status).toBe('pending_confirmation')
    expect(getInventoryBalance(domain, 'product-whisky')).toBe(10)

    expect(() => confirmStockCount(domain, {
      countId: count.id,
      adjustmentMovementId: 'movement-count-1',
      approvalId: 'approval-count-1',
      confirmedBy: 'counter-1',
      reason: '本人尝试复核',
      occurredAt: T2,
      idempotencyKey: 'stock-count-confirm-self',
    })).toThrow('盘点人不能复核自己的差异')

    const confirmed = confirmStockCount(domain, {
      countId: count.id,
      adjustmentMovementId: 'movement-count-1',
      approvalId: 'approval-count-1',
      confirmedBy: 'manager-1',
      reason: '复核实物与盘点表一致',
      occurredAt: T2,
      idempotencyKey: 'stock-count-confirm-0001',
    })
    expect(confirmed).toMatchObject({
      status: 'applied',
      confirmedBy: 'manager-1',
      adjustmentMovementId: 'movement-count-1',
    })
    expect(getInventoryBalance(domain, 'product-whisky')).toBe(8)
    expect(domain.movements.at(-1)).toMatchObject({
      type: 'stock_count_loss',
      approvalId: 'approval-count-1',
      stockCountId: count.id,
    })
  })

  it('can reject a variance without changing inventory', () => {
    const domain = state()
    receiveInventory(domain, receipt())
    submitStockCount(domain, {
      countId: 'count-1',
      productId: 'product-whisky',
      unitCode: 'bottle',
      countedQuantity: 12,
      countedBy: 'counter-1',
      approvalId: 'approval-count-1',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'stock-count-submit-0001',
    })
    const rejected = rejectStockCount(domain, {
      countId: 'count-1',
      approvalId: 'approval-count-1',
      rejectedBy: 'manager-1',
      reason: '重新清点后发现录入错误',
      occurredAt: T2,
      idempotencyKey: 'stock-count-reject-0001',
    })

    expect(rejected.status).toBe('rejected')
    expect(getInventoryBalance(domain, 'product-whisky')).toBe(10)
    expect(domain.movements).toHaveLength(1)
  })
})

describe('customer bottle storage state machine', () => {
  it('creates member and anonymous batches with only manual-confirmation measurements', () => {
    const domain = state()
    const memberBatch = depositBottle(domain, bottleDeposit())
    const anonymousBatch = depositBottle(domain, bottleDeposit({
      batchId: 'bottle-batch-2',
      eventId: 'bottle-event-deposit-2',
      owner: { kind: 'anonymous', customerRef: 'guest-session-token-2', displayNameSnapshot: '王女士' },
      idempotencyKey: 'bottle-deposit-0002',
    }))

    expect(memberBatch).toMatchObject({
      owner: { kind: 'member', memberId: 'member-1' },
      capacityQuantity: 700,
      remainingQuantity: 700,
      unitCode: 'ml',
      measurementSource: 'manual_confirmation',
      status: 'stored',
    })
    expect(anonymousBatch.owner).toEqual({
      kind: 'anonymous',
      customerRef: 'guest-session-token-2',
      displayNameSnapshot: '王女士',
    })
    expect(domain.bottleEvents.every((event) => event.tableSessionId === 'table-session-1')).toBe(true)
  })

  it('tracks partial and complete use against table and order without allowing overuse', () => {
    const domain = state()
    const batch = depositBottle(domain, bottleDeposit())
    const firstUse = useStoredBottle(domain, {
      eventId: 'bottle-event-use-1',
      batchId: batch.id,
      quantity: 200,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      orderItemId: 'order-item-2',
      actorId: 'server-2',
      reason: '客人到店取用',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'bottle-use-0001',
    })
    expect(firstUse).toMatchObject({ remainingAfter: 500, tableSessionId: 'table-session-2', orderId: 'order-2' })
    expect(batch).toMatchObject({ remainingQuantity: 500, status: 'partially_used' })

    expect(() => useStoredBottle(domain, {
      eventId: 'bottle-event-use-over',
      batchId: batch.id,
      quantity: 501,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      reason: '错误数量',
      businessDate: BUSINESS_DATE,
      occurredAt: T2,
      idempotencyKey: 'bottle-use-overflow',
    })).toThrow('取用数量超过存酒剩余量')
    expect(batch.remainingQuantity).toBe(500)

    useStoredBottle(domain, {
      eventId: 'bottle-event-use-2',
      batchId: batch.id,
      quantity: 500,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      reason: '客人取完剩余存酒',
      businessDate: BUSINESS_DATE,
      occurredAt: T2,
      idempotencyKey: 'bottle-use-0002',
    })
    expect(batch).toMatchObject({ remainingQuantity: 0, status: 'exhausted' })
    expect(() => useStoredBottle(domain, {
      eventId: 'bottle-event-use-after-end',
      batchId: batch.id,
      quantity: 1,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      reason: '终态后误操作',
      businessDate: BUSINESS_DATE,
      occurredAt: T3,
      idempotencyKey: 'bottle-use-after-end',
    })).toThrow('当前存酒状态不允许该操作')
  })

  it('transfers the full remainder into a new owner batch under independent approval', () => {
    const domain = state()
    const source = depositBottle(domain, bottleDeposit())
    useStoredBottle(domain, {
      eventId: 'bottle-event-use-1',
      batchId: source.id,
      quantity: 100,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      reason: '先取用一部分',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'bottle-use-0001',
    })

    expect(() => transferStoredBottle(domain, {
      eventId: 'bottle-event-transfer-self',
      sourceBatchId: source.id,
      recipientBatchId: 'bottle-batch-recipient-self',
      recipientOwner: { kind: 'member', memberId: 'member-2' },
      tableSessionId: 'table-session-2',
      actorId: 'manager-1',
      approvalId: 'approval-transfer-1',
      approvedBy: 'manager-1',
      reason: '本人审批',
      businessDate: BUSINESS_DATE,
      occurredAt: T2,
      idempotencyKey: 'bottle-transfer-self',
    })).toThrow('高风险存酒操作必须由另一人审批')

    const recipient = transferStoredBottle(domain, {
      eventId: 'bottle-event-transfer-1',
      sourceBatchId: source.id,
      recipientBatchId: 'bottle-batch-recipient-1',
      recipientOwner: { kind: 'member', memberId: 'member-2' },
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      approvalId: 'approval-transfer-1',
      approvedBy: 'manager-1',
      reason: '原客人确认转赠好友',
      businessDate: BUSINESS_DATE,
      occurredAt: T2,
      idempotencyKey: 'bottle-transfer-0001',
    })

    expect(source).toMatchObject({ status: 'transferred', remainingQuantity: 0 })
    expect(recipient).toMatchObject({
      sourceBatchId: source.id,
      owner: { kind: 'member', memberId: 'member-2' },
      capacityQuantity: 600,
      remainingQuantity: 600,
      expiresAt: EXPIRES_AT,
      depositApprovalId: 'approval-transfer-1',
    })
    expect(domain.bottleEvents.at(-1)).toMatchObject({
      type: 'transfer',
      relatedBatchId: recipient.id,
      approvalId: 'approval-transfer-1',
      approvedBy: 'manager-1',
    })
  })

  it('voids an active batch only with independent approval and preserves the event', () => {
    const domain = state()
    const batch = depositBottle(domain, bottleDeposit())
    const event = voidStoredBottle(domain, {
      eventId: 'bottle-event-void-1',
      batchId: batch.id,
      tableSessionId: 'table-session-1',
      orderId: 'order-1',
      actorId: 'server-1',
      approvalId: 'approval-void-1',
      approvedBy: 'manager-1',
      reason: '客人书面确认放弃保管',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'bottle-void-0001',
    })

    expect(batch).toMatchObject({ status: 'voided', remainingQuantity: 0 })
    expect(event).toMatchObject({ type: 'void', quantity: 700, remainingAfter: 0, approvalId: 'approval-void-1' })
    expect(domain.auditEvents.at(-1)).toMatchObject({ action: 'bottle_storage.voided.v1', actorId: 'server-1' })
  })

  it('enforces retention expiry and only expires an active batch at or after its deadline', () => {
    const domain = state()
    const batch = depositBottle(domain, bottleDeposit())
    expect(() => expireStoredBottle(domain, {
      eventId: 'bottle-event-expire-early',
      batchId: batch.id,
      actorId: 'system',
      reason: '提前清理尝试',
      businessDate: BUSINESS_DATE,
      occurredAt: T1,
      idempotencyKey: 'bottle-expire-early',
    })).toThrow('未到保管期限，不能标记过期')

    const event = expireStoredBottle(domain, {
      eventId: 'bottle-event-expire-1',
      batchId: batch.id,
      actorId: 'system',
      reason: '保管期届满批处理',
      businessDate: '2026-08-14',
      occurredAt: EXPIRES_AT,
      idempotencyKey: 'bottle-expire-0001',
    })
    expect(batch).toMatchObject({ status: 'expired', remainingQuantity: 0 })
    expect(event).toMatchObject({ type: 'expire', quantity: 700, remainingAfter: 0 })
  })

  it('rejects use at the expiry boundary without writing an event', () => {
    const domain = state()
    const batch = depositBottle(domain, bottleDeposit())
    expect(() => useStoredBottle(domain, {
      eventId: 'bottle-event-use-expired',
      batchId: batch.id,
      quantity: 10,
      tableSessionId: 'table-session-2',
      orderId: 'order-2',
      actorId: 'server-2',
      reason: '过期后取用尝试',
      businessDate: '2026-08-14',
      occurredAt: EXPIRES_AT,
      idempotencyKey: 'bottle-use-expired',
    })).toThrow('存酒已超过保管期限')
    expect(domain.bottleEvents).toHaveLength(1)
    expect(batch.remainingQuantity).toBe(700)
  })
})
