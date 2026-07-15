import { createHash } from 'node:crypto'
import type {
  InventoryConsumptionType,
  InventoryDomainState,
  InventoryMovement,
  InventoryRecipeVersion,
} from '../src/shared/inventory-contracts.js'
import type { Order, OrderItem } from '../src/shared/order-contracts.js'
import {
  consumeInventoryForGift,
  consumeInventoryForRemake,
  consumeInventoryForSale,
  normalizeInventoryDomainState,
} from './inventory-domain.js'

export interface ConsumeSubmittedOrderInventoryCommand {
  actorId: string
  businessDate: string
  occurredAt: string
}

export interface ConsumeRemadeOrderItemInventoryCommand extends ConsumeSubmittedOrderInventoryCommand {
  quantity: number
  reason: string
  idempotencyKey: string
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function safeMultiply(left: number, right: number) {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw new Error('配方耗用数量超出安全整数范围')
  return result
}

function activeRecipe(inventory: InventoryDomainState, productId: string) {
  const matches = inventory.recipeVersions.filter((item) => item.productId === productId && item.status === 'active')
  if (matches.length > 1) throw new Error(`商品存在多个生效配方：${productId}`)
  return matches[0]
}

function consumer(type: InventoryConsumptionType) {
  if (type === 'gift') return consumeInventoryForGift
  if (type === 'remake') return consumeInventoryForRemake
  return consumeInventoryForSale
}

interface ConsumeItemContext {
  order: Order
  item: OrderItem
  quantity: number
  type: InventoryConsumptionType
  reason: string
  actorId: string
  businessDate: string
  occurredAt: string
  keyPrefix: string
}

function consumeRecipe(
  inventory: InventoryDomainState,
  recipe: InventoryRecipeVersion,
  context: ConsumeItemContext,
) {
  return recipe.lines.map((line) => {
    const ingredient = inventory.ingredientSkus.find(
      (candidate) => candidate.id === line.ingredientSkuId && candidate.enabled,
    )
    if (!ingredient) throw new Error(`配方原料不存在或已停用：${line.ingredientSkuId}`)
    const balance = inventory.balances.find((candidate) => candidate.productId === ingredient.id)
    if (!balance) throw new Error(`配方原料尚未建立库存：${ingredient.name}`)
    if (balance.unitCode !== ingredient.baseUnitCode) throw new Error(`配方原料库存单位不一致：${ingredient.name}`)
    const idempotencyKey = `${context.keyPrefix}:recipe:${recipe.id}:${ingredient.id}`
    return consumer(context.type)(inventory, {
      movementId: deterministicId('inventory_movement', idempotencyKey),
      productId: ingredient.id,
      unitCode: ingredient.baseUnitCode,
      quantity: safeMultiply(line.standardQuantity, context.quantity),
      tableSessionId: context.order.tableSessionId,
      orderId: context.order.id,
      orderItemId: context.item.id,
      actorId: context.actorId,
      reason: context.reason,
      businessDate: context.businessDate,
      occurredAt: context.occurredAt,
      idempotencyKey,
      configurationSnapshot: {
        kind: 'recipe',
        consumptionType: context.type,
        orderedProductId: context.item.skuId,
        orderedProductName: context.item.name,
        orderedQuantity: context.quantity,
        recipe: structuredClone(recipe),
        ingredient: structuredClone(ingredient),
        recipeLine: structuredClone(line),
      },
    })
  })
}

function consumeDirect(inventory: InventoryDomainState, context: ConsumeItemContext) {
  const balance = inventory.balances.find((candidate) => candidate.productId === context.item.skuId)
  if (!balance) return []
  const idempotencyKey = context.keyPrefix
  return [consumer(context.type)(inventory, {
    movementId: deterministicId('inventory_movement', idempotencyKey),
    productId: context.item.skuId,
    unitCode: balance.unitCode,
    quantity: context.quantity,
    tableSessionId: context.order.tableSessionId,
    orderId: context.order.id,
    orderItemId: context.item.id,
    actorId: context.actorId,
    reason: context.reason,
    businessDate: context.businessDate,
    occurredAt: context.occurredAt,
    idempotencyKey,
    configurationSnapshot: {
      kind: 'direct_product',
      consumptionType: context.type,
      orderedProductId: context.item.skuId,
      orderedProductName: context.item.name,
      orderedQuantity: context.quantity,
      inventoryUnitCode: balance.unitCode,
    },
  })]
}

function consumeItem(inventory: InventoryDomainState, context: ConsumeItemContext) {
  const recipe = activeRecipe(inventory, context.item.skuId)
  return recipe ? consumeRecipe(inventory, recipe, context) : consumeDirect(inventory, context)
}

/**
 * Uses a working copy so an order with multiple products or recipe lines never
 * leaves a partial set of inventory movements.
 */
export function consumeManagedInventoryForSubmittedOrder(
  inventory: InventoryDomainState | undefined,
  order: Order,
  command: ConsumeSubmittedOrderInventoryCommand,
): InventoryMovement[] {
  if (!inventory) return []
  normalizeInventoryDomainState(inventory)
  const workingInventory = structuredClone(inventory)
  const movements = order.items.flatMap((item) => {
    const type = item.unitSalePriceAmount === 0 ? 'gift' : 'sale'
    const existing = workingInventory.movements.filter(
      (movement) => movement.orderId === order.id && movement.orderItemId === item.id && movement.type === type,
    )
    if (existing.length > 0) return existing
    return consumeItem(workingInventory, {
      order,
      item,
      quantity: item.quantity,
      type,
      reason: type === 'gift' ? '零价赠品订单提交自动出库' : '销售订单提交自动出库',
      actorId: command.actorId,
      businessDate: command.businessDate,
      occurredAt: command.occurredAt,
      keyPrefix: `inventory.order-submit:${order.id}:${item.id}:v1`,
    })
  })
  if (movements.length === 0) return []
  Object.assign(inventory, workingInventory)
  return movements
}

export function consumeManagedInventoryForRemadeOrderItem(
  inventory: InventoryDomainState,
  order: Order,
  item: OrderItem,
  command: ConsumeRemadeOrderItemInventoryCommand,
) {
  if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) throw new Error('补做数量必须是正安全整数')
  normalizeInventoryDomainState(inventory)
  const workingInventory = structuredClone(inventory)
  const movements = consumeItem(workingInventory, {
    order,
    item,
    quantity: command.quantity,
    type: 'remake',
    reason: command.reason,
    actorId: command.actorId,
    businessDate: command.businessDate,
    occurredAt: command.occurredAt,
    keyPrefix: `inventory.remake:${command.idempotencyKey}`,
  })
  if (movements.length === 0) throw new Error('补做商品未纳入整件库存且未配置生效配方')
  Object.assign(inventory, workingInventory)
  return movements
}
