import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
const execute=promisify(execFile)
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip
integration('print rollback guard uses real scoped restricted runtime',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()};let admin:Pool,script:string
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!);admin=new Pool({connectionString:databaseUrl})
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Rollback guard')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'guard','Rollback guard')",[scope.storeId,scope.tenantId])
  const source=await readFile('deploy/aliyun/release-state.sh','utf8')
  script=source.split("<<'NODE'\n")[1]!.split('\nNODE\n')[0]!.replace('/app/dist-normalized/server/normalized/runtime-database-identity.js',`${process.cwd()}/server/normalized/runtime-database-identity.ts`)
 },30000)
 afterAll(async()=>{await admin?.end()})
 async function check(environment:Record<string,string|undefined>={}){
  const result=await execute(process.execPath,['--import','tsx','-e',script],{env:{...process.env,DATABASE_URL:runtimeUrl,MBOX_TENANT_ID:scope.tenantId,MBOX_STORE_ID:scope.storeId,...environment}}).then(result=>({status:0,...result}),error=>error as {code:number;stdout:string})
  return JSON.parse(result.stdout)
 }
 it('allows non-cash inheritance and disabled cashier inheritance, blocks enabled cashier cutoff',async()=>{
  await admin.query("INSERT INTO mbox.print_ticket_policy_inheritance(tenant_id,store_id,ticket_kind) VALUES($1,$2,'bar_production')",[scope.tenantId,scope.storeId])
  expect(await check()).toMatchObject({status:'safe',tenantId:scope.tenantId,storeId:scope.storeId,policies:[]})
  await admin.query("INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies) VALUES($1,$2,'cashier_payment',false,1)",[scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.print_ticket_policy_inheritance(tenant_id,store_id,ticket_kind) VALUES($1,$2,'cashier_payment')",[scope.tenantId,scope.storeId])
  expect(await check()).toMatchObject({status:'safe',policies:[]})
  await admin.query("DELETE FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind='cashier_payment'",[scope.tenantId,scope.storeId])
  const blocked=await check();expect(blocked).toMatchObject({status:'blocked',reason:'cashier_payment_inherited_cutoff'});expect(blocked.policies).toHaveLength(1)
 })
 it('never treats absent RLS scope, mismatched scope, or admin credentials as an empty safe policy',async()=>{
  for(const environment of [{MBOX_TENANT_ID:''},{MBOX_STORE_ID:randomUUID()},{MBOX_TENANT_ID:randomUUID()},{DATABASE_URL:databaseUrl}]){
   expect(await check(environment)).toMatchObject({status:'blocked',reason:'scoped_runtime_query_failed'})
  }
 })
})
