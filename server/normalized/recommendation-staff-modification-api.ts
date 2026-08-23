import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import {
  RecommendationStaffModificationError,
  type RecommendationStaffModificationReason,
} from './recommendation-staff-modification-repository.js'
import {
  RecommendationStaffModificationService,
  type RecommendationStaffContext,
} from './recommendation-staff-modification-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

export interface RecommendationStaffModificationApiOptions {
  service: RecommendationStaffModificationService
  resolveStaffContext(request: FastifyRequest):
    | RecommendationStaffContext
    | Promise<RecommendationStaffContext>
}

const REASONS = [
  'customer_request','availability_substitution','service_recovery','staff_judgement',
] as const

export const recommendationStaffModificationApiPlugin: FastifyPluginAsync<
  RecommendationStaffModificationApiOptions
> = async (app, options) => {
  app.get('/staff/customer-experience/recommendations', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const tableSessionId = uuid(object(request.query).tableSessionId, '桌次')
    return reply.send({ data: await options.service.latestForTable(context,tableSessionId) })
  }))

  app.post<{ Params: { recommendationPublicId: string } }>(
    '/staff/customer-experience/recommendations/:recommendationPublicId/modifications',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolveStaffContext(request)
      const body = object(request.body)
      const result = await options.service.modify(context, {
        recommendationPublicId: publicId(request.params.recommendationPublicId),
        sourceProductId: uuid(body.sourceProductId,'原推荐商品'),
        targetProductId: uuid(body.targetProductId,'调整后商品'),
        reasonCode: enumeration(body.reasonCode,'调整原因',REASONS),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({
        data: result.value,meta: { replayed: result.replayed },
      })
    }),
  )
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try { return await execute() } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({
      error: STAFF_AUTHENTICATION_REQUIRED_ERROR,
    })
    if (error instanceof RecommendationStaffModificationApiError) return reply.code(400).send({
      error: { code: 'RECOMMENDATION_STAFF_MODIFICATION_INPUT_INVALID',message: error.message },
    })
    if (error instanceof RecommendationStaffModificationError) return reply.code(error.statusCode).send({
      error: { code: error.code,message: error.message },
    })
    if (error instanceof StaffAccessDeniedError) return reply.code(403).send({
      error: { code: 'STAFF_ACCESS_DENIED',message: '没有调整桌台推荐的权限' },
    })
    if (error instanceof IdempotencyConflictError) return reply.code(409).send({
      error: { code: 'IDEMPOTENCY_CONFLICT',message: '重复请求内容不一致' },
    })
    if (error instanceof IdempotencyInProgressError) return reply.code(425).send({
      error: { code: 'IDEMPOTENCY_IN_PROGRESS',message: '相同推荐调整正在处理中' },
    })
    if (error instanceof IdempotencyRecordError) return reply.code(503).send({
      error: { code: 'IDEMPOTENCY_UNAVAILABLE',message: '推荐调整结果暂时无法确认，请刷新后重试' },
    })
    throw error
  }
}

class RecommendationStaffModificationApiError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecommendationStaffModificationApiError('请求格式不正确')
  }
  return value as Record<string, unknown>
}

function uuid(value: unknown,label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RecommendationStaffModificationApiError(`${label}格式不正确`)
  }
  return value
}

function publicId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value)) {
    throw new RecommendationStaffModificationApiError('推荐编号格式不正确')
  }
  return value
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,label: string,values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new RecommendationStaffModificationApiError(`${label}不受支持`)
  }
  return value as RecommendationStaffModificationReason & Values[number]
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value)) {
    throw new RecommendationStaffModificationApiError('缺少有效幂等键')
  }
  return value
}
