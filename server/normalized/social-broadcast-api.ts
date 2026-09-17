import {z} from 'zod'
import type {FastifyPluginAsync} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonCodec,type JsonObject} from './command-executor.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {SocialBroadcastRepository,broadcastSchema} from './social-broadcast-repository.js'
import {BottleCustodyError} from './bottle-custody-policy.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>v as JsonObject}
export const socialBroadcastApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'BROADCAST_ACCESS_DENIED',message:'没有活动群发权限'}})
  if(error instanceof BottleCustodyError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'BROADCAST_INVALID',message:'请核对标题、内容和发送时间'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'BROADCAST_CONFLICT',message:'请求正在处理或内容已变化，请刷新核对'}})
  throw error
 })
 app.get('/staff/social-broadcasts/accounts',async request=>{const ctx=await options.resolveStaffContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');return(await tx.query("SELECT id,name,enabled FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND kind='service_account' ORDER BY name,id",[ctx.scope.tenantId,ctx.scope.storeId])).rows},{readOnly:true})}})
 app.get<{Querystring:{cursor?:string}}>('/staff/social-broadcasts',async request=>{const ctx=await options.resolveStaffContext(request),cursor=z.string().uuid().optional().parse(request.query.cursor);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');return new SocialBroadcastRepository(tx).list(cursor)},{readOnly:true})}})
 app.post('/staff/social-broadcasts',{bodyLimit:4096},async request=>{
  const ctx=await options.resolveStaffContext(request),input=broadcastSchema.parse(request.body),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'social.broadcast.create',idempotencyKey:key,requestFingerprint:JSON.stringify({input,employee:ctx.employeeId}),resultCodec:codec},async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');const row=await new SocialBroadcastRepository(tx).create(input,ctx.employeeId);return{result:row,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'social.broadcast.drafted',objectType:'social_broadcast',objectId:row.id,afterData:input}],outboxMessages:[]}});return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.post<{Params:{id:string}}>('/staff/social-broadcasts/:id/action',async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id),input=z.object({action:z.enum(['schedule','cancel']),audienceConfirmed:z.boolean()}).strict().parse(request.body)
  if(input.action==='schedule'&&!input.audienceConfirmed)throw new BottleCustodyError('请确认内容和所有关注者发送范围')
  const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'social.broadcast.action',idempotencyKey:key,requestFingerprint:JSON.stringify({id,input,employee:ctx.employeeId}),resultCodec:codec},async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');const row=await new SocialBroadcastRepository(tx).transition(id,input.action);return{result:row,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:`social.broadcast.${input.action}`,objectType:'social_broadcast',objectId:id,afterData:input}],outboxMessages:[]}});return{data:result.value,meta:{replayed:result.replayed}}
 })
}
