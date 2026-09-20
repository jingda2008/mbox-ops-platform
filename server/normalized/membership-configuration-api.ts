import {z} from 'zod'
import {publishMembershipNotification} from './membership-notification-publication.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { StaffCustomerExperienceContext } from './customer-experience-service.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import {
  MembershipConfigurationDraftError,
  MembershipConfigurationDraftService,
  type MembershipConfigurationContent,
  type MembershipConfigurationDomain,
} from './membership-configuration-draft-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

const domains = Object.freeze([
  'base_points','tier_policy','tier_benefits','redemption_catalog',
  'promotion_points','membership_terms','wechat_notifications',
] as const)

export interface MembershipConfigurationApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  resolveStaffContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext
  createStaffAccessRepository?(transaction:ScopedTransaction):Pick<StaffAccessRepository,'assertPermission'>
}

export const membershipConfigurationApiPlugin:FastifyPluginAsync<MembershipConfigurationApiOptions & {commands:Pick<NormalizedCommandExecutor,'execute'>}>=async(app,options)=>{
  app.post<{Params:{configurationId:string}}>('/staff/loyalty/configuration-center/wechat_notifications/:configurationId/publish',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'loyalty.policy.publish')
    const id=z.uuid().parse(request.params.configurationId)
    const input=z.object({expectedRevision:z.number().int().positive(),effectiveFrom:z.iso.datetime({offset:true}),effectiveUntil:z.iso.datetime({offset:true}).nullable(),reason:z.string().trim().min(2).max(500)}).strict().parse(request.body)
    const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
    const result=await options.commands.execute<JsonObject>({scope:context.scope,operationScope:'membership.notification.publish',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,id,input}),resultCodec:{encode:value=>value,decode:value=>value as JsonObject}},async transaction=>{
      const value=await publishMembershipNotification(transaction,id,context.employeeId,input)
      return {result:value,auditEvents:[{actor:{type:'employee',employeeId:context.employeeId},action:'membership.notification.publish',objectType:'wechat_notification_policy',objectId:id,businessDate:context.businessDate,afterData:{...value,reason:input.reason}}],outboxMessages:[]}
    })
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.get('/staff/loyalty/configuration-center',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'loyalty.configuration.view')
    const rows=await options.transactions.run(context.scope,async(transaction)=>{
      const result=await transaction.query<ConfigurationListRow>(`
        SELECT * FROM (
          SELECT 'base_points'::text domain,id,status,draft_revision,version,
            policy_code AS title,updated_at,effective_from,effective_until,approved_by_employee_id FROM mbox.loyalty_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'tier_policy',id,status,draft_revision,version,'会员等级',updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.loyalty_tier_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'tier_benefits',id,status,draft_revision,version,'等级权益',updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.loyalty_tier_benefit_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'redemption_catalog',id,status,draft_revision,version,'积分兑换',updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.redemption_catalog_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'promotion_points',id,status,draft_revision,version,name,updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.loyalty_promotion_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'membership_terms',id,status,draft_revision,version,title,updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.membership_terms_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'wechat_notifications',id,status,draft_revision,policy_version,notification_type,updated_at,effective_from,effective_until,approved_by_employee_id
            FROM mbox.wechat_notification_policies WHERE tenant_id=$1::uuid AND store_id=$2::uuid
              AND governance_mode='managed'
        ) configuration ORDER BY updated_at DESC,domain,version DESC,id
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      return result.rows.map((row)=>({domain:row.domain,configurationId:row.id,status:row.status,
        revision:row.draft_revision,version:row.version,title:row.title,updatedAt:row.updated_at,effectiveFrom:row.effective_from,effectiveUntil:row.effective_until,approvedByEmployeeId:row.approved_by_employee_id}))
    },{readOnly:true})
    return reply.send({data:rows})
  }))

  app.get('/staff/loyalty/configuration-center/references',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'loyalty.configuration.view')
    const data=await options.transactions.run(context.scope,async(transaction)=>{
      const result=await transaction.query<{kind:string;id:string;name:string;status:string}>(`
        SELECT 'tierPolicyVersionId'::text kind,id,'会员等级 第' || version || '版' AS name,status
          FROM mbox.loyalty_tier_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        UNION ALL SELECT 'benefitDefinitionId',id,name,status FROM mbox.loyalty_benefit_definitions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        UNION ALL SELECT 'productId',id,name,status FROM mbox.products
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        UNION ALL SELECT 'activityId',id,title,status FROM mbox.community_activities
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        ORDER BY kind,name,id
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      return result.rows
    },{readOnly:true})
    return reply.send({data})
  }))

  app.get<{Params:{domain:string;configurationId:string}}>(
    '/staff/loyalty/configuration-center/:domain/:configurationId',
    async(request,reply)=>handle(reply,async()=>{
      const context=await authorized(options,request,'loyalty.configuration.view')
      const domain=domainValue(request.params.domain)
      return reply.send({data:await service(options,context).get(domain,request.params.configurationId)})
    }),
  )

  app.put<{Params:{domain:string;configurationId:string}}>(
    '/staff/loyalty/configuration-center/:domain/:configurationId/draft',
    async(request,reply)=>handle(reply,async()=>{
      const context=await authorized(options,request,'loyalty.configuration.edit')
      const domain=domainValue(request.params.domain)
      const body=object(request.body)
      const content=object(body.content) as MembershipConfigurationContent
      if(content.domain!==domain)throw invalid('配置内容与配置域不一致')
      const result=await service(options,context).edit({domain,publicId:request.params.configurationId,
        expectedRevision:integer(body.expectedRevision,'草稿版本'),employeeId:context.employeeId,
        reason:text(body.reason,'修改原因',2,500),content})
      return reply.send({data:result})
    }),
  )

  app.post<{Params:{domain:string;configurationId:string}}>(
    '/staff/loyalty/configuration-center/:domain/:configurationId/impact-preview',
    async(request,reply)=>handle(reply,async()=>{
      const context=await authorized(options,request,'loyalty.configuration.preview')
      const domain=domainValue(request.params.domain)
      const result=await service(options,context).preview(domain,request.params.configurationId,context.employeeId)
      return reply.send({data:result})
    }),
  )

  app.post<{Params:{domain:string;configurationId:string}}>(
    '/staff/loyalty/configuration-center/:domain/:configurationId/approve',
    async(request,reply)=>handle(reply,async()=>{
      const context=await authorized(options,request,'loyalty.configuration.approve')
      const domain=domainValue(request.params.domain)
      const body=object(request.body)
      if('impactPreviewAcknowledged' in body)throw invalid('客户端确认不能代替服务端影响预览')
      const result=await service(options,context).approve({domain,publicId:request.params.configurationId,
        expectedRevision:integer(body.expectedRevision,'草稿版本'),approverEmployeeId:context.employeeId,
        impactPreviewPublicId:text(body.impactPreviewPublicId,'影响预览编号',8,128),
        reason:text(body.reason,'审批原因',2,500)})
      return reply.send({data:result})
    }),
  )
}

