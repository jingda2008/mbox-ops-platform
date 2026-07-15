import type { MenuProduct, ProductWriteInput } from '../src/shared/contracts.js'

export function preserveProtectedProductCost(
  input: ProductWriteInput,
  currentCostAmount: number,
  canViewFinance: boolean,
): ProductWriteInput {
  return canViewFinance ? input : { ...input, costAmount: currentCostAmount }
}

export function productCostView(product: MenuProduct, canViewFinance: boolean): MenuProduct {
  return canViewFinance ? product : { ...product, costAmount: 0 }
}
