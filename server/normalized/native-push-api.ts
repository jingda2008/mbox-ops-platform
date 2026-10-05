import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { IdempotencyConflictError, IdempotencyInProgressError, NativeCommandNotCommittedError } from './command-executor.js'
import { NativePushError, type NativePushActor, type NativePushRegistration } from './native-push-contracts.js'
import { canonicalRevocationSecret } from './native-push-protection.js'
import { NativePushRepository } from './native-push-repository.js'
import type { StoreScope } from './transaction-runner.js'

export interface NativePushApiOptions {
  repository: NativePushRepository
  /** Fixed deployment scope, never derived from anonymous body or headers. */
  scope: StoreScope
  resolveContext: (request: FastifyRequest) => Promise<NativePushActor>
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
function invalid(): never {throw new NativePushError('PUSH_INVALID_REQUEST',400)}
function id(value:unknown) {if(typeof value!=='string'||!uuid.test(value))return invalid();return value}
function integer(value:unknown,min:number) {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)return invalid();return value}
function object(value:unknown,keys:readonly string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid()
  const result=value as Record<string,unknown>
  if(Object.keys(result).length!==keys.length||keys.some(k=>!Object.hasOwn(result,k)))return invalid()
  return result
}
function secret(value:unknown) {if(typeof value!=='string'||!canonicalRevocationSecret(value))return invalid();return value}
function key(request:FastifyRequest) {const value=request.headers['idempotency-key'];if(typeof value!=='string'||!value.startsWith('native-push-')||!uuid.test(value.slice(12)))return invalid();return value}
function registration(value:unknown):NativePushRegistration {
  const body=object(value,['expectedRevision','platform','provider','token','permission','appVersion','revocationSecret'])
  if(body.platform!=='ios'||body.provider!=='apns')throw new NativePushError('PUSH_PROVIDER_UNSUPPORTED',400,true)
  if(typeof body.token!=='string'||!/^(?:[a-fA-F0-9]{2}){16,256}$/.test(body.token)
    || !['authorized','provisional'].includes(body.permission as string) || typeof body.appVersion!=='string'||body.appVersion.trim().length===0||body.appVersion.length>64)return invalid()
  return {expectedRevision:integer(body.expectedRevision,0),platform:'ios',provider:'apns',token:body.token.toLowerCase(),permission:body.permission as NativePushRegistration['permission'],appVersion:body.appVersion,revocationSecret:secret(body.revocationSecret)}
}
async function respond(reply:FastifyReply,work:()=>Promise<unknown>,capability=false) {
  reply.header('cache-control','private, no-store')
  try{return await work()}catch(caught){
    const error=caught instanceof NativeCommandNotCommittedError?caught.original:caught
    if(error instanceof NativePushError){
      if(error.statusCode===429)reply.header('retry-after','60')
      return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,...(error.notCommitted?{commitDisposition:'not_committed'}:{})}})
    }
    if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:error instanceof IdempotencyConflictError?'PUSH_RECEIPT_CONFLICT':'PUSH_REQUEST_IN_PROGRESS',message:'请保留原通知请求后重试核对'}})
    if(error instanceof Error && ['NormalizedAuthenticationRequiredError','StaffSessionNotFoundError','DeviceAccessDeniedError','StaffSessionBindingError'].includes(error.name))return reply.code(401).send({error:{code:'AUTH_REQUIRED',message:'请重新登录后核对通知设置'}})
    if(error instanceof Error && ['StaffAccessDeniedError','StaffNotFoundError'].includes(error.name))return reply.code(403).send({error:{code:'PUSH_FORBIDDEN',message:'当前员工无通知访问权限'}})
    // A unique token race is known rolled back only when the command executor confirms it.
    if(caught instanceof NativeCommandNotCommittedError && typeof error==='object'&&error!==null&&'constraint' in error && error.constraint==='native_push_active_token_uq')return reply.code(409).send({error:{code:'PUSH_TOKEN_CONFLICT',message:'通知设备绑定已变化，请重新读取',commitDisposition:'not_committed'}})
    reply.request.log.error({errorCode:capability?'PUSH_REVOKE_UNCONFIRMED':'PUSH_REQUEST_UNCONFIRMED'},'native push request failed')
    return reply.code(capability?503:500).send({error:{code:capability?'PUSH_REVOKE_UNCONFIRMED':'PUSH_REQUEST_UNCONFIRMED',message:'通知请求结果尚未确认，请保留原请求后重试'}})
  }
}
export const nativePushApiPlugin:FastifyPluginAsync<NativePushApiOptions>=async(app,options)=>{
  const context=async(request:FastifyRequest)=>{
    const employee=request.headers['x-mbox-staff-employee-id'],session=request.headers['x-mbox-staff-session-id']
    if(typeof employee!=='string'||typeof session!=='string'||!uuid.test(employee)||!uuid.test(session))throw new NativePushError('AUTH_REQUIRED',401)
    const actor=await options.resolveContext(request)
    if(employee!==actor.employeeId||session!==actor.staffSessionId)throw new NativePushError('AUTH_REQUIRED',401)
    return actor
  }
  app.get('/capabilities',async(request,reply)=>respond(reply,async()=>reply.send({data:await options.repository.capabilities(await context(request))})))
  app.get<{Params:{installationId:string}}>('/installations/:installationId',async(request,reply)=>respond(reply,async()=>reply.send({data:await options.repository.get(await context(request),id(request.params.installationId))})))
  app.put<{Params:{installationId:string}}>('/installations/:installationId',{bodyLimit:2048},async(request,reply)=>respond(reply,async()=>{
    const actor=await context(request),body=registration(request.body),requestKey=key(request),installationId=id(request.params.installationId)
    const result=await options.repository.put(actor,installationId,requestKey,body)
    return reply.code(!result.replayed&&result.value.installation.revision===1?201:200).send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{installationId:string}}>('/installations/:installationId/revoke',{bodyLimit:256},async(request,reply)=>respond(reply,async()=>{
    const actor=await context(request),body=object(request.body,['expectedRevision'])
    const result=await options.repository.revoke(actor,id(request.params.installationId),key(request),integer(body.expectedRevision,1))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{installationId:string}}>('/installations/:installationId/revoke-capability',{bodyLimit:256},async(request,reply)=>respond(reply,async()=>{
    const body=object(request.body,['revision','revocationSecret'])
    const data=await options.repository.revokeCapability(options.scope,id(request.params.installationId),integer(body.revision,1),secret(body.revocationSecret),request.ip)
    return reply.send({data})
  },true))
  app.get<{Params:{deliveryId:string}}>('/deliveries/:deliveryId/target',async(request,reply)=>respond(reply,async()=>reply.send({data:await options.repository.getTarget(await context(request),id(request.params.deliveryId))})))
  app.post<{Params:{deliveryId:string}}>('/deliveries/:deliveryId/observations',{bodyLimit:128},async(request,reply)=>respond(reply,async()=>{
    const actor=await context(request),body=object(request.body,['kind'])
    if(body.kind!=='received'&&body.kind!=='opened')return invalid()
    const result=await options.repository.observe(actor,id(request.params.deliveryId),key(request),body.kind)
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
}
