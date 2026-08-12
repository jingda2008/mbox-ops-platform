import type { MenuProduct } from '../../shared/contracts'
import type { GuestMenuProduct } from './guest-model'

export function guestMenuProductToMenuProduct(product: GuestMenuProduct): MenuProduct {
  return {
    id: product.productId,
    sku: product.code,
    name: product.name,
    specification: product.specification ?? '',
    productKind: product.productKind,
    beverageFamily: product.beverageFamily,
    bundleComponents: product.bundleComponents.map((component) => ({
      productId: component.productId,
      quantity: component.quantity,
    })),
    substitutionProductIds: [],
    recommendation: {
      ...product.recommendation,
      enabled: product.recommendation.enabled && product.recommendation.contributionPositive,
    },
    categoryId: product.categoryCode,
    categoryName: product.categoryName,
    description: product.description ?? undefined,
    imageUrl: product.imageUrl ?? undefined,
    tags: [...product.tags],
    sortOrder: product.sortOrder,
    soldOut: !product.available,
    availableFrom: product.availableFrom,
    availableUntil: product.availableUntil,
    guestVisible: product.guestVisible,
    requiresFulfillment: product.requiresFulfillment,
    maxOrderQuantity: product.maxOrderQuantity,
    listPriceAmount: product.amountMinor,
    costAmount: product.recommendation.contributionPositive ? 0 : product.amountMinor,
    stationId: product.fulfillmentStation,
    enabled: product.available,
    configVersion: 1,
  }
}
