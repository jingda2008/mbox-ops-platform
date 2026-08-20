import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import {
  LOYALTY_OPERATIONAL_CAPABILITIES,
  type LoyaltyOperationalCapability,
} from './loyalty-operational-control-repository.js'
import {
  LoyaltyOperationalControlError,
  LoyaltyOperationalControlService,
} from './loyalty-operational-control-service.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { StaffCustomerExperienceContext } from './customer-experience-service.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface LoyaltyOperationalControlApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  service: LoyaltyOperationalControlService
  resolveStaffContext(request: FastifyRequest): Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository,'assertPermission'>
}

export const loyaltyOperationalControlApiPlugin: FastifyPluginAsync<
  LoyaltyOperationalControlApiOptions
> = async (app, options) => {
  app.get('/staff/loyalty/operational-controls', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options,request,'loyalty.operations.view')
    return reply.send({ data:await options.service.list(context) })
  }))

  app.put<{ Params:{ capability:string } }>(
    '/staff/loyalty/operational-controls/:capability',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options,request,'loyalty.operations.control')
      const capability = capabilityValue(request.params.capability)
      const body = object(request.body)
      const operation = enumeration(body.operation,'操作',['pause','resume'] as const)
      const reviewAt = optionalFutureTimestamp(body.reviewAt)
      if (operation==='resume' && reviewAt!==null) throw invalid('恢复操作不能设置复核时间')
      const result = await options.service.set(context,{
        capability,operation,reason:text(body.reason,'原因',2,500),reviewAt,
        expectedVersion:integer(body.expectedVersion,'当前版本',0,2_147_483_646),
        idempotencyKey:idempotency(request),
      })
      return reply.send({ data:result.value,meta:{ replayed:result.replayed } })
    }),
  )
}

async function authorized(
  options:LoyaltyOperationalControlApiOptions,
  request:FastifyRequest,
  permission:string,
) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope,(transaction) => (
    (options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction))
      .assertPermission(context.employeeId,permission)
  ),{ readOnly:true })
  return context
}

async function handle(reply:FastifyReply,execute:()=>Promise<unknown>) {
  try { return await execute() } catch (error) {
    if (error instanceof CustomerExperienceRequestError) {
      return reply.code(error.statusCode).send({ error:{ code:error.code,message:error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error:{ code:'STAFF_ACCESS_DENIED',message:'没有执行该操作的权限' } })
    }
    if (error instanceof LoyaltyOperationalControlError) {
      return reply.code(409).send({ error:{ code:error.code,message:error.message } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({ error:{ code:'IDEMPOTENCY_CONFLICT',message:'重复请求内容不一致' } })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(425).send({ error:{ code:'IDEMPOTENCY_IN_PROGRESS',message:'相同请求正在处理中' } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error:{ code:'IDEMPOTENCY_UNAVAILABLE',message:'操作暂时无法确认，请稍后重试' } })
    }
    throw error
  }
}

function capabilityValue(value:string):LoyaltyOperationalCapability {
  if (!LOYALTY_OPERATIONAL_CAPABILITIES.includes(value as LoyaltyOperationalCapability)) {
    throw invalid('不支持的会员运行能力')
  }
  return value as LoyaltyOperationalCapability
}
function object(value:unknown):Record<string,unknown> {
  if (typeof value!=='object'||value===null||Array.isArray(value)) throw invalid('请求格式不正确')
  return value as Record<string,unknown>
}
function text(value:unknown,label:string,minimum:number,maximum:number) {
  if (typeof value!=='string') throw invalid(`${label}必须填写`)
  const normalized=value.trim()
  if (normalized.length<minimum||normalized.length>maximum) throw invalid(`${label}长度不正确`)
  return normalized
}
function enumeration<const Values extends readonly string[]>(value:unknown,label:string,values:Values):Values[number] {
  if (typeof value!=='string'||!values.includes(value)) throw invalid(`${label}不受支持`)
  return value as Values[number]
}
function integer(value:unknown,label:string,minimum:number,maximum:number) {
  if (!Number.isSafeInteger(value)||(value as number)<minimum||(value as number)>maximum) throw invalid(`${label}超出范围`)
  return value as number
}
function optionalFutureTimestamp(value:unknown):string|null {
  if (value===undefined||value===null||value==='') return null
  const normalized=text(value,'复核时间',20,40)
  const parsed=Date.parse(normalized)
  if (!Number.isFinite(parsed)||parsed<=Date.now()) throw invalid('复核时间必须晚于当前时间')
  return normalized
}
function idempotency(request:FastifyRequest) {
  const value=request.headers['idempotency-key']
  if (typeof value!=='string'||value.length<8||value.length>128) throw invalid('缺少有效幂等键')
  return value
}
function invalid(message:string) {
  return new CustomerExperienceRequestError(message,'INVALID_REQUEST',400)
}
