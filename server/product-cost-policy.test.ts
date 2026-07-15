import { describe, expect, it } from 'vitest'
import type { MenuProduct, ProductWriteInput } from '../src/shared/contracts.js'
import { preserveProtectedProductCost, productCostView } from './product-cost-policy.js'

const input: ProductWriteInput = {
  sku: 'SKU-1', name: '测试商品', specification: '1份', listPriceAmount: 8_800,
  costAmount: 0, stationId: 'bar-main', enabled: true,
}
const product: MenuProduct = { id: 'product-1', configVersion: 1, ...input, costAmount: 2_200 }

describe('product cost permissions', () => {
  it('preserves the stored cost when a menu administrator receives a redacted zero', () => {
    expect(preserveProtectedProductCost(input, 2_200, false).costAmount).toBe(2_200)
    expect(productCostView(product, false).costAmount).toBe(0)
  })

  it('allows a finance-authorized operator to change and view cost', () => {
    expect(preserveProtectedProductCost({ ...input, costAmount: 2_500 }, 2_200, true).costAmount).toBe(2_500)
    expect(productCostView(product, true).costAmount).toBe(2_200)
  })
})
