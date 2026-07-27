import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  productWriteSchema,
  type MenuProduct,
  type RuntimeState,
} from '../src/shared/contracts.js'

export const menuCatalogMigrationAction = 'runtime.menu_catalog_2026_07_27_v1_imported.v1'

const manifestComponentSchema = z.object({
  componentSku: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(9999),
})

const manifestProductSchema = z.object({
  preferredId: z.string().trim().min(1).max(128),
  configVersion: z.number().int().min(1),
  bundleComponents: z.array(manifestComponentSchema).max(50),
}).catchall(z.unknown())

const manifestSchema = z.object({
  version: z.string().trim().min(1).max(80),
  source: z.string().trim().min(1).max(240),
  products: z.array(manifestProductSchema).min(1).max(500),
})

type MenuCatalogManifest = z.infer<typeof manifestSchema>

let cachedManifest: MenuCatalogManifest | null = null

function menuCatalogManifest() {
  if (cachedManifest) return cachedManifest
  const raw = readFileSync(
    new URL('../config/menu-catalog-2026-07-27.json', import.meta.url),
    'utf8',
  )
  cachedManifest = manifestSchema.parse(JSON.parse(raw))
  return cachedManifest
}

function operationalAvailability(existing: MenuProduct | undefined) {
  if (!existing) return {}
  return {
    soldOut: existing.soldOut,
    soldOutReason: existing.soldOutReason,
    availableFrom: existing.availableFrom,
    availableUntil: existing.availableUntil,
  }
}

export function applyMenuCatalogMigration(state: RuntimeState) {
  if (state.auditEntries.some((entry) => entry.action === menuCatalogMigrationAction)) return false

  const manifest = menuCatalogManifest()
  const existingBySku = new Map(state.products.map((product) => [product.sku, product]))
  const actualIdByPreferredId = new Map(
    manifest.products.map((product) => [
      product.preferredId,
      existingBySku.get(String(product.sku))?.id ?? product.preferredId,
    ]),
  )
  const actualIdBySku = new Map(
    manifest.products.map((product) => [
      String(product.sku),
      actualIdByPreferredId.get(product.preferredId)!,
    ]),
  )
  const migratedBySku = new Map<string, MenuProduct>()

  for (const rawProduct of manifest.products) {
    const {
      preferredId,
      configVersion,
      bundleComponents,
      ...unresolvedProduct
    } = rawProduct
    const sku = String(unresolvedProduct.sku)
    const existing = existingBySku.get(sku)
    const recommendation = unresolvedProduct.recommendation as Record<string, unknown> | undefined
    const substitutionProductIds = Array.isArray(unresolvedProduct.substitutionProductIds)
      ? unresolvedProduct.substitutionProductIds.map((id) => actualIdByPreferredId.get(String(id)) ?? String(id))
      : []
    const resolved = productWriteSchema.parse({
      ...unresolvedProduct,
      ...operationalAvailability(existing),
      bundleComponents: bundleComponents.map((component) => ({
        productId: actualIdBySku.get(component.componentSku) ?? '',
        quantity: component.quantity,
      })),
      substitutionProductIds,
      recommendation: recommendation
        ? {
            ...recommendation,
            upgradeProductId: recommendation.upgradeProductId
              ? actualIdByPreferredId.get(String(recommendation.upgradeProductId))
                ?? String(recommendation.upgradeProductId)
              : null,
          }
        : undefined,
    })
    migratedBySku.set(sku, {
      id: existing?.id ?? preferredId,
      ...resolved,
      configVersion: existing
        ? Math.max(existing.configVersion + 1, configVersion)
        : configVersion,
    })
  }

  const replacedSkus = new Set(migratedBySku.keys())
  state.products = [
    ...state.products.map((product) => migratedBySku.get(product.sku) ?? product),
    ...manifest.products
      .filter((product) => !existingBySku.has(String(product.sku)))
      .map((product) => migratedBySku.get(String(product.sku))!),
  ]
  if (new Set(state.products.map((product) => product.id)).size !== state.products.length) {
    throw new Error('菜单迁移产生了重复商品ID')
  }
  if (new Set(state.products.map((product) => product.sku)).size !== state.products.length) {
    throw new Error('菜单迁移产生了重复商品SKU')
  }
  const productIds = new Set(state.products.map((product) => product.id))
  for (const product of state.products.filter((item) => replacedSkus.has(item.sku))) {
    for (const component of product.bundleComponents ?? []) {
      if (!productIds.has(component.productId)) {
        throw new Error(`菜单迁移后的组合商品 ${product.sku} 存在无效组件`)
      }
    }
  }

  state.auditEntries.push({
    id: 'runtime-migration-menu-catalog-2026-07-27-v1',
    actorId: 'system',
    action: menuCatalogMigrationAction,
    objectType: 'productCatalog',
    objectId: manifest.version,
    occurredAt: new Date().toISOString(),
    details: {
      source: manifest.source,
      productCount: manifest.products.length,
      strategy: 'sku-upsert-once-preserve-operational-availability',
    },
  })
  return true
}
