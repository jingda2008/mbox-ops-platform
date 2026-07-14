import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

export interface MigrationFile {
  version: string
  filename: string
  checksum: string
  sql: string
}

export function unwrapMigrationTransaction(sql: string) {
  const match = sql.match(/^\s*BEGIN\s*;([\s\S]*?)COMMIT\s*;\s*$/i)
  if (!match?.[1]) throw new Error('迁移文件必须由单一BEGIN/COMMIT事务包裹')
  return match[1]
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/.test(filename))
    .toSorted()
  const migrations = await Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(resolve(directory, filename), 'utf8')
    return {
      version: filename.slice(0, 3),
      filename,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    }
  }))
  if (!migrations.length) throw new Error('没有找到数据库迁移文件')
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(3, '0')
    if (migration.version !== expected) throw new Error(`数据库迁移版本不连续：期望${expected}，实际${migration.version}`)
  })
  return migrations
}

export async function runMigrations(databaseUrl: string, directory: string) {
  const client = new Client({ connectionString: databaseUrl, application_name: 'mbox-migrator' })
  await client.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('mbox.schema_migrations'))`)
    await client.query('CREATE SCHEMA IF NOT EXISTS mbox')
    await client.query(`
      CREATE TABLE IF NOT EXISTS mbox.schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    const appliedResult = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM mbox.schema_migrations ORDER BY version',
    )
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]))
    const migrations = await loadMigrations(directory)
    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version)
      if (existingChecksum && existingChecksum !== migration.checksum) {
        throw new Error(`已应用迁移${migration.version}的校验和发生变化，禁止继续`)
      }
      if (existingChecksum) continue
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
      process.stdout.write(`applied ${migration.filename}\n`)
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('mbox.schema_migrations'))`).catch(() => undefined)
    await client.end()
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('执行数据库迁移必须配置DATABASE_URL')
  await runMigrations(databaseUrl, resolve(process.cwd(), 'database/migrations'))
}
