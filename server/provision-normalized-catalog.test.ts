import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseNormalizedCatalog } from './provision-normalized-catalog.js'

const single = {
  preferredId: 'product_single', sku: 'DRINK-1', name: '测试酒水', categoryId: 'drinks',
  stationId: 'bar-main', productKind: 'single', enabled: true, soldOut: false,
  guestVisible: true, listPriceAmount: 8800, costAmount: 1200, bundleComponents: [],
  recommendation: { enabled: true, upgradeProductId: null },
}
const bundle = {
  preferredId: 'product_bundle', sku: 'BUNDLE-1', name: '测试组合', categoryId: 'bundles',
  stationId: 'bar-main', productKind: 'bundle', enabled: true, soldOut: false,
  guestVisible: true, listPriceAmount: 16800, costAmount: 2400,
  bundleComponents: [{ componentSku: 'DRINK-1', quantity: 2 }],
  recommendation: { enabled: true, upgradeProductId: null },
}

describe('normalized catalog provisioning config', () => {
  it('parses a structured catalog without treating list price as client data', () => {
    const parsed = parseNormalizedCatalog({ version: 'catalog-v1', source: 'verified workbook', products: [single, bundle] })
    expect(parsed.products).toHaveLength(2)
    expect(parsed.products[0]?.snapshot).not.toHaveProperty('listPriceAmount')
    expect(parsed.products[0]?.snapshot).toHaveProperty('costAmount', 1200)
    expect(parsed.products[1]?.bundleComponents).toEqual([{ componentSku: 'DRINK-1', quantity: 2, note: null }])
  })

  it('rejects duplicate SKUs, nested bundles and unknown upgrades', () => {
    expect(() => parseNormalizedCatalog({ version: 'v1', source: 'test', products: [single, single] })).toThrow(/duplicate product sku/)
    expect(() => parseNormalizedCatalog({ version: 'v1', source: 'test', products: [
      single, { ...bundle, bundleComponents: [{ componentSku: 'BUNDLE-1', quantity: 1 }] },
    ] })).toThrow(/invalid component/)
    expect(() => parseNormalizedCatalog({ version: 'v1', source: 'test', products: [
      { ...single, recommendation: { enabled: true, upgradeProductId: 'missing' } }, bundle,
    ] })).toThrow(/invalid recommendation/)
  })

  it('accepts the checked-in M-BOX catalog as a complete structured source', async () => {
    const source = JSON.parse(await readFile('config/menu-catalog-2026-07-27.json', 'utf8'))
    const parsed = parseNormalizedCatalog(source)
    expect(parsed.version).toBe('2026-07-27-v1')
    expect(parsed.products).toHaveLength(81)
    expect(parsed.products.filter((product) => product.productKind === 'bundle')).toHaveLength(17)
    expect(parsed.products.reduce((count, product) => count + product.bundleComponents.length, 0)).toBe(90)
  })
})
