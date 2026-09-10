import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import type { NormalizedCommandExecutor, JsonObject, JsonCodec } from './command-executor.js'
import { MemberCardRepository } from './member-card-repository.js'
import { MemberCardPolicyError } from './member-card-policy.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import { IdempotencyConflictError, IdempotencyInProgressError } from './command-executor.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveSelfContext'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid card command result');return value as JsonObject}}
function body(request:FastifyRequest,keys:string[]){const value=request.body;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new MemberCardPolicyError('提交字段不正确');return value as Record<string,unknown>}
function string(value:unknown,label:string){if(typeof value!=='string'||!value.trim())throw new MemberCardPolicyError(`${label}不能为空`);return value.trim()}
function json(value:unknown):JsonObject{return JSON.parse(JSON.stringify(value)) as JsonObject}
export const memberCardApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
  app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ReservationGuestSessionInvalidError||isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
    if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'CARD_ACCESS_DENIED',message:'没有此项会员卡操作权限'}})
    if(error instanceof MemberCardPolicyError)return reply.code(400).send({error:{code:'MEMBER_CARD_INVALID',message:error.message}})
    if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MEMBER_CARD_COMMAND_CONFLICT',message:'操作正在处理或内容已变化，请先刷新核对'}})
    throw error
  })
  async function write(request:FastifyRequest,scope:Parameters<Options['transactions']['run']>[0],operation:string,fingerprint:unknown,action:(repository:MemberCardRepository)=>Promise<unknown>){
    const key=string(request.headers['idempotency-key'],'操作编号')
    if(!/^[A-Za-z0-9:_-]{8,128}$/.test(key))throw new MemberCardPolicyError('操作编号格式不正确')
    return options.commands.execute({scope,operationScope:`member.card.${operation}`,idempotencyKey:key,requestFingerprint:JSON.stringify(fingerprint),resultCodec:codec},async transaction=>({result:json(await action(new MemberCardRepository(transaction))),auditEvents:[],outboxMessages:[]}))
  }
  async function staff(request:FastifyRequest,permission:string){const context=await options.resolveStaffContext(request);await options.transactions.run(context.scope,tx=>new StaffAccessRepository(tx).assertPermission(context.employeeId,permission),{readOnly:true});return context}
  app.get<{Querystring:Partial<Record<'projects'|'cards'|'applications',string>>}>('/public/mini/member-cards',async request=>{
    const context=await options.resolveSelfContext(request),cursors:Partial<Record<'projects'|'cards'|'applications',string>>={}
    for(const key of ['projects','cards','applications'] as const)if(request.query[key]!==undefined)cursors[key]=request.query[key]
    return{data:await options.transactions.run(context.scope,tx=>new MemberCardRepository(tx).selfView(context.customerId,cursors),{readOnly:true})}
  })
  app.post('/public/mini/member-cards/applications',{bodyLimit:4096},async request=>{
    const context=await options.resolveSelfContext(request),input=body(request,['projectId','acceptedProjectVersion'])
    const projectId=string(input.projectId,'卡项目'),acceptedProjectVersion=input.acceptedProjectVersion
    if(!Number.isSafeInteger(acceptedProjectVersion))throw new MemberCardPolicyError('请先阅读当前卡项目说明')
    const result=await write(request,context.scope,'apply',{customerId:context.customerId,...input},repo=>repo.apply({projectId,acceptedProjectVersion:acceptedProjectVersion as number,customerId:context.customerId,businessDate:context.businessDate}))
    return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.post<{Params:{id:string}}>('/public/mini/member-cards/applications/:id/withdraw',{bodyLimit:4096},async request=>{
    const context=await options.resolveSelfContext(request);body(request,[])
    const result=await write(request,context.scope,'withdraw_application',{customerId:context.customerId,applicationId:request.params.id},repo=>repo.withdrawApplication({applicationId:request.params.id,customerId:context.customerId,businessDate:context.businessDate}))
    return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.post<{Params:{id:string}}>('/public/mini/member-cards/:id/withdraw',{bodyLimit:4096},async request=>{
    const context=await options.resolveSelfContext(request);body(request,[])
    const result=await write(request,context.scope,'withdraw_card',{customerId:context.customerId,cardId:request.params.id},repo=>repo.changeCard({cardId:request.params.id,action:'withdraw',customerId:context.customerId,businessDate:context.businessDate,reason:'客户自主退出兴趣卡'}))
    return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.get<{Querystring:{cursor?:string}}>('/staff/member-cards/applications',async request=>{const context=await options.resolveStaffContext(request);return{data:await options.transactions.run(context.scope,tx=>new MemberCardRepository(tx).reviewQueue(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{cursor?:string}}>('/staff/member-cards/projects',async request=>{const context=await options.resolveStaffContext(request);return{data:await options.transactions.run(context.scope,tx=>new MemberCardRepository(tx).projects(context.employeeId,request.query.cursor??null),{readOnly:true})}})
  app.get<{Querystring:{cursor?:string}}>('/staff/member-cards/holdings',async request=>{
    const context=await options.resolveStaffContext(request)
    return{data:await options.transactions.run(context.scope,tx=>new MemberCardRepository(tx).holdings(context.employeeId,request.query.cursor??null),{readOnly:true})}
  })
  app.post<{Params:{id:string}}>('/staff/member-cards/holdings/:id/state',{bodyLimit:4096},async request=>{
    const context=await staff(request,'member.card.manage'),input=body(request,['action','reason'])
    if(input.action!=='suspend'&&input.action!=='resume'&&input.action!=='revoke')throw new MemberCardPolicyError('持卡操作不正确')
    const data={cardId:request.params.id,action:input.action,reason:string(input.reason,'原因'),employeeId:context.employeeId,businessDate:context.businessDate} as const
    const result=await write(request,context.scope,'card_state',data,repo=>repo.changeCard(data))
    return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.post<{Params:{id:string}}>('/staff/member-cards/applications/:id/review',{bodyLimit:4096},async request=>{
    const context=await staff(request,'member.card.review'),input=body(request,['decision','reason'])
    if(input.decision!=='approve'&&input.decision!=='reject')throw new MemberCardPolicyError('请选择通过或拒绝')
    const data={applicationId:request.params.id,decision:input.decision,reason:string(input.reason,'审核原因'),employeeId:context.employeeId,businessDate:context.businessDate} as const
    const result=await write(request,context.scope,'review',data,repo=>repo.review(data));return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.post('/staff/member-cards/projects',{bodyLimit:16384},async request=>{
    const context=await staff(request,'member.card.manage'),input=body(request,['code','name','terms','kind','availableFrom','availableUntil','cooperationConfirmed','cooperationValidUntil','cooperationReference'])
    if(input.kind!=='interest'&&input.kind!=='cobrand')throw new MemberCardPolicyError('卡类型不正确')
    if(typeof input.cooperationConfirmed!=='boolean')throw new MemberCardPolicyError('须明确记录合作确认状态')
    const data={code:string(input.code,'编号'),name:string(input.name,'名称'),terms:string(input.terms,'说明'),kind:input.kind,availableFrom:string(input.availableFrom,'开始时间'),availableUntil:string(input.availableUntil,'结束时间'),cooperationConfirmed:input.cooperationConfirmed,
      cooperationValidUntil:input.cooperationValidUntil===null?null:string(input.cooperationValidUntil,'合作到期时间'),cooperationReference:input.cooperationReference===null?null:string(input.cooperationReference,'合作依据'),employeeId:context.employeeId,businessDate:context.businessDate} as const
    const result=await write(request,context.scope,'project_create',data,repo=>repo.createProject(data));return{data:result.value,meta:{replayed:result.replayed}}
  })
  app.post<{Params:{id:string}}>('/staff/member-cards/projects/:id/state',{bodyLimit:4096},async request=>{
    const input=body(request,['state','reason']),context=await staff(request,input.state==='open'?'loyalty.policy.publish':'member.card.manage')
    if(input.state!=='open'&&input.state!=='paused'&&input.state!=='closed')throw new MemberCardPolicyError('项目操作不正确')
    const data={projectId:request.params.id,state:input.state,reason:string(input.reason,'原因'),employeeId:context.employeeId,businessDate:context.businessDate} as const
    const result=await write(request,context.scope,'project_state',data,repo=>repo.setProjectState(data));return{data:result.value,meta:{replayed:result.replayed}}
  })
}
