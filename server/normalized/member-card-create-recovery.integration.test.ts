import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor,hashRequestFingerprint} from './command-executor.js'
import {memberCardApiPlugin} from './member-card-api.js'
import {nativeMemberCardsApiPlugin} from './native-member-cards-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('member card creation recovery with restricted LOGIN',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},actor=randomUUID(),other=randomUUID(),role=randomUUID()
 let admin:Pool,runtime:Pool,app:ReturnType<typeof Fastify>,day='2026-11-03',beforeExecute:(()=>Promise<void>)|undefined
 const payload=()=>({code:`CARD_${randomUUID().replaceAll('-','').toUpperCase()}`,name:'合成兴趣卡',terms:'测试申请说明',kind:'interest',availableFrom:'2026-01-01T00:00:00Z',availableUntil:null,cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,openImmediately:true})
 const send=(native:boolean,body:object,key=`native-business-${randomUUID()}`,employee=actor)=>app.inject({method:'POST',url:native?'/staff/native-member-cards/commands/create':'/staff/member-cards/projects',headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const value=(native:boolean,response:any)=>native?response.json().data.result:response.json().data
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const name of ['member_card_projects','member_card_applications','member_cards','benefits','audit_events','outbox_messages','idempotency_records'])result[name]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${name} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 const permission=async(code:string,enabled:boolean)=>{
  if(enabled)await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,code])
  else await admin.query('DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.role_id=$3 AND p.id=a.permission_id AND p.code=$4',[scope.tenantId,scope.storeId,role,code])
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);const transactions=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Card recovery')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Card recovery')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'CARD','Card')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,other]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of ['member.card.manage','loyalty.policy.publish']){await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code]);await permission(code,true)}
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const options={transactions,commands,resolveStaffContext:(req:any)=>({scope,employeeId:req.headers['x-test-employee']??actor,businessDate:day})}
  app=Fastify();await app.register(nativeMemberCardsApiPlugin,options);await app.register(memberCardApiPlugin,{...options,resolveSelfContext:()=>{throw new Error('no customer fixture')}});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 for(const native of [false,true]){
  it.each(['loyalty.policy.publish','member.card.manage','suspended'])(`${native?'native':'web'} save-and-open rejects old and new requests after %s revocation`,async revoked=>{
   const body=payload(),key=`native-business-${randomUUID()}`,first=await send(native,body,key)
   expect(first.statusCode,first.body).toBe(200);expect(value(native,first).status).toBe('open')
   const before=await snapshot()
   try{
    if(revoked==='suspended')await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor]);else await permission(revoked,false)
    expect((await send(native,body,key)).statusCode).toBe(403)
    expect((await send(native,{...body,code:payload().code})).statusCode).toBe(403)
    expect(await snapshot()).toEqual(before)
   }finally{
    if(revoked==='suspended')await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[actor]);else await permission(revoked,true)
   }
   const restored=await send(native,body,key);expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().meta.replayed).toBe(true);expect(value(native,restored)).toEqual(value(native,first));expect(await snapshot()).toEqual(before)
  })
  it(`${native?'native':'web'} rechecks publication permission after the route preflight`,async()=>{
   const body=payload(),key=`native-business-${randomUUID()}`,first=await send(native,body,key);expect(first.statusCode,first.body).toBe(200)
   const before=await snapshot()
   try{beforeExecute=()=>permission('loyalty.policy.publish',false);expect((await send(native,body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)}
   finally{beforeExecute=undefined;await permission('loyalty.policy.publish',true)}
  })
  it(`${native?'native':'web'} draft creation needs management only and recovery does not reopen a later-paused project`,async()=>{
   try{
    await permission('loyalty.policy.publish',false)
    const body={...payload(),openImmediately:false},key=`native-business-${randomUUID()}`
    const first=await send(native,body,key);expect(first.statusCode,first.body).toBe(200);expect(value(native,first).status).toBe('draft')
    expect((await send(native,body,key)).json().meta.replayed).toBe(true)
   }finally{await permission('loyalty.policy.publish',true)}
   const body=payload(),key=`native-business-${randomUUID()}`,first=await send(native,body,key);expect(first.statusCode,first.body).toBe(200)
   await admin.query("UPDATE mbox.member_card_projects SET status='paused' WHERE id=$1",[value(native,first).projectId])
   const before=await snapshot(),replay=await send(native,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(await snapshot()).toEqual(before)
  })
 }
 it.each(['code','availableFrom','both','neither'] as const)('web generated %s remains recoverable across concurrency, response loss and business-day change',async omitted=>{
  const body:Record<string,unknown>={...payload(),openImmediately:false}
  if(omitted==='code'||omitted==='both')delete body.code
  if(omitted==='availableFrom'||omitted==='both')delete body.availableFrom
  const key=`card-recovery-${randomUUID()}`
  const first=await send(false,body,key);expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot(),sameDay=await send(false,body,key);expect(sameDay.statusCode,sameDay.body).toBe(200);expect(sameDay.json().meta.replayed).toBe(true);day='2026-11-04'
  try{
   const replies=await Promise.all([send(false,body,key),send(false,body,key)])
   for(const r of replies){expect(r.statusCode,r.body).toBe(200);expect(r.json().meta.replayed).toBe(true);expect(value(false,r)).toEqual(value(false,first))}
   expect((await send(false,{...body,name:'同键改名'},key)).statusCode).toBe(409)
   expect((await send(false,body,key,other)).statusCode).toBe(409)
   expect(await snapshot()).toEqual(before)
  }finally{day='2026-11-03'}
 })
 it('web recovers an explicit legacy fingerprint without accepting a changed request',async()=>{
  const body={...payload(),openImmediately:false},key=`card-legacy-${randomUUID()}`,first=await send(false,body,key);expect(first.statusCode,first.body).toBe(200)
  const legacy={code:body.code,name:body.name,terms:body.terms,kind:body.kind,availableFrom:body.availableFrom,availableUntil:body.availableUntil,cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:actor,businessDate:day,flowMode:'simple',openImmediately:false}
  await admin.query("UPDATE mbox.idempotency_records SET request_sha256=$3 WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,key,hashRequestFingerprint(JSON.stringify(legacy))])
  const before=await snapshot(),replay=await send(false,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
  expect((await send(false,{...body,name:'篡改旧请求'},key)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 it('does not guess or recreate a legacy receipt whose generated intent cannot be verified',async()=>{
  const body={name:'旧默认值回执',kind:'interest',openImmediately:false},key=`card-unverifiable-${randomUUID()}`
  const first=await send(false,body,key);expect(first.statusCode,first.body).toBe(200)
  // A pre-fix server included its generated code/time in the hash. Never accept
  // a matching key alone, rewrite its hash, or issue a replacement request.
  await admin.query("UPDATE mbox.idempotency_records SET request_sha256=$3 WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,key,hashRequestFingerprint(JSON.stringify({oldGeneratedCode:randomUUID(),oldGeneratedTime:'2026-11-01T00:00:00Z'}))])
  const before=await snapshot();expect((await send(false,body,key)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })

})
