import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import {
  assertNormalizedMigrationTarget,
  inspectTargetDatabase,
  loadNormalizedMigrations,
} from './migrate-normalized.js'

export async function verifyNormalizedMigrationCompatibility(databaseUrl: string) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'mbox-normalized-migration-preflight',
  })
  await client.connect()
  try {
    await client.query('SET default_transaction_read_only = on')
    const databaseIdentity = (await client.query<{
      database: string
      server_address: string
      server_port: string
    }>(`SELECT current_database() AS database,
      COALESCE(inet_server_addr()::text,'local') AS server_address,
      current_setting('port') AS server_port`)).rows[0]
    if (!databaseIdentity) throw new Error('数据库身份预检没有返回结果')
    const inspection = await inspectTargetDatabase(client)
    assertNormalizedMigrationTarget(inspection)
    const available = await loadNormalizedMigrations()
    const applied = inspection.hasNormalizedMigrations
      ? (await client.query<{ version: string; filename: string; checksum: string }>(
          'SELECT version, filename, checksum FROM mbox.normalized_schema_migrations ORDER BY version',
        )).rows
      : []

    for (const [index, row] of applied.entries()) {
      const expected = available[index]
      if (!expected || expected.version !== row.version || expected.filename !== row.filename) {
        throw new Error(`数据库迁移序列与候选不兼容：${row.version}`)
      }
      if (expected.checksum !== row.checksum) throw new Error(`数据库迁移校验和与候选不一致：${row.version}`)
    }

    return {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      status: 'pass' as const,
      databaseIdentity: {
        database: databaseIdentity.database,
        serverAddress: databaseIdentity.server_address,
        serverPort: databaseIdentity.server_port,
      },
      schemaFlavor: inspection.schemaFlavor ?? 'empty',
      appliedCount: applied.length,
      availableCount: available.length,
      pendingCount: available.length - applied.length,
    }
  } finally {
    await client.end()
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('迁移兼容性预检必须配置DATABASE_URL')
  process.stdout.write(`${JSON.stringify(await verifyNormalizedMigrationCompatibility(databaseUrl), null, 2)}\n`)
}
