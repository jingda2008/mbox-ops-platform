import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
} from '../migrate-normalized.js'

const sourceDatabaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = sourceDatabaseUrl ? describe : describe.skip

integration('migration 066 historical order cost backfill', () => {
  const databaseName = `mbox_cost_backfill_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let admin: Client
  let client: Client
  let isolatedDatabaseUrl: URL
  let databaseCreated = false

  beforeAll(async () => {
    if (!/^mbox_cost_backfill_\d+_[0-9a-f]{8}$/.test(databaseName)) {
      throw new Error('Unsafe cost backfill test database name')
    }
    const adminUrl = new URL(sourceDatabaseUrl!)
    adminUrl.pathname = '/postgres'
    isolatedDatabaseUrl = new URL(sourceDatabaseUrl!)
    isolatedDatabaseUrl.pathname = `/${databaseName}`
    admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    databaseCreated = true
    client = new Client({ connectionString: isolatedDatabaseUrl.toString() })
    await client.connect()

    await client.query(`
      CREATE SCHEMA mbox;
      CREATE TABLE mbox.normalized_schema_metadata (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        schema_flavor text NOT NULL,
        schema_version text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE mbox.normalized_schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    await client.query(`
      INSERT INTO mbox.normalized_schema_metadata(singleton, schema_flavor, schema_version)
      VALUES(true, $1, '000')
    `, [NORMALIZED_SCHEMA_FLAVOR])

    const migrations = await loadNormalizedMigrations()
    for (const migration of migrations.filter((entry) => Number(entry.version) <= 65)) {
      await client.query(migration.sql)
      await client.query(`
        INSERT INTO mbox.normalized_schema_migrations(version, filename, checksum)
        VALUES($1, $2, $3)
      `, [migration.version, migration.filename, migration.checksum])
    }
  }, 30_000)

  afterAll(async () => {
    await client?.end().catch(() => undefined)
    if (databaseCreated) {
      await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()
      `, [databaseName]).catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
        .catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  it('promotes only exact consistent history and quarantines malformed keys', async () => {
    const tenantId = randomUUID()
    const storeId = randomUUID()
    const areaId = randomUUID()
    const tableId = randomUUID()
    const tableSessionId = randomUUID()
    const productId = randomUUID()
    const orderId = randomUUID()
    await client.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES($1::uuid, $2, 'Cost Backfill Tenant')
    `, [tenantId, `cost-bf-${tenantId.slice(0, 8)}`])
    await client.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES($1::uuid, $2::uuid, $3, 'Cost Backfill Store')
    `, [storeId, tenantId, `cost-bf-${storeId.slice(0, 8)}`])
    await client.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
      VALUES($1::uuid, $2::uuid, $3::uuid, 'COST_BF', 'Cost Backfill Area', 'indoor')
    `, [areaId, tenantId, storeId])
    await client.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COST_BF', 'Cost Backfill Table', 4)
    `, [tableId, tenantId, storeId, areaId])
    await client.query(`
      INSERT INTO mbox.table_sessions(
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid,
        'cost-backfill-session', '2026-08-16', 2, 'open')
    `, [tableSessionId, tenantId, storeId, tableId])
    await client.query(`
      INSERT INTO mbox.products(
        id, tenant_id, store_id, code, name, category_code,
        fulfillment_station, status, cost_amount_minor
      ) VALUES($1::uuid, $2::uuid, $3::uuid,
        'COST-BF', 'Cost Backfill Product', 'test', 'none', 'active', 999999)
    `, [productId, tenantId, storeId])
    await client.query(`
      INSERT INTO mbox.orders(
        id, tenant_id, store_id, table_session_id, public_id, channel,
        status, payment_status, subtotal_amount_minor, discount_amount_minor,
        total_amount_minor, currency, submitted_at
      ) VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid,
        'cost-backfill-order', 'integration', 'submitted', 'paid',
        12000, 0, 12000, 'CNY', clock_timestamp())
    `, [orderId, tenantId, storeId, tableSessionId])

    const cases = [
      { note: 'valid-both', snapshot: { unitCostMinor: 100, totalCostMinor: 200 } },
      { note: 'valid-total-only', snapshot: { totalCostMinor: 300 } },
      { note: 'missing', snapshot: {} },
      { note: 'invalid-total', snapshot: { unitCostMinor: 100, totalCostMinor: 'bad' } },
      { note: 'contradictory-total', snapshot: { unitCostMinor: 100, totalCostMinor: 999 } },
      { note: 'invalid-unit', snapshot: { unitCostMinor: 'bad', totalCostMinor: 200 } },
    ] as const
    for (const entry of cases) {
      await client.query(`
        INSERT INTO mbox.order_items(
          tenant_id, store_id, order_id, product_id, quantity,
          unit_price_minor, total_amount_minor, currency, fulfillment_station,
          product_snapshot, cost_snapshot, status, note
        ) VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2,
          1000, 2000, 'CNY', 'none', '{}'::jsonb, $5::jsonb, 'submitted', $6)
      `, [tenantId, storeId, orderId, productId, JSON.stringify(entry.snapshot), entry.note])
    }

    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '066')
    expect(migration).toBeDefined()
    await client.query(migration!.sql)

    const result = await client.query<{
      note: string
      unit_cost: string | null
      total_cost: string | null
      cost_source: string
    }>(`
      SELECT note, unit_cost_minor_at_submission::text AS unit_cost,
        total_cost_minor_at_submission::text AS total_cost, cost_source
      FROM mbox.order_items
      ORDER BY note
    `)
    expect(result.rows).toEqual([
      { note: 'contradictory-total', unit_cost: null, total_cost: null, cost_source: 'unavailable' },
      { note: 'invalid-total', unit_cost: null, total_cost: null, cost_source: 'unavailable' },
      { note: 'invalid-unit', unit_cost: null, total_cost: null, cost_source: 'unavailable' },
      { note: 'missing', unit_cost: null, total_cost: null, cost_source: 'unavailable' },
      { note: 'valid-both', unit_cost: '100', total_cost: '200', cost_source: 'legacy_snapshot' },
      { note: 'valid-total-only', unit_cost: null, total_cost: '300', cost_source: 'legacy_snapshot' },
    ])
    expect(result.rows.every((row) => row.total_cost !== '1999998')).toBe(true)
  }, 30_000)
})

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('Unsafe database identifier')
  return `"${value}"`
}
