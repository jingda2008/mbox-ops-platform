import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { describe,expect,it } from 'vitest'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
  unwrapNormalizedMigrationTransaction,
} from '../migrate-normalized.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl ? describe : describe.skip

integration('096 table location historical upgrade',() => {
  it('upgrades real 001-095 history without rewriting old location or trusting stale tokens',async () => {
    const base=new URL(databaseUrl!)
    const databaseName=`mbox_upgrade096_${randomUUID().replaceAll('-','')}`
    const adminUrl=new URL(base);adminUrl.pathname='/postgres'
    const targetUrl=new URL(base);targetUrl.pathname=`/${databaseName}`
    const admin=new Client({ connectionString:adminUrl.toString() })
    await admin.connect()
    await admin.query(`SELECT pg_advisory_lock(hashtext('mbox.normalized.historical-migration-test'))`)
    let migrationLockHeld=true
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const client=new Client({ connectionString:targetUrl.toString() })
    await client.connect()
    try {
      const migrations=await loadNormalizedMigrations()
      await client.query(`CREATE SCHEMA mbox`)
      await client.query(`CREATE TABLE mbox.normalized_schema_metadata(
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_flavor text NOT NULL,
        schema_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
      await client.query(`CREATE TABLE mbox.normalized_schema_migrations(
        version text PRIMARY KEY,filename text NOT NULL UNIQUE,checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
      await client.query(`INSERT INTO mbox.normalized_schema_metadata(
        singleton,schema_flavor,schema_version) VALUES(true,$1,'000')`,[NORMALIZED_SCHEMA_FLAVOR])
      for (const migration of migrations.filter((item) => item.version<='095')) {
        await client.query('BEGIN')
        try {
          await client.query(unwrapNormalizedMigrationTransaction(migration.sql))
          await client.query(`INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum)
            VALUES($1,$2,$3)`,[migration.version,migration.filename,migration.checksum])
          await client.query(`UPDATE mbox.normalized_schema_metadata
            SET schema_version=$1,updated_at=clock_timestamp() WHERE singleton=true`,[migration.version])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
      await admin.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized.historical-migration-test'))`)
      migrationLockHeld=false
      const tenant=randomUUID(),store=randomUUID(),area=randomUUID(),employee=randomUUID()
      const secondTransferEmployee=randomUUID()
      const [tableA,tableB,tableC,tableD]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()]
      const [closedSession,movedSession,leftBeforeSession]=[randomUUID(),randomUUID(),randomUUID()]
      const [closedCustomer,movedCustomer,leftCustomer]=[randomUUID(),randomUUID(),randomUUID()]
      const staleGuestSession=randomUUID()
      await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Upgrade tenant')`,
        [tenant,`upgrade-${tenant.slice(0,8)}`])
      await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Upgrade store')`,
        [store,tenant,`upgrade-${store.slice(0,8)}`])
      await client.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
        VALUES($1,$2,$3,'UPGRADE','升级区','indoor')`,[area,tenant,store])
      await client.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
        VALUES($1,$3,$4,'upgrade-manager','升级管理员'),
          ($2,$3,$4,'upgrade-operator','转桌员工')`,
      [employee,secondTransferEmployee,tenant,store])
      await client.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
        SELECT id,$3,$4,$5,code,code,8 FROM unnest($1::uuid[],$2::text[]) AS seeded(id,code)`,
      [[tableA,tableB,tableC,tableD],['UA','UB','UC','UD'],tenant,store,area])
      await client.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
        SELECT id,$2,$3,public_id FROM unnest($1::uuid[],$4::text[]) AS seeded(id,public_id)`,
      [[closedCustomer,movedCustomer,leftCustomer],tenant,store,
        ['upgrade-closed-customer','upgrade-moved-customer','upgrade-left-customer']])
      await client.query(`INSERT INTO mbox.table_sessions(
        id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,
        opened_by_employee_id,closed_by_employee_id,opened_at,closed_at
      ) VALUES
        ($1,$4,$5,$7,'upgrade-closed-session','2026-08-16',1,'closed',$6,$6,
          '2026-08-16T09:00:00Z','2026-08-16T09:30:00Z'),
        ($2,$4,$5,$7,'upgrade-moved-session','2026-08-16',1,'open',$6,NULL,
          '2026-08-16T10:00:00Z',NULL),
        ($3,$4,$5,$8,'upgrade-left-session','2026-08-16',1,'open',$6,NULL,
          '2026-08-16T11:00:00Z',NULL)`,
      [closedSession,movedSession,leftBeforeSession,tenant,store,employee,tableA,tableD])
      await client.query(`INSERT INTO mbox.table_session_customers(
        tenant_id,store_id,table_session_id,customer_id,relationship,linked_at
      ) VALUES
        ($1,$2,$3,$6,'primary','2026-08-16T09:05:00Z'),
        ($1,$2,$4,$7,'primary','2026-08-16T10:05:00Z'),
        ($1,$2,$5,$8,'primary','2026-08-16T11:05:00Z')`,
      [tenant,store,closedSession,movedSession,leftBeforeSession,closedCustomer,movedCustomer,leftCustomer])
      await client.query(`UPDATE mbox.table_session_customer_participations
        SET left_at='2026-08-16T11:07:00Z'
        WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND customer_id=$4`,
      [tenant,store,leftBeforeSession,leftCustomer])
      await client.query(`INSERT INTO mbox.guest_sessions(
        id,tenant_id,store_id,session_kind,customer_id,table_session_id,
        token_hash,device_hash,scopes,issued_at,expires_at,last_seen_at
      ) VALUES($1,$2,$3,'table',$4,$5,repeat('a',64),repeat('b',64),
        ARRAY['guest.session.read'],'2026-08-16T10:06:00Z','2026-08-16T12:00:00Z','2026-08-16T10:06:00Z')`,
      [staleGuestSession,tenant,store,movedCustomer,movedSession])
      await client.query(`INSERT INTO mbox.guest_session_events(
        tenant_id,store_id,guest_session_id,table_id,table_session_id,event_type,outcome,occurred_at
      ) VALUES($1,$2,$3,$4,$5,'guest_session.issued','succeeded','2026-08-16T10:06:00Z')`,
      [tenant,store,staleGuestSession,tableA,movedSession])
      await client.query(`INSERT INTO mbox.table_session_transfer_events(
        tenant_id,store_id,table_session_id,source_table_id,target_table_id,
        transferred_by_employee_id,reason,occurred_at
      ) VALUES
        ($1,$2,$3,$5,$6,$8,'旧版本第一次整桌转桌','2026-08-16T10:10:00Z'),
        ($1,$2,$3,$6,$7,$9,'旧版本第二次整桌转桌','2026-08-16T10:20:00Z'),
        ($1,$2,$4,$10,$6,$8,'顾客已离桌后的整桌转桌','2026-08-16T11:10:00Z')`,
      [tenant,store,movedSession,leftBeforeSession,tableA,tableB,tableC,employee,
        secondTransferEmployee,tableD])
      await client.query(`UPDATE mbox.table_sessions SET table_id=$1
        WHERE id=$2`,[tableC,movedSession])
      await client.query(`UPDATE mbox.table_sessions SET table_id=$1
        WHERE id=$2`,[tableB,leftBeforeSession])

      const migration096=migrations.find((item) => item.version==='096')!
      await client.query('BEGIN')
      await client.query(unwrapNormalizedMigrationTransaction(migration096.sql))
      await client.query('COMMIT')

      const closed=await client.query(`SELECT left_at::text,left_reason_code,table_id,left_by_employee_id
        FROM mbox.table_session_customer_participations WHERE table_session_id=$1`,[closedSession])
      expect(closed.rows[0]).toMatchObject({
        left_at:'2026-08-16 09:30:00+00',left_reason_code:'session_closed',table_id:tableA,
        left_by_employee_id:employee,
      })
      const moved=await client.query(`SELECT table_id,location_started_at::text,left_at::text,
          left_reason_code,left_by_employee_id,joined_legacy_transfer_event_id,
          left_legacy_transfer_event_id
        FROM mbox.table_session_customer_participations WHERE table_session_id=$1
        ORDER BY location_started_at`,[movedSession])
      expect(moved.rows).toHaveLength(3)
      expect(moved.rows[0]).toMatchObject({
        table_id:tableA,location_started_at:'2026-08-16 10:05:00+00',
        left_at:'2026-08-16 10:10:00+00',left_reason_code:'legacy_transfer',
        left_by_employee_id:employee,joined_legacy_transfer_event_id:null,
      })
      expect(moved.rows[0]?.left_legacy_transfer_event_id).not.toBeNull()
      expect(moved.rows[1]).toMatchObject({
        table_id:tableB,location_started_at:'2026-08-16 10:10:00+00',
        left_at:'2026-08-16 10:20:00+00',left_reason_code:'legacy_transfer',
        left_by_employee_id:secondTransferEmployee,
      })
      expect(moved.rows[1]?.joined_legacy_transfer_event_id)
        .toBe(moved.rows[0]?.left_legacy_transfer_event_id)
      expect(moved.rows[1]?.left_legacy_transfer_event_id).not.toBeNull()
      expect(moved.rows[2]).toMatchObject({
        table_id:tableC,location_started_at:'2026-08-16 10:20:00+00',left_at:null,
        left_reason_code:null,left_by_employee_id:null,
        joined_legacy_transfer_event_id:moved.rows[1]?.left_legacy_transfer_event_id,
        left_legacy_transfer_event_id:null,
      })
      const leftBefore=await client.query(`SELECT table_id,location_started_at::text,left_at::text,left_reason_code
        FROM mbox.table_session_customer_participations WHERE table_session_id=$1`,[leftBeforeSession])
      expect(leftBefore.rows[0]).toMatchObject({ table_id:tableD,
        location_started_at:'2026-08-16 11:05:00+00',left_at:'2026-08-16 11:07:00+00',
        left_reason_code:'legacy_departure_unknown' })
      const token=await client.query(`SELECT revoked_at,revoke_reason FROM mbox.guest_sessions WHERE id=$1`,
        [staleGuestSession])
      expect(token.rows[0]?.revoked_at).not.toBeNull()
      expect(token.rows[0]?.revoke_reason).toBe('table_location_changed')
      const legacyEvents=await client.query(`SELECT count(*)::integer AS count
        FROM mbox.table_session_transfer_events WHERE tenant_id=$1 AND store_id=$2`,[tenant,store])
      expect(legacyEvents.rows[0]?.count).toBe(3)
    } finally {
      if (migrationLockHeld) {
        await admin.query(`SELECT pg_advisory_unlock(hashtext('mbox.normalized.historical-migration-test'))`)
          .catch(()=>undefined)
      }
      await client.end()
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`,[databaseName])
      await admin.query(`DROP DATABASE "${databaseName}"`)
      await admin.end()
    }
  },120_000)
})
