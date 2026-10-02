import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {NormalizedCommandExecutor,NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type JsonObject,type AuditEvent,type OutboxMessage} from './command-executor.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {CustomerExperienceService,type StaffCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerCommandService} from './customer-repository.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {listMembershipConfigurations,membershipConfigurationReferences} from './membership-configuration-api.js'
import {PostgresMembershipConfigurationDraftRepository} from './membership-configuration-draft-repository.js'
import {MembershipConfigurationDraftService,MembershipConfigurationDraftError,assertContent} from './membership-configuration-draft-service.js'
import {LoyaltyTierBenefitManagementService} from './loyalty-tier-benefit-management-service.js'
import {PromotionalLoyaltyService,PromotionalLoyaltyError} from './promotional-loyalty-service.js'
import {MembershipTermsService} from './membership-terms-service.js'
import {LoyaltyOperationalControlService,LoyaltyOperationalControlError} from './loyalty-operational-control-service.js'
import {publishMembershipNotification} from './membership-notification-publication.js'
import {nativeMembershipInput,nativeMembershipPermission,membershipDomains} from './native-membership-configuration-schema.js'
type Options={transactions:Pick<ScopedPostgresTransactionRunner,'run'>;resolveContext:(request:FastifyRequest)=>StaffCustomerExperienceContext|Promise<StaffCustomerExperienceContext>}
const json=(value:unknown):JsonObject=>JSON.parse(JSON.stringify(value)) as JsonObject
export const nativeMembershipConfigurationApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 // Preview, governance mutation and permanent receipt must share one serializable transaction.
 const transactions:Options['transactions']={run:(scope,work,settings)=>options.transactions.run(scope,work,{...settings,isolation:'serializable',retryOnConflict:2})}
 const executor=new NormalizedCommandExecutor(transactions)
 app.addHook('onRequest',async(_r,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_r,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'MEMBERSHIP_CONFIGURATION_FORBIDDEN',message:'当前岗位没有此项会员规则权限'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'MEMBERSHIP_CONFIGURATION_INVALID',message:'请核对规则字段、原版本及时间格式'}})
  if(error instanceof NativeCommandNotCommittedError){const original=error.original;return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',commitDisposition:'not_committed',message:original instanceof MembershipConfigurationDraftError||original instanceof CustomerExperienceRequestError||original instanceof LoyaltyOperationalControlError||original instanceof PromotionalLoyaltyError?original.message:'规则或关联数据已变化，本次未提交，请刷新核对'}})}
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MEMBERSHIP_REQUEST_CONFLICT',message:'请恢复原请求，不能更换内容重试'}})
  if(error instanceof MembershipConfigurationDraftError)return reply.code(409).send({error:{code:error.code,message:error.message}})
  throw error
 })
 async function authorize(request:FastifyRequest,permission:string){const ctx=await options.resolveContext(request);await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission),{readOnly:true});return ctx}
 app.get('/staff/native-membership-config',async request=>{
  const query=z.object({section:z.enum(['rules','controls']).default('rules')}).strict().parse(request.query)
  const ctx=await authorize(request,query.section==='rules'?'loyalty.configuration.view':'loyalty.operations.view')
  const result=query.section==='controls'?{items:await new LoyaltyOperationalControlService(options.transactions,executor).list(ctx),references:[]}:await options.transactions.run(ctx.scope,async tx=>({items:await listMembershipConfigurations(tx),references:await membershipConfigurationReferences(tx)}),{readOnly:true})
  return{data:{...result,section:query.section,employeeId:ctx.employeeId,durableCommands:true,protocol:1}}
 })
 app.get<{Params:{domain:string;id:string}}>('/staff/native-membership-config/:domain/:id',async request=>{
  const ctx=await authorize(request,'loyalty.configuration.view'),domain=membershipDomains.parse(request.params.domain),id=z.uuid().parse(request.params.id)
  const detail=await transactions.run(ctx.scope,async tx=>{
   const runner:Options['transactions']={run:(_s,fn)=>fn(tx)},repo=new PostgresMembershipConfigurationDraftRepository(runner,ctx.scope)
   return repo.runExclusive(domain,id,async session=>{
    const draft=await session.loadDraft(id);if(!draft)throw new MembershipConfigurationDraftError('MEMBERSHIP_CONFIGURATION_NOT_FOUND','配置不存在')
    const found=await tx.query<{public_id:string}>(`SELECT public_id FROM mbox.membership_configuration_impact_previews WHERE tenant_id=$1 AND store_id=$2 AND configuration_domain=$3 AND configuration_id=$4 AND draft_revision=$5 AND expires_at>clock_timestamp() ORDER BY generated_at DESC,id DESC LIMIT 1`,[ctx.scope.tenantId,ctx.scope.storeId,domain,id,draft.revision])
    return{draft,preview:found.rows[0]?await session.loadImpactPreview(found.rows[0].public_id):null}
   })
  })
  return{data:{...detail,employeeId:ctx.employeeId,durableCommands:true,protocol:1}}
 })
 app.post('/staff/native-membership-config/commands',{bodyLimit:524288},async request=>{
  const input=nativeMembershipInput.parse(request.body),action=input.action,domain='content'in input?input.content.domain:'domain'in input?input.domain:''
  const permission=nativeMembershipPermission(action,domain),ctx=await authorize(request,permission),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  const result=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'membership.configuration.native.'+action,retainReceipt:true,idempotencyKey:key,requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,input})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   if('content'in input)assertContent(input.content)
   const runner:Options['transactions']={run:(_scope,fn)=>fn(tx)},audits:AuditEvent[]=[],outbox:OutboxMessage[]=[]
   // Domain commands run within this receipt transaction; never commit through a second connection.
   const commands:Pick<NormalizedCommandExecutor,'execute'>={execute:async(_command,handler,beforeClaim)=>{await beforeClaim?.(tx);const outcome=await handler(tx);audits.push(...outcome.auditEvents);outbox.push(...outcome.outboxMessages);return{value:outcome.result,replayed:false}}}
   const repo=new PostgresMembershipConfigurationDraftRepository(runner,ctx.scope),drafts=new MembershipConfigurationDraftService(repo)
   const customer=new CustomerExperienceService(runner,commands,new CustomerCommandService(commands)),tier=new LoyaltyTierBenefitManagementService(runner,commands),promo=new PromotionalLoyaltyService(runner,commands),terms=new MembershipTermsService(runner,commands)
   let value:unknown,configurationId='configurationId'in input?input.configurationId:null
   if(action==='create'||action==='publish')await tx.query('SELECT id FROM mbox.stores WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId])
   if('configurationId'in input){const original=await drafts.get(input.domain,input.configurationId);if(original.revision!==input.expectedRevision||original.status!==(action==='publish'?'approved':'draft'))throw new MembershipConfigurationDraftError('MEMBERSHIP_CONFIGURATION_STALE','原规则版本或状态已变化，请重新读取');if(action==='publish'&&original.makerEmployeeIds.includes(ctx.employeeId))throw new MembershipConfigurationDraftError('MEMBERSHIP_CONFIGURATION_PUBLISHER_SEPARATION_REQUIRED','发布人必须与所有草稿编辑者和审批人不同');if('content'in input&&input.domain!==input.content.domain)throw new MembershipConfigurationDraftError('MEMBERSHIP_CONFIGURATION_DOMAIN_MISMATCH','配置域不一致')}
   if(input.action==='control')value=(await new LoyaltyOperationalControlService(runner,commands).set(ctx,{...input,idempotencyKey:key})).value
   else if(input.action==='create'){
    const c=input.content,common={reason:input.reason,idempotencyKey:key}
    if(c.domain==='base_points')value=(await customer.draftLoyaltyPolicy(ctx,{...c,...common,policyCode:'BASE'})).value
    else if(c.domain==='tier_policy')value=(await customer.draftLoyaltyTierPolicy(ctx,{...c,...common})).value
    else if(c.domain==='tier_benefits')value=(await tier.draft(ctx,{...c,...common})).value
    else if(c.domain==='redemption_catalog'){
     if(c.items.some(item=>item.status!=='active'))throw new MembershipConfigurationDraftError('MEMBERSHIP_CONFIGURATION_NEW_ITEMS','新建目录兑换项须先处于启用草稿状态；暂停或退役在草稿编辑中设置')
     value=(await customer.draftRedemptionCatalog(ctx,{...common,items:c.items.map(item=>({...item,display:{}}))})).value
    }else if(c.domain==='promotion_points')value=(await promo.draft(ctx,{...c,...common})).value
    else if(c.domain==='membership_terms')value=(await terms.createDraft(ctx,{...c,...common})).value
    else throw new MembershipConfigurationDraftError('MEMBERSHIP_NOTIFICATION_MANAGED','微信通知使用后台托管草稿，请选择已有版本编辑')
    configurationId=(value as {id:string}).id
   }else if(input.action==='edit')value=await drafts.edit({domain:input.domain,publicId:input.configurationId,expectedRevision:input.expectedRevision,employeeId:ctx.employeeId,reason:input.reason,content:input.content})
   else if(input.action==='preview')value=await drafts.preview(input.domain,input.configurationId,ctx.employeeId)
   else if(input.action==='approve')value=await drafts.approve({domain:input.domain,publicId:input.configurationId,expectedRevision:input.expectedRevision,approverEmployeeId:ctx.employeeId,impactPreviewPublicId:input.impactPreviewPublicId,reason:input.reason})
   else {
    const common={effectiveFrom:input.effectiveFrom,effectiveUntil:input.effectiveUntil,reason:input.reason,idempotencyKey:key}
    if(input.domain==='base_points')value=(await customer.publishLoyaltyPolicy(ctx,{...common,policyId:input.configurationId})).value
    else if(input.domain==='tier_policy')value=(await customer.publishLoyaltyTierPolicy(ctx,{...common,policyId:input.configurationId})).value
    else if(input.domain==='tier_benefits')value=(await tier.publish(ctx,{...common,policyId:input.configurationId})).value
    else if(input.domain==='redemption_catalog')value=(await customer.publishRedemptionCatalog(ctx,{...common,catalogId:input.configurationId})).value
    else if(input.domain==='promotion_points')value=(await promo.publish(ctx,{...common,policyId:input.configurationId})).value
    else if(input.domain==='membership_terms'){
     if(input.effectiveUntil!==null)throw new MembershipConfigurationDraftError('MEMBERSHIP_TERMS_UNTIL','入会条款由下一版替代，不能设置结束时间')
     const row=(await tx.query<{version:number}>('SELECT version FROM mbox.membership_terms_versions WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[ctx.scope.tenantId,ctx.scope.storeId,input.configurationId])).rows[0]!
     value=(await terms.publish(ctx,{...common,version:row.version})).value
    }else value=await publishMembershipNotification(tx,input.configurationId,ctx.employeeId,input)
   }
   audits.push({actor:{type:'employee',employeeId:ctx.employeeId},action:'membership.configuration.native.'+action,objectType:domain||'loyalty_operational_control',objectId:configurationId??('capability'in input?input.capability:'configuration'),businessDate:ctx.businessDate,reason:'reason'in input?input.reason:'生成服务器影响预览',metadata:{requestKey:key,action,domain,configurationId}})
   return{result:json({action,domain,configurationId,employeeId:ctx.employeeId,requestKey:key,result:value}),auditEvents:audits,outboxMessages:outbox}
  },async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.tenantId!==ctx.scope.tenantId||current.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('员工已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  return{data:result.value,meta:{protocol:1,replayed:result.replayed}}
 })
}
