import {holdFixtureReceipts} from './staff-permission.test-helper.js'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor,hashRequestFingerprint,type CommandExecution} from './command-executor.js'
import {ActivityOperationsService} from './activity-operations-service.js'
import type {ActivityDraftInput} from './activity-operations-repository.js'
import {CustomerExperienceService} from './customer-experience-service.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('staff configuration command authority with restricted LOGIN',()=>{
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,transactions:Pick<ScopedPostgresTransactionRunner,'run'>,service:CustomerExperienceService,activities:ActivityOperationsService
 let scope:{tenantId:string;storeId:string},actor:string,approver:string,publisher:string,role:string
 let lastFingerprint=''
 let beforeExecute:(()=>Promise<void>)|undefined,beforeRun:(()=>Promise<void>)|undefined,runsUntilHook=0
 const permissions=['customer.experience.feature.manage','recommendation.rule.draft','recommendation.rule.approve','recommendation.rule.publish','customer.public-profile.manage','customer.public-profile.publish','privacy.policy.manage','privacy.policy.publish','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish','loyalty.redemption.control','fulfillment.capacity.draft','fulfillment.capacity.approve','fulfillment.capacity.publish','community.activity.manage','community.activity.publish','community.activity.verify']
 const grant=async(codes=permissions)=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const table of ['community_activities','community_activity_packages','customer_experience_features','employee_customer_public_profiles','privacy_policy_releases','loyalty_policy_versions','loyalty_tier_policy_versions','loyalty_redemption_controls','fulfillment_capacity_policy_versions','fulfillment_capacity_windows','recommendation_policy_versions','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);runner=new ScopedPostgresTransactionRunner(runtime)
  transactions={run:async(s,work,settings)=>{if(runsUntilHook>0&&--runsUntilHook===0){const hook=beforeRun;beforeRun=undefined;await hook?.()}return runner.run(s,work,settings)}}
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{lastFingerprint=args[0].requestFingerprint;const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  activities=new ActivityOperationsService(transactions,commands)
  service=new CustomerExperienceService(transactions,commands,{updateProfile:async()=>{throw Error('unused')}})
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
 afterAll(async()=>{await runtime?.end();await admin?.end()})
 const kinds=['feature','recommendation-feature','profile-draft','profile-publish','profile-withdraw','privacy-draft','privacy-publish','privacy-withdraw','policy-draft','tier-draft','redemption-control','capacity-draft','capacity-approve','capacity-publish','recommendation-draft','recommendation-approve','recommendation-publish','recommendation-clone','activity-create','activity-update','activity-publish','activity-close','activity-stop'] as const
 async function fixture(kind:typeof kinds[number]):Promise<(employeeId?:string)=>Promise<CommandExecution<unknown>>>{
  const ctx=(employeeId=actor)=>({scope,employeeId,businessDate:'2026-11-05'}),common={reason:'Local authorization audit',idempotencyKey:randomUUID()},now=new Date().toISOString()
  if(kind.startsWith('activity-')){
   const draft:ActivityDraftInput={kind:'member_night',title:'本地权限活动',summary:'隔离数据库测试活动',coverUrl:null,startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),assemblyLocation:'Local',capacity:30,feeAmountMinor:0,depositAmountMinor:0,feeBasis:'per_registration',paymentMode:'none',paymentDeadlineMinutes:15,paymentRuleText:'免费活动',pointsReward:0,visibility:'public',audienceMemberLevels:[],audienceLifecycleStages:[],safetyPolicyVersion:'local-safety-v1',safetyAcknowledgementText:'已阅读活动安全规则',safetyRequirements:['成年参与'],refundPolicyVersion:'local-refund-v1',refundPolicySummary:'免费活动可取消',activityDetails:'本地数据库活动权限测试，无真实报名。',includedItems:['活动入场'],participationRequirements:['准时到场'],contactInstructions:'本地测试',memberBenefitText:null,packageSelectionRequired:false,packages:[]}
   if(kind==='activity-create')return(employeeId=actor)=>activities.createDraft(ctx(employeeId),{...common,draft})
   const created=await activities.createDraft(ctx(approver),{...common,idempotencyKey:randomUUID(),draft}),publicId=created.value.publicId
   if(kind==='activity-update')return(employeeId=actor)=>activities.updateDraft(ctx(employeeId),{...common,publicId,draft:{...draft,title:'修改本地活动'}})
   if(kind==='activity-close')return(employeeId=actor)=>activities.closeActivity(ctx(employeeId),{...common,publicId,status:'cancelled'})
   if(kind==='activity-publish')return(employeeId=actor)=>service.publishActivity(ctx(employeeId),{idempotencyKey:common.idempotencyKey,publicId})
   await service.publishActivity(ctx(publisher),{idempotencyKey:randomUUID(),publicId})
   return(employeeId=actor)=>activities.stopRegistration(ctx(employeeId),{...common,publicId})
  }
  if(kind==='feature'||kind==='recommendation-feature')return(employeeId=actor)=>service.setFeature(ctx(employeeId),{...common,featureCode:kind==='feature'?'customer.support.contact':'recommendation.engine',rolloutState:'disabled',configuration:{}})
  if(kind.startsWith('profile')){
   const draft={...common,employeeId:publisher,publicDisplayName:'Local staff'}
   if(kind==='profile-draft')return(employeeId=actor)=>service.draftCustomerPublicProfile(ctx(employeeId),draft)
   const created=await service.draftCustomerPublicProfile(ctx(approver),{...draft,idempotencyKey:randomUUID()})
   const publish={...common,profileId:created.value.id,approvalReference:'Local evidence',effectiveAt:now}
   if(kind==='profile-publish')return(employeeId=actor)=>service.publishCustomerPublicProfile(ctx(employeeId),publish)
   await service.publishCustomerPublicProfile(ctx(actor),{...publish,idempotencyKey:randomUUID()})
   return(employeeId=actor)=>service.withdrawCustomerPublicProfile(ctx(employeeId),{...common,profileId:created.value.id})
  }
  if(kind.startsWith('privacy')){
   const content='Local isolated privacy policy. '.repeat(4),draft={...common,policyVersion:'audit-v1',content,contentSha256:createHash('sha256').update(content).digest('hex'),operatorName:'Local operator',contact:'Local contact',dataRetentionPolicyVersion:'local-v1',thirdPartyRegisterVersion:'local-v1'}
   if(kind==='privacy-draft')return(employeeId=actor)=>service.draftPrivacyPolicy(ctx(employeeId),draft)
   await service.draftPrivacyPolicy(ctx(approver),{...draft,idempotencyKey:randomUUID()})
   const publish={...common,policyVersion:draft.policyVersion,approvedBy:'Local reviewer',approvalReference:'Local evidence',effectiveAt:now}
   if(kind==='privacy-publish')return(employeeId=actor)=>service.publishPrivacyPolicy(ctx(employeeId),publish)
   await service.publishPrivacyPolicy(ctx(actor),{...publish,idempotencyKey:randomUUID()})
   return(employeeId=actor)=>service.withdrawPrivacyPolicy(ctx(employeeId),{...common,policyVersion:draft.policyVersion})
  }
  if(kind.startsWith('policy')){
   const draft={...common,policyCode:'BASE',pointsNumerator:1,pointsDenominatorMinor:1000,growthNumerator:1,growthDenominatorMinor:100,roundingMode:'floor' as const,pointsValidityMonths:12}
   if(kind==='policy-draft')return(employeeId=actor)=>service.draftLoyaltyPolicy(ctx(employeeId),draft)
   const created=await service.draftLoyaltyPolicy(ctx(approver),{...draft,idempotencyKey:randomUUID()})
   const approve={...common,policyId:created.value.id}

   await service.approveLoyaltyPolicy(ctx(publisher),{...approve,idempotencyKey:randomUUID()})
   return(employeeId=actor)=>service.publishLoyaltyPolicy(ctx(employeeId),{...common,policyId:created.value.id,effectiveFrom:now,effectiveUntil:null})
  }
  if(kind.startsWith('tier')){
   const draft={...common,evaluationWindowMonths:12,tierPeriodMonths:12,downgradeGraceDays:30,silverUpgradeGrowth:1000,silverRetainGrowth:500,goldUpgradeGrowth:5000,goldRetainGrowth:3000,silverPointsMultiplierNumerator:1,silverPointsMultiplierDenominator:1,goldPointsMultiplierNumerator:2,goldPointsMultiplierDenominator:1}
   if(kind==='tier-draft')return(employeeId=actor)=>service.draftLoyaltyTierPolicy(ctx(employeeId),draft)
   const created=await service.draftLoyaltyTierPolicy(ctx(approver),{...draft,idempotencyKey:randomUUID()})
   const approve={...common,policyId:created.value.id,impactPreviewAcknowledged:true}

   await service.approveLoyaltyTierPolicy(ctx(publisher),{...approve,idempotencyKey:randomUUID()})
   return(employeeId=actor)=>service.publishLoyaltyTierPolicy(ctx(employeeId),{...common,policyId:created.value.id,effectiveFrom:now,effectiveUntil:null})
  }
  if(kind==='redemption-control')return(employeeId=actor)=>service.setRedemptionControl(ctx(employeeId),{...common,state:'paused',pilotStartsAt:null,pilotEndsAt:null})
  if(kind.startsWith('capacity')){
   const draft={...common,stationCode:'bar' as const,windows:[{startsAt:new Date(Date.now()+3600000).toISOString(),endsAt:new Date(Date.now()+7200000).toISOString(),capacityLimitUnits:100}]}
   if(kind==='capacity-draft')return(employeeId=actor)=>service.draftFulfillmentCapacity(ctx(employeeId),draft)
   const created=await service.draftFulfillmentCapacity(ctx(approver),{...draft,idempotencyKey:randomUUID()})
   if(kind==='capacity-approve')return(employeeId=actor)=>service.transitionFulfillmentCapacity(ctx(employeeId),{...common,policyId:created.value.id,action:'approve'})
   await service.transitionFulfillmentCapacity(ctx(publisher),{...common,idempotencyKey:randomUUID(),policyId:created.value.id,action:'approve'})
   return(employeeId=actor)=>service.transitionFulfillmentCapacity(ctx(employeeId),{...common,policyId:created.value.id,action:'publish'})
  }
  const draft={code:'DEFAULT',preferenceWeight:100,sceneWeight:60,marginWeight:50,priorityWeight:50,performanceWeight:50,inventoryWeight:50,capacityWeight:50,minimumGrossMarginBasisPoints:1500,preferenceHalfLifeDays:90,preferenceMaxAgeDays:730,preferenceMinEffectiveScore:1000,preferenceMinConfidenceBasisPoints:2500,explanationTemplate:'本地隔离规则',displayConfiguration:{},draftReason:common.reason,idempotencyKey:common.idempotencyKey}
  if(kind==='recommendation-draft')return(employeeId=actor)=>service.createRecommendationPolicy(ctx(employeeId),draft)
  const created=await service.createRecommendationPolicy(ctx(approver),{...draft,idempotencyKey:randomUUID()})
  if(kind==='recommendation-approve')return(employeeId=actor)=>service.approveRecommendationPolicy(ctx(employeeId),{...common,publicId:created.value.publicId})
  if(kind==='recommendation-clone'){
   await service.approveRecommendationPolicy(ctx(publisher),{...common,idempotencyKey:randomUUID(),publicId:created.value.publicId})
   await service.publishRecommendationPolicy(ctx(actor),{...common,idempotencyKey:randomUUID(),publicId:created.value.publicId,effectiveFrom:now})
   return(employeeId=actor)=>service.cloneRecommendationPolicyDraft(ctx(employeeId),{idempotencyKey:common.idempotencyKey,sourcePublicId:created.value.publicId,draftReason:common.reason})
  }
  await service.approveRecommendationPolicy(ctx(publisher),{...common,idempotencyKey:randomUUID(),publicId:created.value.publicId})
  return(employeeId=actor)=>service.publishRecommendationPolicy(ctx(employeeId),{...common,publicId:created.value.publicId,effectiveFrom:now})
 }
 for(const kind of kinds)for(const mode of ['fresh','receipt'] as const){
  it(`${kind} ${mode} rejects revocation inside the command boundary`,async()=>{
   const call=await fixture(kind),first=mode==='receipt'?await call():null,before=await snapshot()
   beforeExecute=()=>grant([]);await expect(call()).rejects.toThrow();expect(await snapshot()).toEqual(before)
   await grant();const result=await call()
   if(first){expect(result).toEqual({...first,replayed:true});expect(await snapshot()).toEqual(before)}
   const committed=await snapshot();await expect(call(approver)).rejects.toThrow();expect(await snapshot()).toEqual(committed)
   expect(await call()).toEqual({...result,replayed:true});expect(await snapshot()).toEqual(committed)
  })
 }
 it('staff feature rechecks authorization after waiting on its original receipt',async()=>{
  const call=await fixture('feature'),first=await call(),before=await snapshot(),lock=await holdFixtureReceipts(admin,scope.tenantId)
  // Observe rejection immediately so a fast denied retry cannot become unhandled.
  const retry=call().then(value=>({value,error:null}),error=>({value:null,error}))
  try{await lock.waitUntilBlocked();await grant([])}finally{await lock.release()}
  expect((await retry).error).toBeTruthy();expect(await snapshot()).toEqual(before)
  await grant();expect(await call()).toEqual({...first,replayed:true})
 })
 it('does not replay a legacy unbound operator fingerprint or silently rerun it',async()=>{
  const call=await fixture('feature');await call()
  const original=JSON.parse(lastFingerprint).requestFingerprint as string
  await admin.query('UPDATE mbox.idempotency_records SET request_sha256=$2 WHERE tenant_id=$1',[scope.tenantId,hashRequestFingerprint(original)])
  const before=await snapshot();await expect(call()).rejects.toMatchObject({name:'IdempotencyConflictError'});expect(await snapshot()).toEqual(before)
 })
 it('recommendation publication permission cannot be replaced by generic feature management',async()=>{
  const call=await fixture('recommendation-feature')
  await grant(['customer.experience.feature.manage']);await expect(call()).rejects.toThrow()
  await grant(['recommendation.rule.publish']);expect((await call()).replayed).toBe(false)
  await grant(['customer.experience.feature.manage']);await expect(call()).rejects.toThrow()
 })
 it('retains already actor-bound activity door receipts and its verifier-only permission',async()=>{
  const context={scope,employeeId:actor,businessDate:'2026-11-05'},publicId='historical-activity-receipt',command={action:'admit' as const,arrivedCount:1},key=randomUUID()
  const result={historicalReceipt:true}
  // Represent a completed pre-upgrade receipt; recovery must never run the door mutation again.
  await new NormalizedCommandExecutor(runner).execute({scope,operationScope:'activity.service.door',idempotencyKey:key,retainReceipt:true,requestFingerprint:JSON.stringify({employeeId:actor,publicId,command}),resultCodec:{encode:v=>v,decode:v=>v as typeof result}},async()=>({result,auditEvents:[],outboxMessages:[]}))
  await grant(['community.activity.verify']);const before=await snapshot()
  expect(await activities.serviceCommand(context,publicId,command,key)).toEqual({value:result,replayed:true})
  await expect(activities.serviceCommand({...context,employeeId:approver},publicId,command,key)).rejects.toMatchObject({name:'IdempotencyConflictError'})
  await expect(activities.serviceCommand(context,publicId,{action:'restore_plaque'},randomUUID())).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
 })
})
