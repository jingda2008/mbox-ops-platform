import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { safeContentTargetPath } from './customer-experience-repository.js'
import {
  MemberContentCardError,
  type MemberContentCardDraft,
  type MemberContentCardType,
  type MemberContentCardVisibility,
} from './member-content-card-repository.js'
import { MemberContentCardService } from './member-content-card-service.js'
import type { ActivityOperationsStaffContext } from './activity-operations-service.js'
import {
  IdempotencyConflictError,IdempotencyInProgressError,IdempotencyRecordError,OutboxMessageConflictError,
} from './command-executor.js'
import { StaffAccessDeniedError,StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner,ScopedTransaction } from './transaction-runner.js'

export interface MemberContentCardApiOptions {
  transactions:Pick<ScopedPostgresTransactionRunner,'run'>
  service:MemberContentCardService
  resolveStaffContext(request:FastifyRequest):ActivityOperationsStaffContext|Promise<ActivityOperationsStaffContext>
  createStaffAccessRepository?(transaction:ScopedTransaction):Pick<StaffAccessRepository,'assertPermission'>
}

export const memberContentCardApiPlugin:FastifyPluginAsync<MemberContentCardApiOptions>=async(app,options)=>{
  app.get('/staff/home-content-cards',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'community.activity.view')
    return reply.send({data:await options.service.list(context)})
  }))

  app.post('/staff/home-content-cards',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'community.activity.manage')
    const body=object(request.body)
    const result=await options.service.create(context,{draft:draft(body),reason:text(body.reason,'编辑原因',2,500),idempotencyKey:key(request)})
    return reply.code(result.replayed?200:201).send({data:result.value,meta:{replayed:result.replayed}})
  }))

  app.put<{Params:{code:string}}>('/staff/home-content-cards/:code/draft',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'community.activity.manage')
    const body=object(request.body)
    const result=await options.service.update(context,{code:cardCode(request.params.code),draft:draft(body,request.params.code),reason:text(body.reason,'编辑原因',2,500),idempotencyKey:key(request)})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))

  app.post<{Params:{code:string}}>('/staff/home-content-cards/:code/publish',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'community.activity.publish')
    const body=object(request.body)
    const result=await options.service.publish(context,{code:cardCode(request.params.code),reason:text(body.reason,'发布原因',2,500),idempotencyKey:key(request)})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))

  app.post<{Params:{code:string}}>('/staff/home-content-cards/:code/pause',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,'community.activity.publish')
    const body=object(request.body)
    const result=await options.service.pause(context,{code:cardCode(request.params.code),reason:text(body.reason,'暂停原因',2,500),idempotencyKey:key(request)})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
}

async function authorized(options:MemberContentCardApiOptions,request:FastifyRequest,permission:string){
  const context=await options.resolveStaffContext(request)
  await options.transactions.run(context.scope,async(transaction)=>{
    const access=options.createStaffAccessRepository?.(transaction)??new StaffAccessRepository(transaction)
    await access.assertPermission(context.employeeId,permission)
  },{readOnly:true})
  return context
}

