import { describe, expect, it } from 'vitest'
import { calculateBundleCostRange, conservativeBundleCostAmount } from '../shared/bundle-cost-range.js'

const catalog = [
  { id: 'snack', costAmountMinor: 1_800 },
  { id: 'cocktail-a', costAmountMinor: 2_200 },
  { id: 'cocktail-b', costAmountMinor: 3_500 },
  { id: 'shot', costAmountMinor: 600 },
]

describe('calculateBundleCostRange', () => {
  it('adds fixed products and the cheapest-to-most-expensive valid selections', () => {
    expect(calculateBundleCostRange({
      bundleComponents: [{ productId: 'snack', quantity: 1 }],
      bundleChoiceGroups: [{
        selectionCount: 1,
        options: [
          { productId: 'cocktail-a', quantity: 1 },
          { productId: 'cocktail-b', quantity: 1 },
        ],
      }, {
        selectionCount: 2,
        options: [
          { productId: 'shot', quantity: 1 },
          { productId: 'cocktail-a', quantity: 1 },
          { productId: 'cocktail-b', quantity: 1 },
        ],
      }],
    }, catalog)).toEqual({
      status: 'complete',
      minimumCostMinor: 6_800,
      maximumCostMinor: 11_000,
      missingProductIds: [],
    })
  })

  it('does not invent a range when any configured option cost is missing', () => {
    expect(calculateBundleCostRange({
      bundleChoiceGroups: [{
        selectionCount: 1,
        options: [
          { productId: 'cocktail-a', quantity: 1 },
          { productId: 'unknown', quantity: 1 },
        ],
      }],
    }, catalog)).toEqual({
      status: 'cost_incomplete',
      minimumCostMinor: null,
      maximumCostMinor: null,
      missingProductIds: ['unknown'],
    })
  })

  it('rejects an incomplete choice configuration instead of understating cost', () => {
    expect(calculateBundleCostRange({
      bundleChoiceGroups: [{
        selectionCount: 2,
        options: [{ productId: 'cocktail-a', quantity: 1 }],
      }],
    }, catalog).status).toBe('configuration_incomplete')
  })

  it('uses the list price as a conservative recommendation cost when authority is incomplete', () => {
    expect(conservativeBundleCostAmount({
      bundleChoiceGroups: [{
        selectionCount: 1,
        options: [{ productId: 'unknown', quantity: 1 }],
      }],
    }, catalog, 19_800)).toBe(19_800)
  })
})
