import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { reconcileTableRoster } from '../../scripts/reconcile-table-roster.mjs'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { parseStoreProvisionConfig, provisionNormalizedStore } from '../provision-normalized-store.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('versioned table rename preserves identity and rolls back ambiguity', () => {
  it('never creates a second table for an explicit rename and preserves sessions and QR credentials', async () => {
    await runNormalizedMigrations(databaseUrl!)
    const source = JSON.parse(await readFile('deploy/normalized-store/mbox-lujiazui.store.json', 'utf8'))
    const tenantId = randomUUID(), storeId = randomUUID()
    source.tenant = { ...source.tenant, id: tenantId, code: tenantId }
    source.store = { ...source.store, id: storeId, code: storeId }
    source.version = 'rename-test-v1'
    source.tables = [
      { code: 'A01', name: 'A01', areaCode: 'main', capacity: 4 },
      { code: 'W01', name: 'W01', areaCode: 'outdoor', capacity: 8 },
    ]
    const config = parseStoreProvisionConfig(source)
    const environment = Object.fromEntries([...config.employees.map(e => [e.pinEnv, '5210']), [config.dailyCredentialEnv!, 'MBOX521']])
    const input = { databaseUrl: databaseUrl!, config, environment, sourceCommitSha: 'a'.repeat(40) }
    await provisionNormalizedStore(input)
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const original = (await client.query('SELECT id, code, area_id FROM mbox.tables WHERE tenant_id=$1 ORDER BY code', [tenantId])).rows
      const table = original.find(t => t.code === 'W01')!
      const visit = randomUUID(), qr = randomUUID()
      await client.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
        VALUES($1::uuid,$2,$3,$4,$1::text,current_date,2,'open')`, [visit, tenantId, storeId, table.id])
      await client.query(`INSERT INTO mbox.table_qr_credentials(id,tenant_id,store_id,table_id,qr_version,credential_hash)
        VALUES($1,$2,$3,$4,1,$5)`, [qr, tenantId, storeId, table.id, 'a'.repeat(64)])
      // A01 display name would change first; W1 ambiguity must roll back that change too.
      const conflict = randomUUID()
      await client.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
        VALUES($1,$2,$3,$4,'W1','Conflict',4)`, [conflict, tenantId, storeId, table.area_id])
      source.version = 'rename-test-v2'
      source.tables = source.tables.map((t: { code: string; name: string }) => ({ ...t, renameFrom: t.code, code: t.code.replace('0', ''), name: t.name.replace('0', '') }))
      const renamed = parseStoreProvisionConfig(source)
      await expect(provisionNormalizedStore({ ...input, config: renamed })).rejects.toThrow('Ambiguous table rename W01 -> W1')
      expect((await client.query('SELECT code FROM mbox.tables WHERE tenant_id=$1 ORDER BY code', [tenantId])).rows.map(t => t.code)).toEqual(['A01', 'W01', 'W1'])
      expect((await client.query("SELECT display_name FROM mbox.tables WHERE tenant_id=$1 AND code='A01'", [tenantId])).rows[0].display_name).toBe('A01')
      await client.query('DELETE FROM mbox.tables WHERE id=$1', [conflict])
      await provisionNormalizedStore({ ...input, config: renamed })
      await provisionNormalizedStore({ ...input, config: renamed })
      expect((await client.query('SELECT id,code FROM mbox.tables WHERE tenant_id=$1 ORDER BY code', [tenantId])).rows)
        .toEqual(original.map(t => ({ id: t.id, code: t.code })))
      // Only after frontend activation: finalize codes atomically and audit them.
      await client.query('BEGIN')
      await reconcileTableRoster(client, { tenantId, storeId }, renamed.tables)
      await client.query('COMMIT')
      await provisionNormalizedStore({ ...input, config: renamed })
      expect((await client.query('SELECT id,code FROM mbox.tables WHERE tenant_id=$1 ORDER BY code', [tenantId])).rows)
        .toEqual(original.map(t => ({ id: t.id, code: t.code.replace('0', '') })))
      expect((await client.query('SELECT table_id,status FROM mbox.table_sessions WHERE id=$1', [visit])).rows[0]).toEqual({ table_id: table.id, status: 'open' })
      expect((await client.query('SELECT table_id,status,credential_hash FROM mbox.table_qr_credentials WHERE id=$1', [qr])).rows[0])
        .toEqual({ table_id: table.id, status: 'active', credential_hash: 'a'.repeat(64) })
    } finally { await client.end() }
  }, 30_000)
})
