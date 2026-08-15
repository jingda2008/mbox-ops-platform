import type { MenuProduct } from '../shared/contracts'
import type { ProductAvailability } from '../shared/product-availability'

export function recommendationProductIsOrderable(
  product: MenuProduct,
  availability: ReadonlyMap<string, ProductAvailability>,
  serverValidatedGuestCatalog: boolean,
): boolean {
  if (product.guestVisible === false || availability.get(product.id)?.orderable !== true) return false
  if (product.productKind !== 'bundle' || serverValidatedGuestCatalog) return true
  return (product.bundleComponents ?? []).every((component) => (
    availability.get(component.productId)?.orderable === true
  ))
}
