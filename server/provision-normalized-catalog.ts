import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import type { JsonObject } from './normalized/command-executor.js'
import {
  extractProductOperationalFields,
  type ProductOperationalFields,
} from './normalized/product-operational-fields.js'

export interface NormalizedCatalogProduct {
  sku: string
  name: string
  categoryId: string
  stationId: 'bar-main' | 'kitchen-cold'
  productKind: 'single' | 'bundle'
  enabled: boolean
  soldOut: boolean
  guestVisible: boolean
  listPriceAmount: number
  costAmount: number
  preferredId?: string | null
  bundleComponents: Array<{ componentSku: string; quantity: number; note?: string | null }>
  snapshot: Record<string, unknown>
}

export interface NormalizedCatalogConfig {
  version: string
  source: string
  products: NormalizedCatalogProduct[]
}

export interface CatalogProvisionSummary {
  catalogVersion: string
  catalogSha256: string
  productCount: number
  activeProductCount: number
  bundleCount: number
  componentCount: number
  replayed: boolean
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export function parseNormalizedCatalog(value: unknown): NormalizedCatalogConfig {
  const root = record(value, 'catalog')
  const version = requiredText(root.version, 'version', 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new TypeError('version is invalid')
  const source = requiredText(root.source, 'source', 500)
  if (!Array.isArray(root.products) || root.products.length < 1 || root.products.length > 2_000) {
    throw new TypeError('products must contain between 1 and 2000 entries')
  }
  const products = root.products.map((entry, index) => parseProduct(entry, index))
  assertUnique(products.map((product) => product.sku), 'product sku')
  const bySku = new Map(products.map((product) => [product.sku, product]))
  const byPreferredId = new Map(products.flatMap((product) => product.preferredId
    ? [[product.preferredId, product] as const]
    : []))
  if (byPreferredId.size !== products.filter((product) => product.preferredId).length) {
    throw new TypeError('duplicate preferredId')
  }
  for (const product of products) {
    if (product.productKind === 'single' && product.bundleComponents.length > 0) {
      throw new TypeError(`single product ${product.sku} cannot have bundle components`)
    }
    if (product.productKind === 'bundle' && product.bundleComponents.length === 0) {
      throw new TypeError(`bundle product ${product.sku} must have components`)
    }
    assertUnique(product.bundleComponents.map((component) => component.componentSku), `component in ${product.sku}`)
    for (const component of product.bundleComponents) {
      const target = bySku.get(component.componentSku)
      if (!target || target.productKind !== 'single' || target.sku === product.sku) {
        throw new TypeError(`bundle ${product.sku} references invalid component ${component.componentSku}`)
      }
    }
    const recommendation = recordOrNull(product.snapshot.recommendation)
    const upgradeProductId = recommendation?.upgradeProductId
    if (upgradeProductId !== null && upgradeProductId !== undefined
      && (typeof upgradeProductId !== 'string' || !byPreferredId.has(upgradeProductId))) {
      throw new TypeError(`product ${product.sku} has an invalid recommendation upgradeProductId`)
    }
  }
  return { version, source, products }
}

export async function provisionNormalizedCatalog(input: {
  databaseUrl: string
  tenantId: string
  storeId: string
  catalog: NormalizedCatalogConfig
  sourceCommitSha?: string
  client?: Client
}): Promise<CatalogProvisionSummary> {
  requireUuid(input.tenantId, 'tenantId')
  requireUuid(input.storeId, 'storeId')
  const sourceCommitSha = input.sourceCommitSha ?? process.env.APP_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (!sourceCommitSha || !/^[0-9a-f]{7,64}$/i.test(sourceCommitSha)) {
    throw new Error('APP_COMMIT_SHA is required for versioned catalog provisioning')
  }
  const normalizedSourceCommitSha = sourceCommitSha.toLowerCase()
  const catalogSha256 = createHash('sha256').update(stableJson(input.catalog), 'utf8').digest('hex')
  const summaryBase = catalogSummary(input.catalog, catalogSha256)
  const ownsClient = input.client === undefined
  const client = input.client ?? new Client({ connectionString: input.databaseUrl, application_name: 'mbox-normalized-catalog-provisioner' })
  if (ownsClient) await client.connect()
  try {
    // The global advisory lock is the serialization boundary. READ COMMITTED is
    // required so a provisioner that waited for the lock observes the release
    // that just committed instead of failing on a stale SERIALIZABLE snapshot.
    if (ownsClient) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mbox.normalized.configuration.provision'))`)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mbox.normalized.catalog.provision'))`)
    const schema = await client.query<{ schema_flavor: string; schema_version: string }>(
      'SELECT schema_flavor, schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true',
    )
    if (schema.rows[0]?.schema_flavor !== 'normalized-core-v1' || Number(schema.rows[0]?.schema_version ?? 0) < 44) {
      throw new Error('Normalized schema 044 or later is required')
    }
    const store = await client.query<{ currency: string }>(`
      SELECT currency FROM mbox.stores WHERE tenant_id=$1 AND id=$2 AND status='active' FOR UPDATE`, [
      input.tenantId, input.storeId,
    ])
    const currency = store.rows[0]?.currency
    if (!currency) throw new Error('Active target store was not found')
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`, [
      input.tenantId, input.storeId,
    ])
    const existing = await client.query<{ catalog_sha256: string; source_commit_sha: string }>(`
      SELECT catalog_sha256, source_commit_sha FROM mbox.product_catalog_applications
      WHERE tenant_id=$1 AND store_id=$2 AND catalog_version=$3 FOR UPDATE`, [
      input.tenantId, input.storeId, input.catalog.version,
    ])
    if (existing.rows.some((application) => application.catalog_sha256 !== catalogSha256)) {
      throw new Error('Catalog version already exists with different content')
    }
    if (existing.rows.some((application) => application.source_commit_sha === normalizedSourceCommitSha)) {
      if (ownsClient) await client.query('COMMIT')
      return { ...summaryBase, replayed: true }
    }
    if (existing.rows.length > 0) {
      await insertCatalogApplication(client, input, catalogSha256, normalizedSourceCommitSha, summaryBase)
      if (ownsClient) await client.query('COMMIT')
      return { ...summaryBase, replayed: true }
    }
    await client.query('DELETE FROM mbox.product_bundle_components WHERE tenant_id=$1 AND store_id=$2', [input.tenantId, input.storeId])
    const productIds = new Map<string, string>()
    const preferredIds = new Map<string, string>()
    for (const product of input.catalog.products) {
      const operational = extractProductOperationalFields(snapshotWithoutUpgrade(product.snapshot) as JsonObject, {
        code: product.sku,
        name: product.name,
      })
      const result = await client.query<{ id: string }>(`INSERT INTO mbox.products(
          tenant_id, store_id, code, name, category_code, fulfillment_station, product_kind,
          product_snapshot, status, guest_visible, search_text, recommendation_enabled,
          recommendation_min_guests, recommendation_max_guests, recommendation_priority,
          recommendation_scene_tags, recommendation_intent_tags, recommendation_taste_tags,
          recommendation_dwell_tags, recommendation_single_wave_eligible,
          recommendation_expected_prep_minutes, recommendation_hold_minutes,
          recommendation_upgrade_product_id, menu_sort_order, available_from, available_until,
          allowed_channels, max_order_quantity, kds_priority, fulfillment_sla_seconds, cost_amount_minor)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,
          $16::text[],$17::text[],$18::text[],$19::text[],$20,$21,$22,$23::uuid,
          $24,$25::time,$26::time,$27::text[],$28,$29,$30,$31)
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name=EXCLUDED.name,
          category_code=EXCLUDED.category_code, fulfillment_station=EXCLUDED.fulfillment_station,
          product_kind=EXCLUDED.product_kind, product_snapshot=EXCLUDED.product_snapshot, status=EXCLUDED.status,
          guest_visible=EXCLUDED.guest_visible, search_text=EXCLUDED.search_text,
          recommendation_enabled=EXCLUDED.recommendation_enabled,
          recommendation_min_guests=EXCLUDED.recommendation_min_guests,
          recommendation_max_guests=EXCLUDED.recommendation_max_guests,
          recommendation_priority=EXCLUDED.recommendation_priority,
          recommendation_scene_tags=EXCLUDED.recommendation_scene_tags,
          recommendation_intent_tags=EXCLUDED.recommendation_intent_tags,
          recommendation_taste_tags=EXCLUDED.recommendation_taste_tags,
          recommendation_dwell_tags=EXCLUDED.recommendation_dwell_tags,
          recommendation_single_wave_eligible=EXCLUDED.recommendation_single_wave_eligible,
          recommendation_expected_prep_minutes=EXCLUDED.recommendation_expected_prep_minutes,
          recommendation_hold_minutes=EXCLUDED.recommendation_hold_minutes,
          recommendation_upgrade_product_id=EXCLUDED.recommendation_upgrade_product_id,
          menu_sort_order=EXCLUDED.menu_sort_order, available_from=EXCLUDED.available_from,
          available_until=EXCLUDED.available_until, allowed_channels=EXCLUDED.allowed_channels,
          max_order_quantity=EXCLUDED.max_order_quantity, kds_priority=EXCLUDED.kds_priority,
          fulfillment_sla_seconds=EXCLUDED.fulfillment_sla_seconds,
          cost_amount_minor=EXCLUDED.cost_amount_minor, updated_at=clock_timestamp()
        RETURNING id`, [input.tenantId, input.storeId, product.sku, product.name, product.categoryId,
      station(product), product.productKind, JSON.stringify(persistedDisplaySnapshot(operational)), status(product),
      operational.guestVisible, operational.searchText, operational.recommendationEnabled,
      operational.recommendationMinGuests, operational.recommendationMaxGuests,
      operational.recommendationPriority, operational.recommendationSceneTags,
      operational.recommendationIntentTags, operational.recommendationTasteTags,
      operational.recommendationDwellTags, operational.recommendationSingleWaveEligible,
      operational.recommendationExpectedPrepMinutes, operational.recommendationHoldMinutes,
      operational.recommendationUpgradeProductId, operational.menuSortOrder,
      operational.availableFrom, operational.availableUntil, operational.allowedChannels,
      operational.maxOrderQuantity, operational.kdsPriority, operational.fulfillmentSlaSeconds,
      operational.costAmountMinor])
      const id = result.rows[0]?.id
      if (!id) throw new Error(`Unable to provision product ${product.sku}`)
      productIds.set(product.sku, id)
      if (product.preferredId) preferredIds.set(product.preferredId, id)
    }
    await client.query(`UPDATE mbox.products SET status='inactive'
      WHERE tenant_id=$1 AND store_id=$2 AND NOT (code=ANY($3::text[]))`, [
      input.tenantId, input.storeId, input.catalog.products.map((product) => product.sku),
    ])
    const effective = await client.query<{ value: string }>('SELECT clock_timestamp()::text AS value')
    const effectiveAt = effective.rows[0]?.value
    if (!effectiveAt) throw new Error('Unable to read catalog effective timestamp')
    for (const product of input.catalog.products) {
      const productId = productIds.get(product.sku)
      const snapshot = translateSnapshot(product.snapshot, preferredIds)
      const operational = extractProductOperationalFields(snapshot as JsonObject, { code: product.sku, name: product.name })
      await client.query(`UPDATE mbox.products SET product_snapshot=$4::jsonb,
        guest_visible=$5, search_text=$6, recommendation_enabled=$7,
        recommendation_min_guests=$8, recommendation_max_guests=$9, recommendation_priority=$10,
        recommendation_scene_tags=$11::text[], recommendation_intent_tags=$12::text[],
        recommendation_taste_tags=$13::text[], recommendation_dwell_tags=$14::text[],
        recommendation_single_wave_eligible=$15, recommendation_expected_prep_minutes=$16,
        recommendation_hold_minutes=$17, recommendation_upgrade_product_id=$18::uuid,
        menu_sort_order=$19, available_from=$20::time, available_until=$21::time,
        allowed_channels=$22::text[], max_order_quantity=$23, kds_priority=$24,
        fulfillment_sla_seconds=$25, cost_amount_minor=$26
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [
        input.tenantId, input.storeId, productId, JSON.stringify(persistedDisplaySnapshot(operational)),
        operational.guestVisible, operational.searchText, operational.recommendationEnabled,
        operational.recommendationMinGuests, operational.recommendationMaxGuests,
        operational.recommendationPriority, operational.recommendationSceneTags,
        operational.recommendationIntentTags, operational.recommendationTasteTags,
        operational.recommendationDwellTags, operational.recommendationSingleWaveEligible,
        operational.recommendationExpectedPrepMinutes, operational.recommendationHoldMinutes,
        operational.recommendationUpgradeProductId, operational.menuSortOrder,
        operational.availableFrom, operational.availableUntil, operational.allowedChannels,
        operational.maxOrderQuantity, operational.kdsPriority, operational.fulfillmentSlaSeconds,
        operational.costAmountMinor,
      ])
      await client.query(`UPDATE mbox.product_prices SET valid_until=$5::timestamptz
        WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND price_type='standard' AND currency=$4
          AND valid_from < $5::timestamptz AND (valid_until IS NULL OR valid_until > $5::timestamptz)`, [
        input.tenantId, input.storeId, productId, currency, effectiveAt,
      ])
      await client.query(`INSERT INTO mbox.product_prices(
          tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from)
        VALUES ($1,$2,$3,'standard',$4,$5,$6::timestamptz)`, [
        input.tenantId, input.storeId, productId, product.listPriceAmount, currency, effectiveAt,
      ])
    }
    for (const bundle of input.catalog.products.filter((product) => product.productKind === 'bundle')) {
      for (const [index, component] of bundle.bundleComponents.entries()) {
        await client.query(`INSERT INTO mbox.product_bundle_components(
            tenant_id, store_id, bundle_product_id, component_product_id, quantity, sort_order, note)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.tenantId, input.storeId, productIds.get(bundle.sku),
        productIds.get(component.componentSku), component.quantity, index, component.note ?? null])
      }
    }
    await insertCatalogApplication(client, input, catalogSha256, normalizedSourceCommitSha, summaryBase)
    if (ownsClient) await client.query('COMMIT')
    return { ...summaryBase, replayed: false }
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    if (ownsClient) await client.end()
  }
}

