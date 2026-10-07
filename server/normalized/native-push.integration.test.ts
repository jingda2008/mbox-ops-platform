import { randomUUID, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { beforeAll,afterAll,describe,it,expect } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { nativePushApiPlugin } from './native-push-api.js'
import { NativePushRepository,lockNativePushInstallation } from './native-push-repository.js'
import { NativePushProtection,revocationHash } from './native-push-protection.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'
import type { NativePushActor,NativePushRegistration } from './native-push-contracts.js'
import { NativePushWorker } from './native-push-worker.js'
import type { NativePushSender,NativePushSendRequest } from './native-push-apns.js'
import type { NativePushConfig, GetuiPushConfig } from './native-push-config.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeDatabase=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const suite=database&&runtimeDatabase?describe:describe.skip
suite.each(['apns','getui'] as const)('native push %s scoped installation and irreversible revocation contract',(provider)=>{
 const tenant=randomUUID(),store=randomUUID(),employee=randomUUID(),otherEmployee=randomUUID(),role=randomUUID(),credential=randomUUID(),lease=randomUUID(),otherLease=randomUUID(),staff=randomUUID(),otherStaff=randomUUID(),foreignStaff=randomUUID()
 const scope={tenantId:tenant,storeId:store},deviceHash='d'.repeat(64),hashSecret='s'.repeat(64)
 let owner:Pool,runtime:Pool,tx:ScopedPostgresTransactionRunner,repo:NativePushRepository,app:FastifyInstance,disabled:FastifyInstance
 const actor:NativePushActor={scope,employeeId:employee,staffSessionId:staff,deviceAccessLeaseId:lease,businessDate:'2026-10-05'}
 const cfg:NativePushConfig={environment:'sandbox',topic:'com.mbox.staff',teamId:'ABCDEFGHIJ',keyId:'KLMNOPQRST',privateKey:'test transport only',tokenKey:randomBytes(32),tokenKeyId:'test-1',eventTtlSeconds:300}
 const getuiCfg:GetuiPushConfig={appId:'test-app-id',appKey:'test-app-key',masterSecret:'test-master-secret',environment:'production',topic:'test-app-id',tokenKey:cfg.tokenKey,tokenKeyId:cfg.tokenKeyId,eventTtlSeconds:300}
 const body=(revision=0):NativePushRegistration=>({expectedRevision:revision,platform:provider==='apns'?'ios':'android',provider,token:randomBytes(provider==='apns'?32:16).toString('hex'),permission:'authorized',appVersion:'1.0',revocationSecret:randomBytes(32).toString('base64url')})
 const headers=(who:NativePushActor=actor)=>({'x-mbox-staff-employee-id':who.employeeId,'x-mbox-staff-session-id':who.staffSessionId,'idempotency-key':'native-push-'+randomUUID()})
 const url=(id:string)=>'/api/native/push/installations/'+id
 const put=(id:string,payload=body(),head=headers(),target=app)=>target.inject({method:'PUT',url:url(id),payload,headers:head})
 const revoke=(id:string,revision:number,revocationSecret:string,ip='127.0.0.1')=>app.inject({method:'POST',url:url(id)+'/revoke-capability',payload:{revision,revocationSecret},remoteAddress:ip})
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);owner=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeDatabase});tx=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool);repo=new NativePushRepository(tx,cfg,hashSecret,getuiCfg)
  await owner.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Native push test')",[tenant,'push-'+tenant]);await owner.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'push','Push')",[store,tenant])
  await owner.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'first','First'),($2,$3,$4,'second','Second')",[employee,otherEmployee,tenant,store])
  await owner.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'PUSH','Push')",[role,tenant,store]);await owner.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$5,'2020-01-01'),($1,$2,$4,$5,'2020-01-01')",[tenant,store,employee,otherEmployee,role])
  await owner.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'service.view','Service') ON CONFLICT DO NOTHING",[tenant,store]);await owner.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='service.view'",[tenant,store,role])
  await owner.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,CURRENT_DATE,'scrypt$test',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',$4)",[credential,tenant,store,employee])
  await owner.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$3,$4,$5,CURRENT_DATE,$6,$7,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '12 hours'),($2,$3,$4,$5,CURRENT_DATE,$8,$9,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '12 hours')",[lease,otherLease,tenant,store,credential,deviceHash,'a'.repeat(64),'e'.repeat(64),'b'.repeat(64)])
  for(const [id,emp,device] of [[staff,employee,lease],[otherStaff,otherEmployee,lease],[foreignStaff,employee,otherLease]])await owner.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp()-interval '1 hour',statement_timestamp()+interval '5 hours',statement_timestamp()-interval '59 minutes')",[id,tenant,store,emp,device,randomBytes(32).toString('hex')])
  const resolve=async(request:{headers:Record<string,unknown>})=>{const sid=request.headers['x-mbox-staff-session-id'];return sid===otherStaff?{...actor,employeeId:otherEmployee,staffSessionId:otherStaff}:sid===foreignStaff?{...actor,staffSessionId:foreignStaff,deviceAccessLeaseId:otherLease}:actor}
  app=Fastify();await app.register(nativePushApiPlugin,{prefix:'/api/native/push',repository:repo,scope,resolveContext:resolve})
  disabled=Fastify();await disabled.register(nativePushApiPlugin,{prefix:'/api/native/push',repository:new NativePushRepository(tx,null,hashSecret),scope,resolveContext:resolve})
 })
 afterAll(async()=>{await app?.close();await disabled?.close();await runtime?.end();await owner?.end()})

 it('advertises Android-only configuration without APNs and rejects invalid CID and platform pairs',async()=>{
  const repository=new NativePushRepository(tx,null,hashSecret,getuiCfg)
  expect(await repository.capabilities(actor)).toMatchObject({enabled:true,reasonCode:null,platforms:{ios:{provider:'apns',configured:false,environment:null},android:{provider:'getui',configured:true,reasonCode:null}}})
  for(const token of ['A'.repeat(32),'a'.repeat(31),'a'.repeat(33),'x'.repeat(32),' '+ 'a'.repeat(32)]) {
   const response=await put(randomUUID(),{...body(),platform:'android',provider:'getui',token})
   expect(response.statusCode,response.body).toBe(400)
  }
  expect((await put(randomUUID(),{...body(),platform:'android',provider:'apns'})).json().error.code).toBe('PUSH_PROVIDER_UNSUPPORTED')
  expect((await put(randomUUID(),{...body(),platform:'android',provider:'getui',token:'a'.repeat(32),permission:'provisional'})).statusCode).toBe(400)
 })
 it('keeps platform/provider immutable across a valid next revision in repository and database',async()=>{
  const id=randomUUID();expect((await put(id)).statusCode).toBe(201)
  const other=provider==='apns'?{platform:'android' as const,provider:'getui' as const,token:'b'.repeat(32)}:{platform:'ios' as const,provider:'apns' as const,token:'b'.repeat(64)}
  expect((await put(id,{...body(1),...other})).json().error.code).toBe('PUSH_NOT_FOUND')
  await expect(tx.run(scope,t=>t.query("UPDATE mbox.native_push_installations SET revision=revision+1,platform=$2,provider=$3,environment='production',revocation_hash=$4 WHERE id=$1",[id,other.platform,other.provider,'f'.repeat(64)]))).rejects.toThrow('provider identity is immutable')
 })
 it('projects one source event to both providers exactly once with original ownership and token isolation',async()=>{
  const work=await pushWork(),otherId=randomUUID(),other=provider==='apns'?{platform:'android' as const,provider:'getui' as const,token:work.payload.token.slice(0,32)}:{platform:'ios' as const,provider:'apns' as const,token:work.payload.token}
  const otherPayload={...body(),...other}
  expect((await put(otherId,otherPayload)).statusCode).toBe(201)
  // A fresh event occurs after both registrations. The earlier event must not go to the late binding.
  const event=randomUUID()
  await owner.query("INSERT INTO mbox.service_task_events(id,tenant_id,store_id,service_task_id,event_type,to_status,actor_type,actor_employee_id) VALUES($1,$2,$3,$4,'task.reminded','pending','employee',$5)",[event,tenant,store,work.task,employee])
  const sent:{provider:string;token:string}[]=[]
  const sender=(p:string):NativePushSender=>({send:async r=>{sent.push({provider:p,token:r.token});return {status:'provider_accepted'}}})
  const mixed=new NativePushWorker(tx,cfg,hashSecret,sender('apns'),getuiCfg,sender('getui'))
  expect((await mixed.runBatch(scope,'mixed')).accepted).toBe(3)
  expect(sent.filter(s=>s.provider===provider)).toHaveLength(2)
  expect(sent.filter(s=>s.provider!==provider)).toEqual([{provider:other.provider,token:other.token}])
  expect((await mixed.runBatch(scope,'mixed-again')).accepted).toBe(0)
  const row=(await deliveries(otherId))[0]
  expect((await app.inject({url:'/api/native/push/deliveries/'+row.id+'/target',headers:headers({...actor,employeeId:otherEmployee,staffSessionId:otherStaff})})).statusCode).toBe(404)
  await revoke(otherId,1,otherPayload.revocationSecret)
  expect((await app.inject({url:'/api/native/push/deliveries/'+row.id+'/target',headers:headers()})).statusCode).toBe(404)
 })
 it('uses a real restricted LOGIN and tenant/store RLS including unknown scope',async()=>{
  const user=(await runtime.query('SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];expect(user).toEqual({rolcanlogin:true,rolsuper:false,rolbypassrls:false})
  const installation=randomUUID();expect((await put(installation)).statusCode).toBe(201)
  expect((await runtime.query('SELECT * FROM mbox.native_push_installations')).rows).toEqual([])
  expect(await tx.run({tenantId:randomUUID(),storeId:randomUUID()},async t=>(await t.query('SELECT * FROM mbox.native_push_installations')).rows)).toEqual([])
 })
 it('disabled defaults are explicit; Android is not a configured provider',async()=>{
  const response=await disabled.inject({url:'/api/native/push/capabilities',headers:headers()});expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toMatchObject({enabled:false,reasonCode:'PUSH_DISABLED',platforms:{android:{provider:null,configured:false,reasonCode:'PROVIDER_NOT_SELECTED'}}})
  const r=await put(randomUUID(),body(),headers(),disabled);expect(r.statusCode,r.body).toBe(503);expect(r.json().error.commitDisposition).toBe('not_committed')
  expect((await app.inject({method:'PUT',url:url(randomUUID()),headers:headers(),payload:{...body(),platform:'android',provider:'fcm'}})).json().error.code).toBe('PUSH_PROVIDER_UNSUPPORTED')
 })
 it('requires both identity headers and rejects extra fields without trusting supplied scope',async()=>{
  expect((await app.inject('/api/native/push/capabilities')).statusCode).toBe(401)
  expect((await put(randomUUID(),body(),{...headers(),'x-mbox-staff-employee-id':otherEmployee})).statusCode).toBe(401)
  expect((await app.inject({method:'PUT',url:url(randomUUID()),headers:headers(),payload:{...body(),tenantId:tenant}})).statusCode).toBe(400)
  expect((await app.inject({method:'POST',url:url(randomUUID())+'/revoke-capability',payload:{revision:1,revocationSecret:'x',storeId:store}})).statusCode).toBe(400)
 })
 it('registers without a live foreground heartbeat, encrypts secrets and retains exact replay',async()=>{
  const id=randomUUID(),payload=body(),head=headers(),first=await put(id,payload,head);expect(first.statusCode,first.body).toBe(201);expect(first.json().data).toMatchObject({protocol:1,employeeId:employee,staffSessionId:staff,requestKey:head['idempotency-key'],installation:{revision:1,boundToCurrentSession:true,status:'active'}})
  const again=await put(id,payload,head);expect(again.json().meta.replayed).toBe(true);expect(again.json().data).toEqual(first.json().data)
  expect((await put(id,{...payload,appVersion:'different'},head)).json().error).toMatchObject({code:'PUSH_RECEIPT_CONFLICT'});expect((await put(id,{...payload,appVersion:'different'},head)).json().error.commitDisposition).toBeUndefined()
  const row=(await owner.query('SELECT token_ciphertext,token_key_id,revocation_hash FROM mbox.native_push_installations WHERE id=$1',[id])).rows[0]
  expect(row.token_ciphertext.includes(Buffer.from(payload.token))).toBe(false);expect(row.revocation_hash).toBe(revocationHash(payload.revocationSecret));expect(new NativePushProtection(cfg.tokenKey,cfg.tokenKeyId,hashSecret).reveal(row.token_ciphertext,row.token_key_id,scope,id,1)).toBe(payload.token)
  const receipts=await owner.query('SELECT request_sha256,response_snapshot,expires_at::text FROM mbox.idempotency_records WHERE idempotency_key=$1',[head['idempotency-key']]);expect(receipts.rows[0].expires_at).toBe('infinity');expect(JSON.stringify(receipts.rows)).not.toContain(payload.token);expect(JSON.stringify(receipts.rows)).not.toContain(payload.revocationSecret)
  const audit=await owner.query('SELECT * FROM mbox.audit_events WHERE object_id=$1',[id]);expect(JSON.stringify(audit.rows)).not.toContain(payload.token);expect(JSON.stringify(audit.rows)).not.toContain(payload.revocationSecret)
 })
 it('enforces token ownership and optimistic revision',async()=>{
  const id=randomUUID(),payload=body();expect((await put(id,payload)).statusCode).toBe(201)
  expect((await put(randomUUID(),{...body(),token:payload.token})).json().error.code).toBe('PUSH_TOKEN_CONFLICT')
  expect((await put(id,body())).json().error).toMatchObject({code:'PUSH_REVISION_CONFLICT',commitDisposition:'not_committed'})
  const rotated=await put(id,body(1));expect(rotated.statusCode,rotated.body).toBe(200);expect(rotated.json().data.installation.revision).toBe(2)
 })
 it('revocation arriving before unknown PUT creates an immutable tombstone',async()=>{
  const id=randomUUID(),payload=body(),head=headers();expect((await revoke(id,1,payload.revocationSecret)).json()).toEqual({data:{protocol:1,accepted:true}})
  expect((await put(id,payload,head)).json().error).toMatchObject({code:'PUSH_REGISTRATION_REVOKED'})
  expect((await owner.query('SELECT * FROM mbox.native_push_installations WHERE id=$1',[id])).rowCount).toBe(0)
  await expect(tx.run(scope,t=>t.query('DELETE FROM mbox.native_push_revocation_tombstones WHERE installation_id=$1',[id]))).rejects.toThrow()
  // A different secret at the same next revision was never revoked.
  expect((await put(id,body())).statusCode).toBe(201)
 })
 it('revocation after a lost registration receipt blocks original replay and cannot undo a new binding',async()=>{
  const id=randomUUID(),payload=body(),head=headers();expect((await put(id,payload,head)).statusCode).toBe(201);expect((await revoke(id,1,payload.revocationSecret)).statusCode).toBe(200)
  expect((await put(id,payload,head)).json().error.code).toBe('PUSH_REGISTRATION_REVOKED')
  const next=body(1);expect((await put(id,next)).json().data.installation.revision).toBe(2)
  expect((await revoke(id,1,payload.revocationSecret)).statusCode).toBe(200)
  const current=await app.inject({url:url(id),headers:headers()});expect(current.json().data.installation).toMatchObject({revision:2,status:'active'})
  expect((await revoke(id,2,payload.revocationSecret)).statusCode).toBe(200);expect((await app.inject({url:url(id),headers:headers()})).json().data.installation.status).toBe('active')
 })
 it('serializes put/revoke with an absent installation under a stable advisory lock',async()=>{
  const id=randomUUID(),payload=body(),head=headers();let release!:()=>void,locked!:()=>void
  const ready=new Promise<void>(resolve=>locked=resolve),gate=new Promise<void>(resolve=>release=resolve)
  const holding=tx.run(scope,async t=>{await lockNativePushInstallation(t,id);locked();await gate})
  await ready;const pendingPut=put(id,payload,head),pendingRevoke=revoke(id,1,payload.revocationSecret);release();await holding
  const [registered,revoked]=await Promise.all([pendingPut,pendingRevoke]);expect([201,409]).toContain(registered.statusCode);expect(revoked.statusCode,revoked.body).toBe(200)
  const row=(await owner.query('SELECT status FROM mbox.native_push_installations WHERE id=$1',[id])).rows[0];expect(row?.status??'absent').not.toBe('active');expect((await put(id,payload,head)).json().error.code).toBe('PUSH_REGISTRATION_REVOKED')
 })
 it('conceals other devices; same device can rebind to the current employee without exposing former identity',async()=>{
  const id=randomUUID();expect((await put(id)).statusCode).toBe(201)
  const foreign={...actor,staffSessionId:foreignStaff,deviceAccessLeaseId:otherLease};expect((await app.inject({url:url(id),headers:headers(foreign)})).statusCode).toBe(404);expect((await put(id,body(1),headers(foreign))).statusCode).toBe(404)
  const next={...actor,employeeId:otherEmployee,staffSessionId:otherStaff},read=await app.inject({url:url(id),headers:headers(next)});expect(read.json().data).toMatchObject({employeeId:otherEmployee,staffSessionId:otherStaff,installation:{boundToCurrentSession:false,lastRequestKey:null}})
  expect(read.body).not.toContain(staff);expect((await app.inject({method:'POST',url:url(id)+'/revoke',headers:headers(next),payload:{expectedRevision:1}})).statusCode).toBe(404)
  expect((await put(id,body(1),headers(next))).json().data.installation).toMatchObject({revision:2,boundToCurrentSession:true})
 })
 it('normal revoke works when disabled and remains same revision',async()=>{
  const id=randomUUID();await put(id);const head=headers();const send=()=>disabled.inject({method:'POST',url:url(id)+'/revoke',headers:head,payload:{expectedRevision:1}})
  const first=await send();expect(first.statusCode,first.body).toBe(200);expect(first.json().data.installation).toMatchObject({revision:1,status:'revoked'});expect((await send()).json().meta.replayed).toBe(true)
 })
 it('rechecks permission and session revocation before receipt replay',async()=>{
  const id=randomUUID(),payload=body(),head=headers();await put(id,payload,head)
  const permission=(await owner.query("SELECT id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='service.view'",[tenant,store])).rows[0].id
  const deny=randomUUID();await owner.query("INSERT INTO mbox.employee_permission_overrides(id,tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) VALUES($1,$2,$3,$4,$5,'deny','Push permission revoked',$4)",[deny,tenant,store,employee,permission])
  try{expect((await put(id,payload,head)).statusCode).toBe(403)}finally{await owner.query('DELETE FROM mbox.employee_permission_overrides WHERE id=$1',[deny])}
  await owner.query("UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp(),revoke_reason='push test' WHERE id=$1",[staff])
  try{expect((await put(id,payload,head)).statusCode).toBe(401);expect((await revoke(id,1,payload.revocationSecret)).statusCode).toBe(200)}finally{await owner.query('UPDATE mbox.staff_sessions SET revoked_at=NULL,revoke_reason=NULL WHERE id=$1',[staff])}
 })
 it('valid unknown and wrong-secret requests use the same receipt, while database failures remain unconfirmed',async()=>{
  const accepted=await revoke(randomUUID(),1,body().revocationSecret);expect(accepted.statusCode).toBe(200)
  const failing=Fastify();await failing.register(nativePushApiPlugin,{prefix:'/api/native/push',scope,resolveContext:async()=>actor,repository:new NativePushRepository({run:async()=>{throw new Error('sensitive sentinel')}},null,hashSecret)})
  try{const r=await failing.inject({method:'POST',url:url(randomUUID())+'/revoke-capability',payload:{revision:1,revocationSecret:body().revocationSecret}});expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe('PUSH_REVOKE_UNCONFIRMED');expect(r.body).not.toContain('sentinel')}finally{await failing.close()}
 })
 it('limits anonymous requests across repository instances before writing unbounded tombstones',async()=>{
  const id=randomUUID(),secret=body().revocationSecret
  for(let i=0;i<60;i++)expect((await revoke(id,1,secret,'192.0.2.10')).statusCode).toBe(200)
  const response=await revoke(id,1,secret,'192.0.2.10');expect(response.statusCode,response.body).toBe(429);expect(response.headers['retry-after']).toBe('60')
  expect((await owner.query('SELECT count(*) FROM mbox.native_push_revocation_tombstones WHERE installation_id=$1',[id])).rows[0].count).toBe('1')
 })
 it('token encryption binds tenant, installation, revision and key id',()=>{
  const p=new NativePushProtection(cfg.tokenKey,'test-1',hashSecret),id=randomUUID(),encrypted=p.protect('token-value',scope,id,1)
  for(const [s,i,r,k] of [[{...scope,storeId:randomUUID()},id,1,'test-1'],[scope,randomUUID(),1,'test-1'],[scope,id,2,'test-1'],[scope,id,1,'other']] as const)expect(()=>p.reveal(encrypted,k,s,i,r)).toThrow('Native push token unavailable')
 })
 async function pushWork(type='guest.water',install=true) {
  await owner.query("UPDATE mbox.native_push_installations SET status='revoked' WHERE tenant_id=$1 AND store_id=$2 AND status='active'",[tenant,store])
  const installationId=randomUUID(),payload=body();if(install)expect((await put(installationId,payload)).statusCode).toBe(201)
  const area=randomUUID(),table=randomUUID(),session=randomUUID(),task=randomUUID(),event=randomUUID()
  await owner.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,$4,'Push area','indoor')",[area,tenant,store,'P'+area.replaceAll('-','').slice(0,12).toUpperCase()])
  await owner.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'Push table',4)",[table,tenant,store,area,'P'+table.replaceAll('-','').slice(0,12).toUpperCase()])
  await owner.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,opened_by_employee_id) VALUES($1,$2,$3,$4,$5,CURRENT_DATE,2,'open',$6)",[session,tenant,store,table,session,employee])
  await owner.query("INSERT INTO mbox.service_tasks(id,tenant_id,store_id,table_id,table_session_id,public_id,task_type,title,priority,status,source,assigned_employee_id) VALUES($1::uuid,$2,$3,$4,$5,$1::text,$6,'Do not leak this task title','normal','pending','employee',$7)",[task,tenant,store,table,session,type,employee])
  await owner.query("INSERT INTO mbox.service_task_events(id,tenant_id,store_id,service_task_id,event_type,to_status,actor_type,actor_employee_id) VALUES($1,$2,$3,$4,'task.created','pending','employee',$5)",[event,tenant,store,task,employee])
  return {installationId,payload,task,session,event}
 }
 const deliveries=async(id:string)=>(await owner.query('SELECT * FROM mbox.native_push_deliveries WHERE installation_id=$1',[id])).rows
 const worker=(sender:NativePushSender,overrides:Partial<Pick<NativePushConfig,'eventTtlSeconds'|'tokenKey'|'tokenKeyId'>>={})=>provider==='apns'?new NativePushWorker(tx,{...cfg,...overrides},hashSecret,sender):new NativePushWorker(tx,null,hashSecret,null,{...getuiCfg,...overrides},sender)
 it('captures only future source events in the same transaction, with no disabled-installation backlog',async()=>{
  const absent=await pushWork('guest.water',false);expect((await owner.query('SELECT * FROM mbox.native_push_events WHERE source_event_id=$1',[absent.event])).rowCount).toBe(0)
  const work=await pushWork(),event=(await owner.query('SELECT * FROM mbox.native_push_events WHERE source_event_id=$1',[work.event])).rows[0];expect(event.expires_at.getTime()-event.occurred_at.getTime()).toBe(300_000)
  const client=await owner.connect(),rollbackId=randomUUID();try{await client.query('BEGIN');await client.query("INSERT INTO mbox.service_task_events(id,tenant_id,store_id,service_task_id,event_type,to_status,actor_type,actor_employee_id) VALUES($1,$2,$3,$4,'task.reminded','pending','employee',$5)",[rollbackId,tenant,store,work.task,employee]);await client.query('ROLLBACK')}finally{client.release()}
  expect((await owner.query('SELECT * FROM mbox.native_push_events WHERE source_event_id=$1',[rollbackId])).rowCount).toBe(0)
  await expect(tx.run(scope,t=>t.query("UPDATE mbox.native_push_events SET event_type='task.assign' WHERE id=$1",[event.id]))).rejects.toThrow('immutable')
 })
 it('records APNs acceptance separately, routes to the exact current task, and only timestamps client observations',async()=>{
  const work=await pushWork();const sent:NativePushSendRequest[]=[];const w=worker({send:async r=>{sent.push(r);return {status:'provider_accepted'}}})
  const batch=await w.runBatch(scope,'test:push');expect(batch.accepted).toBe(1);expect(sent).toHaveLength(1)
  const row=(await deliveries(work.installationId))[0];expect(row.status).toBe('provider_accepted');expect(row.provider_accepted_at).not.toBeNull();expect(row.client_reported_received_at).toBeNull()
  const target=await app.inject({url:'/api/native/push/deliveries/'+row.id+'/target',headers:headers()});expect(target.statusCode,target.body).toBe(200);expect(target.json().data).toMatchObject({taskId:work.task,tableSessionId:work.session,installationId:work.installationId,revision:1})
  const head=headers();const observe=()=>app.inject({method:'POST',url:'/api/native/push/deliveries/'+row.id+'/observations',headers:head,payload:{kind:'opened'}})
  const first=await observe();expect(first.statusCode,first.body).toBe(200);expect(first.json().data.clientReportedReceivedAt).toBeNull();expect(first.json().data.clientReportedOpenedAt).toBeTruthy();expect((await observe()).json().meta.replayed).toBe(true)
  expect((await owner.query('SELECT status FROM mbox.service_tasks WHERE id=$1',[work.task])).rows[0].status).toBe('pending')
  await w.runBatch(scope,'test:push');expect(sent).toHaveLength(1)
  await owner.query("UPDATE mbox.service_tasks SET status='completed' WHERE id=$1",[work.task]);expect((await app.inject({url:'/api/native/push/deliveries/'+row.id+'/target',headers:headers()})).statusCode).toBe(410)
  await expect(tx.run(scope,t=>t.query("UPDATE mbox.native_push_deliveries SET status='retry' WHERE id=$1",[row.id]))).rejects.toThrow()
  await expect(tx.run(scope,t=>t.query('UPDATE mbox.native_push_deliveries SET employee_id=$2 WHERE id=$1',[row.id,otherEmployee]))).rejects.toThrow('immutable')
 })
 it('does not project a manager-only complaint to a read-only employee',async()=>{
  const work=await pushWork('guest.complaint');let calls=0;await worker({send:async()=>{calls++;return {status:'provider_accepted'}}}).runBatch(scope,'test:push');expect(calls).toBe(0);expect(await deliveries(work.installationId)).toHaveLength(0)
 })
 it('rechecks assignment, closed original session and revoked access immediately before transport',async()=>{
  const work=await pushWork();let calls=0;const w=worker({send:async()=>{calls++;return {status:'provider_accepted'}}});await w['project'](scope)
  await owner.query('UPDATE mbox.service_tasks SET assigned_employee_id=$2 WHERE id=$1',[work.task,otherEmployee]);await w.runBatch(scope,'test:push');expect(calls).toBe(0);expect((await deliveries(work.installationId))[0].status).toBe('cancelled')
  const closed=await pushWork();await w['project'](scope);await owner.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[closed.session]);await w.runBatch(scope,'test:push');expect(calls).toBe(0);expect((await deliveries(closed.installationId))[0].status).toBe('cancelled')
  const revoked=await pushWork();await w['project'](scope);await owner.query("UPDATE mbox.store_device_access_leases SET revoked_at=clock_timestamp() WHERE id=$1",[lease]);try{await w.runBatch(scope,'test:push');expect(calls).toBe(0);expect((await deliveries(revoked.installationId))[0].status).toBe('cancelled')}finally{await owner.query('UPDATE mbox.store_device_access_leases SET revoked_at=NULL WHERE id=$1',[lease])}
 })
 it('keeps network unknown terminal and retries only a confirmed retry with the same provider request id',async()=>{
  const work=await pushWork();let calls=0;const w=worker({send:async()=>{calls++;return {status:'unknown',code:'APNS_TRANSPORT_UNKNOWN'}}});await w.runBatch(scope,'test:push');await w.runBatch(scope,'test:push');expect(calls).toBe(1);expect((await deliveries(work.installationId))[0].status).toBe('unknown')
  const retry=await pushWork(),ids:string[]=[];const retryWorker=worker({send:async r=>{ids.push(r.requestId);return ids.length===1?{status:'retry',code:'APNS_RETRYABLE',retryAfterSeconds:0}:{status:'provider_accepted'}}});await retryWorker.runBatch(scope,'test:push');await retryWorker.runBatch(scope,'test:push');expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);expect((await deliveries(retry.installationId))[0].attempts).toBe(2)
 })
 it('converts interrupted sending to unknown without invoking transport',async()=>{
  const work=await pushWork();let calls=0;const w=worker({send:async()=>{calls++;return {status:'provider_accepted'}}});await w['project'](scope);const row=(await deliveries(work.installationId))[0]
  await tx.run(scope,t=>t.query("UPDATE mbox.native_push_deliveries SET status='sending',attempts=1,locked_by='old-worker',locked_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[row.id]));await w.runBatch(scope,'test:push');expect(calls).toBe(0);expect((await deliveries(work.installationId))[0]).toMatchObject({status:'unknown',failure_code:'SENDER_INTERRUPTED'})
 })
 it('does not invalidate a newer binding when an old in-flight token is rejected',async()=>{
  const work=await pushWork();const w=worker({send:async()=>{const rotated=await put(work.installationId,body(1));expect(rotated.statusCode,rotated.body).toBe(200);return {status:'rejected',code:'APNS_TOKEN_INVALID',invalidToken:true}}});await w.runBatch(scope,'test:push');const row=(await owner.query('SELECT revision,status FROM mbox.native_push_installations WHERE id=$1',[work.installationId])).rows[0];expect(row).toEqual({revision:'2',status:'active'});expect((await deliveries(work.installationId))[0].status).toBe('rejected')
 })
 it('two workers cannot send the same target concurrently; unrelated installations sharing a token do not deadlock',async()=>{
  const work=await pushWork();let calls=0;const w=worker({send:async()=>{calls++;return {status:'provider_accepted'}}});await Promise.all([w.runBatch(scope,'test:push:a'),w.runBatch(scope,'test:push:b')]);expect(calls).toBe(1);expect(await deliveries(work.installationId)).toHaveLength(1)
  const payload=body(),[a,b]=await Promise.all([put(randomUUID(),payload),put(randomUUID(),{...payload,revocationSecret:body().revocationSecret})]);expect([a.statusCode,b.statusCode].sort()).toEqual([201,409])
 })

 it('an expired-token takeover and concurrent rotation of its previous installation complete without a lock cycle',async()=>{
  const shortLease=randomUUID(),shortSession=randomUUID(),oldId=randomUUID(),payload=body()
  await owner.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,CURRENT_DATE,$5,$6,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 second')",[shortLease,tenant,store,credential,deviceHash,randomBytes(32).toString('hex')])
  await owner.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp())",[shortSession,tenant,store,employee,shortLease,randomBytes(32).toString('hex')])
  await repo.put({...actor,staffSessionId:shortSession,deviceAccessLeaseId:shortLease},oldId,'native-push-'+randomUUID(),payload)
  await new Promise(resolve=>setTimeout(resolve,1100))
  const [takeover,rotation]=await Promise.all([put(randomUUID(),{...body(),token:payload.token}),put(oldId,body(1))])
  expect(takeover.statusCode,takeover.body).toBe(201);expect(rotation.statusCode,rotation.body).toBe(200)
 })
 it('expiry before transmission and unreadable old encryption keys close the binding without sending',async()=>{
  const expired=await pushWork();let calls=0;const w=worker({send:async()=>{calls++;return {status:'provider_accepted'}}},{eventTtlSeconds:1});await w['project'](scope);await new Promise(resolve=>setTimeout(resolve,1100));await w.runBatch(scope,'test:ttl');expect(calls).toBe(0);expect((await deliveries(expired.installationId))[0].status).toBe('expired')
  const oldKey=await pushWork(),rotated=worker({send:async()=>{calls++;return {status:'provider_accepted'}}},{tokenKey:randomBytes(32),tokenKeyId:'rotated'});await rotated.runBatch(scope,'test:key');expect(calls).toBe(0);expect((await owner.query('SELECT status FROM mbox.native_push_installations WHERE id=$1',[oldKey.installationId])).rows[0].status).toBe('revoked');expect((await deliveries(oldKey.installationId))[0].failure_code).toBe('TOKEN_KEY_UNAVAILABLE')
 })

 it('persists an APNs configuration rejection while returning a nonfatal independent channel failure count',async()=>{
  const work=await pushWork();const w=worker({send:async()=>({status:'rejected',code:'APNS_CONFIGURATION_REJECTED',configurationFailure:true})})
  const result=await w.runBatch(scope,'test:configuration');expect(result.configurationRejected).toBe(1)
  expect((await deliveries(work.installationId))[0]).toMatchObject({status:'rejected',failure_code:'APNS_CONFIGURATION_REJECTED',provider_accepted_at:null})
  expect((await owner.query('SELECT status FROM mbox.native_push_installations WHERE id=$1',[work.installationId])).rows[0].status).toBe('active')
 })

})
