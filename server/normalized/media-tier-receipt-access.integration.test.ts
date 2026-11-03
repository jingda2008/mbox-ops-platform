import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {MediaAssetService} from './media-asset-service.js'
import {mediaAssetApiPlugin} from './media-asset-api.js'
import {LoyaltyTierBenefitManagementService} from './loyalty-tier-benefit-management-service.js'
import {loyaltyTierBenefitManagementApiPlugin} from './loyalty-tier-benefit-management-api.js'
import {membershipConfigurationApiPlugin} from './membership-configuration-api.js'
import {MembershipConfigurationDraftService} from './membership-configuration-draft-service.js'
import {PostgresMembershipConfigurationDraftRepository} from './membership-configuration-draft-repository.js'
import {nativeMembershipConfigurationApiPlugin} from './native-membership-configuration-api.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('media and tier configuration authorization with restricted LOGIN',()=>{
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,transactions:Pick<ScopedPostgresTransactionRunner,'run'>,app:ReturnType<typeof Fastify>
 let scope:{tenantId:string;storeId:string},actor:string,approver:string,publisher:string,role:string
 let beforeExecute:(()=>Promise<void>)|undefined,beforeRun:(()=>Promise<void>)|undefined,runsUntilHook=0
 const permissions=['community.activity.view','community.activity.manage','community.activity.publish','customer.experience.feature.manage','media.asset.menu.manage','loyalty.policy.view','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish','loyalty.configuration.view','loyalty.configuration.edit','loyalty.configuration.preview','loyalty.configuration.approve']
 const grant=async(codes=permissions)=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const table of ['media_assets','loyalty_benefit_definitions','loyalty_tier_policy_versions','loyalty_tier_benefit_policy_versions','loyalty_tier_benefit_rules','membership_configuration_draft_contributors','membership_configuration_impact_fulfillment_facts','membership_configuration_impact_previews','membership_configuration_approval_facts','membership_tier_benefit_grants','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);runner=new ScopedPostgresTransactionRunner(runtime)
  transactions={run:async(s,work,settings)=>{if(runsUntilHook>0&&--runsUntilHook===0){const hook=beforeRun;beforeRun=undefined;await hook?.()}return runner.run(s,work,settings)}}
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const resolveContext=(request:{headers:Record<string,unknown>})=>({scope,employeeId:String(request.headers['x-test-employee']??actor),businessDate:'2026-11-03'})
  app=Fastify()
  await app.register(mediaAssetApiPlugin,{transactions,service:new MediaAssetService(transactions,commands),resolveStaffContext:resolveContext,resolveScope:()=>scope})
  await app.register(loyaltyTierBenefitManagementApiPlugin,{transactions,service:new LoyaltyTierBenefitManagementService(transactions,commands),resolveStaffContext:resolveContext})
  await app.register(membershipConfigurationApiPlugin,{transactions,commands,resolveStaffContext:resolveContext})
  await app.register(nativeMembershipConfigurationApiPlugin,{transactions,resolveContext})
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
 const upload=(purpose='menu')=>({purpose,fileName:'fixture.png',mimeType:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')})
 for(const purpose of ['community_activity','home_content','menu','performer','support_contact']){
  it.each(['fresh','receipt'])(`${purpose} upload %s rejects revocation after preflight`,async mode=>{
   const body=upload(purpose),key=randomUUID(),first=mode==='receipt'?await send('/staff/media-assets',body,key):undefined
   if(first)expect(first.statusCode,first.body).toBe(201)
   const before=await snapshot();beforeExecute=()=>grant(['community.activity.view','loyalty.policy.publish'])
   expect((await send('/staff/media-assets',body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
   await grant();const recovered=await send('/staff/media-assets',body,key);expect(recovered.statusCode,recovered.body).toBe(first?200:201)
   if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
  })
  it(`${purpose} enforces its own upload authority even with other management rights`,async()=>{
   await grant(purpose==='menu'?['community.activity.manage']:['media.asset.menu.manage'])
   const before=await snapshot();expect((await send('/staff/media-assets',upload(purpose))).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  })
 }
 it.each(['community.activity.manage','customer.experience.feature.manage'])('support-contact accepts the current alternative permission %s',async permission=>{
  await grant([permission]);const body=upload('support_contact'),key=randomUUID(),first=await send('/staff/media-assets',body,key)
  expect(first.statusCode,first.body).toBe(201);const before=await snapshot();expect((await send('/staff/media-assets',body,key)).statusCode).toBe(200);expect(await snapshot()).toEqual(before)
 })
 it('preserves content deduplication and treats a renamed identical image as the same shared asset',async()=>{
  const body=upload(),key=randomUUID(),first=await send('/staff/media-assets',body,key);expect(first.statusCode,first.body).toBe(201)
  const before=await snapshot(),same=await send('/staff/media-assets',{...body,fileName:'renamed.png'},key,approver)
  expect(same.statusCode,same.body).toBe(200);expect(same.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)
  const reused=await send('/staff/media-assets',body,randomUUID(),approver);expect(reused.statusCode,reused.body).toBe(201);expect(reused.json().data).toEqual(first.json().data)
  expect((await admin.query('SELECT count(*)::int n FROM mbox.media_assets WHERE tenant_id=$1',[scope.tenantId])).rows[0].n).toBe(1)
  expect((await send('/staff/media-assets',{...body,purpose:'home_content'},key)).statusCode).toBe(409)
 })
 it.each(['fresh','receipt'])('upload %s rejects a suspended operator',async mode=>{
  const body=upload(),key=randomUUID();if(mode==='receipt')expect((await send('/staff/media-assets',body,key)).statusCode).toBe(201)
  const before=await snapshot();beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor])}
  expect((await send('/staff/media-assets',body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('denies a library read if authority is revoked after the route precheck',async()=>{
  expect((await send('/staff/media-assets',upload())).statusCode).toBe(201);const before=await snapshot()
  runsUntilHook=2;beforeRun=()=>grant([]);expect((await app.inject('/staff/media-assets')).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('rechecks staff conditional reads and keeps an unpublished image private',async()=>{
  const first=await send('/staff/media-assets',upload());expect(first.statusCode,first.body).toBe(201);const value=first.json().data
  const initial=await app.inject('/staff/media-assets/'+value.publicId);expect(initial.statusCode).toBe(200)
  const read=()=>app.inject({url:'/staff/media-assets/'+value.publicId,headers:{'if-none-match':String(initial.headers.etag)}})
  expect((await read()).statusCode).toBe(304);await grant([]);const before=await snapshot();expect((await read()).statusCode).toBe(403)
  expect((await app.inject('/public/media-assets/'+value.publicId)).statusCode).toBe(404);expect(await snapshot()).toEqual(before)
 })
 const tierFixture=async()=>{
  const tier=randomUUID(),definition=randomUUID()
  await admin.query(`INSERT INTO mbox.loyalty_tier_policy_versions(id,tenant_id,store_id,version,status,evaluation_window_months,tier_period_months,downgrade_grace_days,silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,gold_retain_growth,silver_points_multiplier_numerator,silver_points_multiplier_denominator,gold_points_multiplier_numerator,gold_points_multiplier_denominator,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
   VALUES($1,$2,$3,1,'published',12,12,7,100,80,300,240,11,10,12,10,'2026-08-01T00:00:00Z',$4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z','separated','隔离等级规则')`,[tier,scope.tenantId,scope.storeId,actor,approver,publisher])
  await admin.query("INSERT INTO mbox.loyalty_benefit_definitions(id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,validity_days,requires_employee_fulfillment,cost_amount_minor,currency,status,display_snapshot) VALUES($1::uuid,$2,$3,$1::text,'SILVER_ENTRY','Synthetic','tier_benefit',30,false,0,'CNY','active','{}')",[definition,scope.tenantId,scope.storeId])
  return {tierPolicyVersionId:tier,reason:'隔离等级权益草稿',rules:[{ruleCode:'SILVER_ENTRY',eligibleTier:'silver' as const,inheritToHigherTiers:false,grantOnEntry:true,grantOnRetention:false,benefitDefinitionId:definition,quantity:1,validityDays:30,revocationPolicy:'revoke_unreserved' as const,enabled:true}]}
 }
 const draftUrl='/staff/loyalty/tier-benefit-policies'
 const configuration=()=>new MembershipConfigurationDraftService(new PostgresMembershipConfigurationDraftRepository(transactions,scope))
 const approve=async(id:string)=>{
  const service=configuration(),draft=await service.get('tier_benefits',id),preview=await service.preview('tier_benefits',id,approver)
  return service.approve({domain:'tier_benefits',publicId:id,expectedRevision:draft.revision,approverEmployeeId:approver,reason:'独立检查隔离权益规则',impactPreviewPublicId:preview.publicId})
 }
 const tierCommand=async(action:'draft'|'publish')=>{
  const body=await tierFixture();if(action==='draft')return{url:draftUrl,body,employee:actor}
  const first=await send(draftUrl,body);expect(first.statusCode,first.body).toBe(201);const id=first.json().data.id as string;await approve(id)
  return{url:`${draftUrl}/${id}/publish`,body:{effectiveFrom:'2090-01-01T00:00:00Z',effectiveUntil:null,reason:'隔离第三人正式发布'},employee:publisher}
 }
 for(const action of ['draft','publish'] as const){
  it.each(['fresh','receipt'])(`tier ${action} %s rejects revocation between precheck and execution`,async mode=>{
   const f=await tierCommand(action),key=randomUUID(),first=mode==='receipt'?await send(f.url,f.body,key,f.employee):undefined
   if(first)expect([200,201],first.body).toContain(first.statusCode)
   const before=await snapshot();beforeExecute=()=>grant(permissions.filter(p=>p!==`loyalty.policy.${action==='draft'?'manage':'publish'}`))
   expect((await send(f.url,f.body,key,f.employee)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
   await grant();const recovered=await send(f.url,f.body,key,f.employee);expect([200,201],recovered.body).toContain(recovered.statusCode)
   if(first){expect(recovered.json()).toEqual({data:first.json().data,meta:{replayed:true}});expect(await snapshot()).toEqual(before)}
  })
  it(`tier ${action} binds original actor while recovering old-format receipts`,async()=>{
   const f=await tierCommand(action),key=randomUUID(),first=await send(f.url,f.body,key,f.employee);expect([200,201],first.body).toContain(first.statusCode)
   const stored=(await admin.query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,key])).rows[0].response_snapshot
   expect(Object.keys(stored)).toEqual(['result']) // Existing receipt shape is unchanged.
   const before=await snapshot();expect((await send(f.url,f.body,key,f.employee===actor?approver:actor)).statusCode).toBe(409)
   expect((await send(f.url,{...f.body,reason:'修改后的请求内容'},key,f.employee)).statusCode).toBe(409)
   const replay=await send(f.url,f.body,key,f.employee);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)
  })
  it(`tier ${action} rejects suspended staff on a committed receipt`,async()=>{
   const f=await tierCommand(action),key=randomUUID();expect([200,201]).toContain((await send(f.url,f.body,key,f.employee)).statusCode);const before=await snapshot()
   beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[f.employee])}
   expect((await send(f.url,f.body,key,f.employee)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  })
  it(`tier ${action} recovers its committed receipt after a permitted source or policy pause`,async()=>{
   const f=await tierCommand(action),key=randomUUID(),first=await send(f.url,f.body,key,f.employee);expect([200,201],first.body).toContain(first.statusCode)
   if(action==='draft')await admin.query("UPDATE mbox.loyalty_benefit_definitions SET status='paused' WHERE tenant_id=$1",[scope.tenantId])
   else await admin.query("UPDATE mbox.loyalty_tier_benefit_policy_versions SET status='paused' WHERE tenant_id=$1 AND id=$2",[scope.tenantId,first.json().data.id])
   const before=await snapshot(),replay=await send(f.url,f.body,key,f.employee);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
   expect((await send(f.url,f.body,randomUUID(),f.employee)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
  })
  it(`tier ${action} denies new and old requests after permission was already revoked`,async()=>{
   const f=await tierCommand(action),key=randomUUID();expect([200,201]).toContain((await send(f.url,f.body,key,f.employee)).statusCode)
   await grant([]);const before=await snapshot();expect((await send(f.url,f.body,key,f.employee)).statusCode).toBe(403);expect((await send(f.url,f.body,randomUUID(),f.employee)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  })
 }
 it('configuration read rejects revocation after its outer precheck',async()=>{
  const body=await tierFixture();expect((await send(draftUrl,body)).statusCode).toBe(201);const before=await snapshot()
  runsUntilHook=2;beforeRun=()=>grant([]);expect((await app.inject('/staff/loyalty/tier-benefits')).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it.each(['list','references','detail'])('configuration-center %s read rejects in-flight revocation',async mode=>{
  const body=await tierFixture(),draft=await send(draftUrl,body);expect(draft.statusCode,draft.body).toBe(201)
  const base='/staff/loyalty/configuration-center',url=mode==='list'?base:mode==='references'?base+'/references':base+'/tier_benefits/'+draft.json().data.id
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>grant(permissions.filter(p=>p!=='loyalty.configuration.view'))
  expect((await app.inject(url)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();expect((await app.inject(url)).statusCode).toBe(200);expect(await snapshot()).toEqual(before)
 })
 it.each(['missing','ambiguous'])('tier receipt fails closed on %s original audit evidence',async mode=>{
  const f=await tierCommand('draft'),key=randomUUID(),first=await send(f.url,f.body,key);expect(first.statusCode,first.body).toBe(201)
  if(mode==='missing')await admin.query("UPDATE mbox.idempotency_records SET response_snapshot=jsonb_set(response_snapshot,'{result,id}',to_jsonb($3::text)) WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,key,randomUUID()])
  else await admin.query("INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_employee_id,action,object_type,object_id,business_date,after_snapshot) SELECT tenant_id,store_id,actor_type,actor_employee_id,action,object_type,object_id,business_date,after_snapshot FROM mbox.audit_events WHERE tenant_id=$1 AND action='loyalty.tier-benefit-policy.drafted' LIMIT 1",[scope.tenantId])
  const before=await snapshot();expect((await send(f.url,f.body,key)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 it('original draft receipt survives editing and approval without restoring the old rules',async()=>{
  const body=await tierFixture(),key=randomUUID(),first=await send(draftUrl,body,key);expect(first.statusCode,first.body).toBe(201)
  const id=first.json().data.id as string,service=configuration(),draft=await service.get('tier_benefits',id)
  await service.edit({domain:'tier_benefits',publicId:id,expectedRevision:draft.revision,employeeId:publisher,reason:'隔离第二名贡献者修改',content:{...draft.content,rules:body.rules.map(r=>({...r,quantity:2}))}})
  await approve(id);const before=await snapshot(),replay=await send(draftUrl,body,key)
  expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)
  expect((await send(draftUrl,body,key,publisher)).statusCode).toBe(409)
  // Every contributor, including a later editor, remains excluded from publication.
  const denied=await send(`${draftUrl}/${id}/publish`,{effectiveFrom:'2090-01-01T00:00:00Z',reason:'贡献者不可发布'},randomUUID(),publisher)
  expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error.code).toBe('LOYALTY_TIER_BENEFIT_PUBLISHER_NOT_INDEPENDENT')
  expect(await snapshot()).toEqual(before)
 })
 it('legacy approval endpoint stays disabled even with full permissions',async()=>{
  const body=await tierFixture(),draft=await send(draftUrl,body);expect(draft.statusCode,draft.body).toBe(201);const before=await snapshot()
  const response=await send(`${draftUrl}/${draft.json().data.id}/approve`,{reason:'旧入口不可审批'},randomUUID(),approver)
  expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED');expect(await snapshot()).toEqual(before)
 })
 for(const action of ['edit','preview','approve'])it(`configuration-center ${action} rechecks permission in its transaction`,async()=>{
  const body=await tierFixture(),created=await send(draftUrl,body);expect(created.statusCode,created.body).toBe(201);const id=created.json().data.id as string,service=configuration(),draft=await service.get('tier_benefits',id)
  const preview=action==='approve'?await service.preview('tier_benefits',id,approver):null
  const url=`/staff/loyalty/configuration-center/tier_benefits/${id}/${action==='edit'?'draft':action==='preview'?'impact-preview':'approve'}`
  const input=action==='edit'?{expectedRevision:draft.revision,reason:'隔离修改权益',content:{...draft.content,rules:body.rules.map(r=>({...r,quantity:2}))}}:action==='approve'?{expectedRevision:draft.revision,reason:'隔离独立审批',impactPreviewPublicId:preview!.publicId}:{}
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>grant(permissions.filter(p=>p!==`loyalty.configuration.${action}`))
  expect((await send(url,input,randomUUID(),approver,action==='edit'?'PUT':'POST')).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();expect((await send(url,input,randomUUID(),approver,action==='edit'?'PUT':'POST')).statusCode).toBe(200)
 })
 it.each(['fresh','receipt'])('native tier draft %s already rechecks authority',async mode=>{
  const body=await tierFixture(),input={action:'create',content:{domain:'tier_benefits',tierPolicyVersionId:body.tierPolicyVersionId,rules:body.rules},reason:body.reason},key=`native-business-${randomUUID()}`
  const first=mode==='receipt'?await send('/staff/native-membership-config/commands',input,key):undefined;if(first)expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>grant(permissions.filter(p=>p!=='loyalty.policy.manage'))
  expect((await send('/staff/native-membership-config/commands',input,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
})
