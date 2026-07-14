import { createHash } from 'node:crypto'
import type { InventoryDomainState, InventoryMovement } from '../src/shared/inventory-contracts.js'
import type { Order } from '../src/shared/order-contracts.js'
import { consumeInventoryForGift, consumeInventoryForSale } from './inventory-domain.js'

export interface ConsumeSubmittedOrderInventoryCommand {
  actorId: string
  businessDate: string
  occurredAt: string
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function lineIdempotencyKey(orderId: string, orderItemId: string) {
  return `inventory.order-submit:${orderId}:${orderItemId}:v1`
}

/**
 * Consumes only products that already have an inventory balance. The working
 * copy prevents a multi-line order from leaving partial inventory movements.
 */
export function consumeManagedInventoryForSubmittedOrder(
  inventory: InventoryDomainState | undefined,
  order: Order,
  command: ConsumeSubmittedOrderInventoryCommand,
): InventoryMovement[] {
  if (!inventory) return []

  const managedProductIds = new Set(inventory.balances.map((balance) => balance.productId))
  const managedItems = order.items.filter((item) => managedProductIds.has(item.skuId))
  if (managedItems.length === 0) return []

  const workingInventory = structuredClone(inventory)
  const movements = managedItems.map((item) => {
    const balance = workingInventory.balances.find((candidate) => candidate.productId === item.skuId)
    if (!balance) throw new Error('订单库存余额在提交过程中发生变化')
    const type = item.unitSalePriceAmount === 0 ? 'gift' : 'sale'
    const idempotencyKey = lineIdempotencyKey(order.id, item.id)
    const consume = type === 'gift' ? consumeInventoryForGift : consumeInventoryForSale
    return consume(workingInventory, {
      movementId: deterministicId('inventory_movement', idempotencyKey),
      productId: item.skuId,
      unitCode: balance.unitCode,
      quantity: item.quantity,
      tableSessionId: order.tableSessionId,
      orderId: order.id,
      orderItemId: item.id,
      actorId: command.actorId,
      reason: type === 'gift' ? '零价赠品订单提交自动出库' : '销售订单提交自动出库',
      businessDate: command.businessDate,
      occurredAt: command.occurredAt,
      idempotencyKey,
    })
  })

  Object.assign(inventory, workingInventory)
  return movements
}
