import {commercialOpsApiPlugin} from './commercial-ops-api.js'
import {ProfitQueryService} from './profit-query-service.js'
import {holdFixtureReceipts} from './staff-permission.test-helper.js'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {launchPopupApiPlugin} from './launch-popup-api.js'
import {memberNumberApiPlugin} from './member-number-api.js'
import {defaultMemberNumberPolicy} from './member-number-policy.js'
import {socialAccountApiPlugin} from './social-account-api.js'
import {socialBroadcastApiPlugin} from './social-broadcast-api.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {SocialAccountRepository} from './social-account-repository.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import type {ObservationEventInput} from './customer-experience-observation-repository.js'
import {marketingContactApiPlugin} from './marketing-contact-api.js'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {MemberCardRepository} from './member-card-repository.js'
const protection=createActivityContactProtectionKeyring(null,'receipt-audit-local-only-secret')
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('configuration receipt authorization with restricted LOGIN',()=>{
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,transactions:Pick<ScopedPostgresTransactionRunner,'run'>,app:ReturnType<typeof Fastify>
 let scope:{tenantId:string;storeId:string},actor:string,approver:string,publisher:string,role:string
 let beforeExecute:(()=>Promise<void>)|undefined,beforeRun:(()=>Promise<void>)|undefined,runsUntilHook=0
 const permissions=['community.activity.manage','member.card.manage','observation.record','observation.confirm','observation.correct','observation.view.raw','observation.record.all','marketing.notice.edit','marketing.notice.approve','marketing.notice.publish','marketing.refusal.record','marketing.send','commercial.voucher.redeem']
 const grant=async(codes=permissions)=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const table of ['launch_popup_policies','launch_popup_products','member_number_policies','social_accounts','social_callback_events','member_card_projects','member_card_menu_items','social_broadcasts','group_voucher_redemptions','group_voucher_verification_attempts','marketing_notice_versions','marketing_notice_decisions','marketing_consent_events','marketing_delivery_jobs','marketing_delivery_attempts','observation_inputs','observation_events','observation_revisions','service_tasks','service_task_events','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);runner=new ScopedPostgresTransactionRunner(runtime)
  transactions={run:async(s,work,settings)=>{if(runsUntilHook>0&&--runsUntilHook===0){const hook=beforeRun;beforeRun=undefined;await hook?.()}return runner.run(s,work,settings)}}
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const resolveContext=(request:{headers:Record<string,unknown>})=>({scope,employeeId:String(request.headers['x-test-employee']??actor),businessDate:'2026-11-03'})
  app=Fastify()
  await app.register(launchPopupApiPlugin,{transactions,commands,resolveStaffContext:resolveContext,resolveSelfContext:()=>{throw Error('unused')}})
  await app.register(memberNumberApiPlugin,{transactions,commands,resolveStaffContext:resolveContext})
  await app.register(socialAccountApiPlugin,{transactions,commands,resolveStaffContext:resolveContext,protection,scope:{tenantId:randomUUID(),storeId:randomUUID()}})
  await app.register(socialBroadcastApiPlugin,{transactions,commands,resolveStaffContext:resolveContext})
  await app.register(marketingContactApiPlugin,{transactions,commands,resolveStaffContext:resolveContext,resolveSelfContext:()=>{throw Error('unused')}})
  await app.register(commercialOpsApiPlugin,{transactions,commandExecutor:commands,queryService:new ProfitQueryService(transactions),resolveContext:request=>({...resolveContext(request),capabilities:[]})})
  await app.ready()
 })
 beforeEach(async()=>{
  beforeExecute=undefined;beforeRun=undefined;runsUntilHook=0;scope={tenantId:randomUUID(),storeId:randomUUID()};actor=randomUUID();approver=randomUUID();publisher=randomUUID();role=randomUUID()
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Media tier audit')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Media tier audit')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'AUDITOR','Audit')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,approver,publisher]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of permissions)await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code])
  await grant()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 const send=(url:string,body:object,key=randomUUID(),employee=actor,method:'POST'|'PUT'='POST')=>app.inject({method,url,headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const accountBody=(kind:'service_account'|'wecom'='service_account')=>({kind,appId:kind==='wecom'?'wwReceiptAudit':'wxReceiptAudit',name:kind,enabled:true,credentials:{secret:'local-test-secret',token:'AuditToken',encodingAesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/,'')},codeTemplateId:'test-code',codeDataKey:'character_string1',reminderTemplateId:'test-reminder',reminderDataKey:'thing1'})
 const cases=['popup','number','account','callback','social-policy','menu','menu-remove','broadcast','schedule','cancel','marketing-save','marketing-approve','marketing-publish','marketing-stop','marketing-refusal','marketing-queue','marketing-cancel','voucher-record'] as const
 async function fixture(kind:typeof cases[number]):Promise<{url:string;body:object}>{
  if(kind==='voucher-record')return{url:'/commercial-ops/vouchers/redeem',body:{platform:'meituan',voucherCode:'LOCAL-AUDIT-0001',publicId:'voucher-audit-'+randomUUID(),faceValueMinor:100,settlementAmountMinor:90}}
  if(kind.startsWith('marketing-'))return marketingFixture(kind)
  if(kind==='popup')return{url:'/staff/launch-popup',body:{enabled:true,title:'Audit popup',content:'local only',frequency:'daily',productIds:[],version:0}}
  if(kind==='number')return{url:'/staff/member-number-policy',body:{policy:defaultMemberNumberPolicy,version:0,reason:'local audit'}}
  if(kind==='account')return{url:'/staff/social-accounts',body:accountBody()}
  const account=await runner.run(scope,tx=>new SocialAccountRepository(tx,protection).save(accountBody(),actor))
  if(kind==='callback'){
   const id=randomUUID();await admin.query("INSERT INTO mbox.social_callback_events(id,tenant_id,store_id,account_id,fingerprint,event_type,provider_occurred_at,payload_hash,encrypted_payload,key_id,status) VALUES($1::uuid,$2,$3,$4,$1::text,'subscribe',clock_timestamp(),'test',decode('00','hex'),'test','failed')",[id,scope.tenantId,scope.storeId,account.id])
   return{url:`/staff/social-accounts/events/${id}/retry`,body:{}}
  }
  if(['broadcast','schedule','cancel'].includes(kind)){
   const body={accountId:account.id,title:'Audit',content:'local only',scheduledAt:new Date(Date.now()+86400000).toISOString()}
   if(kind==='broadcast')return{url:'/staff/social-broadcasts',body}
   const draft=await send('/staff/social-broadcasts',body);expect(draft.statusCode,draft.body).toBe(200)
   return{url:`/staff/social-broadcasts/${draft.json().data.id}/action`,body:{action:kind,audienceConfirmed:true}}
  }
  const project=await runner.run(scope,tx=>new MemberCardRepository(tx).createProject({flowMode:kind==='social-policy'?'legacy':'simple',code:`AUDIT_${randomUUID().slice(0,8).toUpperCase()}`,name:'Audit',terms:'local terms',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:actor,businessDate:'2026-11-05'}))
  if(kind==='social-policy'){
   const wecom=await runner.run(scope,tx=>new SocialAccountRepository(tx,protection).save(accountBody('wecom'),actor))
   return{url:`/staff/member-cards/projects/${project.projectId}/social-policy`,body:{serviceAccountId:account.id,wecomAccountId:wecom.id,autoRestore:true,artistName:'Audit',iconUrl:null}}
  }
  const product=randomUUID();await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible,inventory_control_mode,cost_amount_minor) VALUES($1,$2,$3,'AUDIT','Audit','DRINK','none',false,'not_managed',100)",[product,scope.tenantId,scope.storeId])
  const body={productId:product,exclusive:true,active:true,sortOrder:0,exclusivePriceMinor:500}
  const url=`/staff/member-cards/projects/${project.projectId}/menu`
  if(kind==='menu')return{url,body}
  const added=await send(url,body);expect(added.statusCode,added.body).toBe(200)
  return{url:url+'/remove',body:{productId:product}}
 }

 async function marketingFixture(kind:string):Promise<{url:string;body:object}>{
  const rule={operatorName:'隔离测试运营主体',operatorContact:'测试客服',summary:'门店活动及由本店联系的联合活动，不向合作方提供名单。',withdrawalInstructions:'随时停止全部营销联系，原会员与权益不受影响。',purposes:['own_activities','mbox_joint_activities'],channels:['wechat','sms','phone'],dataCategories:['本人联系地址'],validFrom:new Date(Date.now()-86400000).toISOString(),validUntil:new Date(Date.now()+30*86400000).toISOString(),consentDays:7,contactStartMinute:0,contactEndMinute:1440,weekdays:[1,2,3,4,5,6,7],maximumPerDay:1,maximumPerMonth:4,sharingMode:'no_partner_list'}
  const body={code:'AUDIT_NOTICE',rule,reason:'隔离回执权限测试',expectedVersion:0}
  if(kind==='marketing-save')return{url:'/staff/marketing/notices',body}
  const customerId=randomUUID();await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)',[customerId,scope.tenantId,scope.storeId])
  if(kind==='marketing-refusal')return{url:'/staff/marketing/refusals',body:{customerId,reason:'顾客要求停止营销'}}
  const saved=await send('/staff/marketing/notices',body,randomUUID(),approver);expect(saved.statusCode,saved.body).toBe(200)
  const noticeId=saved.json().data.noticeId,url=`/staff/marketing/notices/${noticeId}/decision`
  if(kind==='marketing-approve')return{url,body:{action:'approve',reason:'复核授权范围'}}
  const approved=await send(url,{action:'approve',reason:'复核授权范围'},randomUUID(),publisher);expect(approved.statusCode,approved.body).toBe(200)
  if(kind==='marketing-publish')return{url,body:{action:'publish',reason:'确认发布告知'}}
  const published=await send(url,{action:'publish',reason:'确认发布告知'});expect(published.statusCode,published.body).toBe(200)
  if(kind==='marketing-stop')return{url,body:{action:'stop',reason:'停止本告知'}}
  await runner.run(scope,tx=>new MarketingContactRepository(tx).recordChoices({customerId,noticeId,expectedRevision:'none',businessDate:'2026-11-05',choices:[{channel:'sms',purpose:'own_activities',decision:'granted'}]}))
  const queue={customerId,noticeId,channel:'sms',purpose:'own_activities',campaignKey:randomUUID(),content:'本地测试不实际发送',expiresAt:new Date(Date.now()+3600000).toISOString()}
  if(kind==='marketing-queue')return{url:'/staff/marketing/jobs',body:queue}
  const queued=await send('/staff/marketing/jobs',queue);expect(queued.statusCode,queued.body).toBe(200)
  return{url:`/staff/marketing/jobs/${queued.json().data.jobId}/cancel`,body:{reason:'本地取消任务'}}
 }
 for(const kind of cases){
  for(const mode of ['fresh','receipt'] as const)it(`${kind} ${mode} rejects revocation after preflight and recovers without duplicate writes`,async()=>{
   const {url,body}=await fixture(kind),key=randomUUID()
   const first=mode==='receipt'?await send(url,body,key):null
   if(first)expect(first.statusCode,first.body).toBe(kind==='voucher-record'?201:200)
   const before=await snapshot();beforeExecute=()=>grant([])
   const denied=await send(url,body,key);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
   await grant();const recovered=await send(url,body,key);expect(recovered.statusCode,recovered.body).toBe(kind==='voucher-record'&&!first?201:200)
   if(first){expect(recovered.json()).toEqual(kind==='voucher-record'?{...first.json(),replayed:true}:{...first.json(),meta:{replayed:true}});expect(await snapshot()).toEqual(before)}
   const committed=await snapshot()
   const other=await send(url,body,key,approver);expect(other.statusCode,other.body).toBe(409);expect(await snapshot()).toEqual(committed)
  })
  it(`${kind} rejects a suspended operator on original receipt`,async()=>{
   const {url,body}=await fixture(kind),key=randomUUID();const first=await send(url,body,key);expect(first.statusCode,first.body).toBe(kind==='voucher-record'?201:200)
   const before=await snapshot();beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor])}
   expect((await send(url,body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  })
 }

 for(const kind of ['popup','marketing-save'] as const)it(`${kind} revocation during receipt lock wait denies replay`,async()=>{
  const {url,body}=await fixture(kind),key=randomUUID(),first=await send(url,body,key);expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot(),lock=await holdFixtureReceipts(admin,scope.tenantId),retry=send(url,body,key)
  try{await lock.waitUntilBlocked();await grant([])}finally{await lock.release()}
  expect((await retry).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();expect((await send(url,body,key)).json().data).toEqual(first.json().data)
 })
 const event:ObservationEventInput={expressionKind:'customer_quote',scopeKind:'table',eventType:'other',degree:null,reasonCode:null,seatLabel:null,customerId:null,candidateId:null,productId:null,confidence:0.8,rawExcerpt:'客人表示稍后再点'}
 async function observationFixture(native:boolean,action:'parse'|'confirm'|'revise'){
  const area=randomUUID(),table=randomUUID(),session=randomUUID()
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'AUDIT','Audit','indoor')",[area,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'AUDIT','Audit',6)",[table,scope.tenantId,scope.storeId,area])
  await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,opened_by_employee_id) VALUES($1,$2,$3,$4,'audit-session',CURRENT_DATE,2,'open',$5)",[session,scope.tenantId,scope.storeId,table,actor])
  const service=new CustomerExperienceService(runner,new NormalizedCommandExecutor(runner),{updateProfile:async()=>{throw Error('unused')}})
  const context={scope,employeeId:actor,businessDate:'2026-11-05'}
  const key=()=>native?'native-business-'+randomUUID():randomUUID()
  const parse={...(native?{nativeReceipt:true}:{}),tableSessionId:session,rawContent:'客人表示稍后再点',inputKind:'text' as const,needsImmediateAction:false,idempotencyKey:key()}
  if(action==='parse')return{call:(employeeId=actor)=>service.parseObservation({...context,employeeId},parse),table}
  const draft=await service.parseObservation(context,parse)
  const confirm={...(native?{nativeReceipt:true}:{}),publicId:draft.value.publicId,events:[event],idempotencyKey:key()}
  if(action==='confirm')return{call:(employeeId=actor)=>service.confirmObservation({...context,employeeId},confirm),table}
  const confirmed=await service.confirmObservation(context,confirm)
  const revise={...(native?{nativeReceipt:true}:{}),publicId:draft.value.publicId,previousEventId:String(confirmed.value.events[0]!.id),reason:'本地核对修订',replacement:{...event,rawExcerpt:'客人改为现在点单'},idempotencyKey:key()}
  return{call:(employeeId=actor)=>service.reviseObservation({...context,employeeId},revise),table}
 }
 for(const native of [false,true])for(const action of ['parse','confirm','revise'] as const){
  it(`observation ${native?'native':'web'} ${action} rechecks permission and table scope on the same receipt`,async()=>{
   const {call,table}=await observationFixture(native,action),first=await call(),before=await snapshot()
   expect(await call()).toEqual({...first,replayed:true});expect(await snapshot()).toEqual(before)
   await grant([]);await expect(call()).rejects.toThrow();expect(await snapshot()).toEqual(before)
   await grant(permissions.filter(p=>p!=='observation.record.all'));await expect(call()).rejects.toThrow();expect(await snapshot()).toEqual(before)
   await admin.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,reason) VALUES($1,$2,$3,$4,$5,'primary','local audit')",[scope.tenantId,scope.storeId,table,actor,role])
   expect(await call()).toEqual({...first,replayed:true});expect(await snapshot()).toEqual(before)
   await grant();await expect(call(approver)).rejects.toThrow();expect(await snapshot()).toEqual(before)
  })
 }
})
