import { createHash } from 'node:crypto'
import type { MenuProduct, RuntimeState } from '../src/shared/contracts.js'
import { productAvailability } from '../src/shared/product-availability.js'
import { addOrderItem } from './order-domain.js'
import { routeProductToEnabledWorkstation } from './fulfillment-workstations.js'

interface AddConfiguredProductOptions {
  orderId: string
  product: MenuProduct
  quantity: number
  actorId: string
  occurredAt: string
  idempotencyKey: string
  linePrefix: string
  saleMode?: 'sale' | 'gift'
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export function addConfiguredProductToOrder(state: RuntimeState, options: AddConfiguredProductOptions) {
  const { product, quantity } = options
  const isBundle = product.productKind === 'bundle'
  const parentLineId = deterministicId(options.linePrefix, `${options.idempotencyKey}:parent`)
  const parentRequiresFulfillment = !isBundle && product.requiresFulfillment !== false
  const parentStationId = parentRequiresFulfillment
    ? routeProductToEnabledWorkstation(state, product.stationId).id
    : product.stationId

  addOrderItem(state.orderDomain, {
    orderId: options.orderId,
    item: {
      id: parentLineId,
      skuId: product.id,
      name: product.name,
      specification: product.specification,
      quantity,
      unitListPriceAmount: product.listPriceAmount,
      unitSalePriceAmount: options.saleMode === 'gift' ? 0 : product.listPriceAmount,
      unitCostAmount: product.costAmount,
      stationId: parentStationId,
      commercialLine: true,
      parentOrderItemId: null,
      inventoryTracked: !isBundle,
      requiresFulfillment: parentRequiresFulfillment,
      configVersion: product.configVersion,
    },
    actorId: options.actorId,
    occurredAt: options.occurredAt,
    idempotencyKey: `${options.idempotencyKey}:parent`,
  })

  if (!isBundle) return { parentLineId, componentLineIds: [] }
  const components = product.bundleComponents ?? []
  if (components.length === 0) throw new Error(`${product.name}尚未配置组成商品，暂时不能下单`)
  const componentLineIds = components.map((component, componentIndex) => {
    const componentProduct = state.products.find((candidate) => candidate.id === component.productId && candidate.enabled)
    if (!componentProduct) throw new Error(`${product.name}包含已停用的组成商品，暂时不能下单`)
    if (componentProduct.productKind === 'bundle') throw new Error(`${product.name}包含嵌套组合，暂时不能下单`)
    const availability = productAvailability(componentProduct, new Date(options.occurredAt), state.store.timezone)
    if (!availability.orderable) throw new Error(`${product.name}暂时不能完整出品：${componentProduct.name}${availability.label}`)
    const componentQuantity = component.quantity * quantity
    if (!Number.isSafeInteger(componentQuantity) || componentQuantity <= 0) throw new Error(`${product.name}组成商品数量无效`)
    const requiresFulfillment = componentProduct.requiresFulfillment !== false
    const stationId = requiresFulfillment
      ? routeProductToEnabledWorkstation(state, componentProduct.stationId).id
      : componentProduct.stationId
    const lineId = deterministicId(options.linePrefix, `${options.idempotencyKey}:component:${componentIndex}`)
    addOrderItem(state.orderDomain, {
      orderId: options.orderId,
      item: {
        id: lineId,
        skuId: componentProduct.id,
        name: componentProduct.name,
        specification: componentProduct.specification,
        quantity: componentQuantity,
        unitListPriceAmount: 0,
        unitSalePriceAmount: 0,
        unitCostAmount: 0,
        stationId,
        commercialLine: false,
        parentOrderItemId: parentLineId,
        inventoryTracked: true,
        requiresFulfillment,
        configVersion: componentProduct.configVersion,
      },
      actorId: options.actorId,
      occurredAt: options.occurredAt,
      idempotencyKey: `${options.idempotencyKey}:component:${componentIndex}`,
    })
    return lineId
  })
  return { parentLineId, componentLineIds }
}
