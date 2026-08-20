import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  CustomerPreferenceNotFoundError,
  type CustomerPreferenceSnapshot,
  type PreferencePolarity,
} from './customer-preference-repository.js'
import {
  CustomerPreferenceService,
  type PublicCustomerPreferenceContext,
} from './customer-preference-service.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'

interface CustomerPreferenceApiOptions {
  service: CustomerPreferenceService
  resolvePublicContext(request:FastifyRequest):Promise<PublicCustomerPreferenceContext>|PublicCustomerPreferenceContext
}

const SUPPORTED_KEYS=new Set([
  'beverage.family','taste.note','music.style','service.intensity',
  'seat.preference','dietary.note',
])
const BEVERAGE_FAMILIES=new Set([
  'cocktail','wine','sparkling','beer','spirits','non_alcoholic','mixed','none',
])

export const customerPreferenceApiPlugin:FastifyPluginAsync<CustomerPreferenceApiOptions>=async(app,options)=>{
  app.get('/public/mini/preferences',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolvePublicContext(request)
    return reply.send({data:publicPreferenceSnapshot(await options.service.list(context))})
  }))

  app.post('/public/mini/preferences',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolvePublicContext(request)
    const body=objectBody(request.body)
    rejectIdentityClaims(body)
    const key=preferenceKey(body.key)
    const value=preferenceValue(key,body.value)
    const polarity=enumValue(body.polarity,'偏好方向',['supports','contradicts'] as const) as PreferencePolarity
    const validUntil=optionalFutureTimestamp(body.validUntil)
    const result=await options.service.declare(context,{
      key,value,polarity,validUntil,idempotencyKey:idempotencyKey(request),
    })
    return reply.code(result.replayed?200:201).send({
      data:publicPreferenceSnapshot(result.value),meta:{replayed:result.replayed},
    })
  }))

  app.post<{Params:{publicId:string}}>(
    '/public/mini/preferences/:publicId/withdraw',
    async(request,reply)=>handle(reply,async()=>{
      const context=await options.resolvePublicContext(request)
      const body=objectBody(request.body)
      rejectIdentityClaims(body)
      const result=await options.service.withdraw(context,{
        sourcePublicId:publicId(request.params.publicId),
        reason:text(body.reason??'顾客本人撤回偏好证据','撤回原因',2,240),
        idempotencyKey:idempotencyKey(request),
      })
      return reply.send({
        data:publicPreferenceSnapshot(result.value),meta:{replayed:result.replayed},
      })
    }),
  )
}

function publicPreferenceSnapshot(snapshot:CustomerPreferenceSnapshot){
  return {
    facts:snapshot.facts.map((fact)=>({
      key:fact.key,value:fact.value,status:fact.status,
      supportingEvidenceCount:fact.supportingEvidenceCount,
      contraryEvidenceCount:fact.contraryEvidenceCount,
      lastEvidenceAt:fact.lastEvidenceAt,validUntil:fact.validUntil,
    })),
    sources:snapshot.sources.map((source)=>({
      publicId:source.publicId,sourceKind:source.sourceKind,key:source.key,
      value:source.value,polarity:source.polarity,validUntil:source.validUntil,
      createdAt:source.createdAt,withdrawn:source.withdrawn,
    })),
  }
}

async function handle(reply:FastifyReply,action:()=>Promise<unknown>){
  try{return await action()}catch(error){
    if(error instanceof CustomerPreferenceNotFoundError){
      return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
    }
    if(error instanceof ReservationGuestSessionInvalidError){
      return reply.code(401).send({error:{code:'AUTHENTICATION_REQUIRED',message:'登录状态已失效，请重新进入'}})
    }
    const status=typeof error==='object'&&error!==null&&'statusCode' in error
      &&typeof (error as {statusCode?:unknown}).statusCode==='number'
      ?(error as {statusCode:number}).statusCode:500
    const code=status===401?'AUTHENTICATION_REQUIRED':status===403?'SCOPE_DENIED':'CUSTOMER_PREFERENCE_FAILED'
    return reply.code(status).send({error:{code,message:status>=500?'偏好服务暂时不可用':'当前请求不能处理'}})
  }
}

function objectBody(value:unknown):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value))throw requestError('请求格式不正确')
  return value as Record<string,unknown>
}
function rejectIdentityClaims(body:Record<string,unknown>):void{
  if('customerId' in body||'canonicalCustomerId' in body||'actorRef' in body||'scope' in body){
    throw requestError('顾客身份只能来自已登录会话')
  }
}
function preferenceKey(value:unknown):string{
  if(typeof value!=='string'||!SUPPORTED_KEYS.has(value))throw requestError('偏好类型不受支持')
  return value
}
function preferenceValue(key:string,value:unknown):string{
  const result=text(value,'偏好内容',1,200)
  if(key==='beverage.family'&&!BEVERAGE_FAMILIES.has(result))throw requestError('酒水偏好不受支持')
  if(key==='service.intensity'&&!['quiet','balanced','hosted'].includes(result))throw requestError('服务方式不受支持')
  return result
}
function publicId(value:string):string{return text(value,'偏好证据编号',8,128)}
function text(value:unknown,label:string,min:number,max:number):string{
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw requestError(`${label}不正确`)
  return value.trim()
}
function enumValue<const Values extends readonly string[]>(value:unknown,label:string,values:Values):Values[number]{
  if(typeof value!=='string'||!values.includes(value))throw requestError(`${label}不正确`)
  return value as Values[number]
}
function optionalFutureTimestamp(value:unknown):string|null{
  if(value===undefined||value===null||value==='')return null
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw requestError('有效期不正确')
  const result=new Date(value).toISOString()
  if(Date.parse(result)<=Date.now())throw requestError('有效期必须晚于当前时间')
  return result
}
function idempotencyKey(request:FastifyRequest):string{
  const value=request.headers['idempotency-key']
  if(typeof value!=='string'||value.length<8||value.length>128)throw requestError('缺少有效的幂等编号')
  return value
}
function requestError(message:string){
  return Object.assign(new Error(message),{statusCode:400})
}
