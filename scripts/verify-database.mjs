import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('数据库结构验证必须配置DATABASE_URL')

const directory = resolve(process.cwd(), 'database/migrations')
const filenames = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
const expected = await Promise.all(filenames.map(async (filename) => ({
  version: filename.slice(0, 3),
  filename,
  checksum: createHash('sha256').update(await readFile(resolve(directory, filename), 'utf8')).digest('hex'),
})))

const client = new pg.Client({ connectionString: databaseUrl, application_name: 'mbox-schema-verifier' })
await client.connect()
try {
  const applied = await client.query(
    'SELECT version, filename, checksum::text FROM mbox.schema_migrations ORDER BY version',
  )
  if (JSON.stringify(applied.rows) !== JSON.stringify(expected)) {
    throw new Error(`迁移清单或校验和不一致：期望${expected.length}项，实际${applied.rows.length}项`)
  }

  const rlsGaps = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mbox'
      AND c.relkind = 'r'
      AND c.relname <> 'schema_migrations'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    ORDER BY c.relname
  `)
  if (rlsGaps.rowCount) {
    throw new Error(`以下业务表未同时启用并强制RLS：${rlsGaps.rows.map((row) => row.relname).join(', ')}`)
  }

  const operationalRelations = [
    'operational_projection_checkpoints',
    'operational_tables',
    'operational_table_sessions',
    'operational_service_tasks',
    'operational_orders',
    'operational_order_items',
    'operational_kds_tasks',
    'operational_payment_intents',
    'operational_inventory_balances',
  ]
  const operationalPrivilegeGaps = await client.query(`
    SELECT relation_name, privilege
    FROM unnest($1::text[]) AS relation_name
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]) AS privilege
    WHERE NOT has_table_privilege('mbox_app', format('mbox.%I', relation_name), privilege)
    ORDER BY relation_name, privilege
  `, [operationalRelations])
  if (operationalPrivilegeGaps.rowCount) {
    throw new Error(`mbox_app缺少规范化经营表权限：${operationalPrivilegeGaps.rows
      .map((row) => `${row.relation_name}:${row.privilege}`)
      .join(', ')}`)
  }

  const tableCount = await client.query(`
    SELECT count(*)::integer AS count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mbox' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
  `)
  console.log(`database verification passed (${expected.length} migrations, ${tableCount.rows[0].count} forced-RLS tables)`)
} finally {
  await client.end()
}
