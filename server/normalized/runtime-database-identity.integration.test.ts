import {generateKeyPairSync,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {assertRuntimeDatabaseConnection,assertRuntimeDatabasePool,runtimeDatabaseLogin} from './runtime-database-identity.js'
import {verifySeparateMaintenanceDatabase} from './database-maintenance-connection.js'
import {loadNormalizedRuntimeConfig} from './normalized-runtime-config.js'
import {createNormalizedApp} from './normalized-app.js'
import {createNormalizedWorkerRuntime,REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES} from './normalized-worker-runtime.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {verifyNormalizedMigrationCompatibility} from '../verify-normalized-migration-compatibility.js'

// The caller supplies a disposable, already migrated database and a real LOGIN.
// This test never grants to or alters the shared mbox_runtime group.
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=runtimeUrl&&adminUrl?describe:describe.skip
function localTestTarget(value:string):URL {
  try {
    const url=new URL(value)
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      ||!url.username||!url.pathname.slice(1)||url.search||url.hash)throw new Error()
    if(!url.port)url.port='5432'
    return url
  } catch {throw new Error('Identity drift tests require explicit local PostgreSQL targets without URL parameters')}
}
integration('actual restricted PostgreSQL LOGIN integration',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()}
  let admin:Pool,runtime:Pool
  beforeAll(async()=>{
    const target=localTestTarget(adminUrl!)
    const runtimeTarget=localTestTarget(runtimeUrl!)
    const login=runtimeDatabaseLogin(runtimeTarget.toString())
    if(!/^\/(audit_security_|mbox_normalized_test_)[a-z0-9_]+$/.test(target.pathname)
      ||runtimeTarget.hostname!==target.hostname||runtimeTarget.port!==target.port||runtimeTarget.pathname!==target.pathname
      ||!/^audit_security_login_[a-f0-9]+$/.test(login))throw new Error('Identity drift tests require a disposable local audit_security database and unique audit_security_login role')
    admin=new Pool({connectionString:adminUrl,max:2});runtime=new Pool({connectionString:runtimeUrl,max:4})
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Security test')",[scope.tenantId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'security','Security','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
  })
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  it('accepts actual low login and rejects an admin connection even after SET ROLE',async()=>{
    expect(await assertRuntimeDatabasePool(runtime,runtimeUrl!)).toMatchObject({session_user:runtimeDatabaseLogin(runtimeUrl!),unsafe_attributes:false})
    await expect(assertRuntimeDatabasePool(admin,adminUrl!)).rejects.toMatchObject({code:'RUNTIME_DATABASE_IDENTITY_UNSAFE'})
    const client=await admin.connect()
    try {await client.query('SET ROLE mbox_runtime');await expect(assertRuntimeDatabaseConnection(client,'mbox_runtime')).rejects.toMatchObject({code:'RUNTIME_DATABASE_IDENTITY_UNSAFE'})}
    finally {await client.query('RESET ROLE');client.release()}
  })
  it('enforces missing and foreign scopes and denies DDL or recovery of admin authority',async()=>{
    expect((await runtime.query('SELECT id FROM mbox.stores')).rows).toEqual([])
    const runner=new ScopedPostgresTransactionRunner(runtime)
    expect(await runner.run(scope,async tx=>(await tx.query('SELECT id FROM mbox.stores')).rows)).toEqual([{id:scope.storeId}])
    expect(await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>(await tx.query('SELECT id FROM mbox.stores')).rows)).toEqual([])
    await expect(runner.run(scope,tx=>tx.query("INSERT INTO mbox.staff_access_revisions(tenant_id,store_id,revision) VALUES($1,$2,1)",[scope.tenantId,randomUUID()]))).rejects.toMatchObject({code:'42501'})
    const adminRole=runtimeDatabaseLogin(adminUrl!).replaceAll('"','""')
    const unexpectedRole=`audit_security_negative_${randomUUID().replaceAll('-','')}`
    try {for(const statement of [`SET ROLE "${adminRole}"`,'CREATE SCHEMA runtime_must_not_create',`CREATE ROLE "${unexpectedRole}"`,
      'ALTER TABLE mbox.stores DISABLE ROW LEVEL SECURITY','CREATE FUNCTION mbox.runtime_must_not_create() RETURNS int LANGUAGE SQL AS $$ SELECT 1 $$']) {
      await expect(runtime.query(statement),statement).rejects.toMatchObject({code:'42501'})
    }} finally {await admin.query(`DROP ROLE IF EXISTS "${unexpectedRole}"`)}
  })
  it('refuses unsafe attribute, membership, ownership and schema-create drift',async()=>{
    const login=runtimeDatabaseLogin(runtimeUrl!),role=`audit_security_extra_${randomUUID().replaceAll('-','')}`
    const unsafe=()=>expect(assertRuntimeDatabasePool(runtime,runtimeUrl!)).rejects.toMatchObject({code:'RUNTIME_DATABASE_IDENTITY_UNSAFE'})
    try {
      await admin.query(`ALTER ROLE "${login}" BYPASSRLS`);await unsafe();await admin.query(`ALTER ROLE "${login}" NOBYPASSRLS`)
      await admin.query(`CREATE ROLE "${role}" NOLOGIN`);await admin.query(`GRANT "${role}" TO "${login}"`);await unsafe()
      await admin.query(`REVOKE "${role}" FROM "${login}"`)
      await admin.query(`CREATE SCHEMA "${role}" AUTHORIZATION "${login}"`);await unsafe();await admin.query(`DROP SCHEMA "${role}"`)
      await admin.query(`GRANT CREATE ON SCHEMA mbox TO "${login}"`);await unsafe();await admin.query(`REVOKE CREATE ON SCHEMA mbox FROM "${login}"`)
      await admin.query(`CREATE FUNCTION public."${role}"() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`)
      await unsafe();await admin.query(`DROP FUNCTION public."${role}"()`)
    } finally {
      await admin.query(`ALTER ROLE "${login}" NOBYPASSRLS`)
      await admin.query(`REVOKE CREATE ON SCHEMA mbox FROM "${login}"`)
      await admin.query(`DROP FUNCTION IF EXISTS public."${role}"()`)
      await admin.query(`DROP SCHEMA IF EXISTS "${role}"`);await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    }
    await expect(assertRuntimeDatabasePool(runtime,runtimeUrl!)).resolves.toBeDefined()
  })
  it('reads migration metadata with the runtime login and separates maintenance on the same database',async()=>{
    expect((await verifyNormalizedMigrationCompatibility(runtimeUrl!)).status).toBe('pass')
    await expect(verifySeparateMaintenanceDatabase(runtimeUrl!,adminUrl!)).resolves.toBeUndefined()
    await expect(verifySeparateMaintenanceDatabase(runtimeUrl!,runtimeUrl!)).rejects.toThrow('维护凭据必须独立')
    const other=new URL(adminUrl!);other.pathname='/postgres'
    await expect(verifySeparateMaintenanceDatabase(runtimeUrl!,other.toString())).rejects.toThrow('维护凭据必须独立')
  })
  it('boots the production API and runs core and configured adapter worker families with separate actual low-login pools',async()=>{
    const config={...loadNormalizedRuntimeConfig({NODE_ENV:'test',DATABASE_URL:runtimeUrl,MBOX_TENANT_ID:scope.tenantId,MBOX_STORE_ID:scope.storeId,MBOX_NORMALIZED_SECRET:'test-only-secret-0123456789abcdef0123456789abcdef'})}
    config.deploymentTier='production'
    config.personalContactProtection={activeKeyId:'test-key',activeKey:Buffer.alloc(32,7),lookupKey:Buffer.alloc(32,8),legacyPhoneLookupKey:Buffer.alloc(32,9),previousKeys:[]}
    config.payment={provider:'postar',environment:'test',agencyId:'test-agency',merchantId:'test-merchant',publicKey:generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString(),callbackUrl:'https://example.invalid/payment',timeoutMs:1000,wechat:null}
    const appRuntime=await createNormalizedApp({config,logger:false})
    const workerPool=new Pool({connectionString:runtimeUrl,max:4})
    const errors:unknown[]=[]
    try {
      await assertRuntimeDatabasePool(workerPool,runtimeUrl!)
      const worker=createNormalizedWorkerRuntime({scope,workerId:'security-integration-worker',intervalMs:1000,
        hashSecret:config.secret,transactions:new ScopedPostgresTransactionRunner(workerPool),
        aiExecutions:{executeClaimedScheduled:async()=>{throw new Error('No external calls allowed')}},
        adapters:{capabilities:REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES,preflight:async()=>{},
          outbox:async()=>{},notification:async()=>{},print:{print:async()=>{}},sop:{execute:async()=>({state:'completed'})}},
        onError:(name,error)=>errors.push({name,error:String(error)}),
      })
      const response=await appRuntime.app.inject('/api/ready');expect(response.statusCode,response.body).toBe(200)
      const cycle=await worker.runOnce();expect(errors).toEqual([]);expect(cycle.failures).toEqual([])
      expect(cycle.workers.businessDay).not.toBeNull();expect(cycle.workers.print).not.toBeNull();expect(cycle.workers.outbox).not.toBeNull()
    }finally {await workerPool.end();await appRuntime.app.close()}
  })
})
