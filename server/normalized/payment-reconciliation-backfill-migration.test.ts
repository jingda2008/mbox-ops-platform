import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
  unwrapNormalizedMigrationTransaction,
} from '../migrate-normalized.js'

const sourceDatabaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = sourceDatabaseUrl ? describe : describe.skip

integration('161 payment reconciliation history backfill', () => {
  const databaseName = `mbox_payment_backfill_161_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let admin: Client
  let client: Client
  let databaseCreated = false
  let migrationLockHeld = false

  beforeAll(async () => {
    if (!/^mbox_payment_backfill_161_\d+_[0-9a-f]{8}$/.test(databaseName)) {
      throw new Error('Unsafe payment backfill migration test database name')
    }
    const adminUrl = new URL(sourceDatabaseUrl!)
    adminUrl.pathname = '/postgres'
    const targetUrl = new URL(sourceDatabaseUrl!)
    targetUrl.pathname = `/${databaseName}`
    admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`SELECT pg_advisory_lock(hashtext('mbox.normalized.historical-migration-test'))`)
    migrationLockHeld = true
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
      databaseCreated = true
      client = new Client({ connectionString: targetUrl.toString() })
      await client.connect()
      await initializeHistoricalSchema(client)
      const migrations = await loadNormalizedMigrations()
      for (const migration of migrations.filter((entry) => entry.version <= '160')) {
        await applyMigration(client, migration)
      }
    } finally {
      await admin.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized.historical-migration-test'))`)
      migrationLockHeld = false
    }
  }, 60_000)

  afterAll(async () => {
    await client?.end().catch(() => undefined)
    if (migrationLockHeld) {
      await admin?.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized.historical-migration-test'))`)
        .catch(() => undefined)
    }
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

  it('inherits legacy query counts and stops an expired released payment without deleting evidence', async () => {
    const tenantId = randomUUID()
    const storeId = randomUUID()
    const areaId = randomUUID()
    const tableId = randomUUID()
    const sessionId = randomUUID()
    const oldOrderId = randomUUID()
    const recentOrderId = randomUUID()
    const oldPaymentId = randomUUID()
    const recentPaymentId = randomUUID()
    const suffix = tenantId.replaceAll('-', '').slice(0, 8)

    await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'161 tenant')`, [
      tenantId, `backfill-${suffix}`,
    ])
    await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'161 store')`, [
      storeId, tenantId, `backfill-${suffix}`,
    ])
    await client.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'MAIN','主区','indoor')`, [areaId, tenantId, storeId])
    await client.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'M161','M161',4)`, [tableId, tenantId, storeId, areaId])
    await client.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status
    ) VALUES($1,$2,$3,$4,'backfill-session-161',current_date,2,'open')`, [
      sessionId, tenantId, storeId, tableId,
    ])
    await client.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,cancelled_at,created_at
    ) VALUES
      ($1,$3,$4,$5,'backfill-old-order','cashier','cancelled','pending',4000,0,4000,
        clock_timestamp()-interval '8 days',clock_timestamp()-interval '8 days'),
      ($2,$3,$4,$5,'backfill-recent-order','cashier','cancelled','pending',4000,0,4000,
        clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes')
    `, [oldOrderId, recentOrderId, tenantId, storeId, sessionId])
    await client.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,created_at
    ) VALUES
      ($1,$3,$4,$5,'backfill-old-payment','postar','native_qr',4000,'CNY','pending',clock_timestamp()-interval '8 days'),
      ($2,$3,$4,$6,'backfill-recent-payment','postar','native_qr',4000,'CNY','pending',clock_timestamp()-interval '10 minutes')
    `, [oldPaymentId, recentPaymentId, tenantId, storeId, oldOrderId, recentOrderId])
    await client.query(`
      INSERT INTO mbox.verified_provider_observations(
        tenant_id,store_id,provider,subject_kind,payment_id,verification_kind,
        provider_event_id,integration_ref,observed_status,provider_transaction_id,
        reported_amount_minor,reported_currency,evidence_sha256,occurred_at,recorded_at
      )
      SELECT $1::uuid,$2::uuid,'postar','payment',$3::uuid,'active_query_binding',
        'old-payment-query-'||series::text,'backfill-old-payment','payment_pending',
        'old-provider-transaction',4000,'CNY',repeat('a',64),
        clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes'
      FROM generate_series(1,25) series
      UNION ALL
      SELECT $1::uuid,$2::uuid,'postar','payment',$4::uuid,'active_query_binding',
        'recent-payment-query-'||series::text,'backfill-recent-payment','payment_pending',
        'recent-provider-transaction',4000,'CNY',repeat('b',64),
        clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'
      FROM generate_series(1,21) series
    `, [tenantId, storeId, oldPaymentId, recentPaymentId])

    const beforeCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM mbox.verified_provider_observations
      WHERE payment_id IN ($1,$2)
    `, [oldPaymentId, recentPaymentId])
    const migration161 = (await loadNormalizedMigrations()).find((entry) => entry.version === '161')
    expect(migration161).toBeDefined()
    await applyMigration(client, migration161!)

    const states = await client.query<{
      payment_id: string
      phase: string
      total_query_count: number
      released_query_count: number
      next_query_at: string | null
      stop_reason: string | null
      delay_hours: number | null
    }>(`
      SELECT payment_id::text,phase,total_query_count,released_query_count,
        next_query_at::text,stop_reason,
        extract(epoch FROM next_query_at-clock_timestamp())/3600 AS delay_hours
      FROM mbox.payment_reconciliation_states
      WHERE payment_id IN ($1,$2)
      ORDER BY payment_id
    `, [oldPaymentId, recentPaymentId])
    const oldState = states.rows.find((row) => row.payment_id === oldPaymentId)
    const recentState = states.rows.find((row) => row.payment_id === recentPaymentId)
    expect(oldState).toMatchObject({
      phase: 'stopped', total_query_count: 25, released_query_count: 25,
      next_query_at: null, stop_reason: 'finance_review_required',
    })
    expect(recentState).toMatchObject({
      phase: 'released', total_query_count: 21, released_query_count: 21,
      stop_reason: null,
    })
    expect(Number(recentState?.delay_hours)).toBeGreaterThan(23)

    const afterCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM mbox.verified_provider_observations
      WHERE payment_id IN ($1,$2)
    `, [oldPaymentId, recentPaymentId])
    expect(beforeCount.rows[0]?.count).toBe(46)
    expect(afterCount.rows[0]?.count).toBe(46)
  })
})

async function initializeHistoricalSchema(client: Client): Promise<void> {
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
    await client.query(`
      INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum)
      VALUES($1,$2,$3)
    `, [migration.version, migration.filename, migration.checksum])
    await client.query(`
      UPDATE mbox.normalized_schema_metadata
      SET schema_version=$1,updated_at=clock_timestamp()
      WHERE singleton=true
    `, [migration.version])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('Invalid database name')
  return `"${value.replaceAll('"', '""')}"`
}
