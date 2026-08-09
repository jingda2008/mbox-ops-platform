import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { loadMigrations, unwrapMigrationTransaction } from '../server/migrate.js'

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) throw new Error('checksum upgrade verification requires DATABASE_URL')

const suffix = randomBytes(5).toString('hex')
const role = `mbox_upgrade_${suffix}`
const database = `mbox_upgrade_${suffix}`
const password = randomBytes(16).toString('hex')
const adminDatabaseUrl = new URL(adminUrl)
adminDatabaseUrl.pathname = '/postgres'
const targetUrl = new URL(adminUrl)
targetUrl.pathname = `/${database}`
targetUrl.username = role
targetUrl.password = password

const admin = new Client({ connectionString: adminDatabaseUrl.toString(), application_name: 'mbox-checksum-upgrade-admin' })
await admin.connect()

function appChecksum(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function applyMigration(client: Client, migration: Awaited<ReturnType<typeof loadMigrations>>[number]) {
  await client.query('BEGIN')
  try {
    await client.query(unwrapMigrationTransaction(migration.sql))
    await client.query(
      'INSERT INTO mbox.schema_migrations(version, filename, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.filename, migration.checksum],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function withContext(client: Client, tenantId: string, storeId: string, operation: () => Promise<void>) {
  await client.query('BEGIN')
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`, [tenantId, storeId])
    await operation()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

let target: Client | undefined
try {
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
  await admin.query(`CREATE DATABASE ${database} OWNER ${role}`)
  target = new Client({ connectionString: targetUrl.toString(), application_name: 'mbox-checksum-upgrade-owner' })
  await target.connect()
  await target.query('CREATE SCHEMA IF NOT EXISTS mbox')
  await target.query(`
    CREATE TABLE mbox.schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `)
  const migrations = await loadMigrations(resolve(process.cwd(), 'database/migrations'))
  for (const migration of migrations.filter(({ version }) => Number(version) <= 23)) {
    await applyMigration(target, migration)
  }

  const tenantApp = '11111111-1111-4111-8111-111111111111'
  const storeApp = '11111111-1111-4111-8111-111111111112'
  const tenantMixed = '22222222-2222-4222-8222-222222222221'
  const storeMixed = '22222222-2222-4222-8222-222222222222'
  for (const [tenantId, storeId, code] of [
    [tenantApp, storeApp, 'app'],
    [tenantMixed, storeMixed, 'mixed'],
  ]) {
    await withContext(target, tenantId, storeId, async () => {
      await target!.query('INSERT INTO mbox.tenants(id, code, name) VALUES ($1::uuid, $2, $3)', [tenantId, `upgrade-${code}`, `Upgrade ${code}`])
      await target!.query(`
        INSERT INTO mbox.stores(id, tenant_id, code, name, timezone)
        VALUES ($1::uuid, $2::uuid, $3, $4, 'Asia/Shanghai')
      `, [storeId, tenantId, `upgrade-${code}`, `Upgrade ${code}`])
      const state = { revision: 1 }
      await target!.query(`
        INSERT INTO mbox.runtime_states(tenant_id, store_id, revision, state, state_sha256)
        VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4)
      `, [tenantId, storeId, JSON.stringify(state), appChecksum(state)])
      await target!.query(`
        INSERT INTO mbox.operational_projection_checkpoints(
          tenant_id, store_id, runtime_revision, state_sha256, entity_counts
        ) VALUES ($1::uuid, $2::uuid, 1, $3, '{}'::jsonb)
      `, [tenantId, storeId, appChecksum(state)])
    })
  }

  await withContext(target, tenantMixed, storeMixed, async () => {
    const state = { revision: 2, source: 'pre-024-pg-writer' }
    await target!.query(`
      UPDATE mbox.runtime_states
      SET revision = 2, state = $3::jsonb,
          state_sha256 = encode(sha256(convert_to(($3::jsonb)::text, 'UTF8')), 'hex')
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantMixed, storeMixed, JSON.stringify(state)])
    const checksum = await target!.query<{ checksum: string }>(
      `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS checksum`,
      [JSON.stringify(state)],
    )
    await target!.query(`
      UPDATE mbox.operational_projection_checkpoints
      SET runtime_revision = 2, state_sha256 = $3
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantMixed, storeMixed, checksum.rows[0]!.checksum])
  })

  await applyMigration(target, migrations.find(({ version }) => version === '024')!)

  for (const [tenantId, storeId, expected] of [
    [tenantApp, storeApp, 'app-canonical-json-sha256-v1'],
    [tenantMixed, storeMixed, 'pg-jsonb-text-sha256-v1'],
  ]) {
    await withContext(target, tenantId, storeId, async () => {
      const state = await target!.query<{ state_checksum_algorithm: string }>(`
        SELECT state_checksum_algorithm FROM mbox.runtime_states
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      `, [tenantId, storeId])
      const checkpoint = await target!.query<{ state_checksum_algorithm: string }>(`
        SELECT state_checksum_algorithm FROM mbox.operational_projection_checkpoints
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      `, [tenantId, storeId])
      if (state.rows[0]?.state_checksum_algorithm !== expected || checkpoint.rows[0]?.state_checksum_algorithm !== expected) {
        throw new Error(`023->024 checksum classification failed for ${storeId}`)
      }
    })
  }

  await withContext(target, tenantMixed, storeMixed, async () => {
    const history = await target!.query<{
      revision: string
      previous_state_checksum_algorithm: string | null
      state_checksum_algorithm: string
    }>(`
      SELECT revision, previous_state_checksum_algorithm, state_checksum_algorithm
      FROM mbox.runtime_state_versions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      ORDER BY revision
    `, [tenantMixed, storeMixed])
    if (history.rows[0]?.state_checksum_algorithm !== 'unknown-legacy-sha256-v0'
      || history.rows[1]?.previous_state_checksum_algorithm !== 'unknown-legacy-sha256-v0'
      || history.rows[1]?.state_checksum_algorithm !== 'pg-jsonb-text-sha256-v1') {
      throw new Error(`historical checksum algorithms were misrepresented: ${JSON.stringify(history.rows)}`)
    }

    const rollbackState = { revision: 3, source: 'rolled-back-app-writer' }
    await target!.query(`
      UPDATE mbox.runtime_states
      SET revision = 3, state = $3::jsonb, state_sha256 = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantMixed, storeMixed, JSON.stringify(rollbackState), appChecksum(rollbackState)])
    await target!.query(`
      UPDATE mbox.operational_projection_checkpoints
      SET runtime_revision = 3, state_sha256 = $3
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantMixed, storeMixed, appChecksum(rollbackState)])
    const rollbackCompatibility = await target!.query<{
      runtime_algorithm: string
      checkpoint_algorithm: string
      previous_algorithm: string
      journal_algorithm: string
    }>(`
      SELECT runtime.state_checksum_algorithm AS runtime_algorithm,
        checkpoint.state_checksum_algorithm AS checkpoint_algorithm,
        version.previous_state_checksum_algorithm AS previous_algorithm,
        version.state_checksum_algorithm AS journal_algorithm
      FROM mbox.runtime_states runtime
      JOIN mbox.operational_projection_checkpoints checkpoint USING (tenant_id, store_id)
      JOIN mbox.runtime_state_versions version USING (tenant_id, store_id)
      WHERE runtime.tenant_id = $1::uuid AND runtime.store_id = $2::uuid AND version.revision = 3
    `, [tenantMixed, storeMixed])
    const row = rollbackCompatibility.rows[0]
    if (row?.runtime_algorithm !== 'app-canonical-json-sha256-v1'
      || row.checkpoint_algorithm !== 'app-canonical-json-sha256-v1'
      || row.previous_algorithm !== 'pg-jsonb-text-sha256-v1'
      || row.journal_algorithm !== 'app-canonical-json-sha256-v1') {
      throw new Error(`rollback compatibility failed: ${JSON.stringify(row)}`)
    }
  })

  const forceRls = await target.query<{ relname: string; relforcerowsecurity: boolean }>(`
    SELECT relname, relforcerowsecurity FROM pg_class
    WHERE oid IN (
      'mbox.runtime_states'::regclass,
      'mbox.runtime_state_versions'::regclass,
      'mbox.operational_projection_checkpoints'::regclass
    )
  `)
  if (forceRls.rows.some((row) => row.relforcerowsecurity !== true)) {
    throw new Error(`checksum migration did not restore FORCE RLS: ${JSON.stringify(forceRls.rows)}`)
  }
  console.log(JSON.stringify({ verified: true, upgrade: '023-to-024', nonSuperuser: true, rollbackCompatibility: true }))
} finally {
  await target?.end().catch(() => undefined)
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}'`).catch(() => undefined)
  await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined)
  await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
  await admin.end()
}
