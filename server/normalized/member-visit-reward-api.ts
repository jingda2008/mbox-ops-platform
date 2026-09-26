import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import { type NormalizedCommandExecutor, type JsonCodec, type JsonValue, IdempotencyConflictError, IdempotencyInProgressError } from './command-executor.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { MemberVisitRewardRepository, MemberVisitRewardError } from './member-visit-reward-repository.js'
import { MemberGiftCampaignError } from './member-gift-campaign-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

type Options = Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'> & {commands:Pick<NormalizedCommandExecutor,'execute'>}
const reason=z.string().trim().min(2).max(300)
const body=z.discriminatedUnion('action',[
  z.object({action:z.literal('configure'),campaignVersionId:z.uuid(),requiredVisits:z.number().int().min(1).max(365),reason}).strict(),
  z.object({action:z.literal('stop'),id:z.uuid(),reason}).strict(),
  z.object({action:z.enum(['approve','reject']),ids:z.array(z.uuid()).min(1).max(50).refine(ids=>new Set(ids).size===ids.length),reason}).strict(),
])
const codec:JsonCodec<JsonValue>={encode:value=>value,decode:value=>value as JsonValue}
export const memberVisitRewardApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
  app.addHook('onRequest',async(_request,reply)=>{reply.header('cache-control','private, no-store')})
  app.setErrorHandler((error,_request,reply)=>{
    if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
    if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'VISIT_REWARD_FORBIDDEN',message:'需要管理人员的活动审批及发放权限'}})
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'VISIT_REWARD_INVALID',message:'请核对次数、活动、审批记录及原因'}})
    if(error instanceof MemberVisitRewardError||error instanceof MemberGiftCampaignError)return reply.code(409).send({error:{code:'VISIT_REWARD_CONFLICT',message:error.message}})
    if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'VISIT_REWARD_RETRY',message:'原操作正在处理或内容已变化，请重新读取核对'}})
    throw error
  })
  app.get('/staff/member-visit-rewards',async request=>{
    const context=await options.resolveStaffContext(request)
    const query=z.object({date:z.iso.date().optional(),status:z.enum(['pending','issued','rejected','invalid','all']).default('pending'),cursor:z.uuid().optional()}).strict().parse(request.query)
    return{data:await options.transactions.run(context.scope,async tx=>{
      await new StaffAccessRepository(tx).assertPermission(context.employeeId,'loyalty.configuration.view')
      const repo=new MemberVisitRewardRepository(tx)
      return {businessDate:context.businessDate,rules:await repo.rules(),...await repo.list(query.date??null,query.status,query.cursor??null)}
    },{readOnly:true})}
  })
  app.post('/staff/member-visit-rewards',{bodyLimit:8192},async request=>{
    const context=await options.resolveStaffContext(request),input=body.parse(request.body)
    const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
    const authorize=async(tx:ScopedTransaction)=>{
      await new StaffAccessRepository(tx).assertPermission(context.employeeId,'loyalty.policy.publish')
      if(input.action!=='stop')await new StaffAccessRepository(tx).assertPermission(context.employeeId,input.action==='configure'?'loyalty.configuration.edit':'loyalty.configuration.approve')
    }
    await options.transactions.run(context.scope,authorize,{readOnly:true})
    const result=await options.commands.execute({scope:context.scope,operationScope:'member.visit.reward',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,...input}),resultCodec:codec},async tx=>{
      await authorize(tx)
      const repo=new MemberVisitRewardRepository(tx)
      const result=input.action==='configure'?await repo.create({...input,employeeId:context.employeeId,businessDate:context.businessDate})
        :input.action==='stop'?await repo.stop(input.id,context.employeeId,context.businessDate,input.reason)
        :await repo.decide(input.ids,input.action,context.employeeId,context.businessDate,input.reason)
      return{result:result as JsonValue,auditEvents:[],outboxMessages:[]}
    })
    return{data:result.value,meta:{replayed:result.replayed}}
  })
}
