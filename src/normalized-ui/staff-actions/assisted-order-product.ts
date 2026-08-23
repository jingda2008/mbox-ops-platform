import type { AssistedOrderCatalogProduct } from './staff-actions-api'

export function assistedProductAvailability(product: AssistedOrderCatalogProduct): {
  soldOut: boolean
  enabled: boolean
} {
  const amountMinor = Number(product.standardPrice?.amountMinor ?? 0)
  return {
    soldOut: !product.isAvailable || !product.inventoryConfigurationComplete || !product.inventoryAvailable,
    // AssistedOrderSheet has already admitted active catalog records. Keep a
    // priced entry visible here and express its operational state separately.
    enabled: Number.isSafeInteger(amountMinor) && amountMinor > 0,
  }
}
