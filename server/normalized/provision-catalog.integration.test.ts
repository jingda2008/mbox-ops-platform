import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { parseNormalizedCatalog, provisionNormalizedCatalog } from '../provision-normalized-catalog.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = 'ed000000-0000-4000-8000-000000000001'
const storeId = 'ed000000-0000-4000-8000-000000000002'
const sourceCommitSha = '27e9cba12947456ce83f8da16aa4eca63af731cf'

integration('normalized catalog provisioning', () => {
  let pool: Pool
  const catalog = parseNormalizedCatalog({
    version: 'integration-catalog-v1',
    source: 'integration verified source',
    products: [
      {
        preferredId: 'preferred-single', sku: 'INT-DRINK-1', name: '集成酒水', categoryId: 'drinks',
        stationId: 'bar-main', productKind: 'single', enabled: true, soldOut: false,
        guestVisible: true, listPriceAmount: 8800, costAmount: 1200, bundleComponents: [],
        recommendation: { enabled: true, upgradeProductId: 'preferred-bundle' },
      },
      {
        preferredId: 'preferred-bundle', sku: 'INT-BUNDLE-1', name: '集成组合', categoryId: 'bundles',
        stationId: 'bar-main', productKind: 'bundle', enabled: true, soldOut: false,
        guestVisible: true, listPriceAmount: 16800, costAmount: 2400,
        bundleComponents: [{ componentSku: 'INT-DRINK-1', quantity: 2 }],
        recommendation: { enabled: true, upgradeProductId: null },
      },
    ],
  })

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1,'catalog-int','Catalog Integration')
      ON CONFLICT (id) DO NOTHING`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1,$2,'catalog-int-store','Catalog Integration Store')
      ON CONFLICT (id) DO NOTHING`, [storeId, tenantId])
  })

  afterAll(async () => pool.end())

  it('applies products, prices and bundle links atomically and replays by content hash', async () => {
    const nextSourceCommitSha = '38fadcba2947456ce83f8da16aa4eca63af731cf'
    const first = await provisionNormalizedCatalog({ databaseUrl: databaseUrl!, tenantId, storeId, catalog, sourceCommitSha })
    const second = await provisionNormalizedCatalog({ databaseUrl: databaseUrl!, tenantId, storeId, catalog, sourceCommitSha })
    const nextRelease = await provisionNormalizedCatalog({
      databaseUrl: databaseUrl!, tenantId, storeId, catalog, sourceCommitSha: nextSourceCommitSha,
    })
    expect(first).toMatchObject({ productCount: 2, bundleCount: 1, componentCount: 1, replayed: false })
    expect(second).toMatchObject({ catalogSha256: first.catalogSha256, replayed: true })
    expect(nextRelease).toMatchObject({ catalogSha256: first.catalogSha256, replayed: true })

    const state = await pool.query<{
      products: string
      prices: string
      components: string
      applications: string
      bundle_station: string
      upgrade_product_id: string
      upgrade_database_id: string
      latest_source_commit_sha: string
    }>(`SELECT
      (SELECT count(*)::text FROM mbox.products WHERE tenant_id=$1 AND store_id=$2) AS products,
      (SELECT count(*)::text FROM mbox.product_prices WHERE tenant_id=$1 AND store_id=$2) AS prices,
      (SELECT count(*)::text FROM mbox.product_bundle_components WHERE tenant_id=$1 AND store_id=$2) AS components,
      (SELECT count(*)::text FROM mbox.product_catalog_applications WHERE tenant_id=$1 AND store_id=$2) AS applications,
      (SELECT fulfillment_station FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND code='INT-BUNDLE-1') AS bundle_station,
      (SELECT product_snapshot#>>'{recommendation,upgradeProductId}' FROM mbox.products
        WHERE tenant_id=$1 AND store_id=$2 AND code='INT-DRINK-1') AS upgrade_product_id,
      (SELECT id::text FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND code='INT-BUNDLE-1') AS upgrade_database_id,
      (SELECT source_commit_sha FROM mbox.product_catalog_applications
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY applied_at DESC LIMIT 1) AS latest_source_commit_sha`, [tenantId, storeId])
    expect(state.rows[0]).toMatchObject({
      products: '2', prices: '2', components: '1', applications: '2', bundle_station: 'none',
      latest_source_commit_sha: nextSourceCommitSha,
    })
    expect(state.rows[0]?.upgrade_product_id).toBe(state.rows[0]?.upgrade_database_id)

    const altered = parseNormalizedCatalog({
      version: catalog.version, source: catalog.source,
      products: catalog.products.map((product) => product.sku === 'INT-DRINK-1'
        ? { ...product.snapshot, ...product, name: '被篡改名称', bundleComponents: product.bundleComponents }
        : { ...product.snapshot, ...product, bundleComponents: product.bundleComponents }),
    })
    await expect(provisionNormalizedCatalog({
      databaseUrl: databaseUrl!, tenantId, storeId, catalog: altered, sourceCommitSha,
    })).rejects.toThrow(/different content/)
    const rollback = await pool.query<{ name: string }>(`
      SELECT name FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND code='INT-DRINK-1'`, [tenantId, storeId])
    expect(rollback.rows[0]?.name).toBe('集成酒水')
  })
})
