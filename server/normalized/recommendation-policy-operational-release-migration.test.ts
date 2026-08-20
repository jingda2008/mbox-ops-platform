import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Client } from 'pg'
import { loadNormalizedMigrations,NORMALIZED_SCHEMA_FLAVOR } from '../migrate-normalized.js'

const sourceDatabaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=sourceDatabaseUrl?describe:describe.skip

integration('migration 092 legacy recommendation release boundary',()=>{
  const databaseName=`mbox_rec_release_${process.pid}_${randomUUID().replaceAll('-','').slice(0,8)}`
  let admin:Client
  let client:Client
  let databaseCreated=false
  let migration092:Awaited<ReturnType<typeof loadNormalizedMigrations>>[number]

  beforeAll(async()=>{
    if(!/^mbox_rec_release_\d+_[0-9a-f]{8}$/.test(databaseName))throw new Error('Unsafe recommendation release test database name')
    const adminUrl=new URL(sourceDatabaseUrl!);adminUrl.pathname='/postgres'
    const isolatedUrl=new URL(sourceDatabaseUrl!);isolatedUrl.pathname=`/${databaseName}`
    admin=new Client({connectionString:adminUrl.toString()});await admin.connect()
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);databaseCreated=true
    client=new Client({connectionString:isolatedUrl.toString()});await client.connect()
    await client.query(`CREATE SCHEMA mbox;
      CREATE TABLE mbox.normalized_schema_metadata(
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_flavor text NOT NULL,
        schema_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE mbox.normalized_schema_migrations(
        version text PRIMARY KEY,filename text NOT NULL UNIQUE,checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp());`)
    await client.query(`INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version)VALUES(true,$1,'000')`,[NORMALIZED_SCHEMA_FLAVOR])
    const migrations=await loadNormalizedMigrations()
    migration092=migrations.find((entry)=>entry.version==='092')!
    for(const migration of migrations.filter((entry)=>Number(entry.version)<=91)){
      await client.query(migration.sql)
      await client.query(`INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum)VALUES($1,$2,$3)`,[migration.version,migration.filename,migration.checksum])
    }
  },30_000)

  afterAll(async()=>{
    await client?.end().catch(()=>undefined)
    if(databaseCreated){
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[databaseName]).catch(()=>undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(()=>undefined)
    }
    await admin?.end().catch(()=>undefined)
  })

  it('rejects an old pending approval instead of inventing rationale, then preserves published legacy provenance',async()=>{
    const tenantId=randomUUID(),storeId=randomUUID(),drafterId=randomUUID(),approverId=randomUUID()
    await client.query(`INSERT INTO mbox.tenants(id,code,name)VALUES($1,$2,'Recommendation Migration Tenant')`,[tenantId,`rec-migration-${tenantId.slice(0,8)}`])
    await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)VALUES($1,$2,$3,'Recommendation Migration Store')`,[storeId,tenantId,`rec-migration-${storeId.slice(0,8)}`])
    await client.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)VALUES
      ($1,$3,$4,'REC_OLD_DRAFT','旧起草人'),($2,$3,$4,'REC_OLD_APPROVER','旧审批人')`,[drafterId,approverId,tenantId,storeId])
    await client.query(`INSERT INTO mbox.recommendation_policy_versions(
      tenant_id,store_id,public_id,policy_code,version,status,approved_at,published_at,explanation_template
    )VALUES($1,$2,'pre-092-published-policy','DEFAULT',1,'published',clock_timestamp(),clock_timestamp(),'旧已发布规则')`,[
      tenantId,storeId,
    ])
    await client.query(`INSERT INTO mbox.recommendation_policy_versions(
      tenant_id,store_id,public_id,policy_code,version,status,created_by_employee_id,
      approved_by_employee_id,approved_at,explanation_template
    )VALUES($1,$2,'pre-092-approved-policy','PENDING_OLD',1,'approved',$3,$4,clock_timestamp(),'旧待发布规则')`,[
      tenantId,storeId,drafterId,approverId,
    ])

    await expect(client.query(migration092.sql)).rejects.toThrow(/cannot be migrated without approval rationale/)
    await client.query('ROLLBACK')
    expect((await client.query(`SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true`)).rows[0]?.schema_version).toBe('091')

    await client.query(`DELETE FROM mbox.recommendation_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND public_id='pre-092-approved-policy'`,[tenantId,storeId])
    await client.query(migration092.sql)
    const legacy=await client.query(`SELECT status,publication_mode,publication_reason,effective_from IS NOT NULL AS has_effective_from,
        created_by_employee_id,published_by_employee_id
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1 AND store_id=$2 AND policy_code='DEFAULT'`,[tenantId,storeId])
    expect(legacy.rows).toEqual([{
      status:'published',publication_mode:'legacy_unverified',
      publication_reason:'092迁移前已发布；保留原始人员字段，不补造三人发布证据',
      has_effective_from:true,created_by_employee_id:null,published_by_employee_id:null,
    }])
  },30_000)
})

function quoteIdentifier(value:string){if(!/^[a-z][a-z0-9_]{1,62}$/.test(value))throw new Error('Unsafe database identifier');return `"${value}"`}
