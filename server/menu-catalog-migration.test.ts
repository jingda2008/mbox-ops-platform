import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  applyMenuCatalogMigration,
  menuCatalogMigrationAction,
} from './menu-catalog-migration.js'

describe('menu catalog migration', () => {
  it('imports the versioned catalog once with costs and valid bundle components', () => {
    const state = createSeedState(new Date('2026-07-27T12:00:00+08:00'))

    expect(applyMenuCatalogMigration(state)).toBe(true)
    const imported = state.products.filter((product) => /^(V2|V3)-/.test(product.sku))
    expect(imported).toHaveLength(81)
    expect(imported.every((product) => product.costAmount > 0)).toBe(true)
    const ids = new Set(state.products.map((product) => product.id))
    expect(imported.flatMap((product) => product.bundleComponents ?? [])
      .every((component) => ids.has(component.productId))).toBe(true)
    expect(state.auditEntries.filter((entry) => entry.action === menuCatalogMigrationAction)).toHaveLength(1)

    expect(applyMenuCatalogMigration(state)).toBe(false)
    expect(state.products.filter((product) => /^(V2|V3)-/.test(product.sku))).toHaveLength(81)
    expect(state.auditEntries.filter((entry) => entry.action === menuCatalogMigrationAction)).toHaveLength(1)
  })

  it('does not overwrite later administrator changes after the migration marker exists', () => {
    const state = createSeedState(new Date('2026-07-27T12:00:00+08:00'))
    applyMenuCatalogMigration(state)
    const product = state.products.find((item) => item.sku === 'V2-BUNDLE-COCKTAIL-2')!
    product.name = '管理员调整后的名称'
    product.listPriceAmount = 63800

    applyMenuCatalogMigration(state)

    expect(product.name).toBe('管理员调整后的名称')
    expect(product.listPriceAmount).toBe(63800)
  })
})
