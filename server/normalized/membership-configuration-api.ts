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

export const membershipConfigurationApiPlugin:FastifyPluginAsync<MembershipConfigurationApiOptions>=async(app,options)=>{
  app.get('/staff/loyalty/configuration-center',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'loyalty.configuration.view')
    const rows=await options.transactions.run(context.scope,async(transaction)=>{
      const result=await transaction.query<ConfigurationListRow>(`
        SELECT * FROM (
          SELECT 'base_points'::text domain,id,status,draft_revision,version,
            policy_code AS title,updated_at FROM mbox.loyalty_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'tier_policy',id,status,draft_revision,version,'会员等级',updated_at
            FROM mbox.loyalty_tier_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'tier_benefits',id,status,draft_revision,version,'等级权益',updated_at
            FROM mbox.loyalty_tier_benefit_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'redemption_catalog',id,status,draft_revision,version,'积分兑换',updated_at
            FROM mbox.redemption_catalog_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'promotion_points',id,status,draft_revision,version,name,updated_at
            FROM mbox.loyalty_promotion_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'membership_terms',id,status,draft_revision,version,title,updated_at
            FROM mbox.membership_terms_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          UNION ALL SELECT 'wechat_notifications',id,status,draft_revision,policy_version,notification_type,updated_at
            FROM mbox.wechat_notification_policies WHERE tenant_id=$1::uuid AND store_id=$2::uuid
              AND governance_mode='managed'
        ) configuration ORDER BY updated_at DESC,domain,version DESC,id
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      return result.rows.map((row)=>({domain:row.domain,configurationId:row.id,status:row.status,
        revision:row.draft_revision,version:row.version,title:row.title,updatedAt:row.updated_at}))
    },{readOnly:true})
    return reply.send({data:rows})
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

interface ConfigurationListRow extends Record<string,unknown>{domain:MembershipConfigurationDomain;id:string;status:string;draft_revision:number;version:number;title:string;updated_at:string}

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
