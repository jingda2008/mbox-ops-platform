import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import type { PublicCustomerExperienceContext } from './customer-experience-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import {
  WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES,
  WechatMemberServiceAuthorizationError,
  WechatMemberServiceNotificationRepository,
  type WechatMemberServiceNotificationType,
} from './wechat-member-service-notification-repository.js'

interface Options {
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  commands: Pick<NormalizedCommandExecutor,'execute'>
  channelConfigured: boolean
  resolvePublicContext(request: FastifyRequest): Promise<PublicCustomerExperienceContext> | PublicCustomerExperienceContext
}
interface Result { id:string;notificationType:WechatMemberServiceNotificationType;decision:'granted'|'denied'|'revoked';authorizationVersion:number;changedAt:string }

export const wechatMemberServiceNotificationApiPlugin: FastifyPluginAsync<Options> = async (app,options) => {
  app.get('/public/mini/wechat-member-service-notification-authorizations',async(request,reply)=>{
    const context=await options.resolvePublicContext(request)
    const authorizations=await options.transactions.run(context.scope,(transaction)=>(
      new WechatMemberServiceNotificationRepository(transaction).authorizationOptions(context.customerId,options.channelConfigured)
    ),{readOnly:true})
    return reply.send({data:{available:options.channelConfigured&&authorizations.length>0,authorizations}})
  })
  app.post('/public/mini/wechat-member-service-notification-authorizations',async(request,reply)=>{
    if(!options.channelConfigured)return reply.status(503).send({
      error:{code:'WECHAT_MEMBER_SERVICE_NOTIFICATION_NOT_CONFIGURED',message:'正式微信订阅消息配置尚未完整启用'},
    })
    try {
      const context=await options.resolvePublicContext(request)
      const body=object(request.body)
      const input={
        notificationType: enumValue(body.notificationType,WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES,'通知类型'),
        policyId: uuid(body.policyId,'通知政策'),policyVersion: integer(body.policyVersion,'政策版本',1),
        templateId: text(body.templateId,'微信模板',8,128),expectedVersion:integer(body.expectedVersion,'授权版本',0),
        platformResult:enumValue(body.platformResult,['accept','reject','ban','revoke'] as const,'微信授权结果'),
        platformEventReference:text(body.platformEventReference,'授权请求编号',8,200),
      }
      const headerValue=request.headers['idempotency-key']
      const idempotencyKey=text(Array.isArray(headerValue)?headerValue[0]:headerValue,'幂等键',8,160)
      const execution=await options.commands.execute({
        scope:context.scope,operationScope:'customer.wechat-member-service-notification-authorization.record',
        idempotencyKey,requestFingerprint:fingerprint({...input,customerId:context.customerId}),resultCodec,
      },async(transaction)=>{
        const authorization=await new WechatMemberServiceNotificationRepository(transaction).recordAuthorization({customerId:context.customerId,...input})
        const result:Result={id:authorization.id,notificationType:authorization.notificationType,
          decision:authorization.decision!,authorizationVersion:authorization.authorizationVersion,changedAt:authorization.changedAt!}
        return {result,auditEvents:[{
          actor:{type:'guest',ref:context.actorRef},action:'customer.wechat-member-service-notification-authorization.recorded',
          objectType:'wechat_member_service_notification_authorization',objectId:authorization.id,businessDate:context.businessDate,
          metadata:{notificationType:authorization.notificationType,purpose:authorization.purpose,
            authorizationContext:authorization.authorizationContext,policyVersion:authorization.policyVersion,decision:authorization.decision},
        }],outboxMessages:[]}
      })
      return reply.code(execution.replayed?200:201).send({data:execution.value,meta:{replayed:execution.replayed}})
    } catch(error) {
      if(error instanceof WechatMemberServiceAuthorizationError){
        const status=error.code==='WECHAT_MEMBER_SERVICE_NOTIFICATION_MEMBERSHIP_REQUIRED'?409
          :error.code==='WECHAT_MEMBER_SERVICE_NOTIFICATION_IDENTITY_REQUIRED'?403:409
        return reply.status(status).send({error:{code:error.code,message:error.message}})
      }
      if(error instanceof TypeError){
        return reply.status(400).send({
          error:{code:'WECHAT_MEMBER_SERVICE_NOTIFICATION_INPUT_INVALID',message:error.message},
        })
      }
      const message=postgresMessage(error)
      if(message.includes('identity does not belong')){
        return reply.status(403).send({
          error:{
            code:'WECHAT_MEMBER_SERVICE_NOTIFICATION_IDENTITY_REQUIRED',
            message:'当前顾客没有可验证的本人微信身份',
          },
        })
      }
      throw error
    }
  })
}

function postgresMessage(error: unknown): string {
  if(typeof error!=='object'||error===null) return ''
  const row=error as { message?: unknown; detail?: unknown }
  return `${String(row.message||'')} ${String(row.detail||'')}`.trim()
}

const resultCodec:JsonCodec<Result>={
  encode:(value)=>({...value}),decode:(value)=>{const row=object(value);return {
    id:uuid(row.id,'授权'),notificationType:enumValue(row.notificationType,WECHAT_MEMBER_SERVICE_NOTIFICATION_TYPES,'通知类型'),
    decision:enumValue(row.decision,['granted','denied','revoked'] as const,'授权决定'),
    authorizationVersion:integer(row.authorizationVersion,'授权版本',1),changedAt:timestamp(row.changedAt,'授权时间'),
  }},
}
function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw new TypeError('请求内容格式不正确');return value as Record<string,unknown>}
function text(value:unknown,label:string,min:number,max:number):string{if(typeof value!=='string')throw new TypeError(`${label}格式不正确`);const normalized=value.trim();if(normalized.length<min||normalized.length>max)throw new TypeError(`${label}格式不正确`);return normalized}
function uuid(value:unknown,label:string):string{const normalized=text(value,label,36,36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized))throw new TypeError(`${label}格式不正确`);return normalized}
function integer(value:unknown,label:string,min:number):number{if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>2_000_000_000)throw new TypeError(`${label}格式不正确`);return value as number}
function enumValue<const Value extends string>(value:unknown,values:readonly Value[],label:string):Value{if(typeof value!=='string'||!values.includes(value as Value))throw new TypeError(`${label}格式不正确`);return value as Value}
function timestamp(value:unknown,label:string):string{const normalized=text(value,label,20,40);if(!Number.isFinite(Date.parse(normalized)))throw new TypeError(`${label}格式不正确`);return normalized}
function fingerprint(value:JsonObject):string{return createHash('sha256').update(stableJson(value)).digest('hex')}
function stableJson(value:unknown):string{if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;if(typeof value==='object'&&value!==null){const row=value as Record<string,unknown>;return `{${Object.keys(row).toSorted().map((key)=>`${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`}return JSON.stringify(value)??'null'}
