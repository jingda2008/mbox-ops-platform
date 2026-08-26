import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
  unwrapNormalizedMigrationTransaction,
} from '../migrate-normalized.js'

const sourceDatabaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = sourceDatabaseUrl ? describe : describe.skip

integration('144 menu category hierarchy upgrade', () => {
  const databaseName = `mbox_menu_categories_144_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let admin: Client
  let client: Client
  let databaseCreated = false

  beforeAll(async () => {
    const adminUrl = new URL(sourceDatabaseUrl!)
    adminUrl.pathname = '/postgres'
    const targetUrl = new URL(sourceDatabaseUrl!)
    targetUrl.pathname = `/${databaseName}`
    admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    databaseCreated = true
    client = new Client({ connectionString: targetUrl.toString() })
    await client.connect()
    await initializeSchema(client)
    const migrations = await loadNormalizedMigrations()
    for (const migration of migrations.filter((entry) => entry.version <= '143')) {
      await applyMigration(client, migration)
    }
  }, 60_000)

  afterAll(async () => {
    await client?.end().catch(() => undefined)
    if (databaseCreated) {
      await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()
      `, [databaseName]).catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  it('keeps a legacy category that shares a seeded top-level code without aborting the upgrade', async () => {
    const tenantId = randomUUID()
    const storeId = randomUUID()
    const suffix = tenantId.replaceAll('-', '').slice(0, 8)
    await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'菜单迁移租户')`, [
      tenantId, `menu144-${suffix}`,
    ])
    await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'菜单迁移门店')`, [
      storeId, tenantId, `menu144-${suffix}`,
    ])
    await client.query(`
      INSERT INTO mbox.products(
        tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
      ) VALUES
        ($1,$2,'LEGACY_DRINKS','已有酒水分类','drinks','bar','{}'::jsonb),
        ($1,$2,'LEGACY_MIX','旧自定义分类','legacy-mix','bar','{"categoryName":"旧自定义分类"}'::jsonb)
    `, [tenantId, storeId])

    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '144')
    expect(migration).toBeDefined()
    await applyMigration(client, migration!)

    const categories = await client.query<{
      code: string
      display_name: string
      parent_code: string | null
    }>(`
      SELECT code,display_name,parent_code
      FROM mbox.menu_categories
      WHERE tenant_id=$1 AND store_id=$2
        AND code IN ('drinks','cocktail','legacy-mix')
      ORDER BY code
    `, [tenantId, storeId])
    expect(categories.rows).toEqual([
      { code: 'cocktail', display_name: '鸡尾酒', parent_code: 'drinks' },
      { code: 'drinks', display_name: '酒水', parent_code: null },
      { code: 'legacy-mix', display_name: '旧自定义分类', parent_code: 'other' },
    ])
  })
})

async function initializeSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA mbox;
    CREATE TABLE mbox.normalized_schema_metadata(
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      schema_flavor text NOT NULL,schema_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE mbox.normalized_schema_migrations(
      version text PRIMARY KEY,filename text NOT NULL UNIQUE,checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `)
  await client.query(
    `INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version)
     VALUES(true,$1,'000')`,
    [NORMALIZED_SCHEMA_FLAVOR],
  )
}

async function applyMigration(
  client: Client,
  migration: Awaited<ReturnType<typeof loadNormalizedMigrations>>[number],
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(unwrapNormalizedMigrationTransaction(migration.sql))
    await client.query(
      `INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum) VALUES($1,$2,$3)`,
      [migration.version, migration.filename, migration.checksum],
    )
    await client.query(
      `UPDATE mbox.normalized_schema_metadata
       SET schema_version=$1,updated_at=clock_timestamp()
       WHERE singleton=true`,
      [migration.version],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

function quoteIdentifier(value: string): string {
  if (!/^mbox_menu_categories_144_\d+_[0-9a-f]{8}$/.test(value)) {
    throw new Error('Unsafe PostgreSQL identifier')
  }
  return `"${value}"`
}
