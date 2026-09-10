import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject,type JsonCodec} from './command-executor.js'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {MarketingDeliveryRepository} from './marketing-delivery-repository.js'
import {MarketingContactError,marketingChannels,marketingPurposes,type MarketingChannel,type MarketingPurpose} from './marketing-contact-policy.js'
import {StaffAccessDeniedError,StaffAccessRepository} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {ReservationGuestSessionInvalidError} from './reservation-guest-session.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveSelfContext'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid marketing result');return value as JsonObject}}
function body(request:FastifyRequest,keys:string[]){const value=request.body;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new MarketingContactError('提交字段不正确');return value as Record<string,unknown>}
function text(value:unknown){if(typeof value!=='string'||!value.trim())throw new MarketingContactError('必填内容不能为空');return value.trim()}
export const marketingContactApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
  app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ReservationGuestSessionInvalidError||isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
    if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'MARKETING_ACCESS_DENIED',message:'没有此项营销授权管理权限'}})
    if(error instanceof MarketingContactError)return reply.code(400).send({error:{code:'MARKETING_INVALID',message:error.message}})
    if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MARKETING_COMMAND_CONFLICT',message:'操作正在处理或内容已变化，请先刷新核对'}})
    throw error
  })
  async function write(request:FastifyRequest,scope:Parameters<Options['transactions']['run']>[0],operation:string,data:unknown,action:(repo:MarketingContactRepository,key:string,delivery:MarketingDeliveryRepository)=>Promise<unknown>){
    const key=text(request.headers['idempotency-key']);if(!/^[A-Za-z0-9:_-]{8,128}$/.test(key))throw new MarketingContactError('操作编号格式无效')
    const result=await options.commands.execute({scope,operationScope:`marketing.${operation}`,idempotencyKey:key,requestFingerprint:JSON.stringify(data),resultCodec:codec},async tx=>({result:JSON.parse(JSON.stringify(await action(new MarketingContactRepository(tx),key,new MarketingDeliveryRepository(tx)))) as JsonObject,auditEvents:[],outboxMessages:[]}))
    return{data:result.value,meta:{replayed:result.replayed}}
  }
  async function staff(request:FastifyRequest,permission:string){const context=await options.resolveStaffContext(request);await options.transactions.run(context.scope,tx=>new StaffAccessRepository(tx).assertPermission(context.employeeId,permission),{readOnly:true});return context}
  app.get('/public/mini/marketing-preferences',async request=>{const context=await options.resolveSelfContext(request);return{data:await options.transactions.run(context.scope,tx=>new MarketingContactRepository(tx).selfView(context.customerId),{readOnly:true})}})
  app.post('/public/mini/marketing-preferences/choices',{bodyLimit:8192},async request=>{
    const context=await options.resolveSelfContext(request),input=body(request,['noticeId','expectedRevision','choices'])
    if(!Array.isArray(input.choices)||input.choices.length<1||input.choices.length>6)throw new MarketingContactError('请选择本次联系偏好')
    const choices=input.choices.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['channel','purpose','decision'].includes(k)))throw new MarketingContactError('联系偏好字段无效')
      const row=value as Record<string,unknown>
      if(!marketingChannels.includes(row.channel as MarketingChannel)||!marketingPurposes.includes(row.purpose as MarketingPurpose)||!['granted','withdrawn','denied'].includes(String(row.decision)))throw new MarketingContactError('联系偏好决定无效')
      return row as {channel:MarketingChannel;purpose:MarketingPurpose;decision:'granted'|'withdrawn'|'denied'}
    })
    const data={customerId:context.customerId,noticeId:text(input.noticeId),expectedRevision:text(input.expectedRevision),choices,businessDate:context.businessDate}
    return write(request,context.scope,'choices',data,repo=>repo.recordChoices(data))
  })
  app.post('/public/mini/marketing-preferences/stop-all',{bodyLimit:1024},async request=>{
    const context=await options.resolveSelfContext(request);body(request,[])
    const data={customerId:context.customerId,businessDate:context.businessDate};return write(request,context.scope,'stop_all',data,repo=>repo.stopAll(data))
  })
  app.post('/public/mini/marketing-preferences/withdraw-channel',{bodyLimit:1024},async request=>{
    const context=await options.resolveSelfContext(request),input=body(request,['channel'])
    if(!marketingChannels.includes(input.channel as MarketingChannel))throw new MarketingContactError('联系渠道无效')
    const data={customerId:context.customerId,businessDate:context.businessDate,channel:input.channel as MarketingChannel};return write(request,context.scope,'withdraw_channel',data,repo=>repo.withdrawChannel(data))
  })
  app.get<{Querystring:{cursor?:string}}>('/staff/marketing/notices',async request=>{const context=await staff(request,'marketing.notice.view');return{data:await options.transactions.run(context.scope,tx=>new MarketingContactRepository(tx).list(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{purpose?:string;search?:string;cursor?:string}}>('/staff/marketing/customers',async request=>{
    const purpose=request.query.purpose
    if(purpose!=='send'&&purpose!=='refusal'&&purpose!=='audit')throw new MarketingContactError('客户查找用途无效')
    const permission=purpose==='send'?'marketing.send':purpose==='refusal'?'marketing.refusal.record':'marketing.consent.audit'
    const context=await staff(request,permission)
    return{data:await options.transactions.run(context.scope,tx=>new MarketingContactRepository(tx).customers(context.employeeId,permission,request.query.search??'',request.query.cursor??null),{readOnly:true})}
  })
  app.post('/staff/marketing/notices',{bodyLimit:16384},async request=>{
    const context=await staff(request,'marketing.notice.edit'),input=body(request,['code','rule','reason','expectedVersion'])
    if(!Number.isSafeInteger(input.expectedVersion))throw new MarketingContactError('告知版本无效')
    const data={code:text(input.code),rule:input.rule,reason:text(input.reason),expectedVersion:input.expectedVersion as number,employeeId:context.employeeId,businessDate:context.businessDate}
    return write(request,context.scope,'notice_save',data,(repo,key)=>repo.save({...data,requestKey:key}))
  })
  app.post<{Params:{id:string}}>('/staff/marketing/notices/:id/decision',{bodyLimit:4096},async request=>{
    const input=body(request,['action','reason']);if(input.action!=='approve'&&input.action!=='publish'&&input.action!=='stop')throw new MarketingContactError('告知操作无效')
    const context=await staff(request,input.action==='approve'?'marketing.notice.approve':'marketing.notice.publish')
    const data={noticeId:request.params.id,action:input.action,reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate} as const
    return write(request,context.scope,'notice_decision',data,repo=>repo.decide(data))
  })
  app.post('/staff/marketing/refusals',{bodyLimit:4096},async request=>{
    const context=await staff(request,'marketing.refusal.record'),input=body(request,['customerId','reason'])
    const data={customerId:text(input.customerId),reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate};return write(request,context.scope,'refusal',data,repo=>repo.stopAll(data))
  })
  app.post('/staff/marketing/consent-history/query',{bodyLimit:4096},async request=>{
    const context=await staff(request,'marketing.consent.audit'),input=body(request,['customerId','reason','cursor'])
    return{data:await options.transactions.run(context.scope,tx=>new MarketingContactRepository(tx).consentHistory({employeeId:context.employeeId,customerId:text(input.customerId),businessDate:context.businessDate,reason:text(input.reason),cursor:input.cursor as string|null|undefined}))}
  })
  app.get<{Querystring:{cursor?:string}}>('/staff/marketing/jobs',async request=>{const context=await staff(request,'marketing.send');return{data:await options.transactions.run(context.scope,tx=>new MarketingDeliveryRepository(tx).list(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.post('/staff/marketing/jobs',{bodyLimit:8192},async request=>{
    const context=await staff(request,'marketing.send'),input=body(request,['customerId','noticeId','channel','purpose','campaignKey','content','expiresAt'])
    if(!marketingChannels.includes(input.channel as MarketingChannel)||!marketingPurposes.includes(input.purpose as MarketingPurpose))throw new MarketingContactError('任务渠道或用途无效')
    const data={customerId:text(input.customerId),noticeId:text(input.noticeId),channel:input.channel as MarketingChannel,purpose:input.purpose as MarketingPurpose,campaignKey:text(input.campaignKey),content:text(input.content),expiresAt:text(input.expiresAt),employeeId:context.employeeId,businessDate:context.businessDate}
    return write(request,context.scope,'task_queue',data,(_repo,_key,delivery)=>delivery.queue(data))
  })
  app.post<{Params:{id:string}}>('/staff/marketing/jobs/:id/cancel',{bodyLimit:4096},async request=>{
    const context=await staff(request,'marketing.send'),input=body(request,['reason']),data={jobId:request.params.id,reason:text(input.reason),employeeId:context.employeeId,businessDate:context.businessDate}
    return write(request,context.scope,'task_cancel',data,(_repo,_key,delivery)=>delivery.cancel(data.jobId,data.employeeId,data.businessDate,data.reason))
  })
}
