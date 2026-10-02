import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {CustomerExperienceService,type StaffCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {CustomerCommandService} from './customer-repository.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor} from './command-executor.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
const text=(min:number,max:number)=>z.string().trim().min(min).max(max),uuid=z.string().uuid(),base={reason:text(2,500),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/)},policyVersion=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/)
const schemas={
 'profile-draft':z.object({...base,employeeId:uuid,publicDisplayName:text(1,80)}).strict(),
 'profile-publish':z.object({...base,profileId:uuid,approvalReference:text(8,240),effectiveAt:z.iso.datetime({offset:true})}).strict(),
 'profile-withdraw':z.object({...base,profileId:uuid}).strict(),
 'privacy-draft':z.object({...base,policyVersion,content:text(80,50000),operatorName:text(2,200),contact:text(2,500),dataRetentionPolicyVersion:text(2,80),thirdPartyRegisterVersion:text(2,80)}).strict(),
 'privacy-publish':z.object({...base,policyVersion,approvedBy:text(2,200),approvalReference:text(8,240),effectiveAt:z.iso.datetime({offset:true})}).strict(),
 'privacy-withdraw':z.object({...base,policyVersion}).strict(),
 contact:z.object({...base,rolloutState:z.enum(['disabled','pilot','enabled']),configuration:z.object({phone:text(6,31),phoneLabel:text(2,40),wecomName:text(2,40),wecomQrImageUrl:text(1,1000).nullable()}).strict()}).strict(),
}
const permissions={'profile-draft':'customer.public-profile.manage','profile-publish':'customer.public-profile.publish','profile-withdraw':'customer.public-profile.publish','privacy-draft':'privacy.policy.manage','privacy-publish':'privacy.policy.publish','privacy-withdraw':'privacy.policy.publish',contact:'customer.experience.feature.manage'} as const
const views=[...new Set([...Object.values(permissions),'privacy.policy.view'])]
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
function service(options:Options,commands=options.commands,tx?:ScopedTransaction){return new CustomerExperienceService(tx?{run:async(_scope,operation)=>operation(tx)}:options.transactions,commands,new CustomerCommandService(commands))}
async function version(tx:ScopedTransaction,section:string){
 const q=section==='profile'?"SELECT id,employee_id,public_display_name,status,drafted_by_employee_id,updated_at::text FROM mbox.employee_customer_public_profiles WHERE tenant_id=$1 AND store_id=$2 ORDER BY id":section==='privacy'?"SELECT id,policy_version,content_sha256,status,drafted_by_employee_id,updated_at::text FROM mbox.privacy_policy_releases WHERE tenant_id=$1 AND store_id=$2 ORDER BY id":"SELECT rollout_state,configuration,updated_at::text FROM mbox.customer_experience_features WHERE tenant_id=$1 AND store_id=$2 AND feature_code='customer.support.contact'";
 return createHash('sha256').update(JSON.stringify((await tx.query(q,[tx.scope.tenantId,tx.scope.storeId])).rows)).digest('hex')
}
export const nativeCustomerPublicationApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'PUBLICATION_FORBIDDEN',message:'当前员工无此内容管理权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof CustomerExperienceRequestError||error.original instanceof TypeError?error.original.message:'内容或状态已变化，请刷新原版本',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'PUBLICATION_INVALID',message:error instanceof TypeError?error.message:'请核对必填内容、版本与批准材料'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'PUBLICATION_CONFLICT',message:'原请求仍在处理或内容已变化，请保留原请求核对'}})
  throw error
 })
 app.get('/staff/native-publication',async request=>{const ctx=await options.resolveContext(request);const data=await options.transactions.run(ctx.scope,async tx=>{
  const access=await new StaffAccessRepository(tx).resolve(ctx.employeeId);const allowed=views.filter(p=>access.permissions.includes(p));if(!allowed.length)throw new StaffAccessDeniedError('无内容管理权');const svc=service(options,options.commands,tx)
  const profiles=allowed.some(p=>p.startsWith('customer.public-profile.')),privacy=allowed.some(p=>p.startsWith('privacy.policy.')),contact=allowed.includes(permissions.contact)
  return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,permissions:allowed,
   profiles:profiles?await svc.listCustomerPublicProfiles(ctx):[],employees:allowed.includes(permissions['profile-draft'])?await svc.listCustomerPublicationEmployees(ctx):[],policies:privacy?await svc.listPrivacyPolicyReleases(ctx):[],contact:contact?await svc.supportContact(ctx):null,
   versions:{profile:profiles?await version(tx,'profile'):null,privacy:privacy?await version(tx,'privacy'):null,contact:contact?await version(tx,'contact'):null}}
 },{readOnly:true,isolation:'repeatable-read'});return{data}})
 app.post<{Params:{action:string}}>('/staff/native-publication/:action',{bodyLimit:240000},async request=>{
  const action=z.enum(['profile-draft','profile-publish','profile-withdraw','privacy-draft','privacy-publish','privacy-withdraw','contact']).parse(request.params.action),input=schemas[action].parse(request.body),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']),ctx=await options.resolveContext(request),section=action.startsWith('profile')?'profile':action.startsWith('privacy')?'privacy':'contact'
  const guarded=nativeGuardedExecutor(options.commands,{fingerprint:{employeeId:ctx.employeeId,action,input},authorize:async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permissions[action])},guard:async tx=>{
   await tx.query('SELECT id FROM mbox.stores WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId]);
   if(section==='profile')await tx.query('SELECT id FROM mbox.employee_customer_public_profiles WHERE tenant_id=$1 AND store_id=$2 ORDER BY id FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId]);
   else if(section==='privacy')await tx.query('SELECT id FROM mbox.privacy_policy_releases WHERE tenant_id=$1 AND store_id=$2 ORDER BY id FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId]);
   else await tx.query("SELECT id FROM mbox.customer_experience_features WHERE tenant_id=$1 AND store_id=$2 AND feature_code='customer.support.contact' FOR UPDATE",[ctx.scope.tenantId,ctx.scope.storeId]);
   if(await version(tx,section)!==input.expectedVersion)throw new TypeError('原内容已变化，本次未提交，请刷新后重新核对');
   if('effectiveAt'in input&&typeof input.effectiveAt==='string'&&Date.parse(input.effectiveAt)>Date.now())throw new TypeError('此入口仅支持立即生效，请在计划发布时间提交，避免提前撤下旧内容');
  }})
  const svc=service(options,guarded),common={idempotencyKey:key,reason:input.reason};const result=await(async()=>{
   if(action==='profile-draft')return svc.draftCustomerPublicProfile(ctx,{...schemas['profile-draft'].parse(input),...common})
   if(action==='profile-publish')return svc.publishCustomerPublicProfile(ctx,{...schemas['profile-publish'].parse(input),...common})
   if(action==='profile-withdraw')return svc.withdrawCustomerPublicProfile(ctx,{...schemas['profile-withdraw'].parse(input),...common})
   if(action==='privacy-draft'){const v=schemas['privacy-draft'].parse(input);return svc.draftPrivacyPolicy(ctx,{...v,...common,contentSha256:createHash('sha256').update(v.content).digest('hex')})}
   if(action==='privacy-publish')return svc.publishPrivacyPolicy(ctx,{...schemas['privacy-publish'].parse(input),...common})
   if(action==='privacy-withdraw')return svc.withdrawPrivacyPolicy(ctx,{...schemas['privacy-withdraw'].parse(input),...common})
   return svc.setFeature(ctx,{...schemas.contact.parse(input),...common,featureCode:'customer.support.contact'})
  })();return{data:{employeeId:ctx.employeeId,requestKey:key,action,result:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
