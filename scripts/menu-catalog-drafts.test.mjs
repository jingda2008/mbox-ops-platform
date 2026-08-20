import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const catalog = JSON.parse(readFileSync(resolve(root, 'config/menu-catalog-drafts-2026-08-21.json'), 'utf8'))

test('2026-08 menu drafts remain inactive until costs, recipes and physical output are verified', () => {
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.deploymentPolicy, 'inactive-drafts-only')
  assert.equal(catalog.products.length, 56)
  assert.equal(new Set(catalog.products.map((product) => product.code)).size, 56)
  assert.deepEqual(
    Object.fromEntries(['food', 'signature', 'classic', 'packages'].map((category) => [
      category,
      catalog.products.filter((product) => product.categoryCode === category).length,
    ])),
    { food: 16, signature: 16, classic: 12, packages: 12 },
  )
  for (const product of catalog.products) {
    assert.equal(product.status, 'inactive', `${product.code} must not be sold before verification`)
    assert.equal(product.costAmountMinor, null, `${product.code} must not invent a cost`)
    assert.ok(Number.isSafeInteger(product.priceAmountMinor) && product.priceAmountMinor > 0)
    assert.ok(Array.isArray(product.activationBlockers) && product.activationBlockers.length > 0)
    assert.ok(product.imageUrl.startsWith('/menu/2026-08/items/'))
    assert.ok(existsSync(resolve(root, 'public', product.imageUrl.slice(1))), `${product.code} image missing`)
    if (product.productKind === 'bundle') assert.ok(product.componentCodes.length > 0)
  }
})
