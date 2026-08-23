import { describe, expect, it } from 'vitest'
import type { AssistedOrderCatalogProduct } from './staff-actions-api'
import { assistedProductAvailability } from './assisted-order-product'

function product(
  inventoryConfigurationComplete: boolean,
  fulfillmentStation: AssistedOrderCatalogProduct['fulfillmentStation'] = 'bar',
  inventoryAvailable = true,
): AssistedOrderCatalogProduct {
  return {
    id: 'product-1', code: 'TEST-1YUAN', name: '一元联调商品', productKind: 'single',
    categoryCode: 'other', fulfillmentStation, guestVisible: false, maxOrderQuantity: 1,
    recommendationEnabled: false, recommendationPriority: 0, recommendationSceneTags: [],
    recommendationIntentTags: [], recommendationTasteTags: [], recommendationDwellTags: [],
    recommendationMinGuests: null, recommendationMaxGuests: null,
    recommendationSingleWaveEligible: false, recommendationExpectedPrepMinutes: null,
    recommendationHoldMinutes: null, recommendationUpgradeProductId: null,
    menuSortOrder: 0, availableFrom: null, availableUntil: null,
    standardPrice: { amountMinor: '100', currency: 'CNY' }, costAmountMinor: null,
    bundleComponents: [], productSnapshot: {}, isAvailable: true,
    inventoryConfigurationComplete,
    inventoryAvailable,
  }
}

describe('assistedProductAvailability', () => {
  it('keeps a priced product visible but prevents submission when fulfillment configuration is incomplete', () => {
    const availability = assistedProductAvailability(product(false))

    expect(availability).toEqual({ soldOut: true, enabled: true })
  })

  it('allows a configured non-fulfillment test product to enter the payment flow', () => {
    const availability = assistedProductAvailability(product(true, 'none'))

    expect(availability).toEqual({ soldOut: false, enabled: true })
  })

  it('shows a configured product as sold out when available stock is exhausted', () => {
    expect(assistedProductAvailability(product(true, 'bar', false)))
      .toEqual({ soldOut: true, enabled: true })
  })
})
