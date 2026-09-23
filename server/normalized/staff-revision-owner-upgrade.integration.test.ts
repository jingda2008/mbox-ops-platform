import {randomUUID} from 'node:crypto'
import {Client} from 'pg'
import {describe,expect,it} from 'vitest'
import {loadNormalizedMigrations,unwrapNormalizedMigrationTransaction} from '../migrate-normalized.js'

const url=process.env.TEST_NORMALIZED_ADMIN_URL??process.env.TEST_NORMALIZED_DATABASE_URL
const identifier=(name:string)=>`"${name.replaceAll('"','""')}"`
;(url?describe:describe.skip)('staff revision across maintenance account replacement',()=>{
  it('reproduces the old-owner failure, repairs only the trigger boundary and rejects forged sources',async()=>{
    const suffix=randomUUID().replaceAll('-','').slice(0,12)
    const database=`staff_revision_${suffix}`,old=`staff_owner_${suffix}`,runtime=`staff_runtime_${suffix}`
    const clusterUrl=new URL(url!);clusterUrl.pathname='/postgres'
    const admin=new Client({connectionString:clusterUrl.toString()})
    let client:Client|undefined
    await admin.connect()
    try{
      await admin.query(`CREATE ROLE ${identifier(old)} NOLOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION`)
      // Historical migrations manage the canonical NOLOGIN group. Match its
      // creator's administrative grant without inheriting new runtime grants.
      if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='mbox_runtime'")).rowCount){
        await admin.query('CREATE ROLE mbox_runtime NOLOGIN NOINHERIT')
      }
      await admin.query(`GRANT mbox_runtime TO ${identifier(old)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
      await admin.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(old)} TEMPLATE template0`)
      const target=new URL(url!);target.pathname=`/${database}`
      client=new Client({connectionString:target.toString()});await client.connect()
      await client.query(`SET ROLE ${identifier(old)}`)
      await client.query(`CREATE SCHEMA mbox;
        CREATE TABLE mbox.normalized_schema_metadata(singleton boolean PRIMARY KEY DEFAULT true,
          schema_flavor text NOT NULL,schema_version text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE mbox.normalized_schema_migrations(version text PRIMARY KEY,filename text NOT NULL UNIQUE,
          checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
        INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version) VALUES(true,'normalized-core-v1','000')`)
      const migrations=await loadNormalizedMigrations()
      const apply=async(from:number,to:number)=>{
        for(const migration of migrations.filter(m=>Number(m.version)>=from&&Number(m.version)<=to)){
          await client!.query('BEGIN')
          try{
            await client!.query(unwrapNormalizedMigrationTransaction(migration.sql))
            await client!.query('INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum) VALUES($1,$2,$3)',[migration.version,migration.filename,migration.checksum])
            await client!.query('COMMIT')
          }catch(error){await client!.query('ROLLBACK');throw error}
        }
      }
      await apply(1,224)
      await client.query('RESET ROLE')
      await apply(225,240)
      const tenant=randomUUID(),store=randomUUID()
      await client.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'owner upgrade fixture')",[tenant])
      const createStore=()=>client!.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'owner','owner','Asia/Shanghai','06:00')",[store,tenant])
      await expect(createStore()).rejects.toMatchObject({code:'42501',message:'permission denied for table staff_access_revisions'})
      expect((await client.query('SELECT count(*)::int count FROM mbox.stores WHERE id=$1',[store])).rows[0].count).toBe(0)
      const before=(await client.query(`SELECT proowner::regrole::text owner FROM pg_proc WHERE oid='mbox.seed_member_card_permission_definitions()'::regprocedure`)).rows[0]
      expect(before.owner).toBe(old)
      await apply(241,241)
      await createStore()
      const revision=async()=>Number((await client!.query('SELECT revision FROM mbox.staff_access_revisions WHERE tenant_id=$1 AND store_id=$2',[tenant,store])).rows[0].revision)
      const initial=await revision();expect(initial).toBeGreaterThan(0)
      expect((await client.query(`SELECT proowner::regrole::text owner FROM pg_proc WHERE oid='mbox.seed_member_card_permission_definitions()'::regprocedure`)).rows[0]).toEqual(before)
      expect((await client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[old])).rows[0].rolcanlogin).toBe(false)
      await admin.query(`CREATE ROLE ${identifier(runtime)} NOLOGIN; GRANT mbox_runtime TO ${identifier(runtime)}`)
      expect((await client.query("SELECT has_function_privilege($1,'mbox.advance_staff_access_revision()','EXECUTE') allowed",[runtime])).rows[0].allowed).toBe(false)
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${identifier(runtime)}`)
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[tenant,store])
      await client.query("UPDATE mbox.staff_permission_definitions SET name='updated by restricted runtime' WHERE tenant_id=$1 AND store_id=$2 AND code='member.card.review'",[tenant,store])
      await client.query('COMMIT')
      expect(await revision()).toBe(initial+1)
      const foreignTenant=randomUUID(),foreignStore=randomUUID()
      await client.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'other scope')",[foreignTenant])
      await client.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'other','other','Asia/Shanghai','06:00')",[foreignStore,foreignTenant])
      const foreignRevision=async()=>Number((await client!.query('SELECT revision FROM mbox.staff_access_revisions WHERE tenant_id=$1 AND store_id=$2',[foreignTenant,foreignStore])).rows[0].revision)
      const foreignBefore=await foreignRevision()
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${identifier(runtime)}`)
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[tenant,store])
      expect((await client.query("UPDATE mbox.staff_permission_definitions SET name='forbidden' WHERE tenant_id=$1 AND store_id=$2",[foreignTenant,foreignStore])).rowCount).toBe(0)
      await expect(client.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'forged.scope','forged')",[foreignTenant,foreignStore])).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK')
      expect(await foreignRevision()).toBe(foreignBefore)
      expect(await revision()).toBe(initial+1)
      // Even a trusted installer must not make a caller-owned relation an
      // alternative route to another tenant's revision counter.
      await client.query(`CREATE TEMP TABLE forged_revision(tenant_id uuid,store_id uuid);
        CREATE TRIGGER forged BEFORE INSERT ON forged_revision FOR EACH ROW EXECUTE FUNCTION mbox.advance_staff_access_revision()`)
      await expect(client.query('INSERT INTO forged_revision VALUES($1,$2)',[tenant,store])).rejects.toMatchObject({code:'42501'})
      expect(await revision()).toBe(initial+1)
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${identifier(runtime)}`)
      await client.query('CREATE TEMP TABLE runtime_forged_revision(tenant_id uuid,store_id uuid)')
      await expect(client.query('CREATE TRIGGER forged BEFORE INSERT ON runtime_forged_revision FOR EACH ROW EXECUTE FUNCTION mbox.advance_staff_access_revision()')).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK')
      expect(await revision()).toBe(initial+1)
    }finally{
      await client?.end()
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`)
      await admin.query(`DROP ROLE IF EXISTS ${identifier(runtime)}`)
      await admin.query(`DROP ROLE IF EXISTS ${identifier(old)}`)
      await admin.end()
    }
  },60000)
})
