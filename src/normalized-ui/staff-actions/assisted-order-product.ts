import type { AssistedOrderCatalogProduct } from './staff-actions-api'

export function assistedProductAvailability(product: AssistedOrderCatalogProduct): {
  soldOut: boolean
  enabled: boolean
} {
  const amountMinor = Number(product.standardPrice?.amountMinor ?? 0)
  return {
    soldOut: !product.isAvailable || !product.inventoryConfigurationComplete || !product.inventoryAvailable,
    enabled: product.isAvailable
      && product.inventoryConfigurationComplete
      && product.inventoryAvailable
      && Number.isSafeInteger(amountMinor)
      && amountMinor > 0,
  }
}
