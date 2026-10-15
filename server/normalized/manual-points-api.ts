import {z} from 'zod'
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {ManualPointsError,ManualPointsService} from './manual-points-service.js'
import {IdempotencyConflictError} from './command-executor.js'
import {StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'
import {NormalizedAuthenticationRequiredError,NormalizedStoreUnavailableError,TrustedStoreScopeError} from './normalized-request-context.js'
const reason=z.string().trim().min(3).max(240)
export function registerManualPointsRoutes(app:FastifyInstance,options:{transactions:Pick<ScopedPostgresTransactionRunner,'run'>;resolveStaffContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}){
 const service=new ManualPointsService(options.transactions)
 app.get('/staff/loyalty/manual-points',async(request,reply)=>handle(reply,async()=>{
  const ctx=await options.resolveStaffContext(request),query=z.object({page:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query)
  reply.header('Cache-Control','private, no-store');return reply.send({data:await service.list(ctx,query.page)})
 }))
 app.post('/staff/loyalty/manual-points/requests',async(request,reply)=>handle(reply,async()=>{
  const ctx=await options.resolveStaffContext(request),input=z.object({memberNo:z.string().trim().min(1).max(64),pointsDelta:z.number().int().min(-1000000).max(1000000).refine(v=>v!==0),reason}).strict().parse(request.body)
  const result=await service.request(ctx,input,key(request));return reply.send({data:result.value,meta:{replayed:result.replayed}})
 }))
 app.post('/staff/loyalty/manual-points/decisions',async(request,reply)=>handle(reply,async()=>{
  const ctx=await options.resolveStaffContext(request),input=z.object({requestId:z.string().uuid(),decision:z.enum(['approve','reject']),reason}).strict().parse(request.body)
  const result=await service.decide(ctx,input,key(request));return reply.send({data:result.value,meta:{replayed:result.replayed}})
 }))
}
function key(request:FastifyRequest){return z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/).parse(request.headers['idempotency-key'])}
async function handle(reply:FastifyReply,work:()=>Promise<unknown>){try{return await work()}catch(e){
 if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'MANUAL_POINTS_INVALID',message:'请核对会员、整数积分、原申请和实际依据'}})
 if(e instanceof ManualPointsError)return reply.code(e.statusCode).send({error:{code:e.code,message:e.message,...(e.commitDisposition?{commitDisposition:e.commitDisposition}:{})}})
 if(e instanceof IdempotencyConflictError)return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT',message:'原请求绑定了其他内容，请恢复原操作'}})
 if(e instanceof NormalizedAuthenticationRequiredError||e instanceof StaffSessionNotFoundError)return reply.code(401).send({error:{code:'AUTHENTICATION_REQUIRED',message:'请恢复原员工登录后核对'}})
 if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError||e instanceof TrustedStoreScopeError||e instanceof NormalizedStoreUnavailableError)return reply.code(403).send({error:{code:'PERMISSION_DENIED',message:'当前员工没有人工积分调整权限'}})
 console.error('MANUAL_POINTS_FAILED',e instanceof Error?e.stack:e)
 return reply.code(500).send({error:{code:'MANUAL_POINTS_UNKNOWN',message:'积分操作结果暂未确认，请保留并恢复原请求'}})
}}