async function insertCatalogApplication(
  client: Client,
  input: { tenantId: string; storeId: string; catalog: NormalizedCatalogConfig },
  catalogSha256: string,
  sourceCommitSha: string,
  summary: Omit<CatalogProvisionSummary, 'replayed'>,
): Promise<void> {
  await client.query(`INSERT INTO mbox.product_catalog_applications(
      tenant_id, store_id, catalog_version, catalog_sha256, source_commit_sha,
      source_description, product_count, summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [input.tenantId, input.storeId,
  input.catalog.version, catalogSha256, sourceCommitSha, input.catalog.source,
  input.catalog.products.length, JSON.stringify(summary)])
  await client.query(`INSERT INTO mbox.audit_events(
      tenant_id, store_id, actor_type, actor_ref, action, object_type, object_id,
      business_date, after_snapshot, reason)
    VALUES ($1,$2,'system','normalized-catalog-provisioner','catalog.provisioned','catalog',$3,
      (clock_timestamp() AT TIME ZONE 'Asia/Shanghai' - interval '6 hours')::date,$4::jsonb,$5)`, [
    input.tenantId, input.storeId, input.catalog.version, JSON.stringify(summary), 'Versioned normalized catalog applied',
  ])
}

function parseProduct(value: unknown, index: number): NormalizedCatalogProduct {
  const item = record(value, `products[${index}]`)
  const sku = requiredText(item.sku, `products[${index}].sku`, 64)
  if (!CODE.test(sku)) throw new TypeError(`products[${index}].sku is invalid`)
  const categoryId = requiredText(item.categoryId, `products[${index}].categoryId`, 64)
  if (!CODE.test(categoryId)) throw new TypeError(`products[${index}].categoryId is invalid`)
  const stationId = item.stationId
  if (stationId !== 'bar-main' && stationId !== 'kitchen-cold') throw new TypeError(`products[${index}].stationId is invalid`)
  const productKind = item.productKind
  if (productKind !== 'single' && productKind !== 'bundle') throw new TypeError(`products[${index}].productKind is invalid`)
  const bundleComponents = array(item.bundleComponents, `products[${index}].bundleComponents`).map((entry, componentIndex) => {
    const component = record(entry, `products[${index}].bundleComponents[${componentIndex}]`)
    const componentSku = requiredText(component.componentSku, `products[${index}].bundleComponents[${componentIndex}].componentSku`, 64)
    if (!CODE.test(componentSku)) throw new TypeError(`products[${index}].bundleComponents[${componentIndex}].componentSku is invalid`)
    return {
      componentSku,
      quantity: integer(component.quantity, `products[${index}].bundleComponents[${componentIndex}].quantity`, 1, 999),
      note: optionalText(component.note, `products[${index}].bundleComponents[${componentIndex}].note`, 500),
    }
  })
  const snapshot = jsonObject(item, `products[${index}]`)
  delete snapshot.bundleComponents
  delete snapshot.listPriceAmount
  return {
    sku,
    name: requiredText(item.name, `products[${index}].name`, 160),
    categoryId,
    stationId,
    productKind,
    enabled: boolean(item.enabled, `products[${index}].enabled`),
    soldOut: boolean(item.soldOut, `products[${index}].soldOut`),
    guestVisible: boolean(item.guestVisible, `products[${index}].guestVisible`),
    listPriceAmount: integer(item.listPriceAmount, `products[${index}].listPriceAmount`, 0, Number.MAX_SAFE_INTEGER),
    costAmount: integer(item.costAmount, `products[${index}].costAmount`, 0, Number.MAX_SAFE_INTEGER),
    preferredId: optionalText(item.preferredId, `products[${index}].preferredId`, 128),
    bundleComponents,
    snapshot,
  }
}

function translateSnapshot(snapshot: Record<string, unknown>, preferredIds: ReadonlyMap<string, string>): Record<string, unknown> {
  const translated = structuredClone(snapshot)
  const recommendation = recordOrNull(translated.recommendation)
  if (recommendation && typeof recommendation.upgradeProductId === 'string') {
    recommendation.upgradeProductId = preferredIds.get(recommendation.upgradeProductId) ?? null
  }
  if (Array.isArray(translated.substitutionProductIds)) {
    translated.substitutionProductIds = translated.substitutionProductIds.flatMap((id) => (
      typeof id === 'string' && preferredIds.has(id) ? [preferredIds.get(id)!] : []
    ))
  }
  return translated
}

function snapshotWithoutUpgrade(snapshot: Record<string, unknown>): Record<string, unknown> {
  const prepared = structuredClone(snapshot)
  const recommendation = recordOrNull(prepared.recommendation)
  if (recommendation) recommendation.upgradeProductId = null
  return prepared
}

function persistedDisplaySnapshot(fields: Readonly<ProductOperationalFields>): JsonObject {
  return fields.displaySnapshot
}

function station(product: NormalizedCatalogProduct): 'bar' | 'kitchen' | 'none' {
  if (product.productKind === 'bundle') return 'none'
  return product.stationId === 'bar-main' ? 'bar' : 'kitchen'
}

function status(product: NormalizedCatalogProduct): 'active' | 'sold_out' | 'inactive' {
  if (!product.enabled) return 'inactive'
  return product.soldOut ? 'sold_out' : 'active'
}

function catalogSummary(catalog: NormalizedCatalogConfig, catalogSha256: string): Omit<CatalogProvisionSummary, 'replayed'> {
  return {
    catalogVersion: catalog.version,
    catalogSha256,
    productCount: catalog.products.length,
    activeProductCount: catalog.products.filter((product) => status(product) === 'active').length,
    bundleCount: catalog.products.filter((product) => product.productKind === 'bundle').length,
    componentCount: catalog.products.reduce((total, product) => total + product.bundleComponents.length, 0),
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}
function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function array(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`); return value }
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max) throw new TypeError(`${field} is invalid`)
  return value.trim()
}
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  return requiredText(value, field, max)
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${field} is invalid`)
  return Number(value)
}
function boolean(value: unknown, field: string): boolean { if (typeof value !== 'boolean') throw new TypeError(`${field} is invalid`); return value }
function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const cloned = structuredClone(record(value, field))
  try { JSON.stringify(cloned) } catch { throw new TypeError(`${field} must be valid JSON`) }
  return cloned
}
function assertUnique(values: string[], field: string): void { if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${field}`) }
function requireUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new TypeError(`${field} must be a UUID`)
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const configArgument = process.argv.find((entry) => entry.startsWith('--config='))?.slice('--config='.length)
  const databaseUrl = process.env.DATABASE_URL
  const tenantId = process.env.MBOX_TENANT_ID
  const storeId = process.env.MBOX_STORE_ID
  if (!configArgument || !databaseUrl || !tenantId || !storeId) {
    throw new Error('DATABASE_URL, MBOX_TENANT_ID, MBOX_STORE_ID and --config are required')
  }
  const catalog = parseNormalizedCatalog(JSON.parse(await readFile(resolve(configArgument), 'utf8')))
  const summary = await provisionNormalizedCatalog({ databaseUrl, tenantId, storeId, catalog })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
