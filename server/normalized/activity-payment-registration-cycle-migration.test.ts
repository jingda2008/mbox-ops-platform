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

integration('145 activity payment registration-cycle upgrade', () => {
  const databaseName = `mbox_activity_cycle_145_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let admin: Client
  let client: Client
  let databaseCreated = false
  let migrationLockHeld = false

  beforeAll(async () => {
    if (!/^mbox_activity_cycle_145_\d+_[0-9a-f]{8}$/.test(databaseName)) {
      throw new Error('Unsafe activity-cycle migration test database name')
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
      for (const migration of migrations.filter((entry) => entry.version <= '144')) {
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

  it('leaves an earlier closed payment unassigned and never credits its late success to the reopened cycle', async () => {
    const id = {
      tenant: randomUUID(), store: randomUUID(), employee: randomUUID(), customer: randomUUID(),
      activity: randomUUID(), registration: randomUUID(), oldPayment: randomUUID(), currentPayment: randomUUID(),
    }
    const suffix = id.tenant.replaceAll('-', '').slice(0, 8)
    await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$2,'145 tenant')`, [
      id.tenant, `cycle145-${suffix}`,
    ])
    await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$3,'145 store')`, [
      id.store, id.tenant, `cycle145-${suffix}`,
    ])
    await client.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1::uuid,$2::uuid,$3::uuid,'CYCLE145','迁移测试员工')
    `, [id.employee, id.tenant, id.store])
    await client.query(`
      INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,'cycle145-customer')
    `, [id.customer, id.tenant, id.store])
    await client.query(`
      INSERT INTO mbox.community_activities(
        id,tenant_id,store_id,public_id,activity_kind,title,summary,
        starts_at,ends_at,assembly_location,capacity,fee_amount_minor,
        deposit_amount_minor,registration_payment_mode,refund_policy_snapshot,
        safety_snapshot,sales_copy,safety_policy_version,safety_acknowledgement_text,
        safety_requirements,refund_policy_version,refund_policy_summary,activity_details,
        included_items,participation_requirements,contact_instructions,
        status,published_at,created_by_employee_id
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,'cycle145-activity','member_night','迁移周期活动','验证晚到付款不污染新报名周期',
        clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 2 hours','M-BOX',8,1000,
        0,'full_required','{"policyVersion":"refund-v1","summary":"测试退款规则"}'::jsonb,
        '{"policyVersion":"safety-v1","acknowledgementText":"我已阅读安全要求","requirements":["遵守安全要求"]}'::jsonb,
        '{"details":"迁移周期活动完整详情"}'::jsonb,'safety-v1','我已阅读安全要求',
        ARRAY['遵守安全要求']::text[],'refund-v1','测试退款规则','迁移周期活动完整详情。',
        '{}'::text[],'{}'::text[],'报名后由负责人联系','published',clock_timestamp(),$4::uuid
      )
    `, [id.activity, id.tenant, id.store, id.employee])
    await client.query(`
      INSERT INTO mbox.community_activity_registrations(
        id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,
        status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,
        paid_amount_minor,currency,contact_snapshot,safety_acknowledgement,
        refund_policy_snapshot,idempotency_key,payment_due_at,seat_hold_expires_at,
        registration_cycle,requested_payment_choice,requested_payment_method,
        requested_amount_due_minor,acknowledged_safety_policy_version,
        acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,'cycle145-registration',$4::uuid,$5::uuid,1,
        'payment_pending','full','pending',1000,1000,0,'CNY',NULL,
        '{"acknowledged":true,"policyVersion":"safety-v1"}'::jsonb,
        '{"policyVersion":"refund-v1","summary":"测试退款规则"}'::jsonb,
        'cycle145-registration-key',clock_timestamp()+interval '15 minutes',clock_timestamp()+interval '15 minutes',
        2,'full','jsapi',1000,'safety-v1','refund-v1',clock_timestamp(),'mini_program'
      )
    `, [id.registration, id.tenant, id.store, id.activity, id.customer])
    await client.query(`
      INSERT INTO mbox.payments(
        id,tenant_id,store_id,payable_kind,order_id,activity_registration_id,
        public_id,provider,method,amount_minor,currency,status,provider_snapshot
      ) VALUES
        ($1::uuid,$3::uuid,$4::uuid,'activity_registration',NULL,$5::uuid,
          'cycle145-old-payment','postar','jsapi',1000,'CNY','closed','{}'::jsonb),
        ($2::uuid,$3::uuid,$4::uuid,'activity_registration',NULL,$5::uuid,
          'cycle145-current-payment','postar','jsapi',1000,'CNY','pending','{}'::jsonb)
    `, [id.oldPayment, id.currentPayment, id.tenant, id.store, id.registration])
    await client.query(`
      UPDATE mbox.community_activity_registrations
      SET payment_id=$4::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [id.tenant, id.store, id.registration, id.currentPayment])

    const migration145 = (await loadNormalizedMigrations()).find((entry) => entry.version === '145')
    expect(migration145).toBeDefined()
    await applyMigration(client, migration145!)

    const cycles = await client.query<{
      public_id: string
      activity_registration_cycle: number | null
      status: string
    }>(`
      SELECT public_id,activity_registration_cycle,status
      FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY public_id
    `, [id.tenant, id.store])
    expect(cycles.rows).toEqual([
      { public_id: 'cycle145-current-payment', activity_registration_cycle: 2, status: 'pending' },
      { public_id: 'cycle145-old-payment', activity_registration_cycle: null, status: 'closed' },
    ])

    await expect(client.query(`
      UPDATE mbox.payments
      SET activity_registration_cycle=3
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [id.tenant, id.store, id.currentPayment])).rejects.toMatchObject({ code: '23514' })

    await expect(client.query(`
      INSERT INTO mbox.payments(
        tenant_id,store_id,payable_kind,order_id,activity_registration_id,
        public_id,provider,method,amount_minor,currency,status,provider_snapshot
      ) VALUES($1::uuid,$2::uuid,'activity_registration',NULL,$3::uuid,
        'cycle145-missing-cycle','postar','jsapi',1000,'CNY','failed','{}'::jsonb)
    `, [id.tenant, id.store, id.registration])).rejects.toMatchObject({ code: '23514' })

    await expect(client.query(`
      UPDATE mbox.payments
      SET status='succeeded',provider_transaction_id='cycle145-late-provider',
        succeeded_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [id.tenant, id.store, id.oldPayment])).resolves.toMatchObject({ rowCount: 1 })

    const promotionFacts = await client.query(`
      SELECT registration_cycle,payment_id
      FROM mbox.loyalty_promotion_trigger_facts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND trigger_kind='activity_payment' AND registration_id=$3::uuid
    `, [id.tenant, id.store, id.registration])
    expect(promotionFacts.rows).toEqual([])
    const awards = await client.query(`
      SELECT count(*)::integer AS count
      FROM mbox.loyalty_promotion_awards
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND registration_id=$3::uuid AND registration_cycle=2
    `, [id.tenant, id.store, id.registration])
    expect(awards.rows[0]?.count).toBe(0)
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
  if (!/^mbox_activity_cycle_145_\d+_[0-9a-f]{8}$/.test(value)) {
    throw new Error('Unsafe PostgreSQL identifier')
  }
  return `"${value}"`
}
