import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest'
import Fastify from 'fastify'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {OfficialPointsNotificationWorker,type OfficialPointsAdapterFactory} from './official-points-notification-worker.js'
import {SocialAccountRepository,processSocialEvent} from './social-account-repository.js'
import {officialPointsNotificationApiPlugin} from './official-points-notification-api.js'
const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=adminUrl&&runtimeUrl?describe:describe.skip
const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),accountId=randomUUID()
const protection=createActivityContactProtectionKeyring(null,'isolated-points-notification-tests')
const templateId='synthetic-points-template',keys={character_string1:'change',number2:'balance',thing3:'reason',time4:'occurredAt'}
const templates=[{templateId,title:'测试积分变动',content:'{{character_string1.DATA}} {{number2.DATA}} {{thing3.DATA}} {{time4.DATA}}'}]
integration('official account points notices: restricted real PostgreSQL and synthetic members',()=>{
 let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,customerId:string
 const app=Fastify()
 let sends=0,mode:'accepted'|'unknown'|'rejected'='accepted',following=true,templateAvailable=true,reference=1000
 const factory:OfficialPointsAdapterFactory=()=>({templates:async()=>templateAvailable?templates:[],user:async()=>({active:following,unionId:'synthetic'}),sendTemplate:async()=>{sends++;return{status:mode,providerReference:mode==='accepted'?String(++reference):null,errorCode:mode==='accepted'?null:'SYNTHETIC_RESULT'}}})
 const worker=()=>new OfficialPointsNotificationWorker(runner,protection,factory)
 beforeAll(async()=>{
  await runNormalizedMigrations(adminUrl!);pool=new Pool({connectionString:adminUrl});runtime=new Pool({connectionString:runtimeUrl});runner=new ScopedPostgresTransactionRunner(runtime)
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Synthetic notice test')",[scope.tenantId,scope.tenantId])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'test','Synthetic notice test')",[scope.storeId,scope.tenantId])
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES($1,$2,$3,'test','Synthetic operator','active')",[employee,scope.tenantId,scope.storeId])
  await runner.run(scope,tx=>new SocialAccountRepository(tx,protection).save({id:undefined,kind:'service_account',name:'Synthetic official account',appId:'wxsyntheticpoints',enabled:true,credentials:{secret:'synthetic-secret',token:'synthetictoken',encodingAesKey:'a'.repeat(43)},codeTemplateId:null,codeDataKey:'number1',reminderTemplateId:null,reminderDataKey:'thing1'},employee)).then(async result=>{await pool.query('UPDATE mbox.social_accounts SET id=$1 WHERE id=$2',[accountId,result.id])})
  await pool.query("INSERT INTO mbox.official_points_settings(tenant_id,store_id,account_id,enabled,template_id,data_keys,certification_expires_at,evidence_reference) VALUES($1,$2,$3,true,$4,$5,clock_timestamp()+interval '1 year','synthetic permission evidence only')",[scope.tenantId,scope.storeId,accountId,templateId,JSON.stringify(keys)])
  await app.register(officialPointsNotificationApiPlugin,{prefix:'/api',transactions:runner,protection,factory,resolveStaffContext:()=>({scope,employeeId:employee,actorRef:'synthetic',businessDate:'2026-10-20'}),resolvePublicContext:async()=>({scope,customerId,actorRef:'synthetic',businessDate:'2026-10-20'})});await app.ready()
 })
 beforeEach(()=>{mode="accepted";following=true;templateAvailable=true})
 afterAll(async()=>{await app.close();await runtime?.end();await pool?.end()})
 async function member(opted=true,linked=true){
  const customer=randomUUID(),membership=randomUUID(),openid='synthetic-'+customer
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2,$3,$1::text,'active')",[customer,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4,$5)",[membership,scope.tenantId,scope.storeId,customer,'MBX'+membership.replaceAll('-','').toUpperCase()])
  await pool.query('INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,membership,customer])
  if(linked){const p=protection.protect(openid);await pool.query("INSERT INTO mbox.social_relationships(tenant_id,store_id,account_id,external_hash,encrypted_external_id,key_id,customer_id,active,provider_occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,true,clock_timestamp())",[scope.tenantId,scope.storeId,accountId,p.hash,Buffer.from(p.encryptedBase64,'base64'),p.keyId,customer])}
  if(opted)await pool.query('INSERT INTO mbox.official_points_preferences(tenant_id,store_id,customer_id,account_id,enabled) VALUES($1,$2,$3,$4,true)',[scope.tenantId,scope.storeId,customer,accountId])
  return{customer,membership}
 }
 async function ledger(m:Awaited<ReturnType<typeof member>>,type='adjust',delta=10){return runner.run(scope,async tx=>(await tx.query<{id:string}>("INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,20,CASE WHEN $5='earn' THEN 'order' ELSE 'manual' END,$7,'隔离会员积分变动',$7) RETURNING id",[scope.tenantId,scope.storeId,m.membership,m.customer,type,delta,randomUUID()])).rows[0]!.id)}
 async function notices(customer:string){return(await pool.query('SELECT * FROM mbox.official_points_notifications WHERE customer_id=$1 ORDER BY created_at,id',[customer])).rows}
 it('covers every ledger kind, commits one outbox row per entry and never sends on rollback',async()=>{
  const m=await member()
  for(const type of ['earn','redeem','expire','reverse','supplement','adjust','restore'])await ledger(m,type,['redeem','expire','reverse'].includes(type)?-5:10)
  expect((await notices(m.customer)).map(r=>r.event_type)).toEqual(['earn','redeem','expire','reverse','supplement','adjust','restore'])
  await expect(runner.run(scope,async tx=>{await tx.query("INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key) VALUES($1,$2,$3,$4,'adjust',1,21,'manual','rollback','不得发出通知','rollback-test')",[scope.tenantId,scope.storeId,m.membership,m.customer]);throw new Error('rollback')})).rejects.toThrow('rollback')
  expect(await notices(m.customer)).toHaveLength(7)
  const before=sends;await Promise.all([worker().runBatch(scope,'worker:a'),worker().runBatch(scope,'worker:b')]);await worker().runBatch(scope,'worker:c')
  expect(sends-before).toBe(7);expect((await notices(m.customer)).every(r=>r.status==='accepted')).toBe(true)
  await worker().runBatch(scope,'worker:again');expect(sends-before).toBe(7)
 })
 it('never retries unknown or provider rejected sends',async()=>{
  for(const state of ['unknown','rejected'] as const){const m=await member();await ledger(m);mode=state;const before=sends;await worker().runBatch(scope,'worker:failure');await worker().runBatch(scope,'worker:again');expect(sends-before).toBe(1);expect((await notices(m.customer))[0].status).toBe(state)}mode='accepted'
 })
 it('blocks missing template without consuming or sending and sends after verified recovery',async()=>{
  const m=await member();await ledger(m);templateAvailable=false;const before=sends;await worker().runBatch(scope,'worker:template');expect(sends).toBe(before);expect((await notices(m.customer))[0]).toMatchObject({status:'blocked',error_code:'POINTS_TEMPLATE_UNAVAILABLE'})
  templateAvailable=true;await pool.query('UPDATE mbox.official_points_notifications SET next_check_at=clock_timestamp() WHERE customer_id=$1',[m.customer]);await worker().runBatch(scope,'worker:restored');expect(sends).toBe(before+1)
 })
 it('does not treat a follow or mini-program consent as points-notice permission; no retroactive send',async()=>{
  const m=await member(false);await ledger(m);customerId=m.customer;expect((await app.inject('/api/public/mini/official-points-notifications')).json().data).toMatchObject({enabled:false,linked:true})
  expect((await app.inject({method:'POST',url:'/api/public/mini/official-points-notifications',payload:{accountId,enabled:true}})).statusCode).toBe(200)
  const before=sends;await worker().runBatch(scope,'worker:consent');expect(sends).toBe(before);expect((await notices(m.customer))[0].status).toBe('skipped')
  await ledger(m);await worker().runBatch(scope,'worker:new');expect(sends).toBe(before+1)
  await ledger(m);await app.inject({method:'POST',url:'/api/public/mini/official-points-notifications',payload:{accountId,enabled:false}});await worker().runBatch(scope,'worker:revoked');expect(sends).toBe(before+1)
 })
 it('rejects unbound customer enablement and checks actual follow status before sending',async()=>{
  const unbound=await member(false,false);customerId=unbound.customer;expect((await app.inject({method:'POST',url:'/api/public/mini/official-points-notifications',payload:{accountId,enabled:true}})).statusCode).toBe(409)
  const m=await member();await ledger(m);following=false;const before=sends;await worker().runBatch(scope,'worker:unfollow');following=true;expect(sends).toBe(before);expect((await notices(m.customer))[0].error_code).toBe('NOT_FOLLOWING')
 })
 it('records signed platform receipts separately from acceptance and preserves tenant isolation',async()=>{
  const m=await member();await ledger(m);await worker().runBatch(scope,'worker:receipt');const n=(await notices(m.customer))[0]
  await runner.run(scope,tx=>processSocialEvent(new SocialAccountRepository(tx,protection),accountId,`<xml><Event>TEMPLATESENDJOBFINISH</Event><MsgID>${n.provider_reference}</MsgID><Status>success</Status></xml>`))
  expect((await notices(m.customer))[0].status).toBe('delivered')
  expect((await runner.run({tenantId:randomUUID(),storeId:randomUUID()},tx=>tx.query('SELECT * FROM mbox.official_points_notifications'))).rowCount).toBe(0)
  expect((await app.inject('/api/staff/loyalty/official-notifications')).statusCode).toBe(403)
 })
 it('recovers abandoned dispatching as unknown; pending debt changes get their own notification',async()=>{
  const m=await member();await ledger(m)
  await pool.query("UPDATE mbox.official_points_notifications SET status='dispatching',attempted_at=clock_timestamp()-interval '6 minutes' WHERE customer_id=$1",[m.customer])
  const before=sends;await worker().runBatch(scope,'worker:crash');expect(sends).toBe(before);expect((await notices(m.customer))[0].status).toBe('unknown')
  await runner.run(scope,tx=>tx.query('UPDATE mbox.loyalty_accounts SET pending_recovery_points=5 WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3',[scope.tenantId,scope.storeId,m.membership]))
  expect((await notices(m.customer))[1]).toMatchObject({event_type:'pending_recovery',points_delta:5,balance_after:0});await worker().runBatch(scope,'worker:debt')
 })
 it('handles receipt-before-response, failed receipts and immutable source payloads',async()=>{
  const m=await member();await ledger(m)
  const earlyFactory:OfficialPointsAdapterFactory=()=>({...factory({} as never),sendTemplate:async()=>{
   await runner.run(scope,tx=>new SocialAccountRepository(tx,protection).recordPointsReceipt(accountId,'<xml><MsgID>90001</MsgID><Status>success</Status></xml>'))
   return{status:'accepted',providerReference:'90001',errorCode:null}
  }})
  await new OfficialPointsNotificationWorker(runner,protection,earlyFactory).runBatch(scope,'worker:early')
  expect((await notices(m.customer))[0].status).toBe('delivered')
  await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.official_points_notifications SET points_delta=999 WHERE customer_id=$1',[m.customer]))).rejects.toMatchObject({code:'23514'})
  await expect(runner.run(scope,tx=>tx.query("UPDATE mbox.official_points_notifications SET status='queued' WHERE customer_id=$1",[m.customer]))).rejects.toMatchObject({code:'23514'})
  const other=await member();await ledger(other);await worker().runBatch(scope,'worker:failed-receipt');const n=(await notices(other.customer))[0]
  await runner.run(scope,tx=>new SocialAccountRepository(tx,protection).recordPointsReceipt(accountId,`<xml><MsgID>${n.provider_reference}</MsgID><Status>failed:user block</Status></xml>`))
  expect((await notices(other.customer))[0]).toMatchObject({status:'delivery_failed',error_code:'PROVIDER_DELIVERY_FAILED'})
 })
 it('keeps expired certification blocked, rejects ambiguous identity and handles template field drift',async()=>{
  const m=await member();await ledger(m);const before=sends
  await pool.query("UPDATE mbox.official_points_settings SET certification_expires_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1",[scope.tenantId])
  await worker().runBatch(scope,'worker:expired');expect((await notices(m.customer))[0].error_code).toBe('ACCOUNT_PERMISSION_UNVERIFIED');expect(sends).toBe(before)
  await pool.query("UPDATE mbox.official_points_settings SET certification_expires_at=clock_timestamp()+interval '1 year' WHERE tenant_id=$1",[scope.tenantId])
  await pool.query('UPDATE mbox.official_points_notifications SET next_check_at=clock_timestamp() WHERE customer_id=$1',[m.customer])
  const driftFactory:OfficialPointsAdapterFactory=()=>({...factory({} as never),templates:async()=>[{templateId,title:'Changed',content:'{{thing99.DATA}}'}]})
  await new OfficialPointsNotificationWorker(runner,protection,driftFactory).runBatch(scope,'worker:drift');expect((await notices(m.customer))[0].error_code).toBe('POINTS_TEMPLATE_UNAVAILABLE');expect(sends).toBe(before)
  await pool.query("UPDATE mbox.official_points_notifications SET status='skipped' WHERE customer_id=$1",[m.customer])
 })

 it('rechecks emergency pause after network preflight before dispatching',async()=>{
  const m=await member();await ledger(m);const before=sends
  const controls=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
  const context={scope,employeeId:employee,actorRef:'test',businessDate:'2026-10-20'}
  const pauseFactory:OfficialPointsAdapterFactory=()=>({...factory({} as never),templates:async()=>{
   await controls.set(context,{capability:'wechat_notification',operation:'pause',reason:'隔离发送中暂停测试',reviewAt:null,expectedVersion:0,idempotencyKey:randomUUID()})
   return templates
  }})
  await new OfficialPointsNotificationWorker(runner,protection,pauseFactory).runBatch(scope,'worker:pause')
  expect(sends).toBe(before);expect((await notices(m.customer))[0].status).toBe('queued')
  await controls.set(context,{capability:'wechat_notification',operation:'resume',reason:'隔离恢复发送测试',reviewAt:null,expectedVersion:1,idempotencyKey:randomUUID()})
  await worker().runBatch(scope,'worker:resume');expect(sends).toBe(before+1)
 })
 it('requires staff permission and a readable exact template before enabling; exposes auditable status',async()=>{
  const role=randomUUID()
  await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'POINTS_NOTICE_TEST','Points notice test')",[role,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[scope.tenantId,scope.storeId,employee,role])
  const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,'member.card.manage','测试公众号管理','finance') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId])).rows[0].id
  await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,permission])
  const input={accountId,enabled:true,templateId,dataKeys:keys,certificationExpiresAt:new Date(Date.now()+86400000).toISOString(),evidenceReference:'synthetic account certification fixture'}
  const submit=(payload:object)=>app.inject({method:'POST',url:'/api/staff/loyalty/official-notifications/settings',payload})
  expect((await submit({...input,dataKeys:{thing1:'reason'}})).statusCode).toBe(400)
  templateAvailable=false;expect((await submit(input)).statusCode).toBe(409)
  templateAvailable=true;expect((await submit(input)).statusCode).toBe(200)
  const board=await app.inject('/api/staff/loyalty/official-notifications');expect(board.statusCode).toBe(200);expect(board.json().data.counts.length).toBeGreaterThan(0);expect(board.headers['cache-control']).toContain('no-store')
  expect((await app.inject(`/api/staff/loyalty/official-notifications/accounts/${accountId}/templates`)).json().data.certificationStatus).toBe('requires_platform_evidence')
  expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1 AND action='loyalty.official_notifications.configured'",[scope.tenantId])).rows[0].n).toBe(1)
 })

})