interface ConfigurationListRow extends Record<string,unknown>{domain:MembershipConfigurationDomain;id:string;status:string;draft_revision:number;version:number;title:string;updated_at:string;effective_from:string|null;effective_until:string|null;approved_by_employee_id:string|null}

function service(options:MembershipConfigurationApiOptions,context:StaffCustomerExperienceContext){
  return new MembershipConfigurationDraftService(
    new PostgresMembershipConfigurationDraftRepository(options.transactions,context.scope),
  )
}
async function authorized(options:MembershipConfigurationApiOptions,request:FastifyRequest,permission:string){
  const context=await options.resolveStaffContext(request)
  await options.transactions.run(context.scope,(transaction)=>(
    options.createStaffAccessRepository?.(transaction)??new StaffAccessRepository(transaction)
  ).assertPermission(context.employeeId,permission),{readOnly:true})
  return context
}
async function handle(reply:FastifyReply,execute:()=>Promise<unknown>){try{return await execute()}catch(error){
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'MEMBERSHIP_PUBLICATION_INVALID',message:'请核对生效时间和发布说明'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'IDEMPOTENCY_IN_PROGRESS',message:'请恢复原发布操作，核对处理结果'}})
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'STAFF_ACCESS_DENIED',message:'没有执行该操作的权限'}})
  if(error instanceof MembershipConfigurationDraftError)return reply.code(409).send({error:{code:error.code,message:error.message}})
  if(error instanceof CustomerExperienceRequestError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  throw error
}}
function domainValue(value:string):MembershipConfigurationDomain{if(!domains.includes(value as MembershipConfigurationDomain))throw invalid('不支持的会员配置域');return value as MembershipConfigurationDomain}
function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw invalid('请求格式不正确');return value as Record<string,unknown>}
function integer(value:unknown,label:string){if(!Number.isSafeInteger(value)||(value as number)<1)throw invalid(`${label}无效`);return value as number}
function text(value:unknown,label:string,min:number,max:number){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw invalid(`${label}无效`);return value.trim()}
function invalid(message:string){return new CustomerExperienceRequestError(message,'INVALID_REQUEST',400)}
