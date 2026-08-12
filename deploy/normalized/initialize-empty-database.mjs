import process from 'node:process'
import pg from 'pg'
import { runNormalizedMigrations } from '../../dist-normalized/server/migrate-normalized.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (process.env.NORMALIZED_EMPTY_DATABASE_CONFIRM !== 'INITIALIZE_EMPTY_DATABASE') {
  throw new Error('empty database initialization confirmation is required')
}

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'mbox-normalized-empty-database-guard',
})

await client.connect()
try {
  const result = await client.query(`
    SELECT count(*)::integer AS table_count
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  `)
  if (result.rows[0]?.table_count !== 0) {
    throw new Error('target database is not empty; initialization refused')
  }
} finally {
  await client.end()
}

await runNormalizedMigrations(databaseUrl)
process.stdout.write('normalized empty database initialized\n')
