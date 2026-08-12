import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

export const NORMALIZED_SCHEMA_FLAVOR = 'normalized-core-v1'
export const NORMALIZED_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../database/normalized-migrations/', import.meta.url),
)

export interface NormalizedMigrationFile {
  version: string
  filename: string
  checksum: string
  sql: string
}

export interface TargetDatabaseInspection {
  userTableCount: number
  hasLegacyMigrationMetadata: boolean
  hasRuntimeStates: boolean
  hasRuntimeStateVersions: boolean
  hasNormalizedMetadata: boolean
  hasNormalizedMigrations: boolean
  schemaFlavor?: string
}

export function unwrapNormalizedMigrationTransaction(sql: string) {
  const match = sql.match(/^\s*BEGIN\s*;([\s\S]*?)COMMIT\s*;\s*$/i)
  if (!match?.[1]) throw new Error('规范化迁移文件必须由单一BEGIN/COMMIT事务包裹')
  return match[1]
}

export async function loadNormalizedMigrations(
  directory = NORMALIZED_MIGRATIONS_DIRECTORY,
): Promise<NormalizedMigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/.test(filename))
    .toSorted()
  if (!filenames.length) throw new Error('没有找到规范化数据库迁移文件')

  const migrations = await Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(resolve(directory, filename), 'utf8')
    unwrapNormalizedMigrationTransaction(sql)
    return {
      version: filename.slice(0, 3),
      filename,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    }
  }))

  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(3, '0')
    if (migration.version !== expected) {
      throw new Error(`规范化数据库迁移版本不连续：期望${expected}，实际${migration.version}`)
    }
  })
  return migrations
}

export function assertNormalizedMigrationTarget(inspection: TargetDatabaseInspection) {
  if (inspection.hasRuntimeStates || inspection.hasRuntimeStateVersions) {
    throw new Error('检测到legacy整店运行态表，禁止直接应用规范化基线；请使用全新空库')
  }
  if (inspection.hasLegacyMigrationMetadata) {
    throw new Error('检测到legacy迁移元数据，禁止直接应用规范化基线；请使用全新空库')
  }
  if (inspection.hasNormalizedMetadata || inspection.hasNormalizedMigrations) {
    if (!inspection.hasNormalizedMetadata || !inspection.hasNormalizedMigrations) {
      throw new Error('规范化迁移元数据不完整，禁止自动修补')
    }
    if (inspection.schemaFlavor !== NORMALIZED_SCHEMA_FLAVOR) {
      throw new Error(`数据库schema flavor不匹配：${inspection.schemaFlavor ?? 'unknown'}`)
    }
    return
  }
  if (inspection.userTableCount > 0) {
    throw new Error('目标数据库不是全新空库，禁止应用规范化基线')
  }
}

async function inspectTargetDatabase(client: Client): Promise<TargetDatabaseInspection> {
  const catalog = await client.query<{
    user_table_count: string
    legacy_migrations: string | null
    runtime_states: string | null
    runtime_state_versions: string | null
    normalized_metadata: string | null
    normalized_migrations: string | null
  }>(`
    SELECT
      (
        SELECT count(*)::text
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ) AS user_table_count,
      to_regclass('mbox.schema_migrations')::text AS legacy_migrations,
      to_regclass('mbox.runtime_states')::text AS runtime_states,
      to_regclass('mbox.runtime_state_versions')::text AS runtime_state_versions,
      to_regclass('mbox.normalized_schema_metadata')::text AS normalized_metadata,
      to_regclass('mbox.normalized_schema_migrations')::text AS normalized_migrations
  `)
  const row = catalog.rows[0]
  if (!row) throw new Error('无法读取目标数据库目录信息')

  let schemaFlavor: string | undefined
  if (row.normalized_metadata) {
    const metadata = await client.query<{ schema_flavor: string }>(`
      SELECT schema_flavor
      FROM mbox.normalized_schema_metadata
      WHERE singleton = true
    `)
    schemaFlavor = metadata.rows[0]?.schema_flavor
  }

  return {
    userTableCount: Number(row.user_table_count),
    hasLegacyMigrationMetadata: Boolean(row.legacy_migrations),
    hasRuntimeStates: Boolean(row.runtime_states),
    hasRuntimeStateVersions: Boolean(row.runtime_state_versions),
    hasNormalizedMetadata: Boolean(row.normalized_metadata),
    hasNormalizedMigrations: Boolean(row.normalized_migrations),
    schemaFlavor,
  }
}

async function initializeNormalizedMetadata(client: Client) {
  await client.query('BEGIN')
  try {
    await client.query('CREATE SCHEMA mbox')
    await client.query(`
      CREATE TABLE mbox.normalized_schema_metadata (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        schema_flavor text NOT NULL,
        schema_version text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    await client.query(`
      CREATE TABLE mbox.normalized_schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    await client.query(
      `INSERT INTO mbox.normalized_schema_metadata(singleton, schema_flavor, schema_version)
       VALUES (true, $1, '000')`,
      [NORMALIZED_SCHEMA_FLAVOR],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function runNormalizedMigrations(databaseUrl: string) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'mbox-normalized-migrator',
  })
  await client.connect()
  let lockAcquired = false
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('mbox.normalized_schema_migrations'))`)
    lockAcquired = true

    const inspection = await inspectTargetDatabase(client)
    assertNormalizedMigrationTarget(inspection)
    if (!inspection.hasNormalizedMetadata) await initializeNormalizedMetadata(client)

    const appliedResult = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM mbox.normalized_schema_migrations ORDER BY version',
    )
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]))
    const migrations = await loadNormalizedMigrations()

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version)
      if (existingChecksum && existingChecksum !== migration.checksum) {
        throw new Error(`已应用规范化迁移${migration.version}的校验和发生变化，禁止继续`)
      }
      if (existingChecksum) continue

      await client.query('BEGIN')
      try {
        await client.query(unwrapNormalizedMigrationTransaction(migration.sql))
        await client.query(
          `INSERT INTO mbox.normalized_schema_migrations(version, filename, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        )
        await client.query(
          `UPDATE mbox.normalized_schema_metadata
           SET schema_version = $1, updated_at = clock_timestamp()
           WHERE singleton = true AND schema_flavor = $2`,
          [migration.version, NORMALIZED_SCHEMA_FLAVOR],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
      process.stdout.write(`applied normalized ${migration.filename}\n`)
    }
  } finally {
    if (lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized_schema_migrations'))`).catch(() => undefined)
    }
    await client.end()
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('执行规范化数据库迁移必须配置DATABASE_URL')
  await runNormalizedMigrations(databaseUrl)
}
