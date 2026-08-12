import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { parseNormalizedCatalog, provisionNormalizedCatalog } from '../provision-normalized-catalog.js'
import { parseStoreProvisionConfig, provisionNormalizedStore } from '../provision-normalized-store.js'
import { inspectCommercialReadiness } from '../verify-normalized-commercial-readiness.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const sourceCommitSha = '27e9cba12947456ce83f8da16aa4eca63af731cf'

integration('current M-BOX commercial configuration', () => {
  it('loads the versioned store and catalog into a clean database with explicit validation controls', async () => {
    await runNormalizedMigrations(databaseUrl!)
    const store = parseStoreProvisionConfig(JSON.parse(await readFile(
      resolve('deploy/normalized-store/mbox-lujiazui.store.json'), 'utf8',
    )))
    const catalog = parseNormalizedCatalog(JSON.parse(await readFile(
      resolve('config/menu-catalog-2026-07-27.json'), 'utf8',
    )))
    const environment = Object.fromEntries([
      ...store.employees.map((employee) => [employee.pinEnv, '5210']),
      [store.dailyCredentialEnv!, 'MBOX521'],
    ])

    const provisionedStore = await provisionNormalizedStore({
      databaseUrl: databaseUrl!, config: store, environment, sourceCommitSha,
    })
    const provisionedCatalog = await provisionNormalizedCatalog({
      databaseUrl: databaseUrl!, tenantId: store.tenant.id, storeId: store.store.id,
      catalog, sourceCommitSha,
    })
    const readiness = await inspectCommercialReadiness({
      databaseUrl: databaseUrl!, tenantId: store.tenant.id, storeId: store.store.id,
      expectedCommitSha: sourceCommitSha,
    })

    expect(provisionedStore).toMatchObject({ areaCount: 6, tableCount: 65, roleCount: 14, employeeCount: 13 })
    expect(provisionedCatalog).toMatchObject({ productCount: 81, activeProductCount: 81, bundleCount: 17 })
    expect(readiness.snapshot).toMatchObject({
      activeTables: 65,
      activeEmployees: 13,
      activeProducts: 81,
      productsMissingCurrentPrice: 0,
      productsMissingCost: 0,
      bundlesMissingComponents: 0,
      invalidBundleComponents: 0,
      financialRolesMissingLimits: [],
      kdsRolesMissingStationScopes: [],
      tablesMissingMinimumSpend: 0,
      tablesMissingLayout: 0,
    })
    expect(readiness.status).toBe('ready')
    expect(readiness.issues).toEqual([])
    expect(store.tables.every((table) => table.minimumSpendMinor === 0)).toBe(true)
    expect(store.tables.every((table) => Object.keys(table.layout ?? {}).length > 0)).toBe(true)
  }, 30_000)
})
