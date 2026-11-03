import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {HardwareRepository} from './hardware-repository.js'
import {hardwareApiPlugin} from './hardware-api.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('hardware receipts reauthorize current resource scope with restricted LOGIN',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},actor=randomUUID(),other=randomUUID(),role=randomUUID()
 const permissions=['hardware.manage','hardware.command','printer.manage','print.retry','print.reprint','work.kitchen']
 let admin:Pool,runtime:Pool,app:ReturnType<typeof Fastify>,transactions:ScopedPostgresTransactionRunner,beforeExecute:(()=>Promise<void>)|undefined
 const grant=async(codes:string[])=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const name of ['devices','hardware_commands','print_jobs','print_job_events','audit_events','outbox_messages','idempotency_records'])result[name]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${name} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);transactions=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Hardware recovery')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Hardware recovery')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'HARDWARE','Hardware')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,other]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of permissions)await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code])
  await grant(permissions)
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  app=Fastify();await app.register(hardwareApiPlugin,{transactions,commands,resolveContext:async req=>{
   const employeeId=String(req.headers['x-test-employee']??actor)
   const access=await transactions.run(scope,tx=>new StaffAccessRepository(tx).resolve(employeeId),{readOnly:true})
   return {scope,employeeId,businessDate:'2026-11-03',capabilities:access.permissions}
  }});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 const fixture=async(kind:string,printer=false)=>{
  const device=await transactions.run(scope,tx=>new HardwareRepository(tx).createDevice({code:randomUUID(),name:'隔离测试设备',deviceType:kind==='update'||kind==='command'?(printer?'printer':'controller'):'printer',stationCode:'kitchen'}))
  let id=device.id
  if(kind==='retry'||kind==='reprint'){
   const source=randomUUID()
   await admin.query("INSERT INTO mbox.outbox_messages(id,tenant_id,store_id,message_key,aggregate_type,aggregate_id,aggregate_version,message_type,payload) VALUES($1::uuid,$2,$3,$1::text,'test',$1::uuid,1,'test.print','{}')",[source,scope.tenantId,scope.storeId])
   const route=await transactions.run(scope,tx=>new HardwareRepository(tx).upsertPrinterRoute({code:randomUUID(),name:'隔离测试路由',stationCode:'kitchen',printerDeviceId:device.id,productCategoryCode:source}))
   const jobs=await transactions.run(scope,tx=>new HardwareRepository(tx).materializeFromOutbox({sourceOutboxMessageId:source,stationCode:'kitchen',productCategoryCode:source,sourceType:'kds',sourceReference:source,printSnapshot:{tableCode:'SYNTHETIC',productName:'测试内容',quantity:1}}))
   id=jobs.find(j=>j.printerRouteId===route.id)!.id
   await admin.query("UPDATE mbox.print_jobs SET status=$2,printed_at=CASE WHEN $2='printed' THEN clock_timestamp() ELSE NULL END WHERE id=$1",[id,kind==='retry'?'failed':'printed'])
  }
  const url=kind==='update'?`/hardware/devices/${id}`:kind==='command'?`/hardware/devices/${id}/commands`:`/hardware/print-jobs/${id}/${kind}`
  const body={reason:'隔离权限回归测试',...(kind==='update'?{name:'测试改名'}:kind==='command'?{commandType:'ping'}:{})}
  const send=(key:string,payload=body,employee=actor)=>app.inject({method:kind==='update'?'PATCH':'POST',url,headers:{'idempotency-key':key,'x-test-employee':employee},payload})
  return {id,body,send}
 }
 for(const kind of ['retry','reprint','update','command']){
  const allowed=kind==='update'?['hardware.manage']:kind==='command'?['hardware.command']:[`print.${kind}`,'work.kitchen']
  const narrowed=kind==='update'||kind==='command'?['printer.manage']:[`print.${kind}`]
  it.each(['scope','stale-scope','stale-operation','suspended'])(`${kind} rejects replay and fresh request after %s revocation`,async mode=>{
   await grant(allowed);const f=await fixture(kind),key=`hardware-test-${randomUUID()}`,first=await f.send(key)
   expect([200,202]).toContain(first.statusCode)
   const before=await snapshot()
   const revoke=async()=>{if(mode==='suspended')await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor]);else await grant(mode==='stale-operation'?[]:narrowed)}
   try{
    if(mode==='scope')await revoke();else beforeExecute=revoke
    const replay=await f.send(key);expect(replay.statusCode,replay.body).toBe(403)
    expect((await f.send(`hardware-new-${randomUUID()}`)).statusCode).toBe(403)
    expect(await snapshot()).toEqual(before)
   }finally{beforeExecute=undefined;await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[actor]);await grant(allowed)}
   const replay=await f.send(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:first.json().data,replayed:true});expect(await snapshot()).toEqual(before)
  })
  it(`${kind} denies a first attempt when scope is revoked after context resolution`,async()=>{
   await grant(allowed);const f=await fixture(kind),before=await snapshot()
   try{
    beforeExecute=()=>grant(narrowed)
    const response=await f.send(`hardware-race-${randomUUID()}`)
    expect(response.statusCode,response.body).toBe(403);expect(await snapshot()).toEqual(before)
   }finally{beforeExecute=undefined;await grant(allowed)}
  })
  it(`${kind} retains least privilege, immutable recovery and actor/payload/target conflict`,async()=>{
   await grant(kind==='update'||kind==='command'?['printer.manage']:allowed)
   const f=await fixture(kind,true),key=`hardware-control-${randomUUID()}`,first=await f.send(key);expect([200,202]).toContain(first.statusCode)
   // Current workflow state must not invalidate an already committed receipt.
   if(kind==='retry'||kind==='reprint')await admin.query("UPDATE mbox.print_jobs SET status='printed',printed_at=clock_timestamp() WHERE id=$1",[first.json().data.id])
   else await admin.query("UPDATE mbox.devices SET status='retired' WHERE id=$1",[f.id])
   const second=await fixture(kind,true),before=await snapshot()
   const replay=await f.send(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:first.json().data,replayed:true})
   expect((await f.send(key,{...f.body,reason:'改变原操作理由'})).statusCode).toBe(409)
   expect((await f.send(key,f.body,other)).statusCode).toBe(409)
   expect((await second.send(key)).statusCode).toBe(409)
   expect(await snapshot()).toEqual(before)
  })
 }
 it('rechecks privileged command kind on a printer when hardware command authority is lost',async()=>{
  await grant(['hardware.command']);const f=await fixture('command',true),key=`hardware-kind-${randomUUID()}`
  const body={...f.body,commandType:'open_cash_drawer'}
  const first=await f.send(key,body);expect(first.statusCode,first.body).toBe(202)
  const before=await snapshot()
  try{
   beforeExecute=()=>grant(['printer.manage'])
   expect((await f.send(key,body)).statusCode).toBe(403)
   expect((await f.send(`hardware-new-${randomUUID()}`,body)).statusCode).toBe(403)
   expect(await snapshot()).toEqual(before)
  }finally{beforeExecute=undefined;await grant(['hardware.command'])}
  const replay=await f.send(key,body);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().replayed).toBe(true);expect(await snapshot()).toEqual(before)
 })

})
