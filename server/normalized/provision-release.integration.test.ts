import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { parseNormalizedCatalog } from '../provision-normalized-catalog.js'
import { provisionNormalizedRelease } from '../provision-normalized-release.js'
import { parseStoreProvisionConfig } from '../provision-normalized-store.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const firstSha = '1111111111111111111111111111111111111111'
const failedSha = '2222222222222222222222222222222222222222'

integration('release-bound configuration provisioning', () => {
  it('rolls back the store configuration when catalog provisioning fails', async () => {
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
    await provisionNormalizedRelease({
      databaseUrl: databaseUrl!, storeConfig: store, catalogConfig: catalog, environment, sourceCommitSha: firstSha,
    })

    const changedStore = structuredClone(store)
    changedStore.version = `${store.version}-atomic-failure`
    changedStore.store.name = 'THIS NAME MUST ROLLBACK'
    const conflictingCatalog = structuredClone(catalog)
    conflictingCatalog.products[0]!.name = 'THIS CATALOG MUST CONFLICT'

    await expect(provisionNormalizedRelease({
      databaseUrl: databaseUrl!,
      storeConfig: changedStore,
      catalogConfig: conflictingCatalog,
      environment,
      sourceCommitSha: failedSha,
    })).rejects.toThrow('Catalog version already exists with different content')

    const client = new Client({ connectionString: databaseUrl! })
    await client.connect()
    try {
      const state = await client.query<{ name: string; failed_applications: string }>(`
        SELECT store.name,
          (SELECT count(*)::text FROM mbox.store_configuration_applications application
            WHERE application.tenant_id=store.tenant_id AND application.store_id=store.id
              AND application.config_version=$3) AS failed_applications
        FROM mbox.stores store WHERE store.tenant_id=$1 AND store.id=$2`, [
        store.tenant.id, store.store.id, changedStore.version,
      ])
      expect(state.rows[0]).toEqual({ name: store.store.name, failed_applications: '0' })
    } finally {
      await client.end()
    }
  }, 45_000)
})
