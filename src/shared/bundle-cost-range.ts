export interface BundleCostCatalogProduct {
  id: string
  costAmountMinor?: number | null
}

export interface BundleCostDefinition {
  bundleComponents?: ReadonlyArray<{ productId: string; quantity: number }>
  bundleChoiceGroups?: ReadonlyArray<{
    selectionCount: number
    options: ReadonlyArray<{ productId: string; quantity: number }>
  }>
}

export interface BundleCostRange {
  status: 'complete' | 'configuration_incomplete' | 'cost_incomplete'
  minimumCostMinor: number | null
  maximumCostMinor: number | null
  missingProductIds: string[]
}

/**
 * Calculates the possible per-package cost range from current single-product
 * costs. All configured options are included, including temporarily sold-out
 * ones, because they may become selectable again without a pricing change.
 * This is a configuration preview only; submitted orders freeze the exact
 * cost of the concrete options selected by the customer.
 */
export function calculateBundleCostRange(
  bundle: Readonly<BundleCostDefinition>,
  catalog: readonly Readonly<BundleCostCatalogProduct>[],
): BundleCostRange {
  const fixed = bundle.bundleComponents ?? []
  const groups = bundle.bundleChoiceGroups ?? []
  if (fixed.length === 0 && groups.length === 0) return incomplete('configuration_incomplete')

  const products = new Map(catalog.map((product) => [product.id, product]))
  const missing = new Set<string>()
  let minimum = 0
  let maximum = 0

  for (const component of fixed) {
    const lineCost = componentCost(component.productId, component.quantity, products, missing)
    if (lineCost === 'invalid') return incomplete('configuration_incomplete', missing)
    if (lineCost !== null) {
      minimum = addSafe(minimum, lineCost)
      maximum = addSafe(maximum, lineCost)
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
        return incomplete('configuration_incomplete', missing)
      }
    }
  }

  for (const group of groups) {
    if (!Number.isSafeInteger(group.selectionCount) || group.selectionCount < 1
      || group.options.length < group.selectionCount) {
      return incomplete('configuration_incomplete', missing)
    }
    const optionCosts: number[] = []
    for (const option of group.options) {
      const cost = componentCost(option.productId, option.quantity, products, missing)
      if (cost === 'invalid') return incomplete('configuration_incomplete', missing)
      if (cost !== null) optionCosts.push(cost)
    }
    if (optionCosts.length === group.options.length) {
      optionCosts.sort((left, right) => left - right)
      const groupMinimum = optionCosts.slice(0, group.selectionCount).reduce(addSafe, 0)
      const groupMaximum = optionCosts.slice(-group.selectionCount).reduce(addSafe, 0)
      minimum = addSafe(minimum, groupMinimum)
      maximum = addSafe(maximum, groupMaximum)
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
        return incomplete('configuration_incomplete', missing)
      }
    }
  }

  if (missing.size > 0) return incomplete('cost_incomplete', missing)
  return {
    status: 'complete',
    minimumCostMinor: minimum,
    maximumCostMinor: maximum,
    missingProductIds: [],
  }
}

export function conservativeBundleCostAmount(
  bundle: Readonly<BundleCostDefinition>,
  catalog: readonly Readonly<BundleCostCatalogProduct>[],
  listPriceMinor: number,
): number {
  const range = calculateBundleCostRange(bundle, catalog)
  return range.status === 'complete' && range.maximumCostMinor !== null
    ? range.maximumCostMinor
    : listPriceMinor
}

function componentCost(
  productId: string,
  quantity: number,
  products: ReadonlyMap<string, Readonly<BundleCostCatalogProduct>>,
  missing: Set<string>,
): number | null | 'invalid' {
  if (!Number.isSafeInteger(quantity) || quantity < 1) return 'invalid'
  const cost = products.get(productId)?.costAmountMinor
  if (!Number.isSafeInteger(cost) || Number(cost) < 0) {
    missing.add(productId)
    return null
  }
  const total = Number(cost) * quantity
  return Number.isSafeInteger(total) && total >= 0 ? total : 'invalid'
}

function addSafe(left: number, right: number): number {
  return left + right
}

function incomplete(
  status: Exclude<BundleCostRange['status'], 'complete'>,
  missing: ReadonlySet<string> = new Set(),
): BundleCostRange {
  return {
    status,
    minimumCostMinor: null,
    maximumCostMinor: null,
    missingProductIds: [...missing].sort(),
  }
}
