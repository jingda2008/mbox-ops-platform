import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
} from '../migrate-normalized.js'

const sourceDatabaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = sourceDatabaseUrl ? describe : describe.skip

integration('migration 082 loyalty refund application backfill', () => {
  const databaseName = `mbox_loyalty_082_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let admin: Client
  let client: Client
  let databaseCreated = false

  beforeAll(async () => {
    if (!/^mbox_loyalty_082_\d+_[0-9a-f]{8}$/.test(databaseName)) {
      throw new Error('Unsafe loyalty migration test database name')
    }
    const adminUrl = new URL(sourceDatabaseUrl!)
    adminUrl.pathname = '/postgres'
    const isolatedUrl = new URL(sourceDatabaseUrl!)
    isolatedUrl.pathname = `/${databaseName}`
    admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`SELECT pg_advisory_lock(hashtext('mbox.normalized.historical-migration-test'))`)
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
      databaseCreated = true
      client = new Client({ connectionString: isolatedUrl.toString() })
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
      INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version)
      VALUES(true,$1,'000')
      `, [NORMALIZED_SCHEMA_FLAVOR])
      const migrations = await loadNormalizedMigrations()
      for (const migration of migrations.filter((entry) => Number(entry.version)<=81)) {
        await client.query(migration.sql)
        await client.query(`
        INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum) VALUES($1,$2,$3)
        `, [migration.version, migration.filename, migration.checksum])
      }
    } finally {
      await admin.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized.historical-migration-test'))`)
    }
  }, 30_000)

  afterAll(async () => {
    await client?.end().catch(() => undefined)
    if (databaseCreated) {
      await admin.query(`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()
      `, [databaseName]).catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  it('repairs a historical tiny refund only from typed refund facts and records zero rounded deltas', async () => {
    const id = {
      tenant: randomUUID(), store: randomUUID(), employeeA: randomUUID(), employeeB: randomUUID(),
      employeeC: randomUUID(), area: randomUUID(), table: randomUUID(), session: randomUUID(),
      customer: randomUUID(), membership: randomUUID(), account: randomUUID(), policy: randomUUID(),
      product: randomUUID(), order: randomUUID(), item: randomUUID(), payment: randomUUID(),
      award: randomUUID(), refund: randomUUID(), refundItem: randomUUID(),
    }
    const suffix = id.tenant.replaceAll('-', '').slice(0, 8)
    await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'082 Tenant')`,
      [id.tenant, `l82-${suffix}`])
    await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'082 Store')`,
      [id.store, id.tenant, `l82-${suffix}`])
    await client.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
        ($1,$4,$5,$6,'A','active'),($2,$4,$5,$7,'B','active'),($3,$4,$5,$8,'C','active')
    `, [
      id.employeeA, id.employeeB, id.employeeC, id.tenant, id.store,
      `L82A-${suffix}`, `L82B-${suffix}`, `L82C-${suffix}`,
    ])
    await client.query(`
      INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'L82','082 Area','bar')
    `, [id.area, id.tenant, id.store])
    await client.query(`
      INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
      VALUES($1,$2,$3,$4,'L82','082 Table',4,'available')
    `, [id.table, id.tenant, id.store, id.area])
    await client.query(`
      INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
      VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')
    `, [id.session, id.tenant, id.store, id.table, `l82-session-${suffix}`])
    await client.query(`
      INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      VALUES($1,$2,$3,$4,'active')
    `, [id.customer, id.tenant, id.store, `l82-customer-${suffix}`])
    await client.query(`
      INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status)
      VALUES($1,$2,$3,$4,$5,'member','active')
    `, [id.membership, id.tenant, id.store, id.customer, `MBXL82${suffix.toUpperCase()}`])
    await client.query(`
      INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,available_points,growth_value)
      VALUES($1,$2,$3,$4,$5,80,80)
    `, [id.account, id.tenant, id.store, id.membership, id.customer])
    await client.query(`
      INSERT INTO mbox.loyalty_policy_versions(
        id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,
        growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,
        drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,
        published_at,publication_mode,reason
      ) VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,'2026-08-01T00:00:00Z',
        $4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z','separated','082回填测试规则')
    `, [id.policy, id.tenant, id.store, id.employeeA, id.employeeB, id.employeeC])
    await client.query(`
      INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,status,loyalty_eligible)
      VALUES($1,$2,$3,$4,'082 Product','drink','bar','active',true)
    `, [id.product, id.tenant, id.store, `L82P-${suffix}`])
    await client.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,
        submitted_at,settlement_mode,fulfillment_state,loyalty_policy_version_id
      ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',8000,0,8000,'CNY',$6,
        '2026-08-16T06:00:00Z','immediate_payment','active',$7)
    `, [id.order, id.tenant, id.store, id.session, `l82-order-${suffix}`, id.customer, id.policy])
    await client.query(`
      INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,
        currency,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,
        loyalty_eligibility_source,status
      ) VALUES($1,$2,$3,$4,$5,1,8000,8000,'CNY','bar','{}',true,'catalog_product','submitted')
    `, [id.item, id.tenant, id.store, id.order, id.product])
    await client.query(`
      INSERT INTO mbox.payments(
        id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
        method,amount_minor,currency,status,succeeded_at
      ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',8000,'CNY','partially_refunded','2026-08-16T06:01:00Z')
    `, [id.payment, id.tenant, id.store, id.order, `l82-payment-${suffix}`, `l82-cash-${suffix}`])
    await client.query(`
      INSERT INTO mbox.loyalty_order_awards(
        id,tenant_id,store_id,membership_id,customer_id,order_id,payment_id,policy_version_id,
        eligible_amount_minor,awarded_points,awarded_growth,currency,awarded_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,8000,80,80,'CNY','2026-08-16T06:01:00Z')
    `, [
      id.award, id.tenant, id.store, id.membership, id.customer,
      id.order, id.payment, id.policy,
    ])
    await client.query(`
      INSERT INTO mbox.refunds(
        id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,
        status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
      ) VALUES($1,$2,$3,$4,$5,$6,1,'CNY','succeeded','微额退款',$7,$8,'复核通过','2026-08-16T07:00:00Z')
    `, [
      id.refund, id.tenant, id.store, id.payment, `l82-refund-${suffix}`,
      `l82-provider-refund-${suffix}`, id.employeeA, id.employeeB,
    ])
    await client.query(`
      INSERT INTO mbox.refund_items(id,tenant_id,store_id,refund_id,order_item_id,amount_minor,currency)
      VALUES($1,$2,$3,$4,$5,1,'CNY')
    `, [id.refundItem, id.tenant, id.store, id.refund, id.item])

    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version==='082')
    expect(migration).toBeDefined()
    await client.query(migration!.sql)

    const result = await client.query(`
      SELECT award.reversed_amount_minor::text AS reversed_amount,
        application.eligible_refund_amount_minor::text AS applied_amount,
        application.reversed_points,application.reversed_growth
      FROM mbox.loyalty_order_awards award
      JOIN mbox.loyalty_award_refund_applications application
        ON application.award_id=award.id
      WHERE award.id=$1
    `, [id.award])
    expect(result.rows[0]).toEqual({
      reversed_amount: '1', applied_amount: '1', reversed_points: 0, reversed_growth: 0,
    })
    expect((await client.query(`
      SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true
    `)).rows[0]?.schema_version).toBe('082')
  }, 30_000)
})

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('Unsafe database identifier')
  return `"${value}"`
}
