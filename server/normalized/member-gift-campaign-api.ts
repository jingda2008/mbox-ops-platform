import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {NormalizedCommandExecutor,JsonObject,JsonCodec} from './command-executor.js'
import {IdempotencyConflictError,IdempotencyInProgressError} from './command-executor.js'
import {MemberGiftCampaignRepository} from './member-gift-campaign-repository.js'
import {MemberGiftCampaignError} from './member-gift-campaign-policy.js'
import {MemberCardPolicyError} from './member-card-policy.js'
import {CouponCalendarError} from './coupon-calendar.js'
import {StaffAccessDeniedError,StaffAccessRepository} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {ReservationGuestSessionInvalidError} from './reservation-guest-session.js'
import {CheckoutCouponRefundReviewRepository} from './checkout-coupon-refund-review-repository.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveSelfContext'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid gift result');return value as JsonObject}}
function body(request:FastifyRequest,keys:string[]){const value=request.body;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new MemberGiftCampaignError('提交字段不正确');return value as Record<string,unknown>}
function text(value:unknown){if(typeof value!=='string'||!value.trim())throw new MemberGiftCampaignError('必填内容不能为空');return value.trim()}
export const memberGiftCampaignApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
  app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ReservationGuestSessionInvalidError||isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
    if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'GIFT_ACCESS_DENIED',message:'没有此项发券权限'}})
    if(error instanceof MemberGiftCampaignError||error instanceof MemberCardPolicyError||error instanceof CouponCalendarError)return reply.code(400).send({error:{code:'GIFT_INVALID',message:error.message}})
    if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'GIFT_COMMAND_CONFLICT',message:'操作正在处理或内容已变化，请刷新核对'}})
    throw error
  })
  async function staff(request:FastifyRequest,permission:string){const context=await options.resolveStaffContext(request);await options.transactions.run(context.scope,tx=>new StaffAccessRepository(tx).assertPermission(context.employeeId,permission),{readOnly:true});return context}
  async function write(request:FastifyRequest,context:Awaited<ReturnType<Options['resolveStaffContext']>>,operation:string,data:unknown,action:(repo:MemberGiftCampaignRepository,key:string)=>Promise<unknown>){
    const key=text(request.headers['idempotency-key']);if(!/^[A-Za-z0-9:_-]{8,128}$/.test(key))throw new MemberGiftCampaignError('操作编号格式无效')
    const result=await options.commands.execute({scope:context.scope,operationScope:`member.gift.${operation}`,idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,data}),resultCodec:codec},async tx=>({result:JSON.parse(JSON.stringify(await action(new MemberGiftCampaignRepository(tx),key))) as JsonObject,auditEvents:[],outboxMessages:[]}))
    return{data:result.value,meta:{replayed:result.replayed}}
  }
  app.get<{Querystring:{cursor?:string}}>('/public/mini/member-gift-jobs',async request=>{const context=await options.resolveSelfContext(request);return{data:await options.transactions.run(context.scope,tx=>new MemberGiftCampaignRepository(tx).selfJobs(context.customerId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{cursor?:string}}>('/staff/member-gifts/campaigns',async request=>{const context=await staff(request,'loyalty.configuration.view');return{data:await options.transactions.run(context.scope,tx=>new MemberGiftCampaignRepository(tx).list(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{cursor?:string}}>('/staff/member-gifts/jobs',async request=>{const context=await staff(request,'loyalty.configuration.view');return{data:await options.transactions.run(context.scope,tx=>new MemberGiftCampaignRepository(tx).jobs(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{cursor?:string;state?:'pending'|'resolved'}}>('/staff/member-gifts/refund-reviews',async request=>{
    const context=await staff(request,'loyalty.configuration.view')
    return{data:await options.transactions.run(context.scope,tx=>new CheckoutCouponRefundReviewRepository(tx).list(context.employeeId,request.query.state??'pending',request.query.cursor??null),{readOnly:true})}
  })
  app.post('/staff/member-gifts/refund-reviews',{bodyLimit:4096},async request=>{
    const context=await staff(request,'loyalty.policy.publish'),input=body(request,['refundId','reservationId','action','reason','evidenceReference','replacementBenefitId'])
    if(input.action!=='no_return'&&input.action!=='external_compensation'&&input.action!=='replacement_coupon')throw new MemberGiftCampaignError('权益处理方式无效')
    const data={refundId:text(input.refundId),reservationId:text(input.reservationId),action:input.action,reason:text(input.reason),evidenceReference:text(input.evidenceReference),employeeId:context.employeeId,businessDate:context.businessDate,...(input.replacementBenefitId!==undefined?{replacementBenefitId:text(input.replacementBenefitId)}:{})} as const
    const key=text(request.headers['idempotency-key']);if(!/^[A-Za-z0-9:_-]{8,128}$/.test(key))throw new MemberGiftCampaignError('操作编号格式无效')
    const result=await options.commands.execute({scope:context.scope,operationScope:'member.gift.refund-review',idempotencyKey:key,requestFingerprint:JSON.stringify(data),resultCodec:codec},async tx=>({result:await new CheckoutCouponRefundReviewRepository(tx).decide(data),auditEvents:[],outboxMessages:[]}))
    return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.get<{Querystring:{refundId:string;reservationId:string;cursor?:string}}>('/staff/member-gifts/refund-replacement-options',async request=>{
    const context=await staff(request,'loyalty.policy.publish')
    return{data:await options.transactions.run(context.scope,tx=>new CheckoutCouponRefundReviewRepository(tx).replacementOptions(context.employeeId,request.query.refundId??'',request.query.reservationId??'',request.query.cursor??null),{readOnly:true})}
  })
  app.get<{Querystring:{kind:string;search?:string;cursor?:string}}>('/staff/member-gifts/options',async request=>{const context=await staff(request,'loyalty.configuration.view');return{data:await options.transactions.run(context.scope,tx=>new MemberGiftCampaignRepository(tx).options(context.employeeId,request.query.kind,request.query.search??'',request.query.cursor??null),{readOnly:true})}})
  app.post('/staff/member-gifts/campaigns',{bodyLimit:32768},async request=>{
    const context=await staff(request,'loyalty.configuration.edit'),input=body(request,['code','name','rule','reason'])
    const data={code:text(input.code),name:text(input.name),rule:input.rule,reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate}
    return write(request,context,'create',data,(repo,key)=>repo.create({...data,requestKey:key}))
  })
  app.post<{Params:{id:string}}>('/staff/member-gifts/campaigns/:id/decision',{bodyLimit:4096},async request=>{
    const input=body(request,['action','reason']);if(input.action!=='approve'&&input.action!=='publish'&&input.action!=='stop')throw new MemberGiftCampaignError('活动操作无效')
    const context=await staff(request,input.action==='approve'?'loyalty.configuration.approve':'loyalty.policy.publish')
    const data={versionId:request.params.id,action:input.action,reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate} as const
    return write(request,context,'decision',data,repo=>repo.decide(data))
  })
  app.post<{Params:{id:string}}>('/staff/member-gifts/campaigns/:id/target',{bodyLimit:16384},async request=>{
    const context=await staff(request,'loyalty.policy.publish'),input=body(request,['customerIds','cycleKey','reason'])
    if(!Array.isArray(input.customerIds)||input.customerIds.some(value=>typeof value!=='string'))throw new MemberGiftCampaignError('客户列表无效')
    const data={versionId:request.params.id,customerIds:input.customerIds as string[],cycleKey:text(input.cycleKey),reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate}
    return write(request,context,'target',data,repo=>repo.target(data))
  })
  app.post<{Params:{id:string}}>('/staff/member-gifts/jobs/:id/control',{bodyLimit:4096},async request=>{
    const context=await staff(request,'loyalty.policy.publish'),input=body(request,['action','reason']);if(input.action!=='retry'&&input.action!=='cancel')throw new MemberGiftCampaignError('任务操作无效')
    const data={jobId:request.params.id,action:input.action,reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate} as const
    return write(request,context,'control',data,repo=>repo.controlJob(data))
  })
}