function draft(value:Record<string,unknown>,fixedCode?:string):MemberContentCardDraft{
  const visibility=enumeration(value.visibility,'可见范围',['public','member','segment'] as const)
  const levels=list(value.audienceMemberLevels,'会员等级',['member','silver','gold'] as const)
  const stages=list(value.audienceLifecycleStages,'会员阶段',['new','active','high_value','at_risk','dormant'] as const)
  if(visibility==='segment'&&levels.length+stages.length===0)throw invalid('指定客群内容至少选择一个会员等级或阶段')
  if(visibility!=='segment'&&levels.length+stages.length>0)throw invalid('公开或全会员内容不能携带指定客群条件')
  const validFrom=timestamp(value.validFrom,'开始展示时间')
  const validUntil=timestamp(value.validUntil,'结束展示时间')
  if(Date.parse(validUntil)<=Date.parse(validFrom))throw invalid('结束展示时间必须晚于开始展示时间')
  const targetPath=text(value.targetPath,'小程序目标页面',1,256)
  if(safeContentTargetPath(targetPath)===null)throw invalid('目标页面不在允许的小程序页面内')
  const imageUrl=optionalText(value.imageUrl,'图片地址',1000)
  if(imageUrl!==null&&!safeAssetUrl(imageUrl))throw invalid('图片地址必须是站内路径或HTTPS地址')
  return{
    code:fixedCode?cardCode(fixedCode):cardCode(value.code),
    type:enumeration(value.type,'内容类型',['activity','presale','benefit','article','return_offer','show'] as const) as MemberContentCardType,
    title:text(value.title,'标题',2,120),summary:text(value.summary,'摘要',2,400),imageUrl,
    ctaLabel:text(value.ctaLabel,'操作文案',1,20),targetPath,
    priority:integer(value.priority,'展示顺序',0,10000),visibility:visibility as MemberContentCardVisibility,
    audienceMemberLevels:levels,audienceLifecycleStages:stages,validFrom,validUntil,
  }
}

async function handle(reply:FastifyReply,execute:()=>Promise<unknown>){try{return await execute()}catch(error){
  if(error instanceof InputError)return reply.code(400).send({error:{code:'HOME_CONTENT_INPUT_INVALID',message:error.message}})
  if(error instanceof MemberContentCardError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'STAFF_ACCESS_DENIED',message:'没有管理首页内容的权限'}})
  if(error instanceof IdempotencyConflictError||error instanceof OutboxMessageConflictError)return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT',message:'重复请求内容不一致'}})
  if(error instanceof IdempotencyInProgressError)return reply.code(425).send({error:{code:'IDEMPOTENCY_IN_PROGRESS',message:'相同内容操作正在处理中'}})
  if(error instanceof IdempotencyRecordError)return reply.code(503).send({error:{code:'IDEMPOTENCY_UNAVAILABLE',message:'内容操作暂时无法确认，请刷新后重试'}})
  throw error
}}

class InputError extends Error{}
function invalid(message:string){return new InputError(message)}
function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw invalid('请求格式不正确');return value as Record<string,unknown>}
function text(value:unknown,label:string,min:number,max:number){if(typeof value!=='string'){throw invalid(`${label}格式不正确`)}const result=value.trim();if(result.length<min||result.length>max)throw invalid(`${label}长度不正确`);return result}
function optionalText(value:unknown,label:string,max:number){if(value===null||value===undefined||value==='')return null;return text(value,label,1,max)}
function integer(value:unknown,label:string,min:number,max:number){if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw invalid(`${label}必须是${min}至${max}的整数`);return value as number}
function timestamp(value:unknown,label:string){const result=text(value,label,10,64);if(!Number.isFinite(Date.parse(result)))throw invalid(`${label}格式不正确`);return new Date(result).toISOString()}
function enumeration<const Values extends readonly string[]>(value:unknown,label:string,values:Values):Values[number]{if(typeof value!=='string'||!values.includes(value))throw invalid(`${label}不支持`);return value as Values[number]}
function list<const Values extends readonly string[]>(value:unknown,label:string,values:Values){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!values.includes(item)))throw invalid(`${label}格式不正确`);return [...new Set(value)] as Values[number][]}
function cardCode(value:unknown){const result=text(value,'内容编号',3,64);if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(result))throw invalid('内容编号只能使用字母、数字、点、横线或下划线');return result}
function key(request:FastifyRequest){const value=request.headers['idempotency-key'];if(Array.isArray(value))throw invalid('Idempotency-Key格式不正确');const result=text(value,'Idempotency-Key',8,128);if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(result))throw invalid('Idempotency-Key格式不正确');return result}
function safeAssetUrl(value:string){return(value.startsWith('/')&&!value.startsWith('//'))||/^https:\/\//i.test(value)}
